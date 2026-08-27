# Growth Agent Service (GAS)

The fuel behind the Affiliate Marketing Social Media Growth Agent: the piece
that keeps working when your laptop is off. LITE stays the brains for live
conversation; GAS (this Cloudflare Worker + Supabase pair) is the always-on
engine that runs on a schedule regardless of whether LITE is running.

```
Cron (every 6h, configurable)
   │
   ▼
Cloudflare Worker
   ├─ generate content drafts (Claude, via your Anthropic key)   → content_queue  (pending_approval)
   ├─ poll PartnerStack /rewards                                  → earnings_snapshots
   ├─ poll Exness Partnership API                                 → earnings_snapshots
   └─ build a "while you were away" report                        → reports
   
LITE, next time you open it
   └─ affiliate_growth_agent(action="get_report") → GET /report/latest → spoken/HUD summary
```

Nothing posts to any social platform automatically. Every draft sits in
`content_queue` with `status = pending_approval` until you approve it —
either straight in Supabase, or by building the approval UI into LITE's HUD
later (the `/queue` and `/queue/:id/approve` endpoints are already there for
that).

## 1. Supabase

1. Create a project (or reuse EVA's — separate tables, no conflict either way).
2. SQL Editor → paste and run `schema.sql`.
3. Project Settings → API → copy the **Project URL** and the **service_role** key
   (not anon — this Worker writes tables directly with elevated privileges,
   so treat that key like a password, never ship it client-side).

## 2. PartnerStack

Partner Dashboard → Settings → API → generate an API key. That's the
`PARTNERSTACK_API_KEY`. No OAuth flow, just a Bearer token.

## 3. Exness

You'll use your normal Exness Partner Personal Area email + password
(`EXNESS_EMAIL` / `EXNESS_PASSWORD`) — the Worker exchanges these for a JWT
on every poll via `/api/auth`. If Exness later gives you a dedicated API
key/token instead of email+password, swap it into
`src/networks/exness.ts::getExnessToken` — the rest of the adapter doesn't
change.

**Heads up:** the very first real run's `raw` field in `earnings_snapshots`
is your ground truth for what Exness actually returns — their reporting
endpoint's exact field names have shifted across doc revisions. Check that
row after the first cron tick and tighten the `pick(...)` field-name lists
in `exness.ts` if `clicks/leads/conversions/earnings` come back null despite
`ok: true`.

## 4. LLM provider (multi-provider, Gemini-first)

GAS now uses the same "try each configured provider in order, fall through
on failure" pattern EVA uses — not locked to Claude. **Only one key is
required to start**, the rest are optional and just get skipped if unset:

1. **Gemini** (recommended to start) — free tier, no card:
   `aistudio.google.com` → Get API key → `wrangler secret put GOOGLE_GEMINI_API_KEY`
2. **Claude** — add this once sales are covering it; from that point on it
   participates in the chain automatically, no code or redeploy needed,
   just: `wrangler secret put ANTHROPIC_API_KEY`
3. **Groq** — free tier, no card: `console.groq.com` →
   `wrangler secret put GROQ_API_KEY`
4. Optional further fallbacks, same free-tier pattern: `OPENROUTER_API_KEY`,
   `NVIDIA_API_KEY`, `HUGGINGFACE_API_KEY`

Order tried: **Gemini → Claude → Groq → OpenRouter → NVIDIA → HuggingFace**,
first configured *and* successful one wins. If every configured provider
fails on a given call, the error message lists every individual failure
reason — same diagnosability as EVA's chain, so a bad key or a stale model
name is obvious immediately rather than a generic "it broke".

## 5. Deploy

```bash
cd gas
npm install
npx wrangler login

npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put WORKER_SHARED_SECRET     # make one up, e.g. `openssl rand -hex 24`
npx wrangler secret put PARTNERSTACK_API_KEY
npx wrangler secret put EXNESS_EMAIL
npx wrangler secret put EXNESS_PASSWORD

# Optional — real video rendering. Skip this entirely and video pieces
# still get made, just via the free Workers AI fallback instead of Runway.
npx wrangler secret put RUNWAY_API_KEY

# Create the R2 bucket the video pipeline (both Runway and the fallback)
# stores finished assets in — one-time setup:
npx wrangler r2 bucket create gas-media

npx wrangler deploy
```

Run `migrations/002_video.sql` in the Supabase SQL editor once, after
`schema.sql` — it adds the video columns to `content_queue` (safe to run on
an existing table; every column is `add column if not exists`).

Wrangler prints your Worker URL, e.g. `https://gas.<you>.workers.dev`.

## 6. Wire it into LITE

Add to `config/api_keys.json`:

```json
"gas_worker_url": "https://gas.<you>.workers.dev",
"gas_worker_key": "<the WORKER_SHARED_SECRET you generated above>"
```

Drop `actions/affiliate_growth_agent.py` into your `actions/` folder
(replacing the earlier version — it now includes `assign_job` and
`get_report`), and paste the three snippets from the bottom of that file
into `main.py` (import line, `FUNCTION_DECLARATIONS` entry, dispatch
`elif`).

## 7. Use it

Talk to LITE:

> "Assign the growth agent to work the forex trading apps niche on TikTok,
> Instagram, and LinkedIn, checking in every 6 hours."

Shut your laptop down. It keeps drafting content and polling both networks
on Cloudflare's clock, not yours. LinkedIn needs no separate setup — it's
just another entry in `platforms`; the system prompt already knows to write
LinkedIn pieces in a professional register with a soft CTA instead of
TikTok voice with a hard sell.

### Real video, not just scripts

When the LLM picks `content_type: video` for a piece (it does this on its
own for TikTok/Reels/Shorts/LinkedIn-video pieces — see the system prompt),
GAS renders an actual video asset instead of leaving it as text:

- **If `RUNWAY_API_KEY` is set**: submits the script to Runway's
  text-to-video API. The draft lands in the queue with
  `video_status: "queued"`; the next cron tick (or a manual
  `POST /render-check`) polls it to `"ready"` with a real `video_url`, or
  degrades it to the fallback below if Runway's render itself failed.
- **If it isn't** (or Runway's submit call fails): renders a free fallback
  instead, using Cloudflare Workers AI — already bound to this Worker, no
  extra signup or key. You get `video_status: "fallback_ready"` and a
  `video_assets` object: one AI-generated image per scene plus one
  AI-generated narration audio track, both in your own R2 bucket. Quality
  is lower than a true generated clip, and it isn't a finished MP4 —
  dropping those into CapCut/InShot/Canva is a sub-one-minute assembly step
  from there. **No API call, no extra account, no extra key required** —
  it runs on the Cloudflare account this Worker is already deployed to.

Either way, nothing about the approval flow changes — video drafts sit in
`pending_approval` in `content_queue` exactly like text ones, and
`list_queue` / `get_report` in LITE now surface the video status and URL
alongside the usual title/platform line.

Next time you're back:

> "What's the growth agent report?"

You'll get: how many pieces it drafted (and how many are waiting for your
approval), new leads, new conversions, and earnings delta since your last
check-in — pulled straight from `reports`.

You can also hit `/run-now` directly (with the same Bearer auth) any time
you want to force a fresh cycle instead of waiting for the next cron tick —
handy for testing right after deploy.

## 8. Deleting drafts, downloading drafts, and one-off ad generation

Three more things you can do beyond the standing 6h auto-generator:

- **Delete a draft permanently**: `DELETE /queue/:id`. Unlike REJECT (which
  just flips `status` and keeps the row), this actually removes it from
  the database — and cleans up any R2 files it owned first (fallback
  slideshow images/audio), so nothing orphaned is left in the bucket. In
  LITE's HUD, the DELETE button on a card requires a second click within
  4 seconds to actually fire, since there's no undo.
- **Download a draft to your computer**: `GET /queue/:id` returns the full
  row (title/body/platform/content_type + `video_url`/`video_assets` if
  it's a video piece). LITE's DOWNLOAD button opens a folder picker, then
  saves the text as a `.txt` plus (if present) the rendered MP4, the
  fallback slideshow's images/narration audio, and a captions file.
- **On-demand ad generation**: `POST /generate` with
  `{"description": "...", "platforms": [...], "count": 3, "content_type": "video"}`
  — generates content for that exact one-off idea right now, independent
  of any standing job or its 6h cadence. Say something like "generate an
  ad for our new budgeting app launch, aimed at Gen Z, on TikTok and
  LinkedIn" and LITE calls this via the new `generate_ads` action, then
  pulls the results straight into the review queue.



- **Posting is manual by design** (per your choice) — the agent drafts,
  you post. Auto-posting would need each platform's business API + app
  review, which is a separate, slower project if you want it later.
- **Exness field names may need one round of tightening** after the first
  real poll (see step 3).
- **PartnerStack `/rewards` gives earnings, not raw click counts** — if you
  want click-level attribution per piece of content, the clean way is to
  route your PartnerStack links through their own SubID feature using the
  `tracking_subid` this agent already generates per draft, then read
  clicks back from PartnerStack's reporting once you're posting. That's a
  five-minute addition once you're actually posting content and want that
  granularity — not needed for the report to work today.
- **Cost**: every content pass costs a handful of Claude tokens (a few
  cents at 6h cadence). Both network polls are free API calls. This is the
  one part of the system that costs real money continuously, so `cadence_hours`
  is deliberately per-job and easy to turn down.
- **Runway video costs real money per render** — a 5s Gen-4 Turbo clip is
  roughly $0.05-0.10 depending on current pricing/resolution; check
  dev.runwayml.com's pricing page before turning on high-volume video jobs.
  There's no per-job spending cap built in yet — if you want one, the clean
  place to add it is a running-total check against `earnings_snapshots`
  before `submitVideoTask` is called in `video/index.ts`.
- **The Workers AI fallback produces assets, not a finished video file** —
  a stateless Cloudflare Worker has no ffmpeg and a hard CPU-time ceiling
  per request, so it can't encode/stitch an MP4 on its own. What it hands
  you (images + narration audio, auto-uploaded to R2) still needs one
  manual assembly pass in a video editor, or a future integration with a
  render-as-a-service API (Shotstack/Creatomate) if you want that
  automated too — see the comment at the top of `video/fallback.ts`.
- **`MEDIA_PUBLIC_BASE_URL` is unset by default** — fallback asset URLs will
  read as `r2-key:...` placeholders until you enable public access (or a
  custom domain) on the `gas-media` R2 bucket and set that var to it.

## 9. Exact daily volume — e.g. "1 per platform, 5 platforms, once a day"

Two settings on a job control this precisely now:

- **`posts_per_platform`**: when set, generates exactly that many pieces
  for EACH platform in the job — one LLM call per platform, so the split
  is guaranteed, not left to the model's own judgment across a combined
  list (which could put 2 pieces on TikTok and 0 on LinkedIn in one pass).
  Leave it unset to keep the old behavior (`posts_per_run` total, model
  decides the split).
- **`cadence_hours`**: now actually enforced (it wasn't before — see the
  note in `migrations/004_scheduling.sql`). A job only gets a fresh
  content pass once `cadence_hours` has really elapsed since its last run,
  no matter how often the Worker's own cron trigger ticks.

For "exactly 1 LinkedIn + 1 TikTok + 1 Instagram + 1 Twitter + 1 Facebook
= 5/day, once a day":

```powershell
$body = '{"niche":"forex trading apps","platforms":["LinkedIn","TikTok","Instagram","Twitter","Facebook"],"posts_per_platform":1,"cadence_hours":24}'
Invoke-RestMethod -Method Post -Uri "https://gas.elites.workers.dev/jobs" -Headers $headers -Body $body
```

To change an existing job instead of creating a new one:
```powershell
Invoke-RestMethod -Method Patch -Uri "https://gas.elites.workers.dev/jobs/<job-id>" -Headers $headers `
  -Body '{"posts_per_platform":1,"cadence_hours":24}'
```

This also directly reduces Workers AI quota pressure — 5 pieces/day is at
most 5 fallback renders (fewer still if Runway succeeds for some), versus
whatever a `posts_per_run`-based combined pass repeated every cron tick
could add up to before cadence_hours was enforced.

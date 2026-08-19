# GAS — Growth Agent Service

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

## 4. Anthropic

Use the same Anthropic API key LITE already has in
`config/api_keys.json -> anthropic_api_key`. Set `ANTHROPIC_MODEL` in
`wrangler.toml` `[vars]` to whatever's current per
https://docs.claude.com — `claude-sonnet-5` is a reasonable default as of
this build.

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

npx wrangler deploy
```

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

> "Assign the growth agent to work the forex trading apps niche on TikTok
> and Instagram, checking in every 6 hours."

Shut your laptop down. It keeps drafting content and polling both networks
on Cloudflare's clock, not yours.

Next time you're back:

> "What's the growth agent report?"

You'll get: how many pieces it drafted (and how many are waiting for your
approval), new leads, new conversions, and earnings delta since your last
check-in — pulled straight from `reports`.

You can also hit `/run-now` directly (with the same Bearer auth) any time
you want to force a fresh cycle instead of waiting for the next cron tick —
handy for testing right after deploy.

## Known limits, stated plainly

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

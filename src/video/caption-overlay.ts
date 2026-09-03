// gas/src/video/caption-overlay.ts
//
// Burns caption text onto a scene image as real, correctly-spelled pixels —
// instead of asking the AI image model to render it. AI-generated text
// (what flux-1-schnell was doing before this module existed) is
// fundamentally unreliable at spelling: "tax" -> "tox" and similar, because
// the model is guessing letter shapes rather than placing known characters.
// This sidesteps that class of bug entirely: draw_text_with_border() below
// draws the literal string you pass it, character-for-character, using the
// (Roboto) font baked into @cf-wasm/photon's WASM binary. There is no model
// in the loop that could misspell anything — correctness comes from it
// being a deterministic font-rendering call, not a generative one.
//
// Trade-off, stated plainly: this buys guaranteed-correct spelling and a
// clean, legible caption band, not full creative title-card typography.
// photon's text API supports one font (Roboto), no per-word styling, and
// no text-measurement call — so word-wrapping below is an estimate, not a
// pixel-exact layout. If you later want custom fonts / multi-style text
// baked into the image, that's a bigger lift (SVG via @cf-wasm/resvg
// composited with photon) that this file does not attempt.
//
// @cf-wasm/photon is purpose-built for the Workers (workerd) runtime — see
// https://www.npmjs.com/package/@cf-wasm/photon. It adds ~1.5MB of WASM to
// the deployed Worker (uncompressed; compresses well under gzip), which
// should fit the Workers Paid plan's 10MB compressed script-size ceiling
// comfortably, and likely the Free plan's 3MB ceiling too once combined
// with the rest of this codebase — but check `wrangler deploy` output
// against your actual bundle size before relying on Free.

import { PhotonImage, draw_text_with_border } from "@cf-wasm/photon/workerd";

// Roboto's average glyph width as a rough fraction of font size. photon has
// no text-measurement API, so this is only used to decide where to wrap —
// a little slop left/right of the safe margin is fine for a caption band,
// this is not meant to be pixel-exact.
const AVG_CHAR_WIDTH_RATIO = 0.56;

function wrapText(text: string, maxCharsPerLine: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Darkens a horizontal band of the image in place (alpha blend toward
 * black) so caption text stays legible over busy, unpredictable
 * AI-generated backgrounds. Operates directly on the raw RGBA pixel
 * buffer — no separate watermark image or extra dependency needed. */
function darkenBand(pixels: Uint8Array, width: number, bandTop: number, bandBottom: number, opacity: number): void {
  for (let y = Math.max(0, bandTop); y < bandBottom; y++) {
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = rowStart + x * 4;
      pixels[i] = Math.round(pixels[i] * (1 - opacity));
      pixels[i + 1] = Math.round(pixels[i + 1] * (1 - opacity));
      pixels[i + 2] = Math.round(pixels[i + 2] * (1 - opacity));
      // alpha (pixels[i + 3]) left untouched — source image should already be opaque
    }
  }
}

export interface BurnCaptionOptions {
  /** Font size in px. Defaults to a fraction of image width so it scales
   * sensibly whether the source is a small preview or a full 1080-wide frame. */
  fontSize?: number;
  /** Caption lines beyond this are dropped rather than overflowing the band. */
  maxLines?: number;
  /** Fraction of image height reserved at the bottom for the caption band. */
  bandFraction?: number;
}

/** Burns `caption` onto `pngBytes` as real pixels and returns new PNG
 * bytes. Call this in fallback.ts right after generateSceneImage() produces
 * the raw AI image and before it's uploaded to R2, so the caption travels
 * with the image file itself instead of only living in the separate
 * `captions` array the caller already tracks. */
export function burnCaption(pngBytes: Uint8Array, caption: string, opts: BurnCaptionOptions = {}): Uint8Array {
  const trimmed = caption.trim();
  if (!trimmed) return pngBytes; // nothing to burn — hand back the original untouched

  const source = PhotonImage.new_from_byteslice(pngBytes);
  let darkened: PhotonImage | null = null;
  try {
    const width = source.get_width();
    const height = source.get_height();
    const fontSize = Math.max(14, opts.fontSize ?? Math.round(width * 0.045));
    const maxLines = opts.maxLines ?? 3;
    const bandFraction = opts.bandFraction ?? 0.28;
    const lineHeight = Math.round(fontSize * 1.35);

    const maxCharsPerLine = Math.max(8, Math.floor((width * 0.88) / (fontSize * AVG_CHAR_WIDTH_RATIO)));
    const lines = wrapText(trimmed, maxCharsPerLine).slice(0, maxLines);

    const bandHeight = Math.min(height, Math.max(Math.round(height * bandFraction), lineHeight * lines.length + fontSize));
    const bandTop = height - bandHeight;

    const pixels = source.get_raw_pixels();
    darkenBand(pixels, width, bandTop, height, 0.55);
    darkened = new PhotonImage(pixels, width, height);

    const textStartY = bandTop + Math.round((bandHeight - lineHeight * lines.length) / 2);
    const textX = Math.round(width * 0.06);
    for (let i = 0; i < lines.length; i++) {
      draw_text_with_border(darkened, lines[i], textX, textStartY + i * lineHeight, fontSize);
    }

    return darkened.get_bytes();
  } finally {
    source.free();
    darkened?.free();
  }
}

/**
 * viewer/fit-text.js  (PDF viewer)
 * Puts the text layer's letters exactly where the PDF's letters are drawn.
 *
 * Why: pdf.js lays each run of text ("span") out in a generic fallback font
 * and stretches the whole run to the PDF's width. The run's ends are right,
 * but letters partway along sit where the fallback font puts them. Bold text
 * in the regular face was 8% off; a kerned title ("Va", "Wa", "Tr") was off
 * at every kerning pair. Marks are painted on this layer and the mouse
 * selects from it, so marks and selections drifted from the words by up to
 * 4px at 150% zoom, and more on bigger text.
 *
 * How:
 *   1. While pdf.js draws a page, record where it drew each glyph (it calls
 *      the canvas's fillText once per glyph). That is the truth: it includes
 *      the PDF's kerning, character and word spacing.
 *   2. Lay each run out in the PDF's own font when pdf.js has loaded it and
 *      it measures the run within 10% of the PDF's width (some PDF fonts are
 *      remapped by pdf.js and cannot draw ordinary Unicode; those keep the
 *      fallback).
 *   3. Match each letter of the run to its glyph on the same baseline and set
 *      letter-spacing so each letter starts where its glyph was drawn.
 *      Spaces are never matched (pdf.js draws none), and a letter only takes
 *      a glyph nearer to it than to the next letter, so one missing glyph
 *      cannot shift the rest. Letters with no glyph (spaces, the second
 *      letter of a ligature) start right after the previous letter's own
 *      width, so each word ends where its last glyph ends.
 *      Letters needing their own spacing are wrapped in <wmt-g> (not a span:
 *      pdf.js's CSS positions every text-layer span absolutely).
 *   If no glyphs were recorded (text drawn as outlines, invisible OCR text),
 *   step 2 is used alone, with the run's spare width spread evenly.
 *
 * Everything is computed from font measurements and PDF coordinates, not
 * from page layout, so it also works on the print copy before it is shown.
 * Zooming does not re-lay a text layer out (pdf.js scales it with CSS
 * variables), so fitting once per text layer holds at every zoom.
 */

// ------------------------------------------------------------- glyph recorder

/** canvas -> flat [x, y, x, y, ...] of glyph origins in canvas pixels. */
const logs = new WeakMap();
/** The most recent canvases drawn on, newest last (pdf.js may draw a page on a canvas it later swaps out). */
const recent = [];
const RECENT_MAX = 8;

const realFillText = CanvasRenderingContext2D.prototype.fillText;
CanvasRenderingContext2D.prototype.fillText = function fillText(text, x, y, ...rest) {
  try {
    const canvas = this.canvas;
    let log = logs.get(canvas);
    if (!log) {
      log = [];
      logs.set(canvas, log);
      recent.push(canvas);
      if (recent.length > RECENT_MAX) recent.shift();
    }
    const m = this.getTransform();
    log.push(m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f);
  } catch (e) { /* recording must never stop a page being drawn */ }
  return realFillText.call(this, text, x, y, ...rest);
};

/**
 * Glyph origins drawn for a page, in PDF points, then forgotten.
 * `canvas`: the page's canvas (or, on screen, the canvas pdf.js shows: it may
 * have drawn on a same-sized one first). `viewport`: the viewport it was drawn
 * with; `sx`, `sy`: canvas pixels per viewport pixel (pdf.js's output scale).
 */
export function takeGlyphs(canvas, viewport, sx = 1, sy = 1) {
  let source = logs.has(canvas) ? canvas : null;
  for (let i = recent.length - 1; !source && i >= 0; i--) {
    const c = recent[i];
    if (c.width === canvas.width && c.height === canvas.height) source = c;
  }
  if (!source) return null;
  const log = logs.get(source);
  logs.delete(source);
  recent.splice(recent.indexOf(source), 1);
  if (!log || !log.length) return null;
  const out = new Float64Array(log.length);
  for (let i = 0; i < log.length; i += 2) {
    const [px, py] = viewport.convertToPdfPoint(log[i] / sx, log[i + 1] / sy);
    out[i] = px;
    out[i + 1] = py;
  }
  return out;
}

// ------------------------------------------------------------- measuring

const ctx = document.createElement('canvas').getContext('2d');
ctx.fontKerning = 'none';
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const lettersOf = (s) => Array.from(graphemes.segment(s), (g) => g.segment); // what CSS letter-spacing counts

/** Widths of each letter in `family` at 1px (em), or null if the font is not loaded. */
function letterWidths(family, letters, quoted) {
  if (quoted && !document.fonts.check(`10px "${quoted}"`, letters.join(''))) return null;
  ctx.font = `100px ${family}`;
  return letters.map((l) => ctx.measureText(l).width / 100);
}

const FONT_TOLERANCE = 0.10; // a PDF font measuring further off than this is not used
const SNAP_EM = 0.4;         // a glyph further than this from where a letter is expected is not its glyph
const OWN_EM = 0.004;        // letters whose spacing differs from the run's by less than this are not wrapped

// ------------------------------------------------------------- fitting

/**
 * Fit the spans of one text layer. `items`/`styles` are the page's text
 * content (same options as the layer; its non-empty strings are the spans in
 * order). `glyphs`: from takeGlyphs, or null. Returns true if text nodes were
 * replaced (marks on this layer must then be found again).
 */
export function fitLayer(layer, items, styles, glyphs) {
  const spans = layer.querySelectorAll('span[role="presentation"]');
  const runs = items.filter((it) => typeof it.str === 'string' && it.str !== '');
  if (spans.length !== runs.length) return false;       // not the same text: change nothing
  let replaced = false;
  spans.forEach((span, i) => {
    const it = runs[i];
    if (span.dataset.wmtFit === 'snapped' || it.str !== span.textContent) return;
    if (styles[it.fontName] && styles[it.fontName].vertical) return; // vertical text: pdf.js's layout stays
    const fontHeight = parseFloat(span.style.getPropertyValue('--font-height'));
    if (!fontHeight || !it.width) return;
    const letters = lettersOf(it.str);
    const want = it.width / fontHeight;                  // the run's length in the PDF, in font heights (em)

    // 2. The font.
    if (!span.dataset.wmtFit) {
      span.dataset.wmtFit = 'fallback';
      span.dataset.wmtFallback = span.style.fontFamily || 'sans-serif';
      const own = letterWidths(`"${it.fontName}"`, letters, it.fontName);
      const sum = own ? own.reduce((a, b) => a + b, 0) : 0;
      if (sum && Math.abs(sum / want - 1) <= FONT_TOLERANCE) {
        span.style.fontFamily = `"${it.fontName}", ${span.dataset.wmtFallback}`;
        span.dataset.wmtFit = 'pdf';
      }
    }
    const family = span.style.fontFamily;
    const widths = letterWidths(family, letters, span.dataset.wmtFit === 'pdf' ? it.fontName : null);
    if (!widths) return;
    const natural = widths.reduce((a, b) => a + b, 0);

    // 3. Where each letter's glyph was drawn, along the run's baseline, in em.
    const starts = glyphs && span.dir !== 'rtl' ? glyphStarts(it, fontHeight, letters, widths, want, glyphs) : null;
    if (!starts) {
      if (span.dataset.wmtFit !== 'pdf') return;         // fallback font, nothing to snap to: leave pdf.js's stretch
      setRun(span, (want - natural) / letters.length);
      return;
    }
    // Spacing after each letter = (next start - this start) - its own width.
    const extra = widths.map((w, k) => (starts[k + 1] - starts[k]) - w);
    const base = median(extra);
    setRun(span, base);
    if (extra.every((x) => Math.abs(x - base) < OWN_EM)) { span.dataset.wmtFit = 'snapped'; return; }
    // Rebuild the span's text: runs of letters with the base spacing stay plain
    // text; others get their own spacing. The text itself does not change.
    const frag = document.createDocumentFragment();
    let plain = '';
    letters.forEach((l, k) => {
      if (Math.abs(extra[k] - base) < OWN_EM) { plain += l; return; }
      if (plain) { frag.append(plain); plain = ''; }
      const g = document.createElement('wmt-g');
      g.style.letterSpacing = `${extra[k].toFixed(5)}em`;
      g.textContent = l;
      frag.append(g);
    });
    if (plain) frag.append(plain);
    span.replaceChildren(frag);
    span.dataset.wmtFit = 'snapped';
    replaced = true;
  });
  return replaced;
}

/** Spread spacing `ls` (em) after every letter of a span, and stop pdf.js's stretch. */
function setRun(span, ls) {
  span.style.letterSpacing = `${ls.toFixed(5)}em`;
  span.style.fontKerning = 'none';            // the widths above were measured without kerning
  span.style.fontVariantLigatures = 'none';   // and letter by letter
  span.style.setProperty('--scale-x', '1');
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Start of each letter (and the run's end) along the baseline, in em from
 * the run's origin, from the recorded glyphs. Null if too few glyphs match.
 */
function glyphStarts(it, fontHeight, letters, widths, want, glyphs) {
  const [a, b, , , ox, oy] = it.transform;
  const len = Math.hypot(a, b);
  if (!len) return null;
  const ux = a / len, uy = b / len;                    // along the baseline
  const nx = -uy, ny = ux;                             // across it
  // Candidate glyphs: on this baseline, within the run's length.
  const cand = [];
  for (let i = 0; i < glyphs.length; i += 2) {
    const dx = glyphs[i] - ox, dy = glyphs[i + 1] - oy;
    const across = (dx * nx + dy * ny) / fontHeight;
    if (Math.abs(across) > 0.25) continue;
    const along = (dx * ux + dy * uy) / fontHeight;
    if (along < -SNAP_EM || along > want + SNAP_EM) continue;
    cand.push(along);
  }
  if (!cand.length) return null;
  cand.sort((p, q) => p - q);
  // Expected starts from the font's own widths, scaled to the run's length.
  const n = widths.length;
  const natural = widths.reduce((p, q) => p + q, 0) || 1;
  const expect = [0];
  for (let k = 0; k < n; k++) expect.push(expect[k] + widths[k] * want / natural);
  // Match letters to glyphs in order: nearest unused glyph after the previous match.
  const starts = new Array(n + 1).fill(null);
  starts[n] = want;
  let next = 0;
  let matched = 0;
  let drawn = 0;
  for (let k = 0; k < n; k++) {
    if (/^\s+$/.test(letters[k])) continue;              // pdf.js draws no glyph for a space: never give it one
    drawn++;
    // The glyph must be nearer this letter than the next one, or a letter with
    // no glyph of its own (ligature) would take its neighbour's and shift the rest.
    const reach = Math.min(SNAP_EM, (expect[k + 1] - expect[k]) / 2 || SNAP_EM);
    let best = -1;
    for (let j = next; j < cand.length && cand[j] <= expect[k] + reach; j++) {
      if (Math.abs(cand[j] - expect[k]) <= reach && (best < 0 || Math.abs(cand[j] - expect[k]) < Math.abs(cand[best] - expect[k]))) best = j;
    }
    if (best >= 0 && cand[best] < want) {
      starts[k] = cand[best]; next = best + 1; matched++;
      // Drift correction: later expectations move with the real position found.
      const shift = cand[best] - expect[k];
      for (let q = k + 1; q <= n; q++) expect[q] += shift;
    }
  }
  if (!drawn || matched < Math.ceil(drawn / 2)) return null; // not this run's glyphs after all
  if (starts[0] === null) starts[0] = 0;
  // Letters without a glyph (spaces, second half of a ligature) start right
  // after the previous letter's own width, so the word before them ends where
  // its last glyph ends; any gap goes into the space itself.
  for (let k = 1; k < n; k++) {
    if (starts[k] !== null) continue;
    let j = k + 1;
    while (starts[j] === null) j++;
    for (let q = k; q < j; q++) starts[q] = Math.min(starts[q - 1] + widths[q - 1], starts[j]);
    k = j;
  }
  // Never let a letter start before the previous one (keeps widths sane if glyphs overlap).
  for (let k = 1; k <= n; k++) if (starts[k] < starts[k - 1]) starts[k] = starts[k - 1];
  return starts;
}

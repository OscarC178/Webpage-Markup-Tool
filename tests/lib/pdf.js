/**
 * tests/lib/pdf.js
 * Looks inside PDF files the browser produced, to answer "did the highlight
 * actually end up behind its words on paper?".
 *
 * Uses two command-line tools from the `poppler` package (already installed
 * on this machine): `pdftotext` (where each word is) and `pdftoppm` (a
 * picture of a page). If they are missing, available() returns false and the
 * print check says so instead of failing.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decodePpm, crop } = require('./png');
const colour = require('./colour');

const DPI = 96; // render PDFs at CSS-pixel scale: 1 PDF point = 96/72 pixels

/** Are the poppler tools installed? */
function available() {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');

/** Every word in the PDF with its box, grouped by page. Units are PDF points from the top-left of the page. */
function words(pdfFile) {
  const xml = execFileSync('pdftotext', ['-bbox', pdfFile, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const pages = [];
  const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  let pm;
  while ((pm = pageRe.exec(xml))) {
    const page = { number: pages.length + 1, width: +pm[1], height: +pm[2], words: [] };
    const wordRe = /<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([\s\S]*?)<\/word>/g;
    let wm;
    while ((wm = wordRe.exec(pm[3]))) {
      page.words.push({ xMin: +wm[1], yMin: +wm[2], xMax: +wm[3], yMax: +wm[4], text: unescapeXml(wm[5]) });
    }
    pages.push(page);
  }
  return pages;
}

/** All the text of a PDF as one string. */
function text(pdfFile) {
  return execFileSync('pdftotext', [pdfFile, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const norm = (s) => s.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').toLowerCase();

/**
 * Find a phrase in the PDF. Returns the page and the box around the part of
 * the phrase that sits on one line (the line holding most of it), or null if
 * it cannot be found, or cannot be found in exactly one place.
 *
 * Words are compared with the spaces taken out, because a PDF may split words
 * differently from the page (a drop capital "T" + "he" for "The", for example).
 * context.after / context.before = the page text straight after / before the phrase. When the
 * phrase occurs in several places, the one followed (or preceded) by that text is used.
 */
function findPhrase(pages, phrase, context = {}) {
  const tokens = norm(phrase).split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  // Try the whole phrase first, then shorter openings of it. A shortened opening is only trusted
  // when it occurs exactly once in the document; otherwise the wrong passage could be inspected.
  const tries = [...new Set([tokens.length, Math.min(tokens.length, 4), Math.min(tokens.length, 2)])];
  for (const take of tries) {
    const want = tokens.slice(0, take).join('');
    const hits = [];
    for (const page of pages) {
      const ws = page.words;
      for (let i = 0; i < ws.length; i++) {
        let acc = '';
        let j = i;
        while (j < ws.length && acc.length < want.length) { acc += norm(ws[j].text).replace(/\s+/g, ''); j++; }
        if (acc === want && norm(ws[i].text)) hits.push({ page, from: i, to: j });
      }
    }
    if (!hits.length) continue;
    let chosen = hits;
    if (hits.length > 1) {
      const squash = (t) => norm(t || '').replace(/\s+/g, '');
      const after = squash(context.after).slice(0, 24);
      const before = squash(context.before).slice(-24);
      const textFrom = (h, n) => { let acc = ''; for (let k = h.to; k < h.page.words.length && acc.length < n; k++) acc += squash(h.page.words[k].text); return acc; };
      const textUpTo = (h, n) => { let acc = ''; for (let k = h.from - 1; k >= 0 && acc.length < n; k--) acc = squash(h.page.words[k].text) + acc; return acc; };
      if (take === tokens.length && after.length >= 4) chosen = hits.filter((h) => { const t = textFrom(h, after.length); return t.startsWith(after) || after.startsWith(t); });
      else if (take === tokens.length && before.length >= 4) chosen = hits.filter((h) => { const t = textUpTo(h, before.length); return t.endsWith(before) || before.endsWith(t); });
      if (chosen.length !== 1) return null; // cannot tell which occurrence is the marked one
    }
    const hit = chosen[0];
    const matched = hit.page.words.slice(hit.from, hit.to);
    // Group the matched words into lines and keep the widest line.
    const lines = [];
    for (const w of matched) {
      const line = lines.find((l) => Math.abs(l[0].yMin - w.yMin) <= 2 && Math.abs(l[0].yMax - w.yMax) <= 2);
      if (line) line.push(w); else lines.push([w]);
    }
    const width = (l) => Math.max(...l.map((w) => w.xMax)) - Math.min(...l.map((w) => w.xMin));
    const line = lines.reduce((a, b) => (width(b) > width(a) ? b : a));
    const x0 = Math.min(...line.map((w) => w.xMin));
    return {
      page: hit.page.number,
      matchedWords: matched.length,
      // Where each word of the line sits, in pixels from the left edge of the box.
      spans: line.map((w) => [Math.floor((w.xMin - x0) * DPI / 72), Math.ceil((w.xMax - x0) * DPI / 72)]),
      box: {
        xMin: Math.min(...line.map((w) => w.xMin)), yMin: Math.min(...line.map((w) => w.yMin)),
        xMax: Math.max(...line.map((w) => w.xMax)), yMax: Math.max(...line.map((w) => w.yMax)),
      },
    };
  }
  return null;
}

/** Turn one page of a PDF into pixels. */
function renderPage(pdfFile, pageNumber) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markup-pdf-'));
  try {
    const prefix = path.join(dir, 'page');
    execFileSync('pdftoppm', ['-r', String(DPI), '-f', String(pageNumber), '-l', String(pageNumber), '-singlefile', pdfFile, prefix], { stdio: 'ignore' });
    return decodePpm(fs.readFileSync(`${prefix}.ppm`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Cut the pixels for a box given in PDF points (optionally grown by `grow` points on each side). */
function cropBox(img, box, grow = { x: 0, top: 0, bottom: 0 }) {
  const k = DPI / 72;
  return crop(img, (box.xMin - (grow.x || 0)) * k, (box.yMin - (grow.top || 0)) * k,
    (box.xMax - box.xMin + 2 * (grow.x || 0)) * k, (box.yMax - box.yMin + (grow.top || 0) + (grow.bottom || 0)) * k);
}

/** How many pixels differ noticeably between two same-sized pictures. */
function differingPixels(a, b, threshold = 40) {
  if (!a || !b) return 0;
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const oa = (y * a.width + x) * a.channels;
      const ob = (y * b.width + x) * b.channels;
      const d = Math.abs(a.data[oa] - b.data[ob]) + Math.abs(a.data[oa + 1] - b.data[ob + 1]) + Math.abs(a.data[oa + 2] - b.data[ob + 2]);
      if (d > threshold) n++;
    }
  }
  return n;
}

/**
 * How much of picture `a` differs from picture `b`, as a fraction 0..1.
 * Used as "how much of this phrase has highlight colour behind it".
 */
function coverage(a, b, threshold = 24) {
  if (!a || !b) return 0;
  const total = Math.min(a.width, b.width) * Math.min(a.height, b.height);
  return total ? differingPixels(a, b, threshold) / total : 0;
}

/**
 * Fraction of pixel columns in which `a` differs from `b`.
 * minShare = how much of a column's height must differ for the column to count
 *            (0 = any pixel: right for a thin line; 0.5 = half the height: right for a filled highlight).
 * skipInk  = leave out columns where `b` (the unmarked page) has lettering in them, plus 3 pixels
 *            either side. Browsers break an underline where a letter's tail crosses it, so those
 *            columns say nothing about whether the underline is in the right place. If that would
 *            leave out most of the width (the text already had a line under it, as links do),
 *            nothing is left out.
 * spans   = [[fromX, toX], ...] in pixels: only these columns are judged (the words themselves,
 *            not the gaps between table cells, where there is nothing to highlight).
 */
function columnCoverage(a, b, threshold = 40, minShare = 0, skipInk = false, spans = null) {
  if (!a || !b) return 0;
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const px = (img, x, y) => { const o = (y * img.width + x) * img.channels; return [img.data[o], img.data[o + 1], img.data[o + 2]]; };
  const skip = new Array(w).fill(false);
  if (skipInk) {
    const bg = colour.summarisePixels(b).background;
    // Which rows hold the line? Those where at least half the columns differ from the unmarked page.
    const lineRows = [];
    for (let y = 0; y < h; y++) {
      let n = 0;
      for (let x = 0; x < w; x++) {
        const p = px(a, x, y);
        const q = px(b, x, y);
        if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > threshold) n++;
      }
      if (n >= w * 0.5) lineRows.push(y);
    }
    const y0 = lineRows.length ? Math.max(0, lineRows[0] - 1) : 0;
    const y1 = lineRows.length ? Math.min(h - 1, lineRows[lineRows.length - 1] + 1) : -1;
    for (let x = 0; x < w; x++) {
      for (let y = y0; y <= y1; y++) {
        const p = px(b, x, y);
        if (Math.abs(p[0] - bg.r) + Math.abs(p[1] - bg.g) + Math.abs(p[2] - bg.b) > 90) {
          for (let k = Math.max(0, x - 3); k <= Math.min(w - 1, x + 3); k++) skip[k] = true;
          break;
        }
      }
    }
  }
  if (skip.filter(Boolean).length > w * 0.6) skip.fill(false);
  if (spans && spans.length) for (let x = 0; x < w; x++) if (!spans.some(([f, t]) => x >= f && x <= t)) skip[x] = true;
  let cols = 0;
  let counted = 0;
  for (let x = 0; x < w; x++) {
    if (skip[x]) continue;
    counted++;
    let differing = 0;
    for (let y = 0; y < h; y++) {
      const p = px(a, x, y);
      const q = px(b, x, y);
      if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > threshold) differing++;
    }
    if (differing > 0 && differing >= minShare * h) cols++;
  }
  return counted ? cols / counted : 0;
}

/** Open a PDF for inspection. Word positions and page pictures are worked out once and reused. */
function open(pdfFile) {
  return { file: pdfFile, pages: words(pdfFile), renders: new Map() };
}

/**
 * Inspect an opened PDF for one marked phrase.
 * Returns the most common colour behind the phrase's first line and a cut-out
 * of the strip just under it (where an underline would be), or null when the
 * phrase is not in the PDF.
 */
function inspectPhrase(doc, phrase, context) {
  const hit = findPhrase(doc.pages, phrase, context);
  if (!hit) return null;
  if (!doc.renders.has(hit.page)) doc.renders.set(hit.page, renderPage(doc.file, hit.page));
  const img = doc.renders.get(hit.page);
  const area = cropBox(img, hit.box);
  const strip = cropBox(img, { ...hit.box, yMin: hit.box.yMax - 3 }, { bottom: 5 });
  return {
    page: hit.page,
    box: hit.box,
    matchedWords: hit.matchedWords,
    spans: hit.spans,
    background: area ? colour.summarisePixels(area).background : null,
    area,
    strip,
  };
}

module.exports = { coverage, columnCoverage, available, open, words, text, findPhrase, renderPage, cropBox, differingPixels, inspectPhrase, DPI };

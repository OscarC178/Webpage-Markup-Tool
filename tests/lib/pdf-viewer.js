/**
 * tests/lib/pdf-viewer.js
 * Helpers for check (p): driving the extension's PDF viewer
 * (viewer/viewer.html) and judging it.
 *
 * THE GROUND TRUTH IS NOT THE EXTENSION. Which words sit on which line, and
 * where they are on the page, come from poppler (`pdftotext -bbox-layout`)
 * reading the PDF file itself. The harness finds those words on screen with its
 * own small text walker (it does not use the extension's text code), so the
 * quotes the extension saves and the boxes it paints are compared with an
 * independent answer.
 */
const { execFileSync } = require('child_process');
const h = require('./harness');

const sleep = h.sleep;

/** Names of things in the viewer and in the popup's PDF section. Change them here if the viewer changes. */
const VIEWER = {
  path: 'viewer/viewer.html',
  loadAttr: 'data-wmt-load', // on <html>: network | stash | picked | failed | none | handover | unsupported
  textAttr: 'data-wmt-text', // on <html>: none | some | all
  page: (n) => `#viewer .page[data-page-number="${n}"]`,
  container: '#viewerContainer',
  message: '#message',
  pageCount: '#pageCount',
  pageNumber: '#pageNumber',
  title: '#docTitle',
  zoomIn: '#zoomIn',
  zoomOut: '#zoomOut',
  zoomFit: '#zoomFit',
  printButton: '#printBtn',
  printCopy: '#wmtPrint',
  popup: { section: '#pdfSection', open: '#pdfOpenBtn', status: '#pdfStatus', main: '#main' },
  keyPrefix: 'urn:x-wmt-pdf:',
};

const strip = (s) => String(s).replace(/\s+/g, '');
const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');

// ---------------------------------------------------------------------------
// Ground truth from poppler
// ---------------------------------------------------------------------------

/**
 * Pages of a PDF as poppler reads them: [{ number, width, height, rot, lines }].
 * width/height are the page AS SEEN (rotation applied), in PDF points; word
 * boxes are in the same space, from the top-left. lines = [{ words: [{x0,y0,x1,y1,text}] }].
 */
function readPdf(file) {
  const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  const info = sh('pdfinfo', ['-f', '1', '-l', '9999', file]);
  const sizes = [...info.matchAll(/^Page\s+\d+ size:\s+([\d.]+) x ([\d.]+)/mg)].map((m) => [+m[1], +m[2]]);
  const rots = [...info.matchAll(/^Page\s+\d+ rot:\s+(\d+)/mg)].map((m) => +m[1]);
  const xml = sh('pdftotext', ['-bbox-layout', file, '-']);
  const chunks = xml.split(/<page /).slice(1);
  return sizes.map(([w, hgt], i) => {
    const rot = rots[i] || 0;
    const lines = [...(chunks[i] || '').matchAll(/<line [^>]*>([\s\S]*?)<\/line>/g)].map((l) => ({
      words: [...l[1].matchAll(/<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([\s\S]*?)<\/word>/g)]
        .map((m) => ({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], text: unescapeXml(m[5]) })),
    })).filter((l) => l.words.length);
    return { number: i + 1, width: rot % 180 ? hgt : w, height: rot % 180 ? w : hgt, rot, lines };
  });
}

const cache = new Map();
/** readPdf(), worked out once per file. */
function readPdfCache(file) {
  if (!cache.has(file)) cache.set(file, readPdf(file));
  return cache.get(file);
}

const union = (boxes) => ({
  x0: Math.min(...boxes.map((b) => b.x0)), y0: Math.min(...boxes.map((b) => b.y0)),
  x1: Math.max(...boxes.map((b) => b.x1)), y1: Math.max(...boxes.map((b) => b.y1)),
});

/**
 * A box in "reading" terms: along = the direction the words run, across = from
 * one line to the next (positive = further down the page as read).
 * Only upright pages and pages turned 90 degrees are used by these checks.
 */
function reading(box, rot) {
  if (rot === 90) return { start: box.y0, end: box.y1, top: -box.x1, bottom: -box.x0 };
  return { start: box.x0, end: box.x1, top: box.y0, bottom: box.y1 };
}

/**
 * Phrases that cross a line end: the last words of one line and the first
 * words of the next (two of each, or more if needed to be unique). `quote` is what a reader would expect to be saved (words
 * joined by one space). `boxes` are where those words are (one box per line).
 * Only phrases that occur exactly once on the page are returned. Chosen evenly
 * through the page; `column` ('left' | 'right') limits them to one half.
 */
function crossLinePhrases(page, count, { column = null, avoid = [] } = {}) {
  const all = strip(page.lines.map((l) => l.words.map((w) => w.text).join('')).join(''));
  const used = new Set(avoid.flatMap((p) => p.lineNos));
  const found = [];
  for (let i = 0; i + 1 < page.lines.length; i++) {
    const a = page.lines[i].words;
    const b = page.lines[i + 1].words;
    if (a.length < 4 || b.length < 4) continue;
    const ra = reading(union(a), page.rot);
    const rb = reading(union(b), page.rot);
    const height = ra.bottom - ra.top;
    // The next line must really be the line below, in the same column, in the same body text.
    if (Math.abs(ra.start - rb.start) > 30 || rb.top - ra.top <= 0 || rb.top - ra.top > height * 2.4) continue;
    if (Math.abs(height - (rb.bottom - rb.top)) > 2) continue;
    if (/[-‐­]$/.test(a[a.length - 1].text)) continue; // hyphenated breaks are tested on their own
    // Two words from each line; more where the page repeats itself, until the phrase occurs only once.
    let first;
    let second;
    let words;
    let key = null;
    for (let n = 2; n <= Math.min(7, a.length - 1, b.length - 1) && !key; n++) {
      first = a.slice(-n);
      second = b.slice(0, n);
      words = [...first, ...second].map((w) => w.text);
      const k = strip(words.join(''));
      if (all.indexOf(k) === all.lastIndexOf(k)) key = k;
    }
    if (!key) continue;
    if (column === 'left' && first[0].x0 > page.width / 2) continue;
    if (column === 'right' && b[0].x0 < page.width / 2) continue;
    found.push({ page: page.number, rot: page.rot, key, quote: words.join(' '), boxes: [union(first), union(second)], words: [...first, ...second], lineNos: [i, i + 1] });
  }
  // Take every other candidate at most, evenly spread, never sharing a line.
  const out = [];
  const step = Math.max(1, found.length / (count * 1.5));
  for (let k = 0; out.length < count && k < found.length * 2; k++) {
    const c = found[k < found.length / step ? Math.floor(k * step) : k % found.length];
    if (!c || c.lineNos.some((n) => used.has(n))) continue;
    c.lineNos.forEach((n) => used.add(n));
    out.push(c);
  }
  return out;
}

/** Phrases inside a single line (for pages with hardly any line ends), not touching `avoid`. */
function inLinePhrases(page, count, avoid = []) {
  const all = strip(page.lines.map((l) => l.words.map((w) => w.text).join('')).join(''));
  const used = new Set(avoid.flatMap((p) => p.lineNos));
  const out = [];
  for (let i = 0; i < page.lines.length && out.length < count; i++) {
    const line = page.lines[i].words;
    // A line already holding part of another phrase is used only from its middle, away from its ends.
    const start = used.has(i) ? Math.floor(line.length / 2) - 1 : 0;
    for (let at = start; at + 2 <= line.length && out.length < count; at += 3) {
      if (used.has(i) && (at < 3 || at + 2 > line.length - 3)) continue;
      const words = line.slice(at, at + 2);
      const key = strip(words.map((w) => w.text).join(''));
      if (key.length < 5 || all.indexOf(key) !== all.lastIndexOf(key)) continue;
      out.push({ page: page.number, rot: page.rot, key, quote: words.map((w) => w.text).join(' '), boxes: [union(words)], words, lineNos: [i] });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Driving the viewer
// ---------------------------------------------------------------------------

/** Wait until the viewer has loaded (or failed to load) a PDF. Returns the load state. */
async function viewerReady(page, timeout = 45000) {
  await page.waitForFunction((a) => { const s = document.documentElement.getAttribute(a); return s && s !== 'handover'; }, VIEWER.loadAttr, { timeout });
  const how = await page.evaluate((a) => document.documentElement.getAttribute(a), VIEWER.loadAttr);
  if (how !== 'failed' && how !== 'none' && how !== 'unsupported') {
    await page.waitForSelector(`${VIEWER.page(1)} .textLayer .endOfContent`, { state: 'attached', timeout });
    await h.isInjected(page, 8000);
    await sleep(1000); // content.js looks for marks 300 ms after the text appears
  }
  return how;
}

/** Has pdf.js built the text of page n? */
const hasText = (page, n) => page.evaluate((s) => !!document.querySelector(s), `${VIEWER.page(n)} .textLayer .endOfContent`);

/** Scroll to page n using the viewer's own page box, as a person would, and wait for its text. */
async function goToPage(page, n) {
  const box = page.locator(VIEWER.pageNumber);
  await box.fill(String(n === 1 ? 2 : 1)); // force a "change" even if the box already shows n
  await box.press('Enter');
  await box.fill(String(n));
  await box.press('Enter');
  await box.evaluate((el) => el.blur());
  await page.waitForSelector(`${VIEWER.page(n)} .textLayer .endOfContent`, { state: 'attached', timeout: 30000 });
  await sleep(800);
}

/**
 * Find a phrase (given without any spaces) in the text of page n, with the
 * harness's own walker. mode 'reveal' scrolls it to the middle of the window;
 * 'rects' returns its on-screen boxes and drag points; 'select' selects it in code.
 */
function onPagePhrase(page, n, key, mode, rot = 0) {
  return page.evaluate(({ selector, key, mode, rot, container }) => {
    const layer = document.querySelector(`${selector} .textLayer`);
    if (!layer) return null;
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    let flat = '';
    const map = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement.closest('[data-wmt-marker]')) continue;
      for (let i = 0; i < node.data.length; i++) {
        if (/\s/.test(node.data[i])) continue;
        flat += node.data[i];
        map.push([node, i]);
      }
    }
    const at = flat.indexOf(key);
    if (at < 0) return null;
    const range = document.createRange();
    range.setStart(map[at][0], map[at][1]);
    const last = map[at + key.length - 1];
    range.setEnd(last[0], last[1] + 1);
    const charRect = ([node, i]) => { const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 1); return r.getBoundingClientRect(); };
    if (mode === 'reveal') {
      const box = document.querySelector(container);
      const c = box.getBoundingClientRect();
      const r = range.getBoundingClientRect();
      box.scrollTop += r.top + r.height / 2 - (c.top + c.height / 2);
      if (r.left < c.left || r.right > c.right) box.scrollLeft += r.left + r.width / 2 - (c.left + c.width / 2);
      return true;
    }
    if (mode === 'select') {
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(range);
      const r = charRect(last);
      const target = document.elementFromPoint(r.right - 1, r.top + r.height / 2) || layer;
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.right - 1, clientY: r.top + r.height / 2, button: 0 }));
      return true;
    }
    const a = charRect(map[at]);
    const b = charRect(last);
    return rot === 90
      ? { from: { x: a.left + a.width / 2, y: a.top + 0.5 }, to: { x: b.left + b.width / 2, y: b.bottom - 0.5 } }
      : { from: { x: a.left + 0.5, y: a.top + a.height / 2 }, to: { x: b.right - 0.5, y: b.top + b.height / 2 } };
  }, { selector: VIEWER.page(n), key, mode, rot, container: VIEWER.container });
}

/** Select a phrase: a real mouse drag first; if that does not give exactly these words, set it in code and say so. */
async function selectPhrase(page, phrase) {
  if (!(await onPagePhrase(page, phrase.page, phrase.key, 'reveal'))) return { ok: false, why: `the words "${phrase.quote}" are not in the viewer's text for page ${phrase.page}` };
  await sleep(300);
  await page.evaluate(() => getSelection().removeAllRanges());
  const plan = await onPagePhrase(page, phrase.page, phrase.key, 'rects', phrase.rot);
  await page.mouse.move(plan.from.x, plan.from.y);
  await page.mouse.down();
  await page.mouse.move((plan.from.x + plan.to.x) / 2, (plan.from.y + plan.to.y) / 2, { steps: 4 });
  await page.mouse.move(plan.to.x, plan.to.y, { steps: 6 });
  await page.mouse.up();
  await sleep(150);
  const got = await page.evaluate(() => getSelection().toString());
  if (strip(got) === phrase.key) return { ok: true, method: 'drag' };
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.keyboard.press('Escape');
  await sleep(100);
  await onPagePhrase(page, phrase.page, phrase.key, 'select');
  await sleep(100);
  const again = await page.evaluate(() => getSelection().toString());
  return { ok: strip(again) === phrase.key, method: 'set in code', why: `a real mouse drag selected "${h.normaliseText(got).slice(0, 80)}"` };
}

/** Where the extension paints this phrase, one box per painted piece (viewport coordinates). */
async function paintedFor(page, phrase) {
  const drawn = await h.getMarkups(page);
  return drawn.filter((d) => strip(d.text) === phrase.key);
}

/** Where page n's picture is on screen, and pixels per PDF point. */
function pageFrame(page, n, widthPt) {
  return page.evaluate(([s, w]) => {
    const canvas = document.querySelector(`${s} canvas`);
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return { left: r.left, top: r.top, scale: r.width / w };
  }, [VIEWER.page(n), widthPt]);
}

/**
 * Is the phrase painted on its words? Compares the painted boxes with where
 * poppler says the words are on the page PICTURE (so a text layer that has
 * drifted from the picture is caught). For each line: the start and end along
 * the line, and the middle across it, must be within `tol` pixels.
 */
async function judgeAlignment(page, pdfPage, phrase, kind, tol = 3) {
  const frame = await pageFrame(page, phrase.page, pdfPage.width);
  if (!frame) return { ok: false, summary: `page ${phrase.page} is not drawn`, worst: null };
  const painted = await paintedFor(page, phrase);
  if (!painted.length) return { ok: false, summary: 'nothing is painted for these words', worst: null };
  const entry = painted.find((p) => p.kind === kind) || painted[0];
  const toScreen = (b) => ({ x0: frame.left + b.x0 * frame.scale, y0: frame.top + b.y0 * frame.scale, x1: frame.left + b.x1 * frame.scale, y1: frame.top + b.y1 * frame.scale });
  const rects = entry.rects.map((r) => ({ x0: r.left, y0: r.top, x1: r.right, y1: r.bottom }));
  const lines = [];
  const claimed = new Set();
  let worst = 0;
  const expected = phrase.boxes.map(toScreen);
  for (const box of expected) {
    const e = reading(box, phrase.rot);
    const mine = rects.filter((r, i) => {
      const p = reading(r, phrase.rot);
      const mid = (p.top + p.bottom) / 2;
      const on = mid > e.top && mid < e.bottom;
      if (on) claimed.add(i);
      return on;
    });
    if (!mine.length) { lines.push('a line of the phrase has no paint'); worst = Infinity; continue; }
    const p = reading(union(mine), phrase.rot);
    const d = { start: p.start - e.start, end: p.end - e.end, middle: (p.top + p.bottom - e.top - e.bottom) / 2 };
    worst = Math.max(worst, Math.abs(d.start), Math.abs(d.end), Math.abs(d.middle));
    lines.push(`start ${d.start.toFixed(1)}, end ${d.end.toFixed(1)}, middle ${d.middle.toFixed(1)}px`);
  }
  const stray = rects.filter((r, i) => !claimed.has(i) && r.x1 - r.x0 > tol && r.y1 - r.y0 > tol).length;
  const kindOk = entry.kind === kind;
  const ok = worst <= tol && !stray && kindOk;
  return {
    ok, worst: Number.isFinite(worst) ? Math.round(worst * 10) / 10 : null, expected,
    summary: `${lines.join(' / ')}${stray ? `; ${stray} painted box(es) off the phrase` : ''}${kindOk ? '' : `; painted as ${entry.kind}, should be ${kind}`}`,
  };
}

module.exports = { VIEWER, strip, readPdf, readPdfCache, union, reading, crossLinePhrases, inLinePhrases, viewerReady, hasText, goToPage, onPagePhrase, selectPhrase, paintedFor, pageFrame, judgeAlignment };

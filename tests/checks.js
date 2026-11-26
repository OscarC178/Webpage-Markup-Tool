/**
 * tests/checks.js
 * The list of checks the runner performs on every test site (extension version 2).
 *
 * HOW TO ADD A CHECK: append an object to CHECKS at the bottom of this file:
 *   {
 *     id: 'w',                      // letter shown in the results table
 *     key: 'my-check',              // short name used in file names
 *     title: 'What it proves',      // shown to people
 *     plain: 'One sentence a non-developer understands.',
 *     applies: (site, extras) => true, // optional: return false to mark it "n/a" for a site
 *     needs: (state) => null,       // optional: return a reason string to skip (e.g. nothing to test)
 *     run: async (ctx) => ({ status: 'pass' | 'fail' | 'gap' | 'skip', reason: '...', details: {...} }),
 *   }
 * Checks run in the order of the CHECKS array and share `ctx.state`.
 * No selector for the extension's UI appears in this file: they all come from
 * lib/harness.js (SELECTORS), so a redesign only needs that one map changed.
 *
 * ctx = { session, page, site, extras, url, baseUrl, fixtureUrl, state, errors, reference, headed, pdfTools, shot(), sheet() }
 */

const fs = require('fs');
const path = require('path');
const h = require('./lib/harness');
const colour = require('./lib/colour');
const pdf = require('./lib/pdf');
const { decodePng } = require('./lib/png');
const makePdfCheck = require('./pdf-check');

const S = h.SELECTORS;
const sleep = h.sleep;
const inUi = (sel) => `${S.host} ${sel}`; // Playwright looks inside open shadow roots

// Tunable numbers, in one place.
const LIMITS = {
  alignPx: 2,             // painted text must be within this many pixels of the selected text
  layoutPx: 0.5,          // host page elements may not move/resize by more than this
  contrastMin: 4.5,       // WCAG AA contrast for normal text
  deltaEMin: 10,          // a highlight must differ from the plain background by at least this (CIE76)
  paintedMin: 0.02,       // share of pixels that must change on screen for a markup to count as painted
  noteTyping: 'Harness note 0123456789 abcdef', // exactly 30 characters
  slots: 3,               // each target's text is split in 3: highlight, underline, note
  noteSaveMs: 2500,       // how long to wait for the card to say "Saved"
};

// CSS properties compared in check (m).
const UI_PROPS = [
  'display', 'visibility', 'opacity', 'position', 'box-sizing',
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-transform', 'text-align',
  'color', 'background-color',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-left-radius',
  'transform',
];
const HOST_PROPS = [
  'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'display', 'position',
  'visibility', 'opacity', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-width', 'border-bottom-width',
  'text-decoration-line', 'transform', 'z-index', 'overflow-x', 'overflow-y', 'width', 'height',
];

// Version 1 data used by the migration check (t). It points at tests/fixtures/migrate/index.html.
const V1_SEED = {
  page: '/migrate/index.html',
  items: [
    { id: 'markup-1700000000001-v1hl', type: 'highlight', selector: '#m1', text: 'rebuilt in 1911', color: '#fff888' },
    { id: 'markup-1700000000002-v1ul', type: 'underline', selector: '#m2', text: 'tie up there every evening', color: '#ff5555' },
    { id: 'note-1700000000003', type: 'note', selector: '#m3', text: 'brass plate', note: 'Check the date of the storm.' },
  ],
};

// ===========================================================================
// Small shared helpers
// ===========================================================================

const short = (s, n = 40) => {
  const t = h.normaliseText(s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const round1 = (n) => Math.round(n * 10) / 10;
const labelOf = (m) => `${m.note ? 'note' : m.type} on ${m.target}`;

/** Close the toolbar the way a person would: clear the selection and press Escape. */
async function dismissToolbar(page) {
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.keyboard.press('Escape');
  await sleep(60);
}

/**
 * Turn a list of per-item outcomes into one check result.
 * Fails if any item failed; passes if at least one passed and none failed.
 * "gap" items are things the extension leaves alone by design; they never fail a check.
 */
function summarise(items, what) {
  const by = (s) => items.filter((i) => i.status === s);
  const pass = by('pass');
  const fail = by('fail');
  const skip = by('skip');
  const gap = by('gap');
  const tried = pass.length + fail.length;
  let status = 'pass';
  if (fail.length) status = 'fail';
  else if (!pass.length) status = gap.length ? 'gap' : 'skip';
  const bits = [];
  if (tried) bits.push(`${pass.length} of ${tried} ${what} OK.`);
  else bits.push(`No ${what} could be tested.`);
  if (fail.length) bits.push('FAILED: ' + fail.map((i) => `[${i.name}] ${i.reason}`).join(' | '));
  if (gap.length) bits.push('Left alone by design: ' + gap.map((i) => `[${i.name}] ${i.reason}`).join(' | '));
  if (skip.length) bits.push('Not testable: ' + skip.map((i) => `[${i.name}] ${i.reason}`).join(' | '));
  return { status, reason: bits.join(' '), items };
}

/**
 * Compare the words of a PDF made with markups against the PDF of the untouched page.
 * The marked PDF legitimately has two additions: a small number after each annotated passage and, at
 * the end, the "Notes on this page" list. Both are taken out; everything else must be identical, in
 * the same order. Returns { ok, dropped, altered, words, markers, listCut, examples }.
 */
function comparePdfText(controlText, markedText, listStrings = []) {
  const words = (t) => String(t).replace(/\f/g, ' ').split(/\s+/).filter(Boolean);
  const C = words(controlText);
  let M = words(markedText);
  // The notes list starts at the LAST "Notes on this page" heading. Page text can still follow it in the
  // extracted text (the PDF reader sometimes reads a fixed bar after it), so the part after the heading is kept as a tail.
  let tail = [];
  let listCut = false;
  for (let i = M.length - 4; i >= 0; i--) {
    if (M[i] === 'Notes' && M[i + 1] === 'on' && M[i + 2] === 'this' && M[i + 3] === 'page') { tail = M.slice(i + 4); M = M.slice(0, i); listCut = true; break; }
  }
  // Take the list's own words (source line, each quote, each note) out of the tail.
  const dropSeq = (arr, seq) => {
    if (!seq.length) return arr;
    for (let i = 0; i + seq.length <= arr.length; i++) {
      let hit = true;
      for (let k = 0; k < seq.length; k++) if (arr[i + k] !== seq[k]) { hit = false; break; }
      if (hit) return arr.slice(0, i).concat(arr.slice(i + seq.length));
    }
    return arr;
  };
  for (const str of listStrings) tail = dropSeq(tail, words(str));
  const isMarker = (w) => /^\d{1,2}$/.test(w);
  const out = { ok: true, dropped: 0, altered: 0, words: C.length, markers: 0, listCut, examples: [] };
  let i = 0; // marked
  let j = 0; // control
  const pending = []; // control words not found in step: they must turn up after the notes list
  const note = (kind, a, b) => { if (out.examples.length < 4) out.examples.push(`${kind} near "${C.slice(Math.max(0, j - 3), j + 3).join(' ')}"${a ? `: control has "${a}"` : ''}${b ? `, marked PDF has "${b}"` : ''}`); };
  while (i < M.length && j < C.length) {
    if (M[i] === C[j]) { i++; j++; continue; }
    if (isMarker(M[i]) && out.markers < 200) { out.markers++; i++; continue; } // a number the extension added
    // Resynchronise: is the control's word a little further on in the marked text (extra words), or the marked word further on in the control (dropped words)?
    const ahead = (arr, from, w, n = 40) => { for (let k = 1; k <= n && from + k < arr.length; k++) if (arr[from + k] === w) return k; return -1; };
    const inM = ahead(M, i, C[j]);
    const inC = ahead(C, j, M[i]);
    if (inC > 0 && (inM < 0 || inC <= inM)) { pending.push(...C.slice(j, j + inC)); j += inC; } // maybe read later, after the notes list: settled below
    else if (inM > 0) { out.altered += inM; out.ok = false; note('extra words in the marked PDF', C[j], M.slice(i, i + inM).join(' ')); i += inM; }
    else { out.altered++; out.ok = false; note('a word differs', C[j], M[i]); i++; j++; }
  }
  while (i < M.length && isMarker(M[i])) { out.markers++; i++; }
  // Control words not matched before the heading must be the page text the reader put after the list.
  const left = pending.concat(C.slice(j));
  const rest = M.slice(i);
  for (const w of rest) { const k = left.indexOf(w); if (k >= 0) left.splice(k, 1); else if (!isMarker(w)) { out.altered++; out.ok = false; note('extra text in the marked PDF', '', w); } }
  const pool = tail.slice();
  for (const w of left) {
    const k = pool.indexOf(w);
    if (k >= 0) pool.splice(k, 1);
    else { out.dropped++; out.ok = false; note('page words missing from the marked PDF', w, ''); }
  }
  out.tailMoved = left.length;
  return out;
}

/** Marks that should currently be on the page. */
const activeMarks = (state, type) => state.marks.filter((m) => !m.removed && (!type || m.type === type));

/**
 * For every mark: where is its text now, and what is the extension painting for it?
 * A mark is "aligned" when the highlight registry holds a range whose words equal
 * the marked words and whose on-screen rectangles match the text's rectangles.
 * If the page itself has since changed the words, the right outcome is that
 * nothing is painted there (never a mark on different words).
 * Returns [{mark, cmp, entry, changedByPage}].
 */
async function measure(page, marks, allTexts) {
  if (!marks.length) return [];
  const texts = await page.evaluate((list) => list.map((m) => {
    let el = null;
    try { el = document.querySelector(m.selector); } catch (e) { /* bad selector */ }
    if (!el) return null;
    return { rects: window.__mh.textRects(el, m.startOffset, m.endOffset), now: window.__mh.fullText(el).slice(m.startOffset, m.endOffset) };
  }), marks.map((m) => ({ selector: m.selector, startOffset: m.startOffset, endOffset: m.endOffset })));
  const drawn = await h.getMarkups(page);
  const known = new Set((allTexts || marks.map((m) => m.text)).map(h.normaliseText));
  const touches = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
  return marks.map((mark, i) => {
    const t = texts[i];
    const want = h.normaliseText(mark.text);
    const changedByPage = !!t && h.normaliseText(t.now) !== want;
    if (changedByPage) {
      // Is anything of ours painted where the old words were, on words nobody marked?
      const wrong = drawn.filter((d) => !known.has(h.normaliseText(d.text)) && d.rects.some((r) => t.rects.some((x) => touches(r, x))));
      const ok = wrong.length === 0;
      return {
        mark, changedByPage, entry: null,
        cmp: {
          ok,
          summary: ok
            ? 'the page has changed these words since; nothing is painted in their place (correct)'
            : `the page changed these words and the markup is now painted on different words: "${short(wrong[0].text)}"`,
        },
      };
    }
    const textHidden = !t || !t.rects.length; // the words exist but occupy no space (hidden by the page)
    const sameWords = drawn.filter((d) => h.normaliseText(d.text) === want);
    if (!sameWords.length) {
      const cmp = h.compareRects(t ? t.rects : null, [], LIMITS.alignPx);
      if (t && t.rects.length) cmp.summary = 'nothing is painted for these words (no matching range in the browser\'s highlight registry)';
      return { mark, changedByPage, textHidden, entry: null, cmp };
    }
    let best = null;
    for (const d of sameWords) {
      const cmp = h.compareRects(t ? t.rects : null, d.rects, LIMITS.alignPx);
      const kindOk = d.kind === mark.type;
      const score = (cmp.ok ? 2 : 0) + (kindOk ? 1 : 0);
      if (!best || score > best.score) best = { score, cmp, entry: d, kindOk };
    }
    if (best.cmp.ok && !best.kindOk) {
      best.cmp.ok = false;
      best.cmp.summary = `painted as ${best.entry.kind} (${best.entry.name}) but it should be ${mark.type === 'underline' ? 'an underline' : 'a highlight'}`;
    } else if (best.cmp.ok) {
      best.cmp.summary += ` (${best.entry.name})`;
    }
    return { mark, changedByPage, textHidden, entry: best.entry, cmp: best.cmp };
  });
}

/** Keep measuring until every mark lines up or the time runs out (the extension re-finds text after a short delay). */
async function measureUntilAligned(page, marks, timeout = 1500, allTexts) {
  const end = Date.now() + timeout;
  let res = await measure(page, marks, allTexts);
  while (res.some((r) => !r.cmp.ok) && Date.now() < end) {
    await sleep(200);
    res = await measure(page, marks, allTexts);
  }
  return res;
}

/** Scroll a mark's text into the middle of the window (for screenshots and clicks). */
async function reveal(ctx, mark) {
  if (!mark) return;
  await ctx.page.evaluate((m) => {
    let el = null;
    try { el = document.querySelector(m.selector); } catch (e) { /* ignore */ }
    if (el) window.__mh.revealText(el, m.startOffset, m.endOffset);
  }, { selector: mark.selector, startOffset: mark.startOffset, endOffset: mark.endOffset });
  await sleep(300);
}

/** Photograph a small region of the window. Returns the decoded picture, or null. */
async function grab(page, rect, growBottom = 0) {
  const vp = page.viewportSize();
  const x = Math.max(0, Math.floor(rect.left));
  const y = Math.max(0, Math.floor(rect.top));
  const w = Math.min(vp.width - x, Math.ceil(rect.right) - x);
  const hgt = Math.min(vp.height - y, Math.ceil(rect.bottom + growBottom) - y);
  if (w < 3 || hgt < 3) return null;
  try {
    return decodePng(await page.screenshot({ clip: { x, y, width: w, height: hgt }, animations: 'disabled', timeout: 5000 }));
  } catch (e) {
    return null;
  }
}

/** Computed CSS and size of parts of the extension's UI (for the CSS-conflict check). */
async function captureUi(page, parts) {
  return page.evaluate(async ([Sel, props, wanted]) => {
    const host = document.querySelector(Sel.host);
    const root = host && host.shadowRoot;
    if (!root) return null;
    // The controls fade and grow in; read their CSS only once that has finished.
    const running = root.getAnimations ? root.getAnimations() : [];
    await Promise.race([
      Promise.all(running.map((a) => a.finished.catch(() => null))),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
    const out = {};
    for (const [name, sel] of wanted) {
      const el = root.querySelector(sel);
      if (!el || el.hidden) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const o = { rectWidth: r.width, rectHeight: r.height };
      for (const p of props) o[p] = cs.getPropertyValue(p);
      out[name] = o;
    }
    return Object.keys(out).length ? out : null;
  }, [S, UI_PROPS, parts]);
}
const TOOLBAR_PARTS = [
  ['toolbar', S.toolbar],
  ['toolbar highlight button', `${S.toolbar} ${S.toolbarButtons.highlight}`],
  ['toolbar underline button', `${S.toolbar} ${S.toolbarButtons.underline}`],
  ['toolbar note button', `${S.toolbar} ${S.toolbarButtons.note}`],
];
const CARD_PARTS = [
  ['note card', S.card],
  ['note text box', `${S.card} ${S.cardTextarea}`],
  ['note delete button', `${S.card} ${S.cardDelete}`],
  ['note close button', `${S.card} ${S.cardClose}`],
];
const PIN_PARTS = [['note pin', S.pin]];

// ---- Notes on the page (margin notes and labels) -----------------------------------------------
// A note's on-page element is the margin note, or the label (.pin.label, data-place a|b|c|d), or the
// plain pin when "Show notes on the page" is off. h.noteElementFor() picks whichever exists.

/** How much two rectangles overlap, in px (0 when they only touch or are apart). */
const overlapOf = (a, b) => ({
  w: Math.min(a.right, b.right) - Math.max(a.left, b.left),
  h: Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
});
/** True when two rectangles share real area (more than 1px across and 2px down: rounding is not an overlap). */
const sharesArea = (a, b) => { const o = overlapOf(a, b); return o.w > 1 && o.h > 2; };

/**
 * Judge a note's on-page element: on screen, on top, showing the note text, clear of its own passage,
 * and (margin notes and labels at places a, b, c) clear of every word on the page. A last-resort
 * label (place d) that covers other words is recorded, not failed.
 * @returns {{problems:string[], info:string[], el:object|null, ui:object, passage:object[], coverPx:number}}
 */
async function judgeNoteOnPage(page, note) {
  const ui = await h.getUi(page);
  const el = h.noteElementFor(ui, note.id);
  const passage = (await h.getTextRects(page, note.selector, note.startOffset, note.endOffset)) || [];
  const problems = [];
  const info = [];
  let coverPx = 0;
  if (!el) {
    problems.push('no margin note, label or pin is shown for the note');
    return { problems, info, el, ui, passage, coverPx };
  }
  const kindName = el.kind === 'margin' ? 'margin note' : el.kind === 'label' ? `label (place ${el.place || '?'}${el.compact ? ', compact' : ''})` : 'plain pin';
  if (!el.shown) { problems.push(`the ${kindName} is hidden or has no size`); return { problems, info, el, ui, passage, coverPx }; }
  if (!el.inWindow) problems.push(`the ${kindName} is outside the window although its words are on screen`);
  else if (!el.onTop) problems.push(`the ${kindName} is hidden behind <${el.top}>`);
  // Visible text.
  const flat = String(note.note).replace(/\s+/g, ' ').trim();
  if (el.kind === 'margin') {
    if (!el.text.startsWith(flat)) problems.push(`the margin note shows "${short(el.text, 40)}" instead of the note "${short(flat, 40)}"`);
  } else if (el.kind === 'label') {
    const head = flat.slice(0, Math.min(12, flat.length)).trimEnd();
    const shownText = el.text.replace(/…$/, '');
    if (!shownText.startsWith(head)) problems.push(`the label shows "${short(el.text, 40)}" which does not start with the note's first characters "${head}"`);
  }
  if (el.kind === 'label' && !['a', 'b', 'c', 'd'].includes(el.place)) problems.push(`the label's data-place is ${JSON.stringify(el.place)}, not a, b, c or d`);
  // Not on its own passage.
  if (passage.some((t) => sharesArea(t, el.rect))) problems.push(`the ${kindName} overlaps its own passage`);
  // Not on any other page text.
  const words = await h.pageTextRects(page);
  const covered = words.filter((t) => sharesArea(t, el.rect));
  coverPx = Math.round(covered.reduce((sum, t) => sum + Math.max(0, overlapOf(t, el.rect).w), 0));
  const lastResort = el.kind === 'label' && el.place === 'd';
  if (covered.length && !lastResort && el.kind !== 'pin') problems.push(`the ${kindName} covers ${coverPx}px of page text (e.g. ${covered.length} line fragment(s) near ${Math.round(covered[0].left)},${Math.round(covered[0].top)})`);
  else if (covered.length && lastResort) info.push(`last-resort label covers ${coverPx} px of other text`);
  return { problems, info, el, ui, passage, coverPx, kindName };
}

/**
 * The covering part of judgeNoteOnPage(), for checks (f) and (g): a shown margin note or label (place
 * a, b or c) must not sit on its own passage or on any page text. Judged at rest: the pointer is moved to
 * the window's top-left corner first, because a label under the pointer shows its hover-expanded form,
 * which the design allows to cover text. Returns problem sentences (empty when fine or not shown).
 */
async function noteCoverProblems(page, note) {
  await page.mouse.move(1, 1);
  await sleep(250);
  const judged = await judgeNoteOnPage(page, note);
  if (!judged.el || !judged.el.shown || !judged.el.inWindow) return [];
  return judged.problems.filter((p) => /overlaps its own passage|covers \d+px of page text/.test(p));
}

/**
 * Where should the note's element be? Returns a problem sentence or null.
 *  - margin note: top aligned with the passage's first line (3px), or below a note above it with a gap;
 *  - label: where its data-place says (a after the passage on its line, b after the last line of its
 *    paragraph so below the passage, c right of the passage at its first line, d beside it, off the passage);
 *  - plain pin: in the gap above the end of the last line (as before).
 */
function notePlacementProblem(el, rects, ui) {
  if (!el || !el.shown || !rects || !rects.length) return null; // hidden notes are legitimate (text covered, scrolled out)
  const first = rects[0];
  const last = rects[rects.length - 1];
  if (el.kind === 'margin') {
    const dy = Math.abs(el.rect.top - first.top);
    if (dy <= 3) return null;
    const above = (ui.margins || []).filter((m) => m.id !== el.id && m.shown && m.rect.top < el.rect.top && overlapOf(m.rect, { left: el.rect.left, right: el.rect.right, top: -1e6, bottom: 1e6 }).w > 1);
    const blocker = above.find((m) => m.rect.bottom <= el.rect.top + 1 && el.rect.top - m.rect.bottom <= 24 && el.rect.top - m.rect.bottom >= 4);
    return blocker ? null : `the margin note is ${Math.round(dy)}px away from the top of its passage's first line and no note above it explains that`;
  }
  if (el.kind === 'label') {
    const v = (a, b) => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (el.place === 'a') {
      if (el.rect.left < last.right - 3) return `label place a should sit after the passage on its last line, but it starts ${Math.round(last.right - el.rect.left)}px before the passage ends`;
      if (v(el.rect, last) < 4) return 'label place a is not on the same line as the end of the passage';
    } else if (el.place === 'b') {
      // After the last line of the paragraph: level with that line (which is the passage's own last line when the
      // passage ends the paragraph) or lower, and to the right of the passage when on the same line.
      const mid = el.rect.top + el.rect.height / 2;
      if (mid < last.top + last.height / 2 - 3) return `label place b should be level with or below the last line of the paragraph, but its middle is ${Math.round(last.top + last.height / 2 - mid)}px above the last line of the passage`;
      if (v(el.rect, last) >= 4 && el.rect.left < last.right - 3) return 'label place b is on the passage\'s last line but starts before the passage ends';
    } else if (el.place === 'c') {
      if (el.rect.left < first.right - 3) return 'label place c should be right of the paragraph\'s text at the first line, but it starts inside the passage\'s first line';
      if (v(el.rect, first) < 4) return 'label place c is not level with the passage\'s first line';
    } else if (el.place !== 'd') return `the label's place is ${JSON.stringify(el.place)}`;
    return null;
  }
  const dx = Math.abs(el.rect.left - Math.max(2, Math.min(last.right - 4, ui.viewport.width - 22)));
  const dy = Math.abs(el.rect.top - Math.max(2, last.top - 14));
  return dx > 3 || dy > 3 ? `the note pin is ${Math.round(Math.max(dx, dy))}px away from the end of its words` : null;
}

/** Compare two captureUi() results. Returns a list of human-readable differences. */
function diffUi(reference, actual) {
  const diffs = [];
  if (!reference || !actual) return diffs;
  for (const [part, ref] of Object.entries(reference)) {
    const act = actual[part];
    if (!act) { diffs.push(`${part}: missing`); continue; }
    for (const [prop, want] of Object.entries(ref)) {
      const got = act[prop];
      const nw = parseFloat(want);
      const ng = parseFloat(got);
      const numeric = typeof want === 'number' || /^-?[\d.]+px$/.test(String(want));
      if (numeric && Number.isFinite(nw) && Number.isFinite(ng)) {
        if (Math.abs(nw - ng) > 1) diffs.push(`${part}: ${prop} is ${round1(ng)}px, expected ${round1(nw)}px`);
      } else if (String(want) !== String(got)) {
        diffs.push(`${part}: ${prop} is "${got}", expected "${want}"`);
      }
    }
    if (act.rectWidth < 1 || act.rectHeight < 1) diffs.push(`${part}: has no size on screen`);
    if (act.visibility === 'hidden' || act.display === 'none' || parseFloat(act.opacity) === 0) diffs.push(`${part}: is invisible`);
  }
  return diffs;
}

/**
 * Take a "did the host page change?" measurement and store it under a stage name.
 * Scroll is reset first so every stage is measured in the same state.
 */
async function probe(ctx, stage) {
  const { page, state } = ctx;
  if (!state.sampling) return;
  try {
    await page.mouse.move(page.viewportSize().width - 2, 2); // same pointer position every time (hover styles)
    await page.evaluate(() => window.__mh.resetScroll());
    await sleep(350);
    state.probes[stage] = await page.evaluate((props) => ({
      layout: window.__mh.layoutSnapshot(),
      styles: window.__mh.styleSnapshot(props),
    }), HOST_PROPS);
  } catch (e) {
    state.probeErrors.push(`${stage}: ${e.message.split('\n')[0]}`);
  }
}

/** Differences between two layout snapshots, ignoring anything listed in `unstable`. */
function diffLayout(base, later, unstable) {
  const moved = [];
  const replaced = [];
  const scrolled = base.scroll.x !== later.scroll.x || base.scroll.y !== later.scroll.y;
  for (const [label, a] of Object.entries(base.items)) {
    if (unstable.has(label)) continue;
    const b = later.items[label];
    if (!a) continue;
    // The extension never deletes host content, so a watched item that has gone was replaced by the page itself.
    if (!b) { replaced.push(label); continue; }
    const changes = [];
    // Things stuck to the window legitimately sit elsewhere on the page when the window is scrolled differently.
    const comparePosition = !(scrolled && (a.anchored || b.anchored));
    for (const k of comparePosition ? ['left', 'top', 'width', 'height'] : ['width', 'height']) {
      const d = b[k] - a[k];
      if (Math.abs(d) > LIMITS.layoutPx) changes.push(`${k} ${d > 0 ? '+' : ''}${round1(d)}px`);
    }
    if (changes.length) moved.push(`${label}: ${changes.join(', ')}`);
  }
  const doc = [];
  for (const k of ['scrollWidth', 'scrollHeight', 'clientWidth', 'clientHeight']) {
    if (base.doc[k] !== later.doc[k]) doc.push(`document ${k} ${base.doc[k]} → ${later.doc[k]}`);
  }
  return { moved, doc, replaced };
}

/** Differences between two style snapshots. */
function diffStyles(base, later, unstable) {
  const changed = [];
  for (const [label, a] of Object.entries(base)) {
    if (unstable.has(label) || !a) continue;
    const b = later[label];
    if (!b) continue; // removal is reported by the layout check
    for (const [prop, v] of Object.entries(a)) {
      if (b[prop] !== v) changed.push(`${label}: ${prop} "${v}" → "${b[prop]}"`);
    }
  }
  return changed;
}

/**
 * Do these characters share screen space with text the harness has already marked?
 * (Happens when one target contains another, e.g. a container and a paragraph inside it.)
 * Returns the earlier mark's label, or null.
 */
async function overlapsEarlierMark(ctx, selector, slice) {
  const earlier = activeMarks(ctx.state);
  if (!earlier.length) return null;
  const idx = await ctx.page.evaluate(([sel, s, e, list]) => {
    const q = (x) => { try { return document.querySelector(x); } catch (err) { return null; } };
    const el = q(sel);
    if (!el) return -1;
    const mine = window.__mh.textRects(el, s, e);
    for (let i = 0; i < list.length; i++) {
      const other = q(list[i].selector);
      if (!other) continue;
      const theirs = window.__mh.textRects(other, list[i].startOffset, list[i].endOffset);
      for (const a of mine) for (const b of theirs) {
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const hh = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        // Real overlap means sharing the same characters: most of a line's height and some width.
        if (w > 1 && hh > Math.min(a.height, b.height) * 0.6) return i;
      }
    }
    return -1;
  }, [selector, slice.startOffset, slice.endOffset, earlier.map((m) => ({ selector: m.selector, startOffset: m.startOffset, endOffset: m.endOffset }))]);
  return idx >= 0 ? labelOf(earlier[idx]) : null;
}

/** The ids of the markups saved for the page currently shown. */
async function storedMarkups(ctx) {
  return h.STORAGE.markupsFor(await h.getStored(ctx.session), ctx.page.url());
}

/** Wait for a markup id to appear in storage that was not there before. Returns the saved record, or null. */
async function waitForNewStored(ctx, idsBefore, timeout = 2000) {
  const end = Date.now() + timeout;
  for (;;) {
    const fresh = (await storedMarkups(ctx)).filter((m) => !idsBefore.has(m.id));
    if (fresh.length) return fresh[fresh.length - 1];
    if (Date.now() > end) return null;
    await sleep(120);
  }
}

/** Text of the toast currently shown, or ''. */
async function toastText(page) {
  const ui = await h.getUi(page);
  return ui.toast ? ui.toast.text : '';
}

/**
 * Select a phrase in a target and apply a highlight or underline to it.
 * Records the mark in ctx.state.marks and returns a per-target outcome.
 */
async function markTarget(ctx, target, type) {
  const { page, state } = ctx;
  const name = target.name;
  const slice = target.slices[type];
  if (!target.exists) return { name, status: 'skip', reason: `no element matches ${target.selector}` };
  if (!slice) return { name, status: 'skip', reason: target.why || 'no selectable text' };
  const clash = await overlapsEarlierMark(ctx, target.selector, slice);
  if (clash) return { name, status: 'skip', reason: `these words were already marked earlier in this run (${clash}); this target contains that one` };

  // Photograph the words before anything is painted, to prove afterwards that the screen really changed.
  const loc = page.locator(target.selector).first();
  await loc.evaluate((el, [s, e]) => window.__mh.revealText(el, s, e), [slice.startOffset, slice.endOffset]).catch(() => {});
  await sleep(200);
  await page.evaluate(() => window.getSelection().removeAllRanges());
  const rects0 = await h.getTextRects(page, target.selector, slice.startOffset, slice.endOffset);
  // Up to three pieces of the text are photographed: the widest line (an ordinary run of words),
  // the first piece and the last piece (a drop capital or a wrapped tail can behave differently).
  const pieceIndexes = (rects) => {
    if (!rects || !rects.length) return [];
    let widest = 0;
    rects.forEach((r, i) => { if (r.width > rects[widest].width) widest = i; });
    return [...new Set([widest, 0, rects.length - 1])];
  };
  const pieces0 = pieceIndexes(rects0);
  const beforePics = [];
  const below = type === 'underline' ? 5 : 0; // an underline sits just under the letters; a highlight is the letters' own box
  for (const i of pieces0) beforePics.push(await grab(page, rects0[i], below));
  const beforePic = beforePics.length ? beforePics[0] : null;
  const info = rects0 && rects0.length
    ? await loc.evaluate((el, [s, e]) => window.__mh.colourInfo(el, s, e), [slice.startOffset, slice.endOffset]).catch(() => null) : null;

  const sel = await h.selectText(page, target.selector, { startOffset: slice.startOffset, endOffset: slice.endOffset });
  if (sel.method === 'none') return { name, status: 'skip', reason: sel.why };
  if (!sel.ok) return { name, status: 'skip', reason: `could not select the text: ${sel.why}` };
  const how = sel.method === 'drag' ? 'real mouse drag' : `selection set in code (${sel.why})`;

  const toolbar = await h.waitForToolbar(page);
  if (!toolbar) {
    if (target.designExcluded) return { name, status: 'gap', reason: `no toolbar is offered here: ${target.designExcluded}`, method: sel.method };
    return { name, status: 'fail', reason: `no toolbar appeared after selecting "${short(sel.text)}" [${how}]`, method: sel.method };
  }
  const idsBefore = new Set((await storedMarkups(ctx)).map((m) => m.id));
  const click = await h.clickToolbar(page, type);
  if (!click.ok) {
    await dismissToolbar(page);
    return { name, status: 'fail', reason: `${click.why} [${how}]`, method: sel.method };
  }
  const saved = await waitForNewStored(ctx, idsBefore);
  if (!saved) {
    const toast = await toastText(page);
    if (target.designExcluded) return { name, status: 'gap', reason: `a toolbar appeared but the markup was not made${toast ? ` (the extension said: "${toast}")` : ''}: ${target.designExcluded}`, method: sel.method };
    return { name, status: 'fail', reason: `clicked "${type}" but nothing was saved${toast ? ` (the extension said: "${toast}")` : ''} [${how}]`, method: sel.method };
  }
  await sleep(150); // let the paint land

  const mark = {
    type, target: name, selector: target.selector, startOffset: slice.startOffset, endOffset: slice.endOffset,
    text: sel.text, id: saved.id, colour: saved.colour, note: '', method: sel.method, methodWhy: sel.why, removed: false,
  };
  state.marks.push(mark);
  const [res] = await measureUntilAligned(page, [mark], 600);
  mark.name = res.entry ? res.entry.name : null;

  // Did pixels actually change where the words are?
  let painted = null;
  const rects1 = await h.getTextRects(page, target.selector, slice.startOffset, slice.endOffset);
  const sameLayout = rects1 && rects0 && rects1.length === rects0.length;
  const unpainted = []; // pieces of the text where the screen did not change
  let afterPic = null;
  if (sameLayout) {
    for (let k = 0; k < pieces0.length; k++) {
      const r = rects1[pieces0[k]];
      const pic = await grab(page, r, below);
      const before = beforePics[k];
      if (!pic || !before) continue;
      const total = Math.min(before.width, pic.width) * Math.min(before.height, pic.height);
      const share = total ? pdf.differingPixels(before, pic, 24) / total : null;
      if (k === 0) { afterPic = pic; painted = share; }
      if (share !== null && share < LIMITS.paintedMin) unpainted.push(`the piece ${Math.round(r.width)}×${Math.round(r.height)}px at ${Math.round(r.left)},${Math.round(r.top)}${pieces0[k] === 0 ? ' (the start of the text)' : ''}`);
    }
  }
  if (type === 'highlight' && beforePic && afterPic) {
    state.legibility.push({
      target: name, text: sel.text, info, before: colour.summarisePixels(beforePic), after: colour.summarisePixels(afterPic),
      entry: res.entry ? { name: res.entry.name, colour: res.entry.colour, variant: res.entry.variant } : null, aligned: res.cmp.ok, painted,
    });
  }

  const problems = [];
  if (!res.cmp.ok) problems.push(res.cmp.summary);
  else if (unpainted.length) problems.push(`the ${type} is registered on the right words (${res.entry.name}) but the screen did not change on ${unpainted.length} of ${pieces0.length} pieces of the text that were photographed: ${unpainted.join('; ')}`);
  if (h.normaliseText(h.STORAGE.quoteOf(saved)) !== h.normaliseText(sel.text)) problems.push(`saved words are "${short(h.STORAGE.quoteOf(saved))}", not the selected words`);
  const wantKind = type === 'underline' ? 'underline' : 'highlight';
  if (saved.kind !== wantKind) problems.push(`saved as "${saved.kind}"`);
  const okText = `"${short(sel.text)}": ${res.cmp.summary}${painted !== null ? `, ${Math.round(painted * 100)}% of pixels changed` : ''}`;
  return {
    name, status: problems.length ? 'fail' : 'pass', method: sel.method,
    reason: `${problems.length ? `"${short(sel.text)}": ${problems.join('; ')}` : okText} [${how}]`,
  };
}

/** Wait for the site's first target to exist and the page to go quiet. */
async function waitForSite(ctx) {
  const first = ctx.site.targets && ctx.site.targets[0];
  if (first) await ctx.page.waitForSelector(first.selector, { state: 'attached', timeout: 5000 }).catch(() => {});
  await sleep(500);
}

/** Load an address from scratch (a real page load, even if only the #fragment differs) and wait for the extension. */
async function freshLoad(ctx, url) {
  await ctx.page.goto('about:blank');
  await ctx.page.goto(url, { waitUntil: 'load', timeout: 20000 });
  return h.isInjected(ctx.page, 5000);
}

const pdfOptions = (extra = {}) => ({ format: 'A4', ...extra });

/** Save a PDF of the current page under tests/output/print/. Returns the file path, or null if PDF output is unavailable. */
async function savePdf(ctx, name, extra) {
  const file = path.join(h.PRINT_DIR, `${name}.pdf`);
  fs.mkdirSync(h.PRINT_DIR, { recursive: true });
  try {
    await ctx.page.pdf({ path: file, ...pdfOptions(extra) });
    return file;
  } catch (e) {
    ctx.state.pdfError = e.message.split('\n')[0];
    return null;
  }
}

/**
 * Find a painted markup a person could click on: its words are on screen, not
 * covered, and not inside a link or button (those keep their own click).
 * Returns { mark, point } or null.
 */
async function pickClickable(ctx, prefer) {
  const marks = activeMarks(ctx.state);
  const ordered = [...marks.filter(prefer || (() => false)), ...marks.filter((m) => !(prefer && prefer(m)))];
  for (const mark of ordered) {
    await reveal(ctx, mark);
    const [res] = await measure(ctx.page, [mark]);
    if (!res.cmp.ok || res.changedByPage) continue;
    const point = await ctx.page.evaluate((m) => {
      const el = document.querySelector(m.selector);
      if (!el) return null;
      const rects = window.__mh.textRects(el, m.startOffset, m.endOffset);
      for (const r of rects) {
        const x = r.left + Math.min(r.width / 2, 12);
        const y = r.top + r.height / 2;
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
        const top = window.__mh.deepElementFromPoint(x, y);
        if (!top || !(window.__mh.composedContains(el, top) || window.__mh.composedContains(top, el))) continue;
        // Links and controls keep their normal click, so the extension does not open a card there.
        if (top.closest && top.closest('a[href], button, input, select, textarea, label, summary, [role="button"]')) continue;
        return { x, y };
      }
      return null;
    }, { selector: mark.selector, startOffset: mark.startOffset, endOffset: mark.endOffset });
    if (point) return { mark, point };
  }
  return null;
}

/** Click on a markup's words and wait for its card. Returns the card description or null. */
async function openCardByClick(ctx, point) {
  await ctx.page.mouse.click(point.x, point.y);
  for (let i = 0; i < 10; i++) {
    await sleep(100);
    const ui = await h.getUi(ctx.page);
    if (ui.card) return ui.card;
  }
  return null;
}

/** Is a given saved id currently in storage for this page? */
async function isStored(ctx, id) {
  return (await storedMarkups(ctx)).some((m) => m.id === id);
}

// ===========================================================================
// The checks
// ===========================================================================

const needsInjected = (state) => (state.injected ? null : 'the extension is not running on this page, so nothing else can work');
const needsMarks = (state) => needsInjected(state) || (activeMarks(state).length ? null : 'no highlight or underline was created on this site, so there is nothing to test');
const isFixture = (site) => !!site.fixture;

const CHECKS = [
  // -------------------------------------------------------------------------
  {
    id: 'a',
    key: 'injected',
    title: 'Extension running on the page',
    plain: 'The extension has started on the page and loaded its saved markups.',
    async run(ctx) {
      const { page, site, state } = ctx;
      state.injected = await h.isInjected(page, 5000);
      if (!state.injected) {
        const st = await h.injectionState(page);
        return { status: 'fail', reason: `The extension did not start: its <${S.host}> element ${st.hostExists ? 'exists' : 'is missing'}, ready marker is ${JSON.stringify(st.ready)}, shadow root ${st.shadowOpen ? 'open' : 'not open (test mode not picked up)'}.`, details: st };
      }
      await waitForSite(ctx);

      // Work out, for each target, which phrases will be highlighted / underlined / given a note.
      state.targets = await page.evaluate(([targets, slots]) => targets.map((t) => {
        let el = null;
        let bad = null;
        try { el = document.querySelector(t.selector); } catch (e) { bad = 'invalid selector'; }
        if (!el) return { name: t.name, selector: t.selector, exists: false, why: bad || 'element not found', slices: {} };
        const text = window.__mh.fullText(el);
        const slices = {
          highlight: window.__mh.pickSlice(el, 0, slots),
          underline: window.__mh.pickSlice(el, 1, slots),
          note: window.__mh.pickSlice(el, 2, slots),
        };
        const why = text.trim() ? null : `<${window.__mh.label(el)}> contains no text nodes (form control, embed or empty)`;
        return { name: t.name, selector: t.selector, exists: true, why, slices, textLength: text.length, designExcluded: window.__mh.designExclusion(el) };
      }), [site.targets || [], LIMITS.slots]);

      // Baseline for the "does marking up change the host page?" checks: two snapshots a moment apart,
      // so anything that moves on its own (tickers, animations) can be left out of the comparison.
      state.sampling = await page.evaluate(([owned, sels]) => window.__mh.sampleInit(owned, sels), [h.OWNED_SELECTORS, (site.targets || []).map((t) => t.selector)]);
      await probe(ctx, 'baseline');
      await sleep(700);
      await probe(ctx, 'baseline2');

      // PDFs of the untouched page, to compare the marked-up PDFs against later.
      state.controlPdf = await savePdf(ctx, `${site.slug}-before-markup`);
      state.controlPdfBg = state.controlPdf ? await savePdf(ctx, `${site.slug}-before-markup-with-backgrounds`, { printBackground: true }) : null;

      const missing = state.targets.filter((t) => !t.exists).map((t) => t.name);
      await page.evaluate(() => window.scrollTo(0, 0));
      return {
        status: 'pass',
        screenshot: await ctx.shot('a-injected', { sheetState: 'before' }),
        reason: `Extension element <${S.host}> present and ready. ${state.targets.filter((t) => t.exists).length} of ${state.targets.length} targets exist on the page.`
          + (missing.length ? ` Missing: ${missing.join(', ')}.` : ''),
        details: { sampling: state.sampling },
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'b',
    key: 'toolbar',
    title: 'Toolbar appears in view',
    plain: 'Selecting text shows the toolbar, fully on screen and not hidden behind the page.',
    needs: needsInjected,
    async run(ctx) {
      const { page, state } = ctx;
      const items = [];
      for (const t of state.targets) {
        const slice = t.slices.highlight;
        if (!t.exists) { items.push({ name: t.name, status: 'skip', reason: t.why }); continue; }
        if (!slice) { items.push({ name: t.name, status: 'skip', reason: t.why || 'no selectable text' }); continue; }
        const sel = await h.selectText(page, t.selector, { startOffset: slice.startOffset, endOffset: slice.endOffset });
        if (!sel.ok) { items.push({ name: t.name, status: 'skip', reason: `could not select the text: ${sel.why}`, method: sel.method }); continue; }
        const how = sel.method === 'drag' ? 'real mouse drag' : `selection set in code (${sel.why})`;
        const tb = await h.waitForToolbar(page);
        if (!tb) {
          if (t.designExcluded) items.push({ name: t.name, status: 'gap', reason: `no toolbar is offered here: ${t.designExcluded}`, method: sel.method });
          else items.push({ name: t.name, status: 'fail', reason: `no toolbar appeared [${how}]`, method: sel.method });
          continue;
        }
        const problems = [];
        const r = tb.rect;
        if (!tb.visible) {
          problems.push('the toolbar is created but invisible (hidden by CSS, transparent or zero-sized)');
        } else if (r.left < 0 || r.top < 0 || r.right > tb.viewport.width || r.bottom > tb.viewport.height) {
          problems.push(`toolbar is partly off screen (left ${Math.round(r.left)}, top ${Math.round(r.top)}, right ${Math.round(r.right)}, bottom ${Math.round(r.bottom)} in a ${tb.viewport.width}×${tb.viewport.height} window)`);
        } else if (!tb.onTop) {
          problems.push(`toolbar is covered by <${tb.topElement}>`);
        }
        const absent = ['highlight', 'underline', 'note'].filter((k) => !tb.buttons[k]);
        if (absent.length) problems.push(`missing button(s): ${absent.join(', ')}`);
        // Keep the first toolbar's CSS for the CSS-conflict check, and a picture of it.
        if (!state.ui.toolbar) {
          state.ui.toolbar = await captureUi(page, TOOLBAR_PARTS);
          state.ui.theme = (await h.getUi(page)).theme;
          state.toolbarShot = await ctx.shot('b-toolbar');
        }
        await dismissToolbar(page);
        items.push({
          name: t.name, status: problems.length ? 'fail' : 'pass', method: sel.method,
          reason: (problems.join('; ') || 'toolbar shown in view') + (t.designExcluded ? ` (note: ${t.designExcluded}, where no toolbar is expected by design)` : '') + ` [${how}]`,
        });
      }
      const out = summarise(items, 'targets');
      if (state.toolbarShot) out.screenshot = state.toolbarShot;
      return out;
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'c',
    key: 'highlight',
    title: 'Highlight lines up with the text',
    plain: 'Clicking a highlight colour paints exactly the selected words (within 2 pixels) and saves them.',
    needs: needsInjected,
    async run(ctx) {
      const items = [];
      for (const t of ctx.state.targets) items.push(await markTarget(ctx, t, 'highlight'));
      await reveal(ctx, activeMarks(ctx.state, 'highlight')[0]);
      const shot = await ctx.shot('c-highlight', { sheetState: 'highlighted' });
      await probe(ctx, 'highlight');
      return { ...summarise(items, 'highlights'), screenshot: shot };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'd',
    key: 'underline',
    title: 'Underline lines up with the text',
    plain: 'Clicking Underline draws a line under exactly the selected words (within 2 pixels) and saves them.',
    needs: needsInjected,
    async run(ctx) {
      const items = [];
      for (const t of ctx.state.targets) items.push(await markTarget(ctx, t, 'underline'));
      await reveal(ctx, activeMarks(ctx.state, 'underline')[0] || activeMarks(ctx.state)[0]);
      const shot = await ctx.shot('d-underline', { sheetState: 'underlined' });
      await probe(ctx, 'underline');
      return { ...summarise(items, 'underlines'), screenshot: shot };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'e',
    key: 'note',
    title: 'Note: typing keeps focus and saves',
    plain: 'Add note opens a note card; typing 30 characters never loses the cursor and the text is saved.',
    needs: needsInjected,
    async run(ctx) {
      const { page, state } = ctx;
      let target = null;
      for (const t of state.targets) {
        if (!t.exists || !t.slices.note || t.designExcluded) continue;
        if (await overlapsEarlierMark(ctx, t.selector, t.slices.note)) continue;
        target = t;
        break;
      }
      if (!target) return { status: 'skip', reason: 'No target on this site has unmarked text that can be selected for a note.' };
      const slice = target.slices.note;
      const sel = await h.selectText(page, target.selector, { startOffset: slice.startOffset, endOffset: slice.endOffset });
      if (!sel.ok) return { status: 'skip', reason: `[${target.name}] could not select the text: ${sel.why}` };
      const how = sel.method === 'drag' ? 'real mouse drag' : `selection set in code (${sel.why})`;
      const tb = await h.waitForToolbar(page);
      if (!tb) return { status: 'fail', reason: `[${target.name}] no toolbar appeared [${how}]` };
      const idsBefore = new Set((await storedMarkups(ctx)).map((m) => m.id));
      const click = await h.clickToolbar(page, 'note');
      if (!click.ok) return { status: 'fail', reason: `[${target.name}] ${click.why}` };
      let card = null;
      for (let i = 0; i < 12 && !card; i++) {
        await sleep(100);
        card = (await h.getUi(page)).card;
      }
      if (!card || !card.hasTextarea) return { status: 'fail', reason: `[${target.name}] clicked "note" but no note card with a text box appeared${await toastText(page) ? ` (the extension said: "${await toastText(page)}")` : ''}` };

      // Tag the exact text box we start typing in, so we notice if the extension swaps it for a new one.
      const startedFocused = await page.evaluate((Sel) => {
        const host = document.querySelector(Sel.host);
        const ta = host.shadowRoot.querySelector(`${Sel.card} ${Sel.cardTextarea}`);
        if (ta) ta.__mhTyping = true;
        return !!ta && host.shadowRoot.activeElement === ta;
      }, S);
      const typed = LIMITS.noteTyping;
      // After every keystroke: is the cursor still in the very same text box? (Focus inside the
      // extension's sealed UI can only be read through its shadow root.)
      const lost = [];
      if (!startedFocused) lost.push({ at: 0, why: 'the note text box did not have the cursor when the card appeared' });
      let previous = 'original';
      for (let i = 0; i < typed.length; i++) {
        await page.keyboard.type(typed[i]);
        await sleep(45);
        const st = await page.evaluate((Sel) => {
          const host = document.querySelector(Sel.host);
          const a = host && host.shadowRoot ? host.shadowRoot.activeElement : null;
          if (a && a.__mhTyping) return { where: 'original' };
          if (a && a.closest && a.closest(Sel.card)) return { where: 'replaced' };
          return { where: 'elsewhere', active: document.activeElement ? window.__mh.label(document.activeElement) : 'nothing' };
        }, S);
        if (st.where !== 'original' && st.where !== previous) {
          lost.push({
            at: i + 1,
            why: st.where === 'replaced'
              ? 'the extension replaced the text box being typed in with a new one'
              : `the cursor moved to <${st.active}>`,
          });
        }
        previous = st.where;
      }
      // The card says "Saving…" and then "Saved" about 400 ms after the last keystroke.
      let ui = await h.getUi(page);
      const end = Date.now() + LIMITS.noteSaveMs;
      while (ui.card && ui.card.status !== 'Saved' && Date.now() < end) {
        await sleep(100);
        ui = await h.getUi(page);
      }
      const saved = await waitForNewStored(ctx, idsBefore, 500);
      const mark = saved ? {
        type: 'highlight', target: target.name, selector: target.selector, startOffset: slice.startOffset, endOffset: slice.endOffset,
        text: sel.text, id: saved.id, colour: saved.colour, note: typed, method: sel.method, methodWhy: sel.why, removed: false,
      } : null;
      if (mark) {
        state.marks.push(mark);
        state.note = mark;
      }
      const [res] = mark ? await measureUntilAligned(page, [mark], 600) : [null];
      state.ui.card = await captureUi(page, CARD_PARTS);
      state.ui.theme = state.ui.theme || ui.theme;
      // Facts about the open card, used by the "note visible" check.
      const cardRect = ui.card ? ui.card.rect : null;
      const textRects = await h.getTextRects(page, target.selector, slice.startOffset, slice.endOffset);
      state.cardFacts = ui.card ? {
        shown: ui.card.shown, inWindow: ui.card.inWindow, onTop: ui.card.onTop, top: ui.card.top, rect: cardRect, viewport: ui.viewport,
        coversText: !!cardRect && (textRects || []).some((t) => !(t.right <= cardRect.left || t.left >= cardRect.right || t.bottom <= cardRect.top || t.top >= cardRect.bottom)),
      } : null;
      const shot = await ctx.shot('e-note', { sheetState: 'note' });

      const problems = [];
      if (lost.length) problems.push(`the cursor did not stay put: after ${lost[0].at} character(s) ${lost[0].why}`);
      if (!ui.card) problems.push('the note card disappeared while typing');
      else {
        if (ui.card.text !== typed) problems.push(`the card shows "${ui.card.text}" instead of the 30 typed characters`);
        if (ui.card.status !== 'Saved') problems.push(`the card never said "Saved" (it says "${ui.card.status}")`);
      }
      if (!saved) problems.push('no markup was saved for the note');
      else {
        const now = (await storedMarkups(ctx)).find((m) => m.id === saved.id);
        if (!now || now.note !== typed) problems.push(`saved note is "${now ? now.note : '(gone)'}" instead of the 30 typed characters`);
      }
      if (res && !res.cmp.ok) problems.push(`the note's highlight: ${res.cmp.summary}`);

      // Close the card with its close button; a pin should take its place.
      const closed = await h.clickUi(page, `${S.card} ${S.cardClose}`);
      await sleep(300);
      if (!closed.ok) problems.push(`the card's close button could not be used: ${closed.why}`);
      state.ui.pin = await captureUi(page, PIN_PARTS);
      await probe(ctx, 'note');
      return {
        status: problems.length ? 'fail' : 'pass',
        reason: `[${target.name}] ` + (problems.join('; ') || 'note card opened with the cursor in it, all 30 characters stayed in the same text box, card said "Saved", note stored with a highlight on the right words') + ` [${how}]`,
        screenshot: shot,
        details: { lost, cardStatus: ui.card ? ui.card.status : null },
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'k',
    key: 'layout',
    title: 'Host page layout unchanged',
    plain: 'Marking up does not move or resize anything on the page (0.5 pixel limit) or change the page size.',
    needs: needsInjected,
    async run(ctx) {
      const { state } = ctx;
      const base = state.probes.baseline;
      const base2 = state.probes.baseline2;
      if (!base || !base2) return { status: 'skip', reason: `No baseline measurement was taken. ${state.probeErrors.join('; ')}` };
      // Anything that moved between the two baselines moves by itself: leave it out.
      const self = diffLayout(base.layout, base2.layout, new Set());
      const unstable = new Set(self.moved.map((m) => m.split(':')[0]));
      const docUnstable = self.doc.length > 0;
      const stages = ['highlight', 'underline', 'note'].filter((s) => state.probes[s]);
      if (!stages.length) return { status: 'skip', reason: 'No markup was created, so there is nothing to compare.' };
      const findings = [];
      const details = { watched: Object.keys(base.layout.items).length, ignoredBecauseTheyMoveByThemselves: [...unstable], stages: {} };
      const replacedByPage = new Set();
      for (const stage of stages) {
        const d = diffLayout(base.layout, state.probes[stage].layout, unstable);
        d.replaced.forEach((l) => replacedByPage.add(l));
        details.stages[stage] = d;
        const bits = [];
        if (d.doc.length && !docUnstable) bits.push(d.doc.join(', '));
        if (d.moved.length) bits.push(`${d.moved.length} element(s) moved or resized, e.g. ${d.moved.slice(0, 4).join(' ; ')}`);
        if (bits.length) findings.push(`after ${stage}: ${bits.join('; ')}`);
      }
      const note = `${details.watched} elements and text runs watched`
        + (unstable.size ? `, ${unstable.size} ignored because they move by themselves` : '')
        + (replacedByPage.size ? `, ${replacedByPage.size} ignored because the page itself replaced them during the test` : '')
        + (docUnstable ? ', page size ignored because it changes by itself' : '') + '.';
      if (findings.length) return { status: 'fail', reason: `${findings.join(' || ')} (${note})`, details };
      return { status: 'pass', reason: `Nothing on the host page moved after ${stages.join(', ')} (${note})`, details };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'l',
    key: 'legibility',
    title: 'Highlighted text readable, highlight visible',
    plain: 'Text under a highlight still has enough contrast to read (4.5:1), and the highlight can be told apart from the page.',
    needs: needsInjected,
    async run(ctx) {
      const { state } = ctx;
      if (!state.legibility.length) return { status: 'skip', reason: 'No highlight was created on this site.' };
      const P = h.palette;
      const hex = (x) => colour.parseColour(x);
      const items = [];
      for (const L of state.legibility) {
        const d = { target: L.target, registryName: L.entry ? L.entry.name : null };
        if (!L.aligned || !L.entry) {
          items.push({ name: L.target, status: 'skip', reason: 'the highlight is not painted on its words (see check c), so its effect on the text cannot be judged' });
          continue;
        }
        // (1) Expected, from the extension's own colour table (lib/palette.js) and the variant it chose.
        const v = L.entry.variant; // l, lf, lc, d, df
        const dark = v.startsWith('d');
        const forced = v.endsWith('f') || v === 'lc';
        const row = P.COLOURS[L.entry.colour];
        if (row) {
          const fill = hex(row[dark ? 'dark' : 'light']);
          let text = forced ? hex(dark ? P.MARK_TEXT_LIGHT || '#FFFFFF' : P.MARK_TEXT_DARK || '#1B1B1F') : (L.info ? colour.parseColour(L.info.color) : null);
          if (text && text.a < 1) text = colour.layer(fill, text);
          d.expected = {
            fill: colour.show(fill), textColour: text ? colour.show(text) : 'unknown', textForcedByExtension: forced,
            contrast: text ? round1(colour.contrast(text, fill)) : null,
          };
        }
        // (2) Measured from pixels in a screenshot of the highlighted words.
        d.measured = {
          background: colour.show(L.before.background), backgroundHighlighted: colour.show(L.after.background),
          contrastBefore: round1(L.before.contrast), contrastAfter: round1(L.after.contrast),
          highlightDeltaE: round1(colour.deltaE(L.after.background, L.before.background)),
          highlightVsPageContrast: Math.round(colour.contrast(L.after.background, L.before.background) * 100) / 100,
          pixelsChanged: L.painted === null ? null : Math.round(L.painted * 100),
        };
        const m = d.measured;
        const exp = d.expected && d.expected.contrast;
        const problems = [];
        const notes = [];
        if (m.contrastAfter < LIMITS.contrastMin) {
          // Thin or tiny lettering never reaches its full colour in a screenshot, so pixels under-read
          // contrast. If the colours say it is fine and the highlight has not made it worse, accept it.
          const artefact = exp !== null && exp !== undefined && exp >= LIMITS.contrastMin && m.contrastAfter >= m.contrastBefore * 0.9;
          if (artefact) notes.push(`pixels read ${m.contrastAfter}:1 because the lettering is thin (it read ${m.contrastBefore}:1 before highlighting); by colour it is ${exp}:1`);
          else if (m.contrastBefore < LIMITS.contrastMin && m.contrastAfter >= m.contrastBefore * 0.95) problems.push(`text contrast is ${m.contrastAfter}:1 under the highlight (the page's own text was already only ${m.contrastBefore}:1; the highlight did not fix it)`);
          else problems.push(`text contrast drops from ${m.contrastBefore}:1 to ${m.contrastAfter}:1 under the highlight${exp ? ` (by colour it should be ${exp}:1)` : ''}`);
        }
        if (m.highlightDeltaE < LIMITS.deltaEMin) {
          // The "lc" variant is the extension's answer to a fill that matches the page: it adds an underline.
          if (v === 'lc' && L.painted !== null && L.painted >= LIMITS.paintedMin) notes.push(`fill is close to the page colour (difference ${m.highlightDeltaE}) but the extension added an underline (${m.pixelsChanged}% of pixels changed)`);
          else problems.push(`highlight is barely visible against the page: ${m.background} → ${m.backgroundHighlighted} (colour difference ${m.highlightDeltaE}, needs ${LIMITS.deltaEMin})`);
        }
        const ok = `text ${m.contrastAfter}:1 (was ${m.contrastBefore}:1), highlight colour difference ${m.highlightDeltaE}, painted as ${L.entry.name}`;
        items.push({
          name: L.target, status: problems.length ? 'fail' : 'pass',
          reason: `${problems.join('; ') || ok}${notes.length ? ` (${notes.join('; ')})` : ''} [measured from screenshot pixels${exp ? `; expected from the colour table ${exp}:1` : ''}]`,
          details: d,
        });
      }
      return summarise(items, 'highlights');
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'm',
    key: 'css-conflicts',
    title: 'No CSS conflicts either way',
    plain: 'The page does not restyle the toolbar, note card or pin, and the extension does not restyle the page.',
    needs: needsInjected,
    async run(ctx) {
      const { state } = ctx;
      const findings = [];
      const details = { theme: state.ui.theme };
      // Direction 1: has the host page's CSS changed the extension's controls? Compared with how they
      // look on a plain page in the same theme (the extension has a light and a dark look).
      const ref = ctx.reference && ctx.reference[state.ui.theme || 'light'];
      const compared = [];
      if (!ref) {
        details.extensionUi = `not compared: no reference styles for the "${state.ui.theme}" theme`;
      } else {
        for (const [name, key] of [['toolbar', 'toolbar'], ['note card', 'card'], ['note pin', 'pin']]) {
          if (!state.ui[key] || !ref[key]) continue;
          const diffs = diffUi(ref[key], state.ui[key]);
          details[`${name} differences`] = diffs;
          compared.push(name);
          if (diffs.length) findings.push(`page CSS changed the ${name} (${diffs.length} difference(s)): ${diffs.slice(0, 5).join(' ; ')}`);
        }
      }
      // Direction 2: has the extension changed the computed CSS of host elements?
      const base = state.probes.baseline;
      const base2 = state.probes.baseline2;
      if (base && base2) {
        const unstable = new Set(diffStyles(base.styles, base2.styles, new Set()).map((x) => x.split(':')[0]));
        details.hostElementsIgnored = [...unstable];
        for (const stage of ['highlight', 'underline', 'note']) {
          if (!state.probes[stage]) continue;
          const changed = diffStyles(base.styles, state.probes[stage].styles, unstable);
          details[`host changes after ${stage}`] = changed;
          if (changed.length) findings.push(`host page styles changed after ${stage} (${changed.length}): ${changed.slice(0, 4).join(' ; ')}`);
        }
        compared.push(`${Object.keys(base.styles).length} host elements`);
      }
      if (!compared.length) return { status: 'skip', reason: 'Nothing could be compared on this site.', details };
      if (findings.length) return { status: 'fail', reason: findings.join(' || '), details };
      return { status: 'pass', reason: `No differences (${state.ui.theme || 'light'} theme). Compared: ${compared.join(', ')}.`, details };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'n',
    key: 'notes-visible',
    title: 'Note visible and not covering its text',
    plain: 'The note card, and the note on the page (margin note or label), are on screen, not hidden behind the page, show the note\'s text, and do not sit on top of the words they belong to or on other page text.',
    needs: (state) => needsInjected(state) || (state.note ? null : 'no note was created on this site'),
    async run(ctx) {
      const { page, state } = ctx;
      const problems = [];
      const info = [];
      // (1) The card as it was while the note was being typed (recorded by check e).
      const c = state.cardFacts;
      if (!c) problems.push('no facts were recorded about the open note card');
      else {
        if (!c.shown) problems.push('the note card had no size or was hidden');
        if (c.rect.left < 0 || c.rect.top < 0 || c.rect.right > c.viewport.width || c.rect.bottom > c.viewport.height) problems.push(`the note card stuck out of the window (${Math.round(c.rect.left)},${Math.round(c.rect.top)} to ${Math.round(c.rect.right)},${Math.round(c.rect.bottom)} in ${c.viewport.width}×${c.viewport.height})`);
        else if (!c.onTop) problems.push(`the note card was hidden behind <${c.top}>`);
        if (c.coversText) problems.push('the note card covered the words it was created for');
        if (!problems.length) info.push(`card ${Math.round(c.rect.width)}×${Math.round(c.rect.height)}px, on top, clear of its words`);
      }
      // (2) The note on the page once the card is closed: margin note, or label, or plain pin.
      await reveal(ctx, state.note);
      await sleep(300);
      const judged = await judgeNoteOnPage(page, state.note);
      const pin = judged.el;
      const shot = await ctx.shot('n-note-visible');
      problems.push(...judged.problems);
      info.push(...judged.info);
      if (pin && !judged.problems.length) info.push(`${judged.kindName} on screen, on top, showing the note, clear of its words`);
      // (3) Clicking it must bring the note back.
      if (pin && pin.shown && pin.inWindow) {
        const clicked = await h.clickUi(page, h.noteSelectorFor(pin));
        await sleep(300);
        const again = (await h.getUi(page)).card;
        if (!clicked.ok) problems.push(`the ${judged.kindName} could not be clicked: ${clicked.why}`);
        else if (!again) problems.push(`clicking the ${judged.kindName} did not open the note card`);
        else if (again.text !== state.note.note) problems.push(`the reopened card shows "${again.text}" instead of the saved note`);
        else info.push('clicking it reopens the card with the note text');
        await page.keyboard.press('Escape');
        await sleep(200);
      }
      return { status: problems.length ? 'fail' : 'pass', reason: problems.join('; ') || info.join('; '), screenshot: shot, details: { card: c, pin, coverPx: judged.coverPx } };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'f',
    key: 'reload',
    title: 'Everything restored after reload',
    plain: 'After reloading the page, highlights, underlines and the note (shown beside its words) come back on the right words.',
    needs: (state) => needsInjected(state) || (activeMarks(state).length ? null : 'nothing was created on this site, so there is nothing to restore'),
    async run(ctx) {
      const { page, state } = ctx;
      await page.reload({ waitUntil: 'load' });
      if (!(await h.isInjected(page, 5000))) return { status: 'fail', reason: 'After reload the extension did not start on the page.' };
      await waitForSite(ctx);
      const marks = activeMarks(state);
      const res = await measureUntilAligned(page, marks, 4000);
      const items = res.map((r) => ({
        name: labelOf(r.mark),
        status: r.cmp.ok ? 'pass' : 'fail',
        reason: r.cmp.ok ? r.cmp.summary : `"${short(r.mark.text)}": ${r.cmp.summary}`,
      }));
      if (state.note) {
        const stored = (await storedMarkups(ctx)).find((m) => m.id === state.note.id);
        const problems = [];
        if (!stored) problems.push('the note is no longer in storage');
        else if (stored.note !== state.note.note) problems.push(`the saved note text is now "${stored.note}"`);
        await reveal(ctx, state.note);
        await sleep(300);
        const ui = await h.getUi(page);
        const pin = h.noteElementFor(ui, state.note.id);
        if (!pin) problems.push('no margin note, label or pin came back for the note');
        else if (pin.shown && pin.inWindow) {
          const kind = pin.kind === 'margin' ? 'margin note' : pin.kind === 'label' ? 'label' : 'pin';
          // The restored note must not cover its passage or other page text (same test as check n).
          problems.push(...(await noteCoverProblems(page, state.note)).map((p) => `after reload ${p}`));
          if (pin.kind === 'margin' && !pin.text.startsWith(state.note.note.replace(/\s+/g, ' ').trim())) problems.push(`the restored margin note shows "${short(pin.text, 40)}"`);
          await h.clickUi(page, h.noteSelectorFor(pin));
          await sleep(300);
          const card = (await h.getUi(page)).card;
          if (!card) problems.push(`clicking the restored ${kind} did not open the note`);
          else if (card.text !== state.note.note) problems.push(`the restored note shows "${card.text}"`);
          await page.keyboard.press('Escape');
          await sleep(200);
          // Move the pointer off the note so the screenshot shows it at rest, not hover-expanded.
          await page.mouse.move(1, 1);
        }
        items.push({ name: `note text on ${state.note.target}`, status: problems.length ? 'fail' : 'pass', reason: problems.join('; ') || 'note text, on-page note and card restored' });
      }
      await reveal(ctx, marks[0]);
      const shot = await ctx.shot('f-reload', { sheetState: 'after reload' });
      return { ...summarise(items, 'saved items'), screenshot: shot };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'g',
    key: 'scroll-resize',
    title: 'Still aligned after scroll and resize',
    plain: 'Scrolling the page (and any inner scroll box) and resizing the window keeps every markup, and the note shown beside it, on its text.',
    needs: needsMarks,
    async run(ctx) {
      const { page, state, session } = ctx;
      const marks = activeMarks(state);
      const vp = session.viewport;
      const steps = [
        { name: 'scroll the window down 300px', do: () => page.evaluate(() => window.scrollBy(0, 300)) },
        {
          name: 'scroll inner scroll boxes by 60px',
          do: () => page.evaluate((list) => {
            let n = 0;
            const seen = new Set();
            for (const m of list) {
              const el = document.querySelector(m.selector);
              const box = el && window.__mh.scrollBox(el);
              if (box && !seen.has(box)) { seen.add(box); box.scrollTop += box.scrollTop > 60 ? -60 : 60; n++; }
            }
            return n;
          }, marks.map((m) => ({ selector: m.selector }))),
          optional: true,
        },
        { name: 'resize the window to 900×700', do: () => page.setViewportSize({ width: 900, height: 700 }) },
        { name: `resize the window back to ${vp.width}×${vp.height}`, do: () => page.setViewportSize(vp) },
        { name: 'scroll back to the top', do: () => page.evaluate(() => window.scrollTo(0, 0)) },
      ];
      // Starting point: which markups are on their text right now? (Ones already off are another check's finding.)
      const start = await measureUntilAligned(page, marks, 1000);
      let okBefore = new Set(start.filter((r) => r.cmp.ok).map((r) => r.mark.id));
      const offAtStart = start.filter((r) => !r.cmp.ok);
      if (!okBefore.size) {
        return {
          status: 'skip', screenshot: await ctx.shot('g-scroll-resize'),
          reason: `None of the ${marks.length} markups was on its text before scrolling or resizing (see checks c, d and f), so this cannot be judged.`,
        };
      }
      // Where should the note be? Margin note: top aligned with the first line of its passage (or below the
      // note above it); label: at the place its data-place declares; plain pin: above the end of its last line.
      const pinProblem = async () => {
        if (!state.note || !okBefore.has(state.note.id)) return null;
        const ui = await h.getUi(page);
        const el = h.noteElementFor(ui, state.note.id);
        const rects = await h.getTextRects(page, state.note.selector, state.note.startOffset, state.note.endOffset);
        const where = notePlacementProblem(el, rects, ui);
        // Also: the note must not cover its passage or other page text (same test as check n).
        const cover = el && el.shown ? await noteCoverProblems(page, state.note) : [];
        return [where, ...cover].filter(Boolean).join('; ') || null;
      };
      const items = [];
      let shot = null;
      for (const step of steps) {
        const ret = await step.do();
        if (step.optional && ret === 0) { items.push({ name: step.name, status: 'skip', reason: 'no marked text sits inside an inner scroll box' }); continue; }
        await sleep(450);
        const res = await measureUntilAligned(page, marks.filter((m) => okBefore.has(m.id)), 1200);
        const bad = res.filter((r) => !r.cmp.ok);
        const pin = await pinProblem();
        if ((bad.length || pin) && !shot) shot = await ctx.shot('g-scroll-resize'); // as close as possible to the state that failed
        const bits = [];
        if (bad.length) bits.push(`${bad.length} of ${res.length} markups came off their text, e.g. ${bad.slice(0, 3).map((r) => `${labelOf(r.mark)}: ${r.cmp.summary}`).join(' ; ')}`);
        if (pin) bits.push(pin);
        items.push({ name: step.name, status: bits.length ? 'fail' : 'pass', reason: bits.join('; ') || `all ${res.length} markups still aligned` });
        const now = await measure(page, marks);
        okBefore = new Set(now.filter((r) => r.cmp.ok).map((r) => r.mark.id));
        if (!okBefore.size) break;
      }
      if (!shot) shot = await ctx.shot('g-scroll-resize');
      const out = summarise(items, 'steps');
      if (offAtStart.length) out.reason += ` (${offAtStart.length} markup(s) were already off their text before this check started and were left out: ${offAtStart.slice(0, 3).map((r) => labelOf(r.mark)).join(', ')}.)`;
      return { ...out, screenshot: shot };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'r',
    key: 'url-variants',
    title: 'Same page under #fragment and tracking link',
    plain: 'Markups made on a page still show when the same page is opened with a #section or a ?utm_… tracking parameter.',
    needs: needsMarks,
    async run(ctx) {
      const { page, state, url } = ctx;
      const marks = activeMarks(state);
      const u = new URL(url);
      const withFragment = url + '#wmt-harness-section';
      const withTracking = url + (u.search ? '&' : '?') + 'utm_source=harness&utm_medium=test';
      const items = [];
      let shot = null;
      for (const [name, variant] of [['#fragment', withFragment], ['?utm_ tracking parameter', withTracking]]) {
        const ok = await freshLoad(ctx, variant);
        if (!ok) { items.push({ name, status: 'fail', reason: `the extension did not start at ${variant}` }); continue; }
        await waitForSite(ctx);
        const res = await measureUntilAligned(page, marks, 4000);
        const bad = res.filter((r) => !r.cmp.ok);
        if (bad.length && !shot) { await reveal(ctx, bad[0].mark); shot = await ctx.shot('r-url-variants'); }
        items.push({
          name, status: bad.length ? 'fail' : 'pass',
          reason: bad.length
            ? `${bad.length} of ${res.length} markups are not shown at ${variant.replace(ctx.baseUrl, '')}, e.g. ${bad.slice(0, 2).map((r) => `${labelOf(r.mark)}: ${r.cmp.summary}`).join(' ; ')}`
            : `all ${res.length} markups shown at ${variant.replace(ctx.baseUrl, '')}`,
        });
      }
      if (!shot) { await reveal(ctx, marks[0]); shot = await ctx.shot('r-url-variants'); }
      // Back to the plain address for the checks that follow.
      await freshLoad(ctx, url);
      await waitForSite(ctx);
      return { ...summarise(items, 'address variants'), screenshot: shot };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 's',
    key: 'spa-routes',
    title: 'Single-page app: markups stay with their route',
    plain: 'In an app that changes page without reloading, markups from one screen do not show on another and return when you go back.',
    applies: (site, extras) => !!(extras && extras.routes),
    needs: needsMarks,
    async run(ctx) {
      const { page, state, extras } = ctx;
      const R = extras.routes;
      const marks = activeMarks(state);
      const problems = [];
      const info = [];
      // A marker in the page's memory: if it is still there at the end, no reload happened.
      const token = `t${Date.now()}`;
      await page.evaluate((t) => { window.__mhNoReload = t; }, token);
      const homeKey = h.STORAGE.keyFor(page.url());

      // Go to the other route by clicking the app's own link.
      await page.locator(R.other.link).first().click();
      await page.waitForSelector(R.other.ready, { timeout: 5000 }).catch(() => problems.push(`the app never showed the "${R.other.name}" screen`));
      await sleep(2600); // the extension notices address changes within about a second; the "not found" chip takes 1.5 s more
      const otherKey = h.STORAGE.keyFor(page.url());
      if (otherKey === homeKey) problems.push('the address did not change, so this app does not exercise the check');
      const drawnOther = await h.getMarkups(page);
      const leaked = drawnOther.filter((d) => marks.some((m) => h.normaliseText(m.text) === h.normaliseText(d.text)) || d.connected);
      if (leaked.length) problems.push(`${leaked.length} markup(s) from the first screen are still painted on the "${R.other.name}" screen, e.g. "${short(leaked[0].text)}"`);
      else info.push(`nothing from the first screen is painted on "${R.other.name}"`);
      const uiOther = await h.getUi(page);
      if (uiOther.chip && uiOther.chip.shown) problems.push(`on "${R.other.name}" the extension reports "${uiOther.chip.text}", i.e. it still thinks the first screen's markups belong here`);
      if ([...uiOther.pins, ...(uiOther.margins || [])].some((p) => p.shown)) problems.push(`a note (margin note, label or pin) from the first screen is still shown on "${R.other.name}"`);

      // Make one markup on the other route.
      let otherText = null;
      const sel = await h.selectText(page, R.other.target, { slot: 0, slots: 3 });
      if (sel.ok && (await h.waitForToolbar(page)) && (await h.clickToolbar(page, 'highlight')).ok) {
        await sleep(500);
        otherText = sel.text;
        const saved = h.STORAGE.markupsFor(await h.getStored(ctx.session), page.url());
        if (!saved.some((m) => h.normaliseText(h.STORAGE.quoteOf(m)) === h.normaliseText(otherText))) problems.push(`a highlight made on "${R.other.name}" was not saved under that screen's address`);
        else info.push(`a highlight made on "${R.other.name}" is saved under its own address`);
      } else {
        problems.push(`could not make a highlight on "${R.other.name}" (${sel.why || 'no toolbar'})`);
      }
      const shotOther = await ctx.shot('s-spa-other-route');

      // Go back by clicking the app's link for the first route.
      await page.locator(R.home.link).first().click();
      await page.waitForSelector(R.home.ready, { timeout: 5000 }).catch(() => problems.push('the app never showed the first screen again'));
      const res = await measureUntilAligned(page, marks, 5000);
      const bad = res.filter((r) => !r.cmp.ok);
      if (bad.length) problems.push(`${bad.length} of ${res.length} markups did not come back on returning, e.g. ${bad.slice(0, 2).map((r) => `${labelOf(r.mark)}: ${r.cmp.summary}`).join(' ; ')}`);
      else info.push(`all ${res.length} markups came back on returning to the first screen`);
      if (otherText) {
        const stray = (await h.getMarkups(page)).filter((d) => h.normaliseText(d.text) === h.normaliseText(otherText));
        if (stray.length) problems.push(`the highlight made on "${R.other.name}" is painted on the first screen`);
      }
      const reloaded = (await page.evaluate(() => window.__mhNoReload)) !== token;
      if (reloaded) problems.push('the page reloaded during the test, so this did not test in-app navigation');
      else info.push('no page reload happened');
      const shot = await ctx.shot('s-spa-routes');
      return { status: problems.length ? 'fail' : 'pass', reason: problems.length ? `${problems.join('; ')} (also: ${info.join('; ')})` : info.join('; '), screenshot: shot, details: { otherRoutePicture: shotOther } };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'o',
    key: 'print',
    title: 'Print / PDF shows the markups',
    plain: 'In print layout and in a real saved PDF, highlights and underlines are on the right words and the note text is included; the page\'s own text in the PDF is word-for-word the same with markups as without.',
    needs: (state) => needsInjected(state) || (activeMarks(state).length ? null : 'nothing was created on this site, so there is nothing to print'),
    async run(ctx) {
      const { page, state, site } = ctx;
      const marks = activeMarks(state);
      const problems = [];
      const info = [];
      const details = { files: {} };
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(400);
      // The page's own words, to prove later that printing put everything back.
      const readTexts = () => page.evaluate((sels) => sels.map((s) => { try { const el = document.querySelector(s); return el ? window.__mh.fullText(el) : null; } catch (e) { return null; } }), state.targets.map((t) => t.selector));
      const textsBefore = await readTexts();
      const nodeCount = () => page.evaluate(() => window.__mh.textNodes(document.body).length);
      const nodesBefore = await nodeCount();

      // --- Part 1: print layout in the window --------------------------------
      // A real print job photographs the page the instant print layout is switched on. So: wait for a
      // moment when every markup is painted (text that the page keeps rewriting loses its markup for
      // a fraction of a second after each rewrite), switch print layout on, and judge straight away.
      await measureUntilAligned(page, marks, 1500);
      // Where each marked phrase sits in its paragraph, to find the right occurrence in the PDF later.
      const around = await page.evaluate((list) => list.map((m) => {
        let el = null;
        try { el = document.querySelector(m.selector); } catch (e) { /* ignore */ }
        if (!el) return {};
        const t = window.__mh.fullText(el);
        return { before: t.slice(Math.max(0, m.startOffset - 40), m.startOffset), after: t.slice(m.endOffset, m.endOffset + 40) };
      }), marks.map((m) => ({ selector: m.selector, startOffset: m.startOffset, endOffset: m.endOffset })));
      const contextOf = new Map(marks.map((m, i) => [m, around[i]]));
      await page.emulateMedia({ media: 'print' });
      await sleep(120);
      // Parts of a page that the page's own print style hides (menus, sticky bars) are not printed at
      // all, so markups there have nothing to sit on and are left out of the judgement.
      const resAll = await measureUntilAligned(page, marks, 1500);
      const hiddenByPage = resAll.filter((r) => r.textHidden && !r.changedByPage);
      const res = resAll.filter((r) => !hiddenByPage.includes(r));
      if (hiddenByPage.length) info.push(`${hiddenByPage.length} markup(s) are in parts of the page that the page itself hides when printing (${hiddenByPage.slice(0, 3).map((r) => labelOf(r.mark)).join(', ')}) and were left out`);
      const bad = res.filter((r) => !r.cmp.ok);
      details.printMediaAlignment = res.map((r) => ({ mark: labelOf(r.mark), ok: r.cmp.ok, summary: r.cmp.summary }));
      if (bad.length) problems.push(`in print layout, ${bad.length} of ${res.length} markups are off their text (e.g. ${bad.slice(0, 2).map((r) => `${labelOf(r.mark)}: ${r.cmp.summary}`).join(' ; ')})`);
      else if (res.length) info.push(`all ${res.length} markups on their words in print layout`);
      // By design every highlight switches to the light fill with dark text (…-lf) and underlines to …-l.
      const wrongVariant = res.filter((r) => r.entry && !(r.entry.kind === 'highlight' ? r.entry.variant === 'lf' : r.entry.variant === 'l'));
      details.printVariants = res.filter((r) => r.entry).map((r) => r.entry.name);
      if (wrongVariant.length) problems.push(`in print layout ${wrongVariant.length} markup(s) did not switch to the paper style (e.g. ${wrongVariant[0].entry.name})`);
      if (state.note) {
        const p = await page.evaluate(([Sel, note]) => {
          const block = document.querySelector(Sel.printBlock);
          const text = block && block.shadowRoot ? block.shadowRoot.textContent : null;
          return {
            block: !!block, readable: text !== null, hasNote: text !== null && text.replace(/\s+/g, ' ').includes(note),
            markers: document.querySelectorAll(Sel.printMarker).length,
            lastInBody: !!block && block === document.body.lastElementChild,
          };
        }, [S, state.note.note]);
        details.printNotes = p;
        if (!p.block) problems.push('in print layout the list of notes was not added to the page');
        else if (!p.hasNote) problems.push('the print list of notes does not contain the note text');
        else info.push(`notes list added for print with the note text, ${p.markers} numbered marker(s)`);
        if (p.block && p.markers < 1) problems.push('no numbered marker was placed beside the annotated passage');
      }
      fs.mkdirSync(h.PRINT_DIR, { recursive: true });
      const pngFile = path.join(h.PRINT_DIR, `${site.slug}-print.png`);
      let shot = null;
      try {
        await page.screenshot({ path: pngFile, fullPage: true, animations: 'disabled', timeout: 15000 });
        details.files.printPng = path.relative(h.OUTPUT_DIR, pngFile);
        shot = details.files.printPng;
        await ctx.sheet('print', { fullPage: true });
      } catch (e) {
        info.push(`print-layout picture could not be taken (${e.message.split('\n')[0]})`);
      }
      await page.emulateMedia({ media: null });
      await sleep(600);
      // Leaving print layout must put the page back exactly as it was.
      const after = await page.evaluate((Sel) => ({ markers: document.querySelectorAll(Sel.printMarker).length, block: document.querySelectorAll(Sel.printBlock).length }), S);
      const textsAfter = await readTexts();
      const nodesAfter = await nodeCount();
      if (after.markers || after.block) problems.push(`after leaving print layout ${after.markers} marker(s) and ${after.block} notes list(s) were left behind in the page`);
      const selfChanging = await page.evaluate(([sels, vol]) => sels.map((s) => {
        try { const el = document.querySelector(s); return !!el && vol.some((v) => { const x = document.querySelector(v); return x && (el === x || el.contains(x) || x.contains(el)); }); } catch (e) { return false; }
      }), [state.targets.map((t) => t.selector), (ctx.extras.volatile || []).map((v) => v.selector)]);
      const changedTexts = [];
      textsBefore.forEach((t, i) => {
        if (t === textsAfter[i] || selfChanging[i]) return; // text the page itself rewrites proves nothing here
        let k = 0;
        while (t && textsAfter[i] && k < t.length && t[k] === textsAfter[i][k]) k++;
        changedTexts.push(`[${state.targets[i].name}] at character ${k}: "${short((t || '').slice(k), 30)}" became "${short((textsAfter[i] || '(element gone)').slice(k), 30)}"`);
      });
      details.textChangedByPrinting = changedTexts;
      if (changedTexts.length) problems.push(`after leaving print layout the text of ${changedTexts.length} target element(s) is different from before: ${changedTexts.slice(0, 2).join(' ; ')}`);
      if (nodesAfter !== nodesBefore) info.push(`the page has ${nodesAfter} text pieces after printing against ${nodesBefore} before (may be the page's own doing)`);
      const back = await measureUntilAligned(page, marks, 1500);
      const badBack = back.filter((r) => !r.cmp.ok);
      if (badBack.length) problems.push(`after leaving print layout ${badBack.length} markup(s) are off their text (e.g. ${labelOf(badBack[0].mark)}: ${badBack[0].cmp.summary})`);

      // --- Part 2: a real PDF, as "Save as PDF" would produce ----------------
      const pdfDefault = await savePdf(ctx, site.slug); // browser default: "Background graphics" NOT ticked
      const pdfBg = pdfDefault ? await savePdf(ctx, `${site.slug}-with-backgrounds`, { printBackground: true }) : null;
      if (!pdfDefault) {
        info.push(`a PDF could not be produced in this browser mode (${state.pdfError || 'unknown reason'}); run without --headed for the PDF part`);
      } else {
        details.files.pdf = path.relative(h.OUTPUT_DIR, pdfDefault);
        details.files.pdfWithBackgrounds = pdfBg ? path.relative(h.OUTPUT_DIR, pdfBg) : null;
        if (!ctx.pdfTools) {
          info.push('PDFs saved but not inspected (the poppler tools pdftotext/pdftoppm are not installed)');
        } else if (!state.controlPdf) {
          info.push('PDFs saved but not inspected (no before-markup PDF to compare with)');
        } else {
          try {
            const docs = {
              control: pdf.open(state.controlPdf), marked: pdf.open(pdfDefault),
              controlBg: state.controlPdfBg ? pdf.open(state.controlPdfBg) : null, markedBg: pdfBg ? pdf.open(pdfBg) : null,
            };
            const rows = [];
            const pct = (v) => `${Math.round(v * 100)}%`;
            for (const m of marks) {
              const row = { mark: labelOf(m), type: m.type, text: short(m.text, 30) };
              if (hiddenByPage.some((r) => r.mark === m)) { row.verdict = 'unverified'; row.why = 'the page hides this text when printing'; rows.push(row); continue; }
              const where = contextOf.get(m);
              const c = pdf.inspectPhrase(docs.control, m.text, where);
              const d = pdf.inspectPhrase(docs.marked, m.text, where);
              if (!c || !d) { row.verdict = 'unverified'; row.why = 'text not found in the PDF, or found in more than one place'; rows.push(row); continue; }
              if (m.type === 'highlight') {
                // Across how much of the phrase's width has the colour behind the words changed, compared with the unmarked PDF?
                row.coveredDefault = pdf.columnCoverage(d.area, c.area, 24, 0.5, false, d.spans);
                if (docs.controlBg && docs.markedBg) {
                  const cb = pdf.inspectPhrase(docs.controlBg, m.text, where);
                  const db = pdf.inspectPhrase(docs.markedBg, m.text, where);
                  row.coveredWithBackgrounds = cb && db ? pdf.columnCoverage(db.area, cb.area, 24, 0.5, false, db.spans) : null;
                }
                const best = Math.max(row.coveredDefault, row.coveredWithBackgrounds || 0);
                if (row.coveredDefault >= 0.85) row.verdict = 'ok';
                else if (best < 0.1) row.verdict = 'missing';
                else if (best < 0.85) row.verdict = 'misplaced';
                else row.verdict = 'needs-backgrounds';
              } else {
                // Across how much of the phrase's width is there a line that the unmarked PDF lacks?
                row.coveredDefault = pdf.columnCoverage(d.strip, c.strip, 40, 0, true);
                row.verdict = row.coveredDefault >= 0.85 ? 'ok' : row.coveredDefault < 0.1 ? 'missing' : 'misplaced';
              }
              rows.push(row);
            }
            details.pdfMarks = rows;
            for (const type of ['highlight', 'underline']) {
              const mine = rows.filter((r) => r.type === type && r.verdict !== 'unverified');
              if (!mine.length) continue;
              const count = (v) => mine.filter((r) => r.verdict === v).length;
              const bits = [];
              if (count('misplaced')) {
                const ex = mine.find((r) => r.verdict === 'misplaced');
                bits.push(`${count('misplaced')} only partly on their words (e.g. ${ex.mark} "${ex.text}": ${pct(Math.max(ex.coveredDefault, ex.coveredWithBackgrounds || 0))} of the width)`);
              }
              if (count('missing')) {
                const ex = mine.find((r) => r.verdict === 'missing');
                bits.push(`${count('missing')} missing (e.g. ${ex.mark} "${ex.text}")`);
              }
              if (count('needs-backgrounds')) bits.push(`${count('needs-backgrounds')} appear only when "Background graphics" is ticked in the print dialog`);
              if (bits.length) problems.push(`in the saved PDF, of ${mine.length} ${type}s: ${bits.join('; ')}`);
              else info.push(`all ${mine.length} ${type}s are on their words in the PDF (without "Background graphics")`);
            }
            const unverifiable = rows.filter((r) => r.verdict === 'unverified').length;
            if (unverifiable) info.push(`${unverifiable} markup(s) could not be pinned down in the PDF and were not verified there (${[...new Set(rows.filter((r) => r.verdict === 'unverified').map((r) => r.why))].join('; ')})`);
            if (state.note) {
              // The note's text may wrap inside the PDF, so look for each word of it rather than the whole string.
              const txt = pdf.text(pdfDefault);
              const words = state.note.note.split(/\s+/).filter(Boolean);
              details.noteTextInPdf = words.every((w) => txt.includes(w));
              details.notesHeadingInPdf = txt.includes('Notes on this page');
              if (!details.noteTextInPdf) problems.push('the note text is not in the saved PDF');
              else info.push('note text is in the PDF');
            }
            // Proof that marking up never alters or drops the page's own text in the PDF: the words of the
            // PDF with markups equal the words of the PDF without them, apart from the numbers and the notes list.
            const listStrings = ['127.0.0.1:4173', ...marks.filter((m) => (m.note || '').trim()).flatMap((m) => [m.note, m.text.length > 200 ? m.text.slice(0, 200) : m.text])];
            const same = comparePdfText(pdf.text(state.controlPdf), pdf.text(pdfDefault), listStrings);
            details.pdfTextComparison = same;
            if (!same.ok) problems.push(`the page's text in the saved PDF is not the same as without markups: ${same.dropped} word(s) missing, ${same.altered} changed or added (${same.examples.join(' ; ')})`);
            else info.push(`the PDF's ${same.words} page words are identical with and without markups (only ${same.markers} added note number(s)${same.listCut ? ' and the notes list' : ''})`);
          } catch (e) {
            info.push(`PDF inspection failed (${e.message.split('\n')[0]})`);
          }
        }
      }
      return {
        status: problems.length ? 'fail' : 'pass',
        reason: (problems.length ? problems.join(' || ') : info.join('; ')) + (problems.length && info.length ? ` (also: ${info.join('; ')})` : ''),
        screenshot: shot, details,
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'i',
    key: 'copy',
    title: 'Popup counts and "Copy as Markdown"',
    plain: 'The popup shows the right number of markups and its copy button copies every marked phrase with its note.',
    needs: needsMarks,
    async run(ctx) {
      const { page, state, session } = ctx;
      const url = page.url();
      const stored = await storedMarkups(ctx);
      // Order comes from storage; the words, notes and styles come from what the harness itself did.
      const known = new Map(activeMarks(state).map((m) => [m.id, m]));
      const unknown = stored.filter((m) => !known.has(m.id));
      const rows = stored.filter((m) => known.has(m.id)).map((m) => {
        const k = known.get(m.id);
        return { text: k.text, note: k.note || '', kind: k.type, colour: k.colour };
      });
      const expected = h.COPY_FORMAT(await page.title(), url, rows);
      const popup = await h.openPopup(session, { forPage: page });
      h.captureConsole(popup, ctx.errors, session.extensionId, 'popup');
      try {
        await popup.waitForSelector(`${S.popup.countLine}:not(:empty), ${S.popup.message}:not([hidden])`, { timeout: 4000 }).catch(() => {});
        const count = ((await popup.textContent(S.popup.countLine)) || '').trim();
        const breakdown = ((await popup.textContent(S.popup.breakdown)) || '').trim();
        const message = await popup.locator(S.popup.message).isVisible() ? ((await popup.textContent(S.popup.message)) || '').trim() : '';
        const checkList = ((await popup.textContent(S.popup.checkList)) || '').replace(/\s+/g, ' ').trim();
        const problems = [];
        const details = { count, breakdown, message, checkList, expected, tabId: popup.tabId };
        if (message) {
          const shot = await h.screenshot(popup, `${ctx.site.slug}/i-copy-popup`);
          return { status: 'fail', reason: `The popup showed a message instead of the markups: "${message}"`, screenshot: shot, details };
        }
        const n = known.size;
        const wantCount = `${n} ${n === 1 ? 'markup' : 'markups'} on this page`;
        if (count !== wantCount) problems.push(`the popup says "${count}", expected "${wantCount}"`);
        if (unknown.length) problems.push(`storage holds ${unknown.length} markup(s) for this page that the harness did not make`);
        await popup.click(S.popup.copyButton, { timeout: 3000 });
        await sleep(400);
        const status = ((await popup.textContent(S.popup.status)) || '').trim();
        const copied = await popup.getCopied();
        let clipboard = null;
        try { clipboard = await popup.evaluate(() => navigator.clipboard.readText()); } catch (e) { clipboard = null; }
        const shot = await h.screenshot(popup, `${ctx.site.slug}/i-copy-popup`);
        const got = copied.length ? h.stripExportTime(copied[copied.length - 1]) : null;
        details.got = got;
        details.popupStatus = status;
        if (got === null) problems.push(`the popup copied nothing (it said "${status}")`);
        else if (got !== expected) {
          let i = 0;
          while (i < got.length && i < expected.length && got[i] === expected[i]) i++;
          problems.push(`copied text differs from expected at character ${i}: got "${short(got.slice(i), 50)}", expected "${short(expected.slice(i), 50)}"`);
        } else if (clipboard !== null && h.stripExportTime(clipboard) !== expected) problems.push('the popup built the right text but the clipboard holds something else');
        return {
          status: problems.length ? 'fail' : 'pass', screenshot: shot, details,
          reason: problems.length ? problems.join('; ')
            : `Popup says "${count}" (${breakdown}); copied ${rows.length} phrase(s) as Markdown exactly as expected, ${rows.filter((r) => r.note).length} with a note`
              + `${clipboard === null ? ' (clipboard could not be read back; the write was intercepted instead)' : ' (read back from the clipboard)'}. Page check in the popup: "${short(checkList, 90)}". The popup was opened as a tab and pointed at the page's real tab.`,
        };
      } finally {
        await popup.close().catch(() => {});
        await page.bringToFront().catch(() => {});
      }
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'q',
    key: 'undo',
    title: 'Undo after delete restores the markup',
    plain: 'Deleting a markup offers Undo, and pressing it puts the markup back exactly as it was.',
    needs: needsMarks,
    async run(ctx) {
      const { page } = ctx;
      const pick = await pickClickable(ctx, (m) => m.type === 'highlight' && !m.note);
      if (!pick) return { status: 'skip', reason: 'No markup is painted on visible, clickable words (not inside a link or button), so there is nothing a person could click to delete.' };
      const { mark, point } = pick;
      const label = labelOf(mark);
      const card = await openCardByClick(ctx, point);
      if (!card) return { status: 'fail', reason: `[${label}] clicking the marked words did not open its card`, screenshot: await ctx.shot('q-undo') };
      if (!card.hasDelete) return { status: 'fail', reason: `[${label}] the card has no delete button`, screenshot: await ctx.shot('q-undo') };
      const del = await h.clickUi(page, `${S.card} ${S.cardDelete}`);
      if (!del.ok) return { status: 'fail', reason: `[${label}] ${del.why}` };
      await sleep(500);
      const problems = [];
      const goneDrawn = !(await measure(page, [mark]))[0].cmp.ok;
      const goneStored = !(await isStored(ctx, mark.id));
      if (!goneDrawn) problems.push('after Delete the markup is still painted');
      if (!goneStored) problems.push('after Delete the markup is still in storage');
      const ui = await h.getUi(page);
      const shot = await ctx.shot('q-undo');
      if (!ui.toast || !ui.toast.hasAction) {
        mark.removed = goneStored;
        return { status: 'fail', reason: `[${label}] no Undo was offered after deleting${ui.toast ? ` (toast says "${ui.toast.text}")` : ' (no toast appeared)'}`, screenshot: shot };
      }
      const undo = await h.clickUi(page, S.toastAction);
      if (!undo.ok) {
        mark.removed = goneStored;
        return { status: 'fail', reason: `[${label}] the Undo button could not be clicked: ${undo.why}`, screenshot: shot };
      }
      const [back] = await measureUntilAligned(page, [mark], 2000);
      let storedBack = null;
      for (let i = 0; i < 10 && !storedBack; i++) {
        storedBack = (await storedMarkups(ctx)).find((m) => m.id === mark.id) || null;
        if (!storedBack) await sleep(150);
      }
      if (!back.cmp.ok) problems.push(`after Undo the markup is not back on its words: ${back.cmp.summary}`);
      if (!storedBack) problems.push('after Undo the markup is not back in storage');
      else {
        if (storedBack.kind !== (mark.type === 'underline' ? 'underline' : 'highlight') || storedBack.colour !== mark.colour) problems.push(`after Undo it came back as ${storedBack.kind}/${storedBack.colour}, not ${mark.type}/${mark.colour}`);
        if ((storedBack.note || '') !== (mark.note || '')) problems.push('after Undo its note text is different');
      }
      if (!storedBack) mark.removed = true;
      return {
        status: problems.length ? 'fail' : 'pass', screenshot: shot,
        reason: `[${label}] ` + (problems.join('; ') || 'click on the words opened its card; Delete removed it from the page and storage and offered Undo; Undo put it back on the same words with the same id, style and colour'),
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'h',
    key: 'remove',
    title: 'Delete works and stays deleted',
    plain: 'Clicking marked words opens its card; the bin button deletes it, and it stays gone after a reload.',
    needs: needsMarks,
    async run(ctx) {
      const { page, state } = ctx;
      const pick = await pickClickable(ctx, (m) => m.type === 'highlight' && !m.note);
      if (!pick) return { status: 'skip', reason: 'No markup is painted on visible, clickable words (not inside a link or button), so there is nothing a person could click to delete.' };
      const { mark, point } = pick;
      const label = labelOf(mark);
      const others = activeMarks(state).filter((m) => m !== mark);
      const othersBefore = (await measure(page, others)).filter((r) => r.cmp.ok).map((r) => r.mark.id);
      const card = await openCardByClick(ctx, point);
      if (!card) return { status: 'fail', reason: `[${label}] clicking the marked words did not open its card`, screenshot: await ctx.shot('h-remove') };
      const del = await h.clickUi(page, `${S.card} ${S.cardDelete}`);
      if (!del.ok) return { status: 'fail', reason: `[${label}] ${del.why}` };
      await sleep(500);
      const problems = [];
      if ((await measure(page, [mark]))[0].cmp.ok) problems.push('the markup is still painted after Delete');
      if (await isStored(ctx, mark.id)) problems.push('the markup is still in storage after Delete');
      else mark.removed = true;
      const shot = await ctx.shot('h-remove');
      // Reload: it must stay gone, and the others must still be there.
      await page.reload({ waitUntil: 'load' });
      await h.isInjected(page, 5000);
      await waitForSite(ctx);
      const again = await measureUntilAligned(page, [mark], 1200);
      if (again[0].cmp.ok) problems.push('the markup came back after reload');
      if (mark.removed && (await isStored(ctx, mark.id))) problems.push('the markup is back in storage after reload');
      const stillThere = await measureUntilAligned(page, others.filter((m) => othersBefore.includes(m.id)), 3000);
      const lost = stillThere.filter((r) => !r.cmp.ok);
      if (lost.length) problems.push(`${lost.length} other markup(s) also disappeared (e.g. ${labelOf(lost[0].mark)})`);
      return {
        status: problems.length ? 'fail' : 'pass', screenshot: shot,
        reason: `[${label}] ` + (problems.join('; ') || `deleted from its card, gone from the page and storage, still gone after reload; the other ${stillThere.length} markups untouched`),
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'w',
    key: 'surfaces',
    title: 'See-through controls stay readable; solid when asked',
    plain: 'Words and icons on the toolbar and note card keep 4.5:1 contrast over the darkest and lightest parts of the page, and the controls turn fully solid when the "reduce transparency" setting is on.',
    applies: (site, extras) => !!(extras && extras.surfaces),
    needs: needsInjected,
    async run(ctx) {
      const { page, session } = ctx;
      const items = [];
      const details = { candidates: [], measured: [] };
      await dismissToolbar(page);
      await page.evaluate(() => window.scrollTo(0, 0));

      // --- helpers -----------------------------------------------------------
      /** Average brightness (0 = black, 1 = white) of a picture. */
      const brightness = (img) => {
        let sum = 0;
        const n = img.width * img.height;
        for (let i = 0; i < n; i++) {
          const o = i * img.channels;
          sum += colour.luminance({ r: img.data[o], g: img.data[o + 1], b: img.data[o + 2], a: 1 });
        }
        return n ? sum / n : 0;
      };
      /** Rectangles of every word and icon inside one of the extension's surfaces, plus the surface's own CSS. */
      const partsOf = (surfaceSel) => page.evaluate(([Sel, sel]) => {
        const root = document.querySelector(Sel.host).shadowRoot;
        const el = root.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        const parts = [];
        const nameOf = (n) => n.dataset.action || n.dataset.kind || (n.className && typeof n.className === 'string' ? n.className.split(' ')[0] : '') || n.tagName.toLowerCase();
        for (const n of el.querySelectorAll('*')) {
          if (n.closest(Sel.uiColourSample)) continue; // colour samples are not text
          let rect = null;
          let what = null;
          let col = null;
          if (n.tagName.toLowerCase() === 'svg') {
            rect = n.getBoundingClientRect(); what = `icon ${nameOf(n.parentElement)}`; col = getComputedStyle(n).color;
          } else if (n.tagName === 'TEXTAREA') {
            if (!n.value) continue;
            const r = n.getBoundingClientRect();
            rect = { left: r.left + 4, top: r.top + 4, right: r.right - 16, bottom: Math.min(r.bottom - 4, r.top + 30) }; what = 'typed note text'; col = getComputedStyle(n).color;
          } else {
            const own = Array.from(n.childNodes).filter((c) => c.nodeType === 3 && c.data.trim());
            if (!own.length) continue;
            const range = document.createRange();
            range.selectNodeContents(own[0]);
            rect = range.getBoundingClientRect(); what = `text "${own[0].data.trim().slice(0, 20)}"`; col = getComputedStyle(n).color;
          }
          if (!rect || rect.right - rect.left < 3 || rect.bottom - rect.top < 3) continue;
          parts.push({ what, colour: col, rect: { left: rect.left - 1, top: rect.top - 1, right: rect.right + 1, bottom: rect.bottom + 1 } });
        }
        return {
          rect: window.__mh.plainRect(el.getBoundingClientRect()), background: cs.backgroundColor,
          backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter || 'none', opacity: cs.opacity, parts,
        };
      }, [S, surfaceSel]);
      /** Measure every part of a surface from screenshot pixels. */
      const measureSurface = async (surfaceSel) => {
        const info = await partsOf(surfaceSel);
        if (!info) return null;
        const out = { rect: info.rect, background: info.background, backdropFilter: info.backdropFilter, parts: [] };
        for (const p of info.parts) {
          const pic = await grab(page, p.rect);
          if (!pic) continue;
          const sum = colour.summarisePixels(pic);
          out.parts.push({ what: p.what, contrast: Math.round(sum.contrast * 100) / 100, surface: colour.show(sum.background), ink: sum.text ? colour.show(sum.text) : null, cssColour: p.colour });
        }
        // The surface colour itself, from a strip of its own pixels.
        const body = await grab(page, { left: info.rect.left + 8, top: info.rect.top + 4, right: info.rect.right - 8, bottom: info.rect.bottom - 4 });
        out.surfacePixels = body ? colour.summarisePixels(body).background : null;
        return out;
      };
      const waitToastGone = async () => {
        for (let i = 0; i < 40; i++) {
          if (!(await h.getUi(page)).toast) return;
          await sleep(200);
        }
      };
      /** Show the toolbar, then the note card, at one place; measure both; clean up. */
      const visit = async (cand, mode) => {
        const rec = { where: cand.label, mode, backdropUnderToolbar: Math.round(cand.lum * 100) / 100 };
        const sel = await h.selectText(page, cand.path, { slot: 0, slots: 1 });
        if (!sel.ok || !(await h.waitForToolbar(page))) { rec.problem = `could not show the toolbar here (${sel.why || 'no toolbar'})`; return rec; }
        await page.mouse.move(2, 2);
        await sleep(350); // entry animation finished
        rec.toolbar = await measureSurface(S.toolbar);
        const idsBefore = new Set((await storedMarkups(ctx)).map((m) => m.id));
        if (!(await h.clickToolbar(page, 'note')).ok) { rec.problem = 'the note button could not be clicked'; await dismissToolbar(page); return rec; }
        let card = null;
        for (let i = 0; i < 12 && !card; i++) { await sleep(100); card = (await h.getUi(page)).card; }
        if (!card) { rec.problem = 'no note card appeared'; return rec; }
        await page.keyboard.type('Contrast check 123');
        for (let i = 0; i < 25; i++) { const c = (await h.getUi(page)).card; if (c && c.status === 'Saved') break; await sleep(100); }
        await page.mouse.move(2, 2);
        await sleep(350);
        rec.card = await measureSurface(S.card);
        rec.shot = await ctx.shot(`w-surfaces-${mode}-${cand.kind}`);
        // Remove the markup again so the other checks are not disturbed, then look at what was behind the card.
        const made = await waitForNewStored(ctx, idsBefore, 800);
        await h.clickUi(page, `${S.card} ${S.cardDelete}`);
        await sleep(300);
        if (made && (await isStored(ctx, made.id))) rec.cleanup = 'the temporary note could not be deleted';
        if (rec.card) {
          const behind = await grab(page, rec.card.rect);
          rec.backdropUnderCard = behind ? Math.round(brightness(behind) * 100) / 100 : null;
        }
        await waitToastGone();
        return rec;
      };

      // --- find the darkest and the lightest place a toolbar can appear -------
      const cands = await page.evaluate((max) => window.__mh.textCandidates(max), 36);
      for (const c of cands) {
        const sel = await h.selectText(page, c.path, { slot: 0, slots: 1, settleMs: 80 });
        if (!sel.ok) continue;
        const tb = await h.waitForToolbar(page, 700);
        await dismissToolbar(page);
        if (!tb || !tb.visible) continue;
        await page.mouse.move(2, 2);
        await sleep(60);
        const pic = await grab(page, tb.rect);
        if (!pic) continue;
        c.lum = brightness(pic);
        details.candidates.push({ where: c.label, brightnessUnderToolbar: Math.round(c.lum * 100) / 100 });
      }
      const usable = cands.filter((c) => c.lum !== undefined).sort((a, b) => a.lum - b.lum);
      if (!usable.length) return { status: 'skip', reason: 'No place on this page where a toolbar could be shown and measured.' };
      const darkest = { ...usable[0], kind: 'darkest' };
      const lightest = { ...usable[usable.length - 1], kind: 'lightest' };
      const places = darkest.path === lightest.path ? [darkest] : [darkest, lightest];

      // --- part 1: normal (see-through) look ----------------------------------
      const theme = (await h.getUi(page)).theme;
      for (const place of places) {
        const rec = await visit(place, 'see-through');
        details.measured.push(rec);
        const name = `${place.kind} backdrop (${rec.where}, brightness ${rec.backdropUnderToolbar})`;
        if (rec.problem) { items.push({ name, status: 'skip', reason: rec.problem }); continue; }
        for (const [surface, m, behind] of [['toolbar', rec.toolbar, rec.backdropUnderToolbar], ['note card', rec.card, rec.backdropUnderCard]]) {
          if (!m || !m.parts.length) { items.push({ name: `${surface} over ${name}`, status: 'skip', reason: 'nothing could be measured' }); continue; }
          const low = m.parts.filter((p) => p.contrast < LIMITS.contrastMin);
          const worst = m.parts.reduce((a, b) => (b.contrast < a.contrast ? b : a));
          items.push({
            name: `${surface} over ${place.kind} backdrop`,
            status: low.length ? 'fail' : 'pass',
            reason: low.length
              ? `${low.length} of ${m.parts.length} words/icons are below ${LIMITS.contrastMin}:1 at ${rec.where} (brightness behind the ${surface}: ${behind}): ${low.slice(0, 4).map((p) => `${p.what} ${p.contrast}:1 (${p.ink} on ${p.surface})`).join(' ; ')}`
              : `all ${m.parts.length} words/icons at or above ${LIMITS.contrastMin}:1 at ${rec.where} (brightness behind the ${surface}: ${behind}); lowest is ${worst.what} at ${worst.contrast}:1`,
          });
        }
      }

      // --- part 2: "reduce transparency" switched on ---------------------------
      // Playwright has no option for this preference, so it is switched on through the browser's own
      // debugging channel (Chrome DevTools Protocol), which is what DevTools' "Rendering" panel uses.
      let cdp = null;
      try {
        cdp = await session.context.newCDPSession(page);
        await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
      } catch (e) { cdp = null; }
      const active = cdp ? await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches) : false;
      if (!active) {
        items.push({ name: 'reduce transparency', status: 'skip', reason: 'this browser could not be made to pretend the "reduce transparency" setting is on' });
      } else {
        try {
          await sleep(200);
          const recs = [];
          for (const place of places) {
            const rec = await visit(place, 'reduced-transparency');
            details.measured.push(rec);
            recs.push(rec);
          }
          for (const [surface, key] of [['toolbar', 'toolbar'], ['note card', 'card']]) {
            const ms = recs.map((r) => r[key]).filter(Boolean);
            if (!ms.length) { items.push({ name: `${surface}, reduce transparency`, status: 'skip', reason: recs.map((r) => r.problem).filter(Boolean).join('; ') || 'nothing could be measured' }); continue; }
            const problems = [];
            for (const m of ms) {
              const bg = colour.parseColour(m.background);
              if (!bg || bg.a < 1) problems.push(`its background is still see-through (${m.background})`);
              if (m.backdropFilter && m.backdropFilter !== 'none') problems.push(`it still blurs what is behind it (${m.backdropFilter})`);
            }
            // Pixel proof: a solid surface looks the same over the darkest and the lightest backdrop.
            let pixelNote = '';
            if (ms.length === 2 && ms[0].surfacePixels && ms[1].surfacePixels) {
              const d = round1(colour.deltaE(ms[0].surfacePixels, ms[1].surfacePixels));
              pixelNote = `; its pixels are ${colour.show(ms[0].surfacePixels)} over the darkest and ${colour.show(ms[1].surfacePixels)} over the lightest backdrop (difference ${d})`;
              if (d > 2) problems.push(`its colour changes with what is behind it${pixelNote.slice(1)}`);
            }
            const low = ms.flatMap((m) => m.parts).filter((p) => p.contrast < LIMITS.contrastMin);
            if (low.length) problems.push(`${low.length} words/icons below ${LIMITS.contrastMin}:1, e.g. ${low[0].what} ${low[0].contrast}:1`);
            items.push({
              name: `${surface}, reduce transparency`, status: problems.length ? 'fail' : 'pass',
              reason: problems.length ? [...new Set(problems)].join('; ') : `fully solid (${ms[0].background}, no blur)${pixelNote}; all words/icons at or above ${LIMITS.contrastMin}:1`,
            });
          }
        } finally {
          await cdp.send('Emulation.setEmulatedMedia', { features: [] }).catch(() => {});
        }
      }
      if (cdp) await cdp.detach().catch(() => {});
      await page.evaluate(() => window.scrollTo(0, 0));
      const out = summarise(items, 'surface measurements');
      out.reason = `${theme} theme; ${usable.length} places tried, brightness behind the toolbar from ${Math.round(usable[0].lum * 100) / 100} to ${Math.round(usable[usable.length - 1].lum * 100) / 100}. ${out.reason} Measured from screenshot pixels. The note card opens beside its words, so what lies behind it is whatever is there; its brightness is reported.`;
      const firstShot = details.measured.find((r) => r.shot);
      return { ...out, screenshot: firstShot ? firstShot.shot : null, details };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'v',
    key: 'changed-text',
    title: 'Text changed by the page: "not found", never misplaced',
    plain: 'When the page itself rewrites marked words, the extension says the markup was not found instead of marking other words.',
    applies: (site, extras) => !!(extras && extras.volatile && extras.volatile.length),
    needs: needsInjected,
    async run(ctx) {
      const { page, extras, url } = ctx;
      const items = [];
      let shot = null;
      for (const vt of extras.volatile) {
        const name = vt.name || vt.selector;
        const errorsBefore = ctx.errors.filter((e) => e.fromExtension).length;
        // Mark the words while they still read as they do at page load. The page may rewrite them at any
        // moment (that is the point), so a few attempts are allowed to land a markup between rewrites.
        let made = null;
        let lastWhy = '';
        for (let attempt = 0; attempt < 4 && !made; attempt++) {
          if (!(await freshLoad(ctx, url))) { lastWhy = 'the extension did not start after reloading'; continue; }
          await page.waitForSelector(vt.selector, { state: 'attached', timeout: 4000 }).catch(() => {});
          const idsBefore = new Set((await storedMarkups(ctx)).map((m) => m.id));
          const sel = await h.selectText(page, vt.selector, { slot: 0, slots: 1, settleMs: 60 });
          if (!sel.ok) { lastWhy = `could not select the text: ${sel.why}`; continue; }
          if (!(await h.waitForToolbar(page, 800))) { lastWhy = 'no toolbar appeared'; continue; }
          if (!(await h.clickToolbar(page, 'highlight')).ok) { lastWhy = 'the highlight button could not be clicked'; continue; }
          const saved = await waitForNewStored(ctx, idsBefore, 1200);
          if (!saved) { lastWhy = `nothing was saved${await toastText(page) ? ` (the extension said: "${await toastText(page)}")` : ''}`; continue; }
          made = { id: saved.id, text: sel.text, quote: h.STORAGE.quoteOf(saved) };
        }
        if (!made) { items.push({ name, status: 'skip', reason: `could not mark the text before the page changed it (${lastWhy})` }); continue; }
        // Wait for the page to rewrite the words.
        let changed = false;
        for (let i = 0; i < 40 && !changed; i++) {
          await sleep(150);
          changed = await page.evaluate(([s, t]) => { const el = document.querySelector(s); return !el || !window.__mh.fullText(el).includes(t); }, [vt.selector, made.text]);
        }
        if (!changed) { items.push({ name, status: 'skip', reason: `the page did not change "${short(made.text)}" within 6 seconds` }); continue; }
        await sleep(3200); // the extension looks again after 300 ms and shows its "not found" chip 1.5 s later
        const drawn = await h.getMarkups(page);
        const ui = await h.getUi(page);
        const stored = await storedMarkups(ctx);
        const nowText = await page.evaluate((s) => { const el = document.querySelector(s); return el ? window.__mh.fullText(el) : ''; }, vt.selector);
        // Anything painted inside the changed element that is not words somebody marked and that are still there?
        const validTexts = new Set(stored.filter((m) => m.id !== made.id).map((m) => h.normaliseText(h.STORAGE.quoteOf(m))));
        const elRect = await page.evaluate((s) => { const el = document.querySelector(s); return el ? window.__mh.plainRect(el.getBoundingClientRect()) : null; }, vt.selector);
        const inside = (r) => elRect && r.left >= elRect.left - 1 && r.right <= elRect.right + 1 && r.top >= elRect.top - 1 && r.bottom <= elRect.bottom + 1;
        const wrong = drawn.filter((d) => d.rects.length && d.rects.every(inside) && !validTexts.has(h.normaliseText(d.text)));
        const problems = [];
        if (wrong.length) problems.push(`after the page changed "${short(made.text, 30)}" to "${short(nowText, 30)}", a markup is painted on different words: "${short(wrong[0].text, 30)}" (${wrong[0].name})`);
        if (!stored.some((m) => m.id === made.id)) problems.push('the markup was deleted from storage instead of being kept as "not found"');
        if (!ui.chip || !ui.chip.shown) problems.push('no "not found" chip is shown');
        else if (!/not found/i.test(ui.chip.text)) problems.push(`the chip says "${ui.chip.text}"`);
        const newErrors = ctx.errors.filter((e) => e.fromExtension).slice(errorsBefore);
        if (newErrors.length) problems.push(`the extension logged ${newErrors.length} error(s): ${newErrors[0].text.split('\n')[0].slice(0, 120)}`);
        if (!shot) shot = await ctx.shot('v-changed-text');
        items.push({
          name, status: problems.length ? 'fail' : 'pass',
          reason: problems.join('; ') || `marked "${short(made.text, 30)}"; the page changed it to "${short(nowText, 30)}"; nothing is painted on the new words, the markup is kept in storage and the chip says "${ui.chip.text}"; no errors`,
          details: { made, nowText, chip: ui.chip },
        });
      }
      if (!shot) shot = await ctx.shot('v-changed-text');
      return { ...summarise(items, 'changing texts'), screenshot: shot };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'u',
    key: 'keyboard',
    title: 'Keyboard: select, move, apply, Escape; no key leaks',
    plain: 'Everything can be done from the keyboard, and typing a note does not set off the page\'s own keyboard shortcuts.',
    applies: isFixture,
    needs: needsInjected,
    async run(ctx) {
      const { page, session } = ctx;
      const items = [];
      const target = '#p4'; // a paragraph the earlier checks leave unmarked
      const tabId = await h.tabIdOf(session, page);
      // Chrome delivers the Alt+Shift+H shortcut to the service worker, which forwards it to the page.
      // A test cannot press a browser-level shortcut, so it sends the same forwarded message instead.
      const sendCommand = (command) => h.inWorker(session, ([id, c]) => chrome.tabs.sendMessage(id, { type: 'wmt.command', command: c }), [tabId, command]);
      // Chromium only moves a selection with Shift+Arrow once one exists (a bare click does not give
      // ordinary text a keyboard cursor unless "caret browsing" is on). So: double-click a word to start
      // a selection, close the toolbar that the mouse brought up, then extend with Shift+Arrow. The
      // toolbar that appears after that is the keyboard's doing.
      const selectByKeyboard = async (startChar, count) => {
        await page.evaluate(() => window.getSelection().removeAllRanges());
        const plan = await page.locator(target).evaluate((el, s) => { window.__mh.revealText(el, s, s + 1); return window.__mh.dragPlan(el, s, s + 1); }, startChar);
        await sleep(250);
        const plan2 = await page.locator(target).evaluate((el, s) => window.__mh.dragPlan(el, s, s + 1), startChar);
        await page.mouse.dblclick((plan2 || plan).from.x, (plan2 || plan).from.y);
        await sleep(150);
        await page.keyboard.press('Escape');
        await sleep(100);
        if (await h.getToolbar(page)) return null; // the mouse's toolbar would not close: cannot tell the two apart
        await page.keyboard.down('Shift');
        for (let i = 0; i < count; i++) await page.keyboard.press('ArrowRight');
        await page.keyboard.up('Shift');
        await sleep(150);
        return page.evaluate(() => window.getSelection().toString());
      };
      const focused = async () => { const tb = await h.getToolbar(page); return tb ? tb.focused : '(no toolbar)'; };

      // 1. Selecting with the keyboard shows the toolbar.
      const picked = await selectByKeyboard(2, 11);
      let tb = await h.waitForToolbar(page, 1200);
      if (picked === null) return { status: 'error', reason: 'The toolbar offered after the double-click did not close on Escape, so a keyboard-made toolbar could not be told apart from it.' };
      items.push({ name: 'keyboard selection shows the toolbar', status: tb ? 'pass' : 'fail', reason: tb ? `Shift+Arrow extended the selection to "${picked}" and the toolbar appeared` : `Shift+Arrow extended the selection to "${picked}" but no toolbar appeared` });
      if (!tb) return { ...summarise(items, 'keyboard steps'), screenshot: await ctx.shot('u-keyboard') };

      // 2. The shortcut moves focus into the toolbar; arrows move between buttons.
      await sendCommand('mark-selection');
      await sleep(200);
      const f0 = await focused();
      await page.keyboard.press('ArrowRight');
      const f1 = await focused();
      await page.keyboard.press('ArrowLeft');
      const f2 = await focused();
      await page.keyboard.press('End');
      const f3 = await focused();
      await page.keyboard.press('Home');
      const f4 = await focused();
      const movedOk = f0 && f1 && f0 !== f1 && f2 === f0 && f3 === 'note' && f4 === 'yellow';
      items.push({
        name: 'arrow keys move between toolbar buttons', status: movedOk ? 'pass' : 'fail',
        reason: `focus after the mark-selection shortcut: ${f0}; ArrowRight → ${f1}; ArrowLeft → ${f2}; End → ${f3}; Home → ${f4}` + (movedOk ? '' : ' (expected a different button after ArrowRight, the first again after ArrowLeft, "note" after End, "yellow" after Home)'),
      });
      const shot = await ctx.shot('u-keyboard');

      // 3. Enter applies the focused button (move to green first, so the result is unmistakable).
      await page.keyboard.press('ArrowRight');
      const applyOn = await focused();
      const idsBefore = new Set((await storedMarkups(ctx)).map((m) => m.id));
      await page.keyboard.press('Enter');
      const saved = await waitForNewStored(ctx, idsBefore, 1500);
      const enterOk = !!saved && saved.colour === applyOn && h.normaliseText(h.STORAGE.quoteOf(saved)) === h.normaliseText(picked);
      items.push({
        name: 'Enter applies the focused button', status: enterOk ? 'pass' : 'fail',
        reason: saved ? `Enter on "${applyOn}" saved a ${saved.colour} ${saved.kind} on "${short(h.STORAGE.quoteOf(saved))}"` + (enterOk ? '' : ` (expected ${applyOn} on "${picked}")`) : `Enter on "${applyOn}" saved nothing`,
      });

      // 4. Escape closes the toolbar.
      await selectByKeyboard(20, 9);
      tb = await h.waitForToolbar(page, 1200);
      await page.keyboard.press('Escape');
      await sleep(150);
      const afterEsc = await h.getToolbar(page);
      items.push({
        name: 'Escape closes the toolbar', status: tb && !afterEsc ? 'pass' : 'fail',
        reason: !tb ? 'the toolbar did not appear for the second keyboard selection' : afterEsc ? 'the toolbar is still shown after Escape' : 'toolbar shown, Escape closed it',
      });

      // 5. Typing a note must not reach the page's own key listeners.
      const picked2 = await selectByKeyboard(20, 9);
      await h.waitForToolbar(page, 1200);
      await sendCommand('mark-selection');
      await sleep(200);
      await page.keyboard.press('End');
      const onNote = await focused();
      const keysBefore = await page.evaluate(() => ({ d: window.__pageKeys.document.length, w: window.__pageKeys.windowCapture.length }));
      await page.keyboard.press('Enter');
      let card = null;
      for (let i = 0; i < 12 && !card; i++) { await sleep(100); card = (await h.getUi(page)).card; }
      const typed = 'jk/ ?x';
      if (card) await page.keyboard.type(typed, { delay: 30 });
      await sleep(900);
      const keysAfter = await page.evaluate(() => ({ d: window.__pageKeys.document.slice(), w: window.__pageKeys.windowCapture.slice() }));
      const leakedDoc = keysAfter.d.slice(keysBefore.d);
      const leakedWin = keysAfter.w.slice(keysBefore.w);
      const cardNow = (await h.getUi(page)).card;
      const noteOk = !!card && card.focused && cardNow && cardNow.text === typed && leakedDoc.length === 0 && leakedWin.length === 0;
      const bits = [];
      if (!card) bits.push(`Enter on the "${onNote}" button did not open a note card for "${picked2}"`);
      else {
        if (!card.focused) bits.push('the note text box did not have the cursor');
        if (!cardNow || cardNow.text !== typed) bits.push(`the text box holds "${cardNow ? cardNow.text : '(card gone)'}" after typing "${typed}"`);
        if (leakedDoc.length || leakedWin.length) bits.push(`the page's own key listeners saw ${leakedDoc.length + leakedWin.length} key press(es) typed into the note: document listener [${leakedDoc.join(' ')}], early window listener [${leakedWin.join(' ')}]`);
      }
      items.push({ name: 'typing a note does not reach the page', status: noteOk ? 'pass' : 'fail', reason: bits.join('; ') || `typed "${typed}" into the note; the page's two key listeners saw none of it` });
      // Escape closes the card too, saving the note.
      await page.keyboard.press('Escape');
      await sleep(600);
      const closed = !(await h.getUi(page)).card;
      const savedNote = (await storedMarkups(ctx)).find((m) => m.note === typed);
      items.push({
        name: 'Escape closes the note card and keeps the note', status: closed && savedNote ? 'pass' : 'fail',
        reason: !closed ? 'the card is still open after Escape' : savedNote ? 'card closed, note saved' : 'card closed but the note text was not saved',
      });
      return { ...summarise(items, 'keyboard steps'), screenshot: shot };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 't',
    key: 'migration',
    title: 'Version 1 data carried over',
    plain: 'Highlights, underlines and notes saved by the old version reappear after upgrading, and the old data is kept as a backup.',
    applies: isFixture,
    async run(ctx) {
      // This check uses its own browser: old-format data is written into a fresh profile, the browser
      // is closed, and it is started again so the extension meets the old data as it would after an upgrade.
      const pageUrl = ctx.fixtureUrl + V1_SEED.page;
      const first = await h.launch({ headed: ctx.headed, keepProfile: true });
      let second = null;
      const problems = [];
      const info = [];
      let shot = null;
      try {
        // Let the brand-new install finish its own (empty) first-run bookkeeping.
        for (let i = 0; i < 20; i++) {
          if ((await h.getStored(first)).meta) break;
          await sleep(100);
        }
        // Work out the old-style XPath positions from the real page, with the extension's storage untouched.
        const plain = await first.context.newPage();
        await plain.goto(pageUrl, { waitUntil: 'load' });
        await h.isInjected(plain, 4000);
        const positions = await plain.evaluate((items) => items.map((it) => {
          const el = document.querySelector(it.selector);
          const node = el.firstChild;
          const start = node.data.indexOf(it.text);
          const xp = `//*[@id="${el.id}"]/text()[1]`;
          return { startContainerPath: xp, startOffset: start, endContainerPath: xp, endOffset: start + it.text.length };
        }), V1_SEED.items);
        await plain.close();
        const markups = V1_SEED.items.map((it, i) => (it.type === 'note'
          ? { id: it.id, type: 'note', text: it.note, position: { top: 300, left: 20 }, selection: positions[i] }
          : { id: it.id, type: it.type, text: it.text, position: positions[i], color: it.color }));
        // Seed: old data in, everything version 2 wrote out (as if version 2 had never run).
        const all = await h.getStored(first);
        const v2Keys = Object.keys(all).filter((k) => k !== h.TEST_MODE_KEY);
        await h.setStored(first, { [pageUrl]: { markups } });
        await h.removeStored(first, v2Keys);
        const seeded = await h.getStored(first);
        if (seeded.meta || !seeded[pageUrl]) problems.push('the harness could not seed the old data cleanly');
        await first.close();

        second = await h.launch({ headed: ctx.headed, profileDir: first.profileDir });
        const page = await second.context.newPage();
        const errors = [];
        h.captureConsole(page, errors, second.extensionId, 'migration page');
        await page.goto(pageUrl, { waitUntil: 'load' });
        if (!(await h.isInjected(page, 5000))) problems.push('the extension did not start on the page after the upgrade');
        const marks = V1_SEED.items.map((it) => ({
          type: it.type === 'underline' ? 'underline' : 'highlight', target: it.selector, selector: it.selector, text: it.text, note: it.note || '',
        }));
        // Offsets of each phrase inside its element.
        const offs = await page.evaluate((items) => items.map((it) => { const t = window.__mh.fullText(document.querySelector(it.selector)); return t.indexOf(it.text); }), V1_SEED.items);
        marks.forEach((m, i) => { m.startOffset = offs[i]; m.endOffset = offs[i] + m.text.length; });
        const res = await measureUntilAligned(page, marks, 4000);
        res.forEach((r, i) => {
          const it = V1_SEED.items[i];
          if (!r.cmp.ok) problems.push(`the old ${it.type} on "${it.text}" did not come back: ${r.cmp.summary}`);
          else info.push(`old ${it.type} on "${it.text}" is back (${r.entry.name})`);
        });
        const stored = await h.getStored(second);
        const now = h.STORAGE.markupsFor(stored, pageUrl);
        if (now.length !== 3) problems.push(`storage holds ${now.length} markups for the page in the new format, expected 3`);
        const note = now.find((m) => m.id === V1_SEED.items[2].id);
        if (!note) problems.push('the old note is missing from the new data');
        else if (note.note !== V1_SEED.items[2].note) problems.push(`the note text changed to "${note.note}"`);
        else info.push('note text preserved');
        if (!stored[pageUrl] || !Array.isArray(stored[pageUrl].markups) || stored[pageUrl].markups.length !== 3) problems.push('the old-format record was not kept as a backup');
        else info.push('old record still in storage as a backup');
        if (!stored.meta || stored.meta.schemaVersion !== 2) problems.push(`the data version marker is ${JSON.stringify(stored.meta)}`);
        await sleep(400);
        const uiAfter = await h.getUi(page);
        const migratedEl = note ? h.noteElementFor(uiAfter, note.id) : null;
        if (note && !(migratedEl && migratedEl.shown)) problems.push('no margin note, label or pin is shown for the migrated note');
        else if (note) {
          const flat = note.note.replace(/\s+/g, ' ').trim();
          const head = flat.slice(0, Math.min(12, flat.length)).trimEnd();
          const ok = migratedEl.kind === 'margin' ? migratedEl.text.startsWith(flat) : migratedEl.kind === 'label' ? migratedEl.text.replace(/…$/, '').startsWith(head) : true;
          if (!ok) problems.push(`the migrated note is shown as "${short(migratedEl.text, 40)}" instead of the saved note`);
          else info.push(`migrated note is shown on the page as a ${migratedEl.kind}`);
        }
        const mine = [...errors.filter((e) => e.fromExtension), ...second.workerErrors];
        if (mine.length) problems.push(`the extension logged ${mine.length} error(s): ${mine[0].text.split('\n')[0].slice(0, 120)}`);
        shot = await h.screenshot(page, `${ctx.site.slug}/t-migration`);
      } catch (e) {
        problems.push(`the check could not finish: ${e.message.split('\n')[0]}`);
      } finally {
        if (second) await second.close().catch(() => {});
        fs.rmSync(first.profileDir, { recursive: true, force: true });
        await ctx.page.bringToFront().catch(() => {});
      }
      return { status: problems.length ? 'fail' : 'pass', reason: problems.length ? `${problems.join('; ')}${info.length ? ` (also: ${info.join('; ')})` : ''}` : info.join('; '), screenshot: shot };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'p',
    key: 'pdf-document',
    title: 'PDF documents (the extension\'s PDF viewer)',
    plain: 'Opens real PDFs in the extension\'s viewer, marks them, reloads, zooms, exports and prints them. Ten steps (a to j), each with its own result.',
    applies: (site) => !!site.pdf,
    timeoutMs: 900000, // four PDFs, one of 60 pages, each printed twice
    run: makePdfCheck({ notePlacementProblem, sharesArea }),
  },

  // -------------------------------------------------------------------------
  {
    id: 'x',
    key: 'notes-on-page',
    title: 'Notes on the page (margin notes and labels)',
    plain: 'Clicking a note opens its card; hovering the passage or the note highlights the other; a note hides when its passage is scrolled out of an inner scroll box; the "Show notes on the page" switch turns notes into plain pins and back without a reload; two notes close together never overlap. Run at the normal window width and at 400px.',
    applies: (site, extras) => !!(extras && extras.notesOnPage),
    needs: needsInjected,
    async run(ctx) {
      const { page, state, session, extras } = ctx;
      const cfg = extras.notesOnPage || {};
      const items = [];
      const made = [];                 // notes this check created (all deleted again at the end)
      const vp = session.viewport;
      let shot = null;
      const record = (name, problems, okText) => items.push({ name, status: problems.length ? 'fail' : 'pass', reason: problems.join('; ') || okText });

      /** Select a slice of text, press "Add note", type the text, close the card. Returns a mark-like record or null. */
      const makeNote = async (selector, slot, slots, text, label) => {
        const slice = await page.evaluate(([sel, k, n]) => { const el = document.querySelector(sel); return el ? window.__mh.pickSlice(el, k, n, 30) : null; }, [selector, slot, slots]);
        if (!slice) return { why: `${label}: no text to select in ${selector}` };
        if (await overlapsEarlierMark(ctx, selector, slice)) return { why: `${label}: the text overlaps an earlier markup` };
        for (const m of made) if (m.selector === selector && !(slice.endOffset <= m.startOffset || slice.startOffset >= m.endOffset)) return { why: `${label}: overlaps another test note` };
        const sel = await h.selectText(page, selector, { startOffset: slice.startOffset, endOffset: slice.endOffset });
        if (!sel.ok) return { why: `${label}: could not select the text (${sel.why})` };
        if (!(await h.waitForToolbar(page))) return { why: `${label}: no toolbar appeared` };
        const before = new Set((await storedMarkups(ctx)).map((m) => m.id));
        const click = await h.clickToolbar(page, 'note');
        if (!click.ok) return { why: `${label}: ${click.why}` };
        let card = null;
        for (let i = 0; i < 12 && !card; i++) { await sleep(100); card = (await h.getUi(page)).card; }
        if (!card || !card.hasTextarea) return { why: `${label}: no note card appeared` };
        await page.keyboard.type(text);
        for (let i = 0; i < 20; i++) { await sleep(100); const c = (await h.getUi(page)).card; if (c && c.status === 'Saved') break; }
        const saved = await waitForNewStored(ctx, before, 1000);
        await h.clickUi(page, `${S.card} ${S.cardClose}`);
        await sleep(300);
        if (!saved) return { why: `${label}: the note was not saved` };
        const mark = { type: 'highlight', target: label, selector, startOffset: slice.startOffset, endOffset: slice.endOffset, text: sel.text, id: saved.id, colour: saved.colour, note: text, removed: false };
        made.push(mark);
        return { mark };
      };

      /** Move the mouse to somewhere with no page text under it. */
      const mouseAway = async () => { await page.mouse.move(2, 2); await sleep(250); };
      /** Where to hover on a passage: the middle of its first on-screen line, if nothing but page text is there. */
      const passagePoint = async (mark) => {
        const rects = (await h.getTextRects(page, mark.selector, mark.startOffset, mark.endOffset)) || [];
        const vw = vp.width;
        const r = rects.find((t) => t.width > 6 && t.top >= 0 && t.bottom <= (page.viewportSize() || vp).height && t.left >= 0 && t.right <= (page.viewportSize() || { width: vw }).width);
        return r ? { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2, rects } : null;
      };
      /** Click, hover both ways and overlap, for one note, in whatever window size is current. */
      const battery = async (tag, mark, others) => {
        await reveal(ctx, mark);
        await mouseAway();
        const label = mark.target;
        // 1. The note is on screen and clicking it opens its card.
        const judged = await judgeNoteOnPage(page, mark);
        const el = judged.el;
        {
          const problems = [...judged.problems];
          if (el && el.shown && el.inWindow) {
            const clicked = await h.clickUi(page, h.noteSelectorFor(el));
            await sleep(350);
            const card = (await h.getUi(page)).card;
            if (!clicked.ok) problems.push(`it could not be clicked: ${clicked.why}`);
            else if (!card) problems.push(`clicking the ${judged.kindName} did not open the note card`);
            else if (card.text !== mark.note) problems.push(`the card shows "${card.text}" instead of "${mark.note}"`);
            await page.keyboard.press('Escape');
            await sleep(250);
          }
          if (!shot && problems.length) shot = await ctx.shot('x-notes-on-page');
          record(`${tag}: ${label}: on screen; click opens the card`, problems, `${judged.kindName}; click opens the card with the note${judged.info.length ? ` (${judged.info.join('; ')})` : ''}`);
        }
        // 2. Hover emphasis, both ways.
        {
          await reveal(ctx, mark);
          await mouseAway();
          const problems = [];
          const pt = await passagePoint(mark);
          const e0 = h.noteElementFor(await h.getUi(page), mark.id);
          if (!pt || !e0 || !e0.shown) problems.push('the passage or its note is not on screen, so hovering could not be tried');
          else {
            await page.mouse.move(pt.x, pt.y);
            await sleep(350);
            const a = await h.getUi(page);
            const ea = h.noteElementFor(a, mark.id);
            if (!ea || !ea.emph) problems.push(`hovering the passage did not emphasise its ${e0.kind === 'margin' ? 'margin note' : 'note'} (no ${S.emphClass} class)`);
            await mouseAway();
            const b = await h.getUi(page);
            const eb = h.noteElementFor(b, mark.id);
            if (eb && eb.emph) problems.push('the note stayed emphasised after the mouse left the passage');
            // And the other way: hover the note, the passage gets a ring.
            const now = h.noteElementFor(await h.getUi(page), mark.id);
            if (now && now.shown) {
              await page.mouse.move(now.rect.left + now.rect.width / 2, now.rect.top + Math.min(now.rect.height / 2, 14));
              await sleep(350);
              const c = await h.getUi(page);
              const ec = h.noteElementFor(c, mark.id);
              const near = c.rings.filter((r) => pt.rects.some((t) => Math.abs(r.left - t.left) <= 10 && Math.abs(r.top - t.top) <= 10));
              if (!c.rings.length) problems.push('hovering the note drew no ring round its passage');
              else if (!near.length) problems.push(`hovering the note drew ${c.rings.length} ring(s), but none round the passage's lines`);
              if (ec && !ec.shown) problems.push('the note vanished while it was hovered');
              // Which note is really under the mouse? If another note covers this one's middle, say so.
              const atPoint = await page.evaluate(([x, y]) => { const t = window.__mh.deepElementFromPoint(x, y); return t ? window.__mh.label(t) : null; }, [now.rect.left + now.rect.width / 2, now.rect.top + Math.min(now.rect.height / 2, 14)]);
              if (atPoint && !/margin-note|mn-text|pin|label|short|tiny|full|svg/.test(atPoint)) problems.push(`the note was hidden behind <${atPoint}> when hovered`);
              await mouseAway();
              const d = await h.getUi(page);
              if (d.rings.length) problems.push(`${d.rings.length} ring(s) stayed on the page after the mouse left the note`);
            } else problems.push('the note disappeared when the mouse left the passage');
          }
          if (!shot && problems.length) shot = await ctx.shot('x-notes-on-page');
          record(`${tag}: ${label}: hover emphasis both ways`, problems, 'hovering the passage emphasised the note; hovering the note ringed the passage; both cleared when the mouse left');
        }
        // 3. Notes close together do not overlap each other.
        if (others && others.length) {
          await reveal(ctx, others[0]);
          await mouseAway();
          const ui = await h.getUi(page);
          const shown = [...ui.margins, ...ui.pins].filter((n) => n.shown && n.inWindow);
          const problems = [];
          for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) {
            if (sharesArea(shown[i].rect, shown[j].rect)) { const d = (n) => `${n.kind === 'margin' ? 'margin note' : n.label ? `label ${n.place}` : 'pin'} at ${Math.round(n.rect.left)},${Math.round(n.rect.top)} ${Math.round(n.rect.width)}×${Math.round(n.rect.height)}`; problems.push(`${d(shown[i])} overlaps ${d(shown[j])}`); }
          }
          const want = others.filter((m) => { const e = h.noteElementFor(ui, m.id); return e && e.shown; }).length;
          if (want < 2) { items.push({ name: `${tag}: two close notes do not overlap`, status: 'skip', reason: `only ${want} of the two close test notes were on screen at once` }); }
          else {
            if (!shot && problems.length) shot = await ctx.shot('x-notes-on-page');
            record(`${tag}: two close notes do not overlap`, problems, `${shown.length} notes on screen at once, none overlapping (${shown.map((n) => n.kind === 'margin' ? 'margin' : n.label ? `label ${n.place}` : 'pin').join(', ')})`);
          }
        }
      };

      /** Pop the popup open and set "Show notes on the page". */
      const setShowNotes = async (on) => {
        const popup = await h.openPopup(session, { forPage: page });
        try {
          await popup.waitForSelector(S.popup.showNotes, { timeout: 4000 });
          const box = popup.locator(S.popup.showNotes);
          try { await box.setChecked(on, { timeout: 2500 }); } catch (e) { await box.setChecked(on, { force: true, timeout: 2500 }); }
          await sleep(300);
          return (await box.isChecked()) === on;
        } finally { await popup.close().catch(() => {}); await page.bringToFront().catch(() => {}); }
      };

      try {
        await dismissToolbar(page);
        await page.evaluate(() => window.scrollTo(0, 0));
        // --- Make two notes close together (and one inside an inner scroll box where the site has one).
        let pair = null;
        let pairWhy = [];
        const candidates = state.targets.filter((t) => t.exists && !t.designExcluded);
        for (const t of candidates) {
          const a = await makeNote(t.selector, 5, 8, 'Close note A one', 'close note A');
          if (!a.mark) { pairWhy.push(`${t.name}: ${a.why}`); continue; }
          const b = await makeNote(t.selector, 6, 8, 'Close note B two', 'close note B');
          if (!b.mark) { pairWhy.push(`${t.name}: ${b.why}`); continue; }
          pair = [a.mark, b.mark];
          break;
        }
        const own = state.note && !state.note.removed ? state.note : null;
        if (!pair) items.push({ name: 'set-up: two close notes', status: 'skip', reason: `could not make two close notes (${pairWhy.slice(0, 2).join('; ')})` });
        let scrollNote = null;
        if (cfg.scrollTarget) {
          let r = { why: 'no free text' };
          for (const k of [7, 6, 5, 4, 3, 2, 1, 0]) { r = await makeNote(cfg.scrollTarget, k, 8, 'Scroll box note C', 'scroll-box note'); if (r.mark) break; }
          scrollNote = r.mark || null;
          if (!scrollNote) items.push({ name: 'set-up: note in the inner scroll box', status: 'skip', reason: r.why });
        }
        const subject = own || (pair && pair[0]) || null;
        if (!subject) return { status: 'skip', reason: 'no note could be made on this site' };
        await sleep(500);

        // --- Normal window width.
        await battery(`${vp.width}px`, subject, pair);
        if (pair && own) await battery(`${vp.width}px`, pair[0], pair);

        // --- Inner scroll box: the note hides while its passage is scrolled out of the box.
        if (scrollNote) {
          const probs = [];
          await reveal(ctx, scrollNote);
          const before = h.noteElementFor(await h.getUi(page), scrollNote.id);
          if (!before || !before.shown) probs.push('the scroll-box note was not shown while its passage was in view');
          const res = await page.evaluate(async (m) => {
            const el = document.querySelector(m.selector);
            const box = el && window.__mh.scrollBox(el);
            if (!box) return { box: false };
            box.scrollTop = box.scrollHeight;
            await new Promise((r) => setTimeout(r, 500));
            const rects = window.__mh.textRects(el, m.startOffset, m.endOffset);
            const b = box.getBoundingClientRect();
            const inside = rects.some((t) => t.bottom > b.top && t.top < b.bottom && t.right > b.left && t.left < b.right);
            return { box: true, inside, top: box.scrollTop };
          }, scrollNote);
          if (!res.box) items.push({ name: 'inner scroll box: note hides when its passage scrolls out', status: 'skip', reason: `${cfg.scrollTarget} is not inside an inner scroll box here` });
          else if (res.inside) items.push({ name: 'inner scroll box: note hides when its passage scrolls out', status: 'skip', reason: 'the passage was still inside the scroll box after scrolling to the end, so this cannot be judged' });
          else {
            await sleep(300);
            const hiddenEl = h.noteElementFor(await h.getUi(page), scrollNote.id);
            const stillShown = hiddenEl && hiddenEl.shown && hiddenEl.inWindow;
            if (stillShown) probs.push('the note stayed on screen after its passage scrolled out of the inner scroll box');
            await page.evaluate((m) => { const el = document.querySelector(m.selector); const box = el && window.__mh.scrollBox(el); if (box) box.scrollTop = 0; }, scrollNote);
            await sleep(500);
            await reveal(ctx, scrollNote);
            const back = h.noteElementFor(await h.getUi(page), scrollNote.id);
            if (!back || !back.shown) probs.push('the note did not come back when its passage scrolled back into view');
            if (!shot && probs.length) shot = await ctx.shot('x-notes-on-page');
            record('inner scroll box: note hides when its passage scrolls out, returns when it scrolls back', probs, 'hidden while the passage was scrolled out of the panel, shown again when scrolled back');
          }
        }

        // --- Switch "Show notes on the page" off and on, without reloading.
        {
          const probs = [];
          await reveal(ctx, subject);
          await page.evaluate(() => { window.__xNoReload = true; });
          const offOk = await setShowNotes(false);
          await sleep(700);
          if (!offOk) probs.push('the popup switch would not turn off');
          const off = await h.getUi(page);
          const eOff = h.noteElementFor(off, subject.id);
          if (off.margins.some((m) => m.shown)) probs.push(`${off.margins.filter((m) => m.shown).length} margin note(s) still shown with the setting off`);
          if (off.pins.some((p) => p.shown && p.label)) probs.push('a label is still shown with the setting off');
          if (!eOff || eOff.kind !== 'pin' || !eOff.shown) probs.push(`with the setting off the note should be a plain pin, but it is ${eOff ? (eOff.shown ? eOff.kind : 'hidden') : 'missing'}`);
          else {
            const clicked = await h.clickUi(page, h.noteSelectorFor(eOff));
            await sleep(300);
            const card = (await h.getUi(page)).card;
            if (!clicked.ok || !card) probs.push('the plain pin did not open the note card');
            await page.keyboard.press('Escape');
            await sleep(250);
          }
          const onOk = await setShowNotes(true);
          await sleep(700);
          if (!onOk) probs.push('the popup switch would not turn back on');
          await reveal(ctx, subject);
          const on = await h.getUi(page);
          const eOn = h.noteElementFor(on, subject.id);
          if (!eOn || !eOn.shown || eOn.kind === 'pin') probs.push(`after switching back on the note should be a margin note or label, but it is ${eOn ? (eOn.shown ? eOn.kind : 'hidden') : 'missing'}`);
          if (on.pins.some((p) => p.shown && !p.label)) probs.push('a plain pin is still shown after switching the setting back on');
          const kept = await page.evaluate(() => window.__xNoReload === true);
          if (!kept) probs.push('the page was reloaded by the switch (a marker set before it was lost)');
          if (!shot && probs.length) shot = await ctx.shot('x-notes-on-page');
          record('"Show notes on the page" off and on, no reload', probs, `off: plain pin (click opens the card); on: ${eOn ? eOn.kind : '?'} again; page not reloaded`);
        }

        // --- 400px-wide window.
        await page.setViewportSize({ width: 400, height: vp.height });
        await sleep(900);
        await battery('400px', subject, pair);
        if (pair && own) await battery('400px', pair[0], pair);
        await page.setViewportSize(vp);
        await sleep(700);
      } finally {
        // Put everything back: setting on, window size, and delete the notes this check made.
        await page.setViewportSize(vp).catch(() => {});
        await setShowNotes(true).catch(() => {});
        for (const m of made) {
          try {
            await page.keyboard.press('Escape');
            await reveal(ctx, m);
            const e = h.noteElementFor(await h.getUi(page), m.id);
            if (e && e.shown) {
              await h.clickUi(page, h.noteSelectorFor(e));
              await sleep(300);
              await h.clickUi(page, `${S.card} ${S.cardDelete}`);
              await sleep(400);
            }
          } catch (err) { /* cleanup is best effort */ }
        }
        const left = (await storedMarkups(ctx).catch(() => [])).filter((m) => made.some((x) => x.id === m.id));
        if (left.length) items.push({ name: 'clean-up', status: 'skip', reason: `${left.length} test note(s) could not be deleted again (they are left in this run's throwaway profile)` });
      }
      if (!shot) shot = await ctx.shot('x-notes-on-page');
      return { ...summarise(items, 'steps'), screenshot: shot };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'y',
    key: 'review-prompt',
    title: 'Review prompt',
    plain: 'The popup asks for a review on its 2nd, 5th, 10th and 15th opening and not otherwise; "Remind me later" keeps asking, a star opens the store\'s review page and stops it, and so does "Don\'t ask again".',
    applies: isFixture,
    async run(ctx) {
      // Its own fresh browser, so the popup's open counter starts at zero whatever other checks did.
      const P = S.popup;
      const session = await h.launch({ headed: ctx.headed });
      const problems = [];
      const info = [];
      const errors = [];
      let shot = null;
      const keys = S.reviewKeys;
      /** Open the popup once; returns it with whether the panel is showing. */
      const open = async () => {
        const popup = await h.openPopup(session, { forUrl: ctx.fixtureUrl + '/basic/index.html' });
        h.captureConsole(popup, errors, session.extensionId, 'popup (review check)');
        await popup.waitForSelector(`${P.message}:not([hidden]), #main:not([hidden])`, { timeout: 4000 }).catch(() => {});
        await sleep(150); // the panel decision waits on one storage round trip
        return { popup, shown: await popup.locator(P.reviewPanel).isVisible() };
      };
      const status = async () => (await h.getStored(session))[keys.status];
      try {
        // 1. Opens 1-10 pressing "Remind me later" whenever it shows, then jump the counter to 14 and open the 15th.
        const want = new Set([2, 5, 10, 15]);
        const wrong = [];
        for (let n = 1; n <= 15; n++) {
          if (n === 11) { await h.setStored(session, { [keys.opens]: 14 }); n = 15; }
          const { popup, shown } = await open();
          if (shown !== want.has(n)) wrong.push(`open ${n} ${shown ? 'showed' : 'did not show'} the panel`);
          if (shown && n === 2) shot = await h.screenshot(popup, `${ctx.site.slug}/y-review-popup`);
          if (shown) {
            await popup.click(P.reviewLater, { timeout: 3000 });
            if (await popup.locator(P.reviewPanel).isVisible()) wrong.push(`"Remind me later" did not hide the panel on open ${n}`);
            if (!(await popup.evaluate((sel) => document.activeElement === document.querySelector(sel), P.title))) wrong.push(`after "Remind me later" on open ${n} focus was not moved to the popup heading`);
            const st = await status();
            if (st === 'done' || st === 'never') wrong.push(`"Remind me later" set the status to "${st}"`);
          }
          await popup.close();
        }
        if (wrong.length) problems.push(...wrong); else info.push('panel on opens 2, 5, 10 and 15 only (11-14 skipped by setting the counter); "Remind me later" hides it and keeps asking');

        // 2. On the next qualifying open (20), a star opens the review page in a new tab; no panel after that.
        await h.setStored(session, { [keys.opens]: 19 });
        const { popup, shown } = await open();
        if (!shown) problems.push('no panel on open 20');
        else {
          const tabOpened = session.context.waitForEvent('page', { timeout: 5000 });
          await popup.click(P.reviewStar.replace('{n}', '3'), { timeout: 3000 });
          const tab = await tabOpened.catch(() => null);
          if (tab) await tab.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
          // A fresh profile may be sent on to Google's cookie consent page, which carries the asked-for address in ?continue=.
          const unwrap = (u) => { try { const x = new URL(u); return x.host === 'consent.google.com' ? x.searchParams.get('continue') : u; } catch (e) { return u; } };
          const went = tab ? unwrap(tab.url()) : null;
          if (went !== S.reviewUrl) problems.push(`star 3 opened ${tab ? `"${tab.url()}"` : 'no new tab'}, expected the store review page`);
          else info.push('star 3 opened the store review page in a new tab');
          if (await popup.locator(P.reviewPanel).isVisible()) problems.push('the panel stayed open after a star');
          if ((await status()) !== 'done') problems.push(`after a star the status is "${await status()}", expected "done"`);
          if (tab) await tab.close().catch(() => {});
        }
        await popup.close();
        let back = 0;
        for (let n = 21; n <= 25; n++) { const r = await open(); if (r.shown) back++; await r.popup.close(); }
        if (back) problems.push(`after a star the panel came back ${back} time(s) in opens 21-25`);
        else info.push('never shown again after a star (opens 21-25)');

        // 3. Start over: "Don't ask again" stops it.
        await h.removeStored(session, [keys.status]);
        await h.setStored(session, { [keys.opens]: 4 });
        const five = await open();
        if (!five.shown) problems.push('no panel on open 5 after resetting');
        else {
          await five.popup.click(P.reviewNever, { timeout: 3000 });
          if (!(await five.popup.evaluate((sel) => document.activeElement === document.querySelector(sel), P.title))) problems.push('after "Don\'t ask again" focus was not moved to the popup heading');
          else info.push('focus moves to the popup heading when the panel closes');
          if ((await status()) !== 'never') problems.push(`"Don't ask again" left the status "${await status()}"`);
        }
        await five.popup.close();
        await h.setStored(session, { [keys.opens]: 9 });
        const ten = await open();
        if (ten.shown) problems.push('the panel came back on open 10 after "Don\'t ask again"');
        else info.push('"Don\'t ask again" stops it (nothing on open 10)');
        await ten.popup.close();

        const mine = [...errors.filter((e) => e.fromExtension), ...session.workerErrors];
        if (mine.length) problems.push(`the popup logged ${mine.length} error(s): ${mine[0].text.split('\n')[0].slice(0, 120)}`);
      } catch (e) {
        problems.push(`the check could not finish: ${e.message.split('\n')[0]}`);
      } finally {
        await session.close().catch(() => {});
        await ctx.page.bringToFront().catch(() => {});
      }
      return { status: problems.length ? 'fail' : 'pass', reason: problems.length ? `${problems.join('; ')}${info.length ? ` (also: ${info.join('; ')})` : ''}` : info.join('; '), screenshot: shot };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'j',
    key: 'console',
    title: 'No extension errors in the console',
    plain: 'The extension (page script, popup and background worker) logged no errors while all of the above happened.',
    async run(ctx) {
      const mine = [...ctx.errors.filter((e) => e.fromExtension), ...ctx.session.workerErrors];
      const others = ctx.errors.filter((e) => !e.fromExtension).length;
      const details = { extensionErrors: mine, pageOwnErrors: ctx.errors.filter((e) => !e.fromExtension).slice(0, 10) };
      if (!mine.length) return { status: 'pass', reason: `No errors from the extension.${others ? ` (${others} error(s) from the test page itself were ignored.)` : ''}`, details };
      const counts = new Map();
      for (const e of mine) {
        const key = `${e.where}: ${e.text.split('\n')[0].slice(0, 160)}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const list = [...counts.entries()].slice(0, 4).map(([k, n]) => `${n}× ${k}`).join(' | ');
      return { status: 'fail', reason: `${mine.length} error(s) from the extension: ${list}`, details };
    },
  },
];

/**
 * Capture the "reference" look of the toolbar, note card and pin on plain
 * pages with no CSS of their own that could interfere (tests/fixtures/basic
 * for the light theme, tests/fixtures/dark for the dark theme). Check (m)
 * compares every site against the reference for its theme.
 */
async function captureReference(session, fixtureBase) {
  const out = {};
  for (const [theme, pagePath] of [['light', '/basic/index.html'], ['dark', '/dark/index.html']]) {
    const page = await session.context.newPage();
    try {
      await page.goto(fixtureBase + pagePath, { waitUntil: 'load' });
      if (!(await h.isInjected(page, 5000))) continue;
      const ref = { theme: (await h.getUi(page)).theme };
      let sel = await h.selectText(page, '#p1', { slot: 0, slots: 3 });
      if (sel.ok && (await h.waitForToolbar(page))) ref.toolbar = await captureUi(page, TOOLBAR_PARTS);
      await dismissToolbar(page);
      sel = await h.selectText(page, '#p3', { slot: 2, slots: 3 });
      if (sel.ok && (await h.waitForToolbar(page)) && (await h.clickToolbar(page, 'note')).ok) {
        await sleep(400);
        await page.keyboard.type('x');
        ref.card = await captureUi(page, CARD_PARTS);
        await sleep(700);
        await h.clickUi(page, `${S.card} ${S.cardClose}`);
        await sleep(300);
        ref.pin = await captureUi(page, PIN_PARTS);
      }
      out[ref.theme || theme] = ref;
    } finally {
      await page.close().catch(() => {});
    }
  }
  return Object.keys(out).length ? out : null;
}

module.exports = { CHECKS, LIMITS, captureReference };

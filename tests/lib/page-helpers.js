/**
 * tests/lib/page-helpers.js
 *
 * Code that runs INSIDE the web page under test (not in Node). harness.js
 * installs it into every page before the page's own scripts run, as a single
 * global called `window.__mh` ("markup harness").
 *
 * It only measures things (text positions, selections, layout, colours). It
 * never changes the extension's own elements, so it cannot make a check pass
 * by accident.
 *
 * IMPORTANT: this function is serialised and sent to the browser, so it must be
 * fully self-contained: no require(), no variables from outside the function.
 */

/* eslint-disable no-undef */
function installPageHelpers(ownedSelectors) {
  if (window.__mh) return;
  const mh = {};
  // Selectors of elements the extension itself adds to the page; their text is never counted as page text.
  mh.owned = ownedSelectors || [];
  mh.isOwned = (el) => mh.owned.some((s) => { try { return el.matches(s); } catch (e) { return false; } });

  /** Plain {left, top, right, bottom, width, height} copy of a DOMRect (viewport coordinates). */
  mh.plainRect = (r) => ({
    left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
  });

  /** Short human label for an element, e.g. `p#intro.lead`. */
  mh.label = (el) => {
    if (!el || !el.tagName) return String(el);
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList && el.classList.length ? '.' + el.classList[0] : '');
  };

  /** Parent in the "composed" tree: steps out of shadow roots to their host element. */
  mh.composedParent = (node) => node.parentNode || node.host || null;

  /** True when `inner` is `outer` or lives inside it, even across shadow roots. */
  mh.composedContains = (outer, inner) => {
    for (let n = inner; n; n = mh.composedParent(n)) if (n === outer) return true;
    return false;
  };

  /** Every text node inside an element, in document order. Skips script/style, steps into open shadow roots. */
  mh.textNodes = (el) => {
    const out = [];
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) { out.push(node); return; }
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
      if (node.tagName && /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.tagName)) return;
      if (node.nodeType === Node.ELEMENT_NODE && mh.isOwned(node)) return;
      if (node.shadowRoot) visit(node.shadowRoot);
      for (const child of node.childNodes) visit(child);
    };
    visit(el);
    return out;
  };

  /** The top-most element at a point, looking inside open shadow roots too. */
  mh.deepElementFromPoint = (x, y) => {
    let top = document.elementFromPoint(x, y);
    for (let i = 0; i < 10 && top && top.shadowRoot; i++) {
      const inner = top.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === top) break;
      top = inner;
    }
    return top;
  };

  /**
   * Where the TEXT inside a DOM Range is on screen, one text node at a time
   * (the same way textRects() measures, so the two can be compared).
   */
  mh.rangeTextRects = (range) => {
    const rects = [];
    if (range.collapsed) return rects;
    const rootNode = range.commonAncestorContainer;
    const nodes = rootNode.nodeType === Node.TEXT_NODE ? [rootNode] : mh.textNodes(rootNode);
    for (const node of nodes) {
      if (!range.intersectsNode(node)) continue;
      const from = node === range.startContainer ? range.startOffset : 0;
      const to = node === range.endContainer ? range.endOffset : node.data.length;
      if (to <= from) continue;
      const r = document.createRange();
      r.setStart(node, from);
      r.setEnd(node, to);
      for (const cr of r.getClientRects()) if (cr.width > 0.5 && cr.height > 0.5) rects.push(mh.plainRect(cr));
    }
    return rects;
  };

  /** All of an element's text as one string. Character offsets used everywhere else index into this. */
  mh.fullText = (el) => mh.textNodes(el).map((n) => n.data).join('');

  /** Split [start, end) of the element's text into per-text-node pieces: [{node, from, to}]. */
  mh.segments = (el, start, end) => {
    const segs = [];
    let pos = 0;
    for (const node of mh.textNodes(el)) {
      const len = node.data.length;
      const from = Math.max(start, pos) - pos;
      const to = Math.min(end, pos + len) - pos;
      if (to > from) segs.push({ node, from, to });
      pos += len;
      if (pos >= end) break;
    }
    return segs;
  };

  /** A DOM Range covering characters [start, end) of the element's text. */
  mh.rangeFor = (el, start, end) => {
    const segs = mh.segments(el, start, end);
    if (!segs.length) return null;
    const range = document.createRange();
    range.setStart(segs[0].node, segs[0].from);
    range.setEnd(segs[segs.length - 1].node, segs[segs.length - 1].to);
    return range;
  };

  /**
   * The rectangles the TEXT ITSELF occupies on screen for [start, end).
   * Measured one text node at a time, so it is independent of how the
   * extension measures (the extension asks for the rects of the whole range,
   * which can include whole element boxes).
   */
  mh.textRects = (el, start, end) => {
    const rects = [];
    for (const seg of mh.segments(el, start, end)) {
      const r = document.createRange();
      r.setStart(seg.node, seg.from);
      r.setEnd(seg.node, seg.to);
      for (const cr of r.getClientRects()) {
        if (cr.width > 0.5 && cr.height > 0.5) rects.push(mh.plainRect(cr));
      }
    }
    return rects;
  };

  /**
   * Choose a sensible run of characters to select inside an element when the
   * test site does not say exactly which characters to use.
   * The text is cut into `slots` equal regions and a short phrase (whole words
   * where possible, up to maxChars) is taken from region number `slot`. Using
   * different slots lets a highlight, an underline and a note share one
   * element without overlapping each other.
   */
  mh.pickSlice = (el, slot = 0, slots = 1, maxChars = 40) => {
    const text = mh.fullText(el);
    const L = text.length;
    if (!text.trim()) return null;
    const isWs = (i) => /\s/.test(text[i]);
    const regionStart = Math.floor((L * slot) / slots);
    const regionEnd = Math.floor((L * (slot + 1)) / slots);

    // First word start at or after the region start.
    let start = -1;
    for (let i = regionStart; i < regionEnd; i++) {
      if (!isWs(i) && (i === 0 || isWs(i - 1))) { start = i; break; }
    }
    if (start < 0) {
      // No word boundary in this region (e.g. Chinese/Japanese has no spaces): take the first visible character.
      for (let i = regionStart; i < regionEnd; i++) if (!isWs(i)) { start = i; break; }
    }
    if (start < 0) return null; // region is all whitespace

    // Extend to maxChars, staying inside the region (leave a one-character gap before the next slot).
    const hardEnd = Math.min(start + maxChars, slots > 1 && slot < slots - 1 ? regionEnd - 1 : regionEnd, L);
    let end = hardEnd;
    // Walk back to the end of a whole word, if there is one.
    for (let e = hardEnd; e > start + 1; e--) {
      if (!isWs(e - 1) && (e === L || isWs(e))) { end = e; break; }
    }
    while (end > start + 1 && isWs(end - 1)) end--;
    // Never split a surrogate pair (emoji and some CJK characters are two code units).
    const lo = text.charCodeAt(start);
    if (lo >= 0xdc00 && lo <= 0xdfff && start > 0) start--;
    const hi = text.charCodeAt(end - 1);
    if (hi >= 0xd800 && hi <= 0xdbff && end < L) end++;
    if (end <= start) return null;
    return { startOffset: start, endOffset: end, text: text.slice(start, end), totalLength: L };
  };

  /**
   * Everything Node needs to perform a real mouse drag over [start, end):
   * where to press, where to release, and whether those points are actually
   * on the text (not hidden under a sticky header, cookie banner, etc.).
   */
  mh.dragPlan = (el, start, end) => {
    const range = mh.rangeFor(el, start, end);
    if (!range) return { ok: false, why: 'no text at those character offsets' };
    const text = mh.fullText(el);
    const rects = mh.textRects(el, start, end);
    if (!rects.length) return { ok: false, why: 'the text is not drawn on screen (hidden, or inside a form control)', expected: range.toString() };

    // Rect of the first and last character, to find the exact press/release points.
    const code = (i) => text.charCodeAt(i);
    const firstLen = code(start) >= 0xd800 && code(start) <= 0xdbff ? 2 : 1;
    const lastLen = code(end - 1) >= 0xdc00 && code(end - 1) <= 0xdfff ? 2 : 1;
    const first = mh.textRects(el, start, start + firstLen)[0] || rects[0];
    const last = mh.textRects(el, end - lastLen, end)[0] || rects[rects.length - 1];

    // Right-to-left text (Arabic, Hebrew) starts at the right-hand edge of its first character.
    const dirOf = (node) => getComputedStyle(node.parentElement || el).direction;
    const startRtl = dirOf(range.startContainer) === 'rtl';
    const endRtl = dirOf(range.endContainer) === 'rtl';
    const inset = (r) => Math.min(1, r.width / 4);
    const from = { x: startRtl ? first.right - inset(first) : first.left + inset(first), y: first.top + first.height / 2 };
    const to = { x: endRtl ? last.left + inset(last) : last.right - inset(last), y: last.top + last.height / 2 };

    // Is each point inside the window, and is our text the top-most thing there?
    const hit = (pt) => {
      if (pt.x < 0 || pt.y < 0 || pt.x >= window.innerWidth || pt.y >= window.innerHeight) return 'outside the visible window';
      const top = mh.deepElementFromPoint(pt.x, pt.y); // looks inside web components too
      if (!top) return 'nothing at that point';
      if (mh.composedContains(el, top) || mh.composedContains(top, el)) return null;
      return `covered by <${mh.label(top)}>`;
    };

    return { ok: true, from, to, fromBlocked: hit(from), toBlocked: hit(to), expected: range.toString(), rects };
  };

  /** Scroll so that characters [start, end) sit near the middle of the window. */
  mh.revealText = (el, start, end) => {
    el.scrollIntoView({ block: 'center', inline: 'nearest' }); // also scrolls inner scroll boxes
    const rects = mh.textRects(el, start, end);
    if (!rects.length) return;
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    // Only nudge the window if the text is not comfortably on screen (leave room above for the toolbar).
    if (top < 120 || bottom > window.innerHeight - 80) window.scrollBy(0, (top + bottom) / 2 - window.innerHeight / 2);
  };

  /** What is selected right now, described via the DOM range (not affected by CSS text-transform). */
  mh.selectionInfo = () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return { collapsed: true, text: '' };
    return { collapsed: false, text: sel.getRangeAt(0).toString() };
  };

  /**
   * Fallback used when a real drag cannot produce the selection: set the
   * selection directly and fire the same `mouseup` event a real mouse would.
   */
  mh.selectByRange = (el, start, end) => {
    const range = mh.rangeFor(el, start, end);
    if (!range) return false;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const rects = mh.textRects(el, start, end);
    const last = rects[rects.length - 1] || el.getBoundingClientRect();
    const target = range.endContainer.parentElement || el;
    target.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: last.right, clientY: last.top + last.height / 2,
    }));
    return true;
  };

  /** The nearest ancestor that scrolls on its own (an inner scroll box), or null. */
  mh.scrollBox = (el) => {
    for (let n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 4) return n;
    }
    return null;
  };

  // ---------------------------------------------------------------------
  // Layout and style sampling (checks k and m): "did the host page change?"
  // ---------------------------------------------------------------------

  /**
   * Choose the host-page elements to watch and remember them.
   * @param {string[]} ownedSelectors  selectors of the extension's own elements (never sampled)
   * @param {string[]} targetSelectors the site's target elements (always sampled)
   * @param {number} max               how many other elements to sample, spread evenly through the page
   */
  mh.sampleInit = (ownedSelectors, targetSelectors, max = 80) => {
    const owned = (el) => ownedSelectors.some((s) => { try { return el.closest(s); } catch (e) { return false; } });
    const samples = [];
    const seen = new Set();
    const add = (el, label) => {
      if (!el || seen.has(el) || owned(el)) return;
      seen.add(el);
      samples.push({ el, label });
    };
    for (const sel of targetSelectors) {
      try { add(document.querySelector(sel), `target ${sel}`); } catch (e) { /* bad selector: ignored here, reported elsewhere */ }
    }
    add(document.body, 'body');
    // Candidate blocks: anything that normally holds or frames text.
    const candidates = Array.from(document.body.querySelectorAll(
      'p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,pre,figure,figcaption,img,svg,table,section,article,aside,header,footer,nav,main,form,button,input,textarea,a,span,div'
    )).filter((el) => {
      if (owned(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const step = Math.max(1, candidates.length / max);
    for (let i = 0; i < candidates.length && samples.length < max + targetSelectors.length + 1; i += step) {
      const el = candidates[Math.floor(i)];
      add(el, `${mh.label(el)} [${Math.floor(i)}]`);
    }
    // A sample of text nodes too: their first line box is the most sensitive "did the text move" probe.
    const texts = mh.textNodes(document.body).filter((n) => n.data.trim().length > 3 && n.parentElement && !owned(n.parentElement));
    const tstep = Math.max(1, texts.length / 40);
    const textSamples = [];
    for (let i = 0; i < texts.length && textSamples.length < 40; i += tstep) {
      const node = texts[Math.floor(i)];
      textSamples.push({ node, label: `text "${node.data.trim().slice(0, 24)}" in ${mh.label(node.parentElement)}` });
    }
    // Remember where every scrollable box is scrolled to, so each snapshot is taken in the same scroll state.
    const scrollers = Array.from(document.body.querySelectorAll('*')).filter((el) => {
      if (owned(el)) return false;
      const cs = getComputedStyle(el);
      return /(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (el.scrollHeight > el.clientHeight + 4 || el.scrollWidth > el.clientWidth + 4);
    }).slice(0, 30).map((el) => ({ el, top: 0, left: 0 }));
    mh._samples = samples;
    mh._textSamples = textSamples;
    mh._scrollers = scrollers;
    return { elements: samples.length, textNodes: textSamples.length, scrollBoxes: scrollers.length };
  };

  /** Put the window and every inner scroll box back to the top-left, so snapshots are comparable. */
  mh.resetScroll = () => {
    for (const s of mh._scrollers || []) { s.el.scrollTop = s.top; s.el.scrollLeft = s.left; }
    window.scrollTo(0, 0);
  };

  /** Positions and sizes of the watched elements, plus the document's overall size. */
  mh.layoutSnapshot = () => {
    const de = document.documentElement;
    const items = {};
    // "Anchored" = stuck to the window (position fixed/sticky somewhere above it), so its place
    // on the page depends on how far the window is scrolled.
    const anchored = (el) => {
      for (let n = el; n && n.nodeType === Node.ELEMENT_NODE; n = n.parentElement) {
        const p = getComputedStyle(n).position;
        if (p === 'fixed' || p === 'sticky') return true;
      }
      return false;
    };
    // Positions are stored in page coordinates (viewport position + window scroll).
    const pageRect = (r, el) => ({
      left: r.left + window.scrollX, top: r.top + window.scrollY, width: r.width, height: r.height, anchored: anchored(el),
    });
    for (const s of mh._samples || []) {
      items[s.label] = s.el.isConnected ? pageRect(s.el.getBoundingClientRect(), s.el) : null;
    }
    for (const s of mh._textSamples || []) {
      if (!s.node.isConnected || !s.node.parentElement) { items[s.label] = null; continue; }
      const r = document.createRange();
      r.selectNodeContents(s.node);
      const first = r.getClientRects()[0];
      items[s.label] = first ? pageRect(first, s.node.parentElement) : null;
    }
    return {
      doc: { scrollWidth: de.scrollWidth, scrollHeight: de.scrollHeight, clientWidth: de.clientWidth, clientHeight: de.clientHeight },
      scroll: { x: window.scrollX, y: window.scrollY },
      items,
    };
  };

  /** Computed CSS of the watched elements for the given property names. */
  mh.styleSnapshot = (props) => {
    const out = {};
    for (const s of mh._samples || []) {
      if (!s.el.isConnected) { out[s.label] = null; continue; }
      const cs = getComputedStyle(s.el);
      const o = {};
      for (const p of props) o[p] = cs.getPropertyValue(p);
      out[s.label] = o;
    }
    return out;
  };

  // ---------------------------------------------------------------------
  // Colour information (check l): "can you still read highlighted text?"
  // ---------------------------------------------------------------------

  /**
   * The colours involved in drawing characters [start, end): the text colour
   * and every background colour stacked behind it, innermost first.
   */
  mh.colourInfo = (el, start, end) => {
    const range = mh.rangeFor(el, start, end);
    if (!range) return null;
    const holder = range.startContainer.parentElement || el;
    const cs = getComputedStyle(holder);
    const backgrounds = [];
    const caveats = [];
    for (let n = holder; n && n.nodeType === Node.ELEMENT_NODE; n = mh.composedParent(n)) {
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const s = getComputedStyle(n);
      backgrounds.push(s.backgroundColor);
      if (s.backgroundImage && s.backgroundImage !== 'none') caveats.push(`background image/gradient on <${mh.label(n)}>`);
      if (parseFloat(s.opacity) < 1) caveats.push(`opacity ${s.opacity} on <${mh.label(n)}>`);
      if (s.filter && s.filter !== 'none') caveats.push(`filter on <${mh.label(n)}>`);
    }
    const fill = cs.webkitTextFillColor;
    if (fill && fill !== cs.color) caveats.push(`text is painted with -webkit-text-fill-color ${fill}, not its colour`);
    // Where the text lives, for the cases the extension leaves alone by design.
    return { color: cs.color, textFill: fill, fontSize: cs.fontSize, fontWeight: cs.fontWeight, backgrounds, caveats, holder: mh.label(holder) };
  };

  /** A CSS selector that matches exactly this element (document tree only). */
  mh.cssPath = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.id && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) { parts.unshift('#' + CSS.escape(n.id)); return parts.join(' > '); }
      let i = 1;
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
      parts.unshift(`${n.tagName.toLowerCase()}:nth-of-type(${i})`);
    }
    return 'html > ' + parts.join(' > ');
  };

  /**
   * Up to `max` elements spread over the page whose own text a person could select
   * (visible, at least 25 characters, not a link, button, form field or editable area).
   */
  mh.textCandidates = (max) => {
    const out = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (mh.isOwned(el) || el.closest(mh.owned.join(',') || 'x-none')) continue;
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA|INPUT|SELECT|OPTION|IFRAME)$/.test(el.tagName)) continue;
      if (el.isContentEditable || el.closest('a[href], button, label, summary, [role="button"]')) continue;
      const own = Array.from(el.childNodes).filter((c) => c.nodeType === 3).map((c) => c.data).join('').trim();
      if (own.length < 25) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width < 60 || r.height < 8 || cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
      out.push({ path: mh.cssPath(el), label: mh.label(el) });
    }
    if (out.length <= max) return out;
    const step = out.length / max;
    return Array.from({ length: max }, (_, i) => out[Math.floor(i * step)]);
  };

  /**
   * Is this element's text somewhere the extension deliberately does not work?
   * Returns a short reason, or null.
   */
  mh.designExclusion = (el) => {
    const first = mh.textNodes(el)[0];
    if (first && first.getRootNode() instanceof ShadowRoot) return 'the text is inside a web component (shadow DOM)';
    if (el.isContentEditable) return 'the text is in an editable region (contenteditable)';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return 'the text is in a form field';
    if (window.top !== window) return 'the text is inside an iframe';
    return null;
  };

  window.__mh = mh;
}

module.exports = { installPageHelpers };

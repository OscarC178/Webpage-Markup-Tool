/**
 * lib/anchor.js
 * Remembers WHERE a markup is by its words, not by page structure.
 *
 * The old code stored an XPath (a route through the page's element tree) plus
 * character offsets. Any advert, cookie banner or redesign changed the tree
 * and the markup either vanished or landed on the wrong words.
 *
 * Now each markup stores (after the W3C Web Annotation selector model,
 * https://www.w3.org/TR/annotation-model/#selectors):
 *   quote: { exact, prefix, suffix }  the words, plus ~32 characters either side
 *   pos:   { start, end }             character position in the page's text (a hint)
 *   xpath: {...}                      legacy selector from version 1 data, if any
 *
 * Finding it again tries, in order: the position (only if the words there
 * still match), a search for the words (picking the occurrence whose
 * surroundings match best), a search ignoring whitespace differences, then
 * the legacy XPath (only if the words there match). If all fail the markup is
 * an "orphan": kept in storage, reported to the user, never drawn in the
 * wrong place.
 *
 * `locate` and friends are pure (text in, numbers out) and unit-tested in
 * Node. The DOM half (`buildIndex`, `describeRange`, `resolve`) runs in the page.
 */
(function (root) {
  'use strict';

  const WMT = (root.WMT = root.WMT || {});
  const CONTEXT = 32; // characters of prefix/suffix kept either side of a quote

  // ---------------------------------------------------------------- pure part

  /** Number of matching characters at the END of a and b. */
  function commonSuffixLen(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
  }

  /** Number of matching characters at the START of a and b. */
  function commonPrefixLen(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  }

  /** Every index at which `needle` occurs in `text` (capped for safety). */
  function allIndexesOf(text, needle, cap = 500) {
    const out = [];
    if (!needle) return out;
    let i = text.indexOf(needle);
    while (i !== -1 && out.length < cap) {
      out.push(i);
      i = text.indexOf(needle, i + 1);
    }
    return out;
  }

  /**
   * Collapse every run of whitespace to one space.
   * Returns the new string and, for each character in it, the index of the
   * character it came from in the original (so results can be mapped back).
   */
  function normaliseWhitespace(text) {
    let out = '';
    const map = [];
    let inSpace = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (/\s/.test(ch)) {
        if (!inSpace) { out += ' '; map.push(i); inSpace = true; }
      } else {
        out += ch; map.push(i); inSpace = false;
      }
    }
    return { text: out, map };
  }

  /** Choose the occurrence whose surroundings best match the saved context. */
  function bestOccurrence(text, indexes, len, quote, posHint) {
    let best = -1;
    let bestScore = -Infinity;
    for (const i of indexes) {
      const before = text.slice(Math.max(0, i - CONTEXT), i);
      const after = text.slice(i + len, i + len + CONTEXT);
      let score = commonSuffixLen(before, quote.prefix || '') + commonPrefixLen(after, quote.suffix || '');
      // Nearness to where it used to be breaks ties (worth less than one context character).
      if (posHint) score -= Math.min(Math.abs(i - posHint.start) / (text.length + 1), 0.99);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  /**
   * Find a saved anchor in a page's text.
   * @returns {{start:number, end:number, method:string}|null}
   */
  function locate(text, anchor) {
    if (!anchor) return null;
    const quote = anchor.quote;
    const pos = anchor.pos;
    const exact = quote && quote.exact;

    // 1. Same position, and the words there still match.
    if (pos && exact && text.slice(pos.start, pos.end) === exact) {
      return { start: pos.start, end: pos.end, method: 'position' };
    }
    if (!exact) return null;

    // 2. Search for the exact words.
    const hits = allIndexesOf(text, exact);
    if (hits.length) {
      const i = hits.length === 1 ? hits[0] : bestOccurrence(text, hits, exact.length, quote, pos);
      return { start: i, end: i + exact.length, method: 'quote' };
    }

    // 3. Search again ignoring whitespace differences (line breaks, double spaces).
    const normText = normaliseWhitespace(text);
    const normExact = normaliseWhitespace(exact).text.trim();
    if (normExact.length >= 3) {
      const nHits = allIndexesOf(normText.text, normExact);
      if (nHits.length) {
        const normQuote = {
          prefix: normaliseWhitespace(quote.prefix || '').text,
          suffix: normaliseWhitespace(quote.suffix || '').text,
        };
        const ni = nHits.length === 1 ? nHits[0]
          : bestOccurrence(normText.text, nHits, normExact.length, normQuote, null);
        const start = normText.map[ni];
        const end = normText.map[ni + normExact.length - 1] + 1;
        return { start, end, method: 'fuzzy' };
      }
    }
    return null;
  }

  /** Build the quote+position description for a span of the page text. */
  function describeSpan(text, start, end) {
    return {
      quote: {
        exact: text.slice(start, end),
        prefix: text.slice(Math.max(0, start - CONTEXT), start),
        suffix: text.slice(end, end + CONTEXT),
      },
      pos: { start, end },
    };
  }

  // ----------------------------------------------------------------- DOM part

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'TITLE']);

  /**
   * Read all the text of the page into one string, remembering which text
   * node each stretch came from. Build once per redraw, reuse for all markups.
   * `isOurs(element)` lets the caller exclude the extension's own UI.
   */
  function buildIndex(rootNode, isOurs) {
    const doc = rootNode.ownerDocument || rootNode;
    const nodes = [];
    const starts = [];
    const parts = [];
    let total = 0;
    const walker = doc.createTreeWalker(rootNode, 4 /* NodeFilter.SHOW_TEXT */, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName)) return 2; // FILTER_REJECT
        if (isOurs && isOurs(parent)) return 2;
        return 1; // FILTER_ACCEPT
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      nodes.push(n);
      starts.push(total);
      parts.push(n.data);
      total += n.data.length;
    }
    return { text: parts.join(''), nodes, starts, nodeIndex: new Map(nodes.map((x, i) => [x, i])) };
  }

  /** Convert a DOM boundary (container + offset) into a position in the page text. */
  function boundaryToPos(index, container, offset) {
    const i = index.nodeIndex.get(container);
    if (i !== undefined) return index.starts[i] + Math.min(offset, container.data.length);

    // Boundary sits on an element (or a skipped text node): find the first
    // indexed text node at or after it.
    const doc = container.ownerDocument;
    const probe = doc.createRange();
    try {
      probe.setStart(container, offset);
      probe.collapse(true);
    } catch (e) {
      return null;
    }
    // Binary search: nodes are in document order.
    let lo = 0;
    let hi = index.nodes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      let cmp;
      try { cmp = probe.comparePoint(index.nodes[mid], 0); } catch (e) { cmp = -1; }
      if (cmp >= 0) hi = mid; else lo = mid + 1;
    }
    return lo < index.nodes.length ? index.starts[lo] : index.text.length;
  }

  /** Index of the text node containing page-text position `pos`. */
  function nodeAt(index, pos, preferEnd) {
    let lo = 0;
    let hi = index.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (index.starts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    // An END position that falls exactly on a node boundary belongs to the node before.
    if (preferEnd && lo > 0 && index.starts[lo] === pos) lo--;
    return lo;
  }

  /** Convert a span of page text back into a DOM Range. */
  function spanToRange(index, start, end) {
    if (!index.nodes.length || end <= start) return null;
    const si = nodeAt(index, start, false);
    const ei = nodeAt(index, end, true);
    const doc = index.nodes[0].ownerDocument;
    const range = doc.createRange();
    try {
      range.setStart(index.nodes[si], start - index.starts[si]);
      range.setEnd(index.nodes[ei], end - index.starts[ei]);
    } catch (e) {
      return null;
    }
    return range;
  }

  /** Describe a user's selection so it can be found again later. */
  function describeRange(index, range) {
    const start = boundaryToPos(index, range.startContainer, range.startOffset);
    const end = boundaryToPos(index, range.endContainer, range.endOffset);
    if (start === null || end === null || end <= start) return null;
    return describeSpan(index.text, start, end);
  }

  /** Resolve a version 1 XPath selector, accepting it only if the words match. */
  function resolveLegacyXpath(index, anchor) {
    const x = anchor.xpath;
    if (!x || !x.startContainerPath) return null;
    const doc = index.nodes.length ? index.nodes[0].ownerDocument : null;
    if (!doc) return null;
    try {
      const get = (p) => doc.evaluate(p, doc, null, 9 /* FIRST_ORDERED_NODE_TYPE */, null).singleNodeValue;
      const s = get(x.startContainerPath);
      const e = get(x.endContainerPath);
      if (!s || !e) return null;
      const start = boundaryToPos(index, s, x.startOffset);
      const end = boundaryToPos(index, e, x.endOffset);
      if (start === null || end === null || end <= start) return null;
      const exact = anchor.quote && anchor.quote.exact;
      // Old notes have no saved words to check against, so the XPath is trusted for them.
      if (exact && index.text.slice(start, end) !== exact) return null;
      return { start, end, method: 'xpath' };
    } catch (err) {
      return null;
    }
  }

  /**
   * Find a saved anchor on the live page.
   * @returns {{range: Range, method: string, anchor: object}|null}
   *   `anchor` is a refreshed description to save back when the method was not
   *   'position' (this is how old or drifted data repairs itself).
   */
  function resolve(index, anchor) {
    const hit = locate(index.text, anchor) || resolveLegacyXpath(index, anchor);
    if (!hit) return null;
    const range = spanToRange(index, hit.start, hit.end);
    if (!range) return null;
    const fresh = describeSpan(index.text, hit.start, hit.end);
    return { range, method: hit.method, anchor: { ...fresh, xpath: null } };
  }

  WMT.anchor = {
    CONTEXT, locate, describeSpan, normaliseWhitespace,
    buildIndex, describeRange, resolve, spanToRange, boundaryToPos,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = WMT.anchor;
})(typeof globalThis !== 'undefined' ? globalThis : this);

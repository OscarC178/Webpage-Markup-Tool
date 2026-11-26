/**
 * viewer/host.js  (PDF viewer)
 *
 * The bridge between the extension's normal marking code (content.js, which
 * only has a few hooks marked "// PDF:") and the pdf.js viewer page.
 *
 * content.js looks for globalThis.WMT.host. When it is set, content.js:
 *   - stores marks under host.pageUrl() (the PDF's key, see viewer.js), not
 *     under this page's chrome-extension:// address;
 *   - asks host.describe(range) to describe a new mark, and host.resolve(mark)
 *     to find a saved one, instead of indexing the whole page itself;
 *   - asks host.isPending(mark) before calling a mark "not found", because
 *     pdf.js only builds the text of pages near the screen;
 *   - asks host.blocksFor() where margin notes may go (beside the PDF page);
 *   - prints through host.print() and labels the notes list with host.sourceLabel().
 *
 * WHY THE HOST DESCRIBES MARKS ITSELF (line ends)
 * pdf.js puts each line of a PDF in its own <span> and separates lines with
 * <br>. The browser's Range.toString(), and lib/anchor.js's page text, ignore
 * <br>, so a quote across a line break came out as "watervoles". Here each
 * PDF page gets a second, "clean" text in which
 *   - a line end becomes one space (unless the line already ends in a space);
 *   - a hyphen at a line end between two letters, followed by a lower-case
 *     letter, is dropped and the two halves joined ("re-|introduced" ->
 *     "reintroduced"), the same rule pdf.js's own search uses;
 *   - soft hyphens (U+00AD) are dropped.
 * Quotes are saved and searched in the clean text; a map turns clean
 * positions back into the real text nodes, so the painted range is exact.
 * The page itself is not changed. Web pages are not affected: this file
 * only loads in the viewer.
 *
 * This is a classic script (not a module) so it runs before content.js.
 * viewer.js (a module, runs later) fills in the parts that need pdf.js.
 */
(function () {
  'use strict';

  const WMT = (globalThis.WMT = globalThis.WMT || {});
  const params = new URLSearchParams(location.search);

  // ------------------------------------------------------------ clean text

  const LETTER = /\p{L}/u;
  const LOWER = /\p{Ll}/u;
  const HYPHENS = new Set(['-', '‐']); // hyphen-minus, hyphen
  const SOFT_HYPHEN = '­';

  /** Skip our own print note markers (content.js adds them while printing). */
  const isOurs = (el) => el.hasAttribute('data-wmt-marker');

  /**
   * Text index of a list of text-layer elements (one per PDF page, in order).
   * Returns
   *   raw:   the same shape as lib/anchor.js buildIndex() (text nodes, offsets);
   *   text:  the clean text (see the header);
   *   startOf[rawPos] / endOf[rawPos]: clean position of a raw boundary used
   *          as the start / the end of a span;
   *   rawOf[cleanPos]: raw position of each clean character (an added space
   *          maps to the raw boundary where the line broke).
   */
  function buildClean(layers) {
    const nodes = [];
    const starts = [];
    const breaks = new Set(); // raw positions where a line (or a page) ends
    let rawText = '';
    for (const layer of layers) {
      if (rawText) breaks.add(rawText.length); // a page break counts as a line break
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
        acceptNode(n) {
          if (n.nodeType === 1) return isOurs(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
          return n.parentElement && !isOurs(n.parentElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.nodeType === 1) { if (n.tagName === 'BR') breaks.add(rawText.length); continue; }
        nodes.push(n);
        starts.push(rawText.length);
        rawText += n.data;
      }
    }

    const len = rawText.length;
    const startOf = new Int32Array(len + 1);
    const endOf = new Int32Array(len + 1);
    const rawOf = [];
    let clean = '';
    for (let p = 0; p <= len; p++) {
      if (breaks.has(p) && clean) {
        const last = clean[clean.length - 1];
        const next = rawText[p] || '';
        if (HYPHENS.has(last) && LETTER.test(clean[clean.length - 2] || '') && LOWER.test(next)) {
          clean = clean.slice(0, -1); // "re-" + "introduced" -> "reintroduced"
          rawOf.pop();
          endOf[p] = clean.length;
        } else if (!/\s/.test(last) && next && !/\s/.test(next)) {
          endOf[p] = clean.length;
          clean += ' ';
          rawOf.push(p);
        } else {
          endOf[p] = clean.length;
        }
      } else {
        endOf[p] = clean.length;
      }
      startOf[p] = clean.length;
      if (p === len) break;
      const ch = rawText[p];
      if (ch === SOFT_HYPHEN) continue;
      clean += ch;
      rawOf.push(p);
    }
    const raw = { text: rawText, nodes, starts, nodeIndex: new Map(nodes.map((x, i) => [x, i])) };
    return { raw, text: clean, rawOf, startOf, endOf };
  }

  /** Clean span -> DOM Range on the real text nodes. */
  function cleanToRange(idx, start, end) {
    if (end <= start) return null;
    const rawStart = start < idx.rawOf.length ? idx.rawOf[start] : idx.raw.text.length;
    const lastRaw = idx.rawOf[end - 1];
    // The end is just after the last real character; an added space has no
    // character of its own, so a span ending on one ends at its line break.
    const rawEnd = isAdded(idx, end - 1) ? lastRaw : lastRaw + 1;
    return WMT.anchor.spanToRange(idx.raw, rawStart, Math.max(rawEnd, rawStart + 1));
  }

  /**
   * Is clean character i a space this file added at a line end (not in the PDF)?
   * Every real character equals the raw character it maps to; an added space
   * maps to the first character of the next line, which is never a space.
   */
  function isAdded(idx, i) {
    return idx.raw.text[idx.rawOf[i]] !== idx.text[i];
  }

  // ------------------------------------------------- pages and their text

  /** Root holding the pages marks are looked for in: the screen viewer, or the print copy while printing. */
  function pagesRoot() {
    return host.printing ? document.getElementById('wmtPrint') : document.getElementById('viewer');
  }

  /** Text layer of page n, or null while pdf.js has not built (or has thrown away) its text. */
  function layerOf(n) {
    const root = pagesRoot();
    if (!root) return null;
    const layer = root.querySelector(`[data-page-number="${n}"] .textLayer`);
    if (!layer) return null;
    // Screen pages: pdf.js adds .endOfContent once a page's text is complete.
    // Print pages: viewer.js sets data-wmt-ready.
    return layer.querySelector('.endOfContent') || layer.dataset.wmtReady ? layer : null;
  }

  let cache = new Map(); // "from-to" -> clean index, cleared when the pages change
  function indexFor(from, to) {
    const key = `${host.printing ? 'p' : 's'}${from}-${to}`;
    if (!cache.has(key)) {
      const layers = [];
      for (let n = from; n <= to; n++) layers.push(layerOf(n));
      if (layers.some((l) => !l)) return null;
      cache.set(key, buildClean(layers));
    }
    return cache.get(key);
  }

  function pageOf(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    const page = el && el.closest('[data-page-number]');
    return page ? Number(page.dataset.pageNumber) : 0;
  }

  // ------------------------------------------------------------------ host

  const host = {
    /** Address of the PDF as given in ?file=, or null when a file was picked from disk. */
    fileUrl: params.get('file'),
    /** File name when a file was picked from disk. */
    fileName: null,
    /** Storage key: urn:x-wmt-pdf:<id>, set by viewer.js once the document is read. */
    keyUrl: null,
    /** True once pdf.js has laid out every page (so page numbers are known). */
    loaded: false,
    /** True while the print copy (#wmtPrint) stands in for the screen pages. */
    printing: false,

    pageUrl() {
      return host.keyUrl || 'urn:x-wmt-pdf:none';
    },

    /** The PDF's own address, for the Markdown "Source" line and the print notes list. */
    sourceUrl() {
      return host.fileUrl || (host.fileName ? `local file: ${host.fileName}` : '');
    },
    sourceLabel() {
      const u = host.fileUrl;
      if (!u) return host.fileName || 'PDF';
      try { const x = new URL(u); return x.protocol === 'file:' ? decodeURIComponent(x.pathname) : x.host + x.pathname; } catch (e) { return u; }
    },

    /**
     * Describe a selection for saving: its words in the clean text of its PDF
     * page(s), plus the page numbers. Returns { anchor, range } or null.
     */
    describe(range) {
      const from = pageOf(range.startContainer);
      const to = pageOf(range.endContainer) || from;
      if (!from || to < from) return null;
      const idx = indexFor(from, to);
      if (!idx) return null;
      const rs = WMT.anchor.boundaryToPos(idx.raw, range.startContainer, range.startOffset);
      const re = WMT.anchor.boundaryToPos(idx.raw, range.endContainer, range.endOffset);
      if (rs === null || re === null || re <= rs) return null;
      let start = idx.startOf[rs];
      let end = idx.endOf[re];
      // Never start or end on a space we added at a line end.
      while (start < end && isAdded(idx, start)) start++;
      while (end > start && isAdded(idx, end - 1)) end--;
      if (end <= start) return null;
      const anchor = { ...WMT.anchor.describeSpan(idx.text, start, end), pdfPage: from };
      if (to !== from) anchor.pdfPageEnd = to;
      return { anchor, range: cleanToRange(idx, start, end) || range };
    },

    /**
     * Find a saved mark on its own page(s). Returns null while those pages have
     * no text yet (content.js then treats the mark as waiting, see isPending).
     * The returned anchor is in clean-text terms, so marks saved by the earlier
     * prototype (raw text, "watervoles") repair themselves when found.
     */
    resolve(markup) {
      const a = markup.anchor || {};
      let from = a.pdfPage;
      let to = a.pdfPageEnd || from;
      if (!from) { // no page hint (e.g. imported): search every page whose text exists
        const pages = Array.from(pagesRoot().querySelectorAll('[data-page-number]')).map((p) => Number(p.dataset.pageNumber));
        for (const n of pages) {
          const hit = layerOf(n) && host.resolve({ anchor: { ...a, pdfPage: n } });
          if (hit) return hit;
        }
        return null;
      }
      const idx = indexFor(from, to);
      if (!idx) return null;
      let hit = WMT.anchor.locate(idx.text, a);
      if (!hit) {
        // Older data saved in raw text: look there, then re-describe in clean terms.
        const old = WMT.anchor.locate(idx.raw.text, a);
        if (old) hit = { start: idx.startOf[old.start], end: idx.endOf[old.end], method: 'raw' };
      }
      if (!hit) return null;
      const range = cleanToRange(idx, hit.start, hit.end);
      if (!range) return null;
      const anchor = { ...WMT.anchor.describeSpan(idx.text, hit.start, hit.end), xpath: null, pdfPage: from };
      if (to !== from) anchor.pdfPageEnd = to;
      return { range, method: hit.method, anchor };
    },

    /** True while pdf.js has not yet built the text of the page(s) the mark is on. */
    isPending(markup) {
      if (!host.loaded) return true;
      const a = (markup && markup.anchor) || {};
      if (!a.pdfPage) {
        // No page hint: pending until every page's text exists.
        const root = pagesRoot();
        const all = root.querySelectorAll('[data-page-number]').length;
        let ready = 0;
        for (let n = 1; n <= all; n++) if (layerOf(n)) ready++;
        return ready < all;
      }
      for (let n = a.pdfPage; n <= (a.pdfPageEnd || a.pdfPage); n++) if (!layerOf(n)) return true;
      return false;
    },

    /** Margin notes go beside the PDF page that holds the passage. */
    blocksFor(res) {
      const el = res.range.startContainer.nodeType === 1 ? res.range.startContainer : res.range.startContainer.parentElement;
      const page = el && el.closest('[data-page-number]');
      return page ? [page] : [];
    },

    /** Replaced by viewer.js: build the print copy, then open the print dialogue. */
    print() { window.print(); },

    /** Forget cached page text (viewer.js calls it when it swaps pages in or out). */
    forget() { cache = new Map(); },
  };

  // Any change to the pages (pdf.js building or dropping a page) makes cached text stale.
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(host.forget)
      .observe(document.body, { childList: true, subtree: true, characterData: true });
  });

  // Exposed for the evidence script's checks of the line-end rules.
  host._buildClean = buildClean;
  host._cleanToRange = cleanToRange;

  WMT.host = host;
})();

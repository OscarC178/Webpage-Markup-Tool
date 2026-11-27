/**
 * lib/url.js
 * Turns a page address into a stable storage key.
 *
 * Why: the old code used the raw address as the key, so clicking an in-page
 * link (#section) or arriving with tracking parameters (?utm_source=...) made
 * every saved markup "disappear" because the key no longer matched.
 *
 * Loaded three ways: as a content script, via importScripts in the service
 * worker, and via require() in Node for unit tests. No build step.
 */
(function (root) {
  'use strict';

  const WMT = (root.WMT = root.WMT || {});

  // Query parameters that only exist for tracking and never change the page.
  const TRACKING_EXACT = new Set([
    'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid',
    'mc_cid', 'mc_eid', 'igshid', 'yclid', '_ga', '_gl', 'ref_src',
  ]);
  const TRACKING_PREFIXES = ['utm_'];

  function isTrackingParam(name) {
    const lower = name.toLowerCase();
    return TRACKING_EXACT.has(lower) || TRACKING_PREFIXES.some((p) => lower.startsWith(p));
  }

  /**
   * Normalise an address.
   * - Drops the #fragment, unless it looks like a hash router (#/ or #!),
   *   where the fragment IS the page.
   * - Drops tracking parameters; keeps every other parameter in its order.
   * - Leaves trailing slashes alone (some servers treat them differently).
   * Returns the input unchanged if it cannot be parsed.
   */
  function normaliseUrl(href) {
    let u;
    try {
      u = new URL(href);
    } catch (e) {
      return String(href);
    }
    if (!(u.hash.startsWith('#/') || u.hash.startsWith('#!'))) {
      u.hash = '';
    }
    if (u.search) {
      const kept = [];
      // Work on the raw string so that encoding and order are preserved.
      for (const part of u.search.slice(1).split('&')) {
        if (!part) continue;
        let name = part.split('=')[0];
        try { name = decodeURIComponent(name); } catch (e) { /* keep raw name */ }
        if (!isTrackingParam(name)) kept.push(part);
      }
      u.search = kept.length ? '?' + kept.join('&') : '';
    }
    return u.toString();
  }

  const PAGE_PREFIX = 'page:';

  /** Storage key for a page record. */
  function pageKey(href) {
    return PAGE_PREFIX + normaliseUrl(href);
  }

  /** True for addresses the extension can mark up at all. */
  function isSupportedUrl(href) {
    // PDF: also accept the keys of PDFs shown in the extension's viewer
    // ("urn:x-wmt-pdf:<id>", see viewer/viewer.js) and file:// PDF addresses.
    return /^(https?:\/\/|file:\/\/\/|urn:x-wmt-pdf:)/i.test(String(href || ''));
  }

  /** Best guess that an address points at a PDF file (by its path). */
  function looksLikePdf(href) {
    try {
      return /\.pdf$/i.test(new URL(href).pathname);
    } catch (e) {
      return false;
    }
  }

  /**
   * PDF: can this browser run the bundled pdf.js (6.5)? It uses recent
   * JavaScript without fallbacks: Map.getOrInsertComputed (Chrome 145) and
   * Math.sumPrecise (Chrome 147, per MDN browser-compat-data). On an older Chrome the
   * extension still works on web pages; PDFs simply stay in Chrome's viewer.
   */
  function pdfViewerSupported() {
    return typeof Map.prototype.getOrInsertComputed === 'function' &&
      typeof Math.sumPrecise === 'function' &&
      typeof Promise.try === 'function' &&
      typeof Promise.withResolvers === 'function';
  }

  WMT.url = { normaliseUrl, pageKey, isSupportedUrl, looksLikePdf, pdfViewerSupported, PAGE_PREFIX };

  if (typeof module !== 'undefined' && module.exports) module.exports = WMT.url;
})(typeof globalThis !== 'undefined' ? globalThis : this);

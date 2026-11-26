/**
 * lib/review.js
 * Decides when the popup asks for a Chrome Web Store review.
 *
 * The rule: ask on the 2nd and 5th time the popup is opened, then on every
 * 5th open after that (10th, 15th, ...), until the person has either gone to
 * the review page (status 'done') or said "Don't ask again" (status 'never').
 *
 * An extension cannot tell whether a review was really posted, so "done"
 * means "clicked a star and was sent to the review page".
 *
 * Loaded two ways: as a plain <script> in popup.html, and via require() in
 * Node for unit tests. No build step. No network requests, no tracking.
 */
(function (root) {
  'use strict';

  const WMT = (root.WMT = root.WMT || {});

  // chrome.storage.local keys. Neither starts with "page:" or "http", so the
  // background worker's page records and version 1 migration never touch them.
  const OPENS_KEY = 'wmt:popupOpens';
  const STATUS_KEY = 'wmt:reviewStatus';

  const STATUS = { PENDING: 'pending', DONE: 'done', NEVER: 'never' };

  // Every star goes to the same page, whatever rating is clicked.
  const REVIEW_URL = 'https://chromewebstore.google.com/detail/lpoedmhdgkmngpgiodimgefgcglgcbpk/reviews';

  /** Anything other than a known status (missing, corrupted) counts as 'pending'. */
  function normaliseStatus(status) {
    return status === STATUS.DONE || status === STATUS.NEVER ? status : STATUS.PENDING;
  }

  /**
   * True when the popup should show the review prompt on this open.
   * @param {number} opens   how many times the popup has been opened, counting this one
   * @param {string} status  'pending' | 'done' | 'never'
   */
  function shouldAsk(opens, status) {
    if (normaliseStatus(status) !== STATUS.PENDING) return false;
    if (!Number.isInteger(opens) || opens < 2) return false;
    return opens === 2 || opens % 5 === 0; // 2, 5, 10, 15, ...
  }

  /** The stored open count as a whole number (0 when missing or corrupted). */
  function normaliseOpens(value) {
    return Number.isInteger(value) && value > 0 ? value : 0;
  }

  WMT.review = { shouldAsk, normaliseStatus, normaliseOpens, OPENS_KEY, STATUS_KEY, STATUS, REVIEW_URL };

  if (typeof module !== 'undefined' && module.exports) module.exports = WMT.review;
})(typeof globalThis !== 'undefined' ? globalThis : this);

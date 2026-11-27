/**
 * lib/migrate.js
 * Converts saved data from the version 1 shape to version 2.
 *
 * Version 1 (extension 1.1 and earlier):
 *   { "<raw page address>": { markups: [ {id, type, text, position, color}, ... ] } }
 *   where a highlight/underline `position` is an XPath selector and a note has
 *   `position: {top, left}` in pixels plus `selection` (an XPath selector).
 *
 * Version 2:
 *   { "meta": { schemaVersion: 2, migratedAt },
 *     "page:<normalised address>": { v: 2, url, updatedAt, markups: [ {
 *        id, kind: 'highlight' | 'underline', colour: 'yellow' | ..., note: '',
 *        createdAt, updatedAt, anchor: { quote, pos, xpath } } ] } }
 *
 * In version 2 a note is text attached to a markup, not a free-floating box,
 * so an old sticky note becomes a yellow highlight (on the text it was
 * created from) carrying the note text.
 *
 * Safety rules:
 * - Pure function: it only RETURNS what to write. The caller does the writing.
 * - Old keys are never deleted, so existing users can always be recovered.
 * - Safe to run twice (markups are de-duplicated by id).
 *
 * Depends on lib/url.js and lib/palette.js being loaded first.
 */
(function (root) {
  'use strict';

  const WMT = (root.WMT = root.WMT || {});
  const inNode = typeof module !== 'undefined' && module.exports;
  const urlLib = inNode ? require('./url.js') : WMT.url;
  const palette = inNode ? require('./palette.js') : WMT.palette;

  const SCHEMA_VERSION = 2;
  const MAX_QUOTE = 20000; // cap on stored quote length, in characters
  const MAX_NOTE = 20000;  // cap on stored note length, in characters

  /** Convert one version 1 markup. Returns null if it is unusable. */
  function migrateMarkup(old, now) {
    if (!old || typeof old !== 'object' || !old.id || !old.type) return null;

    if (old.type === 'highlight' || old.type === 'underline') {
      return {
        id: String(old.id),
        kind: old.type,
        // Version 1 defaults were yellow highlights and red underlines.
        colour: palette.nearestColour(old.color, old.type === 'highlight' ? 'yellow' : 'pink'),
        note: '',
        createdAt: now,
        updatedAt: now,
        anchor: {
          // prefix/suffix/pos are filled in the first time the markup is found on the page.
          quote: { exact: String(old.text || '').slice(0, MAX_QUOTE), prefix: '', suffix: '' },
          pos: null,
          xpath: old.position || null,
        },
      };
    }

    if (old.type === 'note') {
      return {
        id: String(old.id),
        kind: 'highlight',
        colour: 'yellow',
        note: String(old.text || '').slice(0, MAX_NOTE),
        createdAt: now,
        updatedAt: now,
        anchor: {
          // Old notes never stored the words they were attached to, only an XPath.
          // If the XPath no longer resolves, the note is listed as "text not found"
          // with its text intact; it is never thrown away.
          quote: null,
          pos: null,
          xpath: old.selection || null,
        },
      };
    }
    return null;
  }

  /**
   * Work out the writes needed to migrate everything.
   * @param {object} all  the full contents of chrome.storage.local
   * @param {number} now  timestamp (ms)
   * @returns {{set: object, migratedPages: number, migratedMarkups: number}}
   */
  function planMigration(all, now) {
    const set = {};
    let migratedMarkups = 0;

    for (const key of Object.keys(all || {})) {
      if (!/^https?:\/\//i.test(key)) continue; // only version 1 page keys
      const record = all[key];
      if (!record || !Array.isArray(record.markups)) continue;

      const newKey = urlLib.pageKey(key);
      // Several old keys (page, page#top, page?utm_...) can merge into one new key.
      const target = set[newKey] || all[newKey] || {
        v: SCHEMA_VERSION,
        url: urlLib.normaliseUrl(key),
        updatedAt: now,
        markups: [],
      };
      const seen = new Set(target.markups.map((m) => m.id));
      const merged = target.markups.slice();

      for (const old of record.markups) {
        const m = migrateMarkup(old, now);
        if (m && !seen.has(m.id)) {
          seen.add(m.id);
          merged.push(m);
          migratedMarkups++;
        }
      }
      if (merged.length) set[newKey] = { ...target, v: SCHEMA_VERSION, updatedAt: now, markups: merged };
    }

    const migratedPages = Object.keys(set).length;
    set.meta = { ...(all && all.meta), schemaVersion: SCHEMA_VERSION, migratedAt: now };
    return { set, migratedPages, migratedMarkups };
  }

  /** True when the stored data has not been migrated yet. */
  function needsMigration(all) {
    return !(all && all.meta && all.meta.schemaVersion >= SCHEMA_VERSION);
  }

  WMT.migrate = { planMigration, needsMigration, migrateMarkup, SCHEMA_VERSION, MAX_QUOTE, MAX_NOTE };

  if (inNode) module.exports = WMT.migrate;
})(typeof globalThis !== 'undefined' ? globalThis : this);

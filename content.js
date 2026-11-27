/**
 * content.js
 * Runs on every web page. Lets the user highlight, underline and annotate
 * text, and puts saved markups back when the page is opened again.
 *
 * How it is built (version 2):
 * - Markups are painted with the CSS Custom Highlight API. Nothing is added
 *   to the page and nothing is measured, so marking up cannot move the page's
 *   text, and markups follow the text through reflow, zoom, inner scrolling
 *   and print for free.
 * - Each markup is remembered by its words (lib/anchor.js), not by page
 *   structure. If the words cannot be found again the markup is listed as
 *   "not found"; it is never drawn in the wrong place and never deleted.
 * - Every control (toolbar, note card, pins, toast) lives in one sealed
 *   shadow root in the browser's top layer, styled by ui/styles.js. The page
 *   cannot restyle it and it cannot restyle the page.
 * - This script never writes to storage. It sends messages to background.js,
 *   the single writer, and redraws from storage change events (which also
 *   keeps two tabs on the same page in step).
 *
 * Depends on: lib/url.js, lib/palette.js, lib/anchor.js, ui/styles.js.
 */
(function () {
  'use strict';

  if (window.top !== window) return;           // top page only, not iframes
  if (globalThis.__wmtContentLoaded) return;   // never run twice in one page
  globalThis.__wmtContentLoaded = true;

  const { url: urlLib, palette, anchor: anchorLib, uiCss } = globalThis.WMT;
  // PDF: inside the extension's own PDF viewer (viewer/viewer.html),
  // viewer/host.js sets WMT.host. content.js then stores marks under the PDF's
  // key (not the viewer's chrome-extension:// address), lets the host describe
  // and find marks page by page, and prints through the host. On every
  // ordinary web page WMT.host is undefined and nothing below changes.
  const host = () => globalThis.WMT.host || null;
  const pageUrl = () => (host() ? host().pageUrl() : location.href);
  const PREFIX = 'wmt-';        // every name we register with the browser starts with this
  const MAX_QUOTE = 20000;      // longest selection we will store, in characters
  const MAX_NOTE = 20000;       // longest note, in characters
  const NOTE_SAVE_DELAY = 400;  // ms after the last keystroke before a note is saved
  const TOAST_LIFE = 6000;      // ms a toast (and its Undo) stays up
  const ORPHAN_RETRY_FAST = 250; // ms between the first few attempts to find missing text (page still loading)
  const ORPHAN_RETRY_SLOW = 2000; // ms between attempts after that
  const ORPHAN_FAST_TRIES = 8;

  const state = {
    key: urlLib.pageKey(pageUrl()), // storage key of the page being shown (PDF: the host's key)
    markups: [],            // saved records for this page
    resolved: new Map(),    // markup id -> { range, text, variant, bgLum }
    repaired: new Set(),    // ids whose saved anchor was refreshed this page load
    index: null,            // cached text index of the page (lib/anchor.js); null = stale
    colour: palette.DEFAULT,// last-used colour
    printing: false,
    dead: false,            // true once the extension has been updated/removed under us
    testMode: false,        // set by the test harness through extension storage
    pendingRange: null,     // the selection the toolbar is offering to mark
    card: null,             // { el, id?, flush() } for the open card, if any
    lastOrphanTry: 0,
    orphanTries: 0,         // attempts to find missing text since the page (or address) loaded
    nextNoteIndex: 0,
    showNotes: true,        // "Show notes on the page" (popup setting, chrome.storage.sync showNotes)
    emphasis: null,         // id of the note whose passage is outlined
  };

  // Shadow-root elements, filled in by buildUi().
  const ui = { host: null, shadow: null, wrap: null, live: null, pins: null, notes: null, toolbar: null, toast: null, chip: null, tooltip: null };
  const pinEls = new Map(); // markup id -> pin button

  // ------------------------------------------------------------ small helpers

  /** Create an element: h('button', { class: 'btn', onclick: fn }, 'text', childEl) */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) if (c !== null && c !== undefined) el.append(c);
    return el;
  }

  const ICONS = {
    underline: 'M6 3v5a3 3 0 0 0 6 0V3M4.5 15h9',
    note: 'M3 4.5h12v8H8.5L5 15.5v-3H3zM9 6.5v4M7 8.5h4',
    bin: 'M3.5 5h11M7 5V3.5h4V5M5 5l.7 9.5h6.6L13 5',
    close: 'M4.5 4.5l9 9M13.5 4.5l-9 9',
  };

  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 18 18');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }

  function debounce(fn, ms) {
    let t;
    const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    wrapped.cancel = () => clearTimeout(t);
    return wrapped;
  }

  /**
   * Like debounce(), but never waits longer than maxMs after the first call
   * of a burst. Used where a page that changes all the time (a ticker, a
   * clock) would otherwise keep postponing the call for ever.
   */
  function debounceMax(fn, ms, maxMs) {
    let t;
    let first = 0; // when the current burst of calls began (0 = no burst)
    const run = () => { clearTimeout(t); first = 0; fn(); };
    return () => {
      const now = Date.now();
      if (!first) first = now;
      clearTimeout(t);
      t = setTimeout(run, Math.max(0, Math.min(ms, first + maxMs - now)));
    };
  }

  function newId() {
    // crypto.randomUUID() is unavailable on plain http pages, so build an id by hand.
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return 'm-' + Date.now().toString(36) + '-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function elementOf(node) {
    return node && (node.nodeType === 1 ? node : node.parentElement);
  }

  /** True while the extension is still installed and this script can talk to it. */
  function alive() {
    try { return !state.dead && !!chrome.runtime.id; } catch (e) { return false; }
  }

  /** Send a request to background.js. Always resolves to { ok, page | error }. */
  async function send(msg) {
    if (!alive()) { onExtensionGone(); return { ok: false, error: 'gone' }; }
    try {
      const res = await chrome.runtime.sendMessage({ ...msg, url: pageUrl() }); // PDF: the host's key
      return res || { ok: false, error: 'No reply' };
    } catch (e) {
      if (!alive() || /context invalidated/i.test(String(e && e.message))) onExtensionGone();
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /**
   * Chrome updated or removed the extension while this page was open. This
   * copy of the script can no longer save anything, so stop and say so.
   */
  function onExtensionGone() {
    if (state.dead) return;
    state.dead = true;
    closeToolbar();
    closeCard(false);
    showToast('Web Page Markup Tool was updated. Reload this page to carry on marking it up.');
  }

  // ------------------------------------------------- reading the page's colours

  function lumOf(c) {
    return palette.luminance(c.r, c.g, c.b);
  }

  /**
   * Work out how light or dark the background behind an element is.
   * Returns { lum: 0..1, complex: true if it is a gradient/image }.
   */
  function backgroundOf(el) {
    let complex = false;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        complex = true;
        // Gradients list their colours; average them. Pictures tell us nothing.
        const cols = Array.from(cs.backgroundImage.matchAll(/rgba?\([^)]+\)/g))
          .map((m) => palette.parseCssColour(m[0]))
          .filter((c) => c && c.a > 0.5);
        if (cols.length) return { lum: cols.reduce((s, c) => s + lumOf(c), 0) / cols.length, complex };
        break;
      }
      const c = palette.parseCssColour(cs.backgroundColor);
      if (c && c.a >= 0.5) return { lum: lumOf(c), complex };
    }
    const text = el ? palette.parseCssColour(getComputedStyle(el).color) : null;
    const textIsLight = !!text && text.a > 0.5 && lumOf(text) > 0.5;
    // Unknown picture: assume the page author made the text readable against it.
    if (complex) return { lum: textIsLight ? 0.02 : 1, complex };
    // No background set anywhere: the browser's canvas, white unless the page opts into dark.
    const scheme = getComputedStyle(document.documentElement).colorScheme || '';
    const darkCanvas = /dark/.test(scheme) && (!/light/.test(scheme) || matchMedia('(prefers-color-scheme: dark)').matches);
    return { lum: darkCanvas || textIsLight ? 0.02 : 1, complex };
  }

  /**
   * The background behind most of a range's text, by character count. A
   * passage that starts on a small dark badge (an avatar's initials) but runs
   * on over a white card is judged by the card, not by its first character.
   * Looks at up to 200 text nodes; falls back to the start element.
   */
  function dominantBackground(range) {
    const root = range.commonAncestorContainer;
    const byEl = new Map(); // element -> characters of the range inside it
    if (root.nodeType === 3) byEl.set(root.parentElement, 1);
    else {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let n = walker.nextNode(); n && seen < 200; n = walker.nextNode()) {
        if (!range.intersectsNode(n)) continue;
        seen++;
        const from = n === range.startContainer ? range.startOffset : 0;
        const to = n === range.endContainer ? range.endOffset : n.data.length;
        const chars = n.data.slice(from, to).replace(/\s+/g, '').length;
        if (chars && n.parentElement) byEl.set(n.parentElement, (byEl.get(n.parentElement) || 0) + chars);
      }
    }
    if (!byEl.size) return backgroundOf(elementOf(range.startContainer));
    // Add up characters on dark and on light backgrounds; the larger side wins.
    const sides = { dark: { chars: 0, bg: null }, light: { chars: 0, bg: null } };
    for (const [el, chars] of byEl) {
      const bg = backgroundOf(el);
      const side = sides[bg.lum < 0.30 ? 'dark' : 'light'];
      if (!side.bg || chars > side.best) { side.bg = bg; side.best = chars; }
      side.chars += chars;
    }
    return sides.dark.chars > sides.light.chars ? sides.dark.bg : sides.light.bg;
  }

  /**
   * Choose which ::highlight() rule (see styles.css) paints a markup, so the
   * text under it stays readable whatever the page looks like.
   */
  function variantFor(markup, res) {
    const colour = palette.isColour(markup.colour) ? markup.colour : palette.DEFAULT;
    if (state.printing) {
      // Paper is white: always the light fill with dark text.
      return PREFIX + (markup.kind === 'underline' ? `ul-${colour}-l` : `hl-${colour}-lf`);
    }
    const startEl = elementOf(res.range.startContainer);
    const endEl = elementOf(res.range.endContainer);
    const bg = dominantBackground(res.range);
    res.bgLum = bg.lum;
    const dark = bg.lum < 0.30;
    if (markup.kind === 'underline') return PREFIX + `ul-${colour}-${dark ? 'd' : 'l'}`;

    const fillLum = palette.hexLuminance(palette.COLOURS[colour][dark ? 'dark' : 'light']);
    // A fill that all but matches the page (yellow on a yellow panel) would be
    // invisible, so that case also gets an underline in the stronger ink colour.
    if (!dark && !bg.complex && palette.contrast(fillLum, bg.lum) < 1.15) return PREFIX + `hl-${colour}-lc`;
    let forced = bg.complex;
    for (const el of new Set([startEl, endEl])) {
      if (forced || !el) break;
      const text = palette.parseCssColour(getComputedStyle(el).color);
      // Transparent text (e.g. gradient-filled lettering) or text that would
      // fall under 4.5:1 on our fill gets a forced, known-readable colour.
      if (!text || text.a < 0.5 || palette.contrast(lumOf(text), fillLum) < 4.5) forced = true;
    }
    return PREFIX + `hl-${colour}-${dark ? 'd' : 'l'}${forced ? 'f' : ''}`;
  }

  // -------------------------------------------------------- finding and painting

  function isOurs(el) {
    return el === ui.host || el.tagName === 'WMT-PRINT' || el.hasAttribute('data-wmt-marker');
  }

  function getIndex() {
    if (!state.index) state.index = anchorLib.buildIndex(document.body, isOurs);
    return state.index;
  }

  /** A found range is still good if it is attached and its words are unchanged. */
  function stillValid(res) {
    const r = res.range;
    return r.startContainer.isConnected && r.endContainer.isConnected && !r.collapsed && r.toString() === res.text;
  }

  /**
   * Find every saved markup on the live page. Cheap when nothing has changed:
   * the page text is only re-read if some markup is missing or broken.
   */
  function resolveAll() {
    if (!document.body) return;
    let retryOrphans = false;
    const todo = [];
    for (const m of state.markups) {
      const res = state.resolved.get(m.id);
      if (res && stillValid(res)) continue;
      if (!res) retryOrphans = true;
      todo.push(m);
    }
    if (!todo.length) return;
    // Text that is not there yet may still be loading, so look again quickly a
    // few times. After that, only every couple of seconds, so a page that
    // changes constantly (a ticker, a clock) costs next to nothing.
    const onlyOrphans = todo.every((m) => !state.resolved.has(m.id));
    const gap = state.orphanTries < ORPHAN_FAST_TRIES ? ORPHAN_RETRY_FAST : ORPHAN_RETRY_SLOW;
    if (onlyOrphans && retryOrphans && Date.now() - state.lastOrphanTry < gap) {
      clearTimeout(orphanTimer);
      orphanTimer = setTimeout(refresh, gap);
      return;
    }
    state.lastOrphanTry = Date.now();
    if (onlyOrphans) state.orphanTries++;

    // PDF: the host finds each mark on its own PDF page, reading line ends as
    // spaces, and answers null while that page's text is not built yet.
    const h = host();
    const index = h ? null : getIndex();
    for (const m of todo) {
      const hit = h ? h.resolve(m) : anchorLib.resolve(index, m.anchor);
      if (!hit) { state.resolved.delete(m.id); continue; }
      state.resolved.set(m.id, { range: hit.range, text: hit.range.toString(), variant: null, bgLum: 1 });
      // The saved description was out of date (old data, or the page moved): refresh it once.
      if (hit.method !== 'position' && !state.repaired.has(m.id)) {
        state.repaired.add(m.id);
        m.anchor = hit.anchor;
        send({ type: 'markup.patch', id: m.id, patch: { anchor: hit.anchor } });
      }
    }
  }

  let orphanTimer;

  /** Register every found markup with the browser so it is painted. */
  function paint() {
    const groups = new Map(); // rule name -> ranges
    for (const m of state.markups) {
      const res = state.resolved.get(m.id);
      if (!res || res.range.collapsed) continue;
      if (!res.variant) res.variant = variantFor(m, res);
      if (!groups.has(res.variant)) groups.set(res.variant, []);
      groups.get(res.variant).push(res.range);
    }
    for (const [name, ranges] of groups) CSS.highlights.set(name, new Highlight(...ranges));
    for (const name of Array.from(CSS.highlights.keys())) {
      if (name.startsWith(PREFIX) && !groups.has(name)) CSS.highlights.delete(name);
    }
    scheduleLayout();
  }

  function clearVariants() {
    for (const res of state.resolved.values()) res.variant = null;
  }

  /** Re-check everything after the page changed. */
  function refresh() {
    if (state.dead || state.printing) return;
    if (checkUrlChanged()) return;
    if (ui.host && !ui.host.isConnected) document.documentElement.append(ui.host);
    resolveAll();
    paint();
    updateChip();
  }
  const scheduleRefresh = debounce(refresh, 300);

  /**
   * Refresh before the next frame is drawn. Used when the page has just
   * replaced the text node a markup was on (e.g. a ticker setting
   * textContent): a range on a detached node paints nothing, so waiting the
   * usual 300 ms would make the markup blink off after every rewrite.
   */
  let refreshFrameQueued = false;
  function refreshBeforeNextFrame() {
    if (refreshFrameQueued) return;
    refreshFrameQueued = true;
    requestAnimationFrame(() => {
      refreshFrameQueued = false;
      scheduleRefresh.cancel();
      refresh();
    });
  }

  /**
   * Cheap test: has any found markup lost its text node? (No text is read.)
   * Ranges are live: when the page removes the text node a range was on, the
   * browser moves both ends onto the still-attached parent, so the range
   * usually shows up as collapsed rather than detached. Check both.
   */
  function anyDetached() {
    for (const res of state.resolved.values()) {
      const r = res.range;
      if (r.collapsed || !r.startContainer.isConnected || !r.endContainer.isConnected) return true;
    }
    return false;
  }

  function orphans() {
    // PDF: a mark whose PDF page has no text yet is waiting, not lost.
    const h = host();
    return state.markups.filter((m) => !state.resolved.has(m.id) && !(h && h.isPending(m)));
  }

  // -------------------------------------------------------------- loading data

  async function loadPage() {
    const res = await send({ type: 'page.get' });
    if (!res.ok) return;
    applyMarkups(res.page.markups || []);
  }

  /** Replace the in-memory list (from storage) while keeping ranges we already found. */
  function applyMarkups(list) {
    const ids = new Set(list.map((m) => m.id));
    for (const id of Array.from(state.resolved.keys())) if (!ids.has(id)) state.resolved.delete(id);
    state.markups = list;
    if (state.card && state.card.id && !ids.has(state.card.id)) closeCard(false);
    clearVariants();
    resolveAll();
    paint();
    updateChip();
  }

  /** Single-page apps change the address without reloading: notice and switch page. */
  function checkUrlChanged() {
    const key = urlLib.pageKey(pageUrl()); // PDF: changes once the viewer knows the document
    if (key === state.key) return false;
    state.key = key;
    closeToolbar();
    closeCard(true);
    state.repaired.clear();
    state.lastOrphanTry = 0;
    state.orphanTries = 0;
    applyMarkups([]);
    loadPage();
    return true;
  }

  // ------------------------------------------------------------------ the UI

  function buildUi() {
    const host = document.createElement('wmt-root');
    // 'closed' stops page scripts reading notes. The test harness asks for 'open'
    // through extension storage, which a web page cannot write to.
    const shadow = host.attachShadow({ mode: state.testMode ? 'open' : 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(uiCss);
    shadow.adoptedStyleSheets = [sheet];

    ui.live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
    ui.pins = h('div', {});
    ui.notes = h('div', {});
    ui.wrap = h('div', { class: 'wmt' }, ui.live, ui.notes, ui.pins);
    shadow.append(ui.wrap);
    ui.host = host;
    ui.shadow = shadow;

    host.setAttribute('popover', 'manual');
    document.documentElement.append(host);
    raise();
    updateTheme();
  }

  /** Put our layer above everything else on the page, including its dialogs. */
  function raise() {
    try {
      if (ui.host.matches(':popover-open')) ui.host.hidePopover();
      ui.host.showPopover();
    } catch (e) { /* the z-index in ui/styles.js is the fallback */ }
  }

  function updateTheme() {
    if (!ui.wrap || !document.body) return;
    ui.wrap.dataset.theme = backgroundOf(document.body).lum < 0.30 ? 'dark' : 'light';
  }

  function announce(text) {
    ui.live.textContent = '';
    setTimeout(() => { ui.live.textContent = text; }, 30);
  }

  // Tooltips: our own element, never the `title` attribute.
  let tipTimer;
  function attachTip(btn, label) {
    btn.setAttribute('aria-label', label);
    const show = (delay) => {
      clearTimeout(tipTimer);
      tipTimer = setTimeout(() => {
        hideTip();
        ui.tooltip = h('div', { class: 'tooltip', role: 'presentation' }, label);
        ui.wrap.append(ui.tooltip);
        const b = btn.getBoundingClientRect();
        const t = ui.tooltip.getBoundingClientRect();
        let top = b.bottom + 6;
        if (top + t.height > innerHeight - 4) top = b.top - t.height - 6;
        const left = Math.max(4, Math.min(b.left + b.width / 2 - t.width / 2, innerWidth - t.width - 4));
        ui.tooltip.style.left = left + 'px';
        ui.tooltip.style.top = top + 'px';
      }, delay);
    };
    btn.addEventListener('mouseenter', () => show(400));
    btn.addEventListener('focus', () => { if (btn.matches(':focus-visible')) show(0); });
    for (const ev of ['mouseleave', 'blur', 'pointerdown']) btn.addEventListener(ev, hideTip);
  }
  function hideTip() {
    clearTimeout(tipTimer);
    if (ui.tooltip) { ui.tooltip.remove(); ui.tooltip = null; }
  }

  function swatchButton(name, { pressed, role, onPick }) {
    const btn = h('button', {
      class: 'btn swatch', type: 'button', style: `--dot:${palette.COLOURS[name].light}`,
      [role === 'radio' ? 'aria-checked' : 'aria-pressed']: String(!!pressed),
      'data-colour': name,
      onclick: () => onPick(name),
    });
    attachTip(btn, `Highlight ${palette.COLOURS[name].label}`);
    return btn;
  }

  /** Position a floating element at viewport coordinates, kept 8px inside the window. */
  function moveTo(el, x, y) {
    const r = el.getBoundingClientRect();
    el.style.left = Math.round(Math.max(8, Math.min(x, innerWidth - r.width - 8))) + 'px';
    el.style.top = Math.round(Math.max(8, Math.min(y, innerHeight - r.height - 8))) + 'px';
  }

  // ----------------------------------------------------------------- toolbar

  /** Decide whether the current selection is something we can mark, and offer the toolbar. */
  function offerToolbar() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !sel.toString().trim()) return false;
    const el = elementOf(sel.anchorNode);
    const active = document.activeElement;
    if (!el || el === ui.host || el.isContentEditable) return false;       // editors keep their own tools
    if (active && /^(INPUT|TEXTAREA)$/.test(active.tagName)) return false;  // text typed into a form field
    const range = sel.getRangeAt(0).cloneRange();
    if (!range.getClientRects().length) return false;
    openToolbar(range);
    return true;
  }

  function openToolbar(range) {
    closeToolbar();
    state.pendingRange = range;
    const bar = h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Mark selected text' });
    for (const name of palette.NAMES) {
      bar.append(swatchButton(name, { pressed: name === state.colour, onPick: (c) => createMarkup('highlight', c, false) }));
    }
    const underline = h('button', { class: 'btn', type: 'button', 'data-action': 'underline', onclick: () => createMarkup('underline', state.colour, false) }, icon('underline'));
    attachTip(underline, 'Underline');
    const note = h('button', { class: 'btn', type: 'button', 'data-action': 'note', onclick: () => createMarkup('highlight', state.colour, true) }, icon('note'));
    attachTip(note, 'Add note');
    bar.append(h('div', { class: 'divider', role: 'separator' }), underline, note);
    // Keep the page's selection when a toolbar button is pressed.
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    // Roving tabindex: one tab stop, arrow keys move within the toolbar.
    for (const b of bar.querySelectorAll('button')) b.tabIndex = b.dataset.colour === state.colour ? 0 : -1;
    ui.toolbar = bar;
    ui.wrap.append(bar);
    raise();
    placeToolbar();
  }

  /** Above the selection if there is room, otherwise below; never off-screen. */
  function placeToolbar() {
    if (!ui.toolbar || !state.pendingRange) return;
    const sel = state.pendingRange.getBoundingClientRect();
    const out = sel.bottom < 0 || sel.top > innerHeight;
    ui.toolbar.style.visibility = out ? 'hidden' : '';
    if (out) return;
    const bar = ui.toolbar.getBoundingClientRect();
    const top = Math.max(sel.top, 0);
    const bottom = Math.min(sel.bottom, innerHeight);
    let y = top - bar.height - 8;
    if (y < 8) y = bottom + 8;
    moveTo(ui.toolbar, sel.left + sel.width / 2 - bar.width / 2, y);
  }

  function closeToolbar() {
    hideTip();
    if (ui.toolbar) { ui.toolbar.remove(); ui.toolbar = null; }
    state.pendingRange = null;
  }

  // ------------------------------------------------------- creating / changing

  function setColour(name) {
    if (!palette.isColour(name) || name === state.colour) return;
    state.colour = name;
    if (alive()) chrome.storage.sync.set({ colour: name }).catch(() => {});
  }

  async function createMarkup(kind, colour, withNote) {
    const range = state.pendingRange;
    closeToolbar();
    if (!range || state.dead) return;

    // PDF: the host describes the selection by its PDF page's text.
    const viaHost = host() ? host().describe(range) : null;
    const index = viaHost ? null : getIndex();
    const desc = viaHost ? viaHost.anchor : anchorLib.describeRange(index, range);
    if (!desc || !desc.quote.exact.trim()) {
      showToast('This text cannot be marked up.');
      return;
    }
    if (desc.quote.exact.length > MAX_QUOTE) {
      showToast('That selection is too long to mark up. Try a shorter one.');
      return;
    }
    const now = Date.now();
    const markup = { id: newId(), kind, colour, note: '', createdAt: now, updatedAt: now, anchor: { ...desc, xpath: null } };
    const own = viaHost ? viaHost.range : (anchorLib.spanToRange(index, desc.pos.start, desc.pos.end) || range);

    state.markups.push(markup);
    state.resolved.set(markup.id, { range: own, text: own.toString(), variant: null, bgLum: 1 });
    state.repaired.add(markup.id);
    paint();
    getSelection().removeAllRanges();
    setColour(colour);
    announce(kind === 'underline' ? 'Underline added' : 'Highlight added');
    if (withNote) openCard(markup.id, true);

    const res = await send({ type: 'markup.upsert', markup });
    if (!res.ok && !state.dead) {
      // Never leave something on screen that was not saved.
      if (state.card && state.card.id === markup.id) closeCard(false);
      state.markups = state.markups.filter((m) => m.id !== markup.id);
      state.resolved.delete(markup.id);
      paint();
      showToast('Could not save this markup.', { alert: true });
    }
  }

  async function changeMarkup(markup, patch) {
    Object.assign(markup, patch);
    const res = state.resolved.get(markup.id);
    if (res) res.variant = null;
    paint();
    const reply = await send({ type: 'markup.patch', id: markup.id, patch });
    if (!reply.ok && !state.dead) showToast('Could not save that change.', { alert: true });
    return reply.ok;
  }

  async function deleteMarkup(id) {
    const markup = state.markups.find((m) => m.id === id);
    if (!markup) return;
    const res = state.resolved.get(id);
    if (state.card && state.card.id === id) closeCard(false);
    state.markups = state.markups.filter((m) => m.id !== id);
    state.resolved.delete(id);
    paint();
    updateChip();
    const reply = await send({ type: 'markup.remove', id });
    if (!reply.ok) {
      if (!state.dead) showToast('Could not delete that markup.', { alert: true });
      return;
    }
    showToast('Markup deleted.', {
      action: 'Undo',
      onAction: async () => {
        // Put the record back exactly as it was.
        if (!state.markups.some((m) => m.id === id)) state.markups.push(markup);
        if (res && stillValid(res)) state.resolved.set(id, { ...res, variant: null });
        resolveAll();
        paint();
        updateChip();
        await send({ type: 'markup.upsert', markup });
      },
    });
  }

  // ---------------------------------------------------------------- note card

  function rectsOf(range) {
    return Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  }

  function boundsOf(rects) {
    const b = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    for (const r of rects) {
      b.left = Math.min(b.left, r.left); b.top = Math.min(b.top, r.top);
      b.right = Math.max(b.right, r.right); b.bottom = Math.max(b.bottom, r.bottom);
    }
    return b;
  }

  function cardShell(title, label) {
    const body = h('div', { class: 'card-body' });
    const head = h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, title));
    const el = h('div', { class: 'card', role: 'dialog', 'aria-label': label }, head, body);
    return { el, head, body };
  }

  function addCloseButton(head) {
    const close = h('button', { class: 'btn', type: 'button', 'data-action': 'close', onclick: () => closeCard(true) }, icon('close'));
    attachTip(close, 'Close');
    head.append(close);
  }

  /** Open the card for one markup: change its colour or style, write a note, or delete it. */
  function openCard(id, focusNote) {
    const markup = state.markups.find((m) => m.id === id);
    if (!markup || !state.resolved.has(id)) return;
    closeCard(true);
    closeToolbar();

    const { el, head, body } = cardShell('Note', 'Note');
    const bin = h('button', { class: 'btn danger', type: 'button', 'data-action': 'delete', onclick: () => deleteMarkup(id) }, icon('bin'));
    attachTip(bin, 'Delete markup');
    head.append(bin);
    addCloseButton(head);

    const swatches = h('div', { class: 'swatches', role: 'group', 'aria-label': 'Colour' });
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Style' });
    const syncPressed = () => {
      for (const b of swatches.children) b.setAttribute('aria-pressed', String(b.dataset.colour === markup.colour));
      for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.kind === markup.kind));
    };
    for (const name of palette.NAMES) {
      swatches.append(swatchButton(name, {
        pressed: false,
        onPick: (c) => { setColour(c); changeMarkup(markup, { colour: c }); syncPressed(); },
      }));
    }
    for (const [kind, text] of [['highlight', 'Highlight'], ['underline', 'Underline']]) {
      seg.append(h('button', { type: 'button', 'data-kind': kind, onclick: () => { changeMarkup(markup, { kind }); syncPressed(); } }, text));
    }
    syncPressed();

    const status = h('div', { class: 'status', 'aria-live': 'polite' });
    const textarea = h('textarea', { 'aria-label': 'Note', placeholder: 'Add a note…', rows: '3', maxlength: String(MAX_NOTE) });
    textarea.value = markup.note || '';

    // Save shortly after typing stops; also on blur, close and when the page is left.
    let dirty = false;
    const save = async () => {
      if (!dirty) return;
      dirty = false;
      const ok = await changeMarkup(markup, { note: textarea.value });
      status.textContent = ok ? 'Saved' : 'Not saved. Your note is still here.';
      if (!ok) dirty = true;
    };
    const saveSoon = debounce(save, NOTE_SAVE_DELAY);
    textarea.addEventListener('input', () => { dirty = true; status.textContent = 'Saving…'; saveSoon(); });
    textarea.addEventListener('blur', () => { saveSoon.cancel(); save(); });

    body.append(h('div', { class: 'controls' }, swatches, seg), textarea, status);
    ui.wrap.append(el);
    state.card = { el, id, flush: () => { saveSoon.cancel(); return save(); } };
    raise();
    placeCard();
    scheduleLayout(); // hide this markup's own margin note or pin while its card is open
    if (focusNote) textarea.focus({ preventScroll: true });
  }

  /** Card for markups whose text is no longer on the page. */
  function openOrphanCard() {
    const list = orphans();
    if (!list.length) return;
    closeCard(true);
    closeToolbar();
    const { el, head, body } = cardShell('Text not found on this page', 'Text not found on this page');
    addCloseButton(head);
    body.append(h('p', { class: 'muted' }, 'These were saved here, but the text has changed or moved.'));
    const items = h('div', { class: 'orphan-list' });
    for (const m of list) {
      const quote = m.anchor && m.anchor.quote && m.anchor.quote.exact;
      const copyText = [quote ? `“${quote}”` : '', m.note || ''].filter(Boolean).join('\n');
      const copyBtn = h('button', { class: 'btn text', type: 'button', onclick: async () => {
        try { await navigator.clipboard.writeText(copyText); copyBtn.textContent = 'Copied'; }
        catch (e) { copyBtn.textContent = 'Could not copy'; }
      } }, 'Copy');
      items.append(h('div', { class: 'orphan' },
        quote ? h('q', {}, quote.length > 200 ? quote.slice(0, 200) + '…' : quote) : h('p', { class: 'muted' }, 'A note saved by an older version.'),
        m.note ? h('p', {}, m.note) : null,
        h('div', { class: 'row' }, copyBtn,
          h('button', { class: 'btn text danger', type: 'button', onclick: () => { deleteMarkup(m.id).then(() => { if (orphans().length) openOrphanCard(); }); } }, 'Delete'))));
    }
    body.append(items);
    ui.wrap.append(el);
    state.card = { el, id: null, flush: () => {} };
    raise();
    placeCard();
    el.querySelector('button').focus({ preventScroll: true });
  }

  /**
   * Put the card next to its text without covering it: below, above, right,
   * then left. If none fits, dock it bottom-right.
   */
  function placeCard() {
    const card = state.card;
    if (!card) return;
    const c = card.el.getBoundingClientRect();
    const res = card.id && state.resolved.get(card.id);
    const rects = res ? rectsOf(res.range) : [];
    const dock = () => moveTo(card.el, innerWidth - c.width - 16, innerHeight - c.height - 16);
    if (!rects.length) return dock();
    const b = boundsOf(rects);
    if (b.bottom < 0 || b.top > innerHeight) return dock(); // its text is scrolled out of view
    const centred = b.left + (b.right - b.left) / 2 - c.width / 2;
    const options = [
      [centred, b.bottom + 8],
      [centred, b.top - c.height - 8],
      [b.right + 8, b.top],
      [b.left - c.width - 8, b.top],
    ];
    for (const [x0, y0] of options) {
      const x = Math.max(8, Math.min(x0, innerWidth - c.width - 8));
      const y = Math.max(8, Math.min(y0, innerHeight - c.height - 8));
      const overlaps = rects.some((r) => x < r.right && x + c.width > r.left && y < r.bottom && y + c.height > r.top);
      if (!overlaps) return moveTo(card.el, x, y);
    }
    dock();
  }

  function closeCard(save) {
    hideTip();
    const card = state.card;
    if (!card) return;
    state.card = null;
    if (save) card.flush();
    card.el.remove();
    scheduleLayout();
  }

  // ---------------------------------------------------------- notes on the page
  //
  // Every markup with a note shows it without a click (setting "Show notes on
  // the page", on by default):
  //   - a margin note (.margin-note) in free space beside the passage's block,
  //     right side first, then left, top aligned with the passage's first line;
  //   - where there is no free gutter, a short label (.pin.label) at the end of
  //     the passage that expands to the full note on hover or focus.
  // With the setting off, each note is the small pin (.pin) it was before.
  //
  // layoutNotes() runs at most once per animation frame (scheduleLayout) and
  // keeps reads and writes in batches: page geometry is read first, then note
  // contents are written, their heights read once (only when they changed),
  // and finally positions are written.

  const NOTE_MIN_W = 104;     // narrowest margin note (needs a 124px gutter: note + gap + edge)
  const NOTE_NARROW_W = 176;  // below this width a note may run to 8 lines instead of 6
  const NOTE_MAX_W = 240;     // widest margin note
  const NOTE_GAP_X = 16;      // between the passage's block and its note
  const NOTE_EDGE = 4;        // between a note and the window edge
  const NOTE_GAP_Y = 8;       // between two stacked notes
  const NOTE_LINE = 18;       // line height of note text (ui/styles.js)
  const NOTE_PAD_Y = 16;      // top + bottom padding of a margin note
  const NOTE_MAX_LINES = 6;
  const NOTE_MAX_LINES_NARROW = 8;
  const LABEL_CHARS = 28;     // characters of the note shown on a fallback label
  const LABEL_CHARS_COMPACT = 12; // characters on the compact label (last resort)
  const LABEL_H = 22;         // label height (ui/styles.js .pin.label)
  const LABEL_MAX_W = 220;    // label max-width (ui/styles.js)
  const LABEL_CHROME = 22;    // label border (2) + padding (12 + 8)
  const LABEL_ICON = 16;      // compact label: 12px icon + 4px gap
  const BLOCK_LEVELS = 4;     // how many enclosing blocks to try for a free gutter

  const marginEls = new Map();      // markup id -> margin note button
  const placeCache = new Map();     // markup id -> { block, side } that last worked
  const blockCache = new WeakMap(); // resolved entry -> its enclosing blocks, nearest first
  const heightCache = new Map();    // "width|text" -> measured margin-note height
  const ringEls = [];               // emphasis rings around the passage of the hovered note

  /** First few words of a passage, for accessible names. */
  function firstWords(text, n = 6) {
    const words = (text || '').trim().split(/\s+/);
    return words.slice(0, n).join(' ') + (words.length > n ? '…' : '');
  }

  /** Accessible name shared by the margin note and the label. */
  function noteName(m, res) {
    const note = m.note.trim();
    return `Note on “${firstWords(res.text)}”: ${note.length > 300 ? note.slice(0, 300) + '…' : note}`;
  }

  /** Colour of the bar that ties a note to its passage (the mark's own colour). */
  function barColour(m) {
    const c = palette.COLOURS[m.colour] || palette.COLOURS[palette.DEFAULT];
    return ui.wrap.dataset.theme === 'dark' ? c.light : c.ink;
  }

  /** The block-level elements around a passage, nearest first (read once per found range). */
  function blocksOf(res) {
    let list = blockCache.get(res);
    if (list) return list;
    // PDF: pdf.js lays every line out as its own positioned box, so the
    // "block" beside which a note goes is the whole PDF page.
    if (host()) { list = host().blocksFor(res); blockCache.set(res, list); return list; }
    list = [];
    for (let el = elementOf(res.range.commonAncestorContainer); el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const d = getComputedStyle(el).display;
      if (d.startsWith('inline') || d === 'contents' || d === 'none') continue;
      list.push(el);
      if (list.length >= BLOCK_LEVELS) break;
    }
    blockCache.set(res, list);
    return list;
  }

  /**
   * Usable width of the window: excludes the page's vertical scrollbar
   * (window.innerWidth includes it, so notes ran under it). Falls back to
   * innerWidth if the root element reports nothing.
   */
  function viewWidth() {
    return document.documentElement.clientWidth || innerWidth;
  }

  /** The topmost page element at a point, looking through our own layer. */
  function pageElementAt(x, y) {
    for (const el of document.elementsFromPoint(x, y)) if (el !== ui.host) return el;
    return null;
  }

  /**
   * Is the box free of page content? Samples a grid of points no more than
   * 20px apart across and 16px apart down (so a short word in a neighbouring
   * column cannot slip between them); a point is free when the page element
   * there is the passage's block or one of its ancestors (background, not a
   * sidebar, an image or text of any other block). Points outside the window
   * cannot be tested and are skipped.
   */
  function boxIsFree(block, x, y, w, hgt, dense = false) {
    // Margin notes (large boxes in a gutter, checked every frame) use a coarse
    // grid; labels (small, sitting among text) use the dense one.
    const stepX = dense ? 20 : 120;
    const stepY = dense ? 16 : 60;
    const spread = (from, size, inset, step) => {
      const a = from + inset, b = from + size - inset;
      const n = Math.max(1, Math.ceil((b - a) / step));
      return Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
    };
    for (const px of spread(x, w, 3, stepX)) {
      for (const py of spread(y, hgt, 3, stepY)) {
        if (px < 0 || px >= viewWidth() || py < 0 || py >= innerHeight) continue;
        const el = pageElementAt(px, py);
        if (el && !el.contains(block)) return false;
      }
    }
    return true;
  }

  /** Where a margin note for this block and side would go, or null if there is not room. */
  function gutterBox(block, side) {
    const b = block.getBoundingClientRect();
    const room = side === 'right' ? viewWidth() - b.right : b.left;
    const w = Math.min(NOTE_MAX_W, Math.floor(room - NOTE_GAP_X - NOTE_EDGE));
    if (w < NOTE_MIN_W) return null;
    return { x: side === 'right' ? Math.round(b.right + NOTE_GAP_X) : Math.round(b.left - NOTE_GAP_X - w), w };
  }

  /** Rough height before the note has been measured (characters per line from the width). */
  function estimateHeight(text, w) {
    const perLine = Math.max(10, Math.floor((w - 26) / 7));
    let lines = 0;
    for (const para of text.split('\n')) lines += Math.max(1, Math.ceil(para.length / perLine));
    return Math.min(lines, w < NOTE_NARROW_W ? NOTE_MAX_LINES_NARROW : NOTE_MAX_LINES) * NOTE_LINE + NOTE_PAD_Y;
  }

  /** A passage's on-screen state: its line boxes and whether it can be seen at all. */
  function passageView(res) {
    const rects = rectsOf(res.range);
    const visible = rects.filter((r) => r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < viewWidth());
    if (!visible.length) return { rects, shown: false };
    // Hidden when covered (a sticky header) or clipped (scrolled out of an inner scroll box).
    const probe = visible[0];
    const hit = pageElementAt(
      Math.min(Math.max(probe.left + probe.width / 2, 0), viewWidth() - 1),
      Math.min(Math.max(probe.top + probe.height / 2, 0), innerHeight - 1));
    const anc = elementOf(res.range.commonAncestorContainer);
    return { rects, shown: !!hit && !!anc && (anc.contains(hit) || hit.contains(anc)) };
  }

  function overlaps(a, b, gap = 0) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
  }

  /** Lay out every note: margin notes, labels or pins. */
  function layoutNotes() {
    const show = state.showNotes;
    const cardId = state.card && state.card.id;
    const cardBox = state.card ? (() => { const r = state.card.el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })() : null;

    // ---- 1. Read: which notes are on screen, and where their passages are.
    const items = [];
    for (const m of state.markups) {
      const res = state.resolved.get(m.id);
      if (!res || !(m.note || '').trim()) continue;
      const view = passageView(res);
      items.push({ m, res, ...view, mode: 'hidden', box: null });
    }
    // Document order, so that collisions push the later note down.
    items.sort((a, b) => a.res.range.compareBoundaryPoints(Range.START_TO_START, b.res.range));

    // ---- 2. Read: pick a gutter for each visible note (cached choice first, then a search).
    for (const it of items) {
      if (!it.shown || it.m.id === cardId) continue;
      if (!show) { it.mode = 'pin'; continue; }
      const text = it.m.note.trim();
      const top = it.rects[0].top;
      const tryPlace = (block, side) => {
        const g = gutterBox(block, side);
        if (!g) return null;
        const hgt = heightCache.get(g.w + '|' + text) || estimateHeight(text, g.w);
        return boxIsFree(block, g.x, top, g.w, hgt) ? { block, side, x: g.x, w: g.w } : null;
      };
      const cached = placeCache.get(it.m.id);
      let spot = cached && cached.block.isConnected ? tryPlace(cached.block, cached.side) : null;
      for (const block of spot ? [] : blocksOf(it.res)) {
        spot = tryPlace(block, 'right') || tryPlace(block, 'left');
        if (spot) break;
      }
      if (spot) {
        placeCache.set(it.m.id, { block: spot.block, side: spot.side });
        it.mode = 'margin';
        it.spot = spot;
      } else {
        placeCache.delete(it.m.id);
        it.mode = 'label';
      }
    }

    // ---- 3. Write: create/update the elements' contents (positions come later).
    const wanted = new Set(items.map((it) => it.m.id));
    for (const it of items) {
      const { m, res } = it;
      // Margin note
      let note = marginEls.get(m.id);
      if (it.mode === 'margin') {
        if (!note) {
          note = h('button', { class: 'margin-note', type: 'button', 'data-id': m.id, onclick: () => openCard(m.id, true) }, h('span', { class: 'mn-text' }));
          for (const ev of ['mouseenter', 'focus']) note.addEventListener(ev, () => setEmphasis(m.id));
          for (const ev of ['mouseleave', 'blur']) note.addEventListener(ev, () => setEmphasis(null));
          marginEls.set(m.id, note);
          ui.notes.append(note);
        }
        setIfChanged(note.firstChild, 'textContent', m.note.trim());
        setAttrIfChanged(note, 'aria-label', noteName(m, res));
        setStyleIfChanged(note, '--bar', barColour(m));
        setStyleIfChanged(note, 'width', it.spot.w + 'px');
        if (note.classList.contains('narrow') !== it.spot.w < NOTE_NARROW_W) note.classList.toggle('narrow');
      }
      if (note) note.hidden = it.mode !== 'margin';
      syncPin(it);
    }
    for (const [id, el] of marginEls) if (!wanted.has(id)) { el.remove(); marginEls.delete(id); placeCache.delete(id); }
    for (const [id, el] of pinEls) if (!wanted.has(id)) { el.remove(); pinEls.delete(id); }

    // ---- 4. Read: real heights of margin notes whose width or text is new (one layout at most).
    for (const it of items) {
      if (it.mode !== 'margin') continue;
      const key = it.spot.w + '|' + it.m.note.trim();
      if (!heightCache.has(key)) {
        if (heightCache.size > 500) heightCache.clear();
        heightCache.set(key, marginEls.get(it.m.id).offsetHeight);
      }
      it.h = heightCache.get(key);
    }

    // ---- 5. Stack margin notes without collisions (in document order, 8px apart).
    const placed = cardBox ? [cardBox] : [];
    for (const it of items) {
      if (it.mode !== 'margin') continue;
      const box = { x: it.spot.x, y: Math.round(it.rects[0].top), w: it.spot.w, h: it.h };
      let moved = true;
      while (moved) {
        moved = false;
        for (const p of placed) {
          if (overlaps(box, p, NOTE_GAP_Y)) { box.y = Math.round(p.y + p.h + NOTE_GAP_Y); moved = true; }
        }
      }
      // A note pushed down must still land on free space; otherwise it becomes a label.
      if (box.y !== Math.round(it.rects[0].top) && !boxIsFree(it.spot.block, box.x, box.y, box.w, box.h)) {
        it.late = true;
        continue;
      }
      it.box = box;
      placed.push(box);
    }
    // Notes that lost their place: switch them to labels now (a rare second write/read round).
    for (const it of items) {
      if (!it.late) continue;
      it.mode = 'label';
      marginEls.get(it.m.id).hidden = true;
      syncPin(it);
    }

    // ---- 6. Read: where pins and labels go. Label sizes are worked out from
    // the text (no layout read), so the full and compact forms can both be tried.
    const textCache = new Map(); // block -> its text line boxes, for this frame only
    // Boxes labels must keep clear of: placed margin notes, the open card, and
    // (added as they are placed, in document order) earlier labels.
    const taken = placed.slice();
    for (const it of items) {
      if (it.mode === 'pin') {
        const last = it.rects[it.rects.length - 1];
        // In the gap above the end of the last line: never on top of the marked words.
        it.box = { x: Math.round(Math.max(2, Math.min(last.right - 4, viewWidth() - 22))), y: Math.round(Math.max(2, last.top - 14)) };
      } else if (it.mode === 'label') {
        Object.assign(it, labelPlace(it, textCache, taken));
        taken.push(it.box);
      }
    }

    // ---- 7. Write: label form, placement, positions.
    for (const it of items) {
      const el = it.mode === 'margin' ? marginEls.get(it.m.id) : pinEls.get(it.m.id);
      if (!el || !it.box) continue;
      if (it.mode === 'label') {
        if (el.classList.contains('compact') !== it.compact) el.classList.toggle('compact');
        setAttrIfChanged(el, 'data-place', it.place);
      } else if (el.hasAttribute('data-place')) {
        el.removeAttribute('data-place');
        el.classList.remove('compact');
      }
      setStyleIfChanged(el, 'left', it.box.x + 'px');
      setStyleIfChanged(el, 'top', it.box.y + 'px');
    }
    drawRings();
  }

  /** Create or update the pin / label for one note (writes only). */
  function syncPin(it) {
    const { m, res } = it;
    let pin = pinEls.get(m.id);
    const wantPin = it.mode === 'pin' || it.mode === 'label';
    if (!pin && !wantPin) return;
    if (!pin) {
      pin = h('button', { class: 'pin', type: 'button', 'data-id': m.id, onclick: () => openCard(m.id, false) });
      for (const ev of ['mouseenter', 'focus']) pin.addEventListener(ev, () => setEmphasis(m.id));
      for (const ev of ['mouseleave', 'blur']) pin.addEventListener(ev, () => setEmphasis(null));
      pinEls.set(m.id, pin);
      ui.pins.append(pin);
    }
    pin.hidden = !wantPin;
    if (!wantPin) return;
    const asLabel = it.mode === 'label';
    if (pin.classList.contains('label') !== asLabel || pin.dataset.text !== m.note) {
      // Rebuild the inside only when the kind or the note text changed.
      pin.classList.toggle('label', asLabel);
      pin.dataset.text = m.note;
      const text = m.note.trim();
      // A label holds every form; CSS shows one: .short (full form), icon +
      // .tiny (compact form), .full (on hover or focus).
      pin.replaceChildren(...(asLabel
        ? [icon('note'),
          h('span', { class: 'short' }, labelText(text, LABEL_CHARS)),
          h('span', { class: 'tiny' }, labelText(text, LABEL_CHARS_COMPACT)),
          h('span', { class: 'full' }, text)]
        : [icon('note')]));
    }
    setAttrIfChanged(pin, 'aria-label', asLabel ? noteName(m, res) : 'Open note');
    setStyleIfChanged(pin, '--bar', barColour(m));
  }

  /** The first n characters of a note, with an ellipsis when cut. */
  function labelText(text, n) {
    const flat = text.replace(/\s+/g, ' ');
    return flat.length > n ? flat.slice(0, n).trimEnd() + '…' : flat;
  }

  // Text widths for label sizes, measured on a canvas (no page layout involved).
  let measureCtx = null;
  function textWidth(str) {
    if (!measureCtx) {
      measureCtx = document.createElement('canvas').getContext('2d');
      measureCtx.font = `500 12px ${getComputedStyle(ui.wrap).fontFamily}`;
    }
    return measureCtx.measureText(str).width;
  }

  /** Widths of a label's full form (28 characters) and compact form (icon + 12 characters). */
  function labelWidths(text) {
    return {
      full: Math.min(LABEL_MAX_W, Math.ceil(LABEL_CHROME + textWidth(labelText(text, LABEL_CHARS)) + 1)),
      compact: Math.min(LABEL_MAX_W, Math.ceil(LABEL_CHROME + LABEL_ICON + textWidth(labelText(text, LABEL_CHARS_COMPACT)) + 1)),
    };
  }

  /** Line boxes of every piece of text in a block (one entry per text node per line). */
  function blockTextRects(block, cache) {
    let list = cache.get(block);
    if (list) return list;
    list = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let n = walker.nextNode(); n && list.length < 2000; n = walker.nextNode()) {
      if (!n.data.trim()) continue;
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) list.push(r);
    }
    cache.set(block, list);
    return list;
  }

  /**
   * The visible area a block is shown through: the window, cut down by every
   * ancestor that clips its content (scroll boxes, overflow: hidden), less
   * their scrollbars and borders. A label must stay inside it.
   */
  function clipRectOf(block, cache) {
    if (!cache.has('clip')) cache.set('clip', new Map());
    const clips = cache.get('clip');
    if (clips.has(block)) return clips.get(block);
    const c ={ left: NOTE_EDGE, top: 0, right: viewWidth() - NOTE_EDGE, bottom: innerHeight };
    for (let el = block.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const r = el.getBoundingClientRect();
      const left = r.left + el.clientLeft;
      const top = r.top + el.clientTop;
      c.left = Math.max(c.left, left); c.top = Math.max(c.top, top);
      c.right = Math.min(c.right, left + el.clientWidth); c.bottom = Math.min(c.bottom, top + el.clientHeight);
    }
    clips.set(block, c);
    return c;
  }

  /** Do two boxes share a line (overlap by more than half the shorter height)? */
  function sameLine(a, b) {
    return Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > Math.min(a.height, b.height) / 2;
  }

  /**
   * Where a fallback label goes, and in which form. Tries, in order, spots
   * with no page text under them:
   *   a. after the end of the passage, when the passage ends its line;
   *   b. after the end of the last line of the passage's block;
   *   c. at the passage's first line, right of the block's text (its padding
   *      or the gap beside it);
   * first in the full form, then in the compact form. Last resort (d): the
   * compact form next to the passage, which may cover nearby page words but
   * never the passage itself.
   * `taken` holds boxes already used (margin notes, the card, earlier labels):
   * a label never overlaps them. When its spot is taken it moves along the
   * line beside them (4px apart); if that leaves no room, the next spot is tried.
   */
  function labelPlace(it, textCache, taken) {
    const rects = it.rects;
    const first = rects[0];
    const last = rects[rects.length - 1];
    const block = blocksOf(it.res)[0] || elementOf(it.res.range.commonAncestorContainer);
    const text = blockTextRects(block, textCache);
    const sizes = labelWidths(it.m.note.trim());
    const h0 = LABEL_H;
    const asBox = (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height });

    // A box is usable when it is inside the area the block is seen through
    // (the window or its scroll box), covers no text of the block or the
    // passage, and hit-testing finds only background there.
    const clip = clipRectOf(block, textCache);
    const usable = (box) =>
      box.x >= clip.left && box.x + box.w <= clip.right &&
      box.y >= clip.top && box.y + box.h <= clip.bottom &&
      !text.some((r) => overlaps(box, asBox(r), 1)) &&
      !rects.some((r) => overlaps(box, asBox(r), 1)) &&
      boxIsFree(block, box.x, box.y, box.w, box.h, true);
    const at = (x, line, w) => ({ x: Math.round(x), y: Math.round(line.top + (line.height - h0) / 2), w, h: h0 });

    // The first taken box this one would touch (kept 4px apart on every side).
    const GAP = 4;
    const clashWith = (box) => taken.find((t) =>
      box.x < t.x + t.w + GAP && box.x + box.w + GAP > t.x && box.y < t.y + t.h + GAP && box.y + box.h + GAP > t.y);
    // Side by side: slide right past each label in the way.
    const slide = (box) => {
      for (let i = 0, t; i < 20 && (t = clashWith(box)); i++) box = { ...box, x: Math.round(t.x + t.w + GAP) };
      return box;
    };

    // Candidate start points (each a function of the label width).
    const tries = [];
    // a. Right after the passage, only if nothing follows it on its line.
    const endsLine = !text.some((r) => sameLine(r, last) && r.right > last.right + 2);
    if (endsLine) tries.push({ place: 'a', box: (w) => at(last.right + 6, last, w) });
    // b. After the last line of the block.
    if (text.length) {
      let end = text[0];
      for (const r of text) if (r.bottom > end.bottom + 1 || (sameLine(r, end) && r.right > end.right)) end = r;
      let lineEnd = end;
      for (const r of text) if (sameLine(r, end) && r.right > lineEnd.right) lineEnd = r;
      tries.push({ place: 'b', box: (w) => at(lineEnd.right + 6, lineEnd, w) });
    }
    // c. At the first line, right of any of the block's text on that line.
    const band = { top: first.top + (first.height - h0) / 2, bottom: first.top + (first.height + h0) / 2 };
    band.height = h0;
    let textRight = first.right;
    for (const r of text) if (Math.min(r.bottom, band.bottom) - Math.max(r.top, band.top) > 0) textRight = Math.max(textRight, r.right);
    tries.push({ place: 'c', box: (w) => at(textRight + 6, first, w) });

    for (const form of ['full', 'compact']) {
      for (const t of tries) {
        const box = slide(t.box(sizes[form]));
        if (!clashWith(box) && usable(box)) return { box, place: t.place, compact: form === 'compact' };
      }
    }

    // d. Last resort: compact, beside the passage (after its last line, else
    // below it, else above the first line), never on the passage's words.
    const w = sizes.compact;
    const clampX = (x) => Math.round(Math.max(NOTE_EDGE, Math.min(x, viewWidth() - w - NOTE_EDGE)));
    const clampY = (y) => Math.round(Math.max(NOTE_EDGE, Math.min(y, innerHeight - h0 - NOTE_EDGE)));
    const options = [
      { x: last.right + 6, y: last.top + (last.height - h0) / 2, fits: last.right + 6 + w <= viewWidth() - NOTE_EDGE },
      { x: last.left, y: last.bottom + 4, fits: true },
      { x: first.left, y: first.top - h0 - 4, fits: true },
    ];
    const onPassage = (box) => rects.some((r) => overlaps(box, asBox(r)));
    const fitsX = (box) => box.x + box.w <= viewWidth() - NOTE_EDGE;
    for (const o of options) {
      if (!o.fits) continue;
      const start = { x: clampX(o.x), y: clampY(o.y), w, h: h0 };
      // Beside the labels in the way, if the line has room...
      const beside = slide(start);
      if (fitsX(beside) && !clashWith(beside) && !onPassage(beside)) return { box: beside, place: 'd', compact: true };
      // ...else stacked below them, 4px apart.
      let box = start;
      for (let i = 0, t; i < 20 && (t = clashWith(box)); i++) box = { ...box, y: Math.round(t.y + t.h + GAP) };
      if (!clashWith(box) && !onPassage(box)) return { box, place: 'd', compact: true };
    }
    // Nothing free near the passage: stack below its last line until clear.
    let box = { x: clampX(last.left), y: Math.round(last.bottom + 4), w, h: h0 };
    for (let i = 0, t; i < 40 && (t = clashWith(box)); i++) box = { ...box, y: Math.round(t.y + t.h + GAP) };
    return { box, place: 'd', compact: true };
  }

  // Small write helpers: skip the write when nothing changed, so a frame where
  // nothing moved does not make the browser redo any layout.
  function setIfChanged(el, prop, value) { if (el[prop] !== value) el[prop] = value; }
  function setAttrIfChanged(el, name, value) { if (el.getAttribute(name) !== value) el.setAttribute(name, value); }
  function setStyleIfChanged(el, prop, value) {
    if (el.style.getPropertyValue(prop) !== value) el.style.setProperty(prop, value);
  }

  // ------------------------------------------------- emphasis (note <-> passage)

  /** Hovering or focusing a note outlines its passage (rings drawn in our own layer). */
  function setEmphasis(id) {
    if (state.emphasis === id) return;
    state.emphasis = id;
    scheduleLayout();
  }

  /** Thin rings around each line of the emphasised passage. Pointer-transparent; nothing is added to the page. */
  function drawRings() {
    const m = state.emphasis && state.markups.find((x) => x.id === state.emphasis);
    const res = m && state.resolved.get(m.id);
    // One ring per line: a passage crossing inline elements (bold, links) has
    // several boxes on the same line, merged here so the outline is not chopped up.
    const rects = [];
    for (const r of res ? rectsOf(res.range) : []) {
      const line = rects.find((l) => Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top) > Math.min(l.height, r.height) / 2);
      if (line) {
        line.left = Math.min(line.left, r.left); line.right = Math.max(line.right, r.right);
        line.top = Math.min(line.top, r.top); line.bottom = Math.max(line.bottom, r.bottom);
        line.width = line.right - line.left; line.height = line.bottom - line.top;
      } else if (rects.length < 40) {
        rects.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height });
      }
    }
    while (ringEls.length < rects.length) {
      const ring = h('div', { class: 'emph-ring', 'aria-hidden': 'true' });
      ringEls.push(ring);
      ui.notes.append(ring);
    }
    ringEls.forEach((ring, i) => {
      const r = rects[i];
      ring.hidden = !r;
      if (!r) return;
      ring.style.setProperty('--bar', barColour(m));
      ring.style.left = Math.round(r.left - 3) + 'px';
      ring.style.top = Math.round(r.top - 2) + 'px';
      ring.style.width = Math.round(r.width + 6) + 'px';
      ring.style.height = Math.round(r.height + 4) + 'px';
    });
  }

  /** Hovering a passage that has a note lifts its note. Checked once per frame at most. */
  let hoverPoint = null;
  let hoverQueued = false;
  function onPointerMove(e) {
    hoverPoint = { x: e.clientX, y: e.clientY };
    if (hoverQueued || !state.showNotes || !(marginEls.size || pinEls.size)) return;
    hoverQueued = true;
    requestAnimationFrame(() => {
      hoverQueued = false;
      let id = null;
      for (const m of state.markups) {
        if (!(m.note || '').trim() || !(marginEls.has(m.id) || pinEls.has(m.id))) continue;
        const res = state.resolved.get(m.id);
        if (res && rectsOf(res.range).some((r) => hoverPoint.x >= r.left && hoverPoint.x <= r.right && hoverPoint.y >= r.top && hoverPoint.y <= r.bottom)) { id = m.id; break; }
      }
      for (const [nid, el] of marginEls) el.classList.toggle('is-emph', nid === id);
      for (const [nid, el] of pinEls) el.classList.toggle('is-emph', nid === id);
    });
  }

  /** Reposition everything that floats, at most once per frame. */
  let layoutQueued = false;
  function scheduleLayout() {
    if (layoutQueued || !ui.host) return;
    layoutQueued = true;
    requestAnimationFrame(() => {
      layoutQueued = false;
      layoutNotes();
      placeToolbar();
      placeCard();
    });
  }

  // ------------------------------------------------------------- toast and chip

  let toastTimer;
  function showToast(message, opts = {}) {
    if (!ui.wrap) return;
    hideToast();
    const toast = h('div', { class: 'toast', role: opts.alert ? 'alert' : 'status' }, h('span', { class: 'msg' }, message));
    if (opts.action) {
      toast.append(h('button', { class: 'btn text', type: 'button', onclick: () => { hideToast(); opts.onAction(); } }, opts.action));
    }
    const arm = () => { clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, TOAST_LIFE); };
    // Give people time: the countdown pauses while the toast is hovered or focused.
    toast.addEventListener('mouseenter', () => clearTimeout(toastTimer));
    toast.addEventListener('focusin', () => clearTimeout(toastTimer));
    toast.addEventListener('mouseleave', arm);
    toast.addEventListener('focusout', arm);
    ui.toast = toast;
    ui.wrap.append(toast);
    raise();
    arm();
  }
  function hideToast() {
    clearTimeout(toastTimer);
    if (ui.toast) { ui.toast.remove(); ui.toast = null; }
  }

  /**
   * "N markups not found" chip. Shown only after the page has had a moment to
   * finish loading, so slow pages do not flash a false alarm. Every refresh
   * restarts the 1.5 s wait, so on a page that rewrites itself more often than
   * that the chip would never appear; CHIP_MAX_WAIT caps the wait. (It is
   * longer than the fast re-find attempts at load: 8 × 250 ms.)
   */
  const CHIP_MAX_WAIT = 2500;
  const updateChip = debounceMax(() => {
    if (!ui.wrap) return;
    const n = orphans().length;
    if (!n) {
      if (ui.chip) { ui.chip.remove(); ui.chip = null; }
      return;
    }
    if (!ui.chip) {
      ui.chip = h('button', { class: 'chip', type: 'button', onclick: openOrphanCard });
      ui.wrap.append(ui.chip);
    }
    ui.chip.textContent = n === 1 ? '1 markup not found' : `${n} markups not found`;
  }, 1500, CHIP_MAX_WAIT);

  // ------------------------------------------------------------------- events

  function onPointerUp(e) {
    if (state.dead || e.target === ui.host) return;
    const { clientX: x, clientY: y, button, altKey } = e;
    const target = e.target;
    // Wait a tick: the browser updates the selection after mouseup.
    setTimeout(() => {
      if (offerToolbar()) { closeCard(true); return; }
      closeToolbar();
      closeCard(true);
      if (button !== 0) return;
      // A plain click on marked text opens its card. Links and controls keep
      // their normal behaviour unless Alt is held.
      const el = elementOf(target);
      if (!altKey && el && el.closest('a[href], button, input, select, textarea, label, summary, [role="button"]')) return;
      const hit = markupAt(x, y);
      if (hit) openCard(hit.id, false);
    }, 0);
  }

  /** The most recently created markup whose painted area contains a point. */
  function markupAt(x, y) {
    for (let i = state.markups.length - 1; i >= 0; i--) {
      const res = state.resolved.get(state.markups[i].id);
      if (res && rectsOf(res.range).some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) return state.markups[i];
    }
    return null;
  }

  /**
   * Keyboard. Keys pressed inside our controls are stopped here, before the
   * page sees them, so typing a note cannot trigger the page's own single-key
   * shortcuts. (Registered on window in the capture phase, as early as possible.)
   */
  function onKey(e) {
    if (!ui.host) return;
    const inside = e.target === ui.host;
    if (e.type === 'keydown' && e.key === 'Escape' && (ui.toolbar || state.card)) {
      // Escape closes whatever is open, wherever the focus is.
      const active = ui.shadow.activeElement;
      closeToolbar();
      closeCard(true);
      if (active) active.blur();
      if (inside) { e.stopImmediatePropagation(); e.preventDefault(); }
      return;
    }
    if (!inside) {
      // Selecting with the keyboard (Shift+arrows) offers the toolbar too.
      if (e.type === 'keyup' && (e.key === 'Shift' || (e.shiftKey && e.key.startsWith('Arrow')))) {
        if (!offerToolbar()) closeToolbar();
      }
      return;
    }
    e.stopImmediatePropagation();
    if (e.type !== 'keydown' || !ui.toolbar) return;
    const active = ui.shadow.activeElement;
    if (!active || !ui.toolbar.contains(active)) return;
    const buttons = Array.from(ui.toolbar.querySelectorAll('button'));
    const i = buttons.indexOf(active);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % buttons.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + buttons.length) % buttons.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    else if (e.key === 'Tab') { closeToolbar(); return; }
    if (next >= 0) {
      e.preventDefault();
      buttons.forEach((b, n) => { b.tabIndex = n === next ? 0 : -1; });
      buttons[next].focus();
    }
  }

  /** Keyboard shortcuts declared in manifest.json, forwarded by background.js. */
  function onCommand(command) {
    if (state.dead || !ui.host) return;
    if (command === 'mark-selection') {
      if (!offerToolbar()) { showToast('Select some text first, then press the shortcut again.'); return; }
      const btn = ui.toolbar.querySelector('button[tabindex="0"]') || ui.toolbar.querySelector('button');
      btn.focus();
    } else if (command === 'next-note') {
      const withNotes = state.markups
        .filter((m) => (m.note || '').trim() && state.resolved.has(m.id))
        .sort((a, b) => state.resolved.get(a.id).range.compareBoundaryPoints(Range.START_TO_START, state.resolved.get(b.id).range));
      if (!withNotes.length) { showToast('There are no notes on this page.'); return; }
      const m = withNotes[state.nextNoteIndex % withNotes.length];
      state.nextNoteIndex = (state.nextNoteIndex + 1) % withNotes.length;
      const el = elementOf(state.resolved.get(m.id).range.startContainer);
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (el) el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      setTimeout(() => openCard(m.id, true), reduce ? 0 : 350);
    }
  }

  /** What the popup's "Check this page" shows: problems this script can detect itself. */
  function report() {
    let hidden = 0;
    let lowContrast = 0;
    for (const m of state.markups) {
      const res = state.resolved.get(m.id);
      if (!res) continue;
      if (!rectsOf(res.range).length) { hidden++; continue; }
      const c = palette.COLOURS[m.colour] || palette.COLOURS[palette.DEFAULT];
      const dark = res.bgLum < 0.30;
      if (m.kind === 'underline') {
        if (palette.contrast(palette.hexLuminance(dark ? c.light : c.ink), res.bgLum) < 3) lowContrast++;
      } else if (palette.contrast(palette.hexLuminance(dark ? c.dark : c.light), res.bgLum) < 1.15
        && palette.contrast(palette.hexLuminance(c.ink), res.bgLum) < 3) lowContrast++; // even the fallback underline is faint
    }
    return {
      ok: true,
      title: document.title,
      // PDF: the popup reads which document this is from the viewer, and
      // whether it has any text (the viewer sets "none" for a scan).
      ...(host() ? { key: pageUrl(), source: host().sourceUrl(), pdf: true, text: document.documentElement.dataset.wmtText || null } : {}),
      total: state.markups.length,
      underlines: state.markups.filter((m) => m.kind === 'underline').length,
      highlights: state.markups.filter((m) => m.kind !== 'underline').length,
      notes: state.markups.filter((m) => (m.note || '').trim()).length,
      notFound: orphans().length,
      hidden,
      lowContrast,
    };
  }

  // -------------------------------------------------------------------- print

  let printBlock = null;
  const printMarkers = [];

  /**
   * Before printing (or "Save as PDF"): switch markups to the paper-friendly
   * style and add the notes as a numbered list at the end of the document,
   * with a small matching number beside each annotated passage. Floating note
   * cards cannot print reliably (they cover text and split across pages).
   */
  function enterPrint() {
    if (state.printing || state.dead || !ui.host) return;
    state.printing = true;
    hideTip();
    clearVariants();
    paint();

    const noted = state.markups.filter((m) => (m.note || '').trim());
    if (!noted.length) return;
    const found = noted.filter((m) => state.resolved.has(m.id))
      .sort((a, b) => state.resolved.get(a.id).range.compareBoundaryPoints(Range.START_TO_START, state.resolved.get(b.id).range));
    const missing = noted.filter((m) => !state.resolved.has(m.id));

    // Numbered markers. Absolutely positioned with no offsets, so each sits at
    // its place in the text without taking up room: nothing reflows.
    found.forEach((m, i) => {
      const range = state.resolved.get(m.id).range;
      const end = range.endContainer;
      if (end.nodeType !== 3 || !end.parentNode) return;
      // Put the number right after the last marked word. That means splitting
      // the text node for the duration of the print; exitPrint() joins it again.
      let tail = null;
      if (range.endOffset > 0 && range.endOffset < end.data.length) tail = end.splitText(range.endOffset);
      const marker = document.createElement('span');
      marker.setAttribute('data-wmt-marker', '');
      marker.setAttribute('aria-hidden', 'true');
      marker.textContent = String(i + 1);
      marker.style.cssText = ['all:initial', 'position:absolute', 'margin:-0.75em 0 0 1px', 'font:700 7pt/1 system-ui,sans-serif',
        'color:#000', 'background:#fff', 'border:0.5pt solid #000', 'border-radius:2pt', 'padding:0.5pt 1.5pt']
        .map((d) => d + ' !important').join(';');
      end.parentNode.insertBefore(marker, end.nextSibling);
      printMarkers.push({ marker, end, tail });
    });

    printBlock = document.createElement('wmt-print');
    printBlock.style.cssText = 'all:initial !important;display:block !important;';
    const shadow = printBlock.attachShadow({ mode: state.testMode ? 'open' : 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      .notes { font: 10pt/14pt system-ui, sans-serif; color: #000; background: #fff; margin: 24pt 0 0; padding: 12pt 0 0; border-top: 1pt solid #000; }
      h2 { font: 700 12pt/16pt system-ui, sans-serif; margin: 0; }
      h3 { font: 700 10pt/14pt system-ui, sans-serif; margin: 12pt 0 0; }
      .src { margin: 0 0 8pt; color: #333; overflow-wrap: anywhere; }
      .item { display: flex; gap: 6pt; margin: 6pt 0 0; break-inside: avoid; }
      .num { min-width: 16pt; font-weight: 700; }
      .chip { display: inline-block; width: 3pt; align-self: stretch; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      q { display: block; color: #333; overflow-wrap: anywhere; }
      p { margin: 2pt 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    `);
    shadow.adoptedStyleSheets = [sheet];
    const item = (m, n) => {
      const quote = (m.anchor && m.anchor.quote && m.anchor.quote.exact) || '';
      const chip = h('span', { class: 'chip' });
      chip.style.background = (palette.COLOURS[m.colour] || palette.COLOURS[palette.DEFAULT]).ink;
      return h('div', { class: 'item' }, h('span', { class: 'num' }, n), chip,
        h('div', {}, quote ? h('q', {}, quote.length > 200 ? quote.slice(0, 200) + '…' : quote) : null, h('p', {}, m.note)));
    };
    const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long' }).format(new Date());
    const block = h('div', { class: 'notes' },
      h('h2', {}, 'Notes on this page'),
      h('p', { class: 'src' }, `${host() ? host().sourceLabel() : location.host + location.pathname} · printed ${date}`)); // PDF: the PDF's address
    found.forEach((m, i) => block.append(item(m, String(i + 1))));
    if (missing.length) {
      block.append(h('h3', {}, 'Notes whose text was not found'));
      missing.forEach((m) => block.append(item(m, '–')));
    }
    shadow.append(block);
    document.body.append(printBlock);
  }

  function exitPrint() {
    if (!state.printing) return;
    for (const { marker, end, tail } of printMarkers.splice(0)) {
      marker.remove();
      // Rejoin the text we split, restoring the page's original text node.
      // Any markup that started in the split-off part is found again by refresh().
      if (tail && tail.parentNode && tail.previousSibling === end) {
        end.appendData(tail.data);
        tail.remove();
      }
    }
    if (printBlock) { printBlock.remove(); printBlock = null; }
    state.printing = false;
    state.index = null;
    clearVariants();
    refresh();
  }

  // -------------------------------------------------------------------- start

  // Registered straight away (the script runs at document_start) so these are
  // the first key listeners on the page.
  for (const type of ['keydown', 'keyup', 'keypress']) window.addEventListener(type, onKey, true);

  async function init() {
    if (document.contentType !== 'text/html' && document.contentType !== 'application/xhtml+xml') return; // PDFs, images, etc.
    if (!document.body || !alive()) return;
    if (!('highlights' in CSS)) return; // browser too old (manifest sets a minimum version anyway)

    try {
      const local = await chrome.storage.local.get('wmt:testMode');
      state.testMode = local['wmt:testMode'] === true;
      const sync = await chrome.storage.sync.get(['colour', 'showNotes']);
      if (palette.isColour(sync.colour)) state.colour = sync.colour;
      state.showNotes = sync.showNotes !== false; // on unless switched off
    } catch (e) { /* defaults are fine */ }

    buildUi();

    document.addEventListener('mouseup', onPointerUp, true);
    // Hovering a passage with a note lifts its note (checked at most once a frame).
    document.addEventListener('mousemove', onPointerMove, { capture: true, passive: true });
    document.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0];
      if (t) onPointerUp({ target: e.target, clientX: t.clientX, clientY: t.clientY, button: 0, altKey: false });
    }, { capture: true, passive: true });

    // Anything that floats follows the text when the page or an inner panel scrolls.
    window.addEventListener('scroll', scheduleLayout, { capture: true, passive: true });
    window.addEventListener('resize', scheduleLayout, { passive: true });
    document.addEventListener('click', scheduleLayout, { capture: true, passive: true }); // tabs, accordions
    new ResizeObserver(scheduleLayout).observe(document.documentElement);

    // Page content changed: forget the cached text and re-check (debounced).
    // Changes inside our own sealed UI are not visible to this observer.
    // PDF: the viewer says "page text appeared" (look for waiting marks now,
    // not at the next slow retry), or with detail.all "the pages were swapped"
    // (the print copy replaces the screen pages, and back): find every mark again.
    window.addEventListener('wmt-host-refresh', (e) => {
      if (e.detail && e.detail.all) { state.resolved.clear(); clearVariants(); }
      state.index = null;
      state.lastOrphanTry = 0;
      refresh();
    });

    new MutationObserver(() => {
      if (state.printing) return;
      state.index = null;
      // A markup's text was swapped out: re-find it before the next frame so it does not blink.
      if (anyDetached()) refreshBeforeNextFrame();
      else scheduleRefresh();
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

    // Theme switches (class/style changes on <html> or <body>) can turn a light page dark.
    const retheme = debounce(() => { updateTheme(); clearVariants(); paint(); }, 250);
    const themeObserver = new MutationObserver(retheme);
    for (const el of [document.documentElement, document.body]) {
      themeObserver.observe(el, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-mode', 'data-color-scheme'] });
    }
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', retheme);

    // Single-page apps: the address can change without a page load.
    window.addEventListener('popstate', () => setTimeout(refresh, 0));
    window.addEventListener('hashchange', () => setTimeout(refresh, 0));
    setInterval(() => { if (!state.dead && !state.printing) checkUrlChanged(); }, 1000);

    // Another tab (or this one) saved a change: redraw from the stored copy.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (state.dead) return;
      if (area === 'local' && changes[state.key]) {
        const page = changes[state.key].newValue;
        applyMarkups((page && page.markups) || []);
      }
      if (area === 'sync' && changes.colour && palette.isColour(changes.colour.newValue)) state.colour = changes.colour.newValue;
      // The popup's "Show notes on the page" switch: applied straight away.
      if (area === 'sync' && changes.showNotes) { state.showNotes = changes.showNotes.newValue !== false; scheduleLayout(); }
    });

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || sender.id !== chrome.runtime.id) return false;
      if (msg.type === 'wmt.check') sendResponse(report());
      // PDF: the viewer draws every page for print first (host.print).
      else if (msg.type === 'wmt.print') { sendResponse({ ok: true }); setTimeout(() => (host() ? host().print() : window.print()), 100); }
      else if (msg.type === 'wmt.showNotFound') { openOrphanCard(); sendResponse({ ok: true }); }
      else if (msg.type === 'wmt.command') { onCommand(msg.command); sendResponse({ ok: true }); }
      return false;
    });

    window.addEventListener('beforeprint', enterPrint);
    window.addEventListener('afterprint', exitPrint);
    matchMedia('print').addEventListener('change', (e) => (e.matches ? enterPrint() : exitPrint()));

    // Do not lose the last few keystrokes of a note when the page is closed.
    window.addEventListener('pagehide', () => { if (state.card) state.card.flush(); });

    await loadPage();
    if (state.testMode) document.documentElement.setAttribute('data-wmt-ready', '1');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();

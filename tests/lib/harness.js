/**
 * tests/lib/harness.js
 * Reusable helpers for driving the "Web Page Markup Tool" extension (version 2)
 * in a real Chromium browser: launch with the extension loaded, select text
 * with the mouse, press the toolbar buttons, read what was painted and saved.
 *
 * ---------------------------------------------------------------------------
 * EVERYTHING THAT DEPENDS ON THE EXTENSION'S OWN MARKUP LIVES IN THIS FIRST
 * BLOCK. When the extension's UI is redesigned, edit SELECTORS / STORAGE /
 * COPY_FORMAT / HIGHLIGHT_NAME here and the checks keep working.
 * ---------------------------------------------------------------------------
 */

const SELECTORS = {
  // The extension's single UI element, a child of <html>. Its presence proves the content script ran.
  host: 'wmt-root',
  // Attribute the content script sets on <html> (test mode only) once saved markups are loaded.
  readyAttr: 'data-wmt-ready',
  // Everything below is INSIDE the host's shadow root (open only in test mode).
  wrap: '.wmt',                 // wrapper; its data-theme is "light" or "dark"
  toolbar: '.toolbar',          // floating toolbar shown after a text selection
  toolbarButtons: {             // by the action name used in clickToolbar(page, action)
    highlight: 'button[data-colour="yellow"]',
    underline: 'button[data-action="underline"]',
    note: 'button[data-action="note"]',
  },
  toolbarColour: 'button[data-colour="{colour}"]', // {colour} is replaced by yellow, green, blue, pink or purple
  toolbarAnyButton: 'button',
  card: '.card',                // note card (role=dialog)
  cardTextarea: 'textarea',
  cardStatus: '.status',        // "Saving…" then "Saved"
  cardDelete: 'button[data-action="delete"]',
  cardClose: 'button[data-action="close"]',
  pin: '.pin',                  // one per markup that has a note, shown while its card is closed
  pinIdAttr: 'data-id',
  // Notes shown on the page (setting "Show notes on the page", on by default).
  marginNote: '.margin-note',   // the note's text in free space beside its passage
  marginText: '.mn-text',
  label: '.pin.label',          // short label used where there is no free gutter; data-place = a|b|c|d
  placeAttr: 'data-place',
  emphClass: 'is-emph',         // on a note/label while its passage is hovered
  emphRing: '.emph-ring',       // outlines the passage while the note is hovered
  toast: '.toast',
  toastAction: '.toast button', // "Undo" after a delete
  chip: '.chip',
  uiColourSample: '[data-colour]', // colour swatch buttons (samples of colour, not text or icons)                // "N markups not found"
  // Print-only additions to the page.
  printBlock: 'wmt-print',
  printMarker: 'span[data-wmt-marker]',
  // Popup (opened as chrome-extension://<id>/popup.html).
  popup: {
    page: 'popup.html',
    countLine: '#countLine',
    breakdown: '#breakdown',
    copyButton: '#copyBtn',
    jsonButton: '#jsonBtn',
    printButton: '#printBtn',
    checkList: '#checkList',
    status: '#status',
    message: '#message',
    showNotes: '#showNotes',    // "Show notes on the page" checkbox
    // "Leave a review" panel, shown on some opens (lib/review.js).
    reviewPanel: '#reviewPanel',
    reviewStar: '[data-star="{n}"]', // {n} is 1 to 5
    reviewLater: '#reviewLater',     // "Remind me later"
    reviewNever: '#reviewNever',     // "Don't ask again"
    title: '#popupTitle',            // the popup's heading; focus moves here when the review panel closes
  },
  // chrome.storage.local keys behind the review panel.
  reviewKeys: { opens: 'wmt:popupOpens', status: 'wmt:reviewStatus' },
  // Where every star sends the person.
  reviewUrl: 'https://chromewebstore.google.com/detail/lpoedmhdgkmngpgiodimgefgcglgcbpk/reviews',
};

/** Elements the extension itself adds to a host page (never counted as page content). */
const OWNED_SELECTORS = [SELECTORS.host, SELECTORS.printBlock, SELECTORS.printMarker];

/** Storage key that switches the extension into test mode (open shadow root, ready attribute). */
const TEST_MODE_KEY = 'wmt:testMode';

/**
 * Markups are painted through the browser's CSS highlight registry
 * (CSS.highlights) under names like "wmt-hl-yellow-lf" or "wmt-ul-pink-d".
 * This turns such a name into its parts, or returns null for names that are not ours.
 *   kind: highlight | underline; variant: l, lf, lc, d, df (see the extension's styles.css)
 */
const HIGHLIGHT_PREFIX = 'wmt-';
function parseHighlightName(name) {
  const m = /^wmt-(hl|ul)-([a-z]+)-([a-z]+)$/.exec(name);
  if (!m) return null;
  return { kind: m[1] === 'hl' ? 'highlight' : 'underline', colour: m[2], variant: m[3] };
}

/** How the extension saves its data in chrome.storage.local (version 2 shape). */
const STORAGE = {
  /** Storage key for a page address ("page:" + address without #fragment and tracking parameters). */
  keyFor(url) { return urlLib.pageKey(url); },
  /** The saved markups for one page, as an array of { id, kind, colour, note, anchor }. */
  markupsFor(stored, url) {
    const entry = stored && stored[urlLib.pageKey(url)];
    return entry && Array.isArray(entry.markups) ? entry.markups : [];
  },
  /** The words a saved markup was made on. */
  quoteOf(markup) { return (markup.anchor && markup.anchor.quote && markup.anchor.quote.exact) || ''; },
};

/**
 * The text "Copy as Markdown" should put on the clipboard (mirrors toMarkdown in popup.js).
 * rows = [{ text, note, kind, colour }] in saved order. The "Exported:" line carries the
 * time of day, so compare with stripExportTime() applied to both sides.
 */
const COPY_FORMAT = (title, url, rows) => {
  const lines = [`# Markups: ${title}`, `Source: ${url}`, 'Exported: <time>', ''];
  rows.forEach((row, i) => {
    lines.push(`${i + 1}. > ${String(row.text).replace(/\s+/g, ' ').trim() || '(text not recorded)'}`);
    if ((row.note || '').trim()) lines.push(`   Note: ${row.note.replace(/\n/g, '\n   ')}`);
    lines.push(`   ${row.kind === 'underline' ? 'Underline' : 'Highlight'}, ${row.colour}`, '');
  });
  return lines.join('\n');
};
const stripExportTime = (s) => String(s).replace(/^Exported: .*$/m, 'Exported: <time>');

// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright-core');
const { installPageHelpers } = require('./page-helpers');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EXTENSION_DIR = REPO_ROOT; // the unpacked extension is the repo root (manifest.json lives there)
const OUTPUT_DIR = path.join(REPO_ROOT, 'tests', 'output');
const SCREENSHOT_DIR = path.join(OUTPUT_DIR, 'screenshots');
const PRINT_DIR = path.join(OUTPUT_DIR, 'print');
// System Chromium. There are no "Chrome for Testing" downloads for Linux arm64, so never `playwright install`.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

// The extension's own address rules and colour table, read (never changed) so the harness
// uses exactly the same page keys and expected colours as the extension.
const urlLib = require(path.join(EXTENSION_DIR, 'lib', 'url.js'));
const palette = require(path.join(EXTENSION_DIR, 'lib', 'palette.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The extension's service worker (background.js). Chromium may stop it when idle; this finds or waits for it. */
async function getWorker(session, timeout = 5000) {
  const mine = () => session.context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
  let worker = mine();
  if (worker) return worker;
  // Asleep: loading any extension page wakes it up.
  if (session.extensionId) {
    const p = await session.context.newPage();
    try {
      const wait = session.context.waitForEvent('serviceworker', { timeout }).catch(() => null);
      await p.goto(`chrome-extension://${session.extensionId}/${SELECTORS.popup.page}`).catch(() => {});
      await p.evaluate(() => chrome.runtime.sendMessage({ type: 'page.get', url: 'http://wake.invalid/' }).catch(() => null)).catch(() => {});
      worker = mine() || (await wait);
    } finally {
      await p.close().catch(() => {});
    }
  } else {
    worker = await session.context.waitForEvent('serviceworker', { timeout }).catch(() => null);
  }
  if (!worker) throw new Error('The extension\'s service worker (background.js) did not start. Is the extension loaded?');
  return worker;
}

/** Run a function inside the service worker, retrying once if the worker had gone to sleep. */
async function inWorker(session, fn, arg) {
  try {
    return await (await getWorker(session)).evaluate(fn, arg);
  } catch (e) {
    await sleep(200);
    return (await getWorker(session)).evaluate(fn, arg);
  }
}

/**
 * Start Chromium with the extension loaded.
 *
 * HOW THE EXTENSION GETS LOADED (verified on Chromium 158, Linux arm64):
 *   - a persistent context is required (extensions do not load in incognito-style contexts);
 *   - Playwright is told `headless: false` so it does not pick its own headless mode,
 *     and Chromium's "new headless" is switched on with the `--headless=new` argument.
 *     New headless is the full browser without a window, so extensions work in it;
 *   - `--load-extension` + `--disable-extensions-except` point at the repo folder;
 *   - the extension id is read from the service worker's address;
 *   - test mode is switched on from inside the service worker BEFORE any page is opened.
 *
 * opts.headed      watch it in a real window
 * opts.profileDir  reuse an existing browser profile (default: a fresh throwaway one)
 * opts.keepProfile do not delete the profile on close (so a later launch can reuse it)
 * opts.testMode    false = leave test mode off (default true)
 *
 * @returns {Promise<object>} session: { context, extensionId, mode, launchInfo, profileDir, close() }
 */
async function launch(opts = {}) {
  const headed = !!opts.headed;
  const viewport = opts.viewport || DEFAULT_VIEWPORT;
  const profileDir = opts.profileDir || fs.mkdtempSync(path.join(os.tmpdir(), 'markup-harness-'));
  const args = [
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(headed ? [] : ['--headless=new']),
  ];
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: CHROMIUM_PATH,
      headless: false, // see the comment above: real headless comes from --headless=new
      args,
      viewport,
    });
  } catch (e) {
    if (!opts.keepProfile && !opts.profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
    throw new Error(`Could not start Chromium at ${CHROMIUM_PATH}: ${e.message.split('\n')[0]}`);
  }
  // Measuring helpers available in every page as window.__mh (see page-helpers.js).
  await context.addInitScript(installPageHelpers, OWNED_SELECTORS);
  // Let pages read/write the clipboard without a permission prompt (used by the popup check).
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});

  const session = {
    context,
    viewport,
    profileDir,
    mode: headed ? 'headed' : 'headless (--headless=new)',
    launchInfo: { executablePath: CHROMIUM_PATH, args, headed, browserVersion: context.browser() ? context.browser().version() : null },
    extensionId: null,
    extensionIdHow: 'read from the address of the extension\'s service worker (background.js)',
    workerErrors: [], // console errors logged by the service worker
    async close() {
      await context.close().catch(() => {});
      if (!opts.keepProfile) fs.rmSync(profileDir, { recursive: true, force: true });
    },
  };
  try {
    const worker = await getWorker(session, 8000);
    session.extensionId = new URL(worker.url()).host;
    // Collect anything the service worker logs as an error, for the console check.
    const watch = (w) => {
      try {
        w.on('console', (msg) => {
          if (msg.type() === 'error') session.workerErrors.push({ where: 'service worker', kind: 'console.error', text: msg.text().slice(0, 500), url: w.url(), fromExtension: true });
        });
      } catch (e) { /* older Playwright: no worker console events */ }
    };
    watch(worker);
    context.on('serviceworker', watch);
    if (opts.testMode !== false) {
      await inWorker(session, (key) => chrome.storage.local.set({ [key]: true }), TEST_MODE_KEY);
    }
  } catch (e) {
    await session.close();
    throw e;
  }
  return session;
}

/** The browser's own id for the tab showing `page` (needed so the popup can talk to that tab). */
async function tabIdOf(session, page) {
  await page.bringToFront().catch(() => {});
  const title = await page.title();
  return inWorker(session, async (wantTitle) => {
    const tabs = await chrome.tabs.query({});
    const matches = [];
    for (const t of tabs) {
      // Without the "tabs" permission addresses are hidden, so ask each tab's content script who it is.
      try {
        const reply = await chrome.tabs.sendMessage(t.id, { type: 'wmt.check' });
        if (reply && reply.title === wantTitle) matches.push(t);
      } catch (e) { /* no content script in that tab */ }
    }
    const best = matches.find((t) => t.active) || matches[0];
    return best ? best.id : null;
  }, title);
}

/**
 * Open the extension's popup as an ordinary tab.
 *
 * A real popup asks the browser "which tab am I attached to?". Opened as a tab
 * it would get itself as the answer, so when `forPage` is given the harness
 * answers that one question on the popup's behalf with the real tab of the
 * page under test (real tab id, so the popup's messages reach that page).
 * `forUrl` alone fakes only the address (used to show the popup a PDF address).
 * `tab` gives the whole tab object to answer with (for tabs with no content
 * script to ask, such as Chrome's PDF tab or the extension's PDF viewer).
 * It also records whatever the popup writes to the clipboard (`getCopied`).
 * Everything else is the popup's own untouched code.
 */
async function openPopup(session, opts = {}) {
  let tab = opts.tab || null;
  if (opts.forPage) {
    tab = { id: await tabIdOf(session, opts.forPage), url: opts.forPage.url(), title: await opts.forPage.title(), active: true };
  } else if (opts.forUrl) {
    tab = { id: -1, url: opts.forUrl, title: '', active: true };
  }
  const popup = await session.context.newPage();
  await popup.addInitScript((fakeTab) => {
    window.__copied = [];
    try {
      const realWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async (text) => {
        window.__copied.push(String(text));
        return realWrite(text);
      };
    } catch (e) { window.__copyHookError = String(e); }
    if (fakeTab && window.chrome && chrome.tabs) {
      const realQuery = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async (q) => {
        if (q && q.active && q.currentWindow) return [fakeTab];
        return realQuery(q);
      };
    }
  }, tab);
  await popup.goto(`chrome-extension://${session.extensionId}/${SELECTORS.popup.page}`);
  popup.getCopied = () => popup.evaluate(() => window.__copied);
  popup.tabId = tab ? tab.id : null;
  return popup;
}

/**
 * Read everything the extension has saved (chrome.storage.local), via its service worker.
 * @param {object} session the object returned by launch()
 * @returns {Promise<object>} the whole storage object
 */
async function getStored(session) {
  return inWorker(session, () => chrome.storage.local.get(null));
}

/** Write directly into the extension's storage (used to seed old-format data for the migration check). */
async function setStored(session, obj) {
  return inWorker(session, (o) => chrome.storage.local.set(o), obj);
}

/** Remove keys from the extension's storage. */
async function removeStored(session, keys) {
  return inWorker(session, (k) => chrome.storage.local.remove(k), keys);
}

/**
 * True once the content script is running: its host element exists and it has
 * finished loading the page's saved markups (the ready attribute, test mode only).
 */
async function isInjected(page, timeout = 3000) {
  try {
    await page.waitForSelector(`html[${SELECTORS.readyAttr}="1"]`, { state: 'attached', timeout });
    return (await page.locator(SELECTORS.host).count()) > 0;
  } catch (e) {
    return false;
  }
}

/** What exists so far, for explaining a failed isInjected(). */
async function injectionState(page) {
  return page.evaluate(([S]) => {
    const host = document.querySelector(S.host);
    return {
      hostExists: !!host,
      shadowOpen: !!(host && host.shadowRoot),
      ready: document.documentElement.getAttribute(S.readyAttr),
      contentType: document.contentType,
    };
  }, [SELECTORS]).catch(() => ({}));
}

const normaliseText = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * Select text inside an element the way a person does: press the mouse at the
 * first character, drag to the last, release.
 *
 * If a real drag cannot produce exactly that selection (the text is under a
 * sticky header, inside a link that starts a drag-and-drop, unselectable...)
 * it falls back to setting the selection in code and firing a `mouseup`
 * event, and says so in the result.
 *
 * @param {import('playwright-core').Page} page
 * @param {string} cssSelector element that contains the text
 * @param {{startOffset?:number, endOffset?:number, slot?:number, slots?:number}} [opts]
 *        character offsets into the element's text; when omitted a short phrase is chosen
 *        automatically (slot/slots pick different, non-overlapping phrases).
 * @returns {Promise<{ok:boolean, method:'drag'|'range-fallback'|'none', why:string|null,
 *                    text:string, startOffset:number, endOffset:number, rects:object[]}>}
 */
async function selectText(page, cssSelector, opts = {}) {
  const result = { ok: false, method: 'none', why: null, text: '', startOffset: opts.startOffset, endOffset: opts.endOffset, rects: [] };
  let handle;
  try {
    handle = await page.locator(cssSelector).first().elementHandle({ timeout: opts.timeout || 3000 });
  } catch (e) {
    result.why = `no element matches ${cssSelector}`;
    return result;
  }
  if (result.startOffset === undefined || result.endOffset === undefined) {
    const slice = await handle.evaluate((el, [slot, slots]) => window.__mh.pickSlice(el, slot, slots), [opts.slot || 0, opts.slots || 1]);
    if (!slice) {
      result.why = 'the element has no selectable text (empty, or its text lives in a form control)';
      return result;
    }
    result.startOffset = slice.startOffset;
    result.endOffset = slice.endOffset;
  }
  const offsets = [result.startOffset, result.endOffset];

  // Bring the text on screen, then let scroll handlers settle (the extension repositions its controls after a scroll).
  await handle.evaluate((el, [s, e]) => window.__mh.revealText(el, s, e), offsets);
  await sleep(opts.settleMs === undefined ? 250 : opts.settleMs);

  const plan = await handle.evaluate((el, [s, e]) => window.__mh.dragPlan(el, s, e), offsets);
  if (!plan.ok) {
    result.why = plan.why;
    return result;
  }
  result.text = plan.expected;
  result.rects = plan.rects;
  const wanted = normaliseText(plan.expected);

  // Start from a clean slate: dragging on text that is already selected would start a drag-and-drop instead.
  await page.evaluate(() => window.getSelection().removeAllRanges());

  let fallbackWhy = null;
  if (plan.fromBlocked || plan.toBlocked) {
    fallbackWhy = plan.fromBlocked ? `start of the text is ${plan.fromBlocked}` : `end of the text is ${plan.toBlocked}`;
  } else {
    await page.mouse.move(plan.from.x, plan.from.y);
    await page.mouse.down();
    await page.mouse.move((plan.from.x + plan.to.x) / 2, (plan.from.y + plan.to.y) / 2, { steps: 4 });
    await page.mouse.move(plan.to.x, plan.to.y, { steps: 4 });
    await page.mouse.up();
    await sleep(60);
    const got = await page.evaluate(() => window.__mh.selectionInfo());
    if (normaliseText(got.text) !== wanted) {
      fallbackWhy = got.collapsed
        ? 'a real mouse drag selected nothing'
        : `a real mouse drag selected "${normaliseText(got.text).slice(0, 40)}" instead of "${wanted.slice(0, 40)}"`;
    }
  }

  if (!fallbackWhy) {
    result.ok = true;
    result.method = 'drag';
    return result;
  }
  // Fallback: set the selection in code and fire mouseup.
  result.method = 'range-fallback';
  result.why = fallbackWhy;
  await handle.evaluate((el, [s, e]) => window.__mh.selectByRange(el, s, e), offsets);
  await sleep(60);
  const got = await page.evaluate(() => window.__mh.selectionInfo());
  result.ok = normaliseText(got.text) === wanted;
  if (!result.ok) result.why += '; setting the selection in code did not work either';
  return result;
}

/** Wait for the extension's toolbar to appear. Returns a description of it, or null if it never shows. */
async function waitForToolbar(page, timeout = 1500) {
  try {
    await page.locator(`${SELECTORS.host} ${SELECTORS.toolbar}`).first().waitFor({ state: 'attached', timeout });
  } catch (e) {
    return null;
  }
  // The toolbar is positioned on the next animation frame; give it that frame.
  await sleep(50);
  return getToolbar(page);
}

/** Describe the toolbar right now: where it is, which buttons it has, whether it is really visible. */
async function getToolbar(page) {
  return page.evaluate((S) => {
    const host = document.querySelector(S.host);
    const tb = host && host.shadowRoot && host.shadowRoot.querySelector(S.toolbar);
    if (!tb) return null;
    const r = tb.getBoundingClientRect();
    const buttons = {};
    for (const [action, sel] of Object.entries(S.toolbarButtons)) buttons[action] = !!tb.querySelector(sel);
    // What is the top-most thing at the toolbar's centre? If it is not the toolbar, something covers it.
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const top = cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight ? window.__mh.deepElementFromPoint(cx, cy) : null;
    const cs = getComputedStyle(tb);
    const active = host.shadowRoot.activeElement;
    return {
      rect: window.__mh.plainRect(r),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      buttons,
      buttonCount: tb.querySelectorAll(S.toolbarAnyButton).length,
      // Which button has the keyboard focus, described by its colour or action.
      focused: active && tb.contains(active) ? (active.dataset.colour || active.dataset.action || 'button') : null,
      topElement: top ? window.__mh.label(top) : null,
      onTop: !!top && tb.contains(top),
      visible: cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0 && r.width > 0 && r.height > 0,
    };
  }, SELECTORS);
}

/**
 * Click a toolbar button with a real mouse click.
 * @param {'highlight'|'underline'|'note'} action  ("highlight" uses yellow; pass opts.colour for another)
 * @returns {Promise<{ok:boolean, why:string|null}>}
 */
async function clickToolbar(page, action, opts = {}) {
  const sel = action === 'highlight' && opts.colour ? SELECTORS.toolbarColour.replace('{colour}', opts.colour) : SELECTORS.toolbarButtons[action];
  if (!sel) throw new Error(`Unknown toolbar action "${action}". Known: ${Object.keys(SELECTORS.toolbarButtons).join(', ')}`);
  const button = page.locator(`${SELECTORS.host} ${SELECTORS.toolbar} ${sel}`);
  if ((await button.count()) === 0) return { ok: false, why: `the toolbar has no "${action}" button (${sel})` };
  try {
    await button.first().click({ timeout: 2500 });
    return { ok: true, why: null };
  } catch (e) {
    return { ok: false, why: `the "${action}" button could not be clicked (hidden, covered by the page, or off screen)` };
  }
}

/**
 * Read what the extension is painting: one entry per range it has registered
 * in the browser's highlight registry (CSS.highlights) under its own names.
 *   name     registry name, e.g. "wmt-hl-yellow-lf"
 *   kind     highlight | underline;  colour, variant: from the name
 *   text     the words the range covers
 *   rects    where those words are on screen (viewport coordinates, one per line of text)
 * There are no ids here: the registry only knows ranges. Ids live in storage.
 */
async function getMarkups(page) {
  const raw = await page.evaluate((prefix) => {
    const out = [];
    if (!('highlights' in CSS)) return out;
    for (const [name, highlight] of CSS.highlights) {
      if (!name.startsWith(prefix)) continue;
      for (const range of highlight) {
        out.push({
          name,
          text: range.toString(),
          collapsed: range.collapsed,
          connected: range.startContainer.isConnected && range.endContainer.isConnected,
          rects: window.__mh.rangeTextRects(range),
          container: window.__mh.label(range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement),
        });
      }
    }
    return out;
  }, HIGHLIGHT_PREFIX);
  return raw.map((r) => ({ ...r, ...(parseHighlightName(r.name) || { kind: null, colour: null, variant: null }) }));
}

/**
 * Describe the rest of the extension's UI: the open note card, the note pins,
 * the toast and the "not found" chip. Each is null / empty when absent.
 */
async function getUi(page) {
  return page.evaluate((S) => {
    const host = document.querySelector(S.host);
    const root = host && host.shadowRoot;
    if (!root) return { host: !!host, open: false, card: null, pins: [], margins: [], rings: [], toast: null, chip: null, theme: null };
    const rectOf = (el) => window.__mh.plainRect(el.getBoundingClientRect());
    const shown = (el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return !el.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0 && r.width > 0 && r.height > 0;
    };
    const onTop = (el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) return { inWindow: false, onTop: false, top: null };
      const top = window.__mh.deepElementFromPoint(cx, cy);
      return { inWindow: true, onTop: !!top && el.contains(top), top: top ? window.__mh.label(top) : null };
    };
    const cardEl = root.querySelector(S.card);
    let card = null;
    if (cardEl) {
      const ta = cardEl.querySelector(S.cardTextarea);
      const st = cardEl.querySelector(S.cardStatus);
      card = {
        rect: rectOf(cardEl), shown: shown(cardEl), ...onTop(cardEl),
        title: (cardEl.getAttribute('aria-label') || '').trim(),
        hasTextarea: !!ta, text: ta ? ta.value : null, status: st ? st.textContent.trim() : null,
        // Focus inside a shadow root is only visible through shadowRoot.activeElement.
        focused: !!ta && root.activeElement === ta && document.activeElement === host,
        hasDelete: !!cardEl.querySelector(S.cardDelete),
        bodyText: cardEl.textContent.replace(/\s+/g, ' ').trim().slice(0, 600),
      };
    }
    // Visible text as a person reads it (spans the label hides with CSS are left out).
    const readText = (el) => (el.innerText || '').replace(/\s+/g, ' ').trim();
    const pins = Array.from(root.querySelectorAll(S.pin)).map((p) => ({
      id: p.getAttribute(S.pinIdAttr), rect: rectOf(p), shown: shown(p), ...onTop(p),
      label: p.classList.contains('label'), compact: p.classList.contains('compact'),
      place: p.getAttribute(S.placeAttr), text: readText(p), emph: p.classList.contains(S.emphClass),
      aria: p.getAttribute('aria-label') || '',
    }));
    const margins = Array.from(root.querySelectorAll(S.marginNote)).map((m) => {
      const t = m.querySelector(S.marginText);
      return {
        id: m.getAttribute(S.pinIdAttr), rect: rectOf(m), shown: shown(m), ...onTop(m),
        text: t ? t.textContent.replace(/\s+/g, ' ').trim() : '', narrow: m.classList.contains('narrow'),
        emph: m.classList.contains(S.emphClass), aria: m.getAttribute('aria-label') || '',
      };
    });
    const rings = Array.from(root.querySelectorAll(S.emphRing)).filter(shown).map(rectOf);
    const toastEl = root.querySelector(S.toast);
    const chipEl = root.querySelector(S.chip);
    const wrap = root.querySelector(S.wrap);
    return {
      host: true, open: true, card, pins, margins, rings,
      toast: toastEl ? { text: toastEl.textContent.replace(/\s+/g, ' ').trim(), hasAction: !!root.querySelector(S.toastAction) } : null,
      chip: chipEl ? { text: chipEl.textContent.trim(), shown: shown(chipEl) } : null,
      theme: wrap ? wrap.dataset.theme || null : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  }, SELECTORS);
}

/**
 * The on-page element that stands for a note: the margin note, or else the label or plain pin.
 * Returns { kind: 'margin' | 'label' | 'pin', ...facts } or null. A hidden one is returned only when
 * nothing shown exists, so callers can tell "hidden" from "absent".
 */
function noteElementFor(ui, id) {
  const cands = [
    ...(ui.margins || []).filter((m) => m.id === id).map((m) => ({ kind: 'margin', ...m })),
    ...ui.pins.filter((p) => p.id === id).map((p) => ({ kind: p.label ? 'label' : 'pin', ...p })),
  ];
  return cands.find((c) => c.shown) || cands[0] || null;
}

/** CSS selector (inside the shadow root) for the on-page element returned by noteElementFor(). */
function noteSelectorFor(el) {
  const base = el.kind === 'margin' ? SELECTORS.marginNote : el.kind === 'label' ? SELECTORS.label : SELECTORS.pin;
  return `${base}[${SELECTORS.pinIdAttr}="${el.id}"]`;
}

/**
 * Rectangles of every word on the page that is on screen right now (viewport coordinates), one per
 * line fragment, measured with Range rectangles. The extension's own elements are left out.
 * Words clipped away by an inner scroll box (overflow hidden/auto/scroll) are left out.
 */
async function pageTextRects(page) {
  return page.evaluate(() => {
    const out = [];
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const clippedBy = (node, r) => {
      for (let el = node.parentElement; el && el !== document.documentElement; el = el.parentElement) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return true;
        if (/(auto|scroll|hidden|clip)/.test(cs.overflowX + cs.overflowY) && el !== document.body) {
          const b = el.getBoundingClientRect();
          if (r.right <= b.left || r.left >= b.right || r.bottom <= b.top || r.top >= b.bottom) return true;
        }
      }
      return false;
    };
    for (const node of window.__mh.textNodes(document.body)) {
      if (!node.data.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue;
        if (clippedBy(node, r)) continue;
        out.push(window.__mh.plainRect(r));
      }
    }
    return out;
  });
}

/** Click something inside the extension's UI with a real mouse click. sel is relative to the shadow root. */
async function clickUi(page, sel, timeout = 2500) {
  const loc = page.locator(`${SELECTORS.host} ${sel}`);
  if ((await loc.count()) === 0) return { ok: false, why: `the extension shows no "${sel}" at the moment` };
  try {
    await loc.first().click({ timeout });
    return { ok: true, why: null };
  } catch (e) {
    return { ok: false, why: `"${sel}" could not be clicked (hidden, covered by the page, or off screen)` };
  }
}

/** Where characters [startOffset, endOffset) of an element are on screen right now (viewport coordinates). */
async function getTextRects(page, cssSelector, startOffset, endOffset) {
  const loc = page.locator(cssSelector).first();
  if ((await loc.count()) === 0) return null;
  return loc.evaluate((el, [s, e]) => window.__mh.textRects(el, s, e), [startOffset, endOffset]);
}

/**
 * Compare where the text is with where the extension drew.
 *  - every text rectangle must have a drawn rectangle whose four edges are within `tol` pixels;
 *  - a drawn rectangle that does not even touch the text is a "stray";
 *  - a drawn rectangle that sits within the text's area but matches no line is counted as
 *    "extra" (usually a duplicate box from an inline element) and reported, not failed.
 * @returns {{ok:boolean, summary:string, missing:number, stray:number, extra:number, worst:number}}
 */
function compareRects(textRects, drawnRects, tol = 2) {
  const out = { ok: false, summary: '', missing: 0, stray: 0, extra: 0, worst: 0, textRects: textRects ? textRects.length : 0, drawnRects: drawnRects.length };
  if (!textRects || textRects.length === 0) {
    out.summary = 'the marked text is no longer on the page (or is hidden), so there is nothing to line up with';
    return out;
  }
  if (drawnRects.length === 0) {
    out.missing = textRects.length;
    out.summary = 'nothing is drawn for this markup';
    return out;
  }
  const delta = (a, b) => Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.right - b.right), Math.abs(a.bottom - b.bottom));
  const matched = new Set();
  let worstMissing = 0;
  for (const t of textRects) {
    let best = Infinity;
    let bestIdx = -1;
    drawnRects.forEach((d, i) => {
      const dl = delta(t, d);
      if (dl < best) { best = dl; bestIdx = i; }
    });
    if (best <= tol) {
      matched.add(bestIdx);
      out.worst = Math.max(out.worst, best);
    } else {
      out.missing++;
      worstMissing = Math.max(worstMissing, best);
    }
  }
  // Area the text covers, grown by the tolerance.
  const box = {
    left: Math.min(...textRects.map((r) => r.left)) - tol, top: Math.min(...textRects.map((r) => r.top)) - tol,
    right: Math.max(...textRects.map((r) => r.right)) + tol, bottom: Math.max(...textRects.map((r) => r.bottom)) + tol,
  };
  drawnRects.forEach((d, i) => {
    if (matched.has(i)) return;
    // Duplicate of a matched rect (two boxes drawn on top of each other)?
    if (textRects.some((t) => delta(t, d) <= tol)) { out.extra++; return; }
    const inside = d.left >= box.left && d.right <= box.right && d.top >= box.top && d.bottom <= box.bottom;
    if (inside) out.extra++; else out.stray++;
  });
  out.ok = out.missing === 0 && out.stray === 0;
  const bits = [];
  if (out.missing) bits.push(`${out.missing} of ${textRects.length} text line(s) have no drawn box within ${tol}px (nearest is ${Math.round(worstMissing)}px off)`);
  if (out.stray) bits.push(`${out.stray} drawn box(es) lie outside the marked text`);
  if (out.extra) bits.push(`${out.extra} extra box(es) inside the text area`);
  out.summary = out.ok
    ? `${textRects.length} text line(s) matched within ${out.worst.toFixed(1)}px${out.extra ? `, ${out.extra} extra box(es)` : ''}`
    : bits.join('; ');
  return out;
}

/**
 * Save a screenshot under tests/output/screenshots/ and return its path
 * relative to tests/output/ (for linking from the reports).
 * @param {string} name e.g. "news-article/c-highlight" (".png" is added)
 * @param {object} [opts] passed to Playwright (fullPage, clip...)
 */
async function screenshot(page, name, opts = {}) {
  const file = path.join(SCREENSHOT_DIR, `${name}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    await page.screenshot({ path: file, animations: 'disabled', caret: 'initial', timeout: 10000, ...opts });
  } catch (e) {
    return null; // a failed screenshot must never fail a check
  }
  return path.relative(OUTPUT_DIR, file);
}

/**
 * Record console errors and uncaught exceptions for a page into `sink`.
 * Each entry notes whether it came from the extension (its script address) or
 * from the page itself.
 */
function captureConsole(page, sink, extensionId, where = 'page') {
  const fromExtension = (text, url) => (url && url.startsWith(`chrome-extension://${extensionId}`))
    || (text && text.includes(`chrome-extension://${extensionId}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const loc = msg.location() || {};
    sink.push({ where, kind: 'console.error', text: msg.text().slice(0, 500), url: loc.url || '', line: loc.lineNumber, fromExtension: !!fromExtension(msg.text(), loc.url) });
  });
  page.on('pageerror', (err) => {
    const text = `${err.message}\n${err.stack || ''}`;
    sink.push({ where, kind: 'uncaught exception', text: `${err.message} ${(err.stack || '').split('\n').slice(1, 3).join(' ')}`.slice(0, 500), url: '', fromExtension: !!fromExtension(text, '') });
  });
}

module.exports = {
  // the extension contract
  SELECTORS, OWNED_SELECTORS, STORAGE, COPY_FORMAT, stripExportTime, TEST_MODE_KEY, HIGHLIGHT_PREFIX, parseHighlightName,
  urlLib, palette,
  // paths and settings
  REPO_ROOT, EXTENSION_DIR, OUTPUT_DIR, SCREENSHOT_DIR, PRINT_DIR, CHROMIUM_PATH, DEFAULT_VIEWPORT,
  // helpers
  launch, getWorker, inWorker, tabIdOf, openPopup, getStored, setStored, removeStored, isInjected, injectionState,
  selectText, waitForToolbar, getToolbar, clickToolbar, getMarkups, getUi, clickUi, getTextRects,
  noteElementFor, noteSelectorFor, pageTextRects,
  compareRects, screenshot, captureConsole, normaliseText, sleep,
};

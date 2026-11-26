/**
 * background.js (service worker)
 * The ONLY place that writes saved markups.
 *
 * Why: the old content script read the page's list, changed it and wrote the
 * whole list back from four separate places. Two tabs on the same page, or
 * two quick actions, could overwrite each other and lose a markup. Here every
 * change for a page joins a queue and runs one at a time.
 *
 * Content scripts and the popup send messages:
 *   { type: 'page.get',      url }
 *   { type: 'markup.upsert', url, markup }      add, or replace by id
 *   { type: 'markup.patch',  url, id, patch }   shallow-merge into one markup
 *   { type: 'markup.remove', url, id }
 * Every reply is { ok: true, page } or { ok: false, error }.
 *
 * Service workers are shut down when idle, so nothing important lives in
 * memory: each operation re-reads storage, and all operations are safe to
 * repeat if a sender retries.
 */
importScripts('lib/url.js', 'lib/palette.js', 'lib/migrate.js');

const { url: urlLib, migrate } = self.WMT;

// ------------------------------------------------------------- migration

/** Convert version 1 data once. Old keys are left in place as a backup. */
async function runMigrationIfNeeded() {
  const meta = (await chrome.storage.local.get('meta')).meta;
  if (meta && meta.schemaVersion >= migrate.SCHEMA_VERSION) return;
  const all = await chrome.storage.local.get(null);
  const plan = migrate.planMigration(all, Date.now());
  await chrome.storage.local.set(plan.set);
}

// One shared promise per worker lifetime; every request waits for it.
let migrationReady = null;
function ensureMigrated() {
  if (!migrationReady) {
    migrationReady = runMigrationIfNeeded().catch((err) => {
      migrationReady = null; // allow a retry on the next request
      throw err;
    });
  }
  return migrationReady;
}

chrome.runtime.onInstalled.addListener(() => { ensureMigrated().catch(console.error); });
chrome.runtime.onStartup.addListener(() => { ensureMigrated().catch(console.error); });

// ------------------------------------------------------------ write queue

const queues = new Map(); // storage key -> promise for the last queued job

/** Run `job` after every earlier job for the same key has finished. */
function enqueue(key, job) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(job);
  queues.set(key, next);
  // Tidy up so the map does not grow for ever.
  next.catch(() => {}).then(() => { if (queues.get(key) === next) queues.delete(key); });
  return next;
}

function emptyPage(url) {
  return { v: migrate.SCHEMA_VERSION, url: urlLib.normaliseUrl(url), updatedAt: 0, markups: [] };
}

async function readPage(url) {
  const key = urlLib.pageKey(url);
  const data = await chrome.storage.local.get(key);
  const page = data[key];
  return page && Array.isArray(page.markups) ? page : emptyPage(url);
}

/** Read the page, let `mutate` change its markup list, write it back. */
function changePage(url, mutate) {
  const key = urlLib.pageKey(url);
  return enqueue(key, async () => {
    const page = await readPage(url);
    const markups = mutate(page.markups.slice());
    const updated = { ...page, updatedAt: Date.now(), markups };
    if (markups.length === 0) {
      await chrome.storage.local.remove(key); // do not leave empty records behind
    } else {
      await chrome.storage.local.set({ [key]: updated });
    }
    return updated;
  });
}

/** Basic shape check so a faulty or hostile sender cannot store rubbish. */
function validMarkup(m) {
  return m && typeof m === 'object'
    && typeof m.id === 'string' && m.id.length > 0 && m.id.length < 200
    && ['highlight', 'underline'].includes(m.kind)
    && self.WMT.palette.isColour(m.colour)
    && (m.note === undefined || (typeof m.note === 'string' && m.note.length <= migrate.MAX_NOTE));
}

// --------------------------------------------------------------- messages

const handlers = {
  'page.get': (msg) => readPage(msg.url),

  'markup.upsert': (msg) => {
    if (!validMarkup(msg.markup)) throw new Error('Invalid markup');
    const now = Date.now();
    return changePage(msg.url, (list) => {
      const i = list.findIndex((m) => m.id === msg.markup.id);
      const markup = { createdAt: now, ...msg.markup, updatedAt: now };
      if (i === -1) list.push(markup); else list[i] = { ...markup, createdAt: list[i].createdAt || now };
      return list;
    });
  },

  'markup.patch': (msg) => {
    if (!msg.patch || typeof msg.patch !== 'object') throw new Error('Invalid patch');
    return changePage(msg.url, (list) => list.map((m) => {
      if (m.id !== msg.id) return m;
      const merged = { ...m, ...msg.patch, id: m.id, updatedAt: Date.now() };
      // A patch that would leave the record invalid is ignored.
      return validMarkup(merged) ? merged : m;
    }));
  },

  'markup.remove': (msg) => changePage(msg.url, (list) => list.filter((m) => m.id !== msg.id)),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && handlers[msg.type];
  if (!handler) return false; // not ours
  // Only this extension's own pages and content scripts may talk to the store.
  if (sender.id !== chrome.runtime.id) return false;
  if (!urlLib.isSupportedUrl(msg.url)) {
    sendResponse({ ok: false, error: 'Unsupported page address' });
    return false;
  }

  ensureMigrated()
    .then(() => handler(msg))
    .then((page) => sendResponse({ ok: true, page }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // keep the channel open for the async reply
});

// ------------------------------------------------------------------ PDF:
// Everything in this section serves the extension's PDF viewer (viewer/).
//
// pdf.stash      pdf-grab.js (in a PDF tab) sends the PDF's bytes in base64
//                chunks. This is the FALLBACK route, used only when the viewer
//                could not fetch the PDF itself. The bytes are kept in the
//                extension's Cache Storage (newest 20 PDFs), on this device only.
// pdf.openViewer Point the sender's tab (or msg.tabId) at the viewer.
// pdf.seen       The viewer opened a document: remember the addresses it was
//                seen at, under its document key, and adopt marks the earlier
//                prototype stored under the address.
const PDF_STASH = 'wmt-pdf';
const PDF_STASH_MAX = 20; // PDFs kept; the oldest is dropped first
const PDF_ADDRESSES_MAX = 20; // addresses remembered per document
const pdfStashKey = (url) => 'https://wmt-pdf.invalid/' + encodeURIComponent(url);
const pdfChunks = new Map(); // transfer id -> array of base64 chunks

function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const viewerUrl = (file, via) => chrome.runtime.getURL('viewer/viewer.html') + '?file=' + encodeURIComponent(file) + (via ? '&via=' + via : '');

const pdfHandlers = {
  'pdf.stash': async (msg) => {
    if (typeof msg.data !== 'string' || !Number.isInteger(msg.index) || !Number.isInteger(msg.total)) throw new Error('Bad chunk');
    const parts = pdfChunks.get(msg.id) || [];
    parts[msg.index] = msg.data;
    pdfChunks.set(msg.id, parts);
    if (parts.filter(Boolean).length < msg.total) return {};
    pdfChunks.delete(msg.id);
    const blob = new Blob(parts.map(fromBase64), { type: 'application/pdf' });
    const cache = await caches.open(PDF_STASH);
    await cache.delete(pdfStashKey(msg.url)); // re-adding moves it to the end of the list
    await cache.put(pdfStashKey(msg.url), new Response(blob, { headers: { 'Content-Type': 'application/pdf' } }));
    const keys = await cache.keys();
    for (const old of keys.slice(0, Math.max(0, keys.length - PDF_STASH_MAX))) await cache.delete(old);
    return { stored: blob.size };
  },

  // An extension may point a tab at its own page without any permission.
  'pdf.openViewer': async (msg, sender) => {
    const tabId = msg.tabId || (sender.tab && sender.tab.id);
    if (!tabId) throw new Error('No tab');
    await chrome.tabs.update(tabId, { url: viewerUrl(msg.url, msg.via) });
    return {};
  },

  'pdf.seen': async (msg) => {
    if (!/^urn:x-wmt-pdf:/.test(msg.url)) throw new Error('Not a document key');
    const metaKey = 'pdfdoc:' + msg.url.slice('urn:x-wmt-pdf:'.length);
    const meta = (await chrome.storage.local.get(metaKey))[metaKey] || { addresses: [] };
    const address = typeof msg.address === 'string' && /^(https?|file):/i.test(msg.address) ? urlLib.normaliseUrl(msg.address) : '';
    if (address) meta.addresses = [address, ...meta.addresses.filter((a) => a !== address)].slice(0, PDF_ADDRESSES_MAX);
    meta.title = typeof msg.title === 'string' ? msg.title.slice(0, 300) : meta.title;
    meta.lastSeen = Date.now();
    await chrome.storage.local.set({ [metaKey]: meta });
    // Marks the earlier prototype keyed by address move to the document key.
    if (address) {
      const old = await readPage(address);
      if (old.markups.length) {
        await changePage(msg.url, (list) => [...list, ...old.markups.filter((m) => !list.some((x) => x.id === m.id))]);
        await chrome.storage.local.remove(urlLib.pageKey(address));
      }
    }
    return { addresses: meta.addresses };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && pdfHandlers[msg.type];
  if (!handler || sender.id !== chrome.runtime.id) return false;
  if (!urlLib.isSupportedUrl(msg.url)) { sendResponse({ ok: false, error: 'Unsupported address' }); return false; }
  // Too old a Chrome for pdf.js: never send a tab to a viewer that cannot run.
  if (msg.type !== 'pdf.seen' && !urlLib.pdfViewerSupported()) {
    sendResponse({ ok: false, error: 'this version of Chrome is too old for the PDF viewer; update Chrome to mark up PDFs' });
    return false;
  }
  ensureMigrated()
    .then(() => handler(msg, sender))
    .then((r) => sendResponse({ ok: true, ...r }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true;
});

// ------------------------------------------------------ keyboard shortcuts

// Shortcuts are declared in manifest.json ("commands"). Chrome delivers them
// here; we pass them to the page the user is looking at.
chrome.commands.onCommand.addListener((command, tab) => {
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'wmt.command', command }).catch(() => {
    // No content script on this tab (browser page, PDF, or not yet reloaded): nothing to do.
  });
});

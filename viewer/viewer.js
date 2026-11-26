/**
 * viewer/viewer.js  (PDF viewer)
 *
 * Shows a PDF with Mozilla's pdf.js (bundled in vendor/pdfjs, no remote code)
 * so that its words are ordinary, selectable HTML text. The extension's normal
 * marking code (content.js) is loaded by viewer.html and works on that text
 * through viewer/host.js.
 *
 * Where the PDF's bytes come from, in order:
 *   1. ?file=<http(s) address>: fetched here directly. The manifest's
 *      host_permissions for http/https let an extension page read any address,
 *      with the site's cookies (so logged-in PDFs work).
 *   2. ?file=<address>&via=stash: the hand-over fallback. If the direct fetch
 *      fails (for example a PDF that only the original tab could load), the
 *      viewer sends the tab back to the PDF with #wmt-handover; pdf-grab.js
 *      fetches it from the PDF's own origin and background.js keeps the bytes
 *      in the extension's Cache Storage, where this page reads them.
 *   3. ?file=<file:// address>: read here if the user has switched on "Allow
 *      access to file URLs"; otherwise the page says how, and offers 4.
 *   4. "Open a file…": a PDF picked from disk (no permission needed).
 *
 * Identity: marks are stored under the document's own identity, not its
 * address (see documentKey), so the same PDF opened from another link, an
 * expiring signed link, file:// or "Open a file…" shows the same marks.
 *
 * Print: see the "print" section. Every page is drawn again at print
 * resolution into a separate print copy, with a text layer the marks are
 * painted on, then the browser's print dialogue opens.
 */

const host = globalThis.WMT.host;
const $ = (id) => document.getElementById(id);
const asset = (p) => chrome.runtime.getURL('vendor/pdfjs/' + p);
const params = new URLSearchParams(location.search);

/** Same naming as background.js: Cache Storage keys must be http(s) addresses. */
const STASH = 'wmt-pdf';
const stashKey = (url) => 'https://wmt-pdf.invalid/' + encodeURIComponent(url);

// Chrome too old for pdf.js 6.5 (see lib/url.js): explain, offer Chrome's own
// viewer, and stop before loading pdf.js (it would fail part-way through).
if (!globalThis.WMT.url.pdfViewerSupported()) {
  const file = params.get('file');
  const box = $('message');
  box.textContent = 'The PDF viewer needs a newer version of Chrome. Update Chrome to mark up PDFs.';
  box.hidden = false;
  if (file) { $('nativeLink').href = file + '#wmt-native'; $('nativeLink').hidden = false; }
  document.documentElement.dataset.wmtLoad = 'unsupported';
  throw new Error('PDF viewer: this browser is too old for pdf.js');
}

// Records where pdf.js draws each glyph, so the text layer can be fitted to it.
const { fitLayer, takeGlyphs } = await import('./fit-text.js');

// pdf.js's viewer module reads globalThis.pdfjsLib when it loads, so load the library first.
const pdfjsLib = await import(chrome.runtime.getURL('vendor/pdfjs/build/pdf.min.mjs'));
pdfjsLib.GlobalWorkerOptions.workerSrc = asset('build/pdf.worker.min.mjs');
const { EventBus, PDFLinkService, PDFViewer } = await import(chrome.runtime.getURL('vendor/pdfjs/web/pdf_viewer.mjs'));

const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus });
const viewer = new PDFViewer({
  container: $('viewerContainer'),
  viewer: $('viewer'),
  eventBus,
  linkService,
  textLayerMode: 1,                                   // build the selectable text layer
  annotationMode: pdfjsLib.AnnotationMode.ENABLE,     // links work; forms are shown but not editable
  imageResourcesPath: asset('web/images/'),
});
linkService.setViewer(viewer);

/** Show (or with '' hide) the message under the bar. `actions` are [label, fn] buttons. */
function showMessage(text, actions = []) {
  const box = $('message');
  box.replaceChildren();
  if (!text) { box.hidden = true; return; }
  const p = document.createElement('span');
  p.textContent = text;
  box.append(p);
  for (const [label, fn] of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', fn);
    box.append(' ', b);
  }
  box.hidden = false;
}

const setState = (name, value) => { document.documentElement.dataset[name] = value; }; // read by the evidence script

// ------------------------------------------------------------ getting bytes

async function fromStash(url) {
  try {
    const hit = await (await caches.open(STASH)).match(stashKey(url));
    return hit ? new Uint8Array(await hit.arrayBuffer()) : null;
  } catch (e) {
    return null;
  }
}

/** Direct fetch from this extension page. file:// needs XMLHttpRequest (fetch refuses the scheme). */
async function fromNetwork(url) {
  if (/^file:/i.test(url)) {
    if (!(await chrome.extension.isAllowedFileSchemeAccess())) throw new Error('file-access-off');
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.responseType = 'arraybuffer';
      xhr.onload = () => (xhr.response && xhr.response.byteLength ? resolve(new Uint8Array(xhr.response)) : reject(new Error('the file is empty or missing')));
      xhr.onerror = () => reject(new Error('Chrome refused to read the file'));
      xhr.send();
    });
  }
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`the server answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// ------------------------------------------------------------- identity

/**
 * The storage key of a document: "urn:x-wmt-pdf:<id>".
 *
 * Most PDFs carry a permanent identifier (the first part of the trailer's
 * /ID, written when the file is first made and kept when it is edited and
 * saved again). pdf.js reports it as fingerprints[0]. When a PDF has no /ID,
 * pdf.js falls back to a hash of the first 1024 bytes, which two different
 * PDFs from the same generator can share. So the /ID is used only when it is
 * really in the file (checked below); otherwise the key is a SHA-256 of the
 * whole file ("sha256-<hex>"), which is unique but changes if the file does.
 */
async function documentKey(bytes, fingerprint) {
  const look = (from, to) => new TextDecoder('latin1').decode(bytes.subarray(from, to));
  const ends = look(0, 65536) + '\n' + look(Math.max(0, bytes.length - 65536), bytes.length);
  const ids = Array.from(ends.matchAll(/\/ID\s*\[\s*<([0-9A-Fa-f\s]+)>/g), (m) => m[1].replace(/\s+/g, '').toLowerCase());
  if (fingerprint && ids.includes(fingerprint.toLowerCase())) return 'urn:x-wmt-pdf:' + fingerprint.toLowerCase();
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return 'urn:x-wmt-pdf:sha256-' + Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

// --------------------------------------------------------------- showing it

let current = null;    // the open document's pdf.js loading task (its destroy() closes the document)
let currentDoc = null; // the open document itself

async function openBytes(data, { name, address }) {
  showMessage('');
  if (current) {
    // Detach the viewer first so it stops drawing pages of the old document.
    viewer.setDocument(null);
    linkService.setDocument(null, null);
    await current.destroy().catch(() => {});
    current = null;
    currentDoc = null;
  }
  host.loaded = false;
  host.keyUrl = null;
  // pdf.js moves the buffer to its worker, so read what we need from a copy first.
  const task = pdfjsLib.getDocument({
    data: data.slice(),
    cMapUrl: asset('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts/'),
    wasmUrl: asset('wasm/'),
    iccUrl: asset('iccs/'),
    isEvalSupported: false, // extension pages forbid eval anyway; say so up front
    disableWorkerRendering: true, // draw here, so fit-text.js can see where glyphs go
    enableXfa: false,
  });
  current = task;
  const doc = await task.promise;
  currentDoc = doc;
  host.keyUrl = await documentKey(data, doc.fingerprints[0]);
  let title = name;
  try {
    const t = String((await doc.getMetadata()).info.Title || '').trim();
    // PDFs printed from a browser often carry the tab's address as their title.
    if (t && !/^(about:blank|untitled|data:)/i.test(t)) title = t;
  } catch (e) { /* keep the file name */ }
  // Remember where this document was seen, and adopt marks the earlier
  // prototype saved under the address. (background.js, "pdf.seen")
  await chrome.runtime.sendMessage({ type: 'pdf.seen', url: host.keyUrl, address: address || '', title }).catch(() => {});
  viewer.setDocument(doc);
  linkService.setDocument(doc, null);
  $('pageCount').textContent = `of ${doc.numPages}`;
  $('pageNumber').max = String(doc.numPages);
  $('docTitle').textContent = title;
  document.title = `${title} · Web Page Markup Tool`;
  // content.js switches to this document's marks at once (not at its next 1 s check).
  window.dispatchEvent(new CustomEvent('wmt-host-refresh', { detail: { all: true } }));
  checkText(doc);
}

/**
 * A scanned PDF is pictures of pages with no text, so there is nothing to
 * select or mark. Say so plainly instead of leaving people dragging at it.
 * Looks at up to 400 pages, in the background.
 */
async function checkText(doc) {
  const upTo = Math.min(doc.numPages, 400);
  const empty = [];
  for (let n = 1; n <= upTo; n++) {
    if (doc !== currentDoc) return;
    try {
      const tc = await (await doc.getPage(n)).getTextContent();
      if (!tc.items.some((i) => i.str && i.str.trim())) empty.push(n);
    } catch (e) { empty.push(n); }
  }
  if (doc !== currentDoc) return;
  if (empty.length === upTo) {
    setState('wmtText', 'none');
    showMessage('This PDF has no text in it: it is a scan or a picture of pages. It can be read and printed here, but it cannot be marked up, because there are no words to select.');
  } else if (empty.length) {
    setState('wmtText', 'some');
    const list = empty.length > 8 ? `${empty.slice(0, 8).join(', ')} and ${empty.length - 8} more` : empty.join(', ');
    showMessage(`${empty.length === 1 ? 'Page' : 'Pages'} ${list} ${empty.length === 1 ? 'has' : 'have'} no text (a scan or picture), so ${empty.length === 1 ? 'it' : 'they'} cannot be marked up. The other pages can.`, [['OK', () => showMessage('')]]);
  } else {
    setState('wmtText', 'all');
  }
}

/**
 * Starting zoom: leave room beside the page for margin notes (up to 1.6x),
 * and fall back to "fit width" when the window is too narrow for that.
 */
function startingZoom() {
  const first = viewer.getPageView(0);
  if (!first) { viewer.currentScaleValue = 'page-width'; return; }
  const widthAt1 = first.viewport.width / first.scale;          // CSS px at 100%
  const avail = $('viewerContainer').clientWidth;
  const GUTTER = 280;                                           // margin note 240 + gaps + scrollbar
  const withNotes = (avail - 2 * GUTTER) / widthAt1;
  if (withNotes >= 0.8) viewer.currentScale = Math.min(withNotes, 1.6);
  else viewer.currentScaleValue = 'page-width';
}

/*
 * Letters of the text layer go exactly where the PDF drew them (see
 * fit-text.js): marks and mouse selections then sit on the words at every
 * zoom. Each page's glyph positions are taken when pdf.js has drawn it; the
 * text layer may be built before or after that, so both events try.
 */
const pageGlyphs = new WeakMap(); // PDFPageView -> glyph origins in PDF points

async function fitPageView(pageView) {
  const layer = pageView && pageView.div && pageView.div.querySelector('.textLayer');
  if (!layer || !pageView.pdfPage || !layer.querySelector('span[role="presentation"]:not([data-wmt-fit="snapped"])')) return;
  const tc = await pageView.pdfPage.getTextContent({ includeMarkedContent: true, disableNormalization: true });
  const replaced = fitLayer(layer, tc.items, tc.styles, pageGlyphs.get(pageView) || null);
  // Text nodes were replaced: marks already found on this page must be found again.
  if (replaced) { host.forget(); window.dispatchEvent(new CustomEvent('wmt-host-refresh', { detail: { all: true } })); }
}
eventBus.on('pagerendered', (e) => {
  const v = e.source;
  if (v && v.canvas && v.viewport && !pageGlyphs.has(v)) {
    const os = v.outputScale;
    const g = takeGlyphs(v.canvas, v.viewport, os && os.scaled ? os.sx : 1, os && os.scaled ? os.sy : 1);
    if (g) pageGlyphs.set(v, g);
  }
  fitPageView(v).catch(() => {});
});
eventBus.on('textlayerrendered', (e) => { fitPageView(e.source).catch(() => {}); });

eventBus.on('pagesinit', startingZoom);
eventBus.on('pagesloaded', () => { host.loaded = true; window.dispatchEvent(new Event('wmt-host-refresh')); });
eventBus.on('pagechanging', (e) => { $('pageNumber').value = String(e.pageNumber); });
// A page's text was (re)built: let content.js look for marks waiting for it straight away.
// (After a tick, so host.js's MutationObserver has cleared its cached page text first.)
eventBus.on('textlayerrendered', () => setTimeout(() => { host.forget(); window.dispatchEvent(new Event('wmt-host-refresh')); }, 0));

function failed(text, actions) {
  showMessage(text, actions);
  setState('wmtLoad', 'failed');
}

async function start() {
  const url = host.fileUrl;
  if (!url) {
    $('docTitle').textContent = 'No PDF open';
    showMessage('Choose "Open a file…" to mark up a PDF from your computer.', [['Open a file…', () => $('pick').click()]]);
    setState('wmtLoad', 'none');
    return;
  }
  let name = url;
  try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || url); } catch (e) { /* keep the address */ }
  $('docTitle').textContent = name;
  const isWeb = /^https?:/i.test(url);
  if (isWeb) {
    $('nativeLink').href = url + '#wmt-native'; // pdf-grab.js will not send this one back here
    $('nativeLink').hidden = false;
  }

  let data = null;
  let how = '';
  if (params.get('via') === 'stash') { data = await fromStash(url); how = 'stash'; }
  if (!data) {
    try {
      data = await fromNetwork(url);
      how = 'network';
    } catch (e) {
      // A file on this computer that Chrome will not let the extension read: the
      // switch is off, or (older manifests) no file:///* host permission.
      if (e.message === 'file-access-off' || /^file:/i.test(url)) {
        return failed('Chrome only lets an extension read PDFs on your computer if you allow it. Either choose "Open a file…" and pick this PDF, or go to chrome://extensions, open this extension\'s Details and switch on "Allow access to file URLs".',
          [['Open a file…', () => $('pick').click()]]);
      }
      if (isWeb && params.get('via') !== 'stash') {
        // Fallback: have the PDF's own tab fetch it (pdf-grab.js), once.
        setState('wmtLoad', 'handover');
        location.replace(url.split('#')[0] + '#wmt-handover');
        return;
      }
      return failed(`Could not load this PDF here (${e.message}). Download it, then use "Open a file…".`,
        [['Open a file…', () => $('pick').click()]]);
    }
  }
  try {
    await openBytes(data, { name, address: url });
    setState('wmtLoad', how);
  } catch (e) {
    failed(`This file could not be opened as a PDF (${e.message}).`);
  }
}

// ------------------------------------------------------------------ controls

$('zoomIn').addEventListener('click', () => viewer.increaseScale());
$('zoomOut').addEventListener('click', () => viewer.decreaseScale());
$('zoomFit').addEventListener('click', () => { viewer.currentScaleValue = 'page-width'; });
$('pageNumber').addEventListener('change', (e) => { viewer.currentPageNumber = Number(e.target.value) || 1; });
$('printBtn').addEventListener('click', () => host.print());
$('pick').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  host.fileUrl = null;
  host.fileName = file.name;
  $('nativeLink').hidden = true;
  try {
    await openBytes(new Uint8Array(await file.arrayBuffer()), { name: file.name, address: '' });
    // Record the key in the address so the popup can tell which document this is.
    history.replaceState(null, '', location.pathname + '?key=' + encodeURIComponent(host.keyUrl));
    setState('wmtLoad', 'picked');
  } catch (err) {
    failed(`This file could not be opened as a PDF (${err.message}).`);
  }
});

// -------------------------------------------------------------------- print
//
// Why a separate print copy: pdf.js draws only pages near the screen and
// keeps at most about 10 drawn, at screen resolution. Printing the screen
// pages gave blank pages, soft text and split sheets. Instead, for print:
//   1. every page is drawn again into its own picture at PRINT_DPI;
//   2. each picture sits on a "sheet" exactly the size of that PDF page, using
//      a CSS named page per page size (so mixed sizes and landscape pages each
//      get the right paper, with no margins);
//   3. a pdf.js text layer is laid over each picture; content.js finds the
//      marks on it (host.printing switches host.js to these pages) and paints
//      them, adds its note numbers, and appends the notes list at the end;
//   4. then window.print(). Afterwards the copy is removed and the marks go
//      back to the screen pages.
// The text layer is invisible but real text, so "Save as PDF" keeps the
// document's words selectable and searchable.

/** Print resolution in dots per inch; lower for long documents to bound time and memory. */
function printDpi(pages) {
  return pages <= 100 ? 300 : pages <= 300 ? 200 : 150;
}
const MAX_PRINT_PIXELS = 40e6; // per page; very large pages (posters) are drawn at less than PRINT_DPI

let printUrls = [];   // object URLs of the page pictures, revoked afterwards
let prepared = false; // true while the print copy is in place
let printing = null;  // the running preparation, so a second click waits for it

const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

async function buildPrintCopy(doc, onProgress) {
  const box = document.createElement('div');
  box.id = 'wmtPrint';
  box.setAttribute('aria-hidden', 'true');
  const dpi = printDpi(doc.numPages);
  const sizes = new Map(); // "w x h" in points -> named page
  const rules = [];
  for (let n = 1; n <= doc.numPages; n++) {
    onProgress(n, doc.numPages);
    const page = await doc.getPage(n);
    const pt = page.getViewport({ scale: 1 }); // in PDF points, the page's own rotation applied
    const sizeKey = `${pt.width.toFixed(2)} ${pt.height.toFixed(2)}`;
    if (!sizes.has(sizeKey)) {
      const name = `wmt-size-${sizes.size}`;
      sizes.set(sizeKey, name);
      rules.push(`@page ${name} { size: ${pt.width}pt ${pt.height}pt; margin: 0; }`);
      if (sizes.size === 1) rules.push(`@page { size: ${pt.width}pt ${pt.height}pt; margin: 16mm 18mm; }`); // the notes list
    }
    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.dataset.pageNumber = String(n);
    sheet.style.setProperty('page', sizes.get(sizeKey));
    sheet.style.width = `${pt.width}pt`;
    sheet.style.height = `${pt.height}pt`;

    // 1. The picture.
    const scale = Math.min(dpi / 72, Math.sqrt(MAX_PRINT_PIXELS / (pt.width * pt.height)));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvasContext: ctx, canvas, viewport: vp, intent: 'print',
      annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE, // form fields print with their values
      printAnnotationStorage: doc.annotationStorage.print,
    }).promise;
    const printGlyphs = takeGlyphs(canvas, vp); // where each letter was drawn, for the text layer below
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    canvas.width = canvas.height = 0; // free the canvas memory now
    const img = document.createElement('img');
    img.alt = '';
    img.src = URL.createObjectURL(blob);
    printUrls.push(img.src);
    await img.decode().catch(() => {});

    // 2. The text, at 1 PDF point = 1 print point (96/72 CSS px per point).
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    const textLayer = new pdfjsLib.TextLayer({
      // Same options as pdf.js's screen pages, so the text (and marks' positions in it) match.
      textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
      container: layer,
      viewport: page.getViewport({ scale: 96 / 72 }),
    });
    await textLayer.render();
    // Same letter placement as on screen (the page was just drawn, so its fonts are loaded).
    const printText = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
    fitLayer(layer, printText.items, printText.styles, printGlyphs);
    // A rotated page's text layer is turned by pdf.js's CSS, e.g. "rotate(90deg)
    // translateY(-100%)". In Chromium's real print pass (not on screen, not with
    // print media emulated) that percentage is resolved wrongly on a landscape
    // sheet and the text, and so the marks, land about (width - height) off.
    // The same turn written in pixels prints correctly.
    const rot = ((page.rotate % 360) + 360) % 360;
    if (rot) {
      const k = 96 / 72;
      const [x0, y0, x1, y1] = page.view; // the page's own (unrotated) box, in points
      const w = Math.floor((x1 - x0) * k);
      const h = Math.floor((y1 - y0) * k);
      const shift = { 90: `translateY(-${h}px)`, 180: `translate(-${w}px, -${h}px)`, 270: `translateX(-${w}px)` }[rot];
      layer.style.transform = `rotate(${rot}deg) ${shift}`;
    }
    layer.dataset.wmtReady = '1';
    sheet.append(img, layer);
    box.append(sheet);
    page.cleanup();
  }
  let style = $('wmt-print-pages');
  if (!style) { style = document.createElement('style'); style.id = 'wmt-print-pages'; document.head.append(style); }
  style.textContent = rules.join('\n');
  document.body.append(box);
  return { dpi };
}

/** Build the print copy and point the marks at it. Exposed for the evidence script. */
host.preparePrint = async () => {
  if (!currentDoc) return null;
  if (prepared) return { dpi: null };
  const t0 = Date.now();
  const info = await buildPrintCopy(currentDoc, (n, total) => showMessage(`Preparing page ${n} of ${total} for printing…`));
  showMessage('');
  host.printing = true;
  host.forget();
  window.dispatchEvent(new CustomEvent('wmt-host-refresh', { detail: { all: true } }));
  await frames();
  prepared = true;
  return { ...info, ms: Date.now() - t0 };
};

/** Remove the print copy and put the marks back on the screen pages. */
host.finishPrint = () => {
  if (!prepared) return;
  prepared = false;
  host.printing = false;
  const box = $('wmtPrint');
  if (box) box.remove();
  for (const u of printUrls.splice(0)) URL.revokeObjectURL(u);
  host.forget();
  window.dispatchEvent(new CustomEvent('wmt-host-refresh', { detail: { all: true } }));
};

host.print = () => {
  if (!currentDoc) return Promise.resolve();
  if (!printing) {
    printing = (async () => {
      try {
        await host.preparePrint();
        window.print();
      } catch (e) {
        host.finishPrint();
        showMessage(`Could not prepare this PDF for printing (${e.message}).`);
      } finally {
        printing = null;
      }
    })();
  }
  return printing;
};

// Chrome's own menu Print (and the print button in the top-right ⋮ menu)
// cannot be intercepted or delayed, so it would print whatever is on screen.
// Instead it prints one sheet that says how to print this PDF properly.
window.addEventListener('beforeprint', () => {
  document.documentElement.classList.toggle('wmt-print-unprepared', !prepared);
});
window.addEventListener('afterprint', () => {
  const wasUnprepared = document.documentElement.classList.contains('wmt-print-unprepared');
  document.documentElement.classList.remove('wmt-print-unprepared');
  setTimeout(host.finishPrint, 0);
  if (wasUnprepared && currentDoc) {
    showMessage('To print this PDF with your marks, use "Print or save PDF" in the bar above, or press Ctrl+P.', [['Print now', () => host.print()]]);
  }
});
// Ctrl+P / Cmd+P go through the proper preparation.
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
    e.preventDefault();
    host.print();
  }
}, true);

// For the evidence script only.
globalThis.__wmtViewer = { viewer, eventBus, get doc() { return currentDoc; } };

start();

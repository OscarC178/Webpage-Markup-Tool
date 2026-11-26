/**
 * pdf-grab.js  (PDF viewer)
 * Content script on http(s) pages, alongside content.js. Does nothing unless
 * the tab is showing a PDF in Chrome's built-in viewer (Chrome's PDF tab is an
 * HTML wrapper page whose document.contentType is "application/pdf"; content
 * scripts run in it, content.js returns early there).
 *
 * Three jobs:
 *   1. Answer the popup's "is this a PDF?" ping.
 *   2. "Always open PDFs in the markup viewer" (off by default): ask the
 *      background to point this tab at the viewer, which fetches the PDF itself.
 *   3. FALLBACK hand-over. When the viewer cannot fetch a PDF itself it sends
 *      the tab back here with #wmt-handover. Then this script fetches the PDF
 *      from its own origin (the tab's cookies and login apply, no CORS), sends
 *      the bytes to background.js in chunks (messages carry JSON only, so they
 *      are base64-encoded), and the viewer reads them from Cache Storage.
 */
(function () {
  'use strict';

  if (window.top !== window) return;
  if (document.contentType !== 'application/pdf') return;

  const CHUNK = 8 * 1024 * 1024; // raw bytes per message (about 11 MB as base64)
  const url = location.href.split('#')[0];

  function toBase64(bytes) {
    // btoa needs a "binary string"; build it in slices to avoid huge argument lists.
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  /** Fetch this PDF from its own origin and pass it to the background in chunks, then open the viewer. */
  async function handOver() {
    const res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
    if (!res.ok) throw new Error(`The server answered ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const id = Math.random().toString(36).slice(2);
    const total = Math.max(1, Math.ceil(bytes.length / CHUNK));
    for (let i = 0; i < total; i++) {
      const reply = await chrome.runtime.sendMessage({
        type: 'pdf.stash', url, id, index: i, total,
        data: toBase64(bytes.subarray(i * CHUNK, (i + 1) * CHUNK)),
      });
      if (!reply || !reply.ok) throw new Error((reply && reply.error) || 'Could not store the PDF');
    }
    const reply = await chrome.runtime.sendMessage({ type: 'pdf.openViewer', url, via: 'stash' });
    if (!reply || !reply.ok) throw new Error((reply && reply.error) || 'Could not open the viewer');
    return { ok: true, bytes: bytes.length, chunks: total };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || sender.id !== chrome.runtime.id) return false;
    if (msg.type === 'wmt.pdf.ping') { sendResponse({ ok: true, pdf: true, url }); return false; }
    return false;
  });

  (async () => {
    try {
      // 3. The viewer asked for the fallback hand-over.
      if (location.hash.includes('wmt-handover')) {
        history.replaceState(null, '', url); // so Back or reload do not repeat it
        await handOver();
        return;
      }
      // 2. Automatic opening. Skipped when the user came here on purpose (the
      // viewer's "Open in Chrome's viewer" link adds #wmt-native) or with the
      // Back button, so Back does not bounce them forward again.
      const { 'wmt:pdfAutoOpen': auto } = await chrome.storage.sync.get('wmt:pdfAutoOpen');
      if (!auto || location.hash.includes('wmt-native')) return;
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav && nav.type === 'back_forward') return;
      await chrome.runtime.sendMessage({ type: 'pdf.openViewer', url });
    } catch (e) { /* stay in Chrome's viewer */ }
  })();
})();

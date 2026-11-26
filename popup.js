/**
 * popup.js
 * The small window opened from the extension's toolbar icon. It shows what
 * is marked on the current page, exports it, and reports problems the
 * extension can detect itself ("Check this page").
 *
 * It only reads: saved data comes from background.js, live page facts come
 * from the content script in the tab.
 */
(function () {
  'use strict';

  const { url: urlLib, palette, review } = globalThis.WMT;
  const $ = (id) => document.getElementById(id);

  let tab = null;
  let page = null; // saved record for this page: { url, markups: [...] }

  // ------------------------------------------------------------ status line

  let statusTimer;
  /** One status line, one timer: a new message always replaces the old one. */
  function showStatus(text) {
    clearTimeout(statusTimer);
    $('status').textContent = text;
    statusTimer = setTimeout(() => { $('status').textContent = ''; }, 4000);
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  // ------------------------------------------------- pages we cannot work on

  /** Plain-English reason this tab cannot be marked up, or null if it can. */
  function unsupportedReason(href) {
    if (!href) return 'This type of page cannot be marked up.';
    if (/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(href)) {
      return 'Chrome does not allow extensions to work on the Chrome Web Store.';
    }
    if (/^(chrome|about|chrome-extension|view-source|devtools|edge|brave):/i.test(href)) {
      return 'Chrome does not allow extensions to work on browser pages like this one.';
    }
    if (/^file:/i.test(href)) {
      return 'This is a file on your computer. Web Page Markup Tool only works on pages opened from the web.';
    }
    if (!urlLib.isSupportedUrl(href)) return 'This type of page cannot be marked up.';
    if (urlLib.looksLikePdf(href)) {
      return 'This tab is a PDF. Web Page Markup Tool only works on web pages, so it cannot mark up PDFs.';
    }
    return null;
  }

  function showMessage(text, withReload) {
    $('main').hidden = true;
    $('message').textContent = text;
    $('message').hidden = false;
    $('reloadBtn').hidden = !withReload;
  }

  // ---------------------------------------------------------------- loading

  /** Ask the content script in the tab about the live page. Null if it is not there. */
  async function askTab(msg) {
    try {
      return (await chrome.tabs.sendMessage(tab.id, msg)) || null;
    } catch (e) {
      return null;
    }
  }

  // PDF ------------------------------------------------------------------
  // The extension's PDF viewer (viewer/viewer.html) is an extension page, so
  // its tab address is chrome-extension://…; the viewer itself reports which
  // document it shows (its key, under which the marks are stored) and the
  // PDF's own address (for the Source line of the export).
  const VIEWER = chrome.runtime.getURL('viewer/viewer.html');
  const isViewerTab = () => !!(tab && tab.url && tab.url.startsWith(VIEWER));
  let pdfLive = null; // the viewer's report, when this tab is the viewer

  /** A PDF in Chrome's own viewer, or a PDF file on this computer: offer to open it in ours. True if shown. */
  async function offerPdf() {
    const href = tab && tab.url;
    if (!href || isViewerTab()) return false;
    // pdf-grab.js answers in Chrome's PDF tab; a file:// tab (or a tab opened
    // before the extension was installed) is judged by its address.
    const ping = /^https?:/i.test(href) ? await askTab({ type: 'wmt.pdf.ping' }) : null;
    if (!(ping && ping.pdf) && !(/^(https?|file):/i.test(href) && urlLib.looksLikePdf(href))) return false;
    $('pageName').textContent = /^file:/i.test(href) ? decodeURIComponent(new URL(href).pathname.split('/').pop()) : shortName(href);
    $('main').hidden = true;
    $('pdfSection').hidden = false;
    // Chrome too old for the bundled pdf.js: say so instead of offering the button.
    if (!urlLib.pdfViewerSupported()) {
      $('pdfOpenBtn').hidden = true;
      $('pdfAutoRow').hidden = true;
      $('pdfStatus').textContent = 'Marking up PDFs needs a newer version of Chrome. Update Chrome, then try again.';
      return true;
    }
    // Automatic opening works only for web PDFs (the extension does not run in file:// tabs).
    $('pdfAutoRow').hidden = /^file:/i.test(href);
    const { 'wmt:pdfAutoOpen': auto } = await chrome.storage.sync.get('wmt:pdfAutoOpen');
    $('pdfAuto').checked = !!auto;
    $('pdfAuto').addEventListener('change', (e) => chrome.storage.sync.set({ 'wmt:pdfAutoOpen': e.target.checked }));
    $('pdfOpenBtn').addEventListener('click', async () => {
      $('pdfOpenBtn').disabled = true;
      const res = await chrome.runtime.sendMessage({ type: 'pdf.openViewer', url: href.split('#')[0], tabId: tab.id }).catch(() => null);
      if (res && res.ok) window.close();
      else { $('pdfOpenBtn').disabled = false; $('pdfStatus').textContent = `Could not open this PDF: ${(res && res.error) || 'no reply'}.`; }
    });
    return true;
  }

  /** The address to show and export: the PDF's own address in the viewer, else the tab's. */
  const sourceUrl = () => (pdfLive && pdfLive.source) || tab.url;
  // ----------------------------------------------------------------------

  async function load() {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (await offerPdf()) return; // PDF: a PDF tab gets the "Mark up this PDF" button
    // PDF: in the viewer, the marks are stored under the document's key.
    if (isViewerTab()) pdfLive = await askTab({ type: 'wmt.check' });
    const href = pdfLive ? pdfLive.key : tab && tab.url;

    const reason = isViewerTab() ? (pdfLive ? null : 'The PDF is still loading. Try again in a moment.') : unsupportedReason(href); // PDF
    if (reason) {
      if (href && /^(https?|file):/i.test(href)) $('pageName').textContent = shortName(href);
      showMessage(reason, false);
      return;
    }
    $('pageName').textContent = pdfLive ? shortName(sourceUrl()) || sourceUrl() : shortName(href); // PDF

    const reply = await chrome.runtime.sendMessage({ type: 'page.get', url: href }).catch(() => null);
    if (!reply || !reply.ok) {
      showMessage('Could not read your markups. Close this window and try again.', false);
      return;
    }
    page = reply.page;

    const live = pdfLive || await askTab({ type: 'wmt.check' }); // PDF: already asked
    if (!live) {
      // A PDF served without ".pdf" in its address also ends up here, as does
      // a tab that was open before the extension was installed or updated.
      showMessage('The extension has not loaded on this page yet. If this is a web page, reload it. PDFs and other documents cannot be marked up.', true);
      return;
    }
    render(live);
  }

  function shortName(href) {
    try {
      const u = new URL(href);
      return u.host + (u.pathname === '/' ? '' : u.pathname);
    } catch (e) {
      return '';
    }
  }

  // -------------------------------------------------------------- rendering

  function render(live) {
    const markups = page.markups;
    const total = markups.length;
    $('main').hidden = false;
    $('message').hidden = true;

    if (total === 0 && live.pdf && live.text === 'none') {
      // PDF: a scan has no words to select, so "select some text" would mislead.
      $('countLine').textContent = 'This PDF is a scan with no text.';
      $('breakdown').textContent = 'It cannot be marked up, because there are no words to select.';
    } else if (total === 0) {
      $('countLine').textContent = 'No markups on this page yet.';
      $('breakdown').textContent = 'Select some text on the page to start.';
    } else {
      const underlines = markups.filter((m) => m.kind === 'underline').length;
      const notes = markups.filter((m) => (m.note || '').trim()).length;
      $('countLine').textContent = `${plural(total, 'markup', 'markups')} on this page`;
      // A note belongs to one of the highlights or underlines, so it is counted
      // as "with a note" rather than as a third kind (which would not add up).
      // With no notes that part is left out.
      $('breakdown').textContent = [
        plural(total - underlines, 'highlight', 'highlights'),
        plural(underlines, 'underline', 'underlines'),
        notes === 0 ? null : notes === 1 ? '1 with a note' : `${notes} with notes`,
      ].filter(Boolean).join(' · ');
    }
    $('actions').hidden = total === 0;
    $('checkSection').hidden = total === 0;
    if (total > 0) renderCheck(live);
  }

  /** "Check this page": one plain line per problem the content script found. */
  function renderCheck(live) {
    const list = $('checkList');
    list.textContent = '';
    const add = (kind, text, actionLabel, action) => {
      const li = document.createElement('li');
      li.className = kind;
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = kind === 'good' ? '✓' : '!';
      const body = document.createElement('span');
      body.textContent = text + (actionLabel ? ' ' : '');
      if (actionLabel) {
        const btn = document.createElement('button');
        btn.className = 'link';
        btn.textContent = actionLabel;
        btn.addEventListener('click', action);
        body.append(btn);
      }
      li.append(mark, body);
      list.append(li);
    };

    if (live.notFound > 0) {
      add('warn',
        `${plural(live.notFound, 'markup', 'markups')} could not be found on this page. The text may have changed since you marked it.`,
        'Show', async () => { await askTab({ type: 'wmt.showNotFound' }); window.close(); });
    }
    if (live.hidden > 0) {
      add('warn', `${plural(live.hidden, 'markup is', 'markups are')} on text that is hidden right now, for example inside a closed menu or tab.`);
    }
    if (live.lowContrast > 0) {
      add('warn', `${plural(live.lowContrast, 'markup is', 'markups are')} hard to see against this page’s background. Try a different colour.`);
    }
    if (!list.children.length) {
      add('good', `No problems found. ${live.total === 1 ? 'Your markup is' : `All ${live.total} markups are`} showing correctly.`);
    }
  }

  // ---------------------------------------------------------------- exports

  function exportRows() {
    return page.markups.map((m) => ({
      id: m.id,
      style: m.kind,
      colour: m.colour,
      text: (m.anchor && m.anchor.quote && m.anchor.quote.exact) || '',
      note: m.note || '',
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));
  }

  function toMarkdown(title) {
    const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeStyle: 'short' }).format(new Date());
    const lines = [`# Markups: ${title || shortName(tab.url)}`, `Source: ${sourceUrl()}`, `Exported: ${date}`, ''];
    exportRows().forEach((row, i) => {
      const quote = row.text.replace(/\s+/g, ' ').trim() || '(text not recorded)';
      lines.push(`${i + 1}. > ${quote}`);
      if (row.note.trim()) lines.push(`   Note: ${row.note.replace(/\n/g, '\n   ')}`);
      lines.push(`   ${row.style === 'underline' ? 'Underline' : 'Highlight'}, ${row.colour}`, '');
    });
    return lines.join('\n');
  }

  $('copyBtn').addEventListener('click', async () => {
    try {
      // PDF: the viewer's tab title ends " · Web Page Markup Tool"; export the PDF's own title.
      await navigator.clipboard.writeText(toMarkdown(isViewerTab() ? String(tab.title || '').replace(/ · Web Page Markup Tool$/, '') : tab.title));
      showStatus(`Copied ${plural(page.markups.length, 'markup', 'markups')}.`);
    } catch (e) {
      showStatus('Could not copy. Click the button again.');
    }
  });

  $('jsonBtn').addEventListener('click', () => {
    const data = { version: 2, url: sourceUrl(), /* PDF */ title: tab.title || '', exportedAt: new Date().toISOString(), markups: exportRows() };
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    link.download = 'markups.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    showStatus('Downloaded markups.json.');
  });

  $('printBtn').addEventListener('click', async () => {
    // The page prints itself; the print dialogue is the feedback.
    const ok = await askTab({ type: 'wmt.print' });
    if (ok) window.close(); else showStatus('Could not open the print dialogue. Reload the page and try again.');
  });

  $('recheckBtn').addEventListener('click', async () => {
    const live = await askTab({ type: 'wmt.check' });
    if (live) { renderCheck(live); showStatus('Checked.'); }
  });

  $('reloadBtn').addEventListener('click', async () => {
    await chrome.tabs.reload(tab.id);
    window.close();
  });

  // ----------------------------------------------------------- default colour

  async function setUpSwatches() {
    const { colour } = await chrome.storage.sync.get('colour');
    const current = palette.isColour(colour) ? colour : palette.DEFAULT;
    const group = $('swatches');
    const buttons = palette.NAMES.map((name) => {
      const btn = document.createElement('button');
      btn.className = 'swatch';
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-label', name[0].toUpperCase() + name.slice(1));
      btn.style.setProperty('--dot', palette.COLOURS[name].light);
      btn.dataset.colour = name;
      group.append(btn);
      return btn;
    });
    const select = (name, focus) => {
      for (const b of buttons) {
        const on = b.dataset.colour === name;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1; // radio group: one tab stop, arrows move
        if (on && focus) b.focus();
      }
      chrome.storage.sync.set({ colour: name });
    };
    select(current, false);
    group.addEventListener('click', (e) => {
      const btn = e.target.closest('.swatch');
      if (btn) select(btn.dataset.colour, true);
    });
    group.addEventListener('keydown', (e) => {
      const i = buttons.indexOf(document.activeElement);
      if (i === -1) return;
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      select(buttons[(i + step + buttons.length) % buttons.length].dataset.colour, true);
    });
  }

  // ------------------------------------------------- show notes on the page

  /** "Show notes on the page" switch: stored in chrome.storage.sync, on unless switched off.
   *  Open pages pick the change up straight away from their storage listener. */
  async function setUpShowNotes() {
    const box = $('showNotes');
    const { showNotes } = await chrome.storage.sync.get('showNotes');
    box.checked = showNotes !== false;
    box.addEventListener('change', () => chrome.storage.sync.set({ showNotes: box.checked }));
  }

  // ---------------------------------------------------------- review prompt

  /**
   * Count this open and, on the 2nd, 5th, 10th, 15th ... open, show the
   * "leave a review" panel (rule in lib/review.js). It sits above the rest of
   * the popup and never blocks it.
   *   - Any star: status 'done', open the store's review page, hide the panel.
   *     Every star goes to the same page; ratings are never steered.
   *   - "Remind me later": hide the panel; it comes back at the next qualifying open.
   *   - "Don't ask again": status 'never', hide the panel.
   * Stored in chrome.storage.local under wmt:popupOpens and wmt:reviewStatus.
   */
  async function setUpReviewPrompt() {
    const stored = await chrome.storage.local.get([review.OPENS_KEY, review.STATUS_KEY]);
    const status = review.normaliseStatus(stored[review.STATUS_KEY]);
    // Once settled there is nothing left to count or show.
    if (status !== review.STATUS.PENDING) return;
    const opens = review.normaliseOpens(stored[review.OPENS_KEY]) + 1;
    await chrome.storage.local.set({ [review.OPENS_KEY]: opens });
    if (!review.shouldAsk(opens, status)) return;

    const panel = $('reviewPanel');
    const group = $('reviewStars');
    const STAR_PATH = 'M12 2.8l2.85 5.78 6.38.93-4.62 4.5 1.09 6.35L12 17.36l-5.7 3 1.09-6.35-4.62-4.5 6.38-.93z';
    const stars = [1, 2, 3, 4, 5].map((n) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'star';
      btn.dataset.star = String(n);
      btn.setAttribute('aria-label', `Rate ${n} star${n === 1 ? '' : 's'}`);
      btn.tabIndex = n === 1 ? 0 : -1; // one tab stop for the row; arrow keys move along it
      btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${STAR_PATH}"/></svg>`;
      group.append(btn);
      return btn;
    });

    // Light stars 1..n (0 = none lit).
    const light = (n) => stars.forEach((b, i) => b.classList.toggle('lit', i < n));
    const starOf = (el) => (el && el.closest ? el.closest('.star') : null);
    // Whichever of hover or focus applies; hover wins while the pointer is over a star.
    let hovered = 0;
    const refresh = () => {
      const focused = starOf(document.activeElement);
      light(hovered || (focused ? Number(focused.dataset.star) : 0));
    };
    group.addEventListener('mouseover', (e) => { const s = starOf(e.target); if (s) { hovered = Number(s.dataset.star); refresh(); } });
    group.addEventListener('mouseleave', () => { hovered = 0; refresh(); });
    group.addEventListener('focusin', refresh);
    group.addEventListener('focusout', () => setTimeout(refresh, 0)); // after focus has moved on

    group.addEventListener('keydown', (e) => {
      const i = stars.indexOf(document.activeElement);
      if (i === -1) return;
      const to = { ArrowRight: i + 1, ArrowUp: i + 1, ArrowLeft: i - 1, ArrowDown: i - 1, Home: 0, End: stars.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      const next = stars[Math.max(0, Math.min(stars.length - 1, to))];
      stars.forEach((b) => { b.tabIndex = b === next ? 0 : -1; });
      next.focus();
    });

    // Closing removes the focused button, so put focus somewhere sensible: the popup's heading
    // (always there, even when the main section is replaced by a message). Tab then reaches the first control.
    const close = () => { panel.hidden = true; $('popupTitle').focus(); };

    group.addEventListener('click', async (e) => {
      if (!starOf(e.target)) return;
      // Save first: opening a tab closes a real popup straight away.
      await chrome.storage.local.set({ [review.STATUS_KEY]: review.STATUS.DONE });
      close();
      await chrome.tabs.create({ url: review.REVIEW_URL });
    });
    $('reviewLater').addEventListener('click', close); // status stays 'pending'
    $('reviewNever').addEventListener('click', async () => {
      await chrome.storage.local.set({ [review.STATUS_KEY]: review.STATUS.NEVER });
      close();
    });

    panel.hidden = false;
  }

  setUpSwatches();
  setUpShowNotes();
  setUpReviewPrompt().catch(() => { /* a review prompt must never break the popup */ });
  load();
})();

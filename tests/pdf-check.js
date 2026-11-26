/**
 * tests/pdf-check.js
 * Check (p): PDFs opened in the extension's own viewer. Ten steps (a to j), each
 * with its own verdict and evidence. It runs in its own fresh browser (and a
 * second one for the old-Chrome step), so nothing from the web page checks is mixed in.
 *
 * checks.js calls this with a few of its own helpers, so the rules for notes
 * (where a margin note may sit) are the same for web pages and PDFs.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const h = require('./lib/harness');
const pdf = require('./lib/pdf');
const v = require('./lib/pdf-viewer');
const { decodePng } = require('./lib/png');

const S = h.SELECTORS;
const V = v.VIEWER;
const sleep = h.sleep;

const ALIGN_PX = 3;              // marks must be within this of their words in the viewer
const PRINT_COVERED = 0.85;      // share of each marked word's width that must carry the mark on paper
const UNDERLINE_GAP = 10;        // pixels (96 dpi): the widest break an underline leaves around a letter's tail
const STRAY_PIXELS = 40;         // changed pixels allowed on a printed page away from any mark (96 dpi)
const FIXTURE_PDFS = path.join(__dirname, 'fixtures', 'pdfs');

/** A word box ({x0,y0,x1,y1}) in the shape lib/pdf.js expects. */
const asPdfBox = (b) => ({ xMin: b.x0, yMin: b.y0, xMax: b.x1, yMax: b.y1 });

const STEPS = {
  a: 'Chrome\'s PDF tab: the popup offers "Mark up this PDF" and it opens the viewer',
  b: 'Highlight, underline and note on page 1 and a later page; quotes saved with correct spaces',
  c: 'Reload: every mark returns on the right words, also on a page not yet drawn',
  d: 'Zoom in and out: marks stay on their words (3px); the note stays beside its passage',
  e: 'Popup in the viewer: counts, "Copy as Markdown", Source is the PDF\'s address',
  f: 'Print through the viewer to a real PDF: pages, text, highlights in place, no blank sheets',
  g: 'A scanned PDF says clearly it cannot be marked, and nothing breaks',
  h: 'The same PDF under another address keeps its marks',
  i: 'Old Chrome (a needed feature removed): PDFs stay in Chrome\'s viewer, the popup explains, web pages work',
  j: 'No extension errors in the console during steps a to i',
};

module.exports = function makePdfCheck({ notePlacementProblem, sharesArea }) {
  return async function run(ctx) {
    const { site } = ctx;
    const steps = Object.fromEntries(Object.entries(STEPS).map(([k, title]) => [k, { step: k, title, problems: [], evidence: [], screenshots: [], tested: 0 }]));
    const say = (k, text) => { steps[k].evidence.push(text); steps[k].tested++; };
    const bad = (k, text) => { steps[k].problems.push(text); steps[k].tested++; };
    const snap = async (k, page, name) => { const f = await h.screenshot(page, `${site.slug}/p-${k}-${name}`); if (f) steps[k].screenshots.push(f); return f; };
    /** Run part of a step; a crash is recorded against that step and the rest carries on. */
    const attempt = async (k, label, fn) => {
      try { await fn(); } catch (e) { bad(k, `${label}: could not finish: ${e.message.split('\n')[0].slice(0, 220)}`); }
    };

    const errors = []; // every console error and uncaught exception seen by this check
    const watch = (session) => session.context.on('page', (p) => h.captureConsole(p, errors, session.extensionId, 'pdf check'));
    const printDir = path.join(h.PRINT_DIR, site.slug);
    fs.mkdirSync(printDir, { recursive: true });

    const docs = [
      { name: 'sample', url: ctx.baseUrl + site.pdf, file: path.join(h.REPO_ROOT, 'test-sites', site.pdf), later: 4 },
      { name: 'columns', url: `${ctx.fixtureUrl}/pdfs/columns.pdf`, file: path.join(FIXTURE_PDFS, 'columns.pdf'), later: 3, twoColumns: true },
      { name: 'rotated', url: `${ctx.fixtureUrl}/pdfs/rotated.pdf`, file: path.join(FIXTURE_PDFS, 'rotated.pdf'), later: 2 },
      { name: 'long', url: `${ctx.fixtureUrl}/pdfs/long.pdf`, file: path.join(FIXTURE_PDFS, 'long.pdf'), later: 45 },
    ];

    let session;
    try {
      session = await h.launch({ headed: ctx.headed });
      watch(session);
      const keyOfViewer = (p) => p.evaluate(() => WMT.host.pageUrl());
      const storedFor = async (key) => { const all = await h.getStored(session); return (all[`page:${key}`] && all[`page:${key}`].markups) || []; };
      const viewerAddress = (url) => `chrome-extension://${session.extensionId}/${V.path}?file=${encodeURIComponent(url)}`;
      /** The popup attached to a viewer tab, given exactly what the browser says about that tab. */
      const popupFor = async (page) => {
        await page.bringToFront();
        const tab = await page.evaluate(async () => { const t = await chrome.tabs.getCurrent(); return { id: t.id, url: t.url || location.href, title: t.title || document.title, active: true }; });
        return h.openPopup(session, { tab });
      };

      // =====================================================================
      // (a) From Chrome's own PDF tab to the viewer
      // =====================================================================
      const first = await session.context.newPage();
      await attempt('a', 'sample', async () => {
        const url = docs[0].url;
        const resp = await first.goto(url, { timeout: 15000 });
        await sleep(2000);
        const type = resp ? resp.headers()['content-type'] : null;
        const builtIn = first.frames().some((f) => f.url().startsWith('chrome-extension://') && !f.url().includes(session.extensionId));
        await snap('a', first, 'chrome-pdf-tab');
        if (!builtIn) bad('a', 'the PDF did not open in Chrome\'s own viewer');
        else say('a', `Chrome's own viewer shows ${url} (${type})`);
        // The popup is given the real tab: same id and address the browser itself reports.
        const tab = await h.inWorker(session, async (u) => {
          const t = (await chrome.tabs.query({})).find((x) => (x.url || '') === u);
          return t ? { id: t.id, url: t.url, title: t.title, active: true } : null;
        }, url);
        if (!tab) throw new Error('the browser does not report a tab with the PDF\'s address');
        const popup = await h.openPopup(session, { tab });
        await popup.waitForSelector(`${V.popup.section}:not([hidden])`, { timeout: 8000 });
        const label = (await popup.textContent(V.popup.open)).trim();
        const shown = await popup.locator(V.popup.open).isVisible();
        const mainHidden = !(await popup.locator(V.popup.main).isVisible());
        await snap('a', popup, 'popup-on-pdf-tab');
        if (!shown || label !== 'Mark up this PDF') bad('a', `popup button visible: ${shown}, label "${label}"`);
        else say('a', `popup shows the button "${label}"${mainHidden ? ' instead of the marks list' : ''}`);
        await popup.click(V.popup.open);
        await first.waitForURL((u) => u.href.startsWith(`chrome-extension://${session.extensionId}/${V.path}`), { timeout: 15000 });
        const how = await v.viewerReady(first);
        const title = (await first.textContent(V.title)).trim();
        const count = (await first.textContent(V.pageCount)).trim();
        await snap('a', first, 'viewer');
        if (how !== 'network' && how !== 'stash') bad('a', `the viewer did not load the PDF (state "${how}")`);
        else say('a', `clicking it opened the viewer in the same tab: "${title}", pages ${count}, bytes from "${how}"`);
        if (!popup.isClosed()) await popup.close();
      });

      // =====================================================================
      // Per document: control print, (b) mark, (c) reload, (d) zoom, (e) popup, (f) print
      // =====================================================================
      for (const doc of docs) {
        const page = doc.name === 'sample' && first.url().includes(V.path) ? first : await session.context.newPage();
        let truth;
        let phrases = [];
        await attempt('b', `${doc.name}: opening`, async () => {
          truth = v.readPdf(doc.file);
          if (page !== first || !page.url().includes(V.path)) await page.goto(viewerAddress(doc.url), { timeout: 20000 });
          await page.bringToFront();
          const how = await v.viewerReady(page);
          if (how !== 'network' && how !== 'stash') throw new Error(`the viewer could not load ${doc.url} (state "${how}")`);
          doc.title = (await page.textContent(V.title)).trim();
          doc.key = await keyOfViewer(page);
        });
        if (!doc.key) { await page.close().catch(() => {}); continue; }

        // The print of the untouched document, to compare the marked print with later.
        await attempt('f', `${doc.name}: print before marking`, async () => {
          doc.control = path.join(printDir, `${doc.name}-before-markup.pdf`);
          await printViaViewer(page, doc.control, 'button');
        });

        // ------------------------------------------------------------- (b)
        await attempt('b', doc.name, async () => {
          for (const n of [1, doc.later]) {
            const pg = truth[n - 1];
            let three;
            if (doc.twoColumns) {
              const left = v.crossLinePhrases(pg, 1, { column: 'left' });
              const right = v.crossLinePhrases(pg, 1, { column: 'right', avoid: left });
              three = [...left, ...right, ...v.crossLinePhrases(pg, 1, { avoid: [...left, ...right] })];
            } else three = v.crossLinePhrases(pg, 3);
            if (three.length < 3) {
              // A page with very little text (a title page) has few line ends; the rest are taken from inside a line.
              const more = v.inLinePhrases(pg, 3 - three.length, three);
              if (more.length) steps.b.evidence.push(`${doc.name} p${n}: only ${three.length} line end(s) usable on this page, so ${more.length} phrase(s) are from inside a line`);
              three = [...three, ...more];
            }
            if (three.length < 3) bad('b', `${doc.name} p${n}: the harness found only ${three.length} usable phrases`);
            three.forEach((p, i) => phrases.push({ ...p, kind: ['highlight', 'underline', 'note'][i] }));
          }
          if (doc.twoColumns) {
            // Lines that break in the middle of a word with a hyphen (made that way by make-pdfs.js).
            const lines = truth[0].lines;
            const i = lines.findIndex((l) => l.words.map((w) => w.text).join(' ').endsWith('Trust re-'));
            if (i < 0) bad('b', 'columns: the hyphenated test lines were not found in the PDF');
            else {
              phrases.push({
                page: 1, rot: 0, kind: 'highlight', hyphen: true,
                key: v.strip('re-introducedotterstotheup-pervalley'), quote: 'reintroduced otters to the upper valley',
                boxes: [v.union(lines[i].words.slice(-1)), v.union(lines[i + 1].words), v.union(lines[i + 2].words.slice(0, 2))],
                words: [lines[i].words.at(-1), ...lines[i + 1].words, ...lines[i + 2].words.slice(0, 2)],
              });
            }
          }
          let noteNo = 0;
          for (const p of phrases) {
            const where = `${doc.name} p${p.page} ${p.kind}`;
            if (p.page !== 1 && !(await v.hasText(page, p.page))) await v.goToPage(page, p.page);
            if (p.kind === 'note') p.note = `Harness note ${doc.name} ${++noteNo} on page ${p.page}`;
            const r = await markOne(page, doc, p, storedFor);
            if (r.problem) { bad('b', `${where} "${p.quote}": ${r.problem}`); continue; }
            p.id = r.saved.id;
            p.savedKind = r.saved.kind;
            p.colour = r.saved.colour;
            const exact = h.STORAGE.quoteOf(r.saved);
            const issues = [];
            if (exact !== p.quote) issues.push(`saved quote is ${JSON.stringify(exact)}, expected ${JSON.stringify(p.quote)}`);
            if (r.saved.anchor.pdfPage !== p.page) issues.push(`saved on page ${r.saved.anchor.pdfPage}`);
            if (p.note && r.saved.note !== p.note) issues.push(`saved note is ${JSON.stringify(r.saved.note)}`);
            if (!r.align.ok) issues.push(`painted off its words: ${r.align.summary}`);
            if (r.changed !== null && r.changed < 0.02) issues.push('the screen did not change on the words');
            if (issues.length) bad('b', `${where}: ${issues.join('; ')}`);
            else say('b', `${where}: saved "${exact}" (${p.boxes.length > 1 ? 'across a line end' : 'within a line'}), painted within ${r.align.worst}px, ${Math.round(r.changed * 100)}% of pixels changed; selected by ${r.method}`);
          }
          await v.goToPage(page, 1);
          await snap('b', page, `${doc.name}-page1`);
          await v.goToPage(page, doc.later);
          await snap('b', page, `${doc.name}-page${doc.later}`);
        });
        const made = phrases.filter((p) => p.id);
        doc.marks = made;
        doc.truth = truth;
        if (!made.length) { bad('c', `${doc.name}: no marks were made, nothing to test`); await page.close().catch(() => {}); continue; }
        // Quirk worth recording: how a real compound word split at its hyphen is saved.
        if (doc.twoColumns) {
          await attempt('b', 'columns: compound word split at a line end', async () => {
            const clean = await page.evaluate(() => WMT.host._buildClean([document.querySelector('#viewer .page[data-page-number="1"] .textLayer')]).text);
            const m = clean.match(/a (well\W?\s?known) success/);
            steps.b.evidence.push(`observation (not judged): the compound "well-/known", split over two lines, reads as "${m ? m[1] : '?'}" in the viewer's saved text`);
          });
        }

        // ------------------------------------------------------------- (c)
        await attempt('c', doc.name, async () => {
          await page.reload();
          await v.viewerReady(page);
          const laterDrawn = await v.hasText(page, doc.later);
          const earlyChip = (await h.getUi(page)).chip;
          if (earlyChip && earlyChip.shown) bad('c', `${doc.name}: before scrolling, the page says "${earlyChip.text}"`);
          if (doc.name === 'long' && laterDrawn) bad('c', `long: page ${doc.later} was already drawn after the reload, so the "not yet drawn" case was not exercised`);
          for (const n of [1, doc.later]) {
            if (n !== 1) await v.goToPage(page, n);
            const mine = made.filter((p) => p.page === n);
            const results = [];
            for (const p of mine) {
              const a = await alignedSoon(page, doc, p);
              if (!a.ok) bad('c', `${doc.name} p${n} ${p.kind} "${p.quote}": ${a.summary}`);
              else results.push(a.worst);
              if (p.note) {
                await v.onPagePhrase(page, p.page, p.key, 'reveal');
                const judged = await noteSoon(page, doc, p);
                if (judged.problems.length) bad('c', `${doc.name} p${n} note: ${judged.problems.join('; ')}`);
                else results.noteShown = judged.kind;
              }
            }
            if (results.length) say('c', `${doc.name} p${n}${n !== 1 ? (laterDrawn ? ' (drawn straight after the reload)' : ' (not drawn until scrolled to)') : ''}: ${results.length} of ${mine.length} marks back on their words, worst ${Math.max(...results)}px${results.noteShown ? `; note shown as ${results.noteShown}` : ''}`);
            await snap('c', page, `${doc.name}-page${n}`);
          }
          const chip = (await h.getUi(page)).chip;
          if (chip && chip.shown) bad('c', `${doc.name}: after scrolling, the page says "${chip.text}"`);
          const now = await storedFor(doc.key);
          if (now.length !== made.length) bad('c', `${doc.name}: ${now.length} marks saved after the reload, ${made.length} expected`);
        });

        // ------------------------------------------------------------- (d)
        await attempt('d', doc.name, async () => {
          const scale = () => page.evaluate(() => Math.round(__wmtViewer.viewer.currentScale * 100));
          await v.goToPage(page, 1);
          const startScale = await scale();
          const plan = [['starting zoom', []], ['zoomed in once', [V.zoomIn]], ['zoomed in three times', [V.zoomIn, V.zoomIn]],
            ['zoomed out below the start', Array(5).fill(V.zoomOut)], ['fit width', [V.zoomFit]]];
          let marginSeen = false;
          for (const [label, buttons] of plan) {
            for (const b of buttons) { await page.click(b); await sleep(250); }
            await sleep(1200);
            const pct = await scale();
            const parts = [];
            let worst = 0;
            let okCount = 0;
            let total = 0;
            for (const n of [1, doc.later]) {
              await v.goToPage(page, n);
              for (const p of made.filter((m) => m.page === n)) {
                total++;
                await v.onPagePhrase(page, n, p.key, 'reveal');
                const a = await alignedSoon(page, doc, p);
                if (!a.ok) {
                  bad('d', `${doc.name} ${label} (${pct}%) p${n} ${p.kind} "${p.quote}": ${a.summary}`);
                  if (!doc.offShot) { doc.offShot = true; await snap('d', page, `${doc.name}-off`); }
                }
                else { okCount++; worst = Math.max(worst, a.worst); }
                if (p.note) {
                  const judged = await noteSoon(page, doc, p);
                  if (judged.problems.length) bad('d', `${doc.name} ${label} (${pct}%) p${n} note: ${judged.problems.join('; ')}`);
                  else parts.push(`p${n} note: ${judged.kind}${judged.info ? ` (${judged.info})` : ''}`);
                  if (judged.isMargin) marginSeen = true;
                  if (n === 1) await snap('d', page, `${doc.name}-${label.replace(/\s+/g, '-')}`);
                }
              }
            }
            say('d', `${doc.name} ${label} (${pct}%): ${okCount} of ${total} marks within ${ALIGN_PX}px (worst ${worst}px); ${parts.join(', ')}`);
          }
          if (!marginSeen) bad('d', `${doc.name}: at no zoom level (start ${startScale}%) was a note shown as a margin note beside the page`);
        });

        // ------------------------------------------------------------- (e)
        await attempt('e', doc.name, async () => {
          await v.goToPage(page, 1);
          const saved = await storedFor(doc.key);
          const popup = await popupFor(page);
          await popup.waitForSelector(`${V.popup.main}:not([hidden])`, { timeout: 8000 });
          await sleep(300);
          const countLine = (await popup.textContent(S.popup.countLine)).trim();
          const breakdown = (await popup.textContent(S.popup.breakdown)).trim();
          const underlines = made.filter((p) => p.kind === 'underline').length;
          const notes = made.filter((p) => p.note).length;
          const wantCount = `${made.length} markups on this page`;
          const wantBreak = [`${made.length - underlines} highlights`, `${underlines} underline${underlines === 1 ? '' : 's'}`, notes === 1 ? '1 with a note' : `${notes} with notes`].join(' · ');
          if (countLine !== wantCount) bad('e', `${doc.name}: popup says "${countLine}", expected "${wantCount}"`);
          if (breakdown !== wantBreak) bad('e', `${doc.name}: popup breakdown "${breakdown}", expected "${wantBreak}"`);
          const check = (await popup.textContent(S.popup.checkList)).replace(/\s+/g, ' ').trim();
          if (/could not be found/.test(check)) bad('e', `${doc.name}: "Check this page" says: ${check}`);
          await popup.click(S.popup.copyButton);
          await popup.waitForFunction(() => window.__copied.length, null, { timeout: 5000 });
          const md = (await popup.getCopied())[0];
          const rows = saved.map((m) => { const k = made.find((p) => p.id === m.id); return { text: k ? k.quote : '(unknown)', note: k ? k.note || '' : '', kind: k ? k.savedKind : m.kind, colour: k ? k.colour : m.colour }; });
          const want = h.COPY_FORMAT(doc.title, doc.url, rows);
          const missing = made.filter((p) => !md.includes(p.quote)).map((p) => p.quote);
          const missingNotes = made.filter((p) => p.note && !md.includes(p.note)).map((p) => p.note);
          const source = (md.match(/^Source: (.*)$/m) || [])[1];
          if (missing.length) bad('e', `${doc.name}: ${missing.length} phrase(s) not in the Markdown, e.g. "${missing[0]}"`);
          if (missingNotes.length) bad('e', `${doc.name}: note missing from the Markdown: "${missingNotes[0]}"`);
          if (source !== doc.url) bad('e', `${doc.name}: Source is "${source}", expected "${doc.url}"`);
          if (h.stripExportTime(md) !== h.stripExportTime(want)) {
            const a = h.stripExportTime(md).split('\n');
            const b = h.stripExportTime(want).split('\n');
            const i = b.findIndex((line, k) => line !== a[k]);
            bad('e', `${doc.name}: the Markdown differs from the expected text at line ${i + 1}: got ${JSON.stringify(a[i])}, expected ${JSON.stringify(b[i])}`);
          }
          fs.writeFileSync(path.join(printDir, `${doc.name}-copy.md`), md);
          say('e', `${doc.name}: "${countLine}" (${breakdown}); check list: "${check}"; Markdown has ${made.length - missing.length}/${made.length} phrases, ${notes - missingNotes.length}/${notes} notes, Source: ${source}`);
          await snap('e', popup, `${doc.name}-popup`);
          await popup.close();
          await page.bringToFront();
        });

        // ------------------------------------------------------------- (f)
        await attempt('f', doc.name, async () => {
          if (!ctx.pdfTools || ctx.headed) throw new Error('needs the poppler tools and the default headless mode');
          await v.goToPage(page, 1);
          const p = made.find((m) => m.page === 1);
          await v.onPagePhrase(page, 1, p.key, 'reveal');
          const before = await alignedSoon(page, doc, p);
          const out = path.join(printDir, `${doc.name}.pdf`);
          const atPrint = await printViaViewer(page, out, 'ctrl+p');
          judgePrint(doc, out, atPrint, (t) => bad('f', `${doc.name}: ${t}`), (t) => say('f', `${doc.name}: ${t}`));
          // After printing, the marks must be back on the screen pages.
          await v.goToPage(page, 1);
          await v.onPagePhrase(page, 1, p.key, 'reveal');
          const back = await alignedSoon(page, doc, p);
          const leftover = await page.locator(V.printCopy).count();
          // Printing must leave the screen as it found it (alignment itself is step d's job).
          const same = back.worst !== null && before.worst !== null && Math.abs(back.worst - before.worst) <= 1;
          if (!same) bad('f', `${doc.name}: after printing, the mark "${p.quote}" is not back as it was: before "${before.summary}", after "${back.summary}"`);
          if (leftover) bad('f', `${doc.name}: the print copy was left in the page`);
          if (same && !leftover) say('f', `${doc.name}: after printing the print copy is gone and the marks are back on screen as before`);
        });
        doc.page = page;
        if (doc.name !== 'sample') await page.close().catch(() => {});
      }

      // =====================================================================
      // (g) A scan
      // =====================================================================
      await attempt('g', 'scan', async () => {
        const page = await session.context.newPage();
        const url = `${ctx.fixtureUrl}/pdfs/scan.pdf`;
        const before = Object.keys(await h.getStored(session)).filter((k) => k.startsWith('page:'));
        await page.goto(viewerAddress(url));
        const how = await v.viewerReady(page);
        await page.waitForSelector(`html[${V.textAttr}="none"]`, { state: 'attached', timeout: 15000 });
        const message = page.locator(V.message);
        const text = (await message.isVisible()) ? (await message.textContent()).trim() : '';
        await snap('g', page, 'scan-message');
        if (!/no text/i.test(text) || !/cannot be marked/i.test(text)) bad('g', `the viewer's message is ${JSON.stringify(text)}`);
        else say('g', `loaded (${how}), text "none"; the viewer says: "${text}"`);
        // Try to mark it anyway: drag across the page, then double-click.
        const box = await page.locator(`${V.page(1)} canvas`).boundingBox();
        await page.mouse.move(box.x + box.width * 0.15, box.y + 120);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.8, box.y + 330, { steps: 10 });
        await page.mouse.up();
        const afterDrag = await h.waitForToolbar(page, 1000);
        await page.mouse.dblclick(box.x + box.width * 0.4, box.y + 200);
        const afterDouble = await h.waitForToolbar(page, 800);
        if (afterDrag || afterDouble) bad('g', 'a markup toolbar appeared on a page with no text');
        else say('g', 'dragging and double-clicking on the picture offer no toolbar');
        const popup = await popupFor(page);
        await sleep(1000);
        const popupText = (await popup.locator('body').innerText()).replace(/\s+/g, ' ').trim();
        await snap('g', popup, 'scan-popup');
        await popup.close();
        steps.g.evidence.push(`observation (not judged): the popup on the scan says: "${popupText.slice(0, 200)}"`);
        await page.bringToFront();
        await page.click(V.zoomIn);
        await page.click(V.zoomOut);
        await v.goToPage(page, 2);
        say('g', 'zoom buttons and moving to page 2 work');
        const out = path.join(printDir, 'scan.pdf');
        await printViaViewer(page, out, 'button');
        const printed = v.readPdf(out);
        const blank = printed.filter((p) => inkShare(pdf.renderPage(out, p.number)) < 0.001).map((p) => p.number);
        if (printed.length !== 2 || blank.length) bad('g', `printing the scan gave ${printed.length} sheets (2 expected), blank: ${blank.join(', ') || 'none'}`);
        else say('g', 'prints as 2 sheets, neither blank');
        const after = Object.keys(await h.getStored(session)).filter((k) => k.startsWith('page:'));
        if (after.length !== before.length) bad('g', 'something was saved for the scan');
        await page.close();
      });

      // =====================================================================
      // (h) Same document, different address
      // =====================================================================
      await attempt('h', 'sample', async () => {
        const doc = docs[0];
        if (!doc.marks || !doc.marks.length) throw new Error('the sample PDF has no marks to look for');
        const other = `${ctx.fixtureUrl}/pdfs/renamed-report.pdf?session=9f3a`;
        const page = await session.context.newPage();
        await page.goto(viewerAddress(other));
        await v.viewerReady(page);
        const key = await keyOfViewer(page);
        if (key !== doc.key) bad('h', `the key changed: ${doc.key} became ${key}`);
        else say('h', `${doc.url} and ${other} are both stored as ${key}`);
        let good = 0;
        for (const n of [1, doc.later]) {
          await v.goToPage(page, n);
          for (const p of doc.marks.filter((m) => m.page === n)) {
            const a = await alignedSoon(page, doc, p);
            if (!a.ok) bad('h', `p${n} ${p.kind} "${p.quote}": ${a.summary}`); else good++;
          }
          await snap('h', page, `other-address-page${n}`);
        }
        say('h', `${good} of ${doc.marks.length} marks are on their words at the new address`);
        const all = await h.getStored(session);
        const meta = all[`pdfdoc:${key.slice(V.keyPrefix.length)}`];
        const addresses = (meta && meta.addresses) || [];
        if (!addresses.some((a) => a.includes('renamed-report')) || !addresses.some((a) => a.includes('sample.pdf'))) bad('h', `addresses remembered: ${JSON.stringify(addresses)}`);
        else say('h', `both addresses are remembered (${addresses.length})`);
        const popup = await popupFor(page);
        await popup.waitForSelector(`${V.popup.main}:not([hidden])`, { timeout: 8000 });
        await popup.click(S.popup.copyButton);
        await popup.waitForFunction(() => window.__copied.length, null, { timeout: 5000 });
        const source = ((await popup.getCopied())[0].match(/^Source: (.*)$/m) || [])[1];
        if (source !== other) bad('h', `Source at the new address is "${source}"`); else say('h', `the export's Source is the new address`);
        await popup.close();
        // Different documents must not share marks.
        const keys = docs.map((d) => d.key).filter(Boolean);
        if (new Set(keys).size !== keys.length) bad('h', `two different PDFs share a key: ${keys.join(', ')}`);
        else say('h', `the ${keys.length} different test PDFs have ${keys.length} different keys`);
        await page.close();
      });
    } catch (e) {
      bad('a', `the browser for these steps could not be used: ${e.message.split('\n')[0]}`);
    } finally {
      if (session) { errors.push(...session.workerErrors); await session.close(); }
    }

    // =======================================================================
    // (i) Old Chrome
    // =======================================================================
    let old;
    await attempt('i', 'old Chrome', async () => {
      old = await h.launch({ headed: ctx.headed });
      watch(old);
      const remove = () => { delete Map.prototype.getOrInsertComputed; };
      await old.context.addInitScript(remove); // pages, including the popup
      await h.inWorker(old, remove); // and the background worker
      await h.inWorker(old, () => chrome.storage.sync.set({ 'wmt:pdfAutoOpen': true })); // even "always open" must not redirect
      const url = ctx.baseUrl + site.pdf;
      const tabPage = await old.context.newPage();
      await tabPage.goto(url);
      await sleep(3000);
      await snap('i', tabPage, 'pdf-tab');
      if (tabPage.url() !== url) bad('i', `the PDF tab was sent to ${tabPage.url()}`);
      else say('i', 'with "Always open PDFs in the markup viewer" on, the PDF stays in Chrome\'s own viewer');
      const tab = await h.inWorker(old, async (u) => {
        const t = (await chrome.tabs.query({})).find((x) => (x.url || '') === u);
        return t ? { id: t.id, url: t.url, title: t.title, active: true } : null;
      }, url);
      const popup = await h.openPopup(old, { tab });
      await popup.waitForSelector(`${V.popup.section}:not([hidden])`, { timeout: 8000 });
      await sleep(500);
      const simulated = await popup.evaluate(() => ({ removed: typeof Map.prototype.getOrInsertComputed === 'undefined', supported: WMT.url.pdfViewerSupported() }));
      const workerRemoved = await h.inWorker(old, () => typeof Map.prototype.getOrInsertComputed === 'undefined');
      if (!simulated.removed || simulated.supported || !workerRemoved) bad('i', `the simulation did not take effect: popup removed ${simulated.removed}, worker removed ${workerRemoved}, viewer thought supported ${simulated.supported}`);
      const status = (await popup.textContent(V.popup.status)).trim();
      const button = await popup.locator(V.popup.open).isVisible();
      await snap('i', popup, 'popup');
      if (button || !/newer version of Chrome/i.test(status)) bad('i', `popup: button visible ${button}, message "${status}"`);
      else say('i', `no "Mark up this PDF" button; the popup says: "${status}"`);
      const reply = await popup.evaluate((m) => chrome.runtime.sendMessage(m), { type: 'pdf.openViewer', url, tabId: tab.id });
      if (!reply || reply.ok) bad('i', 'the background worker still agreed to send the tab to the viewer');
      else say('i', `asked directly to open the viewer, the background refuses: "${reply.error}"`);
      await popup.close();
      // Web pages are unaffected.
      const web = await old.context.newPage();
      await web.goto(`${ctx.fixtureUrl}/basic/index.html`);
      if (!(await h.isInjected(web, 5000))) throw new Error('the extension did not start on a web page');
      let slot = 0;
      for (const [action, selector] of [['highlight', '#p1'], ['underline', '#p3']]) {
        const sel = await h.selectText(web, selector, { slot: slot++, slots: 3 });
        if (!sel.ok || !(await h.waitForToolbar(web)) || !(await h.clickToolbar(web, action)).ok) { bad('i', `web page: could not ${action}`); continue; }
        await sleep(600);
        const hit = (await h.getMarkups(web)).find((m) => m.kind === action && h.normaliseText(m.text) === h.normaliseText(sel.text));
        if (!hit || !h.compareRects(sel.rects, hit.rects, 2).ok) bad('i', `web page: the ${action} is not painted on its words`);
        else say('i', `web page: ${action} on "${h.normaliseText(sel.text)}" painted correctly`);
      }
      await web.reload();
      await h.isInjected(web, 5000);
      await sleep(800);
      const back = (await h.getMarkups(web)).length;
      if (back !== 2) bad('i', `web page: ${back} marks after a reload, 2 expected`); else say('i', 'web page: both marks return after a reload');
      await snap('i', web, 'web-page');
    });
    if (old) { errors.push(...old.workerErrors); await old.close(); }

    // =======================================================================
    // (j) Console
    // =======================================================================
    const mine = errors.filter((e) => e.fromExtension);
    ctx.errors.push(...mine.map((e) => ({ ...e, where: `pdf check, ${e.where}` })));
    if (mine.length) {
      const counts = new Map();
      for (const e of mine) { const k = `${e.where}: ${e.text.split('\n')[0].slice(0, 200)}`; counts.set(k, (counts.get(k) || 0) + 1); }
      for (const [k, n] of counts) bad('j', `${n}× ${k}`);
    } else say('j', `no errors from the viewer, popup, content script or background worker (${errors.length} error(s) from other sources ignored)`);

    await ctx.page.bringToFront().catch(() => {});

    const list = Object.values(steps).map((s) => ({
      step: s.step, title: s.title, status: s.problems.length ? 'fail' : s.tested ? 'pass' : 'skip',
      problems: s.problems, evidence: s.evidence, screenshots: s.screenshots,
    }));
    const failed = list.filter((s) => s.status === 'fail');
    const notRun = list.filter((s) => s.status === 'skip');
    const reason = `${list.filter((s) => s.status === 'pass').length} of ${list.length} steps passed (${list.map((s) => `${s.step} ${s.status === 'skip' ? 'not run' : s.status.toUpperCase()}`).join(', ')}).`
      + (failed.length ? ` ${failed.map((s) => `[${s.step}] ${s.problems.length} problem(s), first: ${s.problems[0]}`).join(' | ')}` : '')
      + ' Evidence for every step is listed under the table.';
    return {
      status: failed.length ? 'fail' : notRun.length ? 'skip' : 'pass', reason, steps: list,
      screenshot: (list[0].screenshots || [])[2] || (list[0].screenshots || [])[0] || null,
      details: { errors, documents: docs.map((d) => ({ name: d.name, url: d.url, key: d.key, marks: (d.marks || []).map((m) => ({ page: m.page, kind: m.kind, quote: m.quote })) })) },
    };
  };

  // -------------------------------------------------------------------------
  // Helpers that need the extension's behaviour
  // -------------------------------------------------------------------------

  /** Make one mark the way a person does: select, press the toolbar button, type the note. */
  async function markOne(page, doc, p, storedFor) {
    if (!(await v.onPagePhrase(page, p.page, p.key, 'reveal'))) return { problem: 'the words are not in the viewer\'s text' };
    await sleep(400);
    const truthPage = v.readPdfCache(doc.file)[p.page - 1];
    // Picture of the words before marking, to prove the screen changes.
    const frame = await v.pageFrame(page, p.page, truthPage.width);
    const clip = frame && clipFor(p, frame, page.viewportSize());
    const beforePic = clip ? decodePng(await page.screenshot({ clip, animations: 'disabled' })) : null;
    const sel = await v.selectPhrase(page, p);
    if (!sel.ok) return { problem: `could not select the words (${sel.why})` };
    if (!(await h.waitForToolbar(page, 3000))) return { problem: `no toolbar appeared (selected by ${sel.method})` };
    const had = new Set((await storedFor(doc.key)).map((m) => m.id));
    const click = await h.clickToolbar(page, p.kind);
    if (!click.ok) return { problem: click.why };
    let saved = null;
    for (let i = 0; i < 30 && !saved; i++) { await sleep(100); saved = (await storedFor(doc.key)).find((m) => !had.has(m.id)) || null; }
    if (!saved) return { problem: 'nothing was saved' };
    if (p.kind === 'note') {
      await page.locator(`${S.host} ${S.card} ${S.cardTextarea}`).waitFor({ state: 'attached', timeout: 3000 });
      await sleep(200);
      await page.keyboard.type(p.note);
      let status = '';
      for (let i = 0; i < 30 && status !== 'Saved'; i++) { await sleep(100); const ui = await h.getUi(page); status = (ui.card && ui.card.status) || ''; }
      await h.clickUi(page, `${S.card} ${S.cardClose}`);
      await sleep(400);
      saved = (await storedFor(doc.key)).find((m) => m.id === saved.id);
      if (status !== 'Saved') return { problem: `the note card did not say "Saved" (said "${status}")` };
    }
    await page.evaluate(() => getSelection().removeAllRanges());
    await page.keyboard.press('Escape');
    await page.mouse.move(2, 400);
    await sleep(300);
    const align = await alignedSoon(page, doc, p);
    // The words may have scrolled a little (card opening), so look again where they are now.
    await v.onPagePhrase(page, p.page, p.key, 'reveal');
    await sleep(300);
    const frame2 = await v.pageFrame(page, p.page, truthPage.width);
    const clip2 = frame2 && clipFor(p, frame2, page.viewportSize());
    let changed = null;
    if (beforePic && clip2) {
      const afterPic = decodePng(await page.screenshot({ clip: clip2, animations: 'disabled' }));
      changed = pdf.differingPixels(beforePic, afterPic, 24) / (Math.min(beforePic.width, afterPic.width) * Math.min(beforePic.height, afterPic.height));
    }
    return { saved, align, changed, method: sel.method === 'drag' ? 'a real mouse drag' : `setting the selection in code (${sel.why})` };
  }

  /** The screen area of a phrase's first line (a little taller, so an underline is included). */
  function clipFor(p, frame, vp) {
    const b = p.boxes[0];
    const grow = 4; // points, towards "below" the line as read
    const x0 = frame.left + (b.x0 - (p.rot === 90 ? grow : 0)) * frame.scale;
    const y0 = frame.top + b.y0 * frame.scale;
    const x1 = frame.left + b.x1 * frame.scale;
    const y1 = frame.top + (b.y1 + (p.rot === 90 ? 0 : grow)) * frame.scale;
    const x = Math.max(0, Math.floor(x0));
    const y = Math.max(0, Math.floor(y0));
    const width = Math.min(vp.width - x, Math.ceil(x1 - x));
    const height = Math.min(vp.height - y, Math.ceil(y1 - y));
    return width > 3 && height > 3 ? { x, y, width, height } : null;
  }

  /** Alignment, retried while the extension catches up. */
  async function alignedSoon(page, doc, p, timeout = 4000) {
    const truthPage = v.readPdfCache(doc.file)[p.page - 1];
    const kind = p.kind === 'underline' ? 'underline' : 'highlight';
    const end = Date.now() + timeout;
    let a = await v.judgeAlignment(page, truthPage, p, kind, ALIGN_PX);
    while (!a.ok && Date.now() < end) { await sleep(250); a = await v.judgeAlignment(page, truthPage, p, kind, ALIGN_PX); }
    return a;
  }

  /** Where the note is shown for a passage that is on screen, and whether that is right. */
  async function judgeNote(page, p) {
    await page.mouse.move(2, 400);
    const ui = await h.getUi(page);
    const el = h.noteElementFor(ui, p.id);
    const painted = await v.paintedFor(page, p);
    const passage = painted.length ? painted[0].rects : [];
    if (!el || !el.shown) return { problems: [el ? 'the note on the page is hidden although its words are on screen' : 'no margin note, label or pin is shown'] };
    const problems = [];
    const kind = el.kind === 'margin' ? 'margin note' : el.kind === 'label' ? `label (place ${el.place})` : 'plain pin';
    if (!el.inWindow) problems.push(`the ${kind} is outside the window`);
    else if (!el.onTop) problems.push(`the ${kind} is hidden behind ${el.top}`);
    const shownText = (el.text || '').replace(/…$/, '').trim();
    if (el.kind !== 'pin' && !(el.kind === 'margin' ? shownText.startsWith(p.note) : p.note.startsWith(shownText.slice(0, 12)) && shownText)) problems.push(`the ${kind} shows "${shownText}"`);
    if (passage.some((t) => sharesArea(t, el.rect))) problems.push(`the ${kind} covers its own passage`);
    const placement = notePlacementProblem(el, passage, ui);
    // A margin note must be level with the top of the passage's first painted line. Label places are
    // defined for lines that run across, so they are not judged on a page turned 90 degrees.
    if (placement && (p.rot !== 90 || el.kind === 'margin')) problems.push(placement);
    let info = '';
    if (el.kind === 'margin') {
      const box = await page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { left: r.left, right: r.right }; }, V.page(p.page));
      const side = el.rect.left >= box.right - 2 ? 'right' : el.rect.right <= box.left + 2 ? 'left' : null;
      if (!side) problems.push('the margin note is on top of the PDF page, not beside it');
      else if (passage.length) info = `${side} of the page, top ${Math.round(el.rect.top - passage[0].top)}px from the passage's first line`;
    } else if (el.kind === 'label') {
      const words = await h.pageTextRects(page);
      const covered = words.filter((t) => sharesArea(t, el.rect));
      if (covered.length && el.place !== 'd') problems.push(`the label covers other text (${covered.length} line piece(s))`);
      if (covered.length && el.place === 'd') info = 'last-resort place, covers some text';
    }
    return { problems, kind, info, isMargin: el.kind === 'margin' };
  }
  async function noteSoon(page, doc, p) {
    await sleep(500);
    let r = await judgeNote(page, p);
    for (let i = 0; i < 8 && r.problems.length; i++) { await sleep(300); r = await judgeNote(page, p); }
    return r;
  }

  /**
   * Print through the viewer's own path ("Print or save PDF" or Ctrl+P). The
   * browser's print dialogue cannot be driven, so window.print is replaced: at
   * the instant the viewer calls it, the harness notes what is painted, then
   * saves the page to a real PDF with the browser's own PDF printer.
   */
  async function printViaViewer(page, out, how) {
    await page.bringToFront();
    await page.evaluate(() => {
      window.__atPrint = null;
      window.print = () => {
        let painted = 0;
        for (const [name, hl] of CSS.highlights) {
          if (!name.startsWith('wmt-')) continue;
          for (const r of hl) if (r.startContainer.parentElement && r.startContainer.parentElement.closest('#wmtPrint')) painted++;
        }
        window.__atPrint = { sheets: document.querySelectorAll('#wmtPrint .sheet').length, painted };
      };
    });
    if (how === 'button') await page.click(V.printButton); else await page.keyboard.press('Control+p');
    await page.waitForFunction(() => window.__atPrint, null, { timeout: 150000 });
    const atPrint = await page.evaluate(() => window.__atPrint);
    // "Background graphics" is left unticked, which is the browser's default.
    await page.pdf({ path: out, preferCSSPageSize: true });
    await sleep(300);
    await page.evaluate(() => WMT.host.finishPrint());
    await sleep(800);
    return atPrint;
  }

  /** Judge a printed, marked PDF against the original and against the print made before marking. */
  function judgePrint(doc, out, atPrint, bad, say) {
    const made = doc.marks;
    const orig = doc.truth;
    const printed = v.readPdf(out);
    const control = v.readPdf(doc.control);
    const notes = made.filter((p) => p.note);
    say(`at the moment the viewer asked to print: ${atPrint.sheets} sheets ready, ${atPrint.painted} marks painted on them`);
    if (atPrint.painted !== made.length) bad(`only ${atPrint.painted} of ${made.length} marks were painted on the print copy when the viewer asked to print`);
    // Pages.
    const want = orig.length + 1;
    if (printed.length !== want) bad(`the printed PDF has ${printed.length} pages; expected ${want} (${orig.length} + 1 notes page)`);
    else say(`${printed.length} pages = ${orig.length} document pages + 1 notes page`);
    if (control.length !== orig.length) bad(`printing before any marks gave ${control.length} pages, expected ${orig.length}`);
    const wrongSize = orig.filter((p, i) => printed[i] && (Math.abs(printed[i].width - p.width) > 1.5 || Math.abs(printed[i].height - p.height) > 1.5));
    if (wrongSize.length) bad(`page size differs on page(s) ${wrongSize.map((p) => p.number).join(', ')}`);
    // Text, page by page.
    const words = (file, n) => execFileSync('pdftotext', ['-f', String(n), '-l', String(n), file, '-'], { encoding: 'utf8' }).split(/\s+/).filter(Boolean);
    const textProblems = [];
    let markers = 0;
    let total = 0;
    for (let n = 1; n <= Math.min(orig.length, printed.length); n++) {
      const a = words(doc.file, n);
      const d = diffWords(a, words(out, n));
      total += a.length;
      const extra = [];
      for (const e of d.extra) {
        // A note number: on its own, or stuck to the end of the word it follows.
        if (/^\d{1,2}$/.test(e) && +e >= 1 && +e <= notes.length) { markers++; continue; }
        const k = d.missing.findIndex((w) => e.startsWith(w) && /^\d{1,2}$/.test(e.slice(w.length)));
        if (k >= 0) { d.missing.splice(k, 1); markers++; continue; }
        extra.push(e);
      }
      if (d.missing.length || extra.length) textProblems.push(`page ${n}: missing ${JSON.stringify(d.missing.slice(0, 6))}, extra ${JSON.stringify(extra.slice(0, 6))}`);
    }
    if (textProblems.length) bad(`pdftotext differs from the original on ${textProblems.length} page(s): ${textProblems.slice(0, 3).join(' ; ')}`);
    if (markers !== notes.length) bad(`${markers} note number(s) found in the printed text, ${notes.length} expected`);
    if (!textProblems.length) say(`the ${total} words of the original are all there, page by page; the only additions are ${markers} note number(s)`);
    // Notes list.
    const tail = printed.length > orig.length
      ? v.strip(execFileSync('pdftotext', ['-f', String(orig.length + 1), out, '-'], { encoding: 'utf8' })) : '';
    const lost = notes.filter((p) => !tail.includes(v.strip(p.note)) || !tail.includes(v.strip(p.quote)));
    if (!tail.includes(v.strip('Notes on this page'))) bad('there is no "Notes on this page" list after the document');
    else if (lost.length) bad(`the notes list lacks the note or quote for ${lost.length} note(s), e.g. "${lost[0].note}" / "${lost[0].quote}"`);
    else say(`the last page lists all ${notes.length} notes with their quotes`);
    // Pictures: blank sheets, marks on their words, nothing painted anywhere else.
    const K = pdf.DPI / 72;
    const blank = [];
    const strays = [];
    const rows = [];
    for (let n = 1; n <= printed.length; n++) {
      const img = pdf.renderPage(out, n);
      if (inkShare(img) < 0.001) blank.push(n);
      if (n > orig.length || n > control.length) continue;
      const base = pdf.renderPage(doc.control, n);
      const here = made.filter((p) => p.page === n);
      const allowed = [];
      for (const p of here) {
        const turned = p.rot === 90;
        for (const b of p.boxes) allowed.push({ x0: b.x0 - 6, y0: b.y0 - 6, x1: b.x1 + 6, y1: b.y1 + 6 });
        if (p.note) { // room for the note number after the passage
          const b = p.boxes[p.boxes.length - 1];
          allowed.push(turned ? { x0: b.x0 - 6, y0: b.y1 - 2, x1: b.x1 + 12, y1: b.y1 + 22 } : { x0: b.x1 - 2, y0: b.y0 - 12, x1: b.x1 + 22, y1: b.y1 + 6 });
        }
        // Coverage of each line of the phrase, measured along the reading direction.
        const covered = p.boxes.map((b) => {
          const underline = p.kind === 'underline';
          const area = !underline ? b : turned ? { x0: b.x0 - 5, y0: b.y0, x1: b.x0 + 3, y1: b.y1 } : { x0: b.x0, y0: b.y1 - 3, x1: b.x1, y1: b.y1 + 5 };
          let a = pdf.cropBox(img, asPdfBox(area));
          let c = pdf.cropBox(base, asPdfBox(area));
          if (turned) { a = turnUpright(a); c = turnUpright(c); }
          const from = turned ? b.y0 : b.x0;
          const lineWords = p.words.filter((w) => w.x0 >= b.x0 - 0.1 && w.x1 <= b.x1 + 0.1 && w.y0 >= b.y0 - 0.1 && w.y1 <= b.y1 + 0.1);
          const spans = lineWords.map((w) => [Math.floor(((turned ? w.y0 : w.x0) - from) * K), Math.ceil(((turned ? w.y1 : w.x1) - from) * K)]);
          return underline ? underlineCoverage(a, c, spans) : pdf.columnCoverage(a, c, 24, 0.5, false, spans);
        });
        rows.push({ p, worst: Math.min(...covered) });
      }
      // Changed pixels away from every mark.
      let stray = 0;
      for (let y = 0; y < Math.min(img.height, base.height); y++) {
        for (let x = 0; x < Math.min(img.width, base.width); x++) {
          const o = (y * img.width + x) * img.channels;
          const q = (y * base.width + x) * base.channels;
          if (Math.abs(img.data[o] - base.data[q]) + Math.abs(img.data[o + 1] - base.data[q + 1]) + Math.abs(img.data[o + 2] - base.data[q + 2]) <= 40) continue;
          if (!allowed.some((r) => x >= r.x0 * K && x <= r.x1 * K && y >= r.y0 * K && y <= r.y1 * K)) stray++;
        }
      }
      if (stray > STRAY_PIXELS) strays.push(`page ${n}: ${stray} pixels`);
      if (here.length) execFileSync('pdftoppm', ['-r', '70', '-f', String(n), '-l', String(n), '-singlefile', '-png', out, out.replace(/\.pdf$/, `-page${n}`)]);
    }
    for (const kind of ['highlight', 'underline', 'note']) {
      const mine = rows.filter((r) => r.p.kind === kind);
      if (!mine.length) continue;
      const off = mine.filter((r) => r.worst < PRINT_COVERED);
      if (off.length) bad(`${off.length} of ${mine.length} ${kind} mark(s) are not fully on their words on paper, e.g. p${off[0].p.page} "${off[0].p.quote}": ${Math.round(off[0].worst * 100)}% of the width on its worst line`);
      else say(`all ${mine.length} ${kind} mark(s) sit on their words on paper (at least ${Math.round(Math.min(...mine.map((r) => r.worst)) * 100)}% of every line's word width, "Background graphics" off)`);
    }
    if (strays.length) bad(`paint or other changes away from any mark: ${strays.join(', ')}`);
    else say(`nothing differs from the unmarked print away from the marks (all ${orig.length} pages compared)`);
    if (blank.length) bad(`blank sheet(s): ${blank.join(', ')}`);
    else say('no blank sheets');
  }
};

/**
 * How much of each word's width has an underline that the unmarked page lacks.
 * Browsers break an underline around letters with tails (g, p, y), so gaps of up
 * to UNDERLINE_GAP pixels count as underlined, as does such a gap at either end.
 */
function underlineCoverage(a, b, spans) {
  if (!a || !b) return 0;
  const w = Math.min(a.width, b.width);
  const changed = Array.from({ length: w }, (_, x) => {
    for (let y = 0; y < Math.min(a.height, b.height); y++) {
      const o = (y * a.width + x) * a.channels;
      const q = (y * b.width + x) * b.channels;
      if (Math.abs(a.data[o] - b.data[q]) + Math.abs(a.data[o + 1] - b.data[q + 1]) + Math.abs(a.data[o + 2] - b.data[q + 2]) > 40) return true;
    }
    return false;
  });
  const near = (x, dir) => { for (let k = 0; k <= UNDERLINE_GAP; k++) if (changed[x + dir * k]) return true; return false; };
  let counted = 0;
  let covered = 0;
  for (let x = 0; x < w; x++) {
    if (!spans.some(([f, t]) => x >= f && x <= t)) continue;
    counted++;
    // Underlined here, or in a short gap with line on one side within reach.
    if (changed[x] || near(x, -1) || near(x, 1)) covered++;
  }
  return counted ? covered / counted : 0;
}

/** Share of a page picture that is not white. */
function inkShare(img) {
  let n = 0;
  for (let o = 0; o < img.width * img.height * img.channels; o += img.channels) if (img.data[o] + img.data[o + 1] + img.data[o + 2] < 720) n++;
  return n / (img.width * img.height);
}

/** Turn a picture of text that reads downwards into one that reads left to right. */
function turnUpright(img) {
  if (!img) return img;
  const { width: w, height: hgt, channels: c, data } = img;
  const out = Buffer.alloc(w * hgt * c);
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      // (x, y) -> (y, w - 1 - x): quarter turn anticlockwise.
      data.copy(out, ((w - 1 - x) * hgt + y) * c, (y * w + x) * c, (y * w + x) * c + c);
    }
  }
  return { width: hgt, height: w, channels: c, data: out };
}

/** Words only in a (missing) and only in b (extra), keeping order (longest common subsequence). */
function diffWords(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const missing = [];
  const extra = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) missing.push(a[i++]); else extra.push(b[j++]);
  }
  while (i < n) missing.push(a[i++]);
  while (j < m) extra.push(b[j++]);
  return { missing, extra };
}

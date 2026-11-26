#!/usr/bin/env node
/**
 * tests/make-pdfs.js
 * Makes the PDFs that check (p) uses, into tests/fixtures/pdfs/. They are kept
 * in the repository, so this only needs running again if the content changes:
 *
 *   node tests/make-pdfs.js
 *
 *   sample.pdf     copy of test-sites/pdf-document/sample.pdf (5 pages, A4)
 *   renamed-report.pdf  the same file under another name
 *   columns.pdf    two columns over several pages, plus lines that break mid-word with a hyphen
 *   rotated.pdf    A4 portrait, a page rotated 90 degrees, A5 landscape, A4
 *   long.pdf       60 pages
 *   scan.pdf       two pages that are pictures only (no text at all)
 *
 * Adapted from experiments/pdf-viewer/tests/make-pdfs.js. Uses the system
 * Chromium (print HTML to PDF) plus qpdf, pdftoppm and ImageMagick. Nothing is
 * downloaded. Re-making a file gives it a new identity (fingerprint).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright-core');

const OUT = path.join(__dirname, 'fixtures', 'pdfs');
const SAMPLE = path.resolve(__dirname, '..', 'test-sites', 'pdf-document', 'sample.pdf');

const run = (cmd, args) => {
  try { return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) {
    if (cmd === 'qpdf' && e.status === 3) return e.stdout; // success with warnings
    throw e;
  }
};

const page = (body, css = '') => `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><style>
  body { font: 11pt/1.45 "Liberation Serif", "DejaVu Serif", serif; margin: 0; }
  h1 { font: 700 18pt/1.2 "Liberation Sans", sans-serif; margin: 0 0 10pt; }
  p { margin: 0 0 8pt; }
  ${css}</style></head><body>${body}</body></html>`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-pdfs-'));
  const out = (name) => path.join(OUT, name);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
  const tab = await browser.newPage();
  const print = async (html, file, opts = {}) => {
    await tab.setContent(html, { waitUntil: 'load' });
    await tab.pdf({ path: file, format: 'A4', margin: { top: '20mm', bottom: '20mm', left: '18mm', right: '18mm' }, ...opts });
  };

  fs.copyFileSync(SAMPLE, out('sample.pdf'));
  // The same file under another name, to prove marks follow the document and not its address (step h).
  fs.copyFileSync(SAMPLE, out('renamed-report.pdf'));

  // Two columns, several pages. The words vary from paragraph to paragraph so
  // that most phrases occur only once on their page.
  const pick = (list, n) => list[n % list.length];
  const who = ['warden', 'miller', 'ferryman', 'surveyor', 'gardener', 'archivist', 'treasurer', 'angler', 'beekeeper', 'cooper', 'thatcher'];
  const did = ['counted', 'measured', 'sketched', 'photographed', 'catalogued', 'repaired', 'inspected'];
  const what = ['otter holts', 'sluice gates', 'willow stumps', 'footbridges', 'gauge boards', 'stone culverts', 'nesting rafts', 'boundary posts', 'drainage ditches'];
  const where = ['below the weir', 'beside the old mill', 'along the north bank', 'near the chapel ford', 'above the sheep wash'];
  const col = (n) => `<p>Paragraph ${n} of the newsletter says that the ${pick(who, n)} ${pick(did, n * 3)} ${n + 11} ${pick(what, n * 2)}
    ${pick(where, n)} in week ${n + 100}, and the ${pick(who, n + 4)} wrote entry ${n + 500} in the ledger before supper. Item ${n} is now closed.</p>`;
  await print(page(`<h1>Two-column newsletter</h1>
    <div class="lines"><div>In spring the Trust re-</div><div>introduced otters to the up-</div><div>per valley and a well-</div><div>known success story.</div></div>
    <div class="cols">${Array.from({ length: 44 }, (_, i) => col(i + 1)).join('')}</div>`,
  '.cols { column-count: 2; column-gap: 12mm; } .lines div { white-space: nowrap; }'), out('columns.pdf'));

  // Rotated and mixed page sizes.
  await print(page('<h1>Landscape A5 page</h1><p>This page is A5 and landscape. Its sentence about lanterns is unique.</p>'),
    path.join(tmp, 'a5.pdf'), { format: 'A5', landscape: true });
  run('qpdf', ['--empty', '--pages', SAMPLE, '1-2', path.join(tmp, 'a5.pdf'), SAMPLE, '3', '--', path.join(tmp, 'mixed.pdf')]);
  run('qpdf', [path.join(tmp, 'mixed.pdf'), '--rotate=+90:2', out('rotated.pdf')]);

  // 60 pages.
  const longBody = Array.from({ length: 60 }, (_, i) => `<section><h1>Chapter ${i + 1}</h1>${
    Array.from({ length: 6 }, (_, k) => `<p>Chapter ${i + 1}, paragraph ${k + 1}: the ${pick(who, i + k)} ${pick(did, k)} ${(i + 1) * 7 + k} fish
      ${pick(where, i + k)} before lunch and then lost count, which the minutes of meeting ${i * 6 + k + 1} record without comment.
      This sentence closes paragraph ${k + 1} of chapter ${i + 1}.</p>`).join('')}</section>`).join('');
  await print(page(longBody, 'section { break-after: page; }'), out('long.pdf'));

  // A scan: pictures of pages, no text.
  run('pdftoppm', ['-r', '110', '-f', '1', '-l', '2', '-png', SAMPLE, path.join(tmp, 'scan')]);
  const scans = fs.readdirSync(tmp).filter((f) => f.startsWith('scan') && f.endsWith('.png')).sort().map((f) => path.join(tmp, f));
  run('magick', [...scans, '-units', 'PixelsPerInch', '-density', '110', out('scan.pdf')]);

  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of fs.readdirSync(OUT).sort()) {
    const info = run('pdfinfo', [out(f)]).toString();
    console.log(f.padEnd(16), `${(fs.statSync(out(f)).size / 1e6).toFixed(2)} MB`, (info.match(/Pages:\s+(\d+)/) || [])[1], 'pages');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

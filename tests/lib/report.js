/**
 * tests/lib/report.js
 * Turns the runner's results into files a person can read:
 *   results.json  everything, for programs
 *   results.md    a site × check table plus the reason for every failure
 *   review.html   one self-contained page of pictures (site × state) with each check's verdict
 */

const fs = require('fs');
const path = require('path');
const { OUTPUT_DIR } = require('./harness');

/** Word shown for each status. */
const LABEL = { pass: 'PASS', fail: 'FAIL', gap: 'GAP', skip: 'skip', 'n/a': 'n/a', error: 'ERROR' };
const LEGEND = [
  ['PASS', 'the extension did what was expected'],
  ['FAIL', 'the extension did not do what was expected (the reason says what happened)'],
  ['GAP', 'something the extension is known not to support; recorded, not counted as a failure'],
  ['skip', 'could not be run on this site (the reason says why, usually an earlier failure or text that cannot be selected)'],
  ['n/a', 'the check does not apply to this site'],
  ['ERROR', 'the test itself broke; this says nothing about the extension'],
];

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const byId = (checks) => checks.slice().sort((a, b) => a.id.localeCompare(b.id));
const find = (site, id) => (site.checks || []).find((c) => c.id === id) || { status: 'n/a', reason: 'not run' };

/** Count statuses across sites. */
function totals(results) {
  const t = { pass: 0, fail: 0, gap: 0, skip: 0, 'n/a': 0, error: 0 };
  for (const s of results) for (const c of s.checks) t[c.status] = (t[c.status] || 0) + 1;
  return t;
}

/** Plain-text table for the terminal. */
function consoleTable(results, checks) {
  const ids = byId(checks).map((c) => c.id);
  const w = Math.max(6, ...results.map((r) => r.slug.length)) + 2;
  const lines = ['Site'.padEnd(w) + ids.map((i) => i.padEnd(6)).join('')];
  for (const r of results) lines.push(r.slug.padEnd(w) + ids.map((i) => LABEL[find(r, i).status].padEnd(6)).join(''));
  lines.push('');
  lines.push('Checks: ' + byId(checks).map((c) => `(${c.id}) ${c.title}`).join('; '));
  return lines.join('\n');
}

const mdCell = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function markdown(all, checks) {
  const { meta, results } = all;
  const sorted = byId(checks);
  const t = totals(results);
  const out = [];
  out.push('# Web Page Markup Tool: browser check results', '');
  out.push(`- Extension: ${meta.extension}`);
  out.push(`- Browser: ${meta.browser}, ${meta.mode}, window ${meta.viewport.width}×${meta.viewport.height}`);
  out.push(`- Last run: ${meta.startedAt} (\`${meta.command}\`), took ${meta.durationSeconds}s`);
  out.push(`- Totals: ${t.pass} PASS, ${t.fail} FAIL, ${t.gap} GAP, ${t.skip} skip, ${t['n/a']} n/a, ${t.error} ERROR`);
  out.push(`- Pictures: open \`review.html\` in this folder. Screenshots are in \`screenshots/<site>/\`, print output in \`print/\`.`, '');
  out.push('## What the words mean', '');
  for (const [k, v] of LEGEND) out.push(`- **${k}**: ${v}`);
  out.push('', '## Checks', '');
  for (const c of sorted) out.push(`- **(${c.id}) ${c.title}**: ${c.plain}`);
  out.push('', '## Table (site × check)', '');
  out.push(`| Site | ${sorted.map((c) => c.id).join(' | ')} |`);
  out.push(`|---|${sorted.map(() => '---').join('|')}|`);
  for (const r of results) out.push(`| ${r.slug} | ${sorted.map((c) => LABEL[find(r, c.id).status]).join(' | ')} |`);
  out.push('', '## Detail per site', '');
  for (const r of results) {
    out.push(`### ${r.slug}: ${mdCell(r.title)}`, '');
    out.push(`Page: ${r.url} · run ${r.ranAt} · ${Math.round((r.durationMs || 0) / 1000)}s`
      + (r.selection ? ` · text selected by real mouse drag ${r.selection.realDrag}×, set in code ${r.selection.setInCode}×` : ''), '');
    out.push('| Check | Result | What happened | Picture |', '|---|---|---|---|');
    for (const c of sorted) {
      const e = find(r, c.id);
      out.push(`| (${c.id}) ${mdCell(c.title)} | ${LABEL[e.status]} | ${mdCell(e.reason)} | ${e.screenshot ? `[picture](${e.screenshot})` : ''} |`);
    }
    out.push('');
    // Checks made of separate steps (check p) list each step and its evidence.
    for (const c of sorted) {
      const e = find(r, c.id);
      if (!e.steps) continue;
      out.push(`#### Check (${c.id}), step by step`, '', '| Step | Result | Problems | Evidence |', '|---|---|---|---|');
      for (const s of e.steps) {
        out.push(`| (${s.step}) ${mdCell(s.title)} | ${LABEL[s.status]} | ${s.problems.map(mdCell).join('<br>')} | ${s.evidence.map(mdCell).join('<br>')} |`);
      }
      out.push('');
    }
  }
  return out.join('\n');
}

const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Read a picture and return it as a data: URI so review.html needs no other files. */
function dataUri(rel) {
  try {
    const file = path.join(OUTPUT_DIR, rel);
    const mime = rel.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  } catch (e) {
    return null;
  }
}

const SHEET_STATES = ['before', 'highlighted', 'underlined', 'note', 'after reload', 'print'];

function html(all, checks) {
  const { meta, results } = all;
  const sorted = byId(checks);
  const t = totals(results);
  const badge = (status) => `<span class="badge s-${status.replace('/', '')}">${LABEL[status]}</span>`;
  const sections = results.map((r) => {
    const thumbs = SHEET_STATES.map((state) => {
      const rel = r.sheet && r.sheet[state];
      const uri = rel ? dataUri(rel) : null;
      return `<figure>${uri
        ? `<button class="thumb" data-full="${uri}" data-caption="${esc(r.slug)}: ${esc(state)}"><img loading="lazy" src="${uri}" alt="${esc(r.slug)} ${esc(state)}"></button>`
        : '<div class="thumb none">no picture</div>'}<figcaption>${esc(state)}</figcaption></figure>`;
    }).join('');
    const rows = sorted.map((c) => {
      const e = find(r, c.id);
      const steps = (e.steps || []).map((s) => `<details${s.status === 'fail' ? ' open' : ''}><summary>${badge(s.status)} (${esc(s.step)}) ${esc(s.title)}</summary><ul class="why">${
        s.problems.map((p) => `<li><strong>Problem:</strong> ${esc(p)}</li>`).join('')}${s.evidence.map((p) => `<li>${esc(p)}</li>`).join('')}${
        s.screenshots.map((p) => `<li><a href="${esc(p)}">${esc(path.basename(p))}</a></li>`).join('')}</ul></details>`).join('');
      return `<tr><td>${badge(e.status)}</td><td class="cid">(${c.id})</td><td><strong>${esc(c.title)}</strong><div class="why">${esc(e.reason)}</div>${steps}</td>`
        + `<td>${e.screenshot ? `<a href="${esc(e.screenshot)}">picture</a>` : ''}</td></tr>`;
    }).join('');
    const stresses = Array.isArray(r.stresses) ? r.stresses.join(', ') : r.stresses || '';
    return `<section id="${esc(r.slug)}"><h2>${esc(r.slug)} <small>${esc(r.title)}</small></h2>
<p class="meta">Stresses: ${esc(stresses)}</p>
<div class="strip">${thumbs}</div>
<table class="checks"><tbody>${rows}</tbody></table></section>`;
  }).join('\n');

  const matrix = `<table class="matrix"><thead><tr><th>Site</th>${sorted.map((c) => `<th title="${esc(c.title)}">${c.id}</th>`).join('')}</tr></thead><tbody>${
    results.map((r) => `<tr><th><a href="#${esc(r.slug)}">${esc(r.slug)}</a></th>${sorted.map((c) => {
      const e = find(r, c.id);
      return `<td class="s-${e.status.replace('/', '')}" title="${esc(c.title)}: ${esc(clip(e.reason, 300))}">${LABEL[e.status]}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table>`;

  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Markup Tool visual review</title>
<style>
:root{--bg:#f6f6f3;--panel:#fff;--ink:#1c1c1a;--muted:#62625c;--line:#dcdcd4;--pass:#1d6b3a;--passbg:#dff3e4;--fail:#a4201c;--failbg:#fbe1df;--gap:#7a5200;--gapbg:#fbeecb;--skip:#55554f;--skipbg:#e9e9e3;--link:#0b57a4}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#161615;--panel:#1f1f1d;--ink:#ecece6;--muted:#a3a39a;--line:#383834;--pass:#7fd69a;--passbg:#173322;--fail:#ff9d96;--failbg:#431b19;--gap:#f0c665;--gapbg:#3d2f0e;--skip:#b5b5ab;--skipbg:#2c2c29;--link:#8ab8f0}}
:root[data-theme="dark"]{--bg:#161615;--panel:#1f1f1d;--ink:#ecece6;--muted:#a3a39a;--line:#383834;--pass:#7fd69a;--passbg:#173322;--fail:#ff9d96;--failbg:#431b19;--gap:#f0c665;--gapbg:#3d2f0e;--skip:#b5b5ab;--skipbg:#2c2c29;--link:#8ab8f0}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1280px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:19px;margin:0 0 4px}h2 small{font-weight:400;color:var(--muted);font-size:14px;margin-left:8px}
a{color:var(--link)}
.meta{color:var(--muted);margin:0 0 12px;font-size:13px}
section,.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin-top:20px}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%}
.matrix th,.matrix td{border:1px solid var(--line);padding:4px 8px;text-align:center;font-size:12px;font-variant-numeric:tabular-nums}
.matrix th:first-child{text-align:left;white-space:nowrap}
.checks td{border-top:1px solid var(--line);padding:8px 8px;vertical-align:top}
.checks .cid{color:var(--muted);white-space:nowrap}
.why{color:var(--muted);font-size:13px;overflow-wrap:anywhere}
.badge{display:inline-block;min-width:48px;text-align:center;border-radius:5px;padding:1px 6px;font-size:12px;font-weight:700}
.s-pass{background:var(--passbg);color:var(--pass)}.s-fail,.s-error{background:var(--failbg);color:var(--fail)}
.s-gap{background:var(--gapbg);color:var(--gap)}.s-skip,.s-na{background:var(--skipbg);color:var(--skip)}
.strip{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin-bottom:14px}
@media (max-width:800px){.strip{grid-template-columns:repeat(2,minmax(0,1fr))}}
figure{margin:0}figcaption{font-size:12px;color:var(--muted);text-align:center;margin-top:4px}
.thumb{display:block;width:100%;aspect-ratio:16/10;padding:0;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--bg);cursor:zoom-in}
.thumb img{width:100%;height:100%;object-fit:cover;object-position:top;display:block}
.thumb.none{display:grid;place-items:center;color:var(--muted);font-size:12px;cursor:default}
.legend{font-size:13px;color:var(--muted);margin:8px 0 0;padding-left:18px}
#lightbox{position:fixed;inset:0;background:rgba(0,0,0,.88);display:none;overflow:auto;z-index:10;cursor:zoom-out;padding:16px;text-align:center}
#lightbox.open{display:block}#lightbox img{max-width:100%;height:auto;background:#fff}
#lightbox p{color:#fff;margin:0 0 8px;font-size:14px}
</style></head><body><main>
<h1>Markup Tool visual review</h1>
<p class="meta">${esc(meta.extension)} · ${esc(meta.browser)}, ${esc(meta.mode)} · last run ${esc(meta.startedAt)} · ${t.pass} PASS, ${t.fail} FAIL, ${t.gap} GAP, ${t.skip} skip, ${t.error} ERROR</p>
<div class="card"><div class="scroll">${matrix}</div>
<ul class="legend">${LEGEND.map(([k, v]) => `<li><strong>${k}</strong>: ${esc(v)}</li>`).join('')}</ul>
<ul class="legend">${sorted.map((c) => `<li><strong>(${c.id}) ${esc(c.title)}</strong>: ${esc(c.plain)}</li>`).join('')}</ul></div>
<p class="meta" style="margin-top:16px">Click any picture to enlarge it; click again or press Esc to close. The six pictures per site show the page before any markup, after highlighting, after underlining, with a note, after a reload, and in print layout.</p>
${sections}
</main>
<div id="lightbox" role="dialog" aria-label="Enlarged picture"><p id="lb-cap"></p><img id="lb-img" alt=""></div>
<script>
// Enlarge a thumbnail on click; close on click or Esc.
(function () {
  var box = document.getElementById('lightbox'), img = document.getElementById('lb-img'), cap = document.getElementById('lb-cap');
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('.thumb[data-full]') : null;
    if (t) { img.src = t.getAttribute('data-full'); cap.textContent = t.getAttribute('data-caption'); box.classList.add('open'); return; }
    if (box.classList.contains('open')) box.classList.remove('open');
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') box.classList.remove('open'); });
})();
</script></body></html>`;
}

/**
 * Write all report files.
 * @param {object} o
 * @param {boolean} o.merge    keep earlier results for sites that were not part of this run (single-site runs)
 * @param {boolean} o.selfTest write to self-test-* files so the real baseline is not overwritten
 */
function write({ meta, results, checks, merge, selfTest }) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const prefix = selfTest ? 'self-test-' : '';
  const files = {
    json: path.join(OUTPUT_DIR, `${prefix}results.json`),
    md: path.join(OUTPUT_DIR, `${prefix}results.md`),
    html: path.join(OUTPUT_DIR, `${prefix}review.html`),
  };
  let combined = results;
  if (merge && fs.existsSync(files.json)) {
    try {
      const old = JSON.parse(fs.readFileSync(files.json, 'utf8')).results || [];
      const fresh = new Map(results.map((r) => [r.slug, r]));
      combined = old.map((r) => fresh.get(r.slug) || r);
      for (const r of results) if (!old.some((o) => o.slug === r.slug)) combined.push(r);
    } catch (e) { /* unreadable old file: just write the new results */ }
  }
  const all = {
    meta,
    checks: byId(checks).map((c) => ({ id: c.id, key: c.key, title: c.title, plain: c.plain })),
    results: combined,
  };
  fs.writeFileSync(files.json, JSON.stringify(all, null, 2));
  fs.writeFileSync(files.md, markdown(all, checks));
  fs.writeFileSync(files.html, html(all, checks));
  return { ...files, all };
}

module.exports = { write, totals, consoleTable, clip, LABEL };

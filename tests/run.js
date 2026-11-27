#!/usr/bin/env node
/**
 * tests/run.js
 * Runs every check in tests/checks.js against every site in test-sites/sites.json
 * with the extension loaded in a real Chromium, and writes the results.
 *
 *   node tests/run.js                 all sites
 *   node tests/run.js --site docs     one site (repeat --site or use commas for several)
 *   node tests/run.js --headed        watch it in a real browser window
 *   node tests/run.js --json          print the results as JSON (progress goes to stderr)
 *   node tests/run.js --self-test     run against the harness's own plain page (tests/fixtures)
 *   node tests/run.js --list          show the sites and checks, run nothing
 *   node tests/run.js --jobs 1        one site at a time (default is 3 at once)
 *
 * Output: tests/output/results.md, results.json, review.html, screenshots/, print/
 * Exit code: 0 = no failures, 1 = at least one check failed, 2 = the runner itself could not run.
 */

const fs = require('fs');
const path = require('path');
const h = require('./lib/harness');
const pdf = require('./lib/pdf');
const report = require('./lib/report');
const { startServer, DEFAULT_PORT } = require('./serve');
const { CHECKS, captureReference } = require('./checks');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const SITES_DIR = path.join(h.REPO_ROOT, 'test-sites');
// Extra facts about some test sites that the harness needs (app routes, text that changes by itself).
const SITE_EXTRAS = JSON.parse(fs.readFileSync(path.join(__dirname, 'site-extras.json'), 'utf8'));
const CHECK_TIMEOUT_MS = 240000; // a single check on a single site may never take longer than this

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { sites: [], headed: false, json: false, selfTest: false, list: false, port: DEFAULT_PORT, help: false, jobs: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--site') opts.sites.push(...String(argv[++i] || '').split(',').filter(Boolean));
    else if (a.startsWith('--site=')) opts.sites.push(...a.slice(7).split(',').filter(Boolean));
    else if (a === '--headed') opts.headed = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--self-test') opts.selfTest = true;
    else if (a === '--list') opts.list = true;
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--jobs') opts.jobs = Number(argv[++i]) || 1;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown option "${a}". Try: node tests/run.js --help`);
  }
  return opts;
}

const HELP = `Usage: node tests/run.js [--site <slug>] [--headed] [--json] [--self-test] [--list]

  (no options)     run every check on every site in test-sites/sites.json
  --site <slug>    run one site only (repeat, or separate several with commas)
  --headed         show the browser window (the PDF part of the print check needs the default headless mode)
  --json           print results as JSON on standard output
  --self-test      run against the harness's own plain page instead of test-sites/
  --list           list the sites and checks without running anything
  --jobs <n>       how many sites to run at the same time (default 3; use 1 with --headed to watch)

Results land in tests/output/ : results.md (table), review.html (pictures), results.json, screenshots/, print/`;

// ---------------------------------------------------------------------------
// Running one site
// ---------------------------------------------------------------------------

/** Run a promise with a time limit so one stuck check cannot hang the whole run. */
function withTimeout(promise, ms, what) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000}s and was stopped`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

async function runSite(site, env, log) {
  const started = Date.now();
  // The harness's own plain page is served from tests/fixtures, everything else from test-sites/.
  const baseUrl = site.fixture ? env.fixtureUrl : env.baseUrl;
  const extras = SITE_EXTRAS[site.slug] || {};
  const url = baseUrl + (site.path.startsWith('/') ? '' : '/') + site.path;
  const result = { slug: site.slug, title: site.title, url, stresses: site.stresses, ranAt: new Date().toISOString(), checks: [], sheet: {} };
  let session;
  try {
    session = await h.launch({ headed: env.headed });
  } catch (e) {
    result.checks = CHECKS.map((c) => ({ id: c.id, key: c.key, title: c.title, status: 'error', reason: `The browser could not be started: ${e.message}` }));
    return result;
  }
  const errors = [];
  const page = await session.context.newPage();
  h.captureConsole(page, errors, session.extensionId);

  // State shared by the checks for this site.
  const state = { injected: false, targets: [], marks: [], note: null, legibility: [], probes: {}, probeErrors: [], ui: {}, sampling: null };
  result.fixture = !!site.fixture;
  const ctx = {
    session, page, site, extras, url, baseUrl, fixtureUrl: env.fixtureUrl, state, errors, reference: env.reference, headed: env.headed, pdfTools: env.pdfTools,
    /** Screenshot of the window. opts.sheetState also stores a copy for the contact sheet (review.html). */
    async shot(name, opts = {}) {
      const { sheetState, ...rest } = opts;
      const rel = await h.screenshot(page, `${site.slug}/${name}`, rest);
      if (sheetState) await ctx.sheet(sheetState, rest);
      return rel;
    },
    /** Store a compact JPEG of the current page for one column of the contact sheet. */
    async sheet(stateName, opts = {}) {
      const file = path.join(h.SCREENSHOT_DIR, site.slug, `sheet-${stateName.replace(/\s+/g, '-')}.jpg`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        await page.screenshot({ path: file, type: 'jpeg', quality: 60, animations: 'disabled', timeout: 15000, ...opts });
        result.sheet[stateName] = path.relative(h.OUTPUT_DIR, file);
      } catch (e) { /* a missing thumbnail is not a test failure */ }
    },
  };

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 20000 });
  } catch (e) {
    errors.push({ where: 'page', kind: 'navigation', text: e.message.split('\n')[0], fromExtension: false });
  }

  for (const check of CHECKS) {
    const t0 = Date.now();
    let res;
    if (check.applies && !check.applies(site, extras)) {
      res = { status: 'n/a', reason: 'Does not apply to this site.' };
    } else {
      const blocked = check.needs ? check.needs(state) : null;
      if (blocked) {
        res = { status: 'skip', reason: `Not run: ${blocked}.` };
      } else {
        try {
          res = await withTimeout(check.run(ctx), check.timeoutMs || CHECK_TIMEOUT_MS, `Check (${check.id})`);
        } catch (e) {
          // An exception here is a problem in the harness (or a crashed page), not a verdict on the extension.
          res = { status: 'error', reason: `The test itself broke: ${e.message.split('\n')[0]}` };
        }
        // Every check gets a picture, even those that did not take their own.
        if (!res.screenshot) res.screenshot = await ctx.shot(`${check.id}-${check.key}`).catch(() => null);
      }
    }
    const entry = { id: check.id, key: check.key, title: check.title, plain: check.plain, ...res, durationMs: Date.now() - t0 };
    result.checks.push(entry);
    log(`  ${report.LABEL[entry.status].padEnd(5)} (${check.id}) ${check.title}: ${report.clip(entry.reason, 260)}`);
    for (const s of entry.steps || []) log(`          ${report.LABEL[s.status].padEnd(5)} (${check.id}.${s.step}) ${s.title}`);
  }

  result.marks = state.marks.map((m) => ({ type: m.type, id: m.id, colour: m.colour, note: m.note, target: m.target, text: m.text, method: m.method, methodWhy: m.methodWhy, removed: m.removed }));
  result.selection = {
    realDrag: state.marks.filter((m) => m.method === 'drag').length,
    setInCode: state.marks.filter((m) => m.method !== 'drag').length,
  };
  result.durationMs = Date.now() - started;
  await session.close();
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }
  // With --json, standard output carries only the JSON; progress goes to standard error.
  const log = (line = '') => (opts.json ? process.stderr.write(line + '\n') : console.log(line));

  const root = opts.selfTest ? FIXTURES_DIR : SITES_DIR;
  const sitesFile = path.join(root, 'sites.json');
  if (!fs.existsSync(sitesFile)) {
    throw new Error(`Cannot find the list of test sites: ${sitesFile}\nThe test sites have not been created yet. To check the harness itself, run: node tests/run.js --self-test`);
  }
  let sites = JSON.parse(fs.readFileSync(sitesFile, 'utf8'));
  // The harness's own plain page runs as one more row: a control, and the home of the migration and keyboard checks.
  if (!opts.selfTest) sites = [...JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'sites.json'), 'utf8')), ...sites];
  if (opts.sites.length) {
    const unknown = opts.sites.filter((s) => !sites.some((x) => x.slug === s));
    if (unknown.length) throw new Error(`No such site: ${unknown.join(', ')}. Available: ${sites.map((s) => s.slug).join(', ')}`);
    sites = sites.filter((s) => opts.sites.includes(s.slug));
  }
  if (opts.list) {
    console.log('Sites:');
    for (const s of sites) console.log(`  ${s.slug.padEnd(18)} ${s.title}`);
    console.log('\nChecks:');
    for (const c of CHECKS.slice().sort((a, b) => a.id.localeCompare(b.id))) console.log(`  (${c.id}) ${c.title}: ${c.plain}`);
    return 0;
  }

  const started = Date.now();
  // Web servers: one for the test sites, one for the harness's own plain reference page.
  let server;
  try {
    server = await startServer({ root, port: opts.port });
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    server = await startServer({ root, port: 0 }); // the usual port is busy: any free port will do
  }
  const fixtureServer = opts.selfTest ? server : await startServer({ root: FIXTURES_DIR, port: 0 });

  const manifest = JSON.parse(fs.readFileSync(path.join(h.EXTENSION_DIR, 'manifest.json'), 'utf8'));
  const env = { baseUrl: server.url, fixtureUrl: fixtureServer.url, headed: opts.headed, pdfTools: pdf.available(), reference: null };

  log(`Web Page Markup Tool ${manifest.version}: browser checks`);
  log(`Sites served from ${root} at ${server.url}`);

  // Reference look of the toolbar and note on a plain page (used by check m).
  let meta;
  try {
    const refSession = await h.launch({ headed: opts.headed });
    env.reference = await captureReference(refSession, fixtureServer.url);
    meta = {
      extension: `${manifest.name} ${manifest.version}`,
      browser: `Chromium ${refSession.launchInfo.browserVersion}`,
      mode: refSession.mode,
      launch: refSession.launchInfo,
      extensionId: refSession.extensionId,
      extensionIdHow: refSession.extensionIdHow,
      viewport: refSession.viewport,
      pdfInspection: env.pdfTools ? 'poppler (pdftotext, pdftoppm)' : 'not available (poppler not installed)',
      referenceStyles: env.reference ? `captured from tests/fixtures (${Object.keys(env.reference).join(' and ')} theme)` : 'NOT captured',
    };
    await refSession.close();
  } catch (e) {
    await server.close();
    if (fixtureServer !== server) await fixtureServer.close();
    throw e;
  }
  log(`Browser: ${meta.browser}, ${meta.mode}; extension id ${meta.extensionId}`);
  log('');

  // A full run starts from an empty output folder; a single-site run only replaces that site's files.
  const full = !opts.sites.length && !opts.selfTest;
  if (full) {
    fs.rmSync(h.SCREENSHOT_DIR, { recursive: true, force: true });
    fs.rmSync(h.PRINT_DIR, { recursive: true, force: true });
  } else {
    for (const s of sites) fs.rmSync(path.join(h.SCREENSHOT_DIR, s.slug), { recursive: true, force: true });
  }

  // Sites run a few at a time, each in its own browser. A site's lines are printed together when it finishes.
  const results = new Array(sites.length);
  const jobs = Math.max(1, Math.min(opts.jobs, sites.length));
  if (sites.length > 1) log(`Running ${sites.length} sites, ${jobs} at a time. Each site reports when it finishes (roughly 30-60 seconds each).\n`);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < sites.length) {
      const i = next++;
      const site = sites[i];
      const lines = [];
      const r = await runSite(site, env, (line) => lines.push(line));
      results[i] = r;
      done++;
      log(`[${done}/${sites.length}] ${site.slug}: ${site.title}`);
      for (const line of lines) log(line);
      log(`  (${(r.durationMs / 1000).toFixed(1)}s; selections made by real mouse drag: ${r.selection ? r.selection.realDrag : 0}, set in code: ${r.selection ? r.selection.setInCode : 0})`);
      log('');
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  await server.close();
  if (fixtureServer !== server) await fixtureServer.close();

  meta.startedAt = new Date(started).toISOString();
  meta.durationSeconds = Math.round((Date.now() - started) / 1000);
  meta.command = `node tests/run.js ${process.argv.slice(2).join(' ')}`.trim();
  meta.selfTest = opts.selfTest;

  const files = report.write({ meta, results, checks: CHECKS, merge: !full && !opts.selfTest, selfTest: opts.selfTest });

  log(report.consoleTable(files.all.results, CHECKS));
  log('');
  const totals = report.totals(results);
  log(`This run: ${totals.pass} passed, ${totals.fail} failed, ${totals.gap} known gaps, ${totals.skip} not run, ${totals.error} harness errors. Took ${meta.durationSeconds}s.`);
  log('Open these to see the detail:');
  log(`  Table and reasons : ${files.md}`);
  log(`  Pictures          : file://${files.html}`);
  log(`  Raw data          : ${files.json}`);
  log(`  Screenshots       : ${h.SCREENSHOT_DIR}/<site>/`);
  log(`  Print output      : ${h.PRINT_DIR}/`);
  if (opts.json) process.stdout.write(JSON.stringify(files.all, null, 2) + '\n');
  return totals.fail || totals.error ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(`\nThe test runner could not run:\n${e.message}`);
  process.exit(2);
});

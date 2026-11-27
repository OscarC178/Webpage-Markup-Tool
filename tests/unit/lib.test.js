/**
 * Unit tests for the pure library code (no browser needed).
 * Run with:  node --test tests/unit/
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const url = require('../../lib/url.js');
const migrate = require('../../lib/migrate.js');
const anchor = require('../../lib/anchor.js');
const palette = require('../../lib/palette.js');

// ------------------------------------------------------------------ url.js

test('url: drops ordinary #fragments', () => {
  assert.equal(url.normaliseUrl('https://a.test/docs/page.html#install'), 'https://a.test/docs/page.html');
});

test('url: keeps hash-router fragments', () => {
  assert.equal(url.normaliseUrl('https://a.test/app#/inbox/3'), 'https://a.test/app#/inbox/3');
  assert.equal(url.normaliseUrl('https://a.test/app#!/inbox'), 'https://a.test/app#!/inbox');
});

test('url: drops tracking parameters, keeps real ones in order', () => {
  assert.equal(
    url.normaliseUrl('https://a.test/p?view=about&utm_source=x&id=7&fbclid=abc'),
    'https://a.test/p?view=about&id=7'
  );
  assert.equal(url.normaliseUrl('https://a.test/p?utm_campaign=x'), 'https://a.test/p');
});

test('url: leaves trailing slashes and unparseable input alone', () => {
  assert.equal(url.normaliseUrl('https://a.test/dir/'), 'https://a.test/dir/');
  assert.equal(url.normaliseUrl('not a url'), 'not a url');
});

test('url: pageKey, supported and pdf detection', () => {
  assert.equal(url.pageKey('https://a.test/x#y'), 'page:https://a.test/x');
  assert.equal(url.isSupportedUrl('chrome://extensions'), false);
  assert.equal(url.isSupportedUrl('http://127.0.0.1:4173/'), true);
  assert.equal(url.looksLikePdf('https://a.test/files/Report.PDF?dl=1'), true);
  assert.equal(url.looksLikePdf('https://a.test/pdf-guide.html'), false);
});

// -------------------------------------------------------------- migrate.js

const V1 = {
  'https://a.test/article': {
    markups: [
      { id: 'markup-1', type: 'highlight', text: 'hello world', color: '#FFF888',
        position: { startContainerPath: '/html/body/p[1]/text()[1]', startOffset: 0, endContainerPath: '/html/body/p[1]/text()[1]', endOffset: 11 } },
      { id: 'note-1', type: 'note', text: 'my note', position: { top: 320, left: 20 },
        selection: { startContainerPath: '/html/body/p[2]/text()[1]', startOffset: 2, endContainerPath: '/html/body/p[2]/text()[1]', endOffset: 9 } },
    ],
  },
  'https://a.test/article#section-2': {
    markups: [{ id: 'markup-2', type: 'underline', text: 'second', position: {}, color: 'javascript:bad' }],
  },
  highlightColorCache: 'unrelated key that must be ignored',
};

test('migrate: converts and merges version 1 pages', () => {
  const plan = migrate.planMigration(V1, 1000);
  const page = plan.set['page:https://a.test/article'];
  assert.equal(plan.migratedPages, 1, 'the #fragment key merges into the same page');
  assert.equal(plan.migratedMarkups, 3);
  assert.deepEqual(page.markups.map((m) => m.id), ['markup-1', 'note-1', 'markup-2']);

  const hl = page.markups[0];
  assert.equal(hl.kind, 'highlight');
  assert.equal(hl.colour, 'yellow');
  assert.equal(hl.anchor.quote.exact, 'hello world');
  assert.equal(hl.anchor.xpath.endOffset, 11);

  const note = page.markups[1];
  assert.equal(note.kind, 'highlight', 'an old sticky note becomes a highlight carrying the note text');
  assert.equal(note.colour, 'yellow');
  assert.equal(note.note, 'my note');
  assert.equal(note.anchor.quote, null);
  assert.equal(note.anchor.xpath.startOffset, 2);

  assert.equal(page.markups[2].colour, 'pink', 'an invalid stored colour falls back to the old default (red -> pink)');
  assert.equal(plan.set.meta.schemaVersion, 2);
});

test('migrate: never asks for old keys to be removed, and is safe to run twice', () => {
  const plan1 = migrate.planMigration(V1, 1000);
  assert.ok(!('https://a.test/article' in plan1.set));
  const after = { ...V1, ...plan1.set };
  assert.equal(migrate.needsMigration(after), false);
  const plan2 = migrate.planMigration(after, 2000);
  assert.equal(plan2.migratedMarkups, 0);
  assert.equal(plan2.set['page:https://a.test/article'].markups.length, 3);
});

test('migrate: tolerates empty and malformed data', () => {
  assert.equal(migrate.needsMigration({}), true);
  const plan = migrate.planMigration({ 'https://b.test/': { markups: [null, {}, { id: 'x' }] }, 'https://c.test/': 'junk' }, 5);
  assert.equal(plan.migratedMarkups, 0);
  assert.equal(plan.set.meta.schemaVersion, 2);
});

// --------------------------------------------------------------- anchor.js

const TEXT = 'The cat sat on the mat. Later the cat sat on the sofa. The dog watched the cat sat on nothing.';

test('anchor: position hit when the words are unchanged', () => {
  const a = anchor.describeSpan(TEXT, 4, 11); // first "cat sat"
  assert.equal(a.quote.exact, 'cat sat');
  assert.deepEqual(anchor.locate(TEXT, a), { start: 4, end: 11, method: 'position' });
});

test('anchor: picks the right repeat using surrounding words after the page shifts', () => {
  const second = TEXT.indexOf('cat sat', 12);
  const a = anchor.describeSpan(TEXT, second, second + 7);
  const shifted = 'COOKIE BANNER TEXT INSERTED ABOVE. ' + TEXT;
  const hit = anchor.locate(shifted, a);
  assert.equal(hit.method, 'quote');
  assert.equal(hit.start, second + 35);
  assert.equal(shifted.slice(hit.start, hit.end), 'cat sat');
});

test('anchor: tolerates whitespace changes', () => {
  const a = { quote: { exact: 'sat on the\n   mat', prefix: '', suffix: '' }, pos: null };
  const hit = anchor.locate(TEXT, a);
  assert.equal(hit.method, 'fuzzy');
  assert.equal(TEXT.slice(hit.start, hit.end), 'sat on the mat');
});

test('anchor: returns null (orphan) when the words are gone', () => {
  const a = { quote: { exact: 'a sentence that was deleted', prefix: '', suffix: '' }, pos: { start: 4, end: 31 } };
  assert.equal(anchor.locate(TEXT, a), null);
  assert.equal(anchor.locate(TEXT, null), null);
  assert.equal(anchor.locate(TEXT, { quote: null, pos: null }), null);
});

// -------------------------------------------------------------- palette.js

test('palette: old free-choice colours map to the nearest of the five', () => {
  assert.equal(palette.nearestColour('#fff888'), 'yellow');
  assert.equal(palette.nearestColour('#ff5555'), 'pink');
  assert.equal(palette.nearestColour('#33cc55'), 'green');
  assert.equal(palette.nearestColour('#3366ff'), 'blue');
  assert.equal(palette.nearestColour('#808080'), 'yellow', 'greys use the default');
  assert.equal(palette.nearestColour('red; background:url(x)'), 'yellow', 'junk uses the default');
});

test('palette: forced text colours are readable on every fill (WCAG 4.5:1)', () => {
  const dark = palette.hexLuminance(palette.MARK_TEXT_DARK);
  const light = palette.hexLuminance(palette.MARK_TEXT_LIGHT);
  for (const name of palette.NAMES) {
    const c = palette.COLOURS[name];
    assert.ok(palette.contrast(dark, palette.hexLuminance(c.light)) >= 4.5, name + ' light fill');
    assert.ok(palette.contrast(light, palette.hexLuminance(c.dark)) >= 4.5, name + ' dark fill');
  }
});

test('palette: parses computed CSS colours', () => {
  assert.deepEqual(palette.parseCssColour('rgba(10, 20, 30, 0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(palette.parseCssColour('rgb(1 2 3 / 40%)'), { r: 1, g: 2, b: 3, a: 0.4 });
  assert.equal(palette.parseCssColour('transparent'), null);
});

/**
 * Unit tests for lib/review.js (when the popup asks for a review).
 * Run with:  node --test tests/unit/
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const review = require('../../lib/review.js');
const url = require('../../lib/url.js');

test('review: asks on open 2, 5 and every 5th open after that while pending', () => {
  const asked = [];
  for (let n = 1; n <= 30; n++) if (review.shouldAsk(n, 'pending')) asked.push(n);
  assert.deepEqual(asked, [2, 5, 10, 15, 20, 25, 30]);
});

test('review: never asks once done or "never"', () => {
  for (const n of [2, 5, 10, 15, 100]) {
    assert.equal(review.shouldAsk(n, 'done'), false);
    assert.equal(review.shouldAsk(n, 'never'), false);
  }
});

test('review: a missing or unknown status counts as pending', () => {
  assert.equal(review.shouldAsk(2, undefined), true);
  assert.equal(review.shouldAsk(5, 'junk'), true);
  assert.equal(review.normaliseStatus(undefined), 'pending');
  assert.equal(review.normaliseStatus('done'), 'done');
});

test('review: rubbish open counts never ask', () => {
  for (const n of [0, -5, 2.5, NaN, '2', null, undefined]) assert.equal(review.shouldAsk(n, 'pending'), false);
  assert.equal(review.normaliseOpens('7'), 0);
  assert.equal(review.normaliseOpens(-1), 0);
  assert.equal(review.normaliseOpens(7), 7);
});

test('review: storage keys are not page keys and not version 1 keys', () => {
  for (const key of [review.OPENS_KEY, review.STATUS_KEY]) {
    assert.ok(!key.startsWith(url.PAGE_PREFIX));
    assert.ok(!/^https?:\/\//i.test(key), 'the migration only reads keys that start with http(s)://');
  }
});

test('review: every star goes to the store review page', () => {
  assert.equal(review.REVIEW_URL, 'https://chromewebstore.google.com/detail/lpoedmhdgkmngpgiodimgefgcglgcbpk/reviews');
});

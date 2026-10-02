import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeReviews, scoreSentence } from '../src/shared/poolHeat.js';

const r = (text) => ({ text, rating: 4, date: '1 month ago' });

test('detects heated pool', () => {
  assert.ok(scoreSentence('The pool was heated and lovely.').pool > 0);
  assert.ok(scoreSentence('Pool water was nice and warm').pool > 0);
});

test('handles negation and unheated', () => {
  assert.ok(scoreSentence('The pool is not heated.').pool < 0);
  assert.ok(scoreSentence("Pool wasn't heated at all").pool < 0);
  assert.ok(scoreSentence('Unheated outdoor pool.').pool < 0);
  assert.ok(scoreSentence('The pool was not cold at all').pool > 0);
  assert.ok(scoreSentence('Wish the pool was heated, it was chilly.').pool < 0);
  assert.ok(scoreSentence('Would be nice if the pool were heated').pool < 0);
});

test('reads temperatures', () => {
  assert.ok(scoreSentence('Pool was 84 degrees').pool > 0);
  assert.ok(scoreSentence('The pool was about 68°F').pool < 0);
  assert.ok(scoreSentence('Pool kept at 29°C').pool > 0);
  assert.ok(scoreSentence('Hot tub was only 92 degrees').hotTub < 0);
  assert.ok(scoreSentence('Hot tub was 102°F, perfect').hotTub > 0);
});

test('attributes cues to the nearest facility', () => {
  const s = scoreSentence('The pool was freezing but the hot tub was nice and hot.');
  assert.ok(s.pool < 0, `pool ${s.pool}`);
  assert.ok(s.hotTub > 0, `hotTub ${s.hotTub}`);
});

test('ignores non-swimming pools and unrelated sentences', () => {
  assert.deepEqual(scoreSentence('Room was cold and the AC was loud.'), {});
  assert.equal(scoreSentence('There was a pool table in the lobby and it was cold.').pool, undefined);
});

test('lukewarm hot tub counts as cold', () => {
  assert.ok(scoreSentence('Jacuzzi was lukewarm at best.').hotTub < 0);
});

test('aggregates into verdicts', () => {
  const res = analyzeReviews([
    r('Great stay. The pool was heated.'),
    r('Kids loved the warm pool!'),
    r('Pool was nice and warm.'),
    r('Pool was a bit cold in the morning.'),
    r('The hot tub was cold.'),
    r('Hot tub was lukewarm.'),
    r('Friendly staff.'),
  ]);
  assert.equal(res.pool.status, 'warm');
  assert.equal(res.pool.warm, 3);
  assert.equal(res.pool.cold, 1);
  assert.equal(res.hotTub.status, 'cold');
  assert.equal(res.reviewsAnalyzed, 7);
  assert.ok(res.pool.evidence.length > 0);
});

test('unknown when nobody mentions temperature', () => {
  const res = analyzeReviews([r('Pool area was clean.'), r('Nice rooms.')]);
  assert.equal(res.pool.status, 'unknown');
  assert.equal(res.pool.mentions, 1);
  assert.equal(res.hotTub.label, 'Not mentioned in reviews');
});

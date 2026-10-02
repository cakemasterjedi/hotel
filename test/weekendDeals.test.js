import test from 'node:test';
import assert from 'node:assert/strict';
import { upcomingWeekends, emptyHistory, findDeals, formatDeals } from '../src/weekendDeals.js';

const hotel = (key, nightly, features = {}) => ({ key, name: key, best: { nightly, total: nightly * 2, source: 'Super.com', taxIncluded: true }, features });
const plus2 = (d) => new Date(Date.parse(d) + 2 * 86_400_000).toISOString().slice(0, 10);
const scan = (checkIn, hotels) => ({ checkIn, checkOut: plus2(checkIn), hotels });
const now = Date.parse('2026-10-02T12:00:00Z');

test('upcoming weekends start the next Friday', () => {
  assert.deepEqual(upcomingWeekends('2026-10-02', 2), [{ checkIn: '2026-10-09', checkOut: '2026-10-11' }, { checkIn: '2026-10-16', checkOut: '2026-10-18' }]);
  assert.equal(upcomingWeekends('2026-10-05', 1)[0].checkIn, '2026-10-09'); // Monday → this Friday
});

test('flags a weekend well below the hotel\'s usual weekend price', () => {
  const h = emptyHistory();
  const deals = findDeals([
    scan('2026-10-09', [hotel('a', 100), hotel('b', 80, { pool: true })]),
    scan('2026-10-16', [hotel('a', 102), hotel('b', 82, { pool: true })]),
    scan('2026-10-23', [hotel('a', 98), hotel('b', 60, { pool: true })]),
    scan('2026-10-30', [hotel('a', 80), hotel('b', 81, { pool: true })]),
  ], h, { now });
  assert.deepEqual(deals.map((d) => [d.key, d.checkIn]), [['b', '2026-10-23'], ['a', '2026-10-30']]); // pool hotel listed first
  assert.ok(deals[0].below >= 0.15);
  assert.match(formatDeals(deals, { origin: 'Maple Heights, OH' }), /2 weekend hotel deals near Maple Heights, OH/); assert.match(formatDeals(deals, { origin: 'M' }), /Oct 23–Oct 25/);
});

test('needs enough prices to judge, and does not repeat a reported deal', () => {
  const h = emptyHistory();
  assert.equal(findDeals([scan('2026-10-09', [hotel('a', 50)])], h, { now }).length, 0);
  const scans = [scan('2026-10-09', [hotel('a', 100)]), scan('2026-10-16', [hotel('a', 100)]), scan('2026-10-23', [hotel('a', 100)]), scan('2026-10-30', [hotel('a', 70)])];
  assert.equal(findDeals(scans, h, { now }).length, 1);
  assert.equal(findDeals(scans, h, { now: now + 86_400_000 }).length, 0, 'same deal next day is not repeated');
  scans[3].hotels[0].best.nightly = 60;
  assert.equal(findDeals(scans, h, { now: now + 2 * 86_400_000 }).length, 1, 'a further drop is reported');
});

test('reports a new low for the cheapest pool / hot tub hotel', () => {
  const h = emptyHistory();
  findDeals([scan('2026-10-09', [hotel('p', 120, { hotTub: true })])], h, { now });
  const deals = findDeals([scan('2026-10-09', [hotel('p', 100, { hotTub: true })])], h, { now: now + 86_400_000 });
  assert.equal(deals.length, 1);
  assert.equal(deals[0].reason, 'new-low');
  assert.match(formatDeals(deals, { origin: 'X' }), /new low/);
});

test('says so when there are no deals', () => {
  assert.equal(formatDeals([], { origin: 'Maple Heights, OH' }), 'No new weekend hotel deals near Maple Heights, OH right now.');
});

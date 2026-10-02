import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastPrice } from '../src/shared/forecast.js';

const DAY = 86_400_000;
const now = Date.parse('2026-10-02T12:00:00Z');

test('prior forecast rises toward check-in and brackets current price', () => {
  const fc = forecastPrice({ nightly: 200, checkIn: '2026-10-10', nights: 2, now });
  assert.equal(fc.leadDays, 8);
  assert.ok(fc.week.expected > 200);
  assert.ok(fc.week.high > fc.week.expected);
  assert.ok(fc.tomorrow.high > 200);
  assert.equal(fc.week.highTotal, Math.round(fc.week.high * 2 * 100) / 100);
  assert.equal(fc.confidence, 'low');
});

test('horizon is capped at check-in', () => {
  const fc = forecastPrice({ nightly: 100, checkIn: '2026-10-05', nights: 1, now });
  assert.equal(fc.week.days, 3);
});

test('falling history pulls the forecast down', () => {
  const history = Array.from({ length: 10 }, (_, i) => ({ nightly: 300 - i * 6, observedAt: now - (9 - i) * DAY }));
  const fc = forecastPrice({ nightly: 246, checkIn: '2026-12-01', nights: 3, history, now });
  assert.ok(fc.week.expected < 246, `expected ${fc.week.expected}`);
  assert.match(fc.advice, /wait/i);
  assert.equal(fc.confidence, 'medium');
});

test('returns null without a price', () => {
  assert.equal(forecastPrice({ nightly: null, checkIn: '2026-10-10', nights: 1, now }), null);
});

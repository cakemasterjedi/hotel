import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { searchSuper, searchBooking, searchTripadvisor, tripadvisorDetails, tripadvisorVersion } from '../src/shared/sources.js';
import { merge, sameHotel, hotelKey } from '../src/shared/merge.js';
import { detectFeatures } from '../src/shared/features.js';
import { haversineKm } from '../src/shared/geo.js';

// Real responses captured from the Super.com, Booking.com and Tripadvisor MCP servers.
const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/live-responses.json', import.meta.url)));
const stay = { q: 'Scottsdale, AZ', checkIn: '2026-10-20', checkOut: '2026-10-21', adults: 2, children: 0 };
const stub = (payload) => async () => payload;

test('parses Super.com city results (per-night prices incl. tax)', async () => {
  const list = await searchSuper(stub(fx.super), stay);
  assert.equal(list.length, 4);
  const hgi = list.find((l) => /Hilton Garden Inn/.test(l.name));
  assert.equal(hgi.offers[0].source, 'Super.com');
  assert.equal(hgi.offers[0].taxIncluded, true);
  assert.ok(hgi.offers[0].nightly > 50);
});

test('retries Super.com with a bare city name when "City, ST" finds nothing', async () => {
  const seen = [];
  const call = async (tool, args) => { seen.push(args.city_name); return args.city_name === 'Scottsdale' ? fx.super : { hotels: [] }; };
  const list = await searchSuper(call, stay);
  assert.deepEqual(seen, ['Scottsdale, AZ', 'Scottsdale']);
  assert.equal(list.length, 4);
});

test('parses Booking.com results and de-duplicates price bands', async () => {
  const list = await searchBooking(stub(fx.booking), stay);
  assert.equal(list.length, fx.booking.accommodations.length);
  const a = list[0];
  assert.ok(a.lat && a.lng);
  assert.ok(a.rating <= 5);
  assert.ok(a.refs.bookingId);
  assert.ok(a.offers[0].total > 0);
});

test('parses Tripadvisor search incl. partner names and search centre', async () => {
  const { listings, center } = await searchTripadvisor(stub(fx.tripadvisor), stay, {});
  assert.equal(listings.length, 3);
  assert.ok(center.lat && center.lng);
  const o = listings[0].offers[0];
  assert.equal(o.via, 'Tripadvisor');
  assert.equal(o.taxIncluded, false);
  assert.notEqual(o.source, 'Tripadvisor partner');
  assert.match(o.link, /^https:\/\/www\.tripadvisor\.com\//);
});

test('parses Tripadvisor details: several sites, reviews, amenities', async () => {
  const d = await tripadvisorDetails(stub(fx.tripadvisorDetails), { ...stay, checkOut: '2026-10-23' }, { hotelId: 1 });
  assert.ok(d.offers.length >= 2);
  assert.ok(d.offers.every((o) => o.nightly > 0 && o.total >= o.nightly));
  assert.equal(d.reviews.length, 10);
  assert.ok(d.amenities.includes('Pool'));
});

test('merges the same hotel from three sites into one card', async () => {
  const listings = [
    ...await searchSuper(stub(fx.super), stay),
    ...await searchBooking(stub(fx.booking), stay),
    ...(await searchTripadvisor(stub(fx.tripadvisor), stay, {})).listings,
  ];
  const hotels = merge(listings, 1);
  const hgi = hotels.filter((h) => /Hilton Garden Inn/i.test(h.name));
  assert.equal(hgi.length, 1, 'one merged Hilton Garden Inn');
  assert.deepEqual(new Set(hgi[0].sources), new Set(['Super.com', 'Booking.com', 'Tripadvisor']));
  assert.ok(hgi[0].lat, 'coordinates come from Booking/Tripadvisor');
  assert.equal(hgi[0].best.nightly, Math.min(...hgi[0].offers.map((o) => o.nightly)));
  // Distinct hotels stay separate.
  assert.ok(hotels.some((h) => /Valley Ho/.test(h.name)));
  assert.ok(hotels.some((h) => /Talking Stick/.test(h.name)));
  assert.ok(!hotels.some((h) => /Home2/.test(h.name) && /Garden/.test(h.name)));
});

test('does not merge different hotels that share brand words', () => {
  assert.equal(sameHotel({ name: 'Hilton Garden Inn Scottsdale Old Town' }, { name: 'Hilton Scottsdale Resort & Villas' }), false);
  assert.equal(sameHotel({ name: 'Hampton Inn Scottsdale', lat: 33.5, lng: -111.9 }, { name: 'Hampton Inn Scottsdale', lat: 33.7, lng: -111.9 }), false);
  assert.equal(sameHotel({ name: 'La Quinta Inn & Suites by Wyndham Phoenix Scottsdale' }, { name: 'La Quinta Inn & Suites Phoenix Scottsdale' }), true);
  assert.equal(hotelKey('The Hotel Valley Ho'), hotelKey('Hotel Valley Ho'));
});

test('detects pool / hot tub from amenity lists without false positives', () => {
  const f = detectFeatures(['Billiards or pool table', 'Number of accessible parking spaces - 6', 'Pool umbrellas', 'Access to nearby outdoor pool']);
  assert.equal(f.pool, false);
  assert.equal(f.hotTub, false);
  const g = detectFeatures(['Outdoor pool (year-round)', 'Hot tub/Jacuzzi', 'Heated pool']);
  assert.deepEqual([g.pool, g.outdoorPool, g.hotTub, g.heatedPoolListed], [true, true, true, true]);
  assert.equal(detectFeatures(['Whirlpool bathtub in room']).hotTub, false);
});

test('reads the Tripadvisor version constant from its schema', () => {
  assert.equal(tripadvisorVersion({ properties: { mcpServerVersion: { properties: { version: { const: 'V9' } } } } }), 'V9');
  assert.equal(tripadvisorVersion(undefined), 'V2026_0327');
});

test('haversine distance is sane', () => {
  const km = haversineKm({ lat: 33.4152, lng: -111.8315 }, { lat: 33.4942, lng: -111.9261 }); // Mesa → Scottsdale
  assert.ok(km > 10 && km < 15, String(km));
});

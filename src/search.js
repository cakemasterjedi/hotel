// Runs every enabled source in parallel and merges the results.
import { config } from './config.js';
import { caller, listTools } from './mcpClient.js';
import { demoCaller } from './providers/demo.js';
import * as google from './providers/serpapi.js';
import { geocode } from './geocode.js';
import { merge, addOffers, nightsBetween } from './shared/merge.js';
import { nearbyAreas, withinRadius } from './shared/near.js';
import {
  SOURCE_INFO, searchSuper, searchBooking, searchTripadvisor, tripadvisorDetails, tripadvisorVersion,
  superLowest, bookingAnswer, HEAT_QUESTION,
} from './shared/sources.js';

const enabled = (id) => config.sources.includes(id) && (id !== 'google' || (config.serpApiKey && !config.demo));

function callFor(id, timeoutMs = 60_000) {
  return config.demo ? demoCaller(id) : caller(SOURCE_INFO[id].url, { timeoutMs, retries: 1 });
}

let taVersion = null;
async function tripadvisorVersionLive() {
  if (config.demo) return undefined;
  if (taVersion) return taVersion;
  try {
    const tools = await listTools(SOURCE_INFO.tripadvisor.url);
    taVersion = tripadvisorVersion(tools.get('search_hotels')?.inputSchema);
  } catch { /* use fallback */ }
  return taVersion || undefined;
}

export function activeSources() {
  return [
    ...['super', 'booking', 'tripadvisor'].filter(enabled).map((id) => SOURCE_INFO[id].label),
    ...(enabled('google') ? ['Google Hotels'] : []),
  ];
}

export function searchAll(stay) {
  return searchArea(stay, { areas: [stay.q] });
}

// Searches one or more place names (e.g. a suburb plus the nearby city) and,
// when `near` is given, Booking.com by radius around that point instead.
export async function searchArea(stay, { areas, near = null, bookingListings = null }) {
  const nights = nightsBetween(stay.checkIn, stay.checkOut);
  const jobs = [];
  for (const q of areas) {
    const s = { ...stay, q };
    if (enabled('super')) jobs.push(['super', searchSuper(callFor('super', 90_000), s)]);
    if (enabled('tripadvisor')) {
      jobs.push(['tripadvisor', tripadvisorVersionLive().then((version) => searchTripadvisor(callFor('tripadvisor', 45_000), s, { version }))]);
    }
    if (enabled('google')) jobs.push(['google', google.searchGoogle(s)]);
  }
  if (bookingListings) jobs.push(['booking', Promise.resolve(bookingListings)]);
  else if (enabled('booking')) jobs.push(['booking', searchBooking(callFor('booking'), near ? { ...stay, near } : { ...stay, q: areas[0] })]);

  const settled = await Promise.allSettled(jobs.map(([, p]) => p));
  const listings = [];
  const byId = {};
  let center = null;
  settled.forEach((r, i) => {
    const id = jobs[i][0];
    const entry = (byId[id] ||= { id, label: SOURCE_INFO[id]?.label || 'Google Hotels', ok: false, count: 0, errors: [] });
    if (r.status === 'rejected') { entry.errors.push(String(r.reason?.message || r.reason).slice(0, 200)); return; }
    const value = id === 'tripadvisor' ? r.value.listings : r.value;
    if (id === 'tripadvisor' && !center) center = r.value.center;
    listings.push(...value);
    entry.ok = true;
    entry.count += value.length;
  });
  const status = Object.values(byId).map(({ errors, ...e }) => (e.ok ? e : { ...e, error: errors[0] }));
  if (!listings.length && status.every((s) => !s.ok)) {
    throw Object.assign(new Error(`No site answered: ${status.map((s) => `${s.label}: ${s.error}`).join('; ')}`), { status: 502 });
  }
  if (!center && !config.demo) center = await geocode(areas[0]);
  // The same hotel can come back from several area searches on one site.
  const seen = new Set();
  const unique = listings.filter((l) => {
    const k = `${l.source}|${l.name}`;
    return !seen.has(k) && seen.add(k);
  });
  const hotels = merge(unique, nights).filter((h) => h.best);
  return { hotels, status, center };
}

// Hotels within `radiusKm` of a point (e.g. the user's location). Booking.com
// is searched by radius; the towns its hotels are in are then searched on the
// other sites, which only accept place names.
export async function searchNear(stay, { point, radiusKm, label }) {
  const near = { lat: point.lat, lng: point.lng, radiusKm };
  let bookingListings = [];
  if (enabled('booking')) {
    try { bookingListings = await searchBooking(callFor('booking'), { ...stay, near }); } catch { bookingListings = null; }
  }
  const areas = nearbyAreas(bookingListings || [], { base: label, point, radiusKm });
  const result = await searchArea({ ...stay, q: areas[0] }, { areas, near, bookingListings });
  return { ...result, hotels: withinRadius(result.hotels, point, radiusKm), center: { lat: point.lat, lng: point.lng, name: label }, areas };
}

// Tripadvisor details (prices, reviews, photos) are shared by several
// buttons, so keep each answer for a few hours in memory.
const taCache = new Map();
function taDetails(stay, hotel) {
  const name = [hotel.name, hotel.city].filter(Boolean).join(', ');
  const key = `${hotel.refs?.tripadvisorId || name}|${stay.checkIn}|${stay.checkOut}|${stay.adults}`;
  const hit = taCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.promise;
  const promise = tripadvisorVersionLive()
    .then((version) => tripadvisorDetails(callFor('tripadvisor', 45_000), stay, { hotelId: hotel.refs?.tripadvisorId, hotelName: name, version }));
  taCache.set(key, { at: Date.now(), promise });
  promise.catch(() => taCache.delete(key));
  if (taCache.size > 500) taCache.delete(taCache.keys().next().value);
  return promise;
}

// Photos for one hotel: Tripadvisor's gallery and guest photos, plus any listing photo.
export async function hotelPhotos(stay, hotel) {
  const photos = [];
  if (enabled('tripadvisor')) {
    try { photos.push(...(await taDetails(stay, hotel)).photos); } catch { /* fall back to listing photo */ }
  }
  // Hotel gallery first, then the booking sites' listing photos, then guest photos.
  const listing = (hotel.images || []).filter((url) => url && !photos.some((p) => p.full === url || p.thumb === url))
    .map((url) => ({ thumb: url, full: url, caption: null, kind: 'hotel' }));
  return [...photos.filter((p) => p.kind !== 'guest'), ...listing, ...photos.filter((p) => p.kind === 'guest')];
}

// Every site's price for one hotel ("Compare all sites").
export async function hotelPrices(stay, hotel) {
  const jobs = [];
  const name = [hotel.name, hotel.city].filter(Boolean).join(', ');
  if (enabled('tripadvisor')) {
    jobs.push(taDetails(stay, hotel).then((d) => d.offers));
  }
  if (enabled('super')) jobs.push(superLowest(callFor('super', 60_000), stay, hotel.refs?.superName || hotel.name).then((o) => [o]));
  if (enabled('google') && hotel.refs?.serpToken) jobs.push(google.googleOffers(stay, hotel.refs.serpToken));
  const settled = await Promise.allSettled(jobs);
  const offers = settled.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value).filter(Boolean);
  const errors = settled.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message || r.reason));
  return { hotel: addOffers({ ...hotel }, offers), errors };
}

// Reviews and answers used for the heated-pool check.
export async function hotelHeatSources(stay, hotel) {
  const name = [hotel.name, hotel.city].filter(Boolean).join(', ');
  const jobs = {};
  if (enabled('tripadvisor')) {
    jobs.tripadvisor = taDetails(stay, hotel);
  }
  if (enabled('booking') && hotel.refs?.bookingId) jobs.booking = bookingAnswer(callFor('booking'), hotel.refs.bookingId, HEAT_QUESTION);
  if (enabled('google') && hotel.refs?.serpToken) jobs.google = google.googleReviews(hotel.refs.serpToken);
  const ids = Object.keys(jobs);
  const settled = await Promise.allSettled(Object.values(jobs));
  const out = { reviews: [], bookingAnswer: null, summary: null, amenities: [], errors: [] };
  settled.forEach((r, i) => {
    if (r.status === 'rejected') { out.errors.push(`${ids[i]}: ${r.reason?.message || r.reason}`); return; }
    if (ids[i] === 'tripadvisor') {
      out.reviews.push(...r.value.reviews);
      out.summary = r.value.summary;
      out.amenities = r.value.amenities;
    } else if (ids[i] === 'booking') out.bookingAnswer = r.value;
    else out.reviews.push(...r.value);
  });
  return out;
}

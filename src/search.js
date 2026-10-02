// Runs every enabled source in parallel and merges the results.
import { config } from './config.js';
import { caller, listTools } from './mcpClient.js';
import { demoCaller } from './providers/demo.js';
import * as google from './providers/serpapi.js';
import { geocode } from './geocode.js';
import { merge, addOffers, nightsBetween } from './shared/merge.js';
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

export async function searchAll(stay) {
  const nights = nightsBetween(stay.checkIn, stay.checkOut);
  const jobs = {};
  if (enabled('super')) jobs.super = searchSuper(callFor('super', 90_000), stay);
  if (enabled('booking')) jobs.booking = searchBooking(callFor('booking'), stay);
  if (enabled('tripadvisor')) {
    jobs.tripadvisor = tripadvisorVersionLive().then((version) => searchTripadvisor(callFor('tripadvisor', 45_000), stay, { version }));
  }
  if (enabled('google')) jobs.google = google.searchGoogle(stay);

  const ids = Object.keys(jobs);
  const settled = await Promise.allSettled(Object.values(jobs));
  const listings = [];
  const status = [];
  let center = null;
  settled.forEach((r, i) => {
    const id = ids[i];
    const label = SOURCE_INFO[id]?.label || 'Google Hotels';
    if (r.status === 'rejected') {
      status.push({ id, label, ok: false, error: String(r.reason?.message || r.reason).slice(0, 200) });
      return;
    }
    const value = id === 'tripadvisor' ? r.value.listings : r.value;
    if (id === 'tripadvisor') center = r.value.center;
    listings.push(...value);
    status.push({ id, label, ok: true, count: value.length });
  });
  if (!listings.length && status.every((s) => !s.ok)) {
    throw Object.assign(new Error(`No site answered: ${status.map((s) => `${s.label}: ${s.error}`).join('; ')}`), { status: 502 });
  }
  if (!center && !config.demo) center = await geocode(stay.q);
  const hotels = merge(listings, nights).filter((h) => h.best);
  return { hotels, status, center };
}

// Every site's price for one hotel ("Compare all sites").
export async function hotelPrices(stay, hotel) {
  const jobs = [];
  const name = [hotel.name, hotel.city].filter(Boolean).join(', ');
  if (enabled('tripadvisor')) {
    jobs.push(tripadvisorVersionLive()
      .then((version) => tripadvisorDetails(callFor('tripadvisor', 45_000), stay, { hotelId: hotel.refs?.tripadvisorId, hotelName: name, version }))
      .then((d) => d.offers));
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
    jobs.tripadvisor = tripadvisorVersionLive().then((version) => tripadvisorDetails(callFor('tripadvisor', 45_000), stay, { hotelId: hotel.refs?.tripadvisorId, hotelName: name, version }));
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

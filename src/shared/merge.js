// Normalised listing helpers and cross-site de-duplication.
//
// Every source produces "listings": one hotel as seen by one site. merge()
// groups listings that are the same property (by name similarity and, when
// both have coordinates, distance) into one hotel with offers from every site.
import { haversineKm } from './geo.js';
import { detectFeatures } from './features.js';

export const round2 = (n) => Math.round(n * 100) / 100;

export function nightsBetween(checkIn, checkOut) {
  const ms = new Date(`${checkOut}T00:00:00Z`) - new Date(`${checkIn}T00:00:00Z`);
  return Math.max(1, Math.round(ms / 86_400_000));
}

// One price offer; always yields both nightly and total.
export function makeOffer({ source, via = null, link = null, nightly, total, nightlyBeforeTax, totalBeforeTax, nights, taxIncluded = null, freeCancellation = false, note = null }) {
  if (nightly == null && total != null) nightly = total / nights;
  if (total == null && nightly != null) total = nightly * nights;
  if (totalBeforeTax == null && nightlyBeforeTax != null) totalBeforeTax = nightlyBeforeTax * nights;
  if (nightlyBeforeTax == null && totalBeforeTax != null) nightlyBeforeTax = totalBeforeTax / nights;
  if (!(nightly > 0)) return null;
  return {
    source: source || 'Unknown',
    via,
    link,
    nightly: round2(nightly),
    total: round2(total),
    nightlyBeforeTax: nightlyBeforeTax != null ? round2(nightlyBeforeTax) : null,
    totalBeforeTax: totalBeforeTax != null ? round2(totalBeforeTax) : null,
    taxIncluded,
    freeCancellation: !!freeCancellation,
    note,
  };
}

export function parseMoney(s) {
  if (typeof s === 'number') return s;
  if (!s) return null;
  const n = Number(String(s).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const STOP = new Set(['the', 'hotel', 'hotels', 'and', 'by', 'a', 'an', 'at', 'of', 'in', 'on', 'amp']);

export function nameTokens(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && !STOP.has(t));
}

export function hotelKey(name) {
  return [...new Set(nameTokens(name))].sort().join('-') || 'unknown';
}

function similarity(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return { overlap: 0, jaccard: 0 };
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return { overlap: inter / Math.min(A.size, B.size), jaccard: inter / (A.size + B.size - inter) };
}

export function sameHotel(a, b) {
  const d = haversineKm(a, b);
  if (d != null && d > 2) return false;
  const { overlap, jaccard } = similarity(a.tokens || nameTokens(a.name), b.tokens || nameTokens(b.name));
  if (overlap >= 0.85 && jaccard >= 0.45) return true;
  if (d != null && d < 0.25 && overlap >= 0.6) return true;
  return false;
}

export function merge(listings, nights) {
  const groups = [];
  for (const l of listings) {
    if (!l || !l.name) continue;
    const item = { ...l, tokens: nameTokens(l.name) };
    const g = groups.find((grp) => grp.items.some((x) => x.source !== item.source && sameHotel(x, item)));
    if (g) g.items.push(item);
    else groups.push({ items: [item] });
  }
  return groups.map(({ items }) => combine(items, nights));
}

const NAME_PREFERENCE = ['booking', 'tripadvisor', 'google', 'super', 'demo'];

function combine(items, nights) {
  const byPref = [...items].sort((a, b) => NAME_PREFERENCE.indexOf(a.source) - NAME_PREFERENCE.indexOf(b.source));
  const first = (fn) => { for (const i of byPref) { const v = fn(i); if (v != null && v !== '') return v; } return null; };
  const withCoords = byPref.find((i) => i.lat != null);

  // Combined guest rating, weighted by review counts.
  const ratings = items.filter((i) => i.rating != null).map((i) => ({ source: i.sourceLabel || i.source, rating: i.rating, count: i.reviewCount || 0 }));
  const totalCount = ratings.reduce((s, r) => s + r.count, 0);
  const rating = ratings.length
    ? Math.round((totalCount ? ratings.reduce((s, r) => s + r.rating * r.count, 0) / totalCount : ratings.reduce((s, r) => s + r.rating, 0) / ratings.length) * 10) / 10
    : null;

  const amenities = [...new Set(items.flatMap((i) => i.amenities || []))];
  const bySource = new Map();
  for (const o of items.flatMap((i) => i.offers || [])) {
    const k = o.source.toLowerCase().replace(/\.com$|\s+/g, '');
    const prev = bySource.get(k);
    if (!prev || o.nightly < prev.nightly) bySource.set(k, o);
  }
  const offers = [...bySource.values()].sort((a, b) => a.nightly - b.nightly);
  const refs = Object.assign({}, ...items.map((i) => i.refs || {}));
  const name = first((i) => i.name);

  return {
    key: hotelKey(name),
    name,
    lat: withCoords?.lat ?? null,
    lng: withCoords?.lng ?? null,
    address: first((i) => i.address),
    city: first((i) => i.city),
    stars: Math.max(0, ...items.map((i) => i.stars || 0)) || null,
    rating,
    reviewCount: totalCount,
    ratings,
    image: first((i) => i.image),
    link: first((i) => i.link),
    amenities,
    features: { ...detectFeatures(amenities), amenitiesKnown: amenities.length > 0 },
    offers,
    best: offers[0] || null,
    refs,
    sources: [...new Set(items.map((i) => i.sourceLabel || i.source))],
    nights,
  };
}

// Adds freshly fetched offers (e.g. from a details call) into a hotel.
export function addOffers(hotel, offers) {
  const all = [...(hotel.offers || []), ...offers.filter(Boolean)];
  const bySource = new Map();
  for (const o of all) {
    const k = o.source.toLowerCase().replace(/\.com$|\s+/g, '');
    const prev = bySource.get(k);
    if (!prev || o.nightly < prev.nightly) bySource.set(k, o);
  }
  hotel.offers = [...bySource.values()].sort((a, b) => a.nightly - b.nightly);
  hotel.best = hotel.offers[0] || null;
  return hotel;
}

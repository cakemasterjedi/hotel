// "Near me" search helpers (browser + server).
//
// Booking.com can search a radius around a point, but Super.com and
// Tripadvisor only take place names. So we search Booking.com first, take
// the towns its nearby hotels are in, and search those towns on the other sites.
import { haversineKm } from './geo.js';

// "Maple Heights, OH" -> "OH"
export function stateOf(label) {
  const m = /,\s*([A-Z]{2})\b/.exec(label || '');
  return m ? m[1] : null;
}

export function nearbyAreas(listings, { base, point, radiusKm, max = 2 }) {
  const state = stateOf(base);
  const counts = new Map();
  for (const l of listings) {
    if (!l.city) continue;
    const d = l.lat != null && point ? haversineKm(point, l) : 0;
    if (d > radiusKm) continue;
    const city = l.city.replace(/\s*\(.*\)$/, '').trim();
    counts.set(city, (counts.get(city) || 0) + 1);
  }
  const baseCity = (base || '').split(',')[0].trim().toLowerCase();
  const top = [...counts.entries()]
    .filter(([c]) => c.toLowerCase() !== baseCity)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([c]) => (state ? `${c}, ${state}` : c));
  return [...new Set([base, ...top].filter(Boolean))];
}

// Drops hotels known to be outside the radius; keeps ones with no location yet.
export function withinRadius(hotels, point, radiusKm) {
  return hotels.filter((h) => h.lat == null || haversineKm(point, h) <= radiusKm);
}

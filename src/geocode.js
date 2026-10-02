import { haversineKm } from './shared/geo.js';
import { nameTokens } from './shared/merge.js';

// Turns a city or address into coordinates (OpenStreetMap, then Open-Meteo).

export async function geocode(place) {
  const q = String(place || '').trim();
  if (!q) return null;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'HotelHunter/1.0 (self-hosted)' }, signal: AbortSignal.timeout(10_000) });
    const [hit] = await res.json();
    if (hit) return { lat: Number(hit.lat), lng: Number(hit.lon), name: hit.display_name.split(',').slice(0, 2).join(',') };
  } catch { /* fall through */ }
  try {
    const name = q.split(',')[0];
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(10_000) });
    const hit = (await res.json()).results?.[0];
    if (hit) return { lat: hit.latitude, lng: hit.longitude, name: [hit.name, hit.admin1].filter(Boolean).join(', ') };
  } catch { /* ignore */ }
  return null;
}

// Finds a hotel's coordinates by name (Photon / OpenStreetMap), biased to the
// search area. Used for listings (e.g. Super.com) that don't include a location.

const LODGING = new Set(['hotel', 'motel', 'guest_house', 'hostel', 'apartment', 'resort', 'chalet', 'camp_site']);

export async function geocodeHotel(name, center) {
  const params = new URLSearchParams({ q: name, limit: '3' });
  if (center) { params.set('lat', center.lat); params.set('lon', center.lng); }
  const res = await fetch(`https://photon.komoot.io/api/?${params}`, { headers: { 'User-Agent': 'HotelHunter/1.0 (self-hosted)' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Photon HTTP ${res.status}`);
  const want = new Set(nameTokens(name));
  for (const f of (await res.json()).features || []) {
    const [lng, lat] = f.geometry?.coordinates || [];
    if (lat == null) continue;
    if (center && haversineKm(center, { lat, lng }) > 60) continue;
    const got = nameTokens(f.properties?.name);
    const overlap = got.filter((t) => want.has(t)).length / Math.max(1, Math.min(got.length, want.size));
    if (overlap >= 0.6 || (LODGING.has(f.properties?.osm_value) && overlap >= 0.4)) return { lat, lng };
  }
  return null;
}

const US_STATES = { Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', 'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY' };

// Coordinates -> "Maple Heights, OH" (town and state).
export async function reverseGeocode(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&zoom=12&lat=${lat}&lon=${lng}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'HotelHunter/1.0 (self-hosted)' }, signal: AbortSignal.timeout(10_000) });
  const a = (await res.json()).address || {};
  const town = a.city || a.town || a.village || a.hamlet || a.suburb || a.county;
  const state = US_STATES[a.state] || a.state;
  return [town, state].filter(Boolean).join(', ') || null;
}

const PRIVATE_IP = /^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fc|fd|::ffff:(127|10|192\.168)\.)/i;

// Approximate location from an IP address. For a private (home network) IP we
// look up the server's own public IP instead, which is the same household.
export async function locateIp(ip) {
  const target = ip && !PRIVATE_IP.test(ip) ? encodeURIComponent(ip.replace(/^::ffff:/, '')) : '';
  const res = await fetch(`https://ipwho.is/${target}`, { signal: AbortSignal.timeout(10_000) });
  const j = await res.json();
  if (!j.success) return null;
  return { lat: j.latitude, lng: j.longitude, name: [j.city, j.region_code || j.region].filter(Boolean).join(', '), approximate: true };
}

// Address / place autocomplete via Photon (OpenStreetMap), for text the
// bundled town list doesn't cover (street addresses, landmarks).
export async function suggestAddresses(q, { limit = 5 } = {}) {
  const params = new URLSearchParams({ q, limit: String(limit), lang: 'en' });
  // US only (the booking sources here are US-focused).
  params.set('bbox', '-170,18,-60,72');
  const res = await fetch(`https://photon.komoot.io/api/?${params}`, { headers: { 'User-Agent': 'HotelHunter/1.0 (self-hosted)' }, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`Photon HTTP ${res.status}`);
  return ((await res.json()).features || []).map((f) => {
    const p = f.properties || {};
    const [lng, lat] = f.geometry?.coordinates || [];
    const first = p.name || (p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street);
    const state = US_STATES[p.state] || p.state;
    const label = [...new Set([first, p.city || p.town || p.village, state].filter(Boolean))].join(', ');
    return lat != null && label ? { label, lat, lng } : null;
  }).filter(Boolean);
}

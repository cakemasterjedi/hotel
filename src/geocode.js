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

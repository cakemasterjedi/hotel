// Distance helpers (browser + server).

export function haversineKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const KM_PER_MI = 1.609344;

export function formatDistance(km, unit = 'mi') {
  if (km == null) return null;
  const v = unit === 'km' ? km : km / KM_PER_MI;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${unit}`;
}

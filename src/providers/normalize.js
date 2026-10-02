// Shared helpers that turn provider payloads into the app's hotel shape.

const POOL_RE = /\bpool/i;
const INDOOR_RE = /indoor pool/i;
const OUTDOOR_RE = /outdoor pool/i;
const HOT_TUB_RE = /hot tub|jacuzzi|whirlpool|spa tub|hot spring/i;
const HEATED_RE = /heated pool|heated (indoor|outdoor) pool/i;

export function detectFeatures(amenities = []) {
  const text = amenities.join(' | ');
  return {
    pool: POOL_RE.test(text),
    indoorPool: INDOOR_RE.test(text),
    outdoorPool: OUTDOOR_RE.test(text),
    hotTub: HOT_TUB_RE.test(text),
    heatedPoolListed: HEATED_RE.test(text),
  };
}

export function nightsBetween(checkIn, checkOut) {
  const ms = new Date(`${checkOut}T00:00:00Z`) - new Date(`${checkIn}T00:00:00Z`);
  return Math.max(1, Math.round(ms / 86_400_000));
}

// Normalises one price offer: always yields both nightly and total.
export function offer({ source, logo, link, nightly, total, nightlyBeforeTax, totalBeforeTax, nights, freeCancellation }) {
  if (nightly == null && total != null) nightly = total / nights;
  if (total == null && nightly != null) total = nightly * nights;
  if (totalBeforeTax == null && nightlyBeforeTax != null) totalBeforeTax = nightlyBeforeTax * nights;
  if (nightlyBeforeTax == null && totalBeforeTax != null) nightlyBeforeTax = totalBeforeTax / nights;
  if (nightly == null) return null;
  return {
    source: source || 'Unknown',
    logo: logo || null,
    link: link || null,
    nightly: round2(nightly),
    total: round2(total),
    nightlyBeforeTax: nightlyBeforeTax != null ? round2(nightlyBeforeTax) : null,
    totalBeforeTax: totalBeforeTax != null ? round2(totalBeforeTax) : null,
    freeCancellation: !!freeCancellation,
  };
}

export const round2 = (n) => Math.round(n * 100) / 100;

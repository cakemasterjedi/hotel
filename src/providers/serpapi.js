// Optional: Google Hotels via SerpApi (needs SERPAPI_KEY). Google Hotels
// compares Booking.com, Expedia, Hotels.com, Priceline, Agoda, the hotels'
// own sites and more, and has guest reviews for the heated-pool check.
import { config } from '../config.js';
import { makeOffer, nightsBetween } from '../shared/merge.js';

const BASE = 'https://serpapi.com/search.json';

async function call(params) {
  const url = new URL(BASE);
  for (const [k, v] of Object.entries({ ...params, api_key: config.serpApiKey, hl: config.hl })) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`SerpApi: ${body.error || `HTTP ${res.status}`}`);
  return body;
}

function offers(prices = [], nights) {
  return prices.map((p) => makeOffer({
    source: p.source,
    via: 'Google',
    link: p.link,
    nightly: p.rate_per_night?.extracted_lowest,
    total: p.total_rate?.extracted_lowest,
    nightlyBeforeTax: p.rate_per_night?.extracted_before_taxes_fees,
    totalBeforeTax: p.total_rate?.extracted_before_taxes_fees,
    nights,
    taxIncluded: true,
    freeCancellation: p.free_cancellation,
  })).filter(Boolean);
}

function listing(p, nights) {
  const list = offers(p.prices, nights);
  if (!list.length && p.rate_per_night?.extracted_lowest) {
    list.push(makeOffer({ source: 'Google Hotels', link: p.link, nightly: p.rate_per_night.extracted_lowest, total: p.total_rate?.extracted_lowest, nights, taxIncluded: true }));
  }
  return {
    source: 'google',
    sourceLabel: 'Google',
    name: p.name,
    lat: p.gps_coordinates?.latitude ?? null,
    lng: p.gps_coordinates?.longitude ?? null,
    stars: p.extracted_hotel_class || null,
    rating: p.overall_rating || null,
    reviewCount: p.reviews || 0,
    image: p.images?.[0]?.thumbnail || null,
    link: p.link,
    amenities: p.amenities || [],
    offers: list,
    refs: { serpToken: p.property_token },
  };
}

export async function searchGoogle(stay) {
  const nights = nightsBetween(stay.checkIn, stay.checkOut);
  const out = [];
  let token;
  for (let page = 0; page < config.searchPages; page++) {
    const data = await call({
      engine: 'google_hotels', q: stay.q, check_in_date: stay.checkIn, check_out_date: stay.checkOut,
      adults: stay.adults, children: stay.children || undefined, currency: stay.currency, gl: config.gl, sort_by: 3, next_page_token: token,
    });
    for (const p of data.properties || []) if (p.property_token) out.push(listing(p, nights));
    token = data.serpapi_pagination?.next_page_token;
    if (!token) break;
  }
  return out;
}

export async function googleOffers(stay, token) {
  const nights = nightsBetween(stay.checkIn, stay.checkOut);
  const data = await call({
    engine: 'google_hotels', q: stay.q, property_token: token, check_in_date: stay.checkIn, check_out_date: stay.checkOut,
    adults: stay.adults, children: stay.children || undefined, currency: stay.currency, gl: config.gl,
  });
  return [...offers(data.featured_prices, nights), ...offers(data.prices, nights)];
}

export async function googleReviews(token) {
  const reviews = [];
  let next;
  for (let page = 0; page < config.reviewPages; page++) {
    const data = await call({ engine: 'google_hotels_reviews', property_token: token, sort_by: 2, next_page_token: next });
    for (const r of data.reviews || []) if (r.snippet) reviews.push({ text: r.snippet, rating: r.rating ?? null, date: r.date || null, source: 'Google' });
    next = data.serpapi_pagination?.next_page_token;
    if (!next) break;
  }
  return reviews;
}

// Live data from Google Hotels via SerpApi. Google Hotels aggregates rates from
// Booking.com, Expedia, Hotels.com, Priceline, Agoda, Trip.com, the hotel's own
// site and many more, so one query compares nearly every major booking site.
import { config } from '../config.js';
import { detectFeatures, nightsBetween, offer } from './normalize.js';

const BASE = 'https://serpapi.com/search.json';

async function call(params) {
  const url = new URL(BASE);
  for (const [k, v] of Object.entries({ ...params, api_key: config.serpApiKey, hl: config.hl })) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new Error(`SerpApi: ${body.error || `HTTP ${res.status}`}`);
  }
  return body;
}

function mapOffers(prices = [], nights) {
  return prices
    .map((p) => offer({
      source: p.source,
      logo: p.logo,
      link: p.link,
      nightly: p.rate_per_night?.extracted_lowest,
      total: p.total_rate?.extracted_lowest,
      nightlyBeforeTax: p.rate_per_night?.extracted_before_taxes_fees,
      totalBeforeTax: p.total_rate?.extracted_before_taxes_fees,
      nights,
      freeCancellation: p.free_cancellation,
    }))
    .filter(Boolean);
}

function mapProperty(p, nights) {
  const offers = mapOffers(p.prices, nights);
  const headline = offer({
    source: offers[0]?.source || 'Best listed rate',
    link: p.link,
    nightly: p.rate_per_night?.extracted_lowest,
    total: p.total_rate?.extracted_lowest,
    nightlyBeforeTax: p.rate_per_night?.extracted_before_taxes_fees,
    totalBeforeTax: p.total_rate?.extracted_before_taxes_fees,
    nights,
  });
  const all = headline ? [headline, ...offers] : offers;
  const best = all.reduce((a, b) => (!a || b.nightly < a.nightly ? b : a), null);
  const amenities = p.amenities || [];
  return {
    token: p.property_token,
    name: p.name,
    type: p.type,
    link: p.link,
    description: p.description,
    image: p.images?.[0]?.thumbnail || p.images?.[0]?.original_image || null,
    hotelClass: p.extracted_hotel_class || null,
    rating: p.overall_rating || null,
    reviewCount: p.reviews || 0,
    location: p.gps_coordinates || null,
    amenities,
    features: detectFeatures(amenities),
    best,
    offers,
    nights,
  };
}

export async function searchHotels({ q, checkIn, checkOut, adults, children, currency }) {
  const nights = nightsBetween(checkIn, checkOut);
  const hotels = [];
  let token;
  for (let page = 0; page < config.searchPages; page++) {
    const data = await call({
      engine: 'google_hotels',
      q,
      check_in_date: checkIn,
      check_out_date: checkOut,
      adults,
      children: children || undefined,
      currency,
      gl: config.gl,
      sort_by: 3, // lowest price first
      next_page_token: token,
    });
    for (const p of data.properties || []) {
      if (p.property_token) hotels.push(mapProperty(p, nights));
    }
    token = data.serpapi_pagination?.next_page_token;
    if (!token) break;
  }
  // Pages can overlap; keep the first occurrence of each property.
  const seen = new Set();
  return hotels.filter((h) => !seen.has(h.token) && seen.add(h.token));
}

// Full per-site price list for one hotel.
export async function hotelDetails({ token, q, checkIn, checkOut, adults, children, currency }) {
  const nights = nightsBetween(checkIn, checkOut);
  const data = await call({
    engine: 'google_hotels',
    q,
    property_token: token,
    check_in_date: checkIn,
    check_out_date: checkOut,
    adults,
    children: children || undefined,
    currency,
    gl: config.gl,
  });
  const hotel = mapProperty({ ...data, property_token: token }, nights);
  const offers = [...mapOffers(data.featured_prices, nights), ...hotel.offers];
  // De-duplicate by source, keeping the cheapest.
  const bySource = new Map();
  for (const o of offers) {
    const prev = bySource.get(o.source);
    if (!prev || o.nightly < prev.nightly) bySource.set(o.source, o);
  }
  hotel.offers = [...bySource.values()].sort((a, b) => a.nightly - b.nightly);
  if (hotel.offers[0] && (!hotel.best || hotel.offers[0].nightly < hotel.best.nightly)) hotel.best = hotel.offers[0];
  return hotel;
}

export async function hotelReviews({ token }) {
  const reviews = [];
  let next;
  for (let page = 0; page < config.reviewPages; page++) {
    const data = await call({ engine: 'google_hotels_reviews', property_token: token, sort_by: 2, next_page_token: next });
    for (const r of data.reviews || []) {
      if (r.snippet) reviews.push({ text: r.snippet, rating: r.rating ?? null, date: r.date || null, source: r.source || null });
    }
    next = data.serpapi_pagination?.next_page_token;
    if (!next) break;
  }
  return reviews;
}

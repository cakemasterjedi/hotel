// Adapters for the hotel sites that publish MCP endpoints (the same
// connectors Claude uses). Transport-agnostic: each function receives
// `call(tool, args) => payload` so the server (direct HTTP) and the phone
// page (claude.ai connectors) share the exact same logic.
import { makeOffer, parseMoney, nightsBetween } from './merge.js';

export const TA_VERSION_FALLBACK = 'V2026_0327';
const CHILD_AGE = 8; // ages are required by some sites; we only ask for a count

export const SOURCE_INFO = {
  super: { label: 'Super.com', server: 'Super.com', url: 'https://www.super.com/travel/mcp' },
  booking: { label: 'Booking.com', server: 'Booking.com', url: 'https://demandapi-mcp.booking.com/v1/mcp/8132308' },
  tripadvisor: { label: 'Tripadvisor', server: 'Tripadvisor', url: 'https://production.ai-mcp-extensibility-prd.tamg.cloud/ogMvjY4De1G7CiHanMOAgddl/mcp' },
};

// Reads the version constant Tripadvisor requires from its input schema.
export function tripadvisorVersion(inputSchema) {
  return inputSchema?.properties?.mcpServerVersion?.properties?.version?.const || TA_VERSION_FALLBACK;
}

const childAges = (stay) => Array.from({ length: Number(stay.children) || 0 }, () => CHILD_AGE);

// ---------------- Super.com ----------------
// Super.com searches a whole city and quotes per-night prices incl. tax (1 adult).

export async function searchSuper(call, stay) {
  const nights = nightsBetween(stay.checkIn, stay.checkOut);
  const args = { check_in: stay.checkIn, check_out: stay.checkOut, city_name: stay.q };
  let p = await call('get_rates_for_city', args);
  // Super.com only understands bare city names ("Scottsdale", not "Scottsdale, AZ").
  const bare = stay.q.split(',')[0].trim();
  if (!p?.hotels?.length && bare && bare !== stay.q) p = await call('get_rates_for_city', { ...args, city_name: bare });
  return (p?.hotels || []).map((h) => ({
    source: 'super',
    sourceLabel: 'Super.com',
    name: h.name,
    lat: null,
    lng: null,
    city: h.city,
    stars: h.stars || null,
    rating: null,
    reviewCount: 0,
    image: h.images?.[0] || null,
    link: h.url,
    amenities: h.amenities || [],
    offers: [makeOffer({ source: 'Super.com', link: h.url, nightly: h.price_after_tax, nightlyBeforeTax: h.price_before_tax, nights, taxIncluded: true })],
    refs: { superName: h.name },
  }));
}

export async function superLowest(call, stay, hotelName) {
  const nights = nightsBetween(stay.checkIn, stay.checkOut);
  const p = await call('get_lowest_price_for_hotel', { check_in: stay.checkIn, check_out: stay.checkOut, hotel_name: hotelName });
  const r = (p?.rates || []).reduce((a, b) => (!a || b.total_price < a.total_price ? b : a), null);
  if (!r) return null;
  return makeOffer({ source: 'Super.com', link: p.booking_url || p.url, nightly: r.total_price, nightlyBeforeTax: r.pre_tax_price, nights, taxIncluded: true, note: r.description });
}

// ---------------- Booking.com ----------------
// Booking.com returns ~10 properties per call, so we query a few price bands.

const BOOKING_BANDS = [{ maximum: 130 }, { minimum: 130, maximum: 250 }, { minimum: 250 }, null];

export async function searchBooking(call, stay) {
  const nights = nightsBetween(stay.checkIn, stay.checkOut);
  const base = {
    checkin_date: stay.checkIn,
    checkout_date: stay.checkOut,
    destination: stay.q,
    number_of_adults: Number(stay.adults) || 2,
    number_of_rooms: 1,
    user_country_code: 'us',
    user_locale: 'en-us',
    currency: stay.currency || 'USD',
  };
  const ages = childAges(stay);
  if (ages.length) base.children_ages = ages;
  const results = await Promise.allSettled(BOOKING_BANDS.map((price) => call('accommodations_search', price ? { ...base, price } : base)));
  const ok = results.filter((r) => r.status === 'fulfilled');
  if (!ok.length) throw results[0].reason;
  const seen = new Set();
  const out = [];
  for (const r of ok) {
    for (const a of r.value?.accommodations || []) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      const c = a.location?.coordinates;
      out.push({
        source: 'booking',
        sourceLabel: 'Booking.com',
        name: a.name,
        lat: c?.latitude ?? null,
        lng: c?.longitude ?? null,
        address: [a.location?.address, a.location?.city_name].filter(Boolean).join(', ') || null,
        city: a.location?.city_name || null,
        stars: a.rating?.stars || null,
        rating: a.rating?.review_score != null ? Math.round((a.rating.review_score / 2) * 10) / 10 : null,
        reviewCount: a.rating?.number_of_reviews || 0,
        image: null,
        link: a.url,
        amenities: a.facilities || [],
        offers: [makeOffer({ source: 'Booking.com', link: a.url, total: a.price?.book, nights, taxIncluded: null })],
        refs: { bookingId: a.id },
      });
    }
  }
  return out;
}

export async function bookingAnswer(call, bookingId, question) {
  const p = await call('answer_property_qa_by_ids_v2', { user_question: question, hotel_ids: [bookingId] });
  return typeof p === 'string' ? p : p?.answer || null;
}

// ---------------- Tripadvisor ----------------
// Prices are for the whole stay incl. fees but before taxes.

const TA_BASE = 'https://www.tripadvisor.com';
const taLink = (u) => (!u ? null : u.startsWith('http') ? u : TA_BASE + u);
const partnerFromUrl = (u) => {
  const m = /[?&]p=([^&]+)/.exec(u || '');
  if (!m) return null;
  const p = decodeURIComponent(m[1]).replace(/Images$|Hotels$/, '');
  return /\./.test(p) ? p : p.replace(/([a-z])([A-Z])/g, '$1 $2');
};

function taContext(version) {
  return { mcpServerVersion: { version: version || TA_VERSION_FALLBACK }, requestContext: { clientType: 'MOBILE' } };
}

export async function searchTripadvisor(call, stay, { version, limit = 30 } = {}) {
  const nights = nightsBetween(stay.checkIn, stay.checkOut);
  const args = {
    location: stay.q,
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    guests: Number(stay.adults) || 2,
    limit,
    pricingMode: 'QUICK',
    ...taContext(version),
  };
  const ages = childAges(stay);
  if (ages.length) args.childrenAges = ages;
  const p = await call('search_hotels', args);
  const geo = p?.searchParameters?.searchGeoData;
  const listings = (p?.hotels || []).map((h) => {
    const offer = h.metaResult?.primaryOffers?.[0] || h.priceInfo;
    const partner = partnerFromUrl(offer?.commerceUrl) || 'Tripadvisor partner';
    const sizes = h.thumbnail?.photoSizes || [];
    const img = sizes.find((s) => s.width >= 250) || sizes.at(-1);
    return {
      source: 'tripadvisor',
      sourceLabel: 'Tripadvisor',
      name: h.hotelName,
      lat: h.geocode?.latitude ?? null,
      lng: h.geocode?.longitude ?? null,
      stars: null,
      rating: h.reviewSummary?.rating ?? null,
      reviewCount: h.reviewSummary?.count || 0,
      image: img?.url || null,
      link: taLink(h.hotelReviewUrl),
      amenities: [],
      offers: [offer && offer.availabilityStatus !== 'UNAVAILABLE'
        ? makeOffer({ source: partner, via: 'Tripadvisor', link: taLink(offer.commerceUrl || offer.linkToBook), total: parseMoney(offer.displayPrice), nights, taxIncluded: false })
        : null].filter(Boolean),
      refs: { tripadvisorId: h.hotelId },
    };
  });
  return { listings, center: geo ? { lat: geo.lat, lng: geo.lon, name: geo.name } : null };
}

export async function tripadvisorDetails(call, stay, { hotelId, hotelName, version }) {
  const nights = nightsBetween(stay.checkIn, stay.checkOut);
  const args = {
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    guests: Number(stay.adults) || 2,
    includeReviews: true,
    includeAmenities: true,
    ...taContext(version),
  };
  if (hotelId) args.hotelId = Number(hotelId);
  else args.hotelName = hotelName;
  const p = await call('hotel_details', args);
  const h = p?.hotel || {};
  const offers = (p?.offers?.metaOffers || [])
    .filter((o) => o.status !== 'UNAVAILABLE')
    .map((o) => makeOffer({ source: o.providerName || partnerFromUrl(o.commerceUrl) || 'Partner', via: 'Tripadvisor', link: taLink(o.commerceUrl), total: parseMoney(o.displayPrice), nights, taxIncluded: false }))
    .filter(Boolean);
  const reviews = (h.reviews || []).map((r) => ({
    text: [r.title, r.text].filter(Boolean).join('. '),
    rating: r.rating ?? null,
    date: r.publishedDate || null,
    source: 'Tripadvisor',
  }));
  return {
    hotelId: h.id,
    name: h.name,
    lat: h.location?.latitude ?? null,
    lng: h.location?.longitude ?? null,
    amenities: (h.amenities || []).map((a) => a.name),
    offers,
    reviews,
    summary: typeof p?.aiReviewSummary === 'string' ? p.aiReviewSummary : null,
  };
}

// Resolves a place name to coordinates using Tripadvisor's geo lookup.
export async function tripadvisorGeocode(call, place, { version } = {}) {
  const p = await call('search_hotels', { location: place, limit: 1, pricingMode: 'NONE', ...taContext(version) });
  const g = p?.searchParameters?.searchGeoData;
  return g ? { lat: g.lat, lng: g.lon, name: g.name || place } : null;
}

export const HEAT_QUESTION = 'Is the swimming pool heated, and is there a hot tub? What do guests say about how warm the pool and hot tub water is?';

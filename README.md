# 🏨 Hotel Hunter

A self-hosted web app that finds the cheapest hotel rates across booking sites, with:

- **Price per night and total price shown together** for every hotel and every site
- **Pool / indoor pool / outdoor pool / hot tub (Jacuzzi) filters**
- **Heated-pool detection from reviews**: reads recent guest reviews and works out whether the pool is heated and the hot tub is actually hot ("pool was freezing", "84 degrees", "wish it was heated", "hot tub lukewarm"…), and shows the quotes it based that on
- **"If you wait" price forecast**: what the price could rise to tomorrow and in a week, the chance it goes up, and a book-now / can-wait suggestion
- **Watchlist** that re-prices stays automatically and builds price history, which makes the forecast more accurate over time
- Filters for max price, guest rating and star class; sort by total, nightly, rating or value
- Works on phones, has dark mode, and can be password-protected

## Where the prices come from

Prices come from **Google Hotels** through [SerpApi](https://serpapi.com). Google Hotels already compares Booking.com, Expedia, Hotels.com, Priceline, Agoda, Trip.com, the hotels' own websites and many others. That's the most reliable legal way to cover "all sites" without scraping each one, which those sites block and their terms forbid.

You need a SerpApi key (they have a free tier). **Without a key the app runs in demo mode** with made-up hotels so you can try it out.

API credits used:

| Action | Credits |
| --- | --- |
| Search | 1 per results page (`SEARCH_PAGES`, default 2), cached 6 h |
| Compare all sites (one hotel) | 1, cached 6 h |
| Check pool heat (one hotel) | 1 per review page (`REVIEW_PAGES`, default 2), cached 14 days |
| Each watched stay | 1 every `WATCH_INTERVAL_HOURS` (default 12 h) |

## Run it locally

Needs Node.js 22.5 or newer.

```bash
npm install
cp .env.example .env      # add SERPAPI_KEY, or leave it empty for demo mode
npm start                 # http://localhost:3000
npm test
```

## Put it on your domain

On any small Linux VPS (DigitalOcean, Hetzner, Lightsail…) with Docker installed:

1. In your DNS provider, add an **A record** pointing your domain (e.g. `hotels.yourdomain.com`) to the server's IP address.
2. On the server:

   ```bash
   git clone <this repo> hotel && cd hotel
   cp .env.example .env
   nano .env      # set DOMAIN, SERPAPI_KEY and APP_PASSWORD
   docker compose up -d --build
   ```

3. Open `https://hotels.yourdomain.com`. Caddy gets and renews the HTTPS certificate automatically, so ports 80 and 443 must be open.

Set `APP_PASSWORD` so strangers who find the site can't use up your API credits. The browser will ask for `APP_USER` / `APP_PASSWORD`.

Updating: `git pull && docker compose up -d --build`. Price history is kept in the `hotel-data` Docker volume.

## How the smart parts work

**Heated pool detection** (`src/poolHeat.js`). Each review is split into sentences, and only sentences that mention a pool or hot tub are kept. Temperature words ("heated", "warm", "freezing", "lukewarm", "not heated", "wish it was heated") and numbers ("82°F", "29 C") are scored and assigned to the *nearest* facility, so "the pool was freezing but the hot tub was nice and hot" counts against the pool and for the hot tub. Each review gets one vote per facility. The verdict (Likely heated / Likely unheated / Mixed / No info) comes with a confidence level and the supporting quotes. If the listing itself says "heated pool", that counts as an extra vote. Outdoor pools are often heated only in some seasons, so check the dates on the quotes.

**Price forecast** (`src/forecast.js`). This is a statistical estimate, not a guarantee. It starts from typical hotel pricing behaviour: prices creep up as check-in approaches and climb fastest in the last 2–3 weeks, and weekend or peak-season stays swing more. It then blends in the actual price history this app has recorded for that exact stay. The more snapshots it has (searches and the watchlist add them), the more weight the real trend gets. "Up to" means the 90th-percentile scenario. When it's a toss-up, booking a free-cancellation rate and keeping it on the watchlist is usually the safest move.

## Project layout

```
src/server.js            API + static hosting + watchlist scheduler
src/providers/serpapi.js Google Hotels via SerpApi (live data)
src/providers/demo.js    fake data for demo mode
src/poolHeat.js          review analysis for pool / hot tub temperature
src/forecast.js          price forecast
src/db.js                SQLite (built into Node) for cache, price history, watchlist
public/                  the web UI (plain HTML/CSS/JS, no build step)
```

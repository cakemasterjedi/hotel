# 🏨 Hotel Hunter

A self-hosted web app that finds the cheapest hotel rates across booking sites:

- **Super.com, Booking.com and Tripadvisor** prices with no API key. Tripadvisor brings in prices from Expedia, Hotels.com, Priceline, Agoda, hotel websites and more. Add a SerpApi key and **Google Hotels** comes in too.
- The same hotel from different sites is merged into **one card**, with the cheapest price on top and every site's price one tap away
- **Price per night and total price** side by side, with a note on whether each site includes tax
- **Pool / hot tub / heated pool are highlights, not filters.** Cheap hotels without them still show; hotels that have them get a blue border and a "✓ Has pool + hot tub" tag
- **Location autofill** as you type: US towns appear instantly from a built-in list (GeoNames, CC BY 4.0), and the self-hosted app also suggests street addresses and landmarks from OpenStreetMap
- **Hotel photos:** each card shows a picture, and "📷 Photos" opens a gallery of the hotel's Tripadvisor photos (hotel and guest photos) plus the booking sites' listing photos. On the phone page, "Photos ↗" opens the hotel's page instead, because claude.ai pages can't load outside images.
- **Near me search:** find hotels within 5–50 miles of you. On the self-hosted app, "📍 Locate me" uses your phone's GPS on an https address and falls back to an approximate location from your internet connection on plain http. You can also type any city or address. Booking.com searches the radius, the nearby towns it finds are searched on the other sites, and anything outside the radius is dropped.
- **Distance** from your location (📍) or any city/address you type, with sort by distance and a max-distance limit
- **"Is the pool heated?"** reads recent guest reviews ("pool was freezing", "84 degrees", "hot tub lukewarm"…), asks Booking.com's hotel Q&A, and shows the quotes it based the answer on
- **"If you wait"** estimate: how high the price could go tomorrow and in a week, the chance it rises, and a book-now / can-wait suggestion
- **Dark mode** by default (☀️ button for light)
- **Weekend deal alerts**: checks the next 4 weekends near you and lists hotels priced well below their usual weekend rate
- **Watchlist** re-prices stays automatically and builds price history, which makes the forecast better over time

## Use it on your phone right now

`mobile/hotel-hunter.html` is published as a claude.ai page: **https://claude.ai/artifact/6r3uHR4WniU2dWJJEPvH8d**

1. In claude.ai, go to **Settings → Connectors** and add **Super.com**, **Booking.com** and **Tripadvisor** (free, no login).
2. Open the link above in the Claude app or a browser where you're signed in. The first search asks you to allow the three connectors for the page.

The phone page has everything except the watchlist. Its forecast history stays on that phone. Pick "Near a place" and type your city or address with a radius; claude.ai pages can't read GPS.

## Run it on TrueNAS SCALE

Works on TrueNAS SCALE 24.10 (Electric Eel) or newer, where apps run on Docker.

**1. Get the image.** Every push to this repo builds `ghcr.io/cakemasterjedi/hotel:latest` with GitHub Actions (`.github/workflows/docker.yml`). The package must be public so TrueNAS can download it without a login. If a pull fails with "unauthorized", go to GitHub → your profile → **Packages** → `hotel` → **Package settings** → **Change visibility** → Public.

**2. Make a dataset** for the app's data, e.g. `tank/apps/hotel-hunter`. In its permissions, give the **apps** user (UID 568) read/write access.

**3. Install the app.** Go to **Apps → Discover Apps → ⋮ → Install via YAML**, name it `hotel-hunter`, and paste [`truenas/hotel-hunter.yaml`](truenas/hotel-hunter.yaml). Change:
- `/mnt/tank/apps/hotel-hunter` to your dataset path
- `APP_PASSWORD`
- `SERPAPI_KEY` (optional)

**4. Open it** at `http://<truenas-ip>:8095` and log in as `admin` with your password.

Updating: **Apps → hotel-hunter → Update / Pull image** (the YAML uses `pull_policy: always`, so a restart also pulls the newest image).

### Your own domain with HTTPS (from TrueNAS)

The simplest option for a home server is a **Cloudflare Tunnel**. You don't open any ports on your router, and HTTPS is automatic.

1. Put your domain on Cloudflare (free plan).
2. In **Cloudflare Zero Trust → Networks → Tunnels**, create a tunnel, then add a public hostname such as `hotels.yourdomain.com`. Point it at the service `http://hotel-hunter:3000`.
3. Copy the tunnel token into the commented-out `cloudflared` block in `truenas/hotel-hunter.yaml`, uncomment it, and update the app.

Prefer a reverse proxy instead? Point Nginx Proxy Manager (or the TrueNAS catalog's Traefik/Caddy apps) at `http://<truenas-ip>:8095`.

"📍 My location" in the browser only works over HTTPS. On plain `http://<ip>:8095`, type your city instead.

## Weekend deal alerts

`npm run deals` checks the next 4 weekends (Friday + Saturday night) near a place and prints the deals it finds:

```bash
npm run deals -- --origin "Maple Heights, OH" --areas "Maple Heights, OH|Cleveland, OH" \
  --radius 20 --history data/weekend-history.json
```

- **What counts as a deal:** a hotel's weekend price that is at least 15% below its usual weekend price (`--threshold 0.15`), or the cheapest pool / hot-tub hotel for a weekend hitting a new low. "Usual" is the median of that hotel's other weekend prices, from this scan and from earlier scans saved in the `--history` file.
- **What you get:** hotels with a pool or hot tub are listed first. The message also says when a whole weekend is cheaper than the others. A deal that was already reported isn't repeated unless its price drops further.
- **Where it searches:** `--areas` lists the place names to search (a small suburb alone has few hotels). Booking.com searches a radius around `--origin`, and anything farther than `--radius` miles is dropped.

A full scan takes about 4 minutes, because it spaces out its requests to the sites.

## Run it anywhere else

```bash
npm install
cp .env.example .env     # set APP_PASSWORD; SERPAPI_KEY is optional
npm start                # http://localhost:3000
npm test
```

On a VPS, `docker-compose.yml` runs the app behind Caddy with automatic HTTPS: set `DOMAIN` in `.env`, then run `docker compose up -d --build`.

## Where the prices come from

| Site | How | Key needed | Notes |
| --- | --- | --- | --- |
| Super.com | Super.com's public MCP server | No | Whole-city search, ~150 hotels, per-night price incl. tax (quoted for 1 adult) |
| Booking.com | Booking.com's public MCP server | No | ~10 hotels per call, so the app asks for 4 price bands |
| Tripadvisor | Tripadvisor's public MCP server | No | 30 hotels with a partner price (Expedia, Hotels.com, Agoda…); "Compare sites" lists every partner and pulls 10 recent reviews |
| Google Hotels | [SerpApi](https://serpapi.com) | `SERPAPI_KEY` | Google's price comparison plus more reviews |
| Priceline | via Google Hotels and Tripadvisor partners | for most prices, `SERPAPI_KEY` | Priceline has no public API or connector. Its prices show up when Google Hotels (usually) or Tripadvisor (rarely) lists them; otherwise "Compare all sites" has a "Find →" link to the hotel on Priceline |

The first three are the same public endpoints those companies run for AI assistants like Claude. They're free, but they're **best-effort**. They have bot protection that can block a server that sends too many requests, and they could change without notice. The app spreads its requests out, caches results for 6 hours (reviews for 14 days), and keeps working with whichever sites answer; a site that fails is marked "unavailable". Booking.com blocks some cloud/datacenter IPs, which usually isn't a problem on a home connection. Each site reports taxes differently, so the price table says which prices include tax.

Super.com listings have no map location, so the app looks those hotels up by name on OpenStreetMap (Photon) to work out distances. A few may still show "distance unknown".

## How the smart parts work

**Heated pool / hot tub** (`src/shared/poolHeat.js`). Reviews are split into sentences, and only sentences that mention a pool or hot tub are kept. Temperature words ("heated", "warm", "freezing", "lukewarm", "not heated", "wish it was heated") and numbers ("82°F", "29 C") are scored and assigned to the *nearest* facility. So "the pool was freezing but the hot tub was nice and hot" counts against the pool and for the hot tub. Each review gets one vote, Booking.com's answer counts as one more, and a listing that says "Heated pool" adds one. The result is Likely heated / Likely unheated / Mixed / No info, with a confidence level and the quotes it used.

**Price forecast** (`src/shared/forecast.js`). This is a statistical estimate, not a guarantee. It starts from typical hotel pricing: prices creep up as check-in gets closer and climb fastest in the last 2–3 weeks, and weekend and peak-season stays swing more. It then blends in this app's own price history for that exact stay; searches and the watchlist both add to it. "Up to" is the 90th-percentile scenario.

## Project layout

```
src/server.js             API, static files, watchlist scheduler
src/search.js             runs all sites in parallel and merges results
src/mcpClient.js          tiny client for the sites' MCP servers
src/shared/               browser-safe logic shared by the server, the web UI and the phone page:
  places.js, usPlaces.js  location autofill (US towns; rebuild with scripts/build-places.js)
  autocomplete.js         the suggestion dropdown
  sources.js              Super.com / Booking.com / Tripadvisor adapters
  merge.js                matches the same hotel across sites
  features.js             pool / hot tub detection from amenity lists
  poolHeat.js, forecast.js, geo.js
src/providers/serpapi.js  Google Hotels (optional)
src/providers/demo.js     fake sites for DEMO_MODE
public/                   web UI (plain HTML/CSS/JS)
mobile/                   phone page: template.html → npm run build:mobile → hotel-hunter.html
truenas/hotel-hunter.yaml TrueNAS "Install via YAML" app definition
```

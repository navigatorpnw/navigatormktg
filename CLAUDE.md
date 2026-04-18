# CLAUDE.md — navigatormktg

## Owner

Ken Clements, Navigator PNW LLC (ken@navigatormktg.com)

## This Repository

Marketing website for **navigatormktg.com** — the Navigator PNW corporate site.

- **Tech stack:** React + Vite + Tailwind CSS v4 + React Router v7
- **Hosting:** Cloudflare Pages (has `wrangler.jsonc` + `@cloudflare/vite-plugin`)
- **Dev server:** `npm run dev`
- **Deploy:** `npm run deploy` (runs build + wrangler deploy)
- **Port:** 5174 (configured in `.claude/launch.json`)

## Local Environment

- **OS:** Windows
- **Base path:** `C:\Users\kencl\OneDrive\Claude\`
- **Node.js:** `C:\Program Files\nodejs\node.exe`
- **CLI:** Wrangler (`npx wrangler`) for Cloudflare deployments

## Project Folder Structure

All projects live under `C:\Users\kencl\OneDrive\Claude\`:

| Folder | Description |
|--------|-------------|
| `navigatormktg` | This repo — navigatormktg.com marketing site |
| `fueldocks-marketing` | fueldocks.app marketing site (React + Vite, Cloudflare Pages) |
| `FuelDocks` | Fuel Docks consumer app (React Native/Expo, iOS/Android) |
| `FDDialer` | FD Dialer — Ken's internal web app for calling marinas |
| `MyFuelDock` | My Fuel Dock — marina-facing B2B portal (myfueldock.com) |
| `myfueldock-app` | My Fuel Dock mobile app (React Native/Expo, iOS/Android) |
| `myfueldock-portal` | My Fuel Dock marina web portal (React SPA) |
| `myfueldock-widgets` | Embeddable price boards (hosted at mfdboard.com) — repo name is legacy; the public-facing term is "price board" |
| `icon-mockup` | App icon mockups |
| `docs` | Shared documentation (also committed to this repo under `docs/`) |

## Navigator PNW Ecosystem

Three interconnected products serving the marine fueling space:

1. **Fuel Docks** (Consumer App) — Free iOS/Android app for boaters to find fuel docks and compare gas/diesel prices. ~31 marinas in Puget Sound, expanding to US/Canada. Five price input methods: HTML scraping (Apify), JS scraping (Apify+Playwright), email (Mailgun), manual calls (Adalo), and marina self-service (MFD).

2. **FD Dialer** (Internal Web App) — Ken's tool for calling marinas and updating prices that can't be scraped. Single user (Ken).

3. **My Fuel Dock** (Marina Portal) — B2B service at myfueldock.com for marina operators to manage their own fuel prices. Embeddable price board widgets for marina websites. Free and paid tiers. Shares the same Xano FuelPrices database as the consumer app.

### Shared Backend

- **API/Database:** Xano (serverless, Postgres-backed)
- **AI:** Claude API (via Xano Function Pack) — parses HTML, emails, and unstructured content into structured price JSON
- **Web scraping:** Apify (Cheerio + Playwright actors)
- **Email:** Mailgun (inbound price parsing, outbound price requests)
- **Single source of truth:** Xano FuelPrices table (shared across all products)

## Brand Guidelines

- **Font:** Open Sans Condensed (Bold for headings, Light/Regular for body)
- **Logo Blue:** #070531 (dark backgrounds, text, headers)
- **Logo Red:** #E33500 (primary action buttons, CTAs)
- **Fuel colors:** Gas = Black (#000000), Diesel = Green (#1D9E75), Propane = Blue (#378ADD)
- **Tone:** Practical, straightforward, boater-to-boater. Plain English, no marine jargon.
- **Tagline:** "Marina fuel prices at your fingertips"

## Key Documentation

See `docs/` folder:

- `Navigator ecosystem.md` — Overview of all three products and how they connect
- `fuel_docks_system_design_v4_51.md` — Complete technical reference for Fuel Docks
- `my_fuel_dock_system_design_v1.111.md` — MFD architecture, database, API, and roadmap
- `marketing_sites_deployment.md` — Build and deploy guide for all marketing sites
- `fuel_docks_risk_register.md` — Security and operational risk tracking
- `navigator_brand_guidelines_v1.1.pdf` — Visual identity and brand voice guidelines

## Domains

| Domain | Purpose | Hosting |
|--------|---------|--------|
| navigatormktg.com | Navigator corporate site (this repo) | Cloudflare Pages |
| fueldocks.app | Fuel Docks consumer marketing site | Cloudflare Pages |
| myfueldock.com | My Fuel Dock marina portal | Cloudflare Pages |
| westmarkmarina.com | Demo marina site for MFD widget | WordPress.com |

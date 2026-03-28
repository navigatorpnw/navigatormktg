# Marketing Sites — Build & Deploy Guide

**Owner:** Ken Clements, Navigator PNW LLC
**Last Updated:** March 27, 2026

---

## Overview

Three marketing websites are built and deployed using the same core stack:

| Site | Domain | Cloudflare Project | Source Location |
|------|--------|--------------------|-----------------|
| Fuel Docks | fueldocks.app | `fueldocks-marketing` | `Fuel Docks\fueldocks-marketing` |
| Navigator Marketing | navigatormktg.com | `navigatormktg` | `Navigator\navigatormktg` |
| Westmark Marina | westmarkmarina.com | WordPress.com (Personal plan) | Hosted on WordPress.com — no local source |

All source paths are relative to `C:\Users\kencl\OneDrive\Navigator\`.

---

## Tech Stack

- **Framework:** React + Vite (fueldocks-marketing, navigatormktg) or WordPress (WestmarkMarina)
- **Styling:** Tailwind CSS v4 (React sites); native WordPress blocks (WestmarkMarina)
- **Routing:** React Router v7 (React sites)
- **Hosting:** Cloudflare Pages (React sites); WordPress.com (WestmarkMarina)
- **CLI:** Wrangler (`npx wrangler`) for React sites

---

## Build & Deploy

### fueldocks-marketing (fueldocks.app)

No wrangler config file — uses direct `wrangler pages deploy`.

```bash
cd "C:\Users\kencl\OneDrive\Navigator\Fuel Docks\fueldocks-marketing"
npm run build
npx wrangler pages deploy dist --project-name=fueldocks-marketing
```

Dev server: `npm run dev` (Vite on port 5173)

### navigatormktg (navigatormktg.com)

Has `wrangler.jsonc` config and `@cloudflare/vite-plugin`. Uses `wrangler deploy`.

```bash
cd "C:\Users\kencl\OneDrive\Navigator\navigatormktg"
npm run deploy    # runs: npm run build && wrangler deploy
```

Dev server: `npm run dev` (Vite)

### WestmarkMarina (westmarkmarina.com)

Hosted on **WordPress.com** (Personal plan). No local source files.

- **WordPress admin:** https://ownera06ea3765f-lgzdj.wordpress.com/wp-admin/
- **Live site:** https://westmarkmarina.com
- **DNS:** Cloudflare (A records → 192.0.78.24 / 192.0.78.25, www CNAME → westmarkmarina.com)
- **Email:** Zoho (MX/SPF/DKIM records on Cloudflare — do not modify)
- **Built with:** Native WordPress blocks (Cover, Columns, Group, Image, etc.)
- **Purpose:** Demo site for MFD widget embed video — shows marina operators how to add the widget to a WordPress site
- **Previous hosting:** Was a static HTML site on Cloudflare Pages (`westmark-marina` project). Old source files deleted March 2026.

---

## Cloudflare Pages Notes

- fueldocks-marketing and navigatormktg use Ken's Cloudflare account (authenticated via `npx wrangler` CLI)
- Custom domains are configured in the Cloudflare dashboard under each Pages project
- fueldocks-marketing and navigatormktg have Git Provider linked
- `_redirects` file in the dist/root handles SPA routing where needed
- westmark-marina Cloudflare Pages project is no longer active — site moved to WordPress.com

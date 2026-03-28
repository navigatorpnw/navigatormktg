
MY FUEL DOCK

System Design Document

Phase 1: Widget Rollout (Free + Paid Tiers)

Version 1.19  |  March 26, 2026

Navigator PNW LLC

Confidential

# 1. Overview

My Fuel Dock is the marina-facing side of the Fuel Docks ecosystem. It provides marina operators with embeddable price boards for their websites and a portal for managing fuel prices. The service offers a free tier to build marina coverage and a paid tier with additional update channels, customization, and analytics. The service runs on the same Xano database as the consumer Fuel Docks app, meaning any price update a marina makes through My Fuel Dock is immediately reflected in the consumer app.

Phase 1 launches both the free and paid widget tiers to build marina coverage while establishing a revenue stream. Data licensing is deferred to Phase 3. See Section 1.4 for detailed tier definitions.

## 1.1 Business Objectives

- Coverage: Get price boards installed on as many marina websites as possible to increase the rate and accuracy of price data flowing into the Fuel Docks database.
- Direct relationships: Establish a direct, ongoing technical relationship with marina operators (our code is on their website, they use our tools to update prices).
- Data quality: Shift marinas from passive (we scrape/call them) to active (they update prices themselves), reducing data collection costs and improving freshness.
- Flywheel: More widgets installed leads to more marinas updating prices, which leads to better consumer app data, which leads to more users, which leads to more marinas wanting widgets.
## 1.2 Domains and URLs

| Domain | Purpose | Notes |
| --- | --- | --- |
| myfueldock.com | Marina portal | React SPA on Cloudflare Pages. Primary domain for all marina-facing materials. |
| widgets.fueldocks.app | Widget/price board hosting | Cloudflare Pages (free tier, static assets) |
| fueldocks.app | Consumer marketing site | React + Vite on Cloudflare Pages (replacing Chariot, saves $17/month) |
| fueldock.app | Typo catch | Forwards to fueldocks.app |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

## 1.3 Relationship to Fuel Docks

My Fuel Dock and Fuel Docks share the same Xano database (Workspace 1, API Group 4). They are separate products with separate user bases (marina operators vs. boating consumers) that read and write the same underlying FuelPrices table. There is no direct integration between the two apps beyond the shared database.

Authentication is fully separate. My Fuel Dock marina operator accounts are stored in the mfd_users table. If/when the consumer Fuel Docks app adds user accounts in the future, those will use a separate table (e.g., fd_users). There is no shared auth, no shared sessions, and no shared user records between the two products.

## 1.4 Service Tiers

My Fuel Dock operates on a free + paid tier model. The free tier provides enough value to get widgets installed on marina websites (driving the data flywheel), while the paid tier monetizes convenience features and advanced functionality.

### Free Tier

| Feature | Details |
| --- | --- |
| Widget | 1 widget per marina (choice of 4 templates: card-standard, card-detailed, compact-horizontal, banner-wide) |
| Price updates | Via web portal only (myfueldock.com Dashboard) |
| Update frequency | Maximum 2 price changes per day (enforced by daily counter; see Section 4.3) |
| Display name | Customizable widget header text (display_name field) |
| Fuel availability | Toggle fuel available/unavailable with scheduled auto-revert |
| Branding | "Powered by myfueldock.com" link displayed on widget (not removable) |

### Paid Tier (includes everything in Free, plus)

| Feature | Details |
| --- | --- |
| Multiple widgets | More than one widget per marina |
| Custom colors | Custom widget color configuration (primary, background, text) |
| Update channels | Update prices, hours, and other info via mobile app, email, or text message — in addition to web portal |
| Unlimited updates | No daily limit on price changes |
| Hours management | Edit and manage operating hours |
| Price reminders | Configurable stale-price reminder emails (price_reminder_days) |
| Analytics | Site visitor counts and widget view counts (7-day, 30-day, bar chart) |
| Priority support | Faster response times for support requests |
| Future features | All new features and widget templates developed going forward |

### Not Available (Any Tier)

- No API access. All integrations go through the portal, mobile app, or email channels.

### Cost Management

The 2-changes-per-day limit on the free tier manages Xano API costs. Most small marinas change prices infrequently (weekly or less), so this limit will not impact typical free-tier usage but provides a clear upgrade trigger for marinas that update frequently.

# 2. Architecture

## 2.1 System Components

| Component | Technology | Purpose |
| --- | --- | --- |
| Marina Portal | React SPA on Cloudflare Pages (myfueldock.com) | Marina operators log in to update prices, configure widgets, manage account, view analytics |
| Price Board Templates | HTML/CSS/JS on Cloudflare Pages | Static files served from widgets.fueldocks.app; each template fetches live data from Xano API |
| Widget Data API | Xano endpoint (new) | Public, cached, rate-limited endpoint returning display-ready price data for a given marina ID |
| Marina Auth API | Xano endpoints (new) | Email/password and email-code authentication for marina operator accounts |
| Price Update API | Xano endpoints (new) | Accepts price updates from portal, mobile app, and email channels |
| My Fuel Dock App | React Native/Expo (new) | Separate mobile app for marina operators to update prices on the go |
| Email Inbound | Mailgun (prices@myfueldock.com) | Receives price update emails, parsed by Claude Haiku |
| Admin Dashboard | Web app (within portal) | Ken's view to manage all marinas, monitor activity, generate reports |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

## 2.2 Data Flow: Price Updates

All price update channels follow the same pattern:

- Input: Marina operator submits new pre-tax price(s) via any channel (portal, mobile app, email).
- Tax calculation: System looks up the applicable tax rate(s) for the marina's state and fuel type. Calculates the post-tax pump price automatically.
- Validation: Both pre-tax and calculated pump prices pass through validation (range checks, spike detection, prompt injection protection via validate_claude_output for AI-parsed inputs).
- Storage: Pre-tax price is stored in the _pretax field. Calculated pump price is stored in the existing price field (preserving Rule 2 for the consumer app). Timestamp logic: last_checked always updates; last_updated only updates when the price value actually changes.
- Display: Consumer Fuel Docks app reads the pump price field as it always has (no change needed). Widgets can show pre-tax, post-tax, or both via a visitor toggle, reading from whichever field the configuration specifies.
## 2.3 Hosting and Infrastructure

| Service | Provider | Cost | Purpose |
| --- | --- | --- | --- |
| Backend/API | Xano | Existing plan | All API endpoints, database, background tasks |
| Widget hosting | Cloudflare Pages | $0/month | Static HTML/CSS/JS templates served from global CDN (widgets.fueldocks.app) |
| Marina portal | Cloudflare Pages | $0/month | React SPA for myfueldock.com |
| Consumer marketing site | Cloudflare Pages | $0/month | React + Vite for fueldocks.app (replaces Chariot at $17/month) |
| Email inbound | Mailgun | Existing plan | prices@myfueldock.com route |
| Mobile app | App stores | Existing accounts | Separate My Fuel Dock app (iOS/Android) |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

# 3. Database Design

## 3.1 Changes to FuelPrices Table (table_id 2)

The existing FuelPrices table is the source of truth for all fuel price data. My Fuel Dock reads and writes to this table. The table uses fixed columns for up to 5 fuel grades: two gasoline slots, two diesel slots, and one propane slot. Most marinas use only Gas 1 and Diesel 1. The second slots (Gas 2, Diesel 2) are nullable and only populated when a marina configures a second grade in their Fuel Types settings.

CRITICAL: Add, don't rename. The existing gas_price and diesel_price fields stay exactly as they are. The consumer Fuel Docks app, FD Dialer, both Apify actors, and all background tasks continue to read and write these fields with zero changes. All new fields are additions alongside the existing ones. This makes the My Fuel Dock launch a pure augmentation with no impact on existing systems.

Existing fields (unchanged):

| Field | Status | Notes |
| --- | --- | --- |
| gas_price | UNCHANGED | Pump price for primary gasoline (Gas 1). Consumer app, FD Dialer, Apify all continue reading/writing this field as-is. My Fuel Dock also writes to this field when the marina updates Gas 1 price. |
| diesel_price | UNCHANGED | Pump price for primary diesel (Diesel 1). All existing systems continue using this field. The 9999 sentinel convention stays in place until the consumer app is updated separately. |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

New fields added alongside existing (Gas 1 and Diesel 1 augmentation):

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| gas_price_pretax | decimal, nullable | null | Pre-tax Gas 1 price entered by marina via My Fuel Dock. Null for marinas not using My Fuel Dock. |
| gas1_grade_name | string | 'Regular' | Display name for Gas 1 (e.g., 'Regular 87', 'Mid-grade 89'). |
| gas1_ethanol_free | boolean | false | Whether Gas 1 is ethanol-free. |
| diesel_price_pretax | decimal, nullable | null | Pre-tax Diesel 1 price entered by marina via My Fuel Dock. |
| diesel1_grade_name | string | '#2 Diesel' | Display name for Diesel 1 (e.g., '#2 Diesel', '#1 Diesel'). |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

New fields (Gas 2, Diesel 2, Propane slots):

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| gas2_price | decimal, nullable | null | Pump price for second gasoline grade. Null if marina has only one gas grade. |
| gas2_price_pretax | decimal, nullable | null | Pre-tax price for second gas grade. |
| gas2_grade_name | string, nullable | null | Display name (e.g., 'Ethanol-free 90', 'Premium 93'). Null = not configured. |
| gas2_ethanol_free | boolean | false | Whether second gas grade is ethanol-free. |
| diesel2_price | decimal, nullable | null | Pump price for second diesel grade. Null if marina has only one diesel grade. |
| diesel2_price_pretax | decimal, nullable | null | Pre-tax price for second diesel grade. |
| diesel2_grade_name | string, nullable | null | Display name (e.g., 'Biodiesel B20'). Null = not configured. |
| propane_price | decimal, nullable | null | Pump price for propane per gallon. Null = marina does not sell propane. |
| propane_price_pretax | decimal, nullable | null | Pre-tax propane price entered by marina. |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

Slot logic: Gas 1 uses the existing gas_price field. Diesel 1 uses the existing diesel_price field. A secondary slot (Gas 2, Diesel 2) is 'active' when its grade_name is not null. Propane is active when propane_price is not null. The existing diesel_price = 9999 sentinel convention remains in place for the consumer app and FD Dialer; My Fuel Dock uses the sells_diesel boolean instead.

Fuel type availability toggles (replace 9999 sentinel pattern):

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| sells_gas | boolean | true | Whether this marina sells any gasoline. When false, all gas slots hidden. |
| sells_diesel | boolean | true | Whether this marina sells any diesel. Replaces diesel_price = 9999 sentinel. |
| sells_propane | boolean | false | Whether this marina sells propane. Default false since most marinas do not. |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

Rule 2 preserved: The existing gas_price and diesel_price fields continue to hold the pump price (what the customer pays, tax included). The consumer Fuel Docks app, FD Dialer, and Apify actors read and write these fields with zero changes required. When a My Fuel Dock marina enters a pre-tax price, the system calculates the pump price and writes it to gas_price / diesel_price (the same fields everything else uses). My Fuel Dock endpoints also read the _pretax, grade_name, and ethanol_free fields that the existing systems ignore.

Tax rate fields:

| Field | Type | Notes |
| --- | --- | --- |
| tax_rate_gas | decimal, nullable | Tax rate for gasoline. Applies to all gas grades. Marina-entered. |
| tax_type_gas | enum: per_gallon, percentage, nullable | Whether gas tax is per-gallon amount or percentage. Null = N/A. |
| tax_rate_diesel | decimal, nullable | Tax rate for diesel. Applies to all diesel grades. Marina-entered. |
| tax_type_diesel | enum: per_gallon, percentage, nullable | Whether diesel tax is per-gallon amount or percentage. Null = N/A. |
| tax_rate_propane | decimal, nullable | Tax rate for propane. Marina-entered. |
| tax_type_propane | enum: per_gallon, percentage, nullable | Whether propane tax is per-gallon amount or percentage. Null = N/A. |
| tax_included | boolean, default true | Documents whether stored pump prices include tax. Always true per Rule 2. |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

Fuel availability fields:

| Field | Type | Notes |
| --- | --- | --- |
| fuel_available | boolean, default true | Whether the marina is currently dispensing fuel. When false, widgets show a 'Fuel Unavailable' status. |
| fuel_available_revert_at | timestamp, nullable | When set, a background task automatically sets fuel_available back to true at this date/time. Allows 'closed until Tuesday 8am' with auto-revert. |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

Hours:

| Field | Type | Notes |
| --- | --- | --- |
| hours_json | JSON, nullable | Structured weekly hours: { mon: { open: '08:00', close: '17:00' }, tue: { ... }, ... }. Null = hours not set. Displayed on Dashboard and optionally in widgets. |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

Marina location fields (may already exist on some records from existing Fuel Docks data):

| Field | Type | Notes |
| --- | --- | --- |
| city | string, nullable | Marina city. Editable by marina on Marina Details screen. |
| state | string (2 char), nullable | US state abbreviation. Used for tax rate reference hints during onboarding. |
| latitude | decimal, nullable | Auto-populated via Google Maps Geocoding API when marina enters city/state/address. Marina can confirm or adjust. |
| longitude | decimal, nullable | Auto-populated via Google Maps Geocoding API. Marina can confirm or adjust. |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

Service tier:

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| tier | enum: free, paid | free | Marina's MFD service tier. Determines feature access (widget count, custom colors, update channels, daily price change limits, analytics, etc.). See Section 1.4 for full tier definitions. All marinas default to free. |

## 3.2 New Tables

mfd_users - Marina portal user accounts. Fully separate from any future consumer Fuel Docks app authentication.

| Field | Type | Notes |
| --- | --- | --- |
| id | auto-increment | Primary key |
| marina_id | int (FK to FuelPrices) | Which marina this user belongs to |
| email | string | Login email, unique across mfd_users |
| password | hashed string, nullable | Null if user only uses email-code auth |
| role | enum: admin, staff | Phase 1: one admin per marina. Phase 2: admin can manage staff users. |
| name | string | Display name |
| phone | string, nullable | For future caller ID matching (Phase 2 Twilio) |
| created_at | timestamp | Account creation date |
| last_login | timestamp, nullable | Last successful login |
| is_active | boolean, default true | Soft disable without deleting |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

mfd_daily_updates - Tracks daily price update count per marina for free-tier enforcement.

| Field | Type | Notes |
| --- | --- |
| id | auto-increment | Primary key |
| marina_id | int (FK to FuelPrices) | Which marina |
| update_date | date | Calendar date (marina's local timezone) |
| update_count | int, default 0 | Number of price updates submitted on this date |

The mfd_update_prices endpoint checks this table before processing. For free-tier marinas, if update_count >= 2 for today's date, the update is rejected with a message directing the marina to upgrade. Paid-tier marinas skip this check. Rows older than 7 days are cleaned up by the daily_maintenance task.

mfd_widgets - Widget/price board configuration per marina.

| Field | Type | Notes |
| --- | --- | --- |
| id | auto-increment | Primary key |
| marina_id | int (FK to FuelPrices) | Which marina this widget belongs to |
| template_id | string | Which template to render (e.g., 'compact-horizontal', 'card-standard') |
| config_json | JSON | Template-specific settings: colors, which fields to display, link URL, show/hide marina name, tax toggle, etc. |
| is_active | boolean, default true | Allows disabling a widget without deleting config |
| created_at | timestamp | When widget was first configured |
| updated_at | timestamp | Last config change |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

mfd_analytics - Daily aggregate counts for site visitors and widget views per marina. Simple analytics that gives marinas value without needing Google Analytics.

| Field | Type | Notes |
| --- | --- | --- |
| id | auto-increment | Primary key |
| marina_id | int (FK to FuelPrices) | Which marina's data |
| widget_id | int (FK to mfd_widgets), nullable | Null = site-level visitor count; populated = specific widget view count |
| metric_date | date | Calendar date (UTC) |
| visitor_count | int, default 0 | Unique site visitors for this date (when widget_id is null) or widget load count (when widget_id is populated) |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

The portal displays these as a simple dashboard: 'Your site had X visitors this week' and 'Your price board was viewed Y times this week.' Analytics data is collected for all marinas (free and paid) but only displayed to paid-tier marinas. Free-tier marinas see an upgrade prompt on the Analytics screen. Data continues to accumulate so it is immediately available if the marina upgrades.

mfd_tax_rates - State-level fuel tax reference table.

| Field | Type | Notes |
| --- | --- | --- |
| id | auto-increment | Primary key |
| state_code | string (2 char) | US state abbreviation |
| fuel_type | enum: gas, diesel, propane | Which fuel this rate applies to |
| tax_rate | decimal | Tax amount (e.g., 0.494 for $0.494/gal or 0.08 for 8%) |
| tax_type | enum: per_gallon, percentage | Whether tax is cents-per-gallon or percentage of price |
| effective_date | date | When this rate took effect |
| notes | string, nullable | Source or context for this rate |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

## 3.3 Tax Handling Design

Design principle: Marinas enter the pre-tax price. The system calculates the pump price. This keeps data entry simple for the marina operator (they know their pre-tax price) while preserving Rule 2 for the consumer app (pump price is always stored in the existing price fields).

Tax rates are marina-entered. Each marina sets their own tax rates on the Marina Details screen. The mfd_tax_rates state reference table provides optional hint text during onboarding (e.g., 'Washington state gas tax is typically $0.494/gal') but does not auto-populate. This avoids errors from locality-specific taxes that differ from state defaults. Tax rates support three formats:

- Per gallon: A fixed dollar amount per gallon (e.g., $0.494/gal). Common for state excise taxes.
- Percentage: A percentage of the pre-tax price (e.g., 8.5%). Common for local sales taxes.
- N/A: No tax applies to this fuel type, or the marina does not sell it. Stored as null.
The workflow:

- Step 1: Marina enters their tax rates on the Marina Details screen (per gallon, percentage, or N/A per fuel type).
- Step 2: Marina enters a pre-tax price on the Dashboard (e.g., gas at $4.50).
- Step 3: System calculates pump price using the marina's tax rate(s) and stores both: gas_price_pretax = 4.50, gas_price = 4.99 (or whatever the post-tax amount is). The existing gas_price / diesel_price fields get the pump price, preserving compatibility with all existing systems.
- Step 4: The price board widget can display pre-tax only, post-tax only, or both with a visitor toggle, based on the widget configuration.
## 3.4 Method=MFD

When a marina signs up through My Fuel Dock, their FuelPrices record gets Method set to 'MFD'. This tells the existing Fuel Docks infrastructure:

- Apify skips them: No web scraping needed. The marina is self-maintaining their prices.
- Outbound email skips them: The send_outbound_emails task ignores Method=MFD records.
- Call queue skips them: FD Dialer's call_queue does not surface these marinas.
- Website field is editable: For Method=HTML or Method=Javascript marinas, the website field is used by Apify for scraping. For Method=MFD marinas, the website field is display info and the source URL for widget color auto-detection. The marina can edit it freely on the Marina Details screen.
## 3.5 Migration Plan

Principle: Add, don't rename. The existing gas_price and diesel_price fields are not renamed, not moved, and not restructured. All existing systems (consumer Fuel Docks app, FD Dialer, Apify actors, background tasks) continue working with zero changes. New fields are added alongside.

Phase A (My Fuel Dock launch): Pure augmentation, no impact on existing systems.

- Step 1: Add all new fields to FuelPrices: gas_price_pretax, gas1_grade_name, gas1_ethanol_free, gas2_price, gas2_price_pretax, gas2_grade_name, gas2_ethanol_free, diesel_price_pretax, diesel1_grade_name, diesel2_price, diesel2_price_pretax, diesel2_grade_name, propane_price, propane_price_pretax, sells_gas, sells_diesel, sells_propane, tax_rate/tax_type fields, fuel_available fields, hours_json, city, state, latitude, longitude.
- Step 2: Set default grade names for all existing records: gas1_grade_name = 'Regular', diesel1_grade_name = '#2 Diesel'.
- Step 3: Set sells_gas = true, sells_diesel = true for all existing records. For records where diesel_price = 9999, set sells_diesel = false.
- Step 4: Create new tables: mfd_users, mfd_widgets, mfd_analytics, mfd_tax_rates.
- Step 5: My Fuel Dock endpoints read gas_price / diesel_price for pump prices and read/write the new _pretax, grade, and ethanol fields. When a My Fuel Dock marina updates a price, the system writes to gas_price / diesel_price (pump price) and gas_price_pretax / diesel_price_pretax (pre-tax). All existing systems see the pump price update with no changes needed.
Phase B (future, independent timeline): Optional cleanup of existing systems. Not required for My Fuel Dock launch.

- Consumer app endpoints: Can be updated to use sells_diesel boolean instead of diesel_price != 9999 check. This happens on its own schedule.
- FD Dialer: Can be updated to show grade names. This happens on its own schedule.
- Apify actors: No changes needed. They write to gas_price / diesel_price which is still the correct field.
- 9999 sentinel retirement: Can happen after the consumer app is updated to use sells_diesel. No rush.
# 4. API Endpoints (New)

## 4.1 Widget Data API

| Property | Value |
| --- | --- |
| Endpoint | widget_data |
| Method | GET |
| Auth | None (public, called from browser) |
| Access control | Requires Method=MFD on the FuelPrices record. Non-MFD marinas receive a generic "Marina not found" 404, identical to an invalid ID. Prevents ID enumeration and unauthorized widget use. |
| Cache | 60 seconds |
| Rate limit | 60 requests/minute per IP |
| Input | marina_id (required int), widget_id (optional int) |
| Response fields | marina_name, city, state, hours, hours_json, timezone, sells_gas, sells_diesel, sells_propane, gas_price, gas_price_pretax, gas1_grade_name, gas1_ethanol_free, gas2_price, gas2_price_pretax, gas2_grade_name, gas2_ethanol_free, diesel_price, diesel_price_pretax, diesel1_grade_name, diesel2_price, diesel2_price_pretax, diesel2_grade_name, propane_price, propane_price_pretax, fuel_available, cash_card, vol_discount, open, closure_note, last_updated, tax_rate_gas, tax_type_gas, tax_rate_diesel, tax_type_diesel, tax_rate_propane, tax_type_propane, template_id, config |
| CORS | Allowed from all origins (widgets run on marina websites) |
| Analytics | If widget_id is provided, increments daily view counter in mfd_analytics. |
| Notes | Response field whitelisting applied. No internal fields exposed. When widget_id is provided, looks up mfd_widgets record to get template_id, config_json, and display_name (overrides marina_name if set). |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

## 4.2 Marina Auth Endpoints

Note: These endpoints use the mfd_users table exclusively. They are completely separate from any future Fuel Docks consumer authentication.

| Endpoint | Method | Auth | Purpose |
| --- | --- | --- | --- |
| mfd_register | POST | None | New marina signup: creates marina record (if new) and admin user account |
| mfd_login | POST | None | Email/password login, returns JWT |
| mfd_login_code_request | POST | None | Sends one-time 6-digit code to email |
| mfd_login_code_verify | POST | None | Verifies email code, returns JWT |
| mfd_password_reset_request | POST | None | Sends password reset link to email |
| mfd_password_reset | POST | None | Completes password reset with token |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

## 4.3 Marina Portal Endpoints

| Endpoint | Method | Auth | Purpose |
| --- | --- | --- | --- |
| mfd_update_prices | POST | JWT | Submit pre-tax price(s) from Dashboard. System calculates pump price using tax rates and stores both. Applies validation and differential timestamp logic. Free-tier marinas: checks mfd_daily_updates counter; rejects if >= 2 updates today. Paid-tier marinas: no daily limit. |
| mfd_get_marina | GET | JWT | Get current marina data for display across portal screens |
| mfd_update_account | POST | JWT | Update name, email, password on My Account screen |
| mfd_update_marina_details | POST | JWT (admin) | Update marina name, phone, website, city/state, hours, payment methods, discount info, tax rates on Marina Details screen |
| mfd_geocode | POST | JWT (admin) | Submit city/state or address; returns lat/long via Google Maps Geocoding API for coordinate auto-population |
| mfd_update_fuel_types | POST | JWT (admin) | Configure fuel grades: toggle sells flags, set grade names, ethanol-free flags, enable/disable Gas 2 / Diesel 2 slots |
| mfd_set_fuel_status | POST | JWT | Set fuel_available to true or false with optional revert timestamp |
| mfd_get_analytics | GET | JWT | Get visitor and widget view counts for Analytics screen. Paid tier only; free-tier requests return an upgrade prompt. |
| mfd_widget_config_get | GET | JWT | Get current widget configuration for Widget Setup screen |
| mfd_widget_config_save | POST | JWT (admin) | Save widget template selection and settings |
| mfd_widget_embed_code | GET | JWT | Generate the iframe embed code for the marina's configured widget |
| mfd_detect_colors | POST | JWT (admin) | Submit marina website URL; returns extracted color palette for widget configuration defaults |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

## 4.4 Admin Endpoints (Ken Only)

| Endpoint | Method | Auth | Purpose |
| --- | --- | --- | --- |
| mfd_admin_marina_list | GET | ADMIN_TOKEN | List all marinas with widget status, last update time, user count, analytics summary |
| mfd_admin_marina_detail | GET | ADMIN_TOKEN | Full detail view of any marina including all config and user accounts |
| mfd_admin_activity_report | GET | ADMIN_TOKEN | Summary of which marinas updated prices recently, which are stale, widget view stats |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

## 4.5 Price Update Inbound Endpoint (Email)

| Property | Value |
| --- | --- |
| Endpoint | mfd_mailgun_inbound |
| Method | POST |
| Auth | HMAC-SHA256 Mailgun signature verification |
| Purpose | Receives price update emails sent to prices@myfueldock.com. Paid tier only. |
| Tier check | After identifying the marina, checks tier. Free-tier marinas receive a reply directing them to use the web portal or upgrade. |
| Marina identification | Matches sender email against registered mfd_users email addresses |
| Price parsing | Claude Haiku with $price_context injection (current on-file prices) and validate_claude_output wrapper |
| Pre-tax handling | Parsed prices are treated as pre-tax. System calculates pump price before storage. |
| Success response | Sends confirmation reply with prices as understood (both pre-tax and calculated pump price) |
| Failure response | If parsing fails or marina unrecognized, forwards to Ken for manual handling |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

# 5. Widget / Price Board System

## 5.1 How Widgets Work

Each widget is an iframe embedded on the marina's website. The iframe points to a URL on widgets.fueldocks.app that includes the marina ID and widget config ID. When the iframe loads:

- Step 1: The browser fetches the single widget entry point (/b/index.html) from Cloudflare Pages (fast, globally distributed, 300+ edge locations). A Cloudflare Pages _redirects rule routes /b/{marina_id} to this file.
- Step 2: JavaScript parses the marina ID from the URL path (/b/9999) and the widget config ID from the query parameter (?w=1).
- Step 3: JavaScript calls the widget_data Xano endpoint with those IDs. The endpoint verifies Method=MFD (returns 404 for non-MFD marinas to prevent ID enumeration). This also triggers the analytics counter.
- Step 4: The endpoint returns price data, template_id, and config_json. The entry point renders the correct template using the marina's configured colors and display options. All 4 templates are rendered from a single HTML file.

Access control: The widget_data endpoint only serves data for marinas with Method=MFD. Non-MFD marinas receive a generic "Marina not found" error identical to an invalid ID, preventing bots from enumerating the database or unauthorized marinas from using the widget.
Example embed code:

<iframe src="https://widgets.fueldocks.app/b/17?w=42&phone=3605551234" width="320" height="180" frameborder="0" title="Fuel Prices"></iframe>

In this example: /b/ = price board, 17 = marina ID, w=42 = widget config ID (loads template and settings from mfd_widgets table), phone=3605551234 = fallback phone number displayed if widget can't load (see Section 5.7).

## 5.2 Template Lineup (Phase 1)

| Template | Dimensions | Content | Best For |
| --- | --- | --- | --- |
| compact-horizontal | 320 x 80px | Prices in a tight horizontal row with fuel type dots, grade names, and Updated timestamp. No hours or extras. | Sidebars, narrow spaces, header/footer bars |
| card-standard | 320 x 200px | Fuel Prices header with Updated timestamp. Vertical price list with grade names, ethanol-free badges. Hours at bottom. | Main content areas, dedicated fuel info section. The default template. |
| card-detailed | 400 x 280px | All fuel prices with inline pre-tax amounts. Info grid: hours, payment methods, discount, fuel status. Visitor tax toggle at bottom. | Marinas wanting to show everything |
| banner-wide | 600 x 100px | Fuel Prices label with Updated timestamp on left. All fuel prices in horizontal row center. Hours on right. | Full-width sections, hero areas |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

All templates are responsive within their container. If the iframe is sized smaller than the template's default, content reflows gracefully. All templates support light and dark base themes, overridden by marina-specific color configuration. Fuel types with their toggle set to off are automatically hidden from the widget display.

## 5.3 Widget Branding

Every widget displays a 'Powered by myfueldock.com' link at the bottom in small blue text. This serves as lead generation: marina operators at other docks see the price board, click the link, and land on the My Fuel Dock landing page. This is the same viral growth pattern used by Intercom, Calendly, Typeform, and similar embedded products.

- Placement: Bottom of every widget template, centered, below all other content.
- Style: Small text (8-9px), blue color to indicate it's a link. Does not interfere with the marina's price data.
- Behavior: Clicking opens myfueldock.com in a new tab (_blank target).
- Free and Paid tiers: Present on all widgets, not removable in either tier.
- Phase 2: White-labeling (removal of the Powered By link) may become a future premium add-on.
Powered by link: Every widget template displays a small "Powered by myfueldock.com" text at the bottom. Blue color to indicate a hyperlink. Opens myfueldock.com in a new tab. This serves as lead generation: marina operators at other docks who see the widget on a competitor's site can discover My Fuel Dock and sign up. The link is present on all widgets in both free and paid tiers. White-label removal may be offered as a future premium add-on.

## 5.4 Widget Configuration Options

Stored in mfd_widgets.config_json. The marina admin configures these through the portal:

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| template_id | string | card-standard | Which template to use |
| show_gas | boolean | true | Show gasoline price (only if sells_gas = true) |
| show_diesel | boolean | true | Show diesel price (only if sells_diesel = true) |
| show_propane | boolean | false | Show propane price (only if sells_propane = true) |
| show_hours | boolean | false | Show operating hours |
| show_discount | boolean | false | Show discount information |
| show_payment | boolean | false | Show accepted payment methods |
| show_marina_name | boolean | false | Show marina name in widget |
| show_tax_toggle | boolean | false | Let visitor toggle between pre-tax and post-tax view |
| show_timestamp | boolean | true | Show 'last updated' timestamp |
| primary_color | hex string | auto-detected | Primary accent color (buttons, headers). Default from color auto-detection. Paid tier only; free tier uses default theme colors. |
| background_color | hex string | auto-detected | Widget background color. Default from color auto-detection. Paid tier only; free tier uses default theme colors. |
| text_color | hex string | auto-detected | Primary text color. Default from color auto-detection. Paid tier only; free tier uses default theme colors. |
| link_url | string, nullable | null | Where widget links to when clicked (marina's choice) |
| link_target | enum: _blank, _parent | _blank | Open link in new tab or same tab |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

## 5.5 Color Auto-Detection

During widget setup, when a marina enters their website URL, the portal calls the mfd_detect_colors endpoint. This endpoint fetches the page and extracts dominant colors from the CSS (background colors, text colors, accent/link colors). The extracted palette is presented as defaults in the color configuration, giving the marina a widget that matches their site out of the box. The marina can override any color manually.

Implementation: a Xano endpoint that fetches the HTML, parses CSS custom properties (variables), background-color declarations, prominent color values from stylesheets and inline styles. Returns a suggested palette of 3 colors (primary, background, text). No external API dependency required. Falls back to light theme defaults if extraction fails or if no URL is provided.

## 5.6 Widget Hosting (Cloudflare Pages)

Widget template files are hosted on Cloudflare Pages under the widgets.fueldocks.app subdomain:

- Cost: $0/month. Free tier includes unlimited bandwidth and unlimited requests for static assets.
- Performance: Served from 300+ global edge locations. Sub-50ms load times for the template shell in most regions.
- Deployment: Connected to a GitHub repository. Push template changes to main branch and they deploy automatically.
- No server-side code: All templates are pure static files. The JavaScript runs in the visitor's browser and calls the Xano API directly.

## 5.7 Widget Fallback (Phone Number)

When the widget cannot load (API error, network issue, invalid marina ID), instead of showing a blank space or generic error, the widget displays a fallback card with the marina's phone number. This ensures website visitors can always reach the marina for fuel pricing information, even if the widget is temporarily unavailable.

Implementation:

- The embed code URL includes a `&phone=` parameter containing the marina's phone number as digits (e.g., `&phone=3605551234`).
- `api.js` exports a `getFallbackPhone()` function that parses this parameter and auto-formats it for display (e.g., `(360) 555-1234`).
- `widget.html` has a `renderFallback()` function that checks for the phone parameter. If present, it renders a styled card with a ⛽ icon, "Call for current fuel prices" text, and a clickable `tel:` link. If no phone is provided, it falls back to a simple text error message.
- The fallback card includes the "Powered by myfueldock.com" link at the bottom, consistent with all other templates.
- Styles are defined in `styles.css` under the `.widget-fallback` class family.

Embed code generation:

- The Widget Setup page (`WidgetSetup.tsx`) automatically injects the marina's phone number from their profile (`marina.phone`) into the embed code URL via an `injectPhone()` helper function.
- Webmasters can change the phone number directly in the embed code if needed (e.g., to use a fuel dock direct line instead of the main marina number).

The Webmasters page (`/webmasters`) documents the `PHONE` placeholder in embed code examples and explains the fallback behavior in the FAQ.

# 6. Marina Portal (myfueldock.com)

## 6.1 Hosting and Tech Stack

The marina portal is a React SPA (single-page application) built with React + Vite + Shadcn/UI component library, hosted on Cloudflare Pages. All backend logic is handled by Xano. The portal makes API calls directly to Xano endpoints from the browser. Hosting cost: $0/month.

The same tech stack (React + Vite + Shadcn/UI on Cloudflare Pages) will also be used to rebuild the consumer fueldocks.app marketing site, replacing Chariot ($17/month) with free hosting. Both sites auto-deploy from GitHub repositories.

## 6.2 Authentication

Marina operators have two authentication options:

- Email + password: Traditional login. Password stored as bcrypt hash in Xano.
- Email code: Passwordless login. User enters email, receives a 6-digit code via Mailgun, enters code to authenticate. Code expires after 10 minutes. Maximum 3 attempts per code.
Both methods return a JWT for session management. JWT expiration: 7 days (marina operators should not need to log in frequently).

Outbound emails (registration confirmation, password reset, email codes) use the navigatorpnw.com sending domain via MAILGUN_KEY_NAVIGATOR, consistent with existing marina outbound email patterns. SPF/DKIM/DMARC are already configured.

Phase 1: One admin account per marina. The data model supports multiple users with admin/staff roles, but the UI for managing additional users is deferred to Phase 2.

## 6.3 Interaction Pattern: View Mode vs. Edit Mode

Design principle: Price updates should be fast and frictionless. Settings changes should require intentional action to prevent accidental modifications.

The portal uses two distinct interaction patterns depending on the screen:

- Direct action screens (Dashboard): The price update form is immediately editable. No unlock step required. This is the screen operators use most frequently, often from a phone while standing at the fuel dock. Speed matters.
- Settings screens (My account, Marina details, Fuel dock status, Fuel types, Widget setup): These load in read-only view mode, displaying current values but with all fields locked. An "Edit" button at the top of the screen unlocks the fields. After making changes, the operator clicks "Save" to commit or "Cancel" to discard and return to view mode.
Additional guard for destructive changes: On the Fuel Types screen, toggling a fuel type off (e.g., turning off sells_gas) triggers a confirmation dialog after clicking Save: "Turning off gasoline will hide it from your price board. Are you sure?" This is a two-step guard: click Edit to unlock the toggles, then confirm the destructive change on Save.

This same view/edit pattern applies to the equivalent screens in the My Fuel Dock mobile app.

## 6.4 Sidebar Navigation

The portal uses a fixed left sidebar with three sections:

| Section | Nav Item | Description |
| --- | --- | --- |
| Prices | Dashboard | Price cards, quick-update form, hours, widget status. The single home for all price activity. |
| Settings | My account | Login credentials (name, email, password), role badge. Phase 2: team members. |
| Settings | Marina details | Marina name, phone, website, city/state, coordinates, hours, payment methods, discounts, tax rates. |
| Settings | Fuel dock status | Fuel available/unavailable toggle with scheduled auto-revert. |
| Settings | Fuel types | Fuel grade configuration: grade names, ethanol-free flags, sells toggles, Gas 2 / Diesel 2 slots. |
| Settings | Widget setup | Template selection, display options, colors (with auto-detection), link config, live preview, embed code. |
| Analytics | Analytics | Site visitor counts and widget view counts, 7-day and 30-day, with 30-day bar chart. |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

## 6.5 Portal Screens

| Screen | Page Title | Mode | Description |
| --- | --- | --- | --- |
| Dashboard | Dashboard | Direct action | Price cards for each active fuel grade (pump price, pre-tax badge, tax). Quick-update form with one input per grade. Fuel dock status pill. Last updated timestamp. Marina hours panel with edit link to Marina details. Widget status bar with link to Widget setup. |
| My account | My account | View / Edit | Name, email, password (masked), role badge. Phase 2: team members placeholder. Log out button. |
| Marina details | Marina details | View / Edit | Marina name, phone, website (editable for Method=MFD), city/state, coordinates (auto-populated via Google Maps). Hours of operation. Accepted payment methods. Discount info. Tax rates (per gallon, percentage, or N/A per fuel type). |
| Fuel dock status | Fuel dock status | View / Edit | Current status with large visual indicator. Scheduled revert section. Educational 'what happens' panel explaining impact on price board widget. |
| Fuel types | Fuel types | View / Edit + Confirm | Gasoline, diesel, propane sections. Each shows selling/not selling badge, Grade 1 (primary), Grade 2 (optional). Grade names, ethanol-free flags, current pump prices for reference. Confirmation dialog on disabling a fuel type. |
| Widget setup | Widget setup | View / Edit | Template selection with thumbnail. Display options grid (toggles for each data field). Color swatches (auto-detected from website URL). Link configuration. Live widget preview. Embed code with copy button. |
| Analytics | Analytics | View only | Paid tier: Four metric cards (visitors 7-day, visitors 30-day, views 7-day, views 30-day). 30-day bar chart showing both metrics. Data retained 90 days. Free tier: Shows upgrade prompt with preview of what analytics are available. |
| Admin dashboard | Admin dashboard | View only | Ken only. All-marina overview, activity monitoring, stale data alerts, analytics across all marinas. |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

## 6.6 UI Design Decisions

Established during wireframing. These patterns apply across the portal and mobile app:

| Element | Design | Notes |
| --- | --- | --- |
| Primary action buttons | Navigator red (#E33500), white text | Used for Save Prices and other primary submit actions |
| Sidebar active state | Navigator blue (#070531) left border | 3px left border on active nav item |
| Sidebar brand | Plain text 'My Fuel Dock', no color accent | Clean, simple, no split-color styling |
| Sidebar structure | 3 sections: Prices, Settings, Analytics | 6 nav items total. Dashboard is the only item under Prices. |
| Price cards | Pump price large (26px), pre-tax in colored badge with white text, tax muted below on its own line | One card per active fuel grade. Color-coded by fuel type. |
| Fuel type colors | Gas = #000000 (black), Diesel = #1D9E75 (green), Propane = #378ADD (blue) | Matches widget colors for consistency. Used for dot indicators, pre-tax badges, and card accents |
| Quick update form | Input fields align in grid matching price cards above. No helper text under fields. | Save button on its own row, right-aligned, Navigator red |
| Hours panel | Weekly grid on Dashboard, read-only with Edit link to Marina details | Today's day bolded. Edit link navigates to Marina details in edit mode. |
| Analytics on Dashboard | Removed. Analytics has its own dedicated screen. | Dashboard stays focused on prices and hours. |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

## 6.7 Public Pages (Pre-Login)

Four pages are accessible without authentication:

| Page | URL Path | Description |
| --- | --- | --- |
| Landing page | / | Hero with headline ('A free fuel price board for your marina's website'), CTA button, browser-frame mockup with auto-rotating widget carousel showing all 4 templates on Westmark Marina's website (westmarkmarina.com — demo marina, id=9999), update channels section (web portal, mobile app, email, text), 4 value props, 3-step 'how it works' with #1/#2/#3 numbered circles, final CTA. Footer with Privacy Policy, Terms of Service, Contact, For Webmasters links. |
| Register | /register | Two-section form: Your Info (name, email, password) and Your Marina (marina name, city, state dropdown, optional website URL with hint about color auto-detection). Single 'Create account' button. Terms/privacy consent note. Link to login. |
| Login | /login | Email + password form with 'Forgot password?' link. Primary 'Log in' button. 'Or' divider with 'Send me a login code instead' button for email-code auth. Link to registration. |
| For Webmasters | /webmasters | Complete installation guide for web developers. 3-step getting started (account, configure, embed). Technical reference (how iframe works, responsive wrapper, sizing table for free widgets). Platform-specific embed instructions for WordPress, Squarespace, Wix, GoDaddy, Shopify, Weebly, Drupal, and raw HTML. How the marina updates prices (4 channels). FAQ (performance, mobile, update speed, styling, phone fallback). Printable via Ctrl+P. |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

## 6.8 Admin Dashboard (Ken Only)

The admin dashboard is a separate view with its own sidebar navigation: Overview, All marinas, Analytics. It is accessible only to Ken via ADMIN_TOKEN authentication.

Overview screen: Four metric cards across the top (total marinas, active widgets, stale prices in warning color, total widget views 30-day). Alerts feed showing stale price warnings and new signups/go-lives. Marina table with columns: marina name, location, widget status badge (Live, Not set up, New), last update time (stale highlighted in warning color), 30-day widget views, View link to drill into detail.

All marinas screen: Full sortable/filterable table of every Method=MFD marina. Click any row to see the full detail view (everything the marina operator sees, read-only).

Analytics screen: Aggregated analytics across all marinas. Total visitors, total widget views, top marinas by views, marinas with zero views (widget installed but not getting traffic).

# 7. My Fuel Dock Mobile App

A separate React Native/Expo app branded as My Fuel Dock. Available on iOS and Android via the App Store and Google Play. Provides the same core functionality as the portal in a mobile-optimized interface. Ideal for dock attendants updating prices from the fuel dock itself.

## 7.1 App Screens

The mobile app follows the same view mode / edit mode interaction pattern as the portal: Dashboard is direct action (always editable), settings screens load in read-only view mode with an Edit button to unlock.

| Screen | Mode | Description |
| --- | --- | --- |
| Login | Direct action | Email/password or email code login. Same auth endpoints as portal. |
| Dashboard | Direct action | Price cards per active fuel grade, fuel dock status, last updated. Quick-update price form (always editable). Hours display. |
| My account | View / Edit | Name, email, password. Tap Edit to unlock. Log out. |
| Marina details | View / Edit | Marina details, hours, payment methods, discounts, tax rates. Tap Edit to unlock. |
| Fuel dock status | View / Edit | Toggle fuel available/unavailable. Set revert time. Tap Edit to unlock. |
| Fuel types | View / Edit + Confirm | Fuel grade configuration. Tap Edit to unlock. Confirmation on disabling fuel types. |
| Analytics | View only | Simple visitor and widget view counts. |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

## 7.2 Technical Details

- Framework: React Native with Expo (same stack as the consumer Fuel Docks app).
- API: Uses the same Xano endpoints as the portal. Shared JWT authentication against mfd_users.
- Distribution: Published to App Store and Google Play under the My Fuel Dock name. Uses existing Apple Developer and Google Play Developer accounts.
- Branding: Distinct from the consumer Fuel Docks app. Separate app icon, name, and store listing.
# 8. Email Price Update Channel

Marina operators can email prices@myfueldock.com with their new prices in any natural format. Mailgun receives the inbound email and routes it to the mfd_mailgun_inbound Xano endpoint.

## 8.1 Processing Flow

- Step 1: Mailgun receives email at prices@myfueldock.com and sends webhook to mfd_mailgun_inbound.
- Step 2: HMAC-SHA256 signature verification (existing Mailgun pattern).
- Step 3: Identify the marina by matching the sender's email address against registered mfd_users emails.
- Step 4: Inject current on-file prices as $price_context (existing pattern from Fuel Docks mailgun_inbound).
- Step 5: Pass the email body to Claude Haiku for parsing via the validate_claude_output wrapper.
- Step 6: Parsed prices are treated as pre-tax. System looks up tax rates and calculates pump prices.
- Step 7: If validation passes, update FuelPrices table (both pretax and pump price fields).
- Step 8: Send confirmation reply showing: 'We received your update: Gas $4.50 pre-tax ($4.99 at the pump), Diesel $5.10 pre-tax ($5.65 at the pump).'
- Step 9: Non-price detection. Claude Haiku also returns a non_price_requests field. If the email mentions any non-price changes (hours, status, availability, etc.), the confirmation reply includes a NOTE section (set off with asterisk lines) directing the user to visit myfueldock.com or use the My Fuel Dock app for those changes. Prices in mixed emails are still processed normally.
- Failure path: If parsing fails or marina is unrecognized, forward to Ken for manual handling.
## 8.2 Mailgun Configuration

- Inbound domain: prices@myfueldock.com (requires MX record setup on myfueldock.com domain)
- Webhook URL: Points to mfd_mailgun_inbound Xano endpoint
- Alias forwarding: Mailgun regex route forwards common address variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com → prices@myfueldock.com. Single route with match_recipient regex, forward action + stop.
- Sending domain: Confirmation replies sent from prices@myfueldock.com via myfueldock.com sending domain
# 9. Security

| ID | Measure | Description |
| --- | --- | --- |
| MFD-S1 | JWT authentication | All portal and app endpoints require valid JWT. 7-day expiration. Issued on login only. |
| MFD-S2 | Role-based access | Admin vs. staff roles on mfd_users. Phase 1: admin only. Phase 2: staff can update prices, admin can configure widgets and manage users. |
| MFD-S3 | Marina scoping | Every authenticated request is scoped to the user's marina_id. A user cannot access or modify another marina's data. |
| MFD-S4 | Widget data whitelisting | widget_data endpoint returns only display-safe fields. No internal IDs, contact info, or operational fields exposed. |
| MFD-S4a | Widget Method gate | widget_data endpoint requires Method=MFD on the FuelPrices record. Non-MFD marinas get a generic "Marina not found" 404 identical to invalid IDs, preventing database enumeration and unauthorized widget use. |
| MFD-S5 | CORS configuration | widget_data allows all origins (necessary for iframe embedding). Portal endpoints restrict to myfueldock.com origin. |
| MFD-S6 | Rate limiting | widget_data: 60 req/min per IP. Auth endpoints: 10 req/min per IP. Price update endpoints: 30 req/min per JWT. |
| MFD-S7 | AI output validation | All Claude Haiku parsed inputs (email) pass through validate_claude_output. Price range checks, spike detection, HTML sanitization. |
| MFD-S8 | HMAC signature verification | Mailgun inbound uses HMAC-SHA256 signature verification (existing pattern). |
| MFD-S9 | Email code security | 6-digit codes expire after 10 minutes. Max 3 verification attempts per code. New code invalidates previous. |
| MFD-S10 | Password security | Bcrypt hashing. Minimum 8 characters. |
| MFD-S11 | Auth isolation | mfd_users table is completely separate from any future consumer app auth. No shared tokens, sessions, or user records. |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

# 10. Background Tasks

| Task | Schedule | Purpose |
| --- | --- | --- |
| fuel_available_revert | Every 15 minutes | Checks FuelPrices for marinas where fuel_available is set and fuel_available_revert_at has passed. Clears both fields to restore normal availability. IMPLEMENTED: Xano task id=12, runs every 900s. |
| mfd_stale_price_alert | Daily 9:00 AM Pacific (weekdays) | Emails Ken about MFD marinas exceeding their price_reminder_days threshold (per-marina configurable, default 14, 0=disabled). Sends from alerts@myfueldock.com. IMPLEMENTED: Xano task id=10. |
| daily_maintenance | Daily 11:59 PM Pacific | Merged task: (1) CSV backup of FuelPrices table to Xano file storage, (2) deletes mfd_analytics records older than 90 days, (3) deletes mfd_daily_updates records older than 7 days. Renamed from daily_csv_backup. IMPLEMENTED: Xano task id=5. |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

# 11. Phase 1 Scope and Priorities

## 11.1 In Scope (Phase 1)

- Widget/price board system: 4 templates, Cloudflare Pages hosting, widget_data API endpoint
- Marina portal (React SPA on Cloudflare Pages): 7 authenticated screens (Dashboard, My account, Marina details, Fuel dock status, Fuel types, Widget setup, Analytics), 3 public pages (landing page, register, login), plus admin dashboard for Ken
- My Fuel Dock mobile app (React Native/Expo, iOS and Android) mirroring portal functionality
- Price update via Dashboard (web form) and mobile app
- Price update via email (prices@myfueldock.com, Mailgun inbound)
- Database schema: new tables (mfd_users, mfd_widgets, mfd_analytics, mfd_tax_rates) and new fields on FuelPrices
- 5-slot fuel grade structure (Gas 1, Gas 2, Diesel 1, Diesel 2, Propane) added alongside existing gas_price/diesel_price fields. Grade names and ethanol-free flag per gas grade.
- Fuel type toggles (sells_gas, sells_diesel, sells_propane) added as new fields. Existing 9999 sentinel convention untouched until consumer app is updated separately.
- Tax handling: marina-entered rates (per gallon, percentage, or N/A per fuel type), marina enters pre-tax, system calculates pump price
- Method=MFD: self-maintaining marinas skip Apify scraping, outbound emails, and call queue
- Fuel dock status (available/unavailable) with scheduled auto-revert
- Structured marina hours (hours_json) with Dashboard display panel and edit link to Marina details
- Marina location: city, state, lat/long with Google Maps geocoding
- Widget color auto-detection from marina website URL
- Domain setup: myfueldock.com portal, widgets.fueldocks.app widget hosting
- Rebuild fueldocks.app consumer marketing site on Cloudflare Pages (replacing Chariot, saves $17/month)
- Simple analytics: site visitor counts and widget view counts per marina with 30-day bar chart
## 11.2 Deferred to Phase 2

- Twilio phone update channel (shared number with PIN or caller ID)
- Multi-user accounts per marina (admin manages staff users via portal UI)
- White-label widget option (removal of 'Powered by' link as premium add-on)
- Advanced analytics (conversion tracking, comparison data)
- Text message (SMS) price update channel

Note: Several features previously listed here as "Phase 2 premium" have been moved into the Phase 1 paid tier. See Section 1.4 for the complete free vs. paid feature breakdown. Custom widget colors, multiple widgets, email/mobile app update channels, hours management, price reminders, and basic analytics are now part of the paid tier within Phase 1.
## 11.3 Deferred to Phase 3

- Data licensing API for third parties (Marinas.com, Navionics, etc.)
- Dedicated Twilio phone numbers per marina
- National expansion infrastructure changes
- Canada (PIPEDA) compliance for privacy policy / TOS
# 12. Implementation Plan

The implementation follows a dependency-driven order: database and domains first (foundation), then API endpoints (everything depends on these), then the portal and widgets (consumer-facing), then additional channels and apps.

## 12.1 Step 1: Foundation (Database + Domains + Scaffolding)

Goal: All infrastructure in place so everything else can build on top of it.

| Task | Details | Dependencies |
| --- | --- | --- |
| Add new fields to FuelPrices | Pure augmentation: gas_price_pretax, gas1_grade_name, gas1_ethanol_free, gas2_*, diesel_price_pretax, diesel1_grade_name, diesel2_*, propane_*, sells_* toggles, tax_rate/tax_type fields, fuel_available fields, hours_json, city, state, lat, long. Existing gas_price and diesel_price fields unchanged. Set default grade names and sells_* booleans on existing records. No impact on consumer app, FD Dialer, or Apify actors. | None |
| Create new Xano tables | mfd_users, mfd_widgets, mfd_analytics, mfd_tax_rates. Schema per Section 3.2. | None |
| Set up Cloudflare Pages account | Create three sites: myfueldock.com (portal), widgets.fueldocks.app (widget hosting), fueldocks.app (marketing site). Connect GitHub repositories. Configure custom domains. | None |
| Configure myfueldock.com DNS | Point domain to Cloudflare Pages. Set up MX records for Mailgun inbound (prices@myfueldock.com). | Cloudflare account |
| Scaffold React + Vite + Shadcn/UI project | Initialize portal project. Set up routing, auth context, API client utility for Xano calls. Push to GitHub. Verify auto-deploy to Cloudflare Pages. | Cloudflare Pages |
| Scaffold widget template project | Initialize HTML/CSS/JS project for widget templates. Push to GitHub. Verify auto-deploy to widgets.fueldocks.app. | Cloudflare Pages |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

## 12.2 Step 2: Core API Endpoints

Goal: All Xano endpoints built and tested so the portal and widgets can call them.

| Task | Details | Dependencies |
| --- | --- | --- |
| Auth endpoints | mfd_register, mfd_login, mfd_login_code_request, mfd_login_code_verify, mfd_password_reset_request, mfd_password_reset. JWT issuance. Bcrypt password hashing. Email code via Mailgun. | mfd_users table |
| Marina data endpoints | mfd_get_marina, mfd_update_account, mfd_update_marina_details, mfd_geocode (Google Maps integration), mfd_update_fuel_types, mfd_set_fuel_status. | FuelPrices fields, mfd_users table |
| Price update endpoint | mfd_update_prices. Accepts pre-tax prices, looks up tax rates, calculates pump prices, stores both. Differential timestamp logic (last_checked vs last_updated). validate_claude_output wrapper for range/spike checks. | FuelPrices fields, tax_rate fields |
| Widget endpoints | widget_data (public, cached, rate-limited, CORS open). mfd_widget_config_get, mfd_widget_config_save, mfd_widget_embed_code, mfd_detect_colors. | mfd_widgets table, FuelPrices fields |
| Analytics endpoint | mfd_get_analytics. Read from mfd_analytics table. Return 7-day and 30-day aggregates. | mfd_analytics table |
| Admin endpoints | mfd_admin_marina_list, mfd_admin_marina_detail, mfd_admin_activity_report. ADMIN_TOKEN auth. | All tables |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

## 12.3 Step 3: Portal (Screen by Screen)

Goal: Fully functional marina portal at myfueldock.com. Build in this order (each screen is usable as soon as it's done):

| Order | Screen | Rationale |
| --- | --- | --- |
| 3a | Landing page, Register, Login | Marinas need to be able to sign up before anything else works. Landing page is the front door. |
| 3b | Dashboard | The most-used screen. Once a marina can sign up and update prices, the core value proposition works. |
| 3c | Marina details | Second priority: marina fills in their info, hours, payment methods, tax rates. |
| 3d | Fuel types | Configure fuel grades. Needed before the widget can display correctly. |
| 3e | Widget setup | The payoff: marina picks a template, configures colors, gets embed code. Price board goes live on their site. |
| 3f | Fuel dock status | Less urgent but important: ability to mark fuel as unavailable with auto-revert. |
| 3g | My account | Account management. Lowest priority since it's set-and-forget. |
| 3h | Analytics | Can be built after widgets are live and generating view data. |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

## 12.4 Step 4: Widget Templates

Goal: All 4 templates live on widgets.fueldocks.app, pulling data from the widget_data API.

| Order | Template | Rationale |
| --- | --- | --- |
| 4a | card-standard | The default template. Build this first so the Widget Setup screen has something to preview. |
| 4b | compact-horizontal | Second most likely choice. Small and simple to implement. |
| 4c | banner-wide | Different layout pattern (horizontal). Third priority. |
| 4d | card-detailed | Most complex template (tax toggle, info grid). Build last. |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

## 12.5 Step 5: Email Channel

Goal: Marinas can email prices@myfueldock.com to update their prices.

| Task | Details | Dependencies |
| --- | --- | --- |
| Mailgun inbound route | Configure MX records on myfueldock.com. Create Mailgun route for prices@myfueldock.com pointing to mfd_mailgun_inbound endpoint. | myfueldock.com DNS |
| mfd_mailgun_inbound endpoint | HMAC-SHA256 signature verification. Sender email lookup against mfd_users. Claude Haiku parsing with $price_context injection and validate_claude_output wrapper. Pre-tax to pump price calculation. Confirmation reply email. | Auth endpoints, price update endpoint, Mailgun config |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

## 12.6 Step 6: Mobile App

Goal: My Fuel Dock app on iOS and Android.

| Task | Details | Dependencies |
| --- | --- | --- |
| Scaffold Expo project | New React Native/Expo project, separate from consumer Fuel Docks app. My Fuel Dock branding, app icon, store listing. | None |
| Build screens | Same screens as portal (Dashboard, My account, Marina details, Fuel dock status, Fuel types, Analytics). Same API endpoints. Same view/edit mode pattern. No Widget Setup screen (not needed on mobile). | All API endpoints |
| EAS build + submit | Build for iOS and Android via EAS. Submit to App Store and Google Play. | Screens complete |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

## 12.7 Step 7: Admin Dashboard

Goal: Ken's command center for monitoring all My Fuel Dock marinas.

Build as a separate section of the portal, accessible via ADMIN_TOKEN. Overview screen with metric cards, alerts feed, and marina table. All marinas list with full detail drill-through. Aggregated analytics. Can be built in parallel with Steps 5 and 6 since it uses the same API endpoints.

## 12.8 Step 8: fueldocks.app Rebuild

Goal: Migrate the consumer marketing site from Chariot ($17/month) to Cloudflare Pages ($0/month). Same React + Vite + Shadcn/UI stack as the portal.

This is the lowest priority item. It can happen any time after the portal is live and the patterns are established. The site is mostly static content: landing page, features, app store download links, Privacy Policy, Terms of Service, contact/about page. Cancel Chariot subscription once migration is verified.

## 12.9 Estimated Build Order Summary

| Step | What | Estimated Effort |
| --- | --- | --- |
| 1 | Foundation (database, domains, scaffolding) | 1 week |
| 2 | Core API endpoints (auth, data, prices, widgets, analytics) | 1-2 weeks |
| 3 | Portal (8 screens, landing page, register, login) | 2-3 weeks |
| 4 | Widget templates (4 templates on Cloudflare Pages) | 1 week |
| 5 | Email channel (Mailgun inbound + Claude parsing) | 2-3 days |
| 6 | Mobile app (Expo, mirrors portal) | 1-2 weeks |
| 7 | Admin dashboard (Ken's view) | 3-5 days |
| 8 | fueldocks.app rebuild (marketing site off Chariot) | 2-3 days |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

Total estimated timeline: 7-10 weeks working step by step. Steps 5, 6, 7, and 8 can overlap. The portal is usable after Step 3 (marinas can sign up, update prices, and configure widgets). Widgets go live on marina websites after Step 4.

# 13. Open Questions

| # | Question | Status |
| --- | --- | --- |
| 1 | What validation is needed for new marina self-registration? (Verify they are a real marina?) | Pending decision |
| 2 | Should the Widget Configurator / preview be part of the portal only, or also a separate public page Ken uses during sales outreach? | Pending decision |
| 3 | Marine fuel tax data source: manual entry per state, or is there a reliable API/dataset? | Needs research |
| 4 | RESOLVED: MX records added to Cloudflare DNS for myfueldock.com (mxa/mxb.mailgun.org). SPF, DKIM, CNAME tracking all verified. Mailgun route forwards prices@myfueldock.com to Xano mfd_email_inbound endpoint. | RESOLVED (v1.10) |
| 5 | Consumer Fuel Docks app endpoint changes needed for sells_gas/sells_diesel/sells_propane toggle migration? | Needs scoping |
| 6 | RESOLVED: From “My Fuel Dock <prices@myfueldock.com>”. Replies go back to prices@myfueldock.com which re-enters the inbound pipeline. | RESOLVED (v1.10) |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

# 14. Glossary

| Term | Definition |
| --- | --- |
| Price board | The marina-facing name for an embeddable widget. A digital fuel price sign for a marina's website. |
| Widget | The developer/technical term for a price board. Used in code, database fields, and API names. |
| Pump price | The price a customer actually pays at the fuel dock, including all taxes. This is what we always store in the _price fields (Rule 2). |
| Pre-tax price | The price before state/local fuel taxes. What the marina operator enters in My Fuel Dock. Stored in _pretax fields. |
| Fuel grade | A specific product within a fuel type (e.g., Regular 87, Premium 93, Ethanol-free 90 are all gasoline grades). Each marina can have up to 2 gas grades and 2 diesel grades. |
| Fuel slot | One of 5 fixed column groups in FuelPrices: Gas 1 (existing gas_price field), Gas 2 (new, optional), Diesel 1 (existing diesel_price field), Diesel 2 (new, optional), Propane (new, optional). Gas 1 and Diesel 1 use the original field names for backward compatibility. |
| Ethanol-free | Gasoline without ethanol. Important for marine engines as ethanol can cause damage. Flagged per fuel grade and optionally displayed in widgets. |
| Rule 2 | Fuel Docks data integrity rule: always store the pump price the customer pays. Never calculate tax and present a number as the pump price that the customer won't actually see. |
| Sentinel value (legacy) | Previously: diesel_price = 9999 meant gas-only marina. Replaced by sells_diesel = false boolean toggle. |
| Method=MFD | A value for the Method field on FuelPrices indicating the marina is self-maintaining through My Fuel Dock. Apify scraping, outbound price-check emails, and the call queue all skip these records. |
| Fuel Docks | The consumer-facing app and brand (fueldocks.app). |
| My Fuel Dock | The marina-facing portal, mobile app, and service (myfueldock.com). |
| FD Dialer | The internal Adalo app used by Ken for manual phone-based price collection. Separate from My Fuel Dock. |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |

# Version History

| Version | Date | Author | Changes |
| --- | --- | --- | --- |
| 1.0 | March 15, 2026 | Ken / Claude | Initial Phase 1 system design document |
| 1.1 | March 15, 2026 | Ken / Claude | Auth isolation explicit. Tax handling: Option A (marina enters pre-tax, system calculates pump price). Fuel type boolean toggles replace 9999 sentinel. Analytics (visitors + widget views) moved to Phase 1. Mobile app moved to Phase 1. Color auto-detection moved to Phase 1. Phone channel confirmed Phase 2. Portal hosting confirmed as Cloudflare Pages React SPA. Propane support added. |
| 1.2 | March 15, 2026 | Ken / Claude | Removed my.fueldock.app and my.fueldocks.app subdomains (myfueldock.com is sole portal domain). Tech stack confirmed: React + Vite + Shadcn/UI. Added fueldocks.app marketing site rebuild to Phase 1 (replacing Chariot at $17/month). Three Cloudflare Pages sites: myfueldock.com, widgets.fueldocks.app, fueldocks.app. |
| 1.3 | March 15, 2026 | Ken / Claude | Added view mode / edit mode UX interaction pattern. Price screens (Dashboard, Update Prices) are direct action with no guards. Settings screens (Marina Info, Fuel Types, Fuel Status, Widget Setup, Account Settings) load read-only with Edit button to unlock. Fuel Types toggle-off requires confirmation dialog. Pattern applies to both portal and mobile app. |
| 1.4 | March 15, 2026 | Ken / Claude | Replaced single gas/diesel price fields with 5-slot flat column structure (Gas 1, Gas 2, Diesel 1, Diesel 2, Propane) supporting up to 2 grades per fuel type. Added grade names, ethanol-free flag. Added hours_json field and hours panel on Dashboard. Added UI design decisions section (colors, button styles, card layout). Updated migration plan for field renames. Updated portal and mobile app screen descriptions for fuel grade awareness. |
| 1.5 | March 15, 2026 | Ken / Claude | Tax rates are marina-entered (not auto-populated from state table). Tax supports per-gallon, percentage, or N/A. Added tax_type fields. Added Method=MFD (Apify/email/call queue skip self-maintaining marinas). Website field editable for MyFuelDock marinas. Added city, state, latitude, longitude fields with Google Maps geocoding. Consolidated portal screens: removed Update Prices (merged into Dashboard), removed Marina Info and Account Settings, replaced with separate My account and Marina details screens. Removed analytics summary from Dashboard (dedicated Analytics screen only). Final sidebar: Prices (Dashboard), Settings (My account, Marina details, Fuel dock status, Fuel types, Widget setup), Analytics (Analytics). Updated all API endpoints to match new screen structure. Updated mobile app screens to mirror portal. |
| 1.6 | March 16, 2026 | Ken / Claude | Added public pages section (landing page with browser-frame widget preview, register form, login with email-code option). Added admin dashboard section (overview with metrics/alerts/marina table, all marinas list, aggregated analytics, separate admin sidebar). Updated widget template descriptions to match wireframe designs. Added Section 12: Implementation Plan with 8-step dependency-driven build order and effort estimates (7-10 weeks total). Renumbered Open Questions to 13, Glossary to 14. |
| 1.7 | March 16, 2026 | Ken / Claude | CRITICAL: Changed migration strategy from rename to augmentation. Existing gas_price and diesel_price fields stay untouched. All new fields (pretax, grade names, ethanol-free, Gas 2, Diesel 2, propane, sells toggles, tax fields, etc.) are added alongside. Consumer Fuel Docks app, FD Dialer, and Apify actors require zero changes for My Fuel Dock launch. Migration plan split into Phase A (launch, pure augmentation) and Phase B (future optional cleanup of existing systems). Updated field tables, slot logic, Rule 2 note, widget_data response fields, implementation plan Step 1, and Phase 1 scope bullets to reflect new approach. |
| 1.8 | March 17, 2026 | Ken / Claude | Added widget branding: 'Powered by myfueldock.com' link at the bottom of all widget templates (Section 5.3). Small blue text, opens myfueldock.com in new tab. Serves as viral lead generation. Not removable in Phase 1. White-label removal added to Phase 2 premium tier features. |
| 1.8 | March 17, 2026 | Ken / Claude | Added 'Powered by myfueldock.com' link to all widget templates (small blue hyperlink at bottom, opens in new tab). Serves as lead generation for marina operators who see the widget on other marinas' websites. White-label removal of this link added to Phase 2 premium tier features. |
| 1.9 | March 19, 2026 | Ken / Claude | Unified portal fuel type colors with widget colors for visual consistency across all surfaces. Portal now uses Gas=#000000 (black), Diesel=#1D9E75 (green), Propane=#378ADD (blue), matching the widget templates. Previously portal spec had Gas=#1D9E75, Diesel=#378ADD, Propane=#BA7517. |
| 1.10 | March 22, 2026 | Ken / Claude | PHASE 1 COMPLETE. Portal deployed to myfueldock.com (15 pages, Users CRUD, Navigator branding, favicon). Email channel live: prices@myfueldock.com → Mailgun → Xano mfd_email_inbound → Claude Haiku parsing → 4-way routing → DB update → confirmation reply from prices@myfueldock.com. Enhanced confirmation emails with pre-tax/pump breakdown, marina website link, ref ID. 4 user management API endpoints (list, create, update, delete with self-delete guard). 3 background tasks: mfd_stale_price_alert (daily weekdays, per-marina configurable threshold via price_reminder_days), daily_maintenance (merged CSV backup + analytics cleanup, renamed from daily_csv_backup), fuel_available_revert (every 15 min). New schema fields: price_reminder_days, fuel_available, fuel_available_revert_at. Mailgun: myfueldock.com verified (MX, SPF, DKIM, CNAME in Cloudflare), new “MFD All Domains” API key. Open questions #4 and #6 resolved. |
| 1.11 | March 22, 2026 | Ken / Claude | Public /setup onboarding page added to myfueldock.com: 3-step guide (sign up, choose widget, send to webmaster), live widget template previews, 3 update methods (dashboard/app/email), FAQ section, printable webmaster guide at /setup-guide.html. CMS platform table updated based on scan of all 47 marina websites: WordPress 58%, Wix 8%, Squarespace/Drupal/CivicPlus/Dealer Spike/Shopify/Weebly. Westmark Marina (id=9999) added to FuelPrices as first MFD test marina (Method=MFD). Boston Harbor Marina (id=1) reverted to pre-test state. support@myfueldock.com Mailgun route created (forwards to ken@navigatormktg.com). Purchased myfueldocks.com (with S) as protective domain: web redirect rule (301 → myfueldock.com preserving path), Mailgun auto-reply endpoint mfd_wrong_domain_reply (API id=79) tells senders to remove the S. westmarkmarina.com Cloudflare DNS fixed (deleted stale A records pointing to old Hover IP, CNAME for www added). New Xano endpoint count: 28 total in MFD API group. |
| 1.12 | March 22, 2026 | Ken / Claude | Public /setup onboarding page added to myfueldock.com: 3-step guide (sign up, choose widget, send to webmaster), live widget template previews, 3 update methods (dashboard/app/email), FAQ section, printable webmaster guide at /setup-guide.html. CMS platform table updated based on scan of all 47 marina websites: WordPress 58%, Wix 8%, Squarespace/Drupal/CivicPlus/Dealer Spike/Shopify/Weebly. Westmark Marina (id=9999) added to FuelPrices as first MFD test marina (Method=MFD). Boston Harbor Marina (id=1) reverted to pre-test state. support@myfueldock.com Mailgun route created (forwards to ken@navigatormktg.com). Purchased myfueldocks.com (with S) as protective domain: web redirect rule (301 → myfueldock.com preserving path), Mailgun auto-reply endpoint mfd_wrong_domain_reply (API id=79) tells senders to remove the S. westmarkmarina.com Cloudflare DNS fixed (deleted stale A records pointing to old Hover IP, CNAME for www added). New Xano endpoint count: 28 total in MFD API group. |
| 1.13 | March 22, 2026 | Ken / Claude | Mailgun alias forwarding route added: regex route forwards common email variants (price, pricing, update, updates, fuel, fuelprice, fuelprices) @myfueldock.com to prices@myfueldock.com. Documented in section 8.2. |
| 1.14 | March 22, 2026 | Ken / Claude | Widget enhancements and timezone support. Timezone-aware open/closed status: new “timezone” field (IANA format, default America/Los_Angeles) on FuelPrices table, returned by widget_data API. Widgets now check current time in the marina’s timezone to show “Open until 6pm”, “Closed · Opens tomorrow at 8am”, or “Closed · Opens today at 8am”. Season-aware hours parsing: parseHours filters month-range hours (e.g., “Oct-Apr: 8am-6pm; May-Sep: 7am-8pm”) to show only the current season in the Detailed Card. Custom widget display name: new “display_name” field on mfd_widgets table allows admin to override the marina name shown in widget header (e.g., “Fuel Prices” instead of “Westmark Marina”). widget_data API looks up display_name when widget_id is provided; falls back to fuel_dock if null/empty. Compact Horizontal font size matched to Banner (0.9375rem/700 weight). Closed status split into two lines: “Closed” on main line with smaller “Opens tomorrow at 8am” detail below, replacing dot separator on Standard Card, Compact, and Banner. Banner layout: status moved from right meta section to under marina name/location. |
| 1.15 | March 23, 2026 | Ken / Claude | Email sending domain fix: confirmation replies to marina price updates now sent from prices@myfueldock.com (previously incorrectly documented as navigatorpnw.com). Section 8.2 updated. |
| 1.16 | March 23, 2026 | Ken / Claude | Method value standardized from `MyFuelDock` to `MFD` across all references. Shorter value is more consistent with existing Method values (HTML, Call, Email) and easier to type/filter. Updated Section 3.4 heading and description, all Method=MFD references throughout document, and glossary entry. Coordinated with Fuel Docks system design doc v4.33 which adds MFD to its Method Field Values table. |
| 1.18 | March 26, 2026 | Ken / Claude | Widget templates built and deployed. Architecture: single /b/index.html entry point renders all 4 templates (card-standard, compact-horizontal, card-detailed, banner-wide) based on template_id from API. URL pattern: /b/{marina_id}?w={widget_id} with Cloudflare _redirects routing. widget_data endpoint updated: now returns template_id and config_json from mfd_widgets table; added Method=MFD access gate (Section 5.1, 4.1, security table MFD-S4a) — non-MFD marinas get generic 404 to prevent ID enumeration and unauthorized widget use. Updated response fields list in Section 4.1 to match actual implementation. Shared render.js rewritten: config-aware fuel list builder, hours_json day-of-week formatter, timezone-aware open/closed using hours_json, custom color CSS variable injection. |
| 1.17 | March 25, 2026 | Ken / Claude | Service tier strategy defined: free + paid model replaces all-free Phase 1. Added Section 1.4 (Service Tiers) with complete free vs. paid feature breakdown. Free tier: 1 widget, web portal price updates only, max 2 changes/day, display name customization, fuel availability toggle. Paid tier adds: multiple widgets, custom colors, email/mobile app/text update channels, unlimited updates, hours management, price reminders, analytics, priority support, all future features. No API access for any tier. New mfd_daily_updates table tracks price changes per marina per day for free-tier enforcement. Added tier field (free/paid) to mfd_users table. Updated mfd_update_prices endpoint to check daily counter for free-tier marinas. Updated mfd_mailgun_inbound to check tier before processing email price updates. Updated mfd_get_analytics to show upgrade prompt for free tier. Analytics data collected for all marinas but only displayed to paid tier. Updated Section 5.3 (widget branding present on all tiers, white-label deferred). Updated Section 5.4 (custom colors noted as paid tier). Updated Section 11.2 (premium features moved from Phase 2 deferred into Phase 1 paid tier). Updated daily_maintenance task to clean up mfd_daily_updates. |
| 1.19 | March 26, 2026 | Ken / Claude | Widget phone fallback (new Section 5.7): when widget fails to load, displays styled fallback card with ⛽ icon, "Call for current fuel prices", and clickable tel: link using marina's phone number from `&phone=` URL parameter. api.js: new `getFallbackPhone()` parses and auto-formats phone digits. widget.html: `renderFallback()` replaces both error paths. styles.css: `.widget-fallback` card styles. WidgetSetup.tsx: `injectPhone()` helper auto-injects marina.phone into embed code URL. Webmasters page (/webmasters): added as 4th public page in Section 6.7. Added Shopify, Weebly, Drupal platform-specific embed instructions (8 platforms total). FAQ "How often" → "How quickly". "Recommended sizes" → "Sizes of our free widgets". Embed code examples updated with `&phone=PHONE`. FAQ fallback answer updated. Landing page: step circles changed to #1/#2/#3 with shadow styling; widget carousel display area increased from 280px to 380px to fit Detailed Card template. |
| 1.20 | March 27, 2026 | Ken / Claude | Moved tier field from mfd_users table to FuelPrices table (where it belongs — tiers are per-marina, not per-user). Added tier enum (free/paid, default free) to FuelPrices schema in Xano and documented in Section 3.1. All existing marinas default to free. |

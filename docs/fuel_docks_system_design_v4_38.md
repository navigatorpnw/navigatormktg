# Fuel Docks System Design Document

**Version:** March 2026 (v4.38)
**Author:** Ken (Navigator Marketing)
**Purpose:** Complete technical reference for the Fuel Docks price monitoring system. Intended for use by Ken, AI assistants, and future developers/collaborators.

---

## 1. System Overview

Fuel Docks is a mobile application that tracks gas and diesel prices at marinas, starting with 31 locations primarily in Washington state's Puget Sound region. The system serves marina customers through a mobile app (React Native/Expo consumer app, with Adalo retained for admin/data entry) while providing automated price monitoring and collection capabilities.

The system collects fuel pricing data through five input methods:

- **HTML scraping** (automated): Apify Cheerio actor fetches static HTML marina websites on a Xano-controlled schedule
- **Javascript scraping** (automated): Apify Playwright actor handles JavaScript-rendered marina websites on a Xano-controlled schedule
- **Email** (semi-automated): Mailgun sends price check requests to marinas and processes their replies
- **Call** (manual): Ken calls marinas and enters data through an Adalo interface
- **MFD** (marina self-service): Marina operators update their own prices via the My Fuel Dock portal (myfueldock.com), mobile app, or email to prices@myfueldock.com

All five methods feed into Xano, which serves as the central orchestrator, scheduler, and single source of truth. Xano determines when AI-powered parsing is needed, calls the Claude API for content interpretation, and serves data to the Adalo mobile app.

---

## 2. Architecture Evolution

### January 2026 Architecture (Legacy)

- **Distill.io** monitored marina websites using CSS selectors
- Distill sent webhooks to **Airtable** only when changes were detected
- **Airtable** stored pricing data and forwarded updates to **Xano** via API POST
- **Xano** served data to **Adalo** via API GET
- **SendGrid** handled error/alert emails to Ken
- Email and phone data entry were fully manual with no automation

**Problems with January architecture:**

- Distill only fires webhooks on change, so `last_checked` could not be updated on every check cycle
- CSS selectors are brittle and misinterpret content (e.g., a closure notice "Closed until 2/09/26" was recorded as a gas price of $2.09)
- Different marina websites required different selector configurations
- No intelligence for interpreting closures, status changes, or contextual notes
- Bidirectional Airtable-Xano sync added complexity
- Multiple email services (SendGrid for alerts, manual email for marina contact)

### February 2026 Architecture

- **Apify** scrapes marina websites using two actors: a Cheerio actor for static HTML sites and a Playwright actor for JavaScript-rendered sites
- **Xano** owns the scraping schedule via Background Tasks and triggers the appropriate Apify actor for each marina
- Apify POSTs raw page content to **Xano** on every run, authenticated with a shared webhook token
- **Xano** hashes content, compares against stored hash, and calls **Claude API** (via Xano's Claude Function Pack) only when content has changed
- **Mailgun** handles both outbound price requests and inbound reply processing (plus error alerts) using the mg.fueldocks.app subdomain for alerts and navigatorpnw.com for marina correspondence
- **Adalo** provides both the consumer app and Ken's manual data entry interface for phone-based price collection
- **Distill.io** demoted to watchdog role (25 monitors: 5 cloud at 4x/day, 20 local). Alerts Ken to changes independently. No webhooks, no data writes. Free plan.
- **Airtable** removed entirely (subscription cancelled, webhook deleted, token removed from Xano)
- **SendGrid** removed (API key deleted, account inert; consolidated into Mailgun)

### March 2026 Architecture (Current)

The backend (Xano, Apify, Mailgun, Claude API) remains unchanged from the February architecture. The consumer-facing frontend is being migrated from Adalo to a native React Native/Expo app built with Claude Code.

- **React Native/Expo** replaces the Adalo consumer app. Built with Expo SDK 54, TypeScript, Expo Router (file-based routing). Connects to the same Xano API endpoints used by the Adalo consumer app.
- **FD Dialer** (call queue admin app) also migrated from Adalo to React Native/Expo (v4.6). Now uses Expo Push Notifications for silent badge updates every 15 minutes so the app icon shows the pending call count without opening the app.
- **Adalo** fully retired. No longer serves any frontend.
- **Claude Code** used as the primary development environment for the React Native app, with Xano MCP server integration for direct database and API endpoint management from the CLI.
- The Xano `marina_detail` endpoint (#46), previously created but unused by Adalo (which passed list row data directly), is now actively called by the React Native app's detail screen.

---

## 3. Technology Stack

| Component | Role | Cost Estimate |
|-----------|------|---------------|
| **Apify** (Free tier) | Web scraping with Cheerio and Playwright actors | Free (~$5/month in compute) |
| **Xano** | Central orchestrator, scheduler, database, API server, Claude Function Pack host | Existing plan |
| **Claude API** (Haiku 4.5) | AI-powered content parsing via Xano Function Pack | ~$5-10/month |
| **Mailgun** | Outbound and inbound email, error alerts (mg.fueldocks.app for alerts, navigatorpnw.com for marina correspondence) | Free tier likely sufficient |
| **React Native / Expo** (SDK 54) | Consumer mobile app (replacing Adalo consumer frontend). TypeScript, Expo Router, file-based routing. | $0 (open source) |
| **Adalo** | Fully retired. Both consumer app and FD Dialer admin app migrated to React Native/Expo. | Plan cancelled |
| **Claude Code** | AI-powered development environment for the React Native app. Xano MCP server integration for direct backend management. | Existing Anthropic plan |
| **Distill.io** (Free tier) | Watchdog/verification layer, change-detection alerts only | $0/month |

**Total estimated monthly cost:** ~$5-20 (plus existing Xano, Adalo, and Anthropic plans)

---

## 4. Data Flow by Channel

### 4.1 Web Scraping Channel (HTML and Javascript methods)

```
Xano Background Task (every 3hrs, 6am-9pm)
    |
    |--> Checks current hour in Pacific time
    |    Skips if outside 6am-9pm window
    |
    |--> Triggers Apify HTML Scraper actor via API
    |    (actor fetches marina list from Xano, scrapes Method="HTML" sites)
    |
    |--> Triggers Apify JS Scraper actor via API
         (actor fetches marina list from Xano, scrapes Method="Javascript" sites)
         |
         Both actors scrape and POST results to same Xano webhook
         (with webhook_token in POST body for authentication)
         |
         Xano apify_webhook --> [Token Check] --> [Hash Check]
              |
              No change --> Update last_checked, done
              Change -----> Xano calls Claude Function Pack
                            |
                            Claude returns JSON
                            |
                            Xano strips code fences,
                            parses JSON, updates prices,
                            status, last_updated
                            |
                            On error --> Try/Catch sends
                            Mailgun alert email to Ken
```

**Detailed steps:**

1. A Xano Background Task (`trigger_apify_scrapers` #2) runs every 3 hours starting at 6am Pacific
2. The task checks the current hour in Pacific time. If the hour is before 6am or 9pm or later, the task exits without doing anything.
3. The task triggers the Apify HTML Scraper actor via POST to the Apify API, which starts the actor run
4. The task triggers the Apify JS Scraper actor via POST to the Apify API, which starts the actor run
5. Each actor calls Xano's `apify_marina_list` endpoint to get its list of marinas (filtered by Method = "HTML" or "Javascript"), authenticating with the `APIFY_WEBHOOK_TOKEN` via a required `token` query parameter
6. Each actor receives a list of marina objects: `{ id, fuel_dock, website, css_selector }`
7. For HTML marinas: Cheerio fetches raw HTML and extracts the fuel section using the CSS selector
8. For Javascript marinas: Playwright launches a headless browser with stealth features (see below) that renders JavaScript
9. Both actors POST `{ marina_id, scraped_content, scrape_url, webhook_token }` to the same Xano `apify_webhook` endpoint for each marina
10. Xano validates the `webhook_token` against `$env.APIFY_WEBHOOK_TOKEN` via a precondition. If the token is missing or incorrect, Xano returns a 401 error and stops processing.
11. Xano converts `marina_id` to integer (required because `util.get_raw_input` delivers all values as strings)
12. Xano computes an HMAC-SHA256 hash of the incoming content (keyed with `APIFY_WEBHOOK_TOKEN`)
13. Xano compares the new hash against `last_content_hash` stored in the database
14. **If hashes match:** Update `last_checked` only. No further action. Page has not changed.
15. **If hashes differ:** Xano stores the new hash, then calls the Claude Function Pack with the page content
16. Claude Function Pack returns structured JSON (possibly wrapped in markdown code fences)
17. Xano strips any code fences, trims whitespace, and decodes the JSON
18. Xano compares extracted values against current database values
19. Xano applies `price_processing_rule`: if `add_tax_diesel` and `diesel_tax > 0`, multiplies diesel by `(1 + diesel_tax)`, rounds to 2 decimals, stores raw price in `diesel_price_pretax` (v4.38)
20. Xano writes any changes and updates `last_updated` timestamp
21. **If any step in 15-20 fails:** The Try/Catch block catches the error, sends a detailed alert email via Mailgun, and returns `{"status": "error"}`

**Why two actors instead of one:** Every website falls into one of two categories: content is in the raw HTML (Cheerio handles it), or content gets loaded by JavaScript after the page opens (Playwright handles it). Cheerio is roughly 10x cheaper in compute units than Playwright. Since most marina websites are simple static HTML, defaulting to Cheerio and only using Playwright where needed keeps costs within the Apify free tier.

**How to determine which actor a marina needs:** View the page source in a browser (right-click, View Page Source). Search for the actual price number. If it's in the raw source, Cheerio works (Method = "HTML"). If not, the price is loaded by JavaScript (Method = "Javascript"). If the site returns HTTP 403 to the Cheerio actor, it likely needs Playwright's stealth features. If neither works (CAPTCHAs, login walls, scraper blocking), route the marina to Email or Call instead.

**Why hash-based change detection:** Avoids paying for Claude API calls when nothing has changed. At 31 marinas checked 5 times daily, that would be 4,650 monthly API calls without hashing versus a much smaller number of calls only when content actually changes.

**Important note on hashing:** Only hash the fuel-relevant section of the page (extracted via CSS selector), not the entire page. Many sites include dynamic elements (timestamps, ads, session tokens) that change on every load and would produce false positives.

**Cheerio failure mode:** If a site loads prices via JavaScript, Cheerio will get the same empty placeholder HTML every time. The hash will never change, and last_updated will never advance. This fails safely (no wrong prices, just stale ones) and is caught by the staleness alert (see Section 15).

### 4.2 Email Channel

```
Xano Background Task (send_outbound_emails, daily 10am Pacific, Mon-Fri)
    |
    |--> For each Method=Email marina due for a check:
    |    Calls send_price_check_email Custom Function
    |    |
    |    Custom Function --> Mailgun Send API --> Marina inbox
    |    Updates last_email_sent, increments consecutive_unanswered
    |    |
    |    If consecutive_unanswered >= 2 --> Alert to ken@navigatormktg.com
    |
                                                      Marina replies
                                                            |
Mailgun Inbound Route (navigatorpnw.com) --> Xano mailgun_inbound webhook
                                                            |
                                              Xano calls Claude Function Pack
                                                            |
                                              Claude extracts prices from email body
                                                            |
                                              Xano updates database,
                                              resets consecutive_unanswered to 0
```

**Detailed steps:**

**Outbound (requesting prices):**

1. The `send_outbound_emails` Background Task runs once daily at 10am Pacific, Monday through Friday (skips weekends)
2. It queries all FuelPrices records, then filters in the loop for marinas where Method = "Email" and `contact_email` is populated
3. For each qualifying marina, it calculates whether the marina is due for an email using date-based comparison (v3.18):
   - Adds `email_cadence` days (in milliseconds) to the reference timestamp, then formats as a `Y-m-d` date string in Pacific time to get the due date
   - If `last_email_response` exists: due date = last response + cadence days; send if due date <= today
   - If no `last_email_response` but `last_email_sent` exists: due date = last send + cadence days; send if due date <= today
   - If neither exists (never emailed): due immediately
   - Default cadence is 7 days if `email_cadence` is null or 0
4. For each due marina, calls the `send_price_check_email` Custom Function which:
   - Looks up the marina record
   - Builds the email subject (custom from `email_subject` field, or default "Current fuel prices?")
   - Builds the email body (custom from `email_body` field with placeholder replacement, or default template)
   - Sends via Mailgun API from ken@navigatorpnw.com
   - Updates `last_email_sent` timestamp
   - Increments `consecutive_unanswered` counter
5. After each successful send, the task checks if `consecutive_unanswered` >= 2 and sends an escalating alert to ken@navigatormktg.com if so
6. Each marina is wrapped in try/catch so one failure does not block the rest

**Inbound (processing replies):**

1. Marina employee replies to the price check email
2. Mailgun receives the reply at navigatorpnw.com (MX records point to Mailgun)
3. Mailgun's inbound route matches `.*@navigatorpnw.com` and forwards the parsed email data to Xano's `mailgun_inbound` webhook endpoint via HTTP POST
4. **Critical:** Mailgun sends data as `x-www-form-urlencoded` (not JSON) with hyphenated field names (`stripped-text`, `body-plain`). Xano's named inputs cannot handle hyphens, so the endpoint uses `util.get_raw_input` with `x-www-form-urlencoded` encoding to capture the full payload.
5. Xano extracts the email body via `$var.mailgun_raw|get:"stripped-text"` and the sender via `$var.mailgun_raw|get:"sender"` using pipe filter syntax
6. Xano queries FuelPrices to find the marina matching the sender's email address (via `contact_email` field)
7. If no marina matches, processing stops with an error response
8. Xano calls the Claude Function Pack to extract prices and status from the email body
9. Claude handles inconsistent reply formats ("gas is 4.95, diesel 5.10" or "$4.95/5.10" or "same as last week")
10. Xano applies `price_processing_rule`: if `add_tax_diesel` and `diesel_tax > 0`, multiplies diesel by `(1 + diesel_tax)`, rounds to 2 decimals, stores raw price in `diesel_price_pretax` (v4.38)
11. Xano routes the response through a three-way conditional: (a) if `forward_to_human` is true, forwards to Ken and updates `last_checked` and `last_email_response` only; (b) if at least one price is non-null, updates prices, sets `last_checked`, `last_updated`, and `last_email_response`; (c) if both prices are null ("no change" reply), updates `last_checked` and `last_email_response` but does NOT set `last_updated` or overwrite existing prices. All three paths reset `consecutive_unanswered` to 0.
12. If Claude's `forward_to_human` flag is true (email is not about prices), the endpoint forwards the original email to ken@navigatormktg.com with subject "RESPONSE REQUIRES ATTENTION: [marina name]"

**Why the LLM is critical for email:** Marina employees reply in wildly inconsistent formats. The LLM handles all variations gracefully without needing format-specific parsing logic.

**Why `stripped-text` instead of `body-plain`:** Mailgun's `stripped-text` field removes quoted reply text (the original outbound message), leaving only the marina employee's new content. This gives Claude cleaner input and avoids confusing the original price request with the reply.

**Why `util.get_raw_input` instead of named inputs:** Mailgun sends form-encoded POST data with hyphenated field names like `stripped-text` and `body-plain`. Xano's input system cannot define inputs with hyphens in the name, and using underscored alternatives (`stripped_text`, `body_plain`) results in empty values because the field names don't match what Mailgun sends. The `util.get_raw_input` approach captures the entire raw POST body as a single object, then individual fields are extracted using the `|get` filter with the exact hyphenated key names.

### 4.3 Call Channel (Manual Entry)

```
Adalo Call List (Home screen)
    |
    |--> call_queue GET returns Method=Call marinas due for a call
    |    (filtered by snooze, recheck_date, suspend_until, cadence)
    |    (sorted by most stale last_updated first)
    |
    |--> User taps marina card --> Call Detail screen
    |
    |--> [Call button] --> Device dialer (tel: URI)
    |    Extension displayed prominently on card for manual keypad entry
    |
    |--> [Submit] --> submit_call POST
    |                   |--> Diesel tax adjustment (if checkbox checked)
    |                   |--> Claude parses notes (if provided)
    |                   |--> Update FuelPrices record
    |                   |--> Set last_call, last_call_connection, clear snooze
    |
    |--> [Call back in 1 hour] --> snooze_call POST
    |                               |--> Set call_snooze_until = now + 1 hour
    |                               |--> Set last_call = now
    |
    |--> [Call back tomorrow] --> snooze_call POST
                                    |--> Set call_snooze_until = tomorrow 12:01am Pacific
                                    |--> Set last_call = now
```

The "FD Dialer" React Native/Expo app (migrated from Adalo in v4.6) provides a dedicated mobile interface (phone form factor) for manual price collection via phone calls. Requires login. Distributed via TestFlight (iOS) for internal testing. Uses Expo Push Notifications for silent badge updates: a Xano background task (`push_badge_update`, every 15 minutes) queries the call queue count and sends a silent push via the Expo Push API to update the app icon badge without displaying a notification banner. Push token registration happens automatically on app launch; tokens are stored in the `dialer_push_tokens` Xano table.

**App name:** FD Dialer (separate React Native/Expo app from the consumer-facing Fuel Docks app)

**Screens:**

- **Welcome:** Login screen with orange LOG IN button, links to Home after authentication
- **Home:** Displays the call queue as a list of marina cards. Each card shows marina name, city, and current open/closure status. Tapping a card navigates to Call Detail. When the queue is empty, the screen shows the `next_call_due` timestamp from the `call_queue` endpoint.
- **Call Detail:** Single-marina view showing full info block (ID, name, city, phone with tap-to-call, extension conditionally visible when populated), current open/closure status with visual emphasis (closure reasons like "Closed Oct 15 - April TBD" displayed in red/orange text), existing comment (read-only), gas/diesel price inputs with numeric keypad (input fields are left empty for clean data entry; current database prices are displayed in each field's label text, e.g., "Gas Price - currently $5.22", so the caller sees last known prices for reference without the Adalo Default Value backspace bug), diesel section (diesel price input, diesel tax field with contextual label e.g. "0 = included", diesel tax checkbox, and helper text) conditionally visible for marinas that sell diesel (hidden when `diesel_price` = 9999, the sentinel value for "does not sell diesel"), notes text input, and three action buttons (Submit, Call Back - 1 Hour, Call Back Tomorrow). All three buttons return to Home after executing.

**Call queue filtering logic:** A marina appears in the queue when ALL of these conditions are true:

1. `Method` == "Call"
2. `call_snooze_until` is null OR `call_snooze_until` <= now (snooze has expired)
3. `recheck_date` is null OR `recheck_date` <= today (not waiting for a future status change)
4. `suspend_until` is null OR `suspend_until` <= today (not suspended for seasonal closure)
5. One of: (a) `last_call_connection` is not null AND days since `last_call_connection` >= `call_cadence` (default 7 if null/0), or (b) `last_call_connection` is null (never successfully reached anyone, always due immediately regardless of `last_call` value). BUG FIX (v3.17, Mar 2 2026): Previously had a third branch that checked cadence against `last_call` when `last_call_connection` was null. This incorrectly prevented snoozed marinas from reappearing after their snooze expired, because `snooze_call` sets `last_call` during the snooze action. Cadence now only gates marinas where a successful connection was made.

**Sort order:** Marinas with the oldest `last_updated` timestamp first (most stale data gets called first).

**Diesel tax checkbox logic:** The checkbox label reads "Price includes tax." Default state on card load: if `diesel_tax` == 0, checkbox starts checked (marina typically quotes tax-included prices); if `diesel_tax` has a nonzero decimal value (e.g., 0.089), checkbox starts unchecked (marina typically quotes pre-tax prices); if `diesel_tax` is null or empty, checkbox starts unchecked (assume pre-tax). On submit: Adalo sends the `diesel_tax_included` input as a **decimal** (not a boolean). When the checkbox is checked, Adalo sends the marina's current `diesel_tax` value (e.g., 0.092). When unchecked, Adalo sends 0. The `submit_call` endpoint multiplies the entered diesel price by `(1 + rate)` to add the percentage-based tax when the rate is greater than 0. For example, an entered price of $4.35 with a rate of 0.089 is stored as $4.35 x 1.089 = $4.737. All tax math lives in the `submit_call` endpoint, not in Adalo. The endpoint also writes the submitted `diesel_tax_included` value back to the `diesel_tax` database field on every submission, keeping the stored tax rate current.

**Diesel tax checkbox default behavior:**

| `diesel_tax` value | Checkbox default | Meaning |
|---|---|---|
| 0 | Checked | Marina usually quotes tax-included; no tax to add |
| Nonzero decimal (e.g., 0.089) | Unchecked | Marina usually quotes pre-tax; known tax rate exists |
| Null/empty | Unchecked | Unknown; assume pre-tax |

**Diesel tax submit calculation:**

| Checkbox state | Entered price | diesel_tax_included sent | Stored `diesel_price` |
|---|---|---|---|
| Unchecked (pre-tax) | 4.35 | 0 | 4.35 (no change) |
| Checked (tax not yet included) | 4.35 | 0.089 | 4.737 (4.35 x 1.089) |
| Checked (tax not yet included) | 5.00 | 0.089 | 5.445 (5.00 x 1.089) |
| Checked (rate is zero) | 5.00 | 0 | 5.00 (multiplier is 1.0, no effect) |

**Future: tax changes via notes.** If a marina tells the caller that tax rules have changed, the caller enters that in the Notes field. Claude picks it up in the `comment` field, and Ken manually updates the `diesel_tax` value in the database. Automated tax field updates from notes are not in scope for Step 7.

**Gas tax UI note:** The gas price row on the Call Detail screen shows a static "WA state doesn't charge tax" message next to the input field (because marine gasoline is exempt in Washington state). As the system expands nationwide, this would become dynamic per state.

**Claude integration for call notes:** When notes are provided in the Submit action, the `submit_call` endpoint calls Claude with a call-notes-specific system prompt (see Section 5). Claude extracts status/closure/hours/recheck_date from the free-text notes. Claude does NOT extract prices from notes (prices come from the form inputs directly). If no notes are provided, Claude is not called.

**Extension handling:** The extension is displayed on the Call Detail card below the phone number, formatted as "(ext. X)". The phone number and extension are two separate Adalo text components (originally they were a single combined component, but had to be split so the extension could be independently hidden). The extension text component is set to **Sometimes Visible** in Adalo so it only renders when the extension field has a value (condition: extension is not equal to empty). Marinas without an extension show only the phone number. The user enters the extension on the phone's keypad manually at the appropriate moment during the call. Auto-send via tel: URI comma pauses was considered but rejected because timing varies per marina phone system and user-tunable delays create a worse UX than just pressing a digit on the keypad.

**Diesel section visibility for gas-only marinas:** The diesel price input, diesel tax field, diesel tax checkbox, and "0 = included" helper text are grouped together in Adalo and set to **Sometimes Visible** with the condition: `diesel_price` is not equal to 9999. The value 9999 is the sentinel value in the `diesel_price` database field meaning "this marina does not sell diesel." When a marina's `diesel_price` is 9999, the entire diesel input group is hidden on the Call Detail screen, leaving only the gas price input visible. This prevents the caller from seeing irrelevant diesel fields for gas-only marinas. The grouping approach (placing all four diesel-related components inside a single visibility condition) follows the same pattern used for the extension component: isolate the conditional content into its own section and apply "Sometimes Visible" to the container rather than to each component individually. Marinas that sell diesel have a real price or null in the `diesel_price` field, so the diesel section renders normally for those records.

**Phone number tap-to-call:** In addition to the Call button, the phone number text itself is tappable on the Call Detail screen. It is wired as a Website link action with `tel:` followed by the call queue phone magic text. The "Use In-app Browser" advanced setting must be set to Off so iOS handles the `tel:` protocol natively instead of trying to open it in a web view. On a real mobile device (TestFlight or production), tapping the number opens the native phone dialer with the number pre-filled. This does not function in the Adalo previewer or desktop browser. Changes to link actions require a fresh Adalo publish and TestFlight update to take effect on device. Confirmed working on iPhone 17 Pro, iOS 26.4.

**Snooze behavior:** "Call back in 1 hour" sets `call_snooze_until` to now + 3600 seconds and records `last_call` as now (attempt was made). "Call back tomorrow" sets `call_snooze_until` to tomorrow at 12:01 AM Pacific. Neither snooze updates `last_call_connection` since no one was reached.

**Voicemail tip:** Some marinas include current fuel prices in their voicemail greeting. The `comment` field is visible on the Call Detail screen so the caller can see notes like "Listen to voicemail - prices are in the greeting" (e.g., Port Orchard Marina, id=28).

**Note on automated voice calls:** Washington state is a two-party consent state for recording phone calls. Automated voice solutions (such as Retell.AI) would require permission from the marina employee being called. This is not practical at scale, so the Call method remains a manual process with Adalo as the data entry frontend.

---

## 5. Claude Integration via Xano Function Pack

### Overview

Claude is integrated using Xano's official **Claude Function Pack**, installed from the Xano Marketplace. This provides a native `createChatCompletion` function that handles API authentication, headers, and request formatting automatically, eliminating the need for manual External API Request configuration.

**Why Function Pack over External API Request:** Early development attempted direct API calls using Xano's External API Request. This approach encountered persistent issues with header authentication (environment variable concatenation), response parsing (Claude wrapping JSON in markdown code fences), and Xano's replace filter not properly matching backtick characters. The Function Pack resolves all of these by abstracting the API integration.

### Model Selection

**Claude Haiku 4.5** (`claude-haiku-4-5`) is used for all parsing tasks. The Function Pack's model dropdown originally listed only Claude 3.x models. The enum was manually updated to add `claude-haiku-4-5` and `claude-haiku-4-5-20251001` as allowed values, with `claude-haiku-4-5` set as the default. This was done by editing the `model` input on the "Create chat completion - Claude" function (#34) under Library > Functions.

**How to update the Function Pack model enum in the future:** Open Library > Functions > "Create chat completion - Claude" #34 > click the `model` input box > add new model strings to the Values list > update the Default value dropdown > click Done > Review & Publish.

### API Access

The Claude API is separate from any Claude Pro chat subscription. Access is through console.anthropic.com with a developer account. API usage is billed per token (pay-as-you-go).

**Status:** Anthropic API key created and stored as Xano environment variable `anthropic_api_key` (lowercase, required by the Claude Function Pack). The Function Pack specifically looks for this lowercase name.

### Function Pack Setup

The Claude Function Pack is installed from Xano Marketplace and provides two functions:

- **createChatCompletion**: Text generation with system prompts (used for price extraction)
- **createImageAnalysis**: Image analysis (not currently used)

The function is called in the `apify_webhook`, `mailgun_inbound`, and `submit_call` endpoints. Configuration:

- **model**: `claude-haiku-4-5`
- **max_tokens**: 1024
- **system**: Extraction prompt (web scraping, email, and call-notes versions differ; see Section 5)
- **prompt**: Scraped page content or email body text
- **temperature**: 0 (for consistent, deterministic results)
- All other parameters (top_k, top_p, stop_sequences, image, image2): null

### Function Pack Response Structure

The Custom Function returns as `func1` with this nested structure:

```
func1: {
  result: {
    model: "claude-haiku-4-5-20251001",
    id: "msg_...",
    type: "message",
    role: "assistant",
    content: [              <-- array, must use index [0]
      {
        type: "text",
        text: "```json\n{...}\n```"   <-- Claude's JSON response, often wrapped in code fences
      }
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, ... }
  },
  status: 200,
  error: null
}
```

**On error, the response structure changes to:**

```
func1: {
  result: {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "messages.0: user messages must have non-empty content"
    },
    request_id: "req_..."
  },
  status: 400,
  error: null
}
```

**Critical path detail:** Claude's text response lives at `$var.func1.result.content[0].text`. The `content` field is an **array**, so the `[0]` index is required to access the first (and typically only) content block. The text value is a JSON string that must have code fences stripped and then be decoded with the `|json_decode` filter before its fields can be accessed.

**Full expression for parsed_response:** `$func1.result.content[0].text|replace:"```json":""|replace:"```":""|trim|json_decode`

**Why code fence stripping is needed:** Despite the system prompt instructing "CRITICAL: Output ONLY raw JSON. Never use markdown, backticks, or code fences," Claude Haiku 4.5 still wraps its JSON output in markdown code fences (` ```json ... ``` `). Claude 3 Haiku sometimes obeyed the instruction, sometimes did not. The `replace` and `trim` filters handle both cases safely: if fences are present they get stripped, if not the filters are no-ops and the clean JSON passes through unchanged.

### System Prompts

**Web Scraping Prompt (used in apify_webhook):**

The prompt is built dynamically at runtime by concatenating the current Pacific date into the system prompt via a `$today_date` variable and a `$system_prompt` variable. The date injection allows Claude to distinguish between current and future closures. The prompt text below shows `{today_date}` where the dynamic date is inserted:

```
CRITICAL: Output ONLY raw JSON. Never use markdown, backticks, or code fences. Start your response with { and end with }. The current date is {today_date}. You are a marina fuel price extraction assistant. Extract fuel pricing data from scraped marina website content. Respond ONLY with valid JSON, no other text. Use this exact structure: {"gas_price": null, "diesel_price": null, "open": "Open", "closure_note": null, "recheck_date": null, "hours": null, "comment": null}. Rules: 1) gas_price = price per gallon of gasoline at the lowest volume tier (smallest number of gallons, which is the highest per-gallon price). This is the base price before volume discounts. Use null if not listed. 2) diesel_price = price per gallon of diesel BEFORE tax at the lowest volume tier (smallest number of gallons, highest per-gallon price). Use null if not listed. 3) open = FIRST check dates: if the website mentions a closure for a FUTURE date after {today_date}, the marina is still operating today so set to exactly "Open" with no additional words. Only if the marina is actually closed or not fully operational RIGHT NOW on {today_date} should you write a short user-facing reason (examples: "Closed for winter maintenance", "Closed for Presidents Day", "By appointment only until March", "Under repair - no ETA given"). Never write just "Closed" by itself because app users need to know why. If operating normally today, set to exactly "Open". 4) closure_note = ANY closure information mentioned on the page, whether current or future. Include the dates and reason. This field captures all closure details so nothing is lost. 5) recheck_date = If any date-specific closure or status change is mentioned (current or future), return the next date the status should be re-evaluated in MM/DD/YYYY format. For a closure starting on a future date, use that start date. For a closure currently in effect with a known end date, use the day after the last closed date. For indefinite closures ("closed until further notice") or no closure information at all, use null. 6) hours = fuel dock operating hours if listed. 7) comment = any other notable info. All prices must be decimal numbers like 4.08, not strings.
```

**Email Parsing Prompt (used in mailgun_inbound):**

Like the web scraping prompt, this is built dynamically with the current Pacific date injected via `$today_date`. Additionally, the marina's current on-file prices are injected via a `$price_context` variable (added v3.28) so Claude can recognize affirmative confirmations of those prices. The `{today_date}` and `{price_context}` placeholders below show where dynamic values are inserted at runtime:

```
CRITICAL: Output ONLY raw JSON. Never use markdown, backticks, or code fences. Start your response with { and end with }. The current date is {today_date}.{price_context} You are a marina fuel price extraction assistant. Extract fuel pricing data from email replies to price check requests. Respond ONLY with valid JSON, no other text. Use this exact structure: {"gas_price": null, "diesel_price": null, "open": "Open", "closure_note": null, "recheck_date": null, "hours": null, "comment": null, "forward_to_human": false}. Rules: 1) gas_price = price per gallon of regular gas. Use null if not mentioned or if prices have not changed. 2) diesel_price = price per gallon of diesel that the customer pays at the pump. NEVER calculate tax yourself. If multiple diesel prices are mentioned (such as a base price and a pump/total/final price), always use the HIGHEST number because that is what the customer actually pays. Use null if not mentioned or if prices have not changed. 3) open = FIRST check dates: if the email mentions a closure for a FUTURE date after {today_date}, the marina is still operating today so set to exactly "Open" with no additional words. Only if the marina fuel dock is actually closed or not fully operational RIGHT NOW on {today_date} should you write a short user-facing reason (examples: "Closed for winter maintenance", "Closed for Presidents Day", "By appointment only until March", "Under repair - no ETA given"). Never write just "Closed" by itself because app users need to know why. If operating normally today or if unclear, set to exactly "Open". 4) closure_note = ANY closure information mentioned in the email, whether current or future. Include the dates and reason. 5) recheck_date = If any date-specific closure or status change is mentioned (current or future), return the next date the status should be re-evaluated in MM/DD/YYYY format. For a closure starting on a future date, use that start date. For a closure currently in effect with a known end date, use the day after the last closed date. For indefinite closures ("closed until further notice") or no closure information at all, use null. 6) hours = fuel dock operating hours if mentioned. 7) comment = any other notable info from the email. 8) forward_to_human = true ONLY if the email is NOT about fuel prices, hours, status, or closures (e.g. complaints, questions, unsubscribe requests, general correspondence). Default to false. IMPORTANT: Short affirmative replies such as "Yes", "Yup", "Correct", "That is right", "Same", "Yep", "Still the same", "No change", "Sure is", "Uh huh", "Yeppers", or similar confirmations mean the marina is confirming the current prices are unchanged. These ARE fuel-dock-related responses. Return null prices with forward_to_human: false. All prices must be decimal numbers like 4.08, not strings. If the email does not contain any price information but IS about the fuel dock (e.g. "no changes", "same as last week", or an affirmative confirmation of the prices we asked about), return null prices with forward_to_human: false. If the email is completely unrelated to fuel pricing, return null prices with forward_to_human: true.
```

The `{price_context}` expands to something like: " The prices currently on file for this marina are: gas $5.99/gallon and diesel $5.69/gallon (a value of 9999.00 means this fuel type is not sold). Our outbound email asked the marina to confirm whether these prices are still current."

**Key prompt design decisions:**

- The web scraping prompt includes the "CRITICAL: Output ONLY raw JSON" prefix to discourage code fences. Haiku 4.5 does not reliably obey this, so both endpoints also strip fences programmatically.
- Both prompts inject the current date in Pacific time via a `$today_date` variable built with `now|format_timestamp:"m/d/Y":"America/Los_Angeles"`. This allows Claude to distinguish between closures that are in effect today versus closures announced for a future date. Without date context, Claude was incorrectly marking marinas as "Closed" when their websites mentioned upcoming holiday closures (e.g., Des Moines Marina showed "Closed" on Feb 14 because of a Presidents Day closure on Feb 16). The `closure_note` field captures ALL closure information (current and future) regardless of the `open` status, so future closure details are never lost.
- Rule 3 (open field) leads with the date check: "FIRST check dates: if the website mentions a closure for a FUTURE date after {today_date}..." This ordering is critical. An earlier version placed the descriptive closure examples before the future-closure exception, which caused Claude to pattern-match on closure keywords and write descriptive text before evaluating whether the closure was actually in effect today. Leading with the date check forces Claude to evaluate "is this today or future?" first.
- The `recheck_date` field (Rule 5) tells the `daily_closure_recheck` background task when to force a re-evaluation of the marina's status by clearing the content hash. Claude returns the next date the status should be re-evaluated: for a future closure, the start date; for a current closure with a known end date, the day after the last closed date; for indefinite closures or no closure info, null. This automates the hash-clearing process that previously required manual intervention when page content remained static but the closure status changed over time.
- The system prompt is built as a `$system_prompt` variable using single-quoted string segments joined with the `~` concatenation operator, rather than passed as an inline string to the Claude Function Pack. This is required because the prompt must include the dynamic `$today_date` value. See "XanoScript single-quote concatenation for dynamic prompts" in Section 19 for syntax details.
- Volume tier pricing uses the **lowest volume tier** (smallest number of gallons = highest per-gallon price). This is the base price shown in the app before volume discounts.
- `diesel_price` is the consumer-facing pump price WITH tax. For marinas with `price_processing_rule = "add_tax_diesel"` and `diesel_tax > 0`, both `apify_webhook` and `mailgun_inbound` automatically apply tax after Claude extraction: `diesel_price = raw_price * (1 + diesel_tax)`, rounded to 2 decimals. The raw pre-tax price is stored in `diesel_price_pretax`. Claude never calculates tax — it extracts whatever price the website/email shows, and Xano applies the tax rule post-extraction (v4.38). The `diesel_tax` field itself is maintained manually.
- The `open` field returns "Open" when the marina is operating normally, or a short descriptive closure reason when the marina is currently closed or not fully operational (e.g., "Closed for Presidents Day", "By appointment only until March", "Under repair - no ETA given"). It never returns bare "Closed" because app users need to see why a marina is closed. This descriptive approach replaced the earlier "Open"/"Closed" binary values so the Adalo closed marinas screen shows useful context.
- The `comment` field from Claude maps to `ai_comment` in the database to avoid overwriting Ken's manual notes in the `comment` field.
- The email prompt includes a fallback response structure for non-price emails (out of office, unrelated content).
- The email prompt includes a `forward_to_human` field (added in thread 4d). When true, the `mailgun_inbound` endpoint forwards the original email to Ken instead of writing to the database. This handles cases where a marina employee replies with a complaint, question, or unsubscribe request rather than price data. The counter is still reset since a reply was received.
- The email prompt distinguishes between "no changes" replies (forward_to_human: false, null prices) and completely unrelated emails (forward_to_human: true). This prevents "no changes" confirmations from being flagged for human review.
- The email prompt injects the marina's current on-file gas and diesel prices via a `$price_context` variable (v3.28). This gives Claude the context to understand that short affirmative replies like "Yup!", "Yes", or "Correct" are confirming those specific prices. Without this context, Claude saw only the one-word reply in isolation and had no way to know what was being confirmed, so it flagged the reply for human attention. The variable is built from `$FuelPrices1` (already loaded in Step 10) using `number_format:2:"."
:""` to format the prices. The sentinel value 9999.00 is noted in the context string so Claude does not treat it as a real price.
- The email prompt includes an explicit affirmative confirmation rule (v3.28) listing common short confirmations ("Yes", "Yup", "Correct", "That is right", "Same", "Yep", "Still the same", "No change", "Sure is", "Uh huh", "Yeppers") and instructing Claude to treat them as fuel-dock-related "no change" responses with null prices and `forward_to_human: false`. This works in tandem with the `$price_context` injection to handle the pattern where outbound emails ask "Are your prices still at $X for gas and $Y for diesel?" and the marina replies with a single-word affirmation.
- Fields like `diesel_tax`, `cash_card`, `vol_discount`, `gas_comment`, and `diesel_comment` are excluded from Claude's output because they are manually maintained and should not be overwritten by AI.

### Expected JSON Output

**Web scraping output:**

```json
{
  "gas_price": 5.15,
  "diesel_price": 4.89,
  "open": "Open",
  "closure_note": null,
  "recheck_date": null,
  "hours": "8am-5pm daily",
  "comment": "Cash and credit accepted"
}
```

**Email parsing output (includes forward_to_human field):**

```json
{
  "gas_price": 5.15,
  "diesel_price": 4.89,
  "open": "Open",
  "closure_note": null,
  "recheck_date": null,
  "hours": "8am-5pm daily",
  "comment": "Prices confirmed by harbormaster",
  "forward_to_human": false
}
```

**Call Notes Prompt (used in submit_call):**

A third prompt variant for parsing free-text notes entered during phone calls. Similar to the email and web scraping prompts but tailored for brief, informal notes. Does NOT extract prices (those come from form inputs). Does NOT include `forward_to_human` (the caller IS the human). Like the other prompts, the current Pacific date is injected via `$today_date`.

```
CRITICAL: Output ONLY raw JSON. Never use markdown, backticks, or code fences. Start your response with { and end with }. The current date is {today_date}. You are a marina fuel price extraction assistant. Extract status and operational data from phone call notes entered by a data collector after calling a marina. Respond ONLY with valid JSON, no other text. Use this exact structure: {"open": "Open", "closure_note": null, "recheck_date": null, "hours": null, "comment": null}. Rules: 1) open = FIRST check dates: if the notes mention a closure for a FUTURE date after {today_date}, the marina is still operating today so set to exactly "Open" with no additional words. Only if the marina is actually closed or not fully operational RIGHT NOW on {today_date} should you write a short user-facing reason (examples: "Closed for winter maintenance", "Closed for Presidents Day", "By appointment only until March", "Under repair - no ETA given"). Never write just "Closed" by itself because app users need to know why. If operating normally today or if unclear, set to exactly "Open". 2) closure_note = ANY closure information mentioned in the notes, whether current or future. Include the dates and reason. This field captures all closure details so nothing is lost. 3) recheck_date = If any date-specific closure or status change is mentioned (current or future), return the next date the status should be re-evaluated in MM/DD/YYYY format. For a closure starting on a future date, use that start date. For a closure currently in effect with a known end date, use the day after the last closed date. For indefinite closures ("closed until further notice") or no closure information at all, use null. 4) hours = fuel dock operating hours if mentioned. 5) comment = any other notable info from the call. Keep it concise.
```

**Call notes prompt expected output:**

```json
{
  "open": "Open",
  "closure_note": "Closing for winter Dec 1 through March",
  "recheck_date": "12/01/2026",
  "hours": null,
  "comment": "Spoke with harbormaster"
}
```

### When Claude is Called

Claude is only called when:

- **Web scraping (HTML or Javascript):** Content hash has changed (something is different on the page)
- **Email:** An inbound reply is received from a marina
- **Call notes:** The caller entered text in the Notes field during a phone call submission

Claude is NOT called on routine checks where nothing has changed. This keeps API costs low.

---

## 6. Database Schema

### FuelPrices Table (Primary)

The table name in Xano is `FuelPrices`. Below are all fields.

**Existing fields (from January, carried forward):**

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer (auto) | Xano auto-generated primary key |
| `fuel_dock` | text | Display name of the marina |
| `website` | text | URL of the marina's fuel page |
| `legal` | text (nullable) | Legal restrictions that affect how this marina can be monitored. Values: `DNC` = marina explicitly told us not to call (Do Not Call); `TOS no scrape` = marina's website Terms of Service prohibit automated scraping. Empty/null = no known legal restrictions. |
| `City` | text | City where the marina is located |
| `phone` | text | Marina phone number |
| `extension` | text | Phone extension if applicable |
| `Method` | text | How this marina is monitored (see Method values below) |
| `price_processing_rule` | text | Special parsing rules (e.g., "last_price" for Kingston) |
| `last_checked` | timestamp | Updated every time any system checks this marina |
| `last_updated` | timestamp | Updated only when actual data changes |
| `gas_price` | decimal | Current gasoline price |
| `diesel_price` | decimal | Current diesel price. A value of 9999 is the sentinel meaning "marina does not sell diesel" (used by Adalo to conditionally hide the diesel input section on the Call Detail screen). |
| `diesel_tax` | decimal | Diesel tax amount |
| `open` | text | Open/Closed status |
| `cash_card` | text | Whether pricing differs for cash vs. card (e.g., "same") |
| `vol_discount` | text | Whether volume discounts are available (YES/NO) |
| `gas_comment` | text (nullable) | Consumer-facing comment displayed below gas price on detail screen (e.g. "ETHANOL FREE"). Replaces the former `ethanol_free` column (removed v4.1). |
| `diesel_comment` | text (nullable) | Consumer-facing comment displayed below diesel price on detail screen. |
| `hours` | text | Fuel dock operating hours (free-text, e.g., "May-Sep: Daily 8:00am-6:00pm; Oct-Apr: Mon, Wed, Fri 9:00am-3:00pm, Tue and Thu Closed") |
| `hours_json` | json (nullable) | Structured weekly hours parsed from `hours` by the `parse_hours_json` nightly task via Claude Haiku. Format: `[{start_month, end_month, closed_days}]`. See v4.25 field description below. |
| `latitude` | decimal | GPS latitude |
| `longitude` | decimal | GPS longitude |
| `comment` | text | General notes (manual, not overwritten by AI) |

**New fields added in Step 1:**

| Field | Type | Description |
|-------|------|-------------|
| `last_content_hash` | text (nullable) | HMAC-SHA256 hash of last scraped page content, keyed with APIFY_WEBHOOK_TOKEN (change detection). Upgraded from MD5 in v3.14 (M5 remediation). |
| `css_selector` | text (nullable) | CSS selector for extracting the fuel section from the website (used by Apify actors) |
| `closure_note` | text (nullable) | Free text for closure details (e.g., "Closed until 02/09/2026") |
| `contact_email` | text (nullable) | Marina's email address for price check requests. **Changed from email type to text type in Step 5** because Xano's email field type does not support `==` query filtering in `db.query`. |
| `email_cadence` | integer (nullable) | Days between outbound price-check emails (default: 7) |
| `last_email_sent` | timestamp (nullable) | When the most recent price check email was sent |
| `last_email_response` | timestamp (nullable) | When the most recent email reply was received |
| `call_cadence` | integer (nullable) | Days between outbound price-check calls (default: 7) |
| `last_call` | timestamp (nullable) | When the most recent call attempt was made |
| `call_snooze_until` | timestamp (nullable) | Marina hidden from call list until this time (set by snooze buttons) |
| `last_call_connection` | timestamp (nullable) | When someone was last actually reached by phone |

**New fields added in Step 2:**

| Field | Type | Description |
|-------|------|-------------|
| `ai_comment` | text (nullable) | AI-generated notes from Claude parsing. Kept separate from `comment` to preserve Ken's manual notes. |

**New fields added in Step 6:**

| Field | Type | Description |
|-------|------|-------------|
| `email_subject` | text (nullable) | Custom email subject for outbound price checks. If empty, defaults to "Current fuel prices?" |
| `email_body` | text (nullable) | Custom email body template. Supports placeholders: `{{fuel_dock}}`, `{{gas_price}}`, `{{diesel_price}}`. Literal `\n` converted to newlines at send time. If empty, uses default template. |
| `consecutive_unanswered` | integer (nullable, default 0) | Tracks how many outbound emails have been sent without receiving a reply. Incremented by `send_price_check_email` Custom Function on each send. Reset to 0 by `mailgun_inbound` when any reply is received (price reply or forwarded-to-human). Used by `send_outbound_emails` task for escalating alerts (fires when >= 2). |

**New fields added post-Step 6 (closure automation):**

| Field | Type | Description |
|-------|------|-------------|
| `recheck_date` | date (nullable) | The next date the system should force a re-evaluation of this marina's status. Set by Claude when it detects date-specific closures (current or future). Cleared by the `daily_closure_recheck` task, which also clears `last_content_hash` to force a re-parse on the next scrape. Example: a Feb 16 Presidents Day closure sets `recheck_date` to `2026-02-16`; when the closure is in effect, Claude sets it to `2026-02-17` (the day after). |
| `suspend_until` | date (nullable) | Pauses outbound emails and calls for this marina until this date. Used for seasonal closures where scraping should continue (to catch early reopenings) but outbound contact should stop. Set manually by Ken or automatically by Claude when it detects a seasonal closure with a known reopen date. Cleared by the `daily_closure_recheck` task when the date passes. |

**New fields added in Step 12 (React Native consumer app, v4.0):**

| Field | Type | Description |
|-------|------|-------------|
| `youtube` | text (nullable) | YouTube video URL for this marina. Populated manually by Ken. When present, the React Native detail screen shows a red "YouTube" button that opens the URL via device Linking. When null/empty, the button is hidden. Added to the `marina_detail` endpoint field whitelist. |
| `gas_comment` | text (nullable) | Consumer-facing comment displayed below gas price on detail screen in bold #E33500 text (e.g. "ETHANOL FREE"). Replaces the former `ethanol_free` column. 43 marinas initially populated from ethanol_free data. Added v4.1. |
| `diesel_comment` | text (nullable) | Consumer-facing comment displayed below diesel price on detail screen in bold #E33500 text. Added v4.1. |

### Computed Fields (Not Persisted)

These fields are calculated at query time and returned in API responses but are not stored in the database.

| Field | Type | Used By | Description |
|-------|------|---------|-------------|
| `distance_mi` | decimal | `gas_prices_by_distance` #21, `diesel_prices_by_distance` #45 | Distance from the user's location to the marina in miles. Computed per-request using `util.geo_distance` (returns meters), then divided by 1609.34 and rounded to 1 decimal place. Only present in distance endpoint responses. |
| `last_updated_relative` | text | `closed_marinas` #18, `gas_price_low_to_high` #19, `diesel_price_low_to_high` #20, `gas_prices_by_distance` #21, `diesel_prices_by_distance` #45 | Human-readable relative timestamp computed per-request from `last_checked`. Formatted as "Updated X minutes/hours/days ago". Replaces exposing raw timestamps that could be used to fingerprint scraping schedules. |

### dialer_push_tokens Table (v4.6)

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer (auto) | Xano auto-generated primary key |
| `created_at` | timestamp | Auto-set on creation (default: `now`) |
| `expo_push_token` | text (trimmed) | Expo push token string (e.g., `ExponentPushToken[...]`). Unique index enforced. |

**Table ID:** 36. Stores Expo push tokens registered by FD Dialer app instances. No user association — the call queue is shared across all dialer users, so any registered device receives the same badge count. Tokens are auto-cleaned when the Expo Push API returns `DeviceNotRegistered` errors (handled in the `push_badge_update` background task). Created v4.6.

### app_version_log Table (v4.37)

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer (auto) | Xano auto-generated primary key |
| `device_id` | text (trimmed, unique index) | Anonymous UUID generated on first app launch, persisted on device via AsyncStorage. No permissions required. |
| `app_version` | text (trimmed) | App version string from `app.json`, e.g. "2.0.0" |
| `platform` | text (trimmed) | Device platform: "ios" or "android" |
| `last_seen` | timestamp (default: `now`) | Updated every time this device pings. Used to filter stale installs (30-day window). |

**Table ID:** 43. Tracks app version adoption across the anonymous install base. Each device generates a random UUID on first launch and sends it with every version ping. The `device_id` unique index enables upsert behavior — existing devices update their `app_version`, `platform`, and `last_seen` on each session. Stale devices (not seen in 30 days) are excluded from stats queries. Created v4.37.

**Indexes:** Primary on `id`, unique btree on `device_id`, btree on `app_version` (ASC), btree on `last_seen` (DESC).

### Method Field Values

The Method field determines how each marina's pricing data is collected:

| Value | Actor/Tool | Count | Description |
|-------|-----------|-------|-------------|
| `HTML` | Apify Cheerio actor | 12 | Static HTML sites where prices are in the raw page source |
| `Javascript` | Apify Playwright actor | 5 | Sites where prices are loaded dynamically by JavaScript, or sites that block Cheerio with 403 errors |
| `Email` | Mailgun | TBD | Marinas contacted via automated email requests |
| `Call` | Adalo data entry | TBD | Marinas contacted by phone with manual data entry |
| `MFD` | My Fuel Dock (myfueldock.com) | TBD | Marina self-maintains prices via the My Fuel Dock portal, mobile app, or email. Apify scraping, outbound emails, and call queue all skip these records. See My Fuel Dock system design doc. |

**Migration note:** Existing records with Method = "Distill" were changed to "HTML" in Step 1. One record (Port Orchard Marina, id=28) was changed from "Call VM" to "Call" with a comment noting that prices are available in the voicemail greeting. Five marinas originally set to "HTML" were moved to "Javascript" in Step 3 after Cheerio returned HTTP 403 errors (Seattle Boat Newport id=22, Point Roberts Marina id=19, Skyline Marine Center id=18, Seattle Boat Lake Union id=21, Port of Anacortes id=5). Rosario Resort (id=24) was changed from Method = "DNC" to Method = "Call" in v4.18, with the DNC restriction moved to the new `legal` field.

### Legal Field Values

The `legal` field tracks legal restrictions that affect how a marina can be monitored. It was added in v4.18 after a TOS review of all scraped marina websites.

| Value | Meaning | Effect |
|-------|---------|--------|
| *(empty/null)* | No known legal restrictions | Marina can be monitored normally per its Method |
| `DNC` | Do Not Call — marina explicitly instructed us not to call | Marina remains Method = "Call" but should not be contacted by phone. The DNC instruction came from the marina operator directly. |
| `TOS no scrape` | Website Terms of Service prohibit automated scraping | Marina's website has explicit anti-scraping language in its TOS. Scraping should not be performed; use Email or Call instead. |

**Current assignments (v4.18):**
- `DNC`: Rosario Resort (id=24) — operator threatened to call police if called again
- `TOS no scrape`: Skyline Marine Center (id=18), Seattle Boat Lake Union (id=21), Seattle Boat Newport (id=22) — seattleboat.com and skylinemarinecenter.com TOS explicitly prohibit robots, spiders, and scraping

**TOS review (v4.18):** All Method = "HTML" and Method = "Javascript" marina websites were reviewed for Terms of Service and robots.txt restrictions. Government/public port websites (Port of Anacortes, Port of Everett, Oak Harbor, Port of Edmonds, Swantown/Port of Olympia, Port of Brownsville, Port of Kingston) had no TOS. Private marina sites (Des Moines Marina, Foss Harbor, Semiahmoo, Blakely Island, Tacoma Fuel Dock, Point Roberts Marina, Port of Poulsbo) either had no TOS or had terms that did not restrict scraping. Only seattleboat.com and skylinemarinecenter.com had explicit anti-scraping TOS language.

---

## 7. API Endpoints

### Existing (January, Carrying Forward)

| Endpoint | Method | # | Tag | Description |
|----------|--------|---|-----|-------------|
| `closed_marinas` | GET | #18 | adalo apis | Returns marinas with closed status to Adalo. H1 hardened: field whitelist, 60s cache, relative timestamps. |
| `gas_price_low_to_high` | GET | #19 | adalo apis | Gas prices sorted ascending for Adalo. H1 hardened: field whitelist, 60s cache, relative timestamps. |
| `diesel_price_low_to_high` | GET | #20 | adalo apis | Diesel prices sorted ascending for Adalo. H1 hardened: field whitelist, 60s cache, relative timestamps. |
| `gas_prices_by_distance` | GET | #21 | adalo apis | Gas prices sorted by distance (nearest-first) for Adalo. H1 hardened: field whitelist, 60s cache, relative timestamps. Sort direction corrected from farthest-first to nearest-first during H1 remediation. |
| `marina_detail` | GET | #46 | adalo apis | Returns a single marina record by ID for the consumer app detail screens. Accepts `id` query parameter. Uses H1 field whitelist (22 fields: the standard 21 plus `youtube`; updated v4.1 to replace `ethanol_free` with `gas_comment` and `diesel_comment`). Computes `last_updated_relative` from `last_checked`. 60s cache. Created v3.24, originally unused by Adalo (list row data passed directly via Link actions). Now actively called by the React Native/Expo consumer app's detail screen (v4.0). |
| `map_marinas` | GET | #48 | adalo apis | Returns ALL marinas (no status or price filters) for the Adalo Map component. Uses same H1 field whitelist as other consumer endpoints. Sorted alphabetically by `fuel_dock`. Computes `last_updated_relative` from `last_checked`. 60s cache. No auth required. Powers the in-app map screen where each pin links to the Gas Detail screen. Created v3.27. |

These endpoints were H1 hardened in February 2026 with response field whitelisting (20 display fields, 18 internal fields excluded), 60-second response caching, and server-side relative timestamp computation. See Section 8.9 for full details.

### Retired (January)

| Endpoint | Method | Description | Status |
|----------|--------|-------------|--------|
| `airtable_webhook` | POST | Received manual price updates from Airtable | Deleted in Step 3 |

### New (February)

| Endpoint | Method | Tag | # | Description |
|----------|--------|-----|---|-------------|
| `apify_webhook` | POST | Fuel Docks API | #36 | Receives scraped content from both Apify actors. Validates webhook token, updates last_checked, computes hash, conditionally calls Claude Function Pack. Includes Try/Catch error handling with Mailgun alerts. |
| `apify_marina_list` | GET | Fuel Docks API | #38 | Returns marinas for Apify scraping. Inputs: `token` (text, required), `method` (text, default "HTML"), and `id` (int, optional). When `id` is provided and > 0, returns a single-item array for that marina (used by `report_price` triggered single-marina runs). When `id` is absent or 0, returns all marinas matching the given Method (used by scheduled batch runs). Output shape is always an array of `{id, fuel_dock, website, css_selector}`. Uses early `return` for the single-marina path; batch query at stack top level. Validates `token` against `$env.APIFY_WEBHOOK_TOKEN`; returns HTTP 403 if invalid (H2 remediation). |
| `mailgun_inbound` | POST | Fuel Docks API | #39 | Receives parsed inbound email data from Mailgun. Verifies request authenticity via HMAC-SHA256 signature check using MAILGUN_SIGNING_KEY. Looks up marina by sender's contact_email. Calls Claude Function Pack to extract prices from email body. Updates database with prices and timestamps. Resets `consecutive_unanswered` to 0 on any reply. Forwards non-price emails to Ken via "RESPONSE REQUIRES ATTENTION" alert. Includes Try/Catch error handling with Mailgun alerts. |
| `send_outbound_email` | POST | Fuel Docks API | #40 | Sends a price check email to a single marina by ID. Validates API token for Adalo-to-Xano authentication (must match FD_API_TOKEN env var). Thin wrapper that calls the shared `send_price_check_email` Custom Function. Used for manual single-marina sends. Originally built as `test_outbound_email` in thread 4d as a full standalone endpoint (93 lines of XanoScript including database lookup, template selection, placeholder replacement, newline conversion, and Mailgun send). Renamed to `send_outbound_email` for production, then refactored to an 18-line thin wrapper when the shared logic was extracted into the `send_price_check_email` Custom Function in Step 6. Changed from GET to POST and added FD_API_TOKEN authentication per security audit C3 (February 2026). |
| `call_queue` | GET | Fuel Docks API | #42 | Returns Method=Call marinas currently due for a call, sorted by most stale `last_updated`. Powers the FD Dialer Adalo app. Filters on six conditions: Method, DNC legal exclusion (v4.19), snooze expiry, recheck_date, suspend_until, and cadence timing. Cadence only applies to successfully connected marinas (v3.17 fix). Also returns `next_call_due` timestamp for the completion screen when the queue is empty. Validates API token for Adalo-to-Xano authentication (must match FD_API_TOKEN or DIALER_API_TOKEN env var). Added per security audit H3 (February 2026). |
| `snooze_call` | POST | Fuel Docks API | #43 | Snoozes a marina call for 1 hour or until tomorrow at 12:01 AM Pacific. Accepts marina_id (text, cast to int internally) and snooze_type ("1hour" or "tomorrow"). All inputs are text because Adalo Custom Actions cannot send unquoted values in JSON bodies. Validates API token for Adalo-to-Xano authentication (must match FD_API_TOKEN env var). Includes guard clause that returns null for empty/zero marina_id (allows Adalo test requests to succeed). Records the call attempt in last_call but does not update last_call_connection since no one was reached. |
| `submit_call` | POST | Fuel Docks API | #44 | Processes a completed call. Validates API token for Adalo-to-Xano authentication. All inputs are text because Adalo Custom Actions cannot send unquoted values in JSON bodies; numeric values are cast to int/decimal internally. Accepts marina_id (text, cast to int), optional gas_price (text, cast to decimal), optional diesel_price (text, cast to decimal), diesel_tax_included (text, cast to decimal: the percentage tax rate to apply via multiplication, or "0" if no tax addition needed), and optional notes (text). Includes guard clause that returns null for empty/zero marina_id (allows Adalo test requests to succeed). Input validation rejects prices outside $2-$15 range. Performs diesel tax addition by multiplying diesel_price by (1 + rate) when diesel_tax_included > 0. Calls Claude Function Pack with call-notes prompt only when notes text is provided (does not extract prices via Claude); Claude call wrapped in Try/Catch with Mailgun error alerting. Compares submitted prices against current database values: `last_checked` always advances (confirms contact was made), but `last_updated` only advances when gas or diesel price actually changed. Updates FuelPrices record with prices, diesel_tax rate, Claude-parsed status fields, timestamps, and clears call_snooze_until. |
| `diesel_prices_by_distance` | GET | adalo apis | #45 | Diesel prices sorted by distance (nearest-first) for Adalo. Mirrors `gas_prices_by_distance` but filters on `diesel_price` instead of `gas_price`. H1 hardened: field whitelist, 60s cache, relative timestamps. Created during H1 remediation (February 2026). |
| `register_push_token` | POST | Fuel Docks API | #51 | Registers an Expo push token for badge update notifications. Accepts `api_token` (text) and `expo_push_token` (text, trimmed). Validates token against `$env.FD_API_TOKEN` or `$env.DIALER_API_TOKEN`. Checks if the token already exists in `dialer_push_tokens` table; inserts only if new (upsert pattern). Returns `{success: true}`. No cache, no request history. Created v4.6. |
| `version_ping` | POST | Fuel Docks API | #82 | Logs the app version for each anonymous device. Accepts `device_id` (text), `app_version` (text), `platform` (text). Upserts `app_version_log` table by `device_id`: creates a new record if the device is new, updates `app_version`, `platform`, and `last_seen` if it already exists. Returns `{status: "ok"}`. No authentication required. Called once per app session from `_layout.tsx` on launch (fire-and-forget). No request history logging. Created v4.37. |
| `version_stats` | GET | Fuel Docks API | #83 | Returns version adoption stats grouped by `app_version` and `platform`. Only counts devices whose `last_seen` is within the last 30 days (2,592,000 seconds). Response: `{versions: [{app_version, count, ios, android}, ...]}`. No authentication required. No request history logging. Created v4.37. |
| `report_price` | POST | Fuel Docks API | #47 | Receives price correction reports from consumer app users. Does NOT write reported prices to the database. Sends alert email to Ken via mg.fueldocks.app, then triggers automated re-verification based on the marina's Method: Apify single-marina actor run (HTML/Javascript), call queue reset via `last_call_connection` null (Call), immediate price check email to marina contact (Email), or no automated action (Facebook). Inputs: `api_token` (text, required), `marina_id` (text, cast to int), `gas_price` (text, optional, cast to decimal, validated $2-$15), `diesel_price` (text, optional, cast to decimal, validated $2-$15), `comments` (text, optional). All inputs are text for Adalo compatibility. Validates against `$env.CONSUMER_API_TOKEN` (separate from FD_API_TOKEN so consumer-facing and admin tokens can be rotated independently). Guard clause returns null for marina_id=0 (Adalo test requests). Requires at least one data field (gas_price, diesel_price, or comments). Created March 2026. |

### Custom Functions (Library > Functions > Fuel Docks)

| Function | Description |
|----------|-------------|
| `send_price_check_email` | Shared logic for sending a price check email to a single marina. Input: `marina_id` (integer). Looks up marina record, formats prices to two decimal places via `number_format` filter, builds subject (custom from `email_subject` or default "Current fuel prices?"), builds body (custom from `email_body` with placeholder replacement or default template), replaces `{{fuel_dock}}`, `{{gas_price}}`, `{{diesel_price}}` placeholders, converts literal `\n` to real newlines, sends via Mailgun API (navigatorpnw.com domain, from ken@navigatorpnw.com) authenticated via `MAILGUN_KEY_NAVIGATOR` (navigatorpnw.com Domain Sending Key) with `o:store=yes` to enable Quick View and MIME tab content in Mailgun logs, updates `last_email_sent` timestamp, increments `consecutive_unanswered` counter. Returns updated FuelPrices record. Called by both `send_outbound_email` endpoint and `send_outbound_emails` Background Task. Published February 12, 2026. |
| `validate_claude_output` (ID 37) | H4 Security: Validates and sanitizes Claude AI output before database writes to prevent prompt injection attacks. Inputs: `gas_price`, `diesel_price`, `open`, `closure_note`, `recheck_date`, `hours`, `comment` (from Claude), plus `current_gas_price` and `current_diesel_price` (from existing DB record for spike detection). Returns validated fields plus `has_flags` (boolean) and `flag_summary` (text for alert emails). See Section 8.10 for full spec. Called by `apify_webhook` and `mailgun_inbound`. Published February 28, 2026. |

### send_price_check_email Custom Function XanoScript

```xanoscript
// Shared logic for sending a price check email to a single marina. Builds subject/body from custom or default template, replaces placeholders, sends via Mailgun, updates last_email_sent, increments consecutive_unanswered counter. Called by send_outbound_email endpoint and send_outbound_emails Background Task.
function "Fuel Docks/send_price_check_email" {
  input {
    // ID of the FuelPrices record to send an outbound price check email to
    int marina_id
  }

  stack {
    // Look up the marina record by ID
    db.get FuelPrices {
      field_name = "id"
      field_value = $input.marina_id
    } as $FuelPrices1

    // Stop if no contact email is set for this marina
    precondition ($var.FuelPrices1.contact_email != "") {
      error_type = "badrequest"
      error = "No contact_email set for this marina"
    }

    // Format prices to two decimal places for display in emails (e.g., 4.5 becomes 4.50)
    var $formatted_gas_price {
      value = $FuelPrices1.gas_price|number_format:2:".":""
    }

    var $formatted_diesel_price {
      value = $FuelPrices1.diesel_price|number_format:2:".":""
    }

    // Set email subject - use custom if defined, otherwise default
    var $email_subject {
      value = "Current fuel prices?"
    }
    conditional {
      if ($var.FuelPrices1.email_subject != "") {
        var.update $email_subject {
          value = $var.FuelPrices1.email_subject
        }
      }
    }

    // Set email body - use custom if defined, otherwise default generic template
    var $email_body {
      value = "Hi,\n\nI currently have {{fuel_dock}} listed at {{gas_price}} for gas and {{diesel_price}} for diesel at the fuel dock. Are these still accurate?\n\nThank you!\n-Ken"
    }
    conditional {
      if ($var.FuelPrices1.email_body != "") {
        var.update $email_body {
          value = $var.FuelPrices1.email_body
        }
      }
    }

    // Replace placeholders with actual marina data values (using formatted prices for clean display)
    var.update $email_body {
      value = $email_body|replace:"{{gas_price}}":$formatted_gas_price|replace:"{{diesel_price}}":$formatted_diesel_price|replace:"{{fuel_dock}}":$FuelPrices1.fuel_dock
    }

    // Replace literal \n with actual newline characters
    var.update $email_body {
      value = $var.email_body|replace:"\\n":"\n"
    }

    // Build Mailgun auth string for sending marina outbound emails via navigatorpnw.com Domain Sending Key
    var $mailgun_auth {
      value = "api:" ~ $env.MAILGUN_KEY_NAVIGATOR
    }

    // Send outbound price check email via Mailgun. o:store=yes enables message content storage
    // so Mailgun log Quick View and MIME tabs are populated for debugging and audit review.
    api.request {
      url = "https://api.mailgun.net/v3/navigatorpnw.com/messages"
      method = "POST"
      params = {}|set:"from":"Ken Clements <ken@navigatorpnw.com>"|set:"to":$var.FuelPrices1.contact_email|set:"subject":$var.email_subject|set:"text":$var.email_body|set:"o:store":"yes"
      headers = []|push:"Authorization: Basic " ~ ($var.mailgun_auth|base64_encode)
    } as $mailgun_response

    // Calculate new consecutive_unanswered count (default to 0 if null, then add 1)
    var $new_unanswered {
      value = 0
    }
    conditional {
      if ($var.FuelPrices1.consecutive_unanswered != null) {
        var.update $new_unanswered {
          value = $var.FuelPrices1.consecutive_unanswered + 1
        }
      }
      else {
        var.update $new_unanswered {
          value = 1
        }
      }
    }

    // Update last_email_sent timestamp and increment unanswered counter
    db.edit FuelPrices {
      field_value = $var.FuelPrices1.id
      data = {last_email_sent: now, consecutive_unanswered: $var.new_unanswered}
    } as $updated_record
  }

  response = $updated_record
}
```

### send_outbound_email Endpoint Detail

The `send_outbound_email` endpoint (#40) sends a price check email to a single marina by ID. It is a thin wrapper that calls the shared `send_price_check_email` Custom Function. It lives in the "Fuel Docks API" group.

**Authentication:** Uses the same FD_API_TOKEN precondition pattern as `submit_call` and `snooze_call`. The `api_token` input is validated against the `FD_API_TOKEN` environment variable before any processing occurs. Requests with a missing or incorrect token receive HTTP 403 "Unauthorized" immediately. Added per security audit C3 (February 2026).

### send_outbound_email Endpoint XanoScript

```xanoscript
// Send an outbound price check email to a specific marina by ID. Calls the shared send_price_check_email Custom Function. Requires FD_API_TOKEN for authentication. Changed from GET to POST per security audit C3.
query send_outbound_email verb=POST {
  api_group = "Fuel Docks API"

  input {
    // Shared secret token for authentication (must match FD_API_TOKEN env var)
    text api_token filters=trim

    // ID of the FuelPrices record to send an outbound price check email to
    int marina_id
  }

  stack {
    // Security: Reject requests without valid API token before any processing occurs (C3 remediation)
    precondition ($input.api_token == $env.FD_API_TOKEN) {
      error_type = "accessdenied"
      error = "Unauthorized"
    }

    // Call the shared Custom Function that handles all send logic
    function.run "Fuel Docks/send_price_check_email" {
      input = {marina_id: $input.marina_id}
    } as $result
  }

  response = $result
}
```

### Background Tasks (Tasks section)

| Task | Schedule | Description |
|------|----------|-------------|
| `trigger_apify_scrapers` | Every 3 hours, 6am-9pm Pacific (starts_on: 2026-03-08 13:00 UTC, freq: 10800) | Queries FuelPrices for HTML and Javascript method marinas via `apify_marina_list` endpoint. Triggers Cheerio and Playwright actors via Apify API. Try/catch per actor. |
| `send_outbound_emails` | Daily at 10am Pacific, Mon-Fri (starts_on: 2026-03-08 17:00 UTC, freq: 86400) | Loops all FuelPrices records, filters for Method=Email with contact_email in the loop. Skips weekends (Saturday/Sunday) via early return. Skips marinas where `suspend_until` is not null and the date has not yet passed (seasonal closure hold). Uses date-based cadence: adds cadence days to the most recent of `last_email_sent` or `last_email_response` (whichever is later), formats as `Y-m-d` Pacific, sends if due date <= today (v3.18). If both are null, due immediately. Default cadence 7 days. Calls `send_price_check_email` Custom Function per marina. Try/catch per marina. Sends escalating alert to ken@navigatormktg.com when `consecutive_unanswered` >= 2 after each send. |
| `daily_closure_recheck` | Daily at midnight Pacific (starts_on: 2026-03-08 07:00 UTC, freq: 86400) | Proactively reopens marinas whose closure period has passed (sets `open` to "Open" immediately). Clears `last_content_hash` and `recheck_date` for marinas where `recheck_date` <= today (forces Claude re-parse on next scrape). Clears `suspend_until` for marinas where the suspension date has passed (resumes outbound contact). Runs at midnight for clean beginning-of-day status transitions. |
| `daily_call_report` | Daily at 2:00 AM Pacific (starts_on: 2026-03-08 09:00 UTC, freq: 86400) | Sends a daily email to ken@navigatormktg.com listing all Method=Call marinas currently due for a call. Applies identical four-filter logic as the `call_queue` endpoint (snooze, recheck_date, suspend_until, cadence). **PARITY GAP (v4.19):** Does not yet include the DNC exclusion filter added to `call_queue` in v4.19. Marinas listed numbered in last-updated-ascending order. Always sends even on zero-due days. No weekend skip. Subject: "Fuel Docks - # calls to make today". 09:00 UTC = 2:00 AM PDT, no DST adjustment needed. See Section 9.7. |
| `daily_tos_check` | Daily at 1:00 AM Pacific (starts_on: 2026-03-19 08:00 UTC, freq: 86400) | Checks scraped marinas (Method = "HTML" or "Javascript") with blank `legal` field for TOS/robots.txt restrictions. Fetches website + robots.txt, sends to Claude Haiku for analysis. Emails ken@navigatormktg.com with prescriptive instructions (set `legal` to "TOS no scrape" or "OK"). Never writes to the database directly. Most nights exits immediately (no blank `legal` fields). See Section 9.11. |

**Xano API base URL:** `https://xlba-eg1u-i4nx.n7e.xano.io/api:-GTDJqKH/`

---

## 8. apify_webhook Endpoint Detail

The `apify_webhook` endpoint (#36) is the core data processing pipeline. It lives in the "Fuel Docks API" group.

### Webhook Authentication

The endpoint is protected by a shared secret token. Apify actors include a `webhook_token` field in the POST body, and Xano validates it against the `APIFY_WEBHOOK_TOKEN` environment variable using a precondition at the top of the function stack. If the token is missing or does not match, Xano returns a 401 error immediately.

**Why token is in the POST body instead of an HTTP header:** Xano's `util.get_raw_input` (used for webhook endpoints) captures the POST body but does not reliably expose HTTP request headers via `$webhook1._headers`. Sending the token as a field in the JSON body ensures it is always accessible to the function stack. This was discovered during implementation when header-based authentication caused "Not numeric" precondition errors.

### Webhook Input

Apify actors POST JSON with four fields:

```json
{
  "marina_id": 5,
  "scraped_content": "Fuel Prices DIESEL < 100 $4.08 ...",
  "scrape_url": "https://www.portofanacortes.com/marina/fuel-dock/",
  "webhook_token": "(shared secret)"
}
```

### Function Stack

```
1. Get All Raw Input                    --> webhook1
     Description: Receive JSON POST from Apify actor

2. Precondition                         (Token validation)
     Condition: $webhook1.webhook_token == $env.APIFY_WEBHOOK_TOKEN
     Error type: accessdenied
     Error message: Unauthorized
     Description: Reject requests without valid webhook token

3. Create Variable: marina_id           --> marina_id
     Value: $webhook1.marina_id | to_int
     Description: Convert marina_id from string to integer (raw input delivers all values as strings)

4. Create Variable: content_hash        --> content_hash
     Value: $webhook1.scraped_content | hmac_sha256:$env.APIFY_WEBHOOK_TOKEN:false
     Description: M5 Security: SHA-256 hash for content change detection (replaces MD5, March 2026)

5. Get Record From FuelPrices           --> FuelPrices1
     Lookup by id = $marina_id
     Description: Fetch current marina record for comparison

6. Conditional
     IF FuelPrices1.last_content_hash != null AND content_hash == FuelPrices1.last_content_hash:
       6.1 Edit Record In FuelPrices    --> FuelPrices2
             field_name = "id"
             field_value = $FuelPrices1.id  (MUST be var type, not text)
             data: { id, last_checked: now }
             Description: No content change, update last_checked only
       6.2 Return {"status": "no_change"}

     ELSE:
       6.3 Create Variable: today_date  --> today_date
             Value: now|format_timestamp:"m/d/Y":"America/Los_Angeles"
             Description: Get current date in Pacific time for Claude closure logic

       6.4 Create Variable: system_prompt --> system_prompt
             Value: (single-quoted segments concatenated with ~ operator, injecting $today_date)
             Description: Build date-aware system prompt for Claude

       6.5 Try / Catch                  Description: Error handling for Claude parsing
         TRY:
           6.5.1 Custom Function: Create chat completion - Claude (Synchronous)  --> func1
                 model: claude-haiku-4-5
                 max_tokens: 1024
                 system: $system_prompt
                 prompt: $var.webhook1.scraped_content
                 temperature: 0
                 Description: Content changed, call Claude to extract pricing

           6.5.2 Create Variable: parsed_response  --> parsed_response
                 Value: $var.func1.result.content[0].text|replace:"```json":""|replace:"```":""|trim|json_decode
                 Description: Strip markdown code fences, trim whitespace, decode JSON

           6.5.3 Custom Function: Fuel Docks/validate_claude_output  --> validated
                 Inputs: gas_price, diesel_price, open, closure_note, recheck_date, hours,
                         comment from $parsed_response; current_gas_price and
                         current_diesel_price from $FuelPrices1
                 Description: H4 Security -- validate and sanitize Claude output before DB write (see Section 8.10)

           6.5.4 Conditional: H4 flag alert email
                 IF $validated.has_flags == true:
                   Build and send Mailgun alert with subject "Fuel Docks H4 Flag: [marina name]"
                   Body includes marina name, ID, scrape URL, and $validated.flag_summary
                   Description: Alert Ken when validation detects anomalies (price out of range, spike, bad open field, truncation)

           6.5.5 Edit Record In FuelPrices  --> FuelPrices3
                 field_name = "id"
                 field_value = $FuelPrices1.id  (MUST be var type, not text)
                 data: { id, last_checked: now, last_updated: now,
                         gas_price, diesel_price, open, closure_note,
                         recheck_date, hours, last_content_hash, ai_comment }
                 **All fields sourced from $validated, not $parsed_response**
                 Description: Write validated Claude results to database

           6.5.6 Return {"status": "updated"}

         CATCH:
           6.5.7 Create Variable: mailgun_auth  --> mailgun_auth
                 Value: "api:" ~ $env.MAILGUN_API_KEY
                 Description: Build Mailgun Basic Auth credentials

           6.5.8 Create Variable: error_subject  --> error_subject
                 Value: "Fuel Docks Alert: " ~ $FuelPrices1.fuel_dock ~ " (ID " ~ $webhook1.marina_id ~ ")"
                 Description: Dynamic email subject with marina name and ID

           6.5.9 Create Variable: error_body  --> error_body
                 Value: (see XanoScript below for full template)
                 Description: Detailed error email body with endpoint, marina info, and error details

           6.5.10 External API Request to Mailgun  --> api1
                 POST https://api.mailgun.net/v3/mg.fueldocks.app/messages
                 params: from, to, subject ($error_subject), text ($error_body)
                 headers: Authorization Basic (mailgun_auth | base64_encode)
                 Description: Send error alert email via Mailgun

           6.5.11 Return {"status": "error"}
```

### Full XanoScript

```xanoscript
query apify_webhook verb=POST {
  api_group = "Fuel Docks API"

  input {
  }

  stack {
    util.get_raw_input {
      encoding = "json"
      exclude_middleware = false
    } as $webhook1

    precondition ($webhook1.webhook_token == $env.APIFY_WEBHOOK_TOKEN) {
      error_type = "accessdenied"
      error = "Unauthorized"
    }

    var $marina_id {
      value = $webhook1.marina_id|to_int
    }

    // M5 Security: SHA-256 hash for content change detection (replaces MD5, March 2026)
    // Uses HMAC-SHA256 keyed with webhook token for stronger collision resistance
    // Note: first run after this change will trigger Claude calls for all marinas (one-time hash mismatch)
    var $content_hash {
      value = $webhook1.scraped_content|hmac_sha256:$env.APIFY_WEBHOOK_TOKEN:false
    }

    db.get FuelPrices {
      field_name = "id"
      field_value = $marina_id
    } as $FuelPrices1

    conditional {
      if ($FuelPrices1.last_content_hash != null && $content_hash == $FuelPrices1.last_content_hash) {
        db.edit FuelPrices {
          field_name = "id"
          field_value = $FuelPrices1.id
          data = {id: $FuelPrices1.id, last_checked: now}
        } as $FuelPrices2

        return {
          value = '{"status": "no_change"}'
        }
      }

      else {
        // Get current date in Pacific time for Claude closure logic
        var $today_date {
          value = now|format_timestamp:"m/d/Y":"America/Los_Angeles"
        }

        // Build date-aware system prompt using single-quote concatenation (no escaped quotes)
        // Rule 3 (open field): date check comes FIRST to prevent future closures from being marked closed today
        // Rule 4 (closure_note): captures all closure info regardless of timing
        // Rule 5 (recheck_date): tells the system when to force re-evaluation of this marina
        var $system_prompt {
          value = 'CRITICAL: Output ONLY raw JSON. Never use markdown, backticks, or code fences. Start your response with { and end with }. The current date is ' ~ $today_date ~ '. You are a marina fuel price extraction assistant. Extract fuel pricing data from scraped marina website content. Respond ONLY with valid JSON, no other text. Use this exact structure: {"gas_price": null, "diesel_price": null, "open": "Open", "closure_note": null, "recheck_date": null, "hours": null, "comment": null}. Rules: 1) gas_price = price per gallon of gasoline at the lowest volume tier (smallest number of gallons, which is the highest per-gallon price). This is the base price before volume discounts. Use null if not listed. 2) diesel_price = price per gallon of diesel BEFORE tax at the lowest volume tier (smallest number of gallons, highest per-gallon price). Use null if not listed. 3) open = FIRST check dates: if the website mentions a closure for a FUTURE date after ' ~ $today_date ~ ', the marina is still operating today so set to exactly "Open" with no additional words. Only if the marina is actually closed or not fully operational RIGHT NOW on ' ~ $today_date ~ ' should you write a short user-facing reason (examples: "Closed for winter maintenance", "Closed for Presidents Day", "By appointment only until March", "Under repair - no ETA given"). Never write just "Closed" by itself because app users need to know why. If operating normally today, set to exactly "Open". 4) closure_note = ANY closure information mentioned on the page, whether current or future. Include the dates and reason. This field captures all closure details so nothing is lost. 5) recheck_date = If any date-specific closure or status change is mentioned (current or future), return the next date the status should be re-evaluated in MM/DD/YYYY format. For a closure starting on a future date, use that start date. For a closure currently in effect with a known end date, use the day after the last closed date. For indefinite closures ("closed until further notice") or no closure information at all, use null. 6) hours = fuel dock operating hours if listed. 7) comment = any other notable info. All prices must be decimal numbers like 4.08, not strings.'
        }

        try_catch {
          try {
            function.run "Create chat completion -  Claude" {
              input = {
                model         : "claude-haiku-4-5"
                max_tokens    : 1024
                system        : $system_prompt
                prompt        : `$var.webhook1.scraped_content`
                temperature   : 0
                top_k         : null
                top_p         : null
                stop_sequences: null
                image         : null
                image2        : null
              }
            } as $func1

            var $parsed_response {
              value = $func1.result.content[0].text
                |replace:"```json":""
                |replace:"```":""
                |trim
                |json_decode
            }

            db.edit FuelPrices {
              field_name = "id"
              field_value = $FuelPrices1.id
              data = {
                id               : $FuelPrices1.id
                last_checked     : now
                last_updated     : now
                gas_price        : $parsed_response.gas_price
                diesel_price     : $parsed_response.diesel_price
                open             : $parsed_response.open
                closure_note     : $parsed_response.closure_note
                recheck_date     : $parsed_response.recheck_date
                hours            : $parsed_response.hours
                last_content_hash: $content_hash
                ai_comment       : $parsed_response.comment
              }
            } as $FuelPrices3

            return {
              value = '{"status": "updated"}'
            }
          }

          catch {
            var $mailgun_auth {
              value = "api:" ~ $env.MAILGUN_API_KEY
            }

            var $error_subject {
              value = "Fuel Docks Alert: " ~ $FuelPrices1.fuel_dock ~ " (ID " ~ $webhook1.marina_id ~ ")"
            }

            var $error_body {
              value = "Xano Endpoint: apify_webhook\nMarina: " ~ $FuelPrices1.fuel_dock ~ "\nMarina ID: " ~ $webhook1.marina_id ~ "\nScrape URL: " ~ $webhook1.scrape_url ~ "\n\nError Type: " ~ $func1.result.error.type ~ "\nError Message: " ~ $func1.result.error.message ~ "\nHTTP Status: " ~ $func1.status
            }

            api.request {
              url = "https://api.mailgun.net/v3/mg.fueldocks.app/messages"
              method = "POST"
              params = {}
                |set:"from":"Fuel Docks Alerts <alerts@mg.fueldocks.app>"
                |set:"to":"ken@navigatormktg.com"
                |set:"subject":$error_subject
                |set:"text":$error_body
              headers = []
                |push:("Authorization: Basic %s"
                  |sprintf:($mailgun_auth|base64_encode)
                )
            } as $api1

            return {
              value = '{"status": "error"}'
            }
          }
        }
      }
    }
  }

  response = $webhook1
}
```

### Important Implementation Notes

- **Webhook token in POST body:** The `webhook_token` field is sent in the JSON body (not as an HTTP header) because Xano's `util.get_raw_input` does not reliably expose HTTP headers. The precondition checks `$webhook1.webhook_token` against `$env.APIFY_WEBHOOK_TOKEN`.
- **marina_id type conversion:** The `util.get_raw_input` function delivers all JSON values as strings, even numbers. The `marina_id` must be converted to an integer via a separate `var $marina_id` step with the `|to_int` filter before it can be used in `db.get`. Applying `|to_int` inline on the `db.get field_value` line does not work reliably; always use a separate variable.
- **field_value in Edit Record**: Must be set to `$FuelPrices1.id` as a **variable type** (not text type). In the Xano Stack UI, the dropdown next to the value must show "var: any", not "text". If set as text, Xano treats `$FuelPrices1.id` as a literal string and throws "Missing param: field_value" or "Value is not a valid integer" errors.
- **id field in data section**: Same rule applies -- the `id` field inside the data object of Edit Record must also be set as variable type referencing `$FuelPrices1.id`, not a text string.
- **ai_comment vs comment**: Claude's `comment` output maps to the `ai_comment` database field. The `comment` field is reserved for Ken's manual notes and is never overwritten by AI.
- **parsed_response path**: The Claude Function Pack returns a nested object. Claude's text response is at `$var.func1.result.content[0].text`. The `content` field is an array (even though it typically has only one element), so the `[0]` index is always required. The `|replace` filters strip markdown code fences, `|trim` removes whitespace, and `|json_decode` converts the JSON string into a usable object.
- **Code fence stripping**: Claude Haiku 4.5 wraps its JSON output in markdown code fences (` ```json ... ``` `) despite the system prompt instructing otherwise. The expression chains `|replace:"```json":""` then `|replace:"```":""` then `|trim` before `|json_decode`. This is safe whether fences are present or not.
- **Expression Editor**: Step 6.3.2 uses Xano's Expression Editor (not the standard variable picker) because it needs both a deep variable path and multiple filters applied. The expression is entered directly in the expression editor.
- **Try/Catch wraps the Else branch**: The entire Claude call, parse, and database write sequence is wrapped in a Try/Catch block. If any step fails (Claude API error, JSON parse failure, database write error), execution jumps to the Catch block which sends an alert email before returning an error status.
- **Error details from func1**: When Claude returns an error (e.g., empty content), the error details are at `$func1.result.error.type` and `$func1.result.error.message`, not in any `$try_catch` variable. The `$func1.status` field contains the HTTP status code (e.g., 400).
- **Mailgun auth in Catch block**: The Catch block builds its own `mailgun_auth` variable using `"api:" ~ $env.MAILGUN_API_KEY` because Xano's External API Request cannot directly concatenate environment variables in the sprintf filter's Additional Arguments field. The auth string is then base64-encoded and inserted into the Authorization header via sprintf.
- **content_hash must use unquoted variable reference (BUG FIX, Feb 14 2026):** The original XanoScript had `value = "$webhook1.scraped_content"|md5:false` with the variable wrapped in double quotes. This caused Xano to hash the literal string `$webhook1.scraped_content` instead of the actual page content, producing the same hash (`69debe6d98aa935507a285017e84a134`) for every marina on every run. The first run for each marina bypassed this because `last_content_hash` was null (triggering Claude correctly), but all subsequent runs matched the bogus hash and returned "no_change" even when prices had changed. The fix is `value = $webhook1.scraped_content|md5:false` with no quotes around the variable. This bug froze all scraped marina prices from Feb 10-14, 2026. (Note: the hash algorithm was later upgraded from MD5 to HMAC-SHA256 in v3.14, M5 remediation. The same unquoted-variable rule applies.)
- **response must use unquoted variable reference (BUG FIX, Feb 14 2026):** The original XanoScript had `response = "webhook1"` which returns the literal string "webhook1" instead of the webhook payload. The fix is `response = $webhook1`.
- **System prompt built as variable, not inline string:** The system prompt is constructed as a `$system_prompt` variable using single-quoted segments concatenated with the `~` operator. This is necessary because the prompt includes the dynamic `$today_date` value. The prompt is then passed to the Claude Function Pack via `system: $system_prompt` instead of an inline string.
- **Date-aware closure logic (Feb 14 2026):** The system prompt injects `$today_date` (Pacific time) so Claude can distinguish between closures that are in effect today versus future closures announced on the website. Without this, Claude was setting `open: "Closed"` for marinas that had upcoming holiday closure notices even though they were currently operational. The `closure_note` field captures ALL closure information (current and future) regardless of the `open` status.

---

## 8.5 mailgun_inbound Endpoint Detail

The `mailgun_inbound` endpoint (#39) processes inbound email replies from marina employees. It lives in the "Fuel Docks API" group.

### Authentication

The endpoint verifies that incoming requests originate from Mailgun using **HMAC-SHA256 signature verification**. Mailgun includes three fields in every forwarded message: `timestamp`, `token`, and `signature`. The endpoint concatenates the timestamp and token, computes an HMAC-SHA256 hash using the `MAILGUN_SIGNING_KEY` environment variable, and compares the result against Mailgun's signature. If they do not match, the request is rejected with "Access Denied" before any further processing occurs.

**How Mailgun signature verification works:** When Mailgun forwards an inbound email, it generates a unique `token`, records the Unix `timestamp`, and computes `signature = HMAC-SHA256(timestamp + token, signing_key)`. The signing key is Mailgun's HTTP Webhook Signing Key, found in the Mailgun dashboard under Settings > Security & Users > HTTP Webhook Signing Key. The endpoint repeats this computation and compares results. A mismatch means the request did not come from Mailgun.

**Why this approach over a shared secret token:** Unlike the `apify_webhook` (which uses a shared secret in the POST body because Apify's actors are under Ken's control), the `mailgun_inbound` endpoint receives traffic from Mailgun's infrastructure. Mailgun's built-in signature mechanism is the standard way to verify that forwarded messages are authentic. This prevents anyone who discovers the endpoint URL from injecting fake price data by POSTing directly to it.

### Why util.get_raw_input Instead of Named Inputs

Mailgun sends inbound email data as `x-www-form-urlencoded` POST with hyphenated field names like `stripped-text`, `body-plain`, and `sender`. Xano's input system cannot define inputs with hyphens in the name. Using underscored alternatives (`stripped_text`, `body_plain`) results in empty values because the field names don't match what Mailgun actually sends.

The solution is `util.get_raw_input` with `x-www-form-urlencoded` encoding, which captures the entire raw POST body as a single object. Individual fields are then extracted using the `|get` pipe filter with the exact hyphenated key names: `$var.mailgun_raw|get:"stripped-text"` and `$var.mailgun_raw|get:"sender"`.

**Discovery:** This was identified after the endpoint returned 500 Internal Server Error on real emails from Mailgun, despite working in the Xano debugger with manually entered test inputs. The debugger uses named inputs directly, bypassing the field name mismatch issue. The real Mailgun POST data had the correct content in `stripped-text` but the Xano input named `stripped_text` received nothing.

### Function Stack

```
1. Get All Raw Input                    --> mailgun_raw
     Encoding: x-www-form-urlencoded
     Description: Capture full Mailgun POST payload with original hyphenated field names

2. Create Variable: mg_timestamp        --> mg_timestamp
     Value: $var.mailgun_raw|get:"timestamp"
     Description: Extract Mailgun's Unix timestamp from POST data for signature verification

3. Create Variable: mg_token            --> mg_token
     Value: $var.mailgun_raw|get:"token"
     Description: Extract Mailgun's unique token from POST data for signature verification

4. Create Variable: mg_signature        --> mg_signature
     Value: $var.mailgun_raw|get:"signature"
     Description: Extract Mailgun's computed HMAC-SHA256 signature for comparison

5. Create Variable: verification_string --> verification_string
     Value: $var.mg_timestamp ~ $var.mg_token
     Description: Concatenate timestamp and token to build the string that was signed

6. Create Variable: computed_signature  --> computed_signature
     Value: $var.verification_string|hmac_sha256:$env.MAILGUN_SIGNING_KEY:false
     Description: Compute HMAC-SHA256 hash using Mailgun's signing key (false = hex output)

7. Precondition                         (Signature verification)
     Condition: $var.computed_signature == $var.mg_signature
     Error type: accessdenied
     Error message: Access Denied
     Description: Reject requests where computed signature does not match Mailgun's signature

8. Create Variable: email_body          --> email_body
     Value: $var.mailgun_raw|get:"stripped-text"
     Description: Extract email body (quoted reply text removed by Mailgun)

9. Create Variable: sender_email          --> sender_email
     Value: ($mailgun_raw|get:"sender")|to_lower
     Description: Extract sender email from Mailgun's "sender" field (SMTP MAIL FROM envelope
     sender — always a bare email address, no display name or angle brackets) and normalize
     to lowercase. The "from" field has display name format but "sender" does not, so no
     regex extraction is needed. (v4.34 simplification — see v4.29 for original regex approach
     and v4.34 history for why it was removed)

10. Query All Records From FuelPrices   --> FuelPrices1
     Filter: ($db.FuelPrices.contact_email|to_lower) == $sender_email
     Return type: single
     Description: Find the marina that matches the sender's email address (case-insensitive, v4.29)

11. Precondition                        (Marina match validation)
     Condition: $FuelPrices1 != null
     Error message: No marina found with this contact_email
     Description: Stop processing if no marina matches the sender

12. Try / Catch                         Description: Process email with Claude and update database
   TRY:
     12.1 Create Variable: today_date   --> today_date
           Value: now|format_timestamp:"m/d/Y":"America/Los_Angeles"
           Description: Get current date in Pacific time for Claude closure logic

     12.1a Create Variable: price_context --> price_context
           Value: " The prices currently on file for this marina are: gas $" ~ ($FuelPrices1.gas_price|number_format:2:".":"") ~ "/gallon and diesel $" ~ ($FuelPrices1.diesel_price|number_format:2:".":"") ~ "/gallon (a value of 9999.00 means this fuel type is not sold). Our outbound email asked the marina to confirm whether these prices are still current."
           Description: Build on-file price context so Claude can recognize affirmative confirmations (v3.28)

     12.2 Create Variable: system_prompt --> system_prompt
           Value: (single-quoted segments concatenated with ~ operator, injecting $today_date and $price_context)
           Description: Build date-aware and price-aware email parsing prompt for Claude

     12.3 Custom Function: Create chat completion - Claude (Synchronous)  --> func1
           model: claude-haiku-4-5
           max_tokens: 1024
           system: $system_prompt
           prompt: $var.email_body
           temperature: 0
           Description: Call Claude to extract pricing from email body

     12.4 Create Variable: parsed_response  --> parsed_response
           Value: $func1.result.content[0].text|replace:"```json":""|replace:"```":""|trim|json_decode
           Description: Strip markdown code fences, trim whitespace, decode JSON

     12.4a Custom Function: Fuel Docks/validate_claude_output  --> validated
           Inputs: gas_price, diesel_price, open, closure_note, recheck_date, hours,
                   comment from $parsed_response; current_gas_price and
                   current_diesel_price from $FuelPrices1
           Description: H4 Security -- validate and sanitize Claude output before DB write (see Section 8.10)

     12.4b Conditional: H4 flag alert email
           IF $validated.has_flags == true:
             Build and send Mailgun alert with subject "Fuel Docks H4 Flag: [marina name] (Email)"
             Body includes marina name, ID, sender email, and $validated.flag_summary
             Description: Alert Ken when validation detects anomalies in email-parsed data

     12.5 Conditional: Three-way email response routing
           Uses nested conditionals because XanoScript does not support "else if"
           **Price fields use full-precision $write_gas/$write_diesel (from $parsed_response, with H4 rejection check). Status/text fields sourced from $validated.**
           IF parsed_response.forward_to_human == true:
             12.5.1 Build forwarding email (subject, body, auth)
             12.5.2 Send to ken@navigatormktg.com via Mailgun (mg.fueldocks.app)
                    Subject: "RESPONSE REQUIRES ATTENTION: [marina name]"
             12.5.3 Edit Record: Update last_checked, last_email_response, reset
                    consecutive_unanswered to 0, set ai_comment with "FORWARDED TO HUMAN:" prefix
                    Description: Any reply resets the counter, even non-price replies
           ELSE:
             Nested Conditional: check whether new prices were provided
             IF parsed_response.gas_price != null OR parsed_response.diesel_price != null:
               12.5.4 Edit Record: Update all price fields, last_checked, last_updated,
                      last_email_response, reset consecutive_unanswered to 0, set ai_comment
                      Description: New prices provided, full update with last_updated
             ELSE:
               12.5.5 Edit Record: Update last_checked, last_email_response,
                      reset consecutive_unanswered to 0, update open/closure_note/
                      recheck_date/hours/ai_comment but NOT last_updated or prices
                      Description: No price change ("no changes", "same as last week",
                      or affirmative confirmation like "Yup!"), preserve existing
                      prices and last_updated timestamp

   CATCH:
     12.6 Create Variable: mailgun_auth --> mailgun_auth
           Value: "api:" ~ $env.MAILGUN_API_KEY
           Description: Build Mailgun Basic Auth credentials

     12.7 Create Variable: error_subject --> error_subject
           Value: "Fuel Docks Alert: Email Parse Error - " ~ $var.FuelPrices1.fuel_dock
           Description: Dynamic email subject with marina name

     12.8 Create Variable: error_body   --> error_body
           Value: Marina name, ID, sender, subject, error details
           Description: Detailed error email body

     12.9 External API Request to Mailgun --> api1
           POST https://api.mailgun.net/v3/mg.fueldocks.app/messages
           Description: Send error alert email via Mailgun
```

### Full XanoScript

```xanoscript
// Receives inbound email replies from marina contacts via Mailgun webhook. Verifies HMAC-SHA256 signature, parses email content via Claude AI, validates output, and updates FuelPrices. Routes non-price emails to Ken for manual handling.
query mailgun_inbound verb=POST {
  api_group = "Fuel Docks API"

  input {
    text sender? filters=trim
    text subject? filters=trim
    text stripped_text? filters=trim
    text body_plain? filters=trim
  }

  stack {
    // Step 1: Capture raw Mailgun POST data with original hyphenated field names
    util.get_raw_input {
      encoding = "x-www-form-urlencoded"
      exclude_middleware = false
    } as $mailgun_raw
  
    // Step 2: Extract Mailgun's timestamp for signature verification
    var $mg_timestamp {
      value = $mailgun_raw|get:"timestamp"
    }
  
    // Step 3: Extract Mailgun's unique token for signature verification
    var $mg_token {
      value = $mailgun_raw|get:"token"
    }
  
    // Step 4: Extract Mailgun's computed signature for comparison
    var $mg_signature {
      value = $mailgun_raw|get:"signature"
    }
  
    // Step 5: Concatenate timestamp and token to build the string that was signed
    var $verification_string {
      value = $mg_timestamp ~ $mg_token
    }
  
    // Step 6: Compute HMAC-SHA256 hash using Mailgun's signing key (false = hex output)
    var $computed_signature {
      value = $verification_string
        |hmac_sha256:$env.MAILGUN_SIGNING_KEY:false
    }
  
    // Step 7: Reject requests where computed signature does not match Mailgun's signature
    precondition ($computed_signature == $mg_signature) {
      error_type = "accessdenied"
      error = "Access Denied"
    }
  
    // Step 8: Extract email body from raw input - Mailgun uses hyphens not underscores
    var $email_body {
      value = $mailgun_raw|get:"stripped-text"
    }
  
    // Step 9: Extract sender email, normalized to lowercase.
    // Mailgun's "sender" field is the SMTP MAIL FROM envelope sender - always a bare
    // email address (no display name, no angle brackets). The "from" field has the
    // display name format. We use "sender" so no regex extraction is needed.
    var $sender_email {
      value = ($mailgun_raw|get:"sender")|to_lower
    }

    // Step 10: Look up marina by contact_email (case-insensitive)
    db.query FuelPrices {
      where = ($db.FuelPrices.contact_email|to_lower) == $sender_email
      return = {type: "single"}
    } as $FuelPrices1
  
    // Step 11: Stop if no marina matches this sender
    precondition ($FuelPrices1 != null) {
      error = "No marina found with this contact_email"
      payload = "No marina found with this contact_email"
    }
  
    // Step 12: Process email with Claude, validate output, and update database
    try_catch {
      try {
        // Get current date in Pacific time for Claude closure logic
        var $today_date {
          value = now
            |format_timestamp:"m/d/Y":"America/Los_Angeles"
        }
      
        // Build current on-file price context so Claude can recognize affirmative confirmations
        // When outbound emails ask "Are your prices still at $X for gas and $Y for diesel?",
        // replies like "Yup!", "Yes", "Correct" confirm those prices are unchanged
        var $price_context {
          value = " The prices currently on file for this marina are: gas $" ~ ($FuelPrices1.gas_price|number_format:2:".":"") ~ "/gallon and diesel $" ~ ($FuelPrices1.diesel_price|number_format:2:".":"") ~ "/gallon (a value of 9999.00 means this fuel type is not sold). Our outbound email asked the marina to confirm whether these prices are still current."
        }
      
        // Build date-aware email parsing prompt using single-quote concatenation
        // Rule 2 (diesel_price): use highest diesel number mentioned, never calculate tax
        // Rule 3 (open field): date check comes FIRST to prevent future closures from being marked closed today
        // Rule 4 (closure_note): captures all closure info regardless of timing
        // Rule 5 (recheck_date): tells the system when to force re-evaluation of this marina
        // Affirmative confirmation rule added to prevent "Yup/Yes/Correct" from being forwarded to human
        var $system_prompt {
          value = 'CRITICAL: Output ONLY raw JSON. Never use markdown, backticks, or code fences. Start your response with { and end with }. The current date is ' ~ $today_date ~ '.' ~ $price_context ~ ' You are a marina fuel price extraction assistant. Extract fuel pricing data from email replies to price check requests. Respond ONLY with valid JSON, no other text. Use this exact structure: {"gas_price": null, "diesel_price": null, "open": "Open", "closure_note": null, "recheck_date": null, "hours": null, "comment": null, "forward_to_human": false}. Rules: 1) gas_price = price per gallon of regular gas. Use null if not mentioned or if prices have not changed. 2) diesel_price = price per gallon of diesel that the customer pays at the pump. NEVER calculate tax yourself. If multiple diesel prices are mentioned (such as a base price and a pump/total/final price), always use the HIGHEST number because that is what the customer actually pays. Use null if not mentioned or if prices have not changed. 3) open = FIRST check dates: if the email mentions a closure for a FUTURE date after ' ~ $today_date ~ ', the marina is still operating today so set to exactly "Open" with no additional words. Only if the marina fuel dock is actually closed or not fully operational RIGHT NOW on ' ~ $today_date ~ ' should you write a short user-facing reason (examples: "Closed for winter maintenance", "Closed for Presidents Day", "By appointment only until March", "Under repair - no ETA given"). Never write just "Closed" by itself because app users need to know why. If operating normally today or if unclear, set to exactly "Open". 4) closure_note = ANY closure information mentioned in the email, whether current or future. Include the dates and reason. 5) recheck_date = If any date-specific closure or status change is mentioned (current or future), return the next date the status should be re-evaluated in MM/DD/YYYY format. For a closure starting on a future date, use that start date. For a closure currently in effect with a known end date, use the day after the last closed date. For indefinite closures ("closed until further notice") or no closure information at all, use null. 6) hours = fuel dock operating hours if mentioned. 7) comment = any other notable info from the email. 8) forward_to_human = true ONLY if the email is NOT about fuel prices, hours, status, or closures (e.g. complaints, questions, unsubscribe requests, general correspondence). Default to false. IMPORTANT: Short affirmative replies such as "Yes", "Yup", "Correct", "That is right", "Same", "Yep", "Still the same", "No change", "Sure is", "Uh huh", "Yeppers", or similar confirmations mean the marina is confirming the current prices are unchanged. These ARE fuel-dock-related responses. Return null prices with forward_to_human: false. All prices must be decimal numbers like 4.08, not strings. If the email does not contain any price information but IS about the fuel dock (e.g. "no changes", "same as last week", or an affirmative confirmation of the prices we asked about), return null prices with forward_to_human: false. If the email is completely unrelated to fuel pricing, return null prices with forward_to_human: true.'
        }
      
        function.run "Create chat completion -  Claude" {
          input = {
            model         : "claude-haiku-4-5"
            max_tokens    : 1024
            system        : $system_prompt
            prompt        : $email_body
            temperature   : 0
            top_k         : null
            top_p         : null
            stop_sequences: null
            image         : null
            image2        : null
          }
        } as $func1
      
        var $parsed_response {
          value = $func1.result.content[0].text
            |replace:"```json":""
            |replace:"```":""
            |trim
            |json_decode
        }
      
        // H4 Security: Validate and sanitize Claude output before writing to database
        // Checks price ranges, validates open field format, strips HTML, detects price spikes
        function.run "Fuel Docks/validate_claude_output" {
          input = {
            gas_price           : $parsed_response.gas_price
            diesel_price        : $parsed_response.diesel_price
            open                : $parsed_response.open
            closure_note        : $parsed_response.closure_note
            recheck_date        : $parsed_response.recheck_date
            hours               : $parsed_response.hours
            comment             : $parsed_response.comment
            current_gas_price   : $FuelPrices1.gas_price
            current_diesel_price: $FuelPrices1.diesel_price
          }
        } as $validated
      
        // Three-way routing for email response handling:
        // Path 1 (outer if): forward_to_human - email not about fuel, forward to Ken
        // Path 2 (inner if): new prices provided - at least one price is non-null, full update with last_updated
        // Path 3 (inner else): no change reported - both prices null, update last_checked but NOT last_updated
        // Uses nested conditionals because XanoScript does not support "else if" syntax
        conditional {
          if ($parsed_response.forward_to_human) {
            // Forward the original email to Ken for manual handling
            var $fwd_mailgun_auth {
              value = "api:" ~ $env.MAILGUN_API_KEY
            }
          
            var $fwd_subject {
              value = "RESPONSE REQUIRES ATTENTION: " ~ $var.FuelPrices1.fuel_dock
            }
          
            var $fwd_body {
              value = `"The following email reply was flagged as not containing price data.\n\nMarina: " ~ $var.FuelPrices1.fuel_dock ~ "\nSender: " ~ $sender_email ~ "\nOriginal Subject: " ~ ($var.mailgun_raw|get:"subject") ~ "\n\nEmail Body:\n" ~ $email_body ~ "\n\nClaude's comment: " ~ $parsed_response.comment`
            }
          
            api.request {
              url = "https://api.mailgun.net/v3/mg.fueldocks.app/messages"
              method = "POST"
              params = {}
                |set:"from":"Fuel Docks Alerts <alerts@mg.fueldocks.app>"
                |set:"to":"ken@navigatormktg.com"
                |set:"subject":$fwd_subject
                |set:"text":$fwd_body
              headers = []
                |push:("Authorization: Basic %s"
                  |sprintf:($fwd_mailgun_auth|base64_encode)
                )
            } as $fwd_api
          
            // Update last_email_response timestamp, reset unanswered counter, but do not change prices
            // Uses $validated.comment for sanitized ai_comment (H4 Security)
            db.edit FuelPrices {
              field_name = "id"
              field_value = $FuelPrices1.id
              data = {
                last_checked          : now
                last_email_response   : now
                consecutive_unanswered: 0
                ai_comment            : "FORWARDED TO HUMAN: " ~ $validated.comment
              }
            } as $FuelPrices2
          }
        
          else {
            // Not forwarded to human - check whether new prices were provided
            conditional {
              if ($parsed_response.gas_price != null || $parsed_response.diesel_price != null) {
                // New prices provided - write VALIDATED fields to database (H4 Security)
                db.edit FuelPrices {
                  field_name = "id"
                  field_value = $FuelPrices1.id
                  data = {
                    last_checked          : now
                    last_updated          : now
                    gas_price             : $validated.gas_price
                    diesel_price          : $validated.diesel_price
                    open                  : $validated.open
                    closure_note          : $validated.closure_note
                    recheck_date          : $validated.recheck_date
                    hours                 : $validated.hours
                    last_email_response   : now
                    consecutive_unanswered: 0
                    ai_comment            : $validated.comment
                  }
                } as $FuelPrices2
              }
            
              else {
                // No price change reported (e.g. "no changes", "same as last week", or affirmative confirmation like "Yup!")
                // Update last_checked and last_email_response but NOT last_updated
                // Do not overwrite existing prices with null values
                // Uses VALIDATED fields for text content (H4 Security)
                db.edit FuelPrices {
                  field_name = "id"
                  field_value = $FuelPrices1.id
                  data = {
                    last_checked          : now
                    last_email_response   : now
                    consecutive_unanswered: 0
                    open                  : $validated.open
                    closure_note          : $validated.closure_note
                    recheck_date          : $validated.recheck_date
                    hours                 : $validated.hours
                    ai_comment            : $validated.comment
                  }
                } as $FuelPrices2
              }
            }
          }
        }
      
        // H4 Security: Send alert email if validation flagged any issues
        // Runs after database write regardless of which routing path was taken
        conditional {
          if ($validated.has_flags) {
            // Mailgun Basic Auth for H4 validation flag alert
            var $flag_mailgun_auth {
              value = "api:" ~ $env.MAILGUN_API_KEY
            }
          
            // H4 validation alert subject with marina name
            var $flag_subject {
              value = "Fuel Docks H4 Flag: " ~ $FuelPrices1.fuel_dock ~ " (Email)"
            }
          
            // H4 validation alert body with flag details, sender info, and raw Claude output
            var $flag_body {
              value = `"H4 Validation Flags Detected\n\nEndpoint: mailgun_inbound\nMarina: " ~ $FuelPrices1.fuel_dock ~ "\nMarina ID: " ~ $FuelPrices1.id ~ "\nSender: " ~ $sender_email ~ "\nSubject: " ~ ($var.mailgun_raw|get:"subject") ~ "\n\nFlags:\n" ~ $validated.flag_summary ~ "\n\nRaw Claude Output:\nGas: " ~ $parsed_response.gas_price ~ "\nDiesel: " ~ $parsed_response.diesel_price ~ "\nOpen: " ~ $parsed_response.open ~ "\nComment: " ~ $parsed_response.comment`
            }
          
            api.request {
              url = "https://api.mailgun.net/v3/mg.fueldocks.app/messages"
              method = "POST"
              params = {}
                |set:"from":"Fuel Docks Alerts <alerts@mg.fueldocks.app>"
                |set:"to":"ken@navigatormktg.com"
                |set:"subject":$flag_subject
                |set:"text":$flag_body
              headers = []
                |push:("Authorization: Basic %s"
                  |sprintf:($flag_mailgun_auth|base64_encode)
                )
            } as $flag_api
          }
        }
      }
    
      catch {
        // Build Mailgun auth header
        var $mailgun_auth {
          value = "api:" ~ $env.MAILGUN_API_KEY
        }
      
        // Error alert subject line
        var $error_subject {
          value = "Fuel Docks Alert: Email Parse Error - " ~ $var.FuelPrices1.fuel_dock
        }
      
        // Error alert body with debugging details
        var $error_body {
          value = `"Marina: " ~ $var.FuelPrices1.fuel_dock ~ "\nMarina ID: " ~ $var.FuelPrices1.id ~ "\nSender: " ~ $sender_email ~ "\nSubject: " ~ ($var.mailgun_raw|get:"subject") ~ "\n\nXano Endpoint: mailgun_inbound\nError: " ~ $error.message ~ "\nError Code: " ~ $error.code`
        }
      
        // Send error alert via Mailgun
        api.request {
          url = "https://api.mailgun.net/v3/mg.fueldocks.app/messages"
          method = "POST"
          params = {}
            |set:"from":"Fuel Docks Alerts <alerts@mg.fueldocks.app>"
            |set:"to":"ken@navigatormktg.com"
            |set:"subject":$error_subject
            |set:"text":$error_body
          headers = []
            |push:("Authorization: Basic %s"
              |sprintf:($mailgun_auth|base64_encode)
            )
        } as $api1
      }
    }
  }

  response = $FuelPrices1
}
```

### Important Implementation Notes

- **util.get_raw_input encoding must be x-www-form-urlencoded:** Mailgun sends form-encoded POST data, not JSON. The `encoding` parameter on the Get All Raw Input step must be set to `"x-www-form-urlencoded"`. Using `"json"` will fail to parse the payload correctly.
- **Pipe filter for hyphenated keys:** Mailgun field names contain hyphens (`stripped-text`, `body-plain`). These cannot be accessed via dot notation (which would interpret hyphens as subtraction). The `|get` pipe filter correctly accesses hyphenated keys: `$var.mailgun_raw|get:"stripped-text"`.
- **Named inputs are retained but unused:** The `input {}` block still defines `sender`, `subject`, `stripped_text`, and `body_plain` for documentation purposes, but the actual data comes from `$var.mailgun_raw` via `util.get_raw_input`. The named inputs receive empty values from real Mailgun traffic due to the field name mismatch.
- **db.query WHERE syntax:** XanoScript `db.query` requires `$db.TableName.field_name` syntax for WHERE clauses, not `"field_name"`. Using `where = "contact_email" == $input.sender` silently fails and returns null. The correct syntax is `where = $db.FuelPrices.contact_email == $sender_email`. This differs from `db.get` which uses `field_name = "id"` and `field_value = $variable`. This was the single biggest debugging challenge during Step 5 development.
- **Precondition null check:** When `db.query` with `return = {type: "single"}` finds no record, it returns `null`, not an empty string. The precondition must check `$FuelPrices1 != null`, not `$FuelPrices1 != ""`. Using `!= ""` causes the precondition to always pass even when no record is found.
- **contact_email field type must be text:** The `contact_email` field was originally created with the Xano "email" type. This field type applies automatic validation (trim, lowercase) and does not work correctly with `==` query filters in `db.query`. Changing the field type to "text" resolved the query failures. The email data stored in the field is unchanged.
- **Sender email extraction from Mailgun format (v4.29):** Mailgun's `sender` field arrives in RFC 5322 display name format: `"Bob Williams <Bob@covichwilliams.com>"` rather than just the bare email address. The original Step 9 stored this full string as `$sender_email` and compared it directly against `contact_email` in the database, which stores only the bare email. This caused a silent lookup failure — the precondition at Step 11 returned "No marina found with this contact_email" and the marina's reply was never processed. Discovered when marina #44 (Covich Williams) replied at 10:04 AM on March 18, 2026 but the webhook returned 500 on both the initial attempt and Mailgun's retry. The fix splits Step 9 into three parts: (9) capture raw sender, (9b) use `regex_replace` with pattern `^.*<([^>]+)>.*$` to extract the email from angle brackets (falls back to the full string if no brackets are present), (9c) normalize to lowercase. Step 10's WHERE clause also lowercases `contact_email` for case-insensitive matching.
- **HMAC-SHA256 signature verification:** The endpoint verifies every request using Mailgun's webhook signature mechanism. Steps 2-7 extract `timestamp`, `token`, and `signature` from the raw POST data, concatenate timestamp + token, compute an HMAC-SHA256 hash using `$env.MAILGUN_SIGNING_KEY`, and compare the result against Mailgun's provided signature. Requests with mismatched signatures are rejected with "Access Denied" (HTTP 403) before any further processing. This prevents unauthorized direct POSTs to the endpoint URL.
- **MAILGUN_SIGNING_KEY source:** The signing key is Mailgun's HTTP Webhook Signing Key, retrieved from the Mailgun dashboard: Settings (gear icon in sidebar) > Security & Users > HTTP Webhook Signing Key (under the Account Settings heading). This is distinct from both Domain Sending Keys used for email sends: `MAILGUN_API_KEY` (mg.fueldocks.app Domain Sending Key for alert emails) and `MAILGUN_KEY_NAVIGATOR` (navigatorpnw.com Domain Sending Key for marina outbound emails). The signing key is used exclusively for verifying inbound webhook HMAC-SHA256 signatures.
- **hmac_sha256 filter output format:** Xano's `hmac_sha256` filter with the `false` parameter produces a 64-character lowercase hexadecimal string (e.g., `a1b2c3d4...`). This matches the format Mailgun uses for its `signature` field. The `false` parameter means "do not output raw binary" (output hex string instead). If the filter produced uppercase hex, the comparison would fail because Mailgun's signatures are lowercase.
- **Signature verification inserted before email processing:** The verification steps (2-7) sit between the raw input capture (step 1) and the email body extraction (step 8). This ensures unauthorized requests are rejected before any database queries, Claude API calls, or email forwarding occurs.
- **Debugger tests will always fail:** Running the endpoint through Xano's debugger with manually entered inputs will always be rejected by the signature precondition because the debugger does not include Mailgun's `timestamp`, `token`, and `signature` fields. This is expected. Real Mailgun traffic includes these fields automatically. To test changes to the endpoint logic below the signature check, temporarily comment out or disable the precondition, test, then re-enable it.
- **Claude prompt uses $email_body, not $input.stripped_text:** The prompt for the Claude Function Pack call references `$email_body` (extracted from raw input via pipe filter) instead of `$input.stripped_text` (which would be empty from real Mailgun traffic).
- **Error body references raw input for subject:** The catch block's error body extracts the email subject via `($var.mailgun_raw|get:"subject")` rather than `$input.subject`, consistent with the raw input approach.
- **Timestamps updated on success:** The endpoint uses three-way routing that determines which timestamps are set: (1) `forward_to_human` path sets `last_checked` and `last_email_response` only; (2) new prices path (at least one non-null price) sets `last_checked`, `last_updated`, and `last_email_response`; (3) no-change path (both prices null, not forwarded) sets `last_checked` and `last_email_response` but NOT `last_updated`. The `last_email_response` update is critical for the outbound email cadence logic: the `send_outbound_emails` task uses it as the preferred reference timestamp for computing the next due date (v3.18 date-based comparison). The no-change path also preserves existing prices by not writing null values to `gas_price` or `diesel_price`.
- **Three-way response routing via nested conditionals:** After Claude parses the email, the endpoint routes through three paths using nested `conditional` blocks (because XanoScript does not support `else if`). The outer conditional checks `$parsed_response.forward_to_human`: if true, forwards to Ken without changing prices. The inner conditional (inside the outer `else`) checks whether at least one price is non-null (`$parsed_response.gas_price != null || $parsed_response.diesel_price != null`): if true, performs a full price update with `last_updated`; if false (both null, meaning "no change"), updates status fields and timestamps but preserves existing prices and `last_updated`. This prevents "no change" email replies from incorrectly advancing the `last_updated` timestamp.
- **consecutive_unanswered reset:** All three routing paths (forward-to-human, new prices, no-change) AND the catch block set `consecutive_unanswered` to 0. This ensures the escalating alert system in `send_outbound_emails` stops alerting once any reply is received, regardless of whether it contains prices or whether Claude parsing failed. The catch block reset was added in v4.26 after discovering that transient Claude API 500 errors caused marina replies to be silently lost — the marina responded but `consecutive_unanswered` was never decremented because the error bypassed all three routing paths. The catch block now also sets `last_email_response` to `now` and writes `ai_comment` = "PARSE ERROR: {error message}" for debugging.
- **Response is $FuelPrices1:** During development, the response was temporarily set to `$mailgun_raw` for debugging (to see what Mailgun sent). It was changed back to `$FuelPrices1` for production use.
- **Date-aware closure logic (Feb 14 2026):** Same pattern as `apify_webhook`. The system prompt injects `$today_date` (Pacific time) so Claude can distinguish current closures from future ones mentioned in email replies. The `$today_date` and `$system_prompt` variables are created inside the Try block, before the Claude Function Pack call.
- **Affirmative confirmation context injection (v3.28):** When the outbound email asks "Are your prices still at $X for gas and $Y for diesel?", marina contacts often reply with a single word like "Yup!" or "Yes". Without context about what was asked, Claude only sees the one-word reply and has no prices to extract, so it set `forward_to_human: true` and Ken received an unnecessary alert. The fix injects the marina's current on-file prices into the system prompt via a `$price_context` variable (built from `$FuelPrices1`, which is already loaded before the Try block). Combined with an explicit affirmative confirmation rule in the prompt, Claude now recognizes these short replies as "no change" confirmations and returns null prices with `forward_to_human: false`, routing them to Path 3 (no-change) instead of Path 1 (forward-to-human).

---

## 8.6 call_queue Endpoint Detail

The `call_queue` endpoint (#42) returns Method=Call marinas currently due for a phone call. It lives in the "Fuel Docks API" group and powers the FD Dialer Adalo app's Home screen.

### Authentication

**Authentication:** Uses the same FD_API_TOKEN precondition pattern as `submit_call` and `send_outbound_email`. The `api_token` input is validated against the `FD_API_TOKEN` environment variable before any processing occurs. Requests with a missing or incorrect token receive HTTP 403 "Unauthorized" immediately. Added per security audit H3 (February 2026).

**Adalo integration:** The FD Dialer app's "Call Queue" external collection passes the token as a query parameter in the Get All URL: `call_queue?api_token=URL_ENCODED_TOKEN`. Because the token value contains an ampersand (`&`), the character must be URL-encoded as `%26` in the Adalo URL field so it is not interpreted as a query parameter separator. Only the Get All endpoint is used by the app; Get One, Create, Update, and Delete are unused Adalo scaffolding.

### Function Stack

```
0. Precondition: api_token must match FD_API_TOKEN env var
     Description: Security - reject requests without valid API token before any processing occurs (H3 remediation)

1. Query FuelPrices                       --> FuelPrices1
     WHERE: Method == "Call"
     Sort: last_updated ascending (most stale first)
     Return: list
     Description: Get all Method=Call marinas sorted by most stale first

2. Create Variable: now                   --> now
     Value: now
     Description: Current timestamp for snooze and cadence comparisons

3. Create Variable: today                 --> today
     Value: now|format_timestamp:"Y-m-d":"America/Los_Angeles"
     Description: Today date string for recheck_date and suspend_until comparisons (Pacific time)

3b. Create Variable: current_month        --> current_month
     Value: (now|format_timestamp:"n":"America/Los_Angeles") * 1
     Description: Current month as integer (1-12) for hours_json seasonal matching

3c. Create Variable: current_day_abbr     --> current_day_abbr
     Value: now|format_timestamp:"D":"America/Los_Angeles"|to_lower
     Description: Current day abbreviation ("mon", "tue", etc.) for hours_json closed-day matching

4. Create Variable: due_marinas           --> due_marinas
     Value: [] (empty array)
     Description: Array to collect marinas that pass all filter conditions

5. Create Variable: next_call_due         --> next_call_due
     Value: null
     Description: Track earliest future call time for the empty-queue completion screen

6. For Each (FuelPrices1)
     Each as $marina

     6.1 Create Variable: skip            --> skip
          Value: false
          Description: Assume marina is due until a filter says otherwise

     6.2 Create Variable: cadence_days    --> cadence_days
          Value: 7 (default)
          Description: Cadence defaults to 7 days if call_cadence is null or 0.
          Override with marina.call_cadence if > 0

     6.3 Filter 0: DNC (Do Not Call) Exclusion
          If marina.legal == "DNC": set skip = true
          Absolute exclusion — no other filters matter for DNC marinas.
          Runs first to avoid wasting cycles on marinas we cannot contact.

     6.3b Filter 0b: Closed Today (hours_json)
          If marina.hours_json is not null:
            For each schedule in hours_json:
              Match current_month against start_month/end_month range (handles year-wrap)
              If matched: iterate closed_days, if current_day_abbr found: set skip = true
          Marinas with null hours_json pass through (treated as open).

     6.4 Filter 1: Snooze Check
          If marina.call_snooze_until is not null AND > now: set skip = true
          Also track snooze time for next_call_due on the completion screen

     6.5 Filter 2: Recheck Date
          If skip is false AND marina.recheck_date is not null AND > today: set skip = true

     6.6 Filter 3: Suspend Until
          If skip is false AND marina.suspend_until is not null AND > today: set skip = true

     6.7 Filter 4: Cadence Check (only applies to successful connections)
          If skip is false AND last_call_connection exists:
            compute cadence_ms = cadence_days * 86400000 (milliseconds per day)
            check elapsed since last_call_connection >= cadence_ms
          If last_call_connection is null: skip stays false (always due)
          BUG FIX (v3.17): Removed fallback that checked last_call against cadence.
          That branch prevented snoozed marinas from reappearing after snooze expired.

     6.8 If skip is false: format gas_price and diesel_price via number_format:2:"."."",
          update $marina object with formatted prices, push to due_marinas array

7. Create Variable: result                --> result
     Value: {due_marinas: $due_marinas, next_call_due: $next_call_due}
     Description: Build response with queue and completion screen data
```

### call_queue XanoScript

The XanoScript below reflects the current published version (v4.25), which includes Filter 0 (DNC), Filter 0b (closed today), and Filters 1-4 (snooze, recheck, suspend, cadence). See the [Xano MCP `getAPI` for endpoint #42] for the live version.

### Important Implementation Notes

- **Hand-written XanoScript:** This endpoint's filtering logic was too complex for the Stack UI visual editor. The XanoScript was written directly rather than auto-generated.
- **DNC (Do Not Call) filter (v4.19):** Filter 0 checks the `legal` field for the value `"DNC"` and immediately skips the marina. This is an absolute exclusion that runs before all other filters (snooze, recheck, suspend, cadence) because no other logic matters for a marina that has told us not to call. Currently applies to Rosario Resort (id=24).
- **Closed today filter (v4.25):** Filter 0b checks `hours_json` to skip marinas that are closed on the current day of the week in the current season. Computes `$current_month` (int 1-12, via `format_timestamp:"n"` with `* 1` for int coercion) and `$current_day_abbr` (lowercase 3-letter day, via `format_timestamp:"D"|to_lower`) once outside the foreach loop. For each marina with non-null `hours_json`, iterates the schedule array, matches the current month against `start_month`/`end_month` (handles year-wrapping ranges like Oct-Apr), then iterates `closed_days` to check if today's day abbreviation matches. Marinas with null `hours_json` pass through (treated as open). Currently applies to La Conner Landing (id=31, closed Tue/Thu Oct-Apr).
- **FD_API_TOKEN precondition (H3 remediation):** The precondition at the top of the stack rejects unauthenticated requests before any database queries or filtering logic runs. This prevents exposing marina phone numbers, contact details, and pricing history to unauthenticated callers. The token is passed as a query parameter by the Adalo external collection.
- **Adalo external collection token delivery:** The FD Dialer app uses an Adalo external collection ("Call Queue") to load the call list. The token is appended to the Get All URL as a query parameter. Special characters in the token value (such as `&`) must be URL-encoded in the Adalo URL field (e.g., `&` becomes `%26`) so they are not interpreted as query parameter separators. Only the Get All endpoint is used; the other CRUD endpoints (Get One, Create, Update, Delete) are unused Adalo scaffolding.
- **Price formatting for Adalo:** Gas and diesel prices are formatted via `number_format:2:".":""` before being pushed to the response array. This ensures Adalo displays "4.50" instead of "4.5" in pre-filled input fields.
- **Nested conditionals throughout:** Because XanoScript does not support `else if` in the standard `conditional` block (only `elseif` inside the same block), and because `||` (logical OR) does not work in conditionals, many filters use nested conditional blocks. Each null check wraps an inner comparison check.
- **cadence_days default logic:** If `call_cadence` is null or 0, the endpoint defaults to 7 days. This is done via a two-level nested conditional (null check, then > 0 check) because XanoScript does not support compound conditions with `||`.
- **next_call_due tracking:** When a marina is skipped due to an active snooze, the snooze expiration time is compared against the current `next_call_due`. The earliest snooze time becomes `next_call_due`, which is displayed on the completion screen when the queue is empty. Note: this currently only tracks snooze-based future calls, not cadence-based ones.
- **Response structure:** Returns `{due_marinas: [...], next_call_due: timestamp|null}` rather than a flat array. Adalo reads `due_marinas` for the list and `next_call_due` for the empty-queue completion screen.

---

## 8.7 snooze_call Endpoint Detail

The `snooze_call` endpoint (#43) snoozes a marina call for later callback without saving any price data. It lives in the "Fuel Docks API" group.

### Authentication

**Authentication:** Uses the same FD_API_TOKEN precondition pattern as `call_queue` and `send_outbound_email`. The `api_token` input is validated against the `FD_API_TOKEN` environment variable before any processing occurs. Requests with a missing or incorrect token receive HTTP 403 "Unauthorized" immediately. The token is sent by Adalo Custom Actions in the JSON request body.

### Function Stack

```
0. Precondition: api_token must match FD_API_TOKEN env var
     Description: Security - reject requests without valid API token before any processing occurs

1. Precondition                           (Input validation)
     Condition: snooze_type == "1hour" OR snooze_type == "tomorrow"
     Error: "snooze_type must be '1hour' or 'tomorrow'"
     Description: Reject invalid snooze_type values

2. Create Variable: marina_id_int         --> marina_id_int
     Value: $input.marina_id|to_int
     Description: Cast marina_id from text to integer (Adalo sends quoted values)

3. Create Variable: now                   --> now
     Value: now
     Description: Current timestamp for last_call and snooze calculation

4. Create Variable: result                --> result (guard)
     Value: null
     Description: Holds db.edit response or null if marina_id is invalid

5. Conditional: Guard clause (marina_id_int > 0)
     IF marina_id_int > 0:
       5.1 Conditional: snooze type branching
            IF snooze_type == "1hour":
              5.1.1 Create Variable: snooze_until  --> snooze_until
                   Value: now + 1 hour (Pacific time)
            ELSE (tomorrow):
              5.1.2 Create Variable: tomorrow_date --> tomorrow_date
                   Value: tomorrow's date string in Y-m-d format (Pacific)
              5.1.3 Create Variable: snooze_until  --> snooze_until
                   Value: tomorrow_date concatenated with " 00:01:00", converted to timestamp

       5.2 Edit FuelPrices                        --> FuelPrices1
            Field: id = marina_id_int
            Data: last_call = now, call_snooze_until = snooze_until
            Description: Record the call attempt and set the snooze. Does NOT update last_call_connection.

       5.3 Update Variable: result = FuelPrices1
```

### snooze_call XanoScript

```xanoscript
// Snoozes a marina call for 1 hour or until tomorrow 12:01am Pacific. Validates API token for Adalo-to-Xano authentication. Records the call attempt in last_call but does not update last_call_connection since no one was reached.
// marina_id is accepted as text because Adalo Custom Actions cannot send unquoted integers in JSON bodies. Cast to int inside the stack.
query snooze_call verb=POST {
  api_group = "Fuel Docks API"

  input {
    // Shared secret token for Adalo-to-Xano authentication (must match FD_API_TOKEN env var)
    text api_token filters=trim
  
    // ID of the marina to snooze (text because Adalo sends quoted values; cast to int in stack)
    text marina_id filters=trim

    // 1hour or tomorrow
    text snooze_type filters=trim
  }

  stack {
    // Security: Reject requests without valid API token before any processing occurs
    precondition ($input.api_token == $env.FD_API_TOKEN) {
      error_type = "accessdenied"
      error = "Unauthorized"
    }
  
    // Validate snooze_type input before proceeding
    precondition ($input.snooze_type == "1hour" || $input.snooze_type == "tomorrow") {
      error = "snooze_type must be '1hour' or 'tomorrow'"
    }

    // Cast marina_id from text to integer because Adalo Custom Actions cannot send unquoted integers in JSON bodies
    var $marina_id_int {
      value = $input.marina_id|to_int
    }

    // Current timestamp for snooze and last_call comparisons
    var $now {
      value = now
    }

    // Guard: skip db operations if marina_id is 0 or empty (safety net for malformed requests)
    // Holds the db.edit response or null if marina_id is invalid
    var $result {
      value = null
    }

    conditional {
      if ($marina_id_int > 0) {
        // Validate that the marina_id actually exists in the database
        db.get FuelPrices {
          field_name = "id"
          field_value = $marina_id_int
        } as $FuelPricesCheck
      
        precondition ($FuelPricesCheck != null) {
          error_type = "notfound"
          error = "Marina not found"
        }
      
        conditional {
          if ($input.snooze_type == "1hour") {
            // Snooze expiration set to 1 hour from now in Pacific time
            var $snooze_until {
              value = $now
                |transform_timestamp:"+1 hour":"America/Los_Angeles"
            }
          }

          else {
            // Tomorrow date string for building 12:01am Pacific snooze time
            var $tomorrow_date {
              value = $now
                |transform_timestamp:"+1 day":"America/Los_Angeles"
                |format_timestamp:"Y-m-d":"America/Los_Angeles"
            }

            // Snooze expiration set to tomorrow 12:01am Pacific
            var $snooze_until {
              value = $tomorrow_date
                |concat:" 00:01:00"
                |to_timestamp:"America/Los_Angeles"
            }
          }
        }

        // Record the call attempt and set the snooze. Does NOT update last_call_connection.
        db.edit FuelPrices {
          field_name = "id"
          field_value = $marina_id_int
          data = {last_call: $now, call_snooze_until: $snooze_until}
        } as $FuelPrices1

        var.update $result {
          value = $FuelPrices1
        }
      }
    }
  }

  response = $result
}
```

### Important Implementation Notes

- **All inputs are text type (Adalo compatibility):** The `marina_id` input is `text` instead of `int` because Adalo Custom Actions cannot send unquoted values in JSON request bodies. Adalo's JSON validator rejects `{"marina_id": [chip]}` and requires `{"marina_id": "[chip]"}`, wrapping all values in quotes. The endpoint casts to int internally using `|to_int`. The `snooze_type` was already text and is unaffected.
- **Guard clause for Adalo test requests:** When configuring a Custom Action in Adalo, the "RUN TEST REQUEST" button sends empty placeholder values for all inputs. Without the guard clause, `to_int` on an empty string produces 0, causing a 404 on the db.edit. The `$marina_id_int > 0` guard returns null instead, allowing the test to succeed with a 200 response.
- **`||` works in preconditions:** The precondition uses `$input.snooze_type == "1hour" || $input.snooze_type == "tomorrow"`. Despite the lesson learned that `||` does not work in `conditional` blocks, it does work correctly in `precondition` expressions. This distinction (preconditions vs conditionals) is important.
- **Tomorrow 12:01 AM construction:** The "tomorrow" path builds the snooze time in three steps: (1) add 1 day to now, (2) format as date-only string (Y-m-d), (3) concatenate " 00:01:00" and convert back to timestamp with Pacific timezone. This ensures 12:01 AM Pacific regardless of the current time. Originally set to 8:00 AM, but changed to 12:01 AM so snoozed marinas reappear at the start of the next day rather than mid-morning.
- **transform_timestamp vs arithmetic:** The 1-hour snooze uses `transform_timestamp:"+1 hour"` rather than adding 3600 seconds. This handles DST transitions correctly by operating in the named timezone.
- **last_call updated, last_call_connection NOT updated:** The snooze records that a call attempt was made without claiming a successful connection was made. As of v3.17, cadence only checks `last_call_connection` (successful calls). The `last_call` field is still set during snooze for historical tracking purposes (knowing when the last attempt was made) but it no longer participates in the call_queue cadence filter. This means when a snooze expires, the marina immediately reappears on the call list regardless of when `last_call` was set.
- **Adalo Custom Actions are per-button, not shared:** Each button has its own Custom Action instance. The "Call Back - 1 Hour" and "Call Back Tomorrow" buttons each required independent fixes to their Custom Action body and input mappings. Changes to one do not propagate to the other.
- **Root cause of marinas not hiding after snooze/submit (hardcoded values bug):** All three Call Detail buttons (Submit, Call Back - 1 Hour, Call Back - Tomorrow) were configured with hardcoded literal values in the Custom Action JSON body instead of Magic Text references. For example, the body contained `{"marina_id": "1", "snooze_type": ""}` as typed text, which always sent marina_id 1 and an empty snooze_type regardless of which marina was displayed on screen. This meant snoozing or submitting would write to marina ID 1 instead of the current marina, so the displayed marina never received a snooze timestamp and continued appearing on the call list. The fix was rebuilding each button's Custom Action body using the Magic Text icon (the "T*" button in Adalo's body editor), which inserts orange pill-shaped chips that dynamically reference the actual input values. Each button had to be fixed independently since Adalo Custom Actions are per-button instances (thread "Adalo/Xano snooze button fix").

---

## 8.8 submit_call Endpoint Detail

The `submit_call` endpoint (#44) processes a completed phone call with optional prices, percentage-based diesel tax addition, and Claude-parsed notes. It lives in the "Fuel Docks API" group. Price validation hardened in M4 remediation (v3.13) to prevent negative values from bypassing range checks. M6 fix (v4.22): empty/zero price inputs now preserve existing database values instead of overwriting with 0 (see Section 8.16).

### Authentication

**Authentication:** Uses the same FD_API_TOKEN precondition pattern as `call_queue` and `send_outbound_email`. The `api_token` input is validated against the `FD_API_TOKEN` environment variable before any processing occurs. Requests with a missing or incorrect token receive HTTP 403 "Unauthorized" immediately. The token is sent by Adalo Custom Actions in the JSON request body.

### Function Stack

```
0. Precondition: api_token must match FD_API_TOKEN env var
     Description: Security - reject requests without valid API token before any processing occurs

1. Create Variable: marina_id_int        --> marina_id_int
     Value: $input.marina_id|to_int
     Description: Cast marina_id from text to integer (Adalo sends quoted values)

2. Create Variable: gas_price_dec        --> gas_price_dec
     Value: $input.gas_price|to_decimal
     Description: Cast gas_price from text to decimal for db storage

3. Create Variable: diesel_price_dec     --> diesel_price_dec
     Value: $input.diesel_price|to_decimal
     Description: Cast diesel_price from text to decimal for tax calculation and db storage

4. Create Variable: diesel_tax_dec       --> diesel_tax_dec
     Value: $input.diesel_tax_included|to_decimal
     Description: Cast diesel_tax_included from text to decimal for percentage-based tax addition logic

5. Create Variable: result               --> result (guard)
     Value: null
     Description: Holds the final db.edit response or null if marina_id is invalid

6. Conditional: Guard clause (marina_id_int > 0)
     IF marina_id_int > 0:
       6.1 Get FuelPrices                 --> FuelPrices1
            Field: id = marina_id_int
            Description: Look up the marina record to get current data

       6.1.1 Precondition: FuelPrices1 != null
            Description: Validate that the marina_id actually exists in the database

       6.1.2 Conditional: Gas price range validation (M4)
            IF gas_price_dec != null AND gas_price_dec != 0:
              Precondition: gas_price_dec >= 2 AND gas_price_dec <= 15
              Description: Reject gas prices outside reasonable marine fuel range ($2-$15).
                           Uses != 0 (not > 0) so negative values cannot bypass the range check.
                           0 = "not provided" from Adalo and is allowed through.

       6.1.3 Conditional: Diesel price range validation (M4)
            IF diesel_price_dec != null AND diesel_price_dec != 0:
              Precondition: diesel_price_dec >= 2 AND diesel_price_dec <= 15
              Description: Reject diesel prices outside reasonable marine fuel range ($2-$15).
                           Uses != 0 (not > 0) so negative values cannot bypass the range check.
                           0 = "not provided" from Adalo and is allowed through.

       6.2 Create Variable: now           --> now
            Value: now
            Description: Current timestamp for last_checked, last_call, and last_call_connection

       6.3 Create Variable: diesel_tax_rate --> diesel_tax_rate
            Value: $diesel_tax_dec
            Description: Capture the submitted diesel tax percentage rate for tax addition and storage

       6.4 Conditional: Diesel tax addition
            IF diesel_tax_rate > 0 AND diesel_price_dec != null AND diesel_price_dec > 0:
              6.4.1 Create Variable: adjusted_diesel --> adjusted_diesel
                   Value: diesel_price_dec * (1 + diesel_tax_rate)
            ELSE:
              6.4.2 Create Variable: adjusted_diesel --> adjusted_diesel
                   Value: diesel_price_dec as entered (no adjustment)

       6.5 Conditional: Claude AI note parsing (only when notes have content)
            IF notes != null AND notes strlen > 0:
              Try/Catch:
                TRY:
                  6.5.1 Create Variable: today_date    --> today_date
                  6.5.2 Create Variable: system_prompt --> system_prompt
                  6.5.3 Function.run Claude Function Pack
                  6.5.4 Create Variable: claude_raw    --> claude_raw
                  6.5.5 Create Variable: claude_parsed --> claude_parsed
                  6.5.6 Edit FuelPrices (Claude fields only)
                CATCH:
                  6.5.7 Create Variable: mailgun_auth
                  6.5.8 Create Variable: error_subject
                  6.5.9 Create Variable: error_body
                  6.5.10 API Request to Mailgun (send error alert)

       6.6a Price-change detection (compares submitted prices against current database values)
            Description: Determines whether last_updated should advance or preserve existing timestamp.
            A "no change" submission (caller confirms same prices) refreshes last_checked but preserves last_updated.
            6.6a.1 Create Variable: prices_changed --> prices_changed
                   Value: false
            6.6a.2 Conditional: gas price differs from database
                   IF gas_price_dec != null AND gas_price_dec > 0 AND gas_price_dec != FuelPrices1.gas_price:
                     Update Variable: prices_changed = true
            6.6a.3 Conditional: diesel price (after tax adjustment) differs from database
                   IF adjusted_diesel != null AND adjusted_diesel > 0 AND adjusted_diesel != FuelPrices1.diesel_price:
                     Update Variable: prices_changed = true
            6.6a.4 Create Variable: new_last_updated --> new_last_updated
                   Value: FuelPrices1.last_updated (preserve existing timestamp by default)
            6.6a.5 Conditional: advance last_updated only if prices changed
                   IF prices_changed == true:
                     Update Variable: new_last_updated = $now

       6.6b-prep Preserve existing prices when no new value was submitted (M6 fix, v4.22)
            Description: Prevents empty/zero price inputs from overwriting existing database values
                         (e.g., sentinel 9999 for "no diesel" being zeroed out on gas-only call submissions).
            6.6b-prep.1 Create Variable: final_gas_price --> final_gas_price
                   Value: gas_price_dec (submitted value)
            6.6b-prep.2 Conditional: gas_price_dec is null or 0
                   IF gas_price_dec == null OR gas_price_dec == 0:
                     Update Variable: final_gas_price = FuelPrices1.gas_price (preserve existing)
            6.6b-prep.3 Create Variable: final_diesel_price --> final_diesel_price
                   Value: adjusted_diesel (submitted value after tax adjustment)
            6.6b-prep.4 Conditional: adjusted_diesel is null or 0
                   IF adjusted_diesel == null OR adjusted_diesel == 0:
                     Update Variable: final_diesel_price = FuelPrices1.diesel_price (preserve existing)
            6.6b-prep.5 Create Variable: final_diesel_tax --> final_diesel_tax
                   Value: diesel_tax_rate (submitted value)
            6.6b-prep.6 Conditional: adjusted_diesel is null or 0
                   IF adjusted_diesel == null OR adjusted_diesel == 0:
                     Update Variable: final_diesel_tax = FuelPrices1.diesel_tax (preserve existing)

       6.6b Edit FuelPrices (prices and timestamps, always runs)
            Data: last_checked = now, last_updated = new_last_updated, gas_price = final_gas_price,
                  diesel_price = final_diesel_price, diesel_tax = final_diesel_tax,
                  last_call = now, call_snooze_until = null, last_call_connection = now
            Description: last_checked always advances (we confirmed contact).
                         last_updated only advances if prices actually changed.
                         Prices and diesel_tax use final_* variables that preserve existing DB values
                         when no new value was submitted (M6 fix).

       6.7 Update Variable: result = FuelPrices2
```

### submit_call XanoScript

```xanoscript
// Processes a completed marina phone call. Validates API token for Adalo-to-Xano authentication. Saves gas/diesel prices (with percentage-based diesel tax addition when tax rate > 0), parses free-text notes via Claude for status/closure/hours info, updates all timestamps, and clears any active snooze. Includes Try/Catch with Mailgun error alerting for Claude failures.
// All numeric inputs accepted as text because Adalo Custom Actions cannot send unquoted values in JSON bodies. Cast to proper types inside the stack.
// last_checked always updates (confirms the marina was contacted). last_updated only advances when a price actually changed.
// M4 security: Price validation gates use != 0 (not > 0) so negative values cannot bypass the $2-$15 range check.
query submit_call verb=POST {
  api_group = "Fuel Docks API"

  input {
    // Shared secret token for authentication (must match FD_API_TOKEN or DIALER_API_TOKEN env var)
    text api_token filters=trim

    // ID of the marina record in FuelPrices table (text because Adalo sends quoted values; cast to int in stack)
    text marina_id filters=trim

    // Gas price per gallon as displayed at the pump (text; cast to decimal in stack)
    text gas_price? filters=trim

    // Diesel price per gallon as entered by caller (text; cast to decimal in stack)
    text diesel_price? filters=trim

    // Diesel tax as percentage rate (text; cast to decimal in stack). 0 = no tax to add; >0 = percentage rate to apply via multiplication (e.g., 0.089 = 8.9%)
    text diesel_tax_included? filters=trim

    // Free-text call notes for Claude to parse for status, closures, hours
    text notes? filters=trim
  }

  stack {
    // Security: Reject requests without valid API token before any processing occurs
    precondition ($input.api_token == $env.FD_API_TOKEN || $input.api_token == $env.DIALER_API_TOKEN) {
      error_type = "accessdenied"
      error = "Unauthorized"
    }
  
    // Cast text inputs to proper numeric types for calculations and db writes
    // Cast marina_id from text to integer because Adalo Custom Actions cannot send unquoted integers in JSON bodies
    var $marina_id_int {
      value = $input.marina_id|to_int
    }
  
    // Cast gas_price from text to decimal for db storage
    var $gas_price_dec {
      value = $input.gas_price|to_decimal
    }
  
    // Cast diesel_price from text to decimal for tax calculation and db storage
    var $diesel_price_dec {
      value = $input.diesel_price|to_decimal
    }
  
    // Cast diesel_tax_included from text to decimal for percentage-based tax addition logic
    var $diesel_tax_dec {
      value = $input.diesel_tax_included|to_decimal
    }
  
    // Guard: skip all operations if marina_id is 0 or empty (safety net for malformed or test requests)
    // Holds the final db.edit response or null if marina_id is invalid
    var $result {
      value = null
    }
  
    conditional {
      if ($marina_id_int > 0) {
        // Step 1: Look up the marina record to get current data
        // Fetch current marina record for reference before updating
        db.get FuelPrices {
          field_name = "id"
          field_value = $marina_id_int
        } as $FuelPrices1
      
        // Validate that the marina_id actually exists in the database
        precondition ($FuelPrices1 != null) {
          error_type = "notfound"
          error = "Marina not found"
        }
      
        // M4 Input validation: reject gas prices outside reasonable marine fuel range ($2-$15 per gallon)
        // Uses != 0 instead of > 0 so negative values cannot bypass the range check (0 = "not provided" from Adalo)
        conditional {
          if ($gas_price_dec != null && $gas_price_dec != 0) {
            precondition ($gas_price_dec >= 2 && $gas_price_dec <= 15) {
              error = "Gas price out of valid range (2.00-15.00)"
            }
          }
        }
      
        // M4 Input validation: reject diesel prices outside reasonable marine fuel range ($2-$15 per gallon)
        // Uses != 0 instead of > 0 so negative values cannot bypass the range check (0 = "not provided" from Adalo)
        conditional {
          if ($diesel_price_dec != null && $diesel_price_dec != 0) {
            precondition ($diesel_price_dec >= 2 && $diesel_price_dec <= 15) {
              error = "Diesel price out of valid range (2.00-15.00)"
            }
          }
        }
      
        // Step 2: Capture current timestamp for all date fields
        // Current timestamp for last_checked, last_call, and last_call_connection
        var $now {
          value = now
        }
      
        // Step 3: Capture the submitted diesel tax percentage rate for addition logic and db storage
        // Diesel tax percentage rate for tax addition logic and db storage (e.g., 0.089 = 8.9%)
        var $diesel_tax_rate {
          value = $diesel_tax_dec
        }
      
        // Step 4: Diesel tax addition - multiply by (1 + rate) when tax rate > 0 and diesel price was provided
        // The diesel_tax field stores a percentage rate (e.g., 0.089 = 8.9%), not a flat dollar amount.
        // When the rate is nonzero, the entered price is multiplied by (1 + rate) to produce the tax-inclusive price.
        // Example: $4.35 entered with rate 0.089 = $4.35 x 1.089 = $4.737 stored in diesel_price.
        conditional {
          if ($diesel_tax_rate > 0 && $diesel_price_dec != null && $diesel_price_dec > 0) {
            // Multiply entered diesel price by (1 + tax rate) to add percentage-based tax
            // Diesel price after applying percentage-based tax addition
            var $adjusted_diesel {
              value = $diesel_price_dec * (1 + $diesel_tax_rate)
            }
          }
        
          else {
            // No tax adjustment needed - use the diesel price as entered
            // Diesel price with no tax adjustment applied
            var $adjusted_diesel {
              value = $diesel_price_dec
            }
          }
        }
      
        // Step 5: Parse call notes via Claude AI - only if notes were actually provided with content
        conditional {
          if ($input.notes != null && ($input.notes|strlen) > 0) {
            // Wrap Claude call in Try/Catch so failures send an alert instead of crashing the endpoint
            try_catch {
              try {
                // Build today's date string for Claude's date-aware closure logic
                // Today date string injected into Claude system prompt for date-aware closure logic
                var $today_date {
                  value = now
                    |format_timestamp:"m/d/Y":"America/Los_Angeles"
                }
              
                // System prompt instructs Claude to return structured JSON from free-text call notes
                // Claude system prompt for parsing free-text call notes into structured JSON
                var $system_prompt {
                  value = "CRITICAL: Output ONLY raw JSON. Never use markdown, backticks, or code fences. Start your response with { and end with }. The current date is " ~ $today_date ~ ". You are a marina fuel price extraction assistant. Extract status and operational data from phone call notes entered by a data collector after calling a marina. Respond ONLY with valid JSON, no other text. Use this exact structure: {\"open\": \"Open\", \"closure_note\": null, \"recheck_date\": null, \"hours\": null, \"comment\": null}. Rules: 1) open = FIRST check dates: if the notes mention a closure for a FUTURE date after " ~ $today_date ~ ", the marina is still operating today so set to exactly \"Open\" with no additional words. Only if the marina is actually closed or not fully operational RIGHT NOW on " ~ $today_date ~ " should you write a short user-facing reason (examples: \"Closed for winter maintenance\", \"Closed for Presidents Day\", \"By appointment only until March\", \"Under repair - no ETA given\"). Never write just \"Closed\" by itself because app users need to know why. If operating normally today or if unclear, set to exactly \"Open\". 2) closure_note = ANY closure information mentioned in the notes, whether current or future. Include the dates and reason. This field captures all closure details so nothing is lost. 3) recheck_date = If any date-specific closure or status change is mentioned (current or future), return the next date the status should be re-evaluated in MM/DD/YYYY format. For a closure starting on a future date, use that start date. For a closure currently in effect with a known end date, use the day after the last closed date. For indefinite closures or no closure information at all, use null. 4) hours = Operating hours if mentioned. 5) comment = Any other relevant information from the call notes."
                }
              
                // Call Claude Haiku to parse the notes into structured JSON
                // Send call notes to Claude Haiku for structured parsing
                function.run "Create chat completion -  Claude" {
                  input = {
                    model         : "claude-haiku-4-5"
                    max_tokens    : 500
                    system        : $system_prompt
                    prompt        : $input.notes
                    temperature   : 0
                    top_k         : null
                    top_p         : null
                    stop_sequences: null
                    image         : null
                    image2        : null
                  }
                } as $func1
              
                // Strip any markdown code fences Claude might add despite instructions
                // Raw Claude response with markdown fences stripped
                var $claude_raw {
                  value = $func1.result.content[0].text
                    |replace:"```json":""
                    |replace:"```":""
                    |trim
                }
              
                // Parse Claude's JSON response string into a usable object
                // Parsed JSON object from Claude response
                var $claude_parsed {
                  value = $claude_raw|json_decode
                }
              
                // Save the parsed status fields to the marina record
                // Write Claude-parsed status, closure, hours, and comment fields to the marina record
                db.edit FuelPrices {
                  field_name = "id"
                  field_value = $marina_id_int
                  data = {
                    open        : $claude_parsed.open
                    closure_note: $claude_parsed.closure_note
                    recheck_date: $claude_parsed.recheck_date
                    hours       : $claude_parsed.hours
                    ai_comment  : $claude_parsed.comment
                  }
                } as $FuelPrices3
              }
            
              catch {
                // Send error alert via Mailgun so Ken knows the Claude call failed
                // Prices and timestamps still save in Step 6b because execution continues after catch
                var $mailgun_auth {
                  value = "api:" ~ $env.MAILGUN_API_KEY
                }
              
                var $error_subject {
                  value = "Fuel Docks Alert: Call Note Parse Error - " ~ $FuelPrices1.fuel_dock
                }
              
                var $error_body {
                  value = "Marina: " ~ $FuelPrices1.fuel_dock ~ "\nMarina ID: " ~ $input.marina_id ~ "\nNotes: " ~ $input.notes ~ "\n\nXano Endpoint: submit_call\nError Type: " ~ $func1.result.error.type ~ "\nError Message: " ~ $func1.result.error.message ~ "\nHTTP Status: " ~ $func1.status
                }
              
                api.request {
                  url = "https://api.mailgun.net/v3/mg.fueldocks.app/messages"
                  method = "POST"
                  params = {}
                    |set:"from":"Fuel Docks Alerts <alerts@mg.fueldocks.app>"
                    |set:"to":"ken@navigatormktg.com"
                    |set:"subject":$error_subject
                    |set:"text":$error_body
                  headers = []
                    |push:("Authorization: Basic %s"
                      |sprintf:($mailgun_auth|base64_encode)
                    )
                } as $api1
              }
            }
          }
        }
      
        // Step 6a: Determine if any submitted price differs from what is currently in the database
        // Compare submitted values against existing record so last_updated only advances on actual price changes
        // A "no change" submission (caller confirms same prices) still refreshes last_checked but preserves last_updated
        var $prices_changed {
          value = false
        }
      
        // Check if a new gas price was submitted and differs from the current database value
        conditional {
          if ($gas_price_dec != null && $gas_price_dec > 0 && $gas_price_dec != $FuelPrices1.gas_price) {
            var.update $prices_changed {
              value = true
            }
          }
        }
      
        // Check if the final diesel price (after tax adjustment) differs from the current database value
        conditional {
          if ($adjusted_diesel != null && $adjusted_diesel > 0 && $adjusted_diesel != $FuelPrices1.diesel_price) {
            var.update $prices_changed {
              value = true
            }
          }
        }
      
        // Resolve which last_updated value to write: $now if prices changed, otherwise keep the existing timestamp
        var $new_last_updated {
          value = $FuelPrices1.last_updated
        }
      
        conditional {
          if ($prices_changed == true) {
            var.update $new_last_updated {
              value = $now
            }
          }
        }
      
        // Step 6b-prep: Preserve existing prices when no new value was submitted (M6 fix, v4.22)
        // When gas_price is 0/empty (not provided), keep the current database value instead of overwriting with 0
        var $final_gas_price {
          value = $gas_price_dec
        }

        conditional {
          if ($gas_price_dec == null || $gas_price_dec == 0) {
            var.update $final_gas_price {
              value = $FuelPrices1.gas_price
            }
          }
        }

        // When diesel_price is 0/empty (not provided), keep the current database value instead of overwriting with 0
        // This prevents sentinel values (e.g. 9999 for "no diesel") from being zeroed out on gas-only call submissions
        var $final_diesel_price {
          value = $adjusted_diesel
        }

        conditional {
          if ($adjusted_diesel == null || $adjusted_diesel == 0) {
            var.update $final_diesel_price {
              value = $FuelPrices1.diesel_price
            }
          }
        }

        // Also preserve existing diesel_tax when no new diesel price was submitted
        var $final_diesel_tax {
          value = $diesel_tax_rate
        }

        conditional {
          if ($adjusted_diesel == null || $adjusted_diesel == 0) {
            var.update $final_diesel_tax {
              value = $FuelPrices1.diesel_tax
            }
          }
        }

        // Step 6b: Update the marina record with prices, tax rate, timestamps, and clear any active snooze
        // Write prices, tax rate, timestamps, and clear snooze. Sets both last_call and last_call_connection since someone was reached.
        // last_checked always advances (we confirmed contact). last_updated only advances if prices actually changed.
        // M6: Uses final_* variables that preserve existing DB values when no new price was submitted.
        db.edit FuelPrices {
          field_name = "id"
          field_value = $marina_id_int
          data = {
            last_checked        : $now
            last_updated        : $new_last_updated
            gas_price           : $final_gas_price
            diesel_price        : $final_diesel_price
            diesel_tax          : $final_diesel_tax
            last_call           : $now
            call_snooze_until   : null
            last_call_connection: $now
          }
        } as $FuelPrices2
      
        var.update $result {
          value = $FuelPrices2
        }
      }
    }
  }

  response = $result
}
```

### Important Implementation Notes

- **API token authentication:** The endpoint validates `api_token` against the `FD_API_TOKEN` environment variable as the first operation in the stack. Requests without a valid token receive a 403 "Unauthorized" error before any database operations occur.
- **Input validation for price range (M4 security):** Gas and diesel prices are validated to be within $2.00-$15.00 per gallon when provided. This prevents accidental data corruption from typos (e.g., entering "55" instead of "5.50") and blocks malicious or malformed negative values. The validation gate uses `!= 0` (not `> 0`) so that negative values are caught by the $2-$15 range check rather than bypassing it. Zero and null are treated as "not provided" from Adalo and skip validation. Originally used `> 0` which allowed negative values to bypass the range check entirely and write directly to the database (fixed in v3.13, M4 remediation).
- **Marina existence check:** After the db.get, a precondition verifies `$FuelPrices1 != null` before any further processing. Invalid marina IDs return a 404 "Marina not found" error.
- **All inputs are text type (Adalo compatibility):** All numeric inputs (`marina_id`, `gas_price`, `diesel_price`, `diesel_tax_included`) are `text` instead of `int`/`decimal` because Adalo Custom Actions cannot send unquoted values in JSON request bodies. Adalo's JSON validator rejects `{"marina_id": [chip]}` and requires `{"marina_id": "[chip]"}`, wrapping all values in quotes. The endpoint casts to proper types internally using `|to_int` and `|to_decimal`.
- **Guard clause for Adalo test requests:** When configuring a Custom Action in Adalo, the "RUN TEST REQUEST" button sends empty placeholder values for all inputs. Without the guard clause, `to_int` on an empty string produces 0, causing a 404 on the db.get. The `$marina_id_int > 0` guard returns null instead, allowing the test to succeed with a 200 response.
- **XanoScript `to_decimal` not `to_float`:** The Xano expression filter for converting text to decimal is `to_decimal`, not `to_float`. Using `to_float` produces "Invalid filter name: to_float" error. This was discovered during the initial deployment attempt.
- **diesel_tax_included is a decimal, not a boolean:** Adalo sends the tax percentage rate (from the marina's `diesel_tax` field when the checkbox is checked, or 0 when unchecked). The endpoint multiplies the entered diesel price by `(1 + rate)` to add the percentage-based tax when the rate is greater than 0. This avoids the need for the endpoint to look up the marina's stored tax rate separately.
- **Empty prices preserve existing database values (M6 fix, v4.22):** When `gas_price` or `diesel_price` is not submitted (empty/null, cast to 0), Step 6b-prep falls back to the existing database value from `$FuelPrices1` instead of writing 0. This prevents sentinel values (e.g., 9999 for marinas that don't sell diesel) from being silently zeroed out. The bug was discovered when North Lake Marina (gas-only, `sells_diesel: false`) appeared in the diesel price list at $0.00 — every call submission had been overwriting `diesel_price: 9999` with `diesel_price: 0` because the FD Dialer hides the diesel price field for gas-only marinas, sending an empty value that was cast to 0 and written unconditionally. The same guard applies to `diesel_tax` when no diesel price is submitted.
- **diesel_tax written back on every submit:** Step 6b writes `diesel_tax: $final_diesel_tax` to the database on every submission where a diesel price was provided. This keeps the stored tax rate in sync with whatever the caller indicated. If a marina changes their tax quoting behavior, the next submission automatically updates the stored rate. When no diesel price is submitted, the existing diesel_tax is preserved (M6 fix).
- **Two separate db.edit calls:** The endpoint uses two Edit FuelPrices operations. The first (step 6.5.6, inside the notes conditional) writes only Claude-parsed status fields. The second (step 6.6b, always runs inside the guard) writes prices, timestamps, and clears snooze. This separation ensures prices and timestamps are always updated even when no notes are provided, while Claude fields are only written when Claude actually runs.
- **Try/Catch with Mailgun error alerting:** The Claude call is wrapped in a Try/Catch block. If Claude fails (API error, malformed response), the catch block sends an error alert email to ken@navigatormktg.com via Mailgun with the marina name, ID, notes text, error type, and error message. Execution continues to Step 6a/6b after the catch, so prices and timestamps still save even when Claude fails.
- **Price-change detection preserves last_updated:** Step 6a compares the submitted gas price and the tax-adjusted diesel price against the current database values from `$FuelPrices1`. If neither price has changed, `$new_last_updated` retains the existing `last_updated` timestamp. If either price differs, `$new_last_updated` is set to `$now`. This matches the behavior in `mailgun_inbound` (v2.17) and `apify_webhook` where "no change" responses preserve `last_updated` while always advancing `last_checked`. The comparison uses the post-tax-adjustment `$adjusted_diesel` (not the raw input) so the comparison is apples-to-apples with what gets written to the database.
- **strlen for robust empty checking:** The notes conditional uses `$input.notes|strlen > 0` in addition to the null check. This guards against whitespace-only or empty-string inputs that would send a blank prompt to Claude and get unparseable results.
- **max_tokens reduced to 500:** The call-notes Claude call uses `max_tokens: 500` instead of the 1024 used by `apify_webhook` and `mailgun_inbound`. Call notes are typically brief, and the response JSON is small (no price fields). This reduces Claude API cost per call.
- **hours_json auto-invalidation (v4.25):** When Claude parses call notes and returns a non-null `hours` value, the db.edit that writes the new hours also sets `hours_json = null`. This triggers the nightly `parse_hours_json` task to re-parse the updated hours text into structured schedule data. If Claude returns null for hours (no hours mentioned in the notes), `hours_json` is left untouched. This is implemented as a conditional branch: one db.edit includes `hours_json: null` (when hours changed), the other omits it (when hours unchanged).
- **Adalo Custom Action body requires Magic Text chips:** The Custom Action body must use Adalo's Magic Text icon to insert input references as chips (orange pill-shaped tokens). Typing the input name as plain text does not work. Each chip is wrapped in quotes in the JSON body (e.g., `"[marina_id chip]"`). Hardcoded values in the body were the root cause of the original submit button failure.

---

## 8.9 Consumer Endpoint H1 Hardening

All six consumer-facing API endpoints share a common H1 hardening pattern applied in February 2026. This section documents the shared pattern once rather than repeating it for each endpoint.

### Rationale

Consumer endpoints previously returned full database records including internal fields such as contact emails, scraping hashes, email cadence data, and AI processing notes. H1 remediation restricts responses to display-relevant fields only, preventing data leakage of operational internals to the mobile app and any third parties who might inspect API traffic.

### Endpoints Covered

- `closed_marinas` #18
- `gas_price_low_to_high` #19
- `diesel_price_low_to_high` #20
- `gas_prices_by_distance` #21
- `diesel_prices_by_distance` #45
- `marina_detail` #46
- `map_marinas` #48

### Control 1: Response Field Whitelisting

Each endpoint builds its response using only display-relevant fields. The standard set is 21 fields (in this order):

`id`, `fuel_dock`, `last_updated`, `last_checked`, `gas_price`, `diesel_price`, `diesel_tax`, `open`, `closure_note`, `cash_card`, `vol_discount`, `gas_comment`, `diesel_comment`, `hours`, `comment`, `website`, `City`, `phone`, `extension`, `latitude`, `longitude`

The `marina_detail` endpoint (#46) includes one additional field, `youtube`, for a total of 22 fields (added v4.0 for the React Native consumer app's YouTube button feature). The other consumer endpoints do not include `youtube` as they are list endpoints where the field is not displayed.

These 19 internal/operational fields are deliberately excluded from all consumer responses:

`last_content_hash`, `css_selector`, `contact_email`, `email_cadence`, `last_email_sent`, `last_email_response`, `consecutive_unanswered`, `email_subject`, `email_body`, `call_cadence`, `last_call`, `call_snooze_until`, `last_call_connection`, `ai_comment`, `suspend_until`, `recheck_date`, `Method`, `price_processing_rule`, `youtube` (excluded from list endpoints only; included in `marina_detail`)

### Control 2: 60-Second Response Caching

Each endpoint has Xano's built-in response cache enabled with a 60-second TTL. The cache key is per unique combination of input parameters, so the distance endpoints cache separately per lat/lon pair. This limits how frequently anyone can poll for fresh data and reduces database load under high request volume.

The cache is configured via Xano's built-in cache toggle on each endpoint, not via an environment variable.

### Control 3: Server-Side Relative Timestamp

Each endpoint computes a `last_updated_relative` field server-side from the `last_checked` timestamp. The computation uses Xano's built-in timestamp math: it calculates the difference between now and `last_checked`, then formats the result as "Updated X minutes/hours/days ago" depending on the magnitude.

This replaces exposing raw timestamps that could be used to fingerprint scraping schedules or determine exactly when the system last checked each marina.

### Distance Endpoint Specifics

The two distance endpoints (`gas_prices_by_distance` #21 and `diesel_prices_by_distance` #45) share identical logic beyond the standard H1 controls:

- **Inputs:** Accept `latitude` and `longitude` as inputs from the mobile app
- **Distance calculation:** Use `util.geo_distance` to compute distance in meters between the user's coordinates and each marina's coordinates, then convert to miles by dividing by 1609.34 and rounding to 1 decimal place
- **Additional response field:** The computed `distance_mi` field is included in the response alongside the 20 whitelisted fields (21 fields total for distance endpoints)
- **Sort order:** Results are sorted nearest-first (ascending by `distance_mi`)
- **Filtering:** Sentinel prices (9999) and closed marinas (`open` != "Open") are excluded from results
- **gas_prices_by_distance sort fix:** The sort direction on `gas_prices_by_distance` #21 was corrected from farthest-first to nearest-first during H1 remediation. This was a pre-existing bug where results were sorted descending instead of ascending by distance.

---

## 8.10 H4 Security: Claude Output Validation

### Security Finding -- H4

**Threat:** Prompt injection via scraped web content or inbound email bodies. A marina website or email reply could contain adversarial text designed to manipulate Claude's JSON output, for example injecting arbitrary HTML into the `open` or `comment` fields, setting extreme prices to corrupt the database, or embedding script content that reaches the Adalo mobile app. Because Claude parses untrusted third-party content, its output must be treated as untrusted and validated before any database write.

**Remediation:** A shared Custom Function (`Fuel Docks/validate_claude_output`, ID 37) validates and sanitizes all Claude output fields. Both `apify_webhook` and `mailgun_inbound` call this function after Claude parsing and before any `db.edit` call. All database writes use the validated output, never the raw parsed response.

### validate_claude_output Function Spec

**Location:** Library > Functions > Fuel Docks > validate_claude_output (ID 37)

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| `gas_price` | decimal, nullable | Claude-extracted gas price per gallon |
| `diesel_price` | decimal, nullable | Claude-extracted diesel price per gallon |
| `open` | text | Claude-extracted open/closed status string |
| `closure_note` | text, nullable | Claude-extracted closure details |
| `recheck_date` | text, nullable | Claude-extracted recheck date (MM/DD/YYYY) |
| `hours` | text, nullable | Claude-extracted operating hours |
| `comment` | text, nullable | Claude-extracted comment (maps to ai_comment) |
| `current_gas_price` | decimal | Current gas_price from FuelPrices record (for spike detection). Pass 0 to skip. |
| `current_diesel_price` | decimal | Current diesel_price from FuelPrices record (for spike detection). Pass 0 to skip. |

**Outputs:** Returns a single object with all validated fields plus metadata:

| Output Field | Description |
|--------------|-------------|
| `gas_price` | Validated gas price (nulled if outside $2.00-$15.00 range) |
| `diesel_price` | Validated diesel price (nulled if outside $2.00-$15.00 range) |
| `open` | Validated open field (forced to "Open" if format invalid) |
| `closure_note` | HTML-stripped, length-limited closure note |
| `recheck_date` | Passed through unchanged |
| `hours` | HTML-stripped, length-limited hours |
| `comment` | HTML-stripped, length-limited comment |
| `has_flags` | Boolean: true if any validation issue was detected |
| `flag_summary` | Concatenated text of all validation warnings for alert emails |

**Validation Rules:**

1. **Price range check ($2.00 - $15.00):** Gas and diesel prices outside this range are nulled out to prevent bad data from reaching the database. Separate conditional blocks for below-minimum and above-maximum because XanoScript does not support the `||` (OR) operator. Each rejection sets `has_flags = true` and appends a REJECTED message to `flag_summary`.

2. **Price spike detection (absolute delta > $2.00/gallon):** Compares new price against current database price. Uses `|abs` filter on the difference. Flags the update but ALLOWS it through so Ken can review via alert email. Only runs when both new and current prices are available and non-zero.

3. **Open field validation:** Must be exactly "Open" or start with "Closed". HTML angle brackets (`<` and `>`) stripped first, then format validated, then length limited to 200 characters. Non-matching values are forced to "Open" with a flag preserving the original value in `flag_summary`.

4. **Text field sanitization:** All user-facing text fields (`closure_note`, `hours`, `comment`) have HTML angle brackets stripped via `|replace:"<":""|replace:">"":""` and are length-limited (`closure_note`: 500 chars, `hours`: 200 chars, `comment`: 500 chars). Truncation of `comment` sets a flag; other fields truncate silently.

### Integration Pattern

Both `apify_webhook` and `mailgun_inbound` follow this sequence after Claude parsing:

1. Call `validate_claude_output` with parsed response fields and current DB prices
2. Store result as `$validated`
3. Check `$validated.has_flags` -- if true, send H4 flag alert email via Mailgun
4. Write `$validated` fields (not raw `$parsed_response` fields) to `db.edit`

---

## 8.11 Redis Rate Limiting (v3.12, removed v3.16)

Redis-based rate limiting was added to all six write-capable and webhook endpoints in v3.12 (March 2026) using Xano's `redis.ratelimit` function. Rate limits served as a second line of defense after authentication, positioned immediately after the authentication precondition in each endpoint's function stack.

**Removed in v3.16:** The `redis.ratelimit` blocks were removed from all six endpoints because the current Xano subscription tier does not support Redis. The feature is not available on this plan.

### Endpoints Affected

| Endpoint | API ID | Former Key | Former Max | Former Window | Former Rationale |
|----------|--------|------------|------------|---------------|------------------|
| `apify_webhook` | #36 | `rl:apify_webhook` | 70 | 60s | Guarded against runaway Apify actor loops |
| `mailgun_inbound` | #39 | `rl:mailgun_inbound` | 20 | 60s | Guarded against Mailgun replay floods or misconfigured routing |
| `send_outbound_email` | #40 | `rl:send_outbound_email` | 5 | 60s | Prevented duplicate sends or runaway automation |
| `call_queue` | #42 | `rl:call_queue` | 10 | 60s | Prevented excessive polling from Adalo |
| `snooze_call` | #43 | `rl:snooze_call` | 10 | 60s | Prevented rapid-fire snooze taps from Adalo |
| `submit_call` | #44 | `rl:submit_call` | 10 | 60s | Prevented duplicate submissions or runaway calls from Adalo |

### Design Notes (Historical)

- **Global rate limits (not per-user):** All rate limit keys were global. Since the system has a single operator (Ken) and a small number of automated callers (Apify, Mailgun, Adalo), per-user segmentation was unnecessary at this scale.
- **apify_webhook was set to 70:** With 31 marinas and two actors (Cheerio + Playwright), a normal scrape cycle produces up to 62 webhook calls in rapid succession. The 70 limit provided headroom above normal traffic while still catching runaway loops.
- **Consumer GET endpoints were not rate limited:** The H1-hardened Adalo consumer endpoints (`gas_price_low_to_high`, `diesel_price_low_to_high`, etc.) rely on 60-second response caching instead of rate limiting. These endpoints serve read-only data and pose no write risk.
- **Redis keys were namespaced with `rl:` prefix:** All rate limit keys started with `rl:` to avoid collisions with other Redis usage in the workspace.
- **Added March 2026 (v3.12). Removed March 2026 (v3.16) because the Xano subscription tier does not support Redis.**

---

## 8.12 M4 Security: Input Price Range Validation Hardening (v3.13)

### Security Finding -- M4

**Threat:** Negative or extreme price values submitted through the `submit_call` endpoint could bypass the $2-$15 range validation and write directly to the database. The original validation gate used `> 0` as the condition for entering the range check block. A negative value like "-5.00" evaluates false for `> 0`, causing execution to skip the range check entirely and proceed to the database write with the invalid price.

**Affected Endpoint:** `submit_call` (POST #44) in the Fuel Docks API group.

**Not Affected:** `apify_webhook` (#36) and `mailgun_inbound` (#39) are not vulnerable because they route through the `validate_claude_output` function (ID #37), which independently enforces the $2-$15 range by checking `< 2` and `> 15` as separate conditions. Out-of-range values are nulled out regardless of sign.

### Root Cause

The validation blocks used this pattern:

```
if ($gas_price_dec != null && $gas_price_dec > 0) {
  precondition ($gas_price_dec >= 2 && $gas_price_dec <= 15)
}
```

The `> 0` gate was intended to mean "a price was provided." However, it also excluded negative values, which should have been caught by the $2-$15 range check.

### Fix

Changed the gate condition from `> 0` to `!= 0` in both gas and diesel validation blocks:

```
if ($gas_price_dec != null && $gas_price_dec != 0) {
  precondition ($gas_price_dec >= 2 && $gas_price_dec <= 15)
}
```

This preserves the original intent (0 and null mean "not provided" and skip validation) while ensuring any nonzero value, including negative numbers, enters the range check.

### Behavior After Fix

| Input Value | Before (v3.12) | After (v3.13) |
|-------------|-----------------|---------------|
| null / empty / "0" | Skips validation (not provided) | Same |
| "-5.00" | **BYPASSED validation, wrote to DB** | Rejected: out of valid range |
| "1.50" | Rejected (below $2) | Same |
| "5.50" | Accepted | Same |
| "20.00" | Rejected (above $15) | Same |

### Validation Approach Comparison

The three price-writing endpoints use two different validation strategies:

- **submit_call (hard rejection):** Precondition blocks reject out-of-range prices with an HTTP error. The invalid value never reaches the database. This is appropriate for manual entry where the operator can immediately correct the input.
- **apify_webhook and mailgun_inbound (soft nulling via validate_claude_output):** Out-of-range prices are nulled out (no write to the price field) and a flag alert email is sent to Ken. The record still updates other fields. This is appropriate for automated channels where there is no interactive user to retry.

**Added March 2026 (v3.13).**

---

## 8.13 M5 Security: Content Hashing Algorithm Upgrade (v3.14)

### Security Finding -- M5

**Threat:** The `apify_webhook` endpoint used MD5 (`$webhook1.scraped_content|md5:false`) for content change detection. MD5 is cryptographically broken. While the practical risk is low for change detection (an attacker would need to craft page content producing the same MD5 hash as different content, which is theoretically possible but impractical), upgrading to a stronger algorithm eliminates the concern entirely and avoids the edge case of MD5 collisions on very similar page content.

**Affected Endpoint:** `apify_webhook` (POST #36) in the Fuel Docks API group.

### Fix

Replaced the MD5 filter with HMAC-SHA256, keyed with the existing `APIFY_WEBHOOK_TOKEN` environment variable:

**Before (v3.13):**
```
var $content_hash {
  value = $webhook1.scraped_content|md5:false
}
```

**After (v3.14):**
```
// M5 Security: SHA-256 hash for content change detection (replaces MD5, March 2026)
// Uses HMAC-SHA256 keyed with webhook token for stronger collision resistance
// Note: first run after this change will trigger Claude calls for all marinas (one-time hash mismatch)
var $content_hash {
  value = $webhook1.scraped_content|hmac_sha256:$env.APIFY_WEBHOOK_TOKEN:false
}
```

### Why HMAC-SHA256 Instead of Plain SHA-256

Using `hmac_sha256` with a key (rather than a plain SHA-256 hash) provides two benefits: stronger collision resistance through the keyed construction, and reuse of the existing `APIFY_WEBHOOK_TOKEN` environment variable (no new secrets needed). Xano's built-in `hmac_sha256` filter accepts the key as the first parameter and returns a 64-character hex string (compared to MD5's 32 characters). The `last_content_hash` field in FuelPrices is a text type, so no schema change was needed.

### One-Time Hash Mismatch on Deployment

Switching the hash algorithm means every stored MD5 hash (32-character hex string) will not match the new HMAC-SHA256 hash (64-character hex string) on the next scrape cycle. This triggers a Claude API call for all ~31 web-scraped marinas during the first run after deployment. Estimated one-time cost: $0.10-0.15. After that first pass, change detection resumes normally with the new algorithm.

### Additional Change

Updated the `last_content_hash` field description in the FuelPrices table to document the algorithm change: "HMAC-SHA256 hash of last scraped content, keyed with APIFY_WEBHOOK_TOKEN. Used for change detection to skip Claude API calls when page content is unchanged. Upgraded from MD5 in March 2026 (M5 security remediation)."

**Added March 2026 (v3.14).**

---

## 8.14 apify_marina_list Endpoint Detail (Updated v3.25)

The `apify_marina_list` endpoint (api_id #38) returns marina scraping configuration for Apify actors. Updated in v3.25 to support an optional `id` parameter for single-marina lookups triggered by the `report_price` endpoint.

### Authentication

Validates `token` input against `$env.APIFY_WEBHOOK_TOKEN`. Returns HTTP 403 "Unauthorized" if missing or incorrect (H2 security remediation).

### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `token` | text | Yes | -- | Shared secret for Apify actor authentication |
| `method` | text | No | "HTML" | Filter by collection method: "HTML" or "Javascript" (batch runs) |
| `id` | int | No | 0 | Return a single marina by ID (single-marina runs from report_price) |

### Function Stack

1. **Precondition:** Validate token against `$env.APIFY_WEBHOOK_TOKEN`
2. **Conditional:** If `id` is not null and > 0, query FuelPrices by id and `return` early with single-item array
3. **Batch query:** If id is absent/0, query FuelPrices by Method (falls through to here because the single-marina path uses early return)
4. **Response:** Array of `{id, fuel_dock, website, css_selector}` (same shape for both paths)

### apify_marina_list XanoScript

```xanoscript
// Returns marinas for Apify actors to scrape. When id is provided, returns a single marina
// (used by report_price triggered runs). When id is absent, returns all marinas for the
// given Method (used by scheduled batch runs). Validates token against APIFY_WEBHOOK_TOKEN.
query apify_marina_list verb=GET {
  api_group = "Fuel Docks API"

  input {
    // Shared secret token for Apify actor authentication
    text token filters=trim

    // Filter by collection method: "HTML" or "Javascript" (used by batch runs)
    text method?=HTML filters=trim

    // Optional: return a single marina by ID (used by report_price single-marina runs)
    int id?
  }

  stack {
    // H2 Security: Reject requests without valid Apify webhook token
    precondition ($input.token == $env.APIFY_WEBHOOK_TOKEN) {
      error_type = "accessdenied"
      error = "Unauthorized"
    }

    // Single-marina lookup: if id is provided, query by id and return early
    conditional {
      if ($input.id != null && $input.id > 0) {
        db.query FuelPrices {
          where = $db.FuelPrices.id == $input.id
          return = {type: "list"}
          output = ["id", "fuel_dock", "website", "css_selector"]
        } as $single_result

        return {
          value = $single_result
        }
      }
    }

    // Batch lookup: return all marinas for the given Method (original behavior)
    // Only reached when id is not provided
    db.query FuelPrices {
      where = $db.FuelPrices.Method == $input.method
      return = {type: "list"}
      output = ["id", "fuel_dock", "website", "css_selector"]
    } as $batch_result
  }

  response = $batch_result
}
```

### Important Implementation Notes

1. **XanoScript variable scoping requires early return pattern:** Variables declared inside conditional branches (if/else) are not accessible from the `response =` line at the stack's top level. The original implementation attempted to declare `$response` before the conditional and use `var.update` inside each branch, but Xano returned "Unable to locate response" at runtime. The working pattern uses `return` inside the single-marina conditional to exit early, with the batch query at the stack's top level (outside the conditional) where its `as $batch_result` variable is naturally in scope for the `response` line.
2. **Xano optional int defaults to 0, not null:** When the `id` parameter is not provided in the URL, Xano sets it to 0 (the default for optional integers). The conditional checks `$input.id != null && $input.id > 0` to correctly route both absent and zero values to the batch path.
3. **Response shape is identical for both paths:** Both paths return an array of objects with `{id, fuel_dock, website, css_selector}`. The single-marina path returns a one-element array, not a single object. This allows Apify actors to use the same loop logic regardless of mode.

---

## 8.15 report_price Endpoint Detail (v3.25)

The `report_price` endpoint (api_id #47) receives price correction reports from consumer app users. It does NOT write reported prices to the database. Instead, it sends an alert email to Ken and triggers automated re-verification based on the marina's collection Method.

### Authentication

Validates `api_token` input against `$env.CONSUMER_API_TOKEN` (separate from FD_API_TOKEN). Returns HTTP 401 "Unauthorized" if invalid.

### Inputs

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `api_token` | text | Yes | Must match `$env.CONSUMER_API_TOKEN` |
| `marina_id` | text | Yes | Cast to int internally (Adalo sends quoted strings) |
| `reported_gas` | text | No | Cast to decimal; validated $2-$15 range. Renamed from `gas_price` in v4.26 to prevent Xano auto-merge bug (see M7). |
| `reported_diesel` | text | No | Cast to decimal; validated $2-$15 range. Renamed from `diesel_price` in v4.26 to prevent Xano auto-merge bug (see M7). |
| `comments` | text | No | Free text from user |

### Function Stack

1. **Precondition:** Validate api_token against `$env.CONSUMER_API_TOKEN`
2. **Cast marina_id** from text to int via `|to_int`
3. **Guard clause:** Return null if marina_id is 0 (Adalo test requests)
4. **db.get FuelPrices** by id to look up the marina record
5. **Precondition:** Marina must exist
6. **Cast prices** to decimal when provided (skip empty strings)
7. **Require at least one data field** (gas_price, diesel_price, or comments)
8. **Validate price ranges** ($2-$15) when provided
9. **Format display strings** for current database prices and reported prices
10. **Determine automated action** text based on marina's Method field
11. **Build alert email body** with marina info, current vs. reported prices, comments, and action taken
12. **Send alert email** to ken@navigatormktg.com via Mailgun (mg.fueldocks.app domain)
13. **Execute automated action** based on Method:
    - **HTML:** POST to Apify API to trigger Cheerio actor with `marina_id` in the run input
    - **Javascript:** POST to Apify API to trigger Playwright actor with `marina_id` in the run input
    - **Call:** `db.edit` to set `last_call_connection` to null (marina enters call queue immediately)
    - **Email:** Send immediate price check email via Mailgun (navigatorpnw.com domain), then update `last_email_sent` and increment `consecutive_unanswered`
    - **Facebook:** No automated action (noted in alert email)
14. **Response:** `{status: "success", message: "Thank you for your report"}`

### report_price XanoScript

```xanoscript
// Receives price correction reports from consumer app users. Does NOT write reported
// prices to the database. Sends alert email to Ken, then triggers automated re-verification:
// Apify single-marina run (HTML/Javascript), call queue reset (Call), or immediate
// price check email (Email). Secured with CONSUMER_API_TOKEN.
query report_price verb=POST {
  api_group = "Fuel Docks API"

  input {
    // Consumer app authentication token
    text api_token

    // Marina ID (text because Adalo sends quoted strings; cast to int in stack)
    text marina_id

    // Reported gas price (optional; text for Adalo compatibility; cast to decimal)
    text gas_price?

    // Reported diesel price (optional; text for Adalo compatibility; cast to decimal)
    text diesel_price?

    // Free text comments from the user
    text comments?
  }

  stack {
    // Authenticate consumer app token
    precondition ($input.api_token == $env.CONSUMER_API_TOKEN) {
      error_type = "accessdenied"
      error = "Unauthorized"
    }

    // Cast marina_id from text to integer (Adalo sends quoted strings)
    var $marina_id {
      value = $input.marina_id|to_int
    }

    // Guard clause for Adalo test requests with empty/zero marina_id
    conditional {
      if ($marina_id == 0) {
        return {
          value = null
        }
      }
    }

    // Look up the marina record
    db.get FuelPrices {
      field_name = "id"
      field_value = $marina_id
    } as $marina

    precondition ($marina != null) {
      error_type = "notfound"
      error = "Marina not found"
    }

    // Cast optional prices to decimal for validation
    var $gas_val {
      value = null
    }

    conditional {
      if ($input.gas_price != null && $input.gas_price != "") {
        var.update $gas_val {
          value = $input.gas_price|to_decimal
        }
      }
    }

    var $diesel_val {
      value = null
    }

    conditional {
      if ($input.diesel_price != null && $input.diesel_price != "") {
        var.update $diesel_val {
          value = $input.diesel_price|to_decimal
        }
      }
    }

    // Require at least one data field
    var $has_data {
      value = false
    }

    conditional {
      if ($gas_val != null) {
        var.update $has_data {
          value = true
        }
      }
    }

    conditional {
      if ($diesel_val != null) {
        var.update $has_data {
          value = true
        }
      }
    }

    conditional {
      if ($input.comments != null && $input.comments != "") {
        var.update $has_data {
          value = true
        }
      }
    }

    precondition ($has_data) {
      error_type = "badrequest"
      error = "At least one field (gas price, diesel price, or comments) is required"
    }

    // Validate price ranges when provided ($2-$15)
    conditional {
      if ($gas_val != null) {
        precondition ($gas_val >= 2 && $gas_val <= 15) {
          error_type = "badrequest"
          error = "Gas price must be between $2 and $15"
        }
      }
    }

    conditional {
      if ($diesel_val != null) {
        precondition ($diesel_val >= 2 && $diesel_val <= 15) {
          error_type = "badrequest"
          error = "Diesel price must be between $2 and $15"
        }
      }
    }

    // Format current database prices for the alert email
    var $current_gas_display {
      value = "N/A"
    }

    conditional {
      if ($marina.gas_price != null) {
        var.update $current_gas_display {
          value = "$" ~ ($marina.gas_price|number_format:2:".":"")
        }
      }
    }

    var $current_diesel_display {
      value = "N/A"
    }

    conditional {
      if ($marina.diesel_price != null && $marina.diesel_price != 9999) {
        var.update $current_diesel_display {
          value = "$" ~ ($marina.diesel_price|number_format:2:".":"")
        }
      }
    }

    conditional {
      if ($marina.diesel_price == 9999) {
        var.update $current_diesel_display {
          value = "Does not sell diesel"
        }
      }
    }

    // Format reported prices for the alert email (no tax field - Ken verifies manually)
    var $reported_gas_display {
      value = "Not reported"
    }

    conditional {
      if ($gas_val != null) {
        var.update $reported_gas_display {
          value = "$" ~ ($gas_val|number_format:2:".":"")
        }
      }
    }

    var $reported_diesel_display {
      value = "Not reported"
    }

    conditional {
      if ($diesel_val != null) {
        var.update $reported_diesel_display {
          value = "$" ~ ($diesel_val|number_format:2:".":"")
        }
      }
    }

    var $reported_comments {
      value = "None"
    }

    conditional {
      if ($input.comments != null && $input.comments != "") {
        var.update $reported_comments {
          value = $input.comments
        }
      }
    }

    // Determine what automated action will be taken based on Method
    var $action_taken {
      value = "None (unknown Method)"
    }

    conditional {
      if ($marina.Method == "HTML") {
        var.update $action_taken {
          value = "Triggered Cheerio actor for single-marina re-scrape"
        }
      }
    }

    conditional {
      if ($marina.Method == "Javascript") {
        var.update $action_taken {
          value = "Triggered Playwright actor for single-marina re-scrape"
        }
      }
    }

    conditional {
      if ($marina.Method == "Call") {
        var.update $action_taken {
          value = "Reset call queue (nulled last_call_connection) so marina is due for immediate callback"
        }
      }
    }

    conditional {
      if ($marina.Method == "Email") {
        var.update $action_taken {
          value = "Sent immediate price check email to marina contact"
        }
      }
    }

    conditional {
      if ($marina.Method == "Facebook") {
        var.update $action_taken {
          value = "No automated action available (Facebook method). Manual check required."
        }
      }
    }

    // Build alert email body
    var $email_body {
      value = "A Fuel Docks app user has reported a price discrepancy.\n\nMarina: " ~ $marina.fuel_dock ~ " (ID: " ~ $marina.id ~ ")\nCity: " ~ $marina.City ~ "\nMethod: " ~ $marina.Method ~ "\n\nCurrent database prices:\n  Gas: " ~ $current_gas_display ~ "\n  Diesel: " ~ $current_diesel_display ~ "\n\nUser-reported prices:\n  Gas: " ~ $reported_gas_display ~ "\n  Diesel: " ~ $reported_diesel_display ~ "\n  Comments: " ~ $reported_comments ~ "\n\nAutomated action taken: " ~ $action_taken
    }

    // Send alert email to Ken via mg.fueldocks.app
    var $mailgun_auth {
      value = "api:" ~ $env.MAILGUN_API_KEY
    }

    api.request {
      url = "https://api.mailgun.net/v3/mg.fueldocks.app/messages"
      method = "POST"
      params = {}
        |set:"from":"Fuel Docks Alerts <alerts@mg.fueldocks.app>"
        |set:"to":"ken@navigatormktg.com"
        |set:"subject":"Price Report: " ~ $marina.fuel_dock
        |set:"text":$email_body
      headers = []
        |push:"Authorization: Basic " ~ ($mailgun_auth|base64_encode)
    } as $alert_email_result

    // Take automated action based on Method
    conditional {
      if ($marina.Method == "HTML") {
        // Trigger Cheerio actor for single-marina scrape
        api.request {
          url = "https://api.apify.com/v2/acts/" ~ $env.APIFY_HTML_ACTOR_ID ~ "/runs?token=" ~ $env.APIFY_API_TOKEN
          method = "POST"
          params = {}|set:"marina_id":$marina_id
          headers = []
            |push:"Content-Type: application/json"
        } as $apify_result
      }
    }

    conditional {
      if ($marina.Method == "Javascript") {
        // Trigger Playwright actor for single-marina scrape
        api.request {
          url = "https://api.apify.com/v2/acts/" ~ $env.APIFY_JS_ACTOR_ID ~ "/runs?token=" ~ $env.APIFY_API_TOKEN
          method = "POST"
          params = {}|set:"marina_id":$marina_id
          headers = []
            |push:"Content-Type: application/json"
        } as $apify_result
      }
    }

    conditional {
      if ($marina.Method == "Call") {
        // Null last_call_connection so marina enters call queue immediately
        db.edit FuelPrices {
          field_value = $marina.id
          data = {last_call_connection: null}
        } as $call_reset
      }
    }

    conditional {
      if ($marina.Method == "Email") {
        // Send special one-off price check email immediately
        var $price_check_body {
          value = "Hi,\n\nWe have received a report that fuel prices at " ~ $marina.fuel_dock ~ " may have changed. Could you share your current gas and diesel prices when you get a chance?\n\nThank you!\n-Ken"
        }

        // Build Mailgun auth for navigatorpnw.com domain
        var $navigator_auth {
          value = "api:" ~ $env.MAILGUN_KEY_NAVIGATOR
        }

        api.request {
          url = "https://api.mailgun.net/v3/navigatorpnw.com/messages"
          method = "POST"
          params = {}
            |set:"from":"Ken Clements <ken@navigatorpnw.com>"
            |set:"to":$marina.contact_email
            |set:"subject":"Quick price check - " ~ $marina.fuel_dock
            |set:"text":$price_check_body
            |set:"o:store":"yes"
          headers = []
            |push:"Authorization: Basic " ~ ($navigator_auth|base64_encode)
        } as $email_result

        // Calculate new consecutive_unanswered count
        var $new_unanswered {
          value = 1
        }

        conditional {
          if ($marina.consecutive_unanswered != null) {
            var.update $new_unanswered {
              value = $marina.consecutive_unanswered + 1
            }
          }
        }

        // Update last_email_sent and increment unanswered counter
        // (treat as regular send so cadence restarts from now)
        db.edit FuelPrices {
          field_value = $marina.id
          data = {
            last_email_sent       : now
            consecutive_unanswered: $new_unanswered
          }
        } as $email_update
      }
    }
  }

  response = {
    status : "success"
    message: "Thank you for your report"
  }
}
```

### Important Implementation Notes

1. **Reported prices are never written to the database.** The endpoint only sends an alert email and triggers re-verification. This is a deliberate design choice: user-reported prices are unverified and could be incorrect. Ken reviews each report and the automated re-verification provides the actual price update through the normal scraping/email/call channels. **CRITICAL (v4.26):** The input parameters were renamed from `gas_price`/`diesel_price` to `reported_gas`/`reported_diesel` because Xano silently auto-merges input values into `db.edit` operations when input field names match database column names. See Section 8.17 (M7) for full details.
2. **Token separation:** `CONSUMER_API_TOKEN` is separate from `FD_API_TOKEN` so the consumer-facing token can be rotated independently if compromised, without disrupting the FD Dialer admin app.
3. **Email-method marinas:** The endpoint sends an immediate price check email directly (not via the `send_price_check_email` Custom Function) because the email template is different (a brief "prices may have changed" message rather than the full customizable template). It treats the send as a regular cadence send, updating `last_email_sent` and incrementing `consecutive_unanswered`.
4. **Call-method marinas:** Nulling `last_call_connection` causes the marina to appear in the call queue immediately because cadence only applies after a successful connection (see call_queue endpoint logic).
5. **Apify actor triggering:** Uses the Apify REST API at `https://api.apify.com/v2/acts/{actorId}/runs?token={apiToken}` with the `marina_id` as the JSON body. The actor reads this via `Actor.getInput()` and passes it to `apify_marina_list` as the `id` parameter.
6. **Facebook-method marinas:** No automated action is available. The alert email notes this and Ken must manually check the Facebook page.
7. **Email-method marinas without contact_email:** If `contact_email` is empty, the Mailgun API call will fail. The alert email to Ken is sent first, so Ken is aware of the report. A future improvement could add a precondition check before the email send block.
8. **No Try/Catch wrappers:** Unlike `apify_webhook` and `mailgun_inbound`, the `report_price` endpoint does not wrap its external API calls (Mailgun, Apify) in Try/Catch blocks. If the alert email or Apify trigger fails, the endpoint will return an error to the user. A future improvement could add Try/Catch so the user always sees "success" and failures are handled silently.

**Added March 2026 (v3.25).**

---

## 8.16 M6 Data Integrity: Empty Price Overwrite Prevention (v4.22)

### Data Integrity Finding -- M6

**Threat:** When a call is submitted for a marina that only sells one fuel type (e.g., gas only), the `submit_call` endpoint wrote `diesel_price: 0` to the database because the FD Dialer hides the diesel price field for gas-only marinas. The empty input was cast to 0 via `|to_decimal` and written unconditionally in Step 6b, overwriting the sentinel value of 9999 (which means "does not sell this fuel"). This caused the marina to appear in the diesel price list at $0.00, misleading consumers.

**Affected Endpoint:** `submit_call` (POST #44) in the Fuel Docks API group.

**Not Affected:** `apify_webhook` (#36) and `mailgun_inbound` (#39) are not affected because they use the `validate_claude_output` function which only writes price fields when Claude returns a non-null value.

### Root Cause

Step 6b unconditionally wrote `gas_price: $gas_price_dec` and `diesel_price: $adjusted_diesel` to the database on every submission. When a price field was not submitted (empty string from FD Dialer), `|to_decimal` cast it to 0, and the db.edit wrote 0 over whatever value was previously stored — including the 9999 sentinel used for marinas that don't sell that fuel type.

The validation gates in Step 6a correctly treated 0 as "not provided" and skipped price-change detection, but Step 6b still performed the destructive write.

### Discovery

North Lake Marina (Kenmore, WA, ID 42) — a gas-only marina with `sells_diesel: false` — appeared at the top of the consumer app's diesel price list showing $0.00. Investigation traced the `diesel_price` value from 9999 to 0 via `submit_call` submissions where the diesel price field was hidden in the FD Dialer UI.

### Fix

Added Step 6b-prep before the db.edit that resolves final price values:

```
var $final_gas_price { value = $gas_price_dec }
conditional {
  if ($gas_price_dec == null || $gas_price_dec == 0) {
    var.update $final_gas_price { value = $FuelPrices1.gas_price }
  }
}

var $final_diesel_price { value = $adjusted_diesel }
conditional {
  if ($adjusted_diesel == null || $adjusted_diesel == 0) {
    var.update $final_diesel_price { value = $FuelPrices1.diesel_price }
  }
}

var $final_diesel_tax { value = $diesel_tax_rate }
conditional {
  if ($adjusted_diesel == null || $adjusted_diesel == 0) {
    var.update $final_diesel_tax { value = $FuelPrices1.diesel_tax }
  }
}
```

Step 6b now writes `$final_gas_price`, `$final_diesel_price`, and `$final_diesel_tax` instead of the raw input values. When no price is submitted (0/null), the existing database value is preserved.

### Behavior After Fix

| Scenario | Before (v4.21) | After (v4.22) |
|----------|----------------|---------------|
| Gas-only marina, diesel field hidden | **diesel_price overwritten with 0** | diesel_price preserved (e.g., 9999) |
| Diesel-only marina, gas field hidden | **gas_price overwritten with 0** | gas_price preserved |
| Both prices submitted | Written normally | Same |
| Confirming same prices (no change) | Written normally (same values) | Same |
| Empty submission (notes only, no prices) | **Both prices overwritten with 0** | Both prices preserved |

**Added March 2026 (v4.22).**

---

## 8.17 M7 Data Integrity: Xano Input-Column Name Collision (v4.26)

### Data Integrity Finding -- M7

**Threat:** When a consumer app user submits a price report via the `report_price` endpoint, the user-reported prices silently overwrite the marina's actual verified prices in the database, even though the endpoint's `db.edit` data object does not include price fields.

### Root Cause

Xano auto-merges API endpoint input parameters into `db.edit` operations when the input field names exactly match database column names. The `report_price` endpoint had input parameters named `gas_price` and `diesel_price` — identical to the `FuelPrices` table column names. Even though the `db.edit` for the Email method path only specified `{last_email_sent: now, consecutive_unanswered: $new_unanswered}`, Xano silently included the input values of `gas_price` and `diesel_price` in the write.

### Discovery

A user submitted a test report for Covich Williams (ID 44) with gas=2 and diesel=2. The nightly CSV backup showed the marina had gas=4.50 and diesel=4.40 the night before. After the report submission, the database contained gas=2 and diesel=2. The `report_price` XanoScript was reviewed and confirmed to have no explicit price writes — proving the auto-merge behavior.

### Fix

Renamed the input parameters from `gas_price`/`diesel_price` to `reported_gas`/`reported_diesel` in both:
1. **Xano `report_price` endpoint** — input definitions and all internal variable references (`$input.reported_gas`, `$input.reported_diesel`)
2. **Expo consumer app** — `ReportPriceInput` interface in `services/api.ts` and the `handleSubmit` call in `app/report-price/[id].tsx`

Because the renamed inputs no longer match any database column names, Xano cannot auto-merge them into `db.edit` operations.

### Design Principle

**Never name API input parameters identically to database column names in endpoints that perform `db.edit` operations on the same table.** Xano's auto-merge behavior is undocumented and silent — there is no error, warning, or log entry. The only defense is naming discipline. Use prefixes like `reported_`, `input_`, or `submitted_` for user-provided values that should not be written directly.

**Added March 17, 2026 (v4.26).**

---

## 9. trigger_apify_scrapers Background Task Detail

The `trigger_apify_scrapers` Background Task (#2) is the automated scheduler that triggers both Apify scraper actors. It lives in the Xano Tasks section.

### Schedule

- **Frequency:** Every 3 hours
- **Start time:** Mar 8, 2026 6:00 AM Pacific (13:00:00 UTC, PDT)
- **Effective run times:** 6am, 9am, 12pm, 3pm, 6pm, 9pm, 12am, 3am (every 3 hours around the clock)
- **Time window enforcement:** The function stack checks the current Pacific hour and only triggers actors when `$current_hour >= 6 && $current_hour < 21`. This means 5 runs per day actually trigger actors (6am, 9am, 12pm, 3pm, 6pm). The 9pm run (hour 21) fails the `< 21` check and exits without triggering. Midnight and 3am runs also exit immediately.
- **Known off-by-one at 9pm:** The condition `$current_hour < 21` excludes hour 21 (9pm Pacific), so the last effective scrape each day is at 6pm. This was discovered during post-deployment debugging when marina price updates made after 6pm were not detected until the following morning's 6am run. To close this gap, either change the condition to `$current_hour <= 21` (to include 9pm) or reduce the scraping interval from 3 hours to 1 hour. Neither change has been made yet.

### Function Stack

```
1. Create Variable: current_hour        --> current_hour
     Value: now|format_timestamp:"H":"America/Los_Angeles"|to_int
     Description: Check current hour in Pacific time

2. Conditional
     IF current_hour >= 6 AND current_hour < 21:

       2.1 Try / Catch                  Description: Trigger HTML Scraper actor
         TRY:
           2.1.1 API Request To Apify   --> html_result
                 POST https://api.apify.com/v2/acts/{APIFY_HTML_ACTOR_ID}/runs?token={APIFY_API_TOKEN}
                 params: { build: "latest" }
                 Description: Start HTML Scraper actor run
         CATCH:
           2.1.2 Create Variable: mailgun_auth_1
           2.1.3 API Request To Mailgun --> mail1
                 Description: Send alert email if HTML Scraper trigger fails

       2.2 Try / Catch                  Description: Trigger JS Scraper actor
         TRY:
           2.2.1 API Request To Apify   --> js_result
                 POST https://api.apify.com/v2/acts/{APIFY_JS_ACTOR_ID}/runs?token={APIFY_API_TOKEN}
                 params: { build: "latest" }
                 Description: Start JS Scraper actor run
         CATCH:
           2.2.2 Create Variable: mailgun_auth_2
           2.2.3 API Request To Mailgun --> mail2
                 Description: Send alert email if JS Scraper trigger fails
```

### Full XanoScript

```xanoscript
// Triggers Apify HTML and JS scraper actors every 3 hours from 6am to 9pm Pacific
task trigger_apify_scrapers {
  active = true

  stack {
    // Check current hour in Pacific time
    var $current_hour {
      value = now|format_timestamp:"H":"America/Los_Angeles"|to_int
    }

    conditional {
      if ($current_hour >= 6 && $current_hour < 21) {
        // Trigger HTML Scraper actor
        try_catch {
          try {
            api.request {
              url = "https://api.apify.com/v2/acts/" ~ $env.APIFY_HTML_ACTOR_ID ~ "/runs?token=" ~ $env.APIFY_API_TOKEN
              method = "POST"
              headers = []
                |push:"Content-Type: application/json"
              params = {}
                |set:"build":"latest"
            } as $html_result
          }

          catch {
            var $mailgun_auth_1 {
              value = "api:" ~ $env.MAILGUN_API_KEY
            }

            api.request {
              url = "https://api.mailgun.net/v3/mg.fueldocks.app/messages"
              method = "POST"
              params = {}
                |set:"from":"Fuel Docks Alerts <alerts@mg.fueldocks.app>"
                |set:"to":"ken@navigatormktg.com"
                |set:"subject":"Fuel Docks Alert: HTML Scraper trigger failed"
                |set:"text":"The trigger_apify_scrapers task failed to start the HTML Scraper actor."
              headers = []
                |push:("Authorization: Basic %s"
                  |sprintf:($mailgun_auth_1|base64_encode)
                )
            } as $mail1
          }
        }

        // Trigger JS Scraper actor
        try_catch {
          try {
            api.request {
              url = "https://api.apify.com/v2/acts/" ~ $env.APIFY_JS_ACTOR_ID ~ "/runs?token=" ~ $env.APIFY_API_TOKEN
              method = "POST"
              headers = []
                |push:"Content-Type: application/json"
              params = {}
                |set:"build":"latest"
            } as $js_result
          }

          catch {
            var $mailgun_auth_2 {
              value = "api:" ~ $env.MAILGUN_API_KEY
            }

            api.request {
              url = "https://api.mailgun.net/v3/mg.fueldocks.app/messages"
              method = "POST"
              params = {}
                |set:"from":"Fuel Docks Alerts <alerts@mg.fueldocks.app>"
                |set:"to":"ken@navigatormktg.com"
                |set:"subject":"Fuel Docks Alert: JS Scraper trigger failed"
                |set:"text":"The trigger_apify_scrapers task failed to start the JS Scraper actor."
              headers = []
                |push:("Authorization: Basic %s"
                  |sprintf:($mailgun_auth_2|base64_encode)
                )
            } as $mail2
          }
        }
      }
    }
  }

  schedule = [{starts_on: 2026-03-08 13:00:00+0000, freq: 10800}]
}
```

### Important Implementation Notes

- **Apify API authentication:** The Apify API token is passed as a query parameter (`?token=`) in the URL, not as an HTTP header. This is the standard Apify API authentication method.
- **params must be an object, not an empty array:** XanoScript's `params = {}` sends an empty array `[]` to the API, not an empty object `{}`. Apify returns HTTP 400 "The input JSON must be object, got 'array' instead." The fix is adding at least one key-value pair: `params = {} |set:"build":"latest"`. The `build: "latest"` parameter tells Apify to use the latest actor build, which is the default behavior anyway, but it forces Xano to serialize the params as a JSON object.
- **Time window check uses a conditional, not preconditions:** An earlier attempt used `precondition` blocks with `error_type = "skip"`, but "skip" is not a valid error_type value in Xano. The working approach uses a `conditional` block that wraps all logic inside an `if ($current_hour >= 6 && $current_hour < 21)` check. Runs outside this window simply do nothing.
- **XanoScript does not support `||` (logical OR) in conditionals:** The `||` operator causes "Invalid repeating block" syntax errors. Use `&&` (AND) instead, and restructure logic accordingly. For OR conditions, use separate `if`/`elseif` branches.
- **Each actor trigger is independently wrapped in try_catch:** If the HTML Scraper trigger fails, the JS Scraper still runs (and vice versa). Each failure sends its own Mailgun alert email.
- **Old `sync_airtable_marinas` task deleted:** The legacy Background Task (#1) that synced Airtable data was deleted since Airtable has been fully removed from the architecture.

---

## 9.5 daily_closure_recheck Background Task Detail

The `daily_closure_recheck` Background Task runs once daily at midnight Pacific. It handles three automated maintenance operations:

1. **Proactive reopening:** For any marina where `recheck_date` is today or in the past AND `open` is not "Open", immediately sets `open` to "Open". This handles marina website latency: after a holiday closure, the marina may not update its website until later in the day (or even the next day), but the app should not show "Closed for Presidents Day" the morning after the holiday.
2. **Hash clearing for re-evaluation:** For any marina where `recheck_date` is today or in the past, clears `last_content_hash` (forcing a Claude re-parse on the next scrape) and clears `recheck_date` (so the task does not re-trigger on subsequent days). If the marina was proactively reopened in operation 1, the 6am scrape will still re-parse and Claude can override with whatever the website currently says. If the marina's `open` field was already "Open" (meaning a closure is starting today, not ending), the hash clearing forces Claude to re-parse and set the appropriate closure status.
3. **Suspend expiration:** For any marina where `suspend_until` has passed, clears `suspend_until` so the marina re-enters the outbound email and call cadence.

### Why This Task Exists

Hash-based change detection prevents Claude from being called when a page has not changed. This is normally desirable (saves API costs), but creates a problem for date-sensitive closures. A marina website might say "Closed February 16 for Presidents Day" and the page never changes. On Feb 15, Claude correctly marks the marina as "Open" and stores a hash. On Feb 16, the hash still matches (page did not change), so Claude is never called, and the marina stays "Open" even though it should now be "Closed for Presidents Day."

The `recheck_date` field solves this: Claude sets `recheck_date` to the date the status should be re-evaluated. The daily task clears the hash on that date, and the next scraper run forces a fresh Claude parse with the correct date context.

**Why the task also sets `open` proactively:** Clearing the hash alone means the status correction waits until the first scrape at 6am. Worse, if the marina website still shows old closure text the morning after a holiday (common, since marinas update their sites on their own schedule), Claude might re-read the stale closure notice and keep the marina marked closed. Des Moines Marina demonstrated this on Feb 17, 2026: the website still showed the Presidents Day closure notice more than 13 hours after the holiday ended. The proactive reopening solves both problems: the app shows "Open" immediately at midnight, and the 6am scrape provides a safety net where Claude can override if the website says something unexpected.

### Schedule

- **Frequency:** Every 24 hours (freq: 86400 seconds)
- **Start time:** Mar 8, 2026 12:00 AM Pacific (07:00:00 UTC, PDT)
- **Effective run time:** Midnight Pacific daily
- **Status:** Active

### Self-Managing Closure Lifecycle (Example: Des Moines Marina Presidents Day)

1. **Feb 15 scrape:** Claude returns `open: "Open"`, `closure_note: "Closed 02/16/2026 for Presidents Day"`, `recheck_date: "02/16/2026"`
2. **Feb 16 midnight:** `daily_closure_recheck` finds `recheck_date` Feb 16 <= today Feb 16. Marina `open` is currently "Open" (closure is starting today, not ending), so no status change. Clears `last_content_hash` and `recheck_date`.
3. **Feb 16 6:00am:** Scraper runs, null hash forces Claude re-parse, Claude sees today IS Feb 16, returns `open: "Closed for Presidents Day"`, `recheck_date: "02/17/2026"`
4. **Feb 17 midnight:** Task finds `recheck_date` Feb 17 <= today Feb 17. Marina `open` is "Closed for Presidents Day" (not "Open"), so task proactively sets `open: "Open"`. Clears `last_content_hash` and `recheck_date`. App immediately shows marina as open.
5. **Feb 17 6:00am:** Scraper runs, null hash forces Claude re-parse. Even if the website still says "Closed Feb 16 for Presidents Day" (marina has not updated yet), Claude sees today is Feb 17 (after the closure date) and confirms `open: "Open"`, `recheck_date: null`.

No manual intervention required. The cycle is fully self-managing, and the app shows correct status at midnight rather than waiting for the 6am scrape.

### Function Stack

```
1. Create Variable: today                --> today
     Value: now|format_timestamp:"Y-m-d":"America/Los_Angeles"
     Description: Get current date in Pacific time for comparing against recheck_date and suspend_until

2. Query All Records From FuelPrices     --> FuelPrices1
     Return type: list
     Description: Load all marina records to check for due recheck_date or suspend_until values

3. For Each (FuelPrices1, each as $marina)

   3.1 Conditional: recheck_date check
       IF marina.recheck_date != null AND marina.recheck_date <= $today:

         3.1.1 Conditional: proactive reopening check
               IF marina.open != "Open":
                 3.1.1.1 Edit Record In FuelPrices    --> FuelPrices2
                         data: { recheck_date: null, last_content_hash: null, open: "Open" }
                         Description: Closure has passed - proactively reopen marina and clear hash for confirmation scrape
               ELSE:
                 3.1.1.2 Edit Record In FuelPrices    --> FuelPrices2
                         data: { recheck_date: null, last_content_hash: null }
                         Description: Marina already Open (closure may be starting today) - clear hash to force Claude re-parse

   3.2 Conditional: suspend_until check
       IF marina.suspend_until != null AND marina.suspend_until <= $today:
         3.2.1 Edit Record In FuelPrices              --> FuelPrices3
               data: { suspend_until: null }
               Description: Suspension period ended - resume outbound emails and calls for this marina
```

### Full XanoScript

```xanoscript
task daily_closure_recheck {
  stack {
    // Get current date in Pacific time for comparing against recheck_date and suspend_until
    var $today {
      value = now|format_timestamp:"Y-m-d":"America/Los_Angeles"
    }

    // Load all marina records to check for due recheck_date or suspend_until values
    db.query FuelPrices {
      return = {type: "list"}
    } as $FuelPrices1

    foreach ($FuelPrices1) {
      each as $marina {
        // If recheck_date has arrived or passed, handle status and clear hash
        conditional {
          if ($marina.recheck_date != null && $marina.recheck_date <= $today) {
            // Check if marina is currently showing a closure status
            conditional {
              if ($marina.open != "Open") {
                // Closure has passed - proactively reopen marina and clear hash for confirmation scrape
                db.edit FuelPrices {
                  field_name = "id"
                  field_value = $marina.id
                  data = {recheck_date: null, last_content_hash: null, open: "Open"}
                } as $FuelPrices2
              }

              else {
                // Marina already Open (closure may be starting today) - clear hash to force Claude re-parse
                db.edit FuelPrices {
                  field_name = "id"
                  field_value = $marina.id
                  data = {recheck_date: null, last_content_hash: null}
                } as $FuelPrices2
              }
            }
          }
        }

        // If suspend_until has passed, clear it so marina resumes receiving outbound emails and calls
        conditional {
          if ($marina.suspend_until != null && $marina.suspend_until <= $today) {
            db.edit FuelPrices {
              field_name = "id"
              field_value = $marina.id
              data = {suspend_until: null}
            } as $FuelPrices3
          }
        }
      }
    }
  }

  schedule = [{starts_on: 2026-03-08 07:00:00+0000, freq: 86400}]
}
```

### Important Implementation Notes

- **Proactive reopening vs. letting Claude decide:** When `recheck_date` fires and the marina shows a closure status, the task sets `open: "Open"` immediately rather than waiting for the 6am scrape. This addresses marina website latency: marinas often leave closure notices up for hours or days after a holiday. Without proactive reopening, the app would show stale "Closed" status until the marina updated their site AND the scraper ran. The 6am scrape still acts as a safety net, since the hash is also cleared and Claude will re-parse with fresh date context.
- **Two db.edit branches prevent unnecessary writes:** The conditional checks `$marina.open != "Open"` to decide whether to include `open: "Open"` in the data block. This avoids writing to the `open` field when the marina is already "Open" (e.g., a closure is starting today and the hash clearing is needed to let Claude set the closure status). Both branches still clear `recheck_date` and `last_content_hash`.
- **Nested conditionals in XanoScript foreach:** The recheck_date branch contains a nested conditional (`if marina.open != "Open"` inside `if marina.recheck_date <= $today`). XanoScript supports this nesting. If building in the Stack UI, add the outer conditional first, then add the inner conditional inside the IF branch of the outer one.
- **$today must not be wrapped in quotes:** The `var $today` value must be `now|format_timestamp:"Y-m-d":"America/Los_Angeles"` without surrounding single quotes. Wrapping it in quotes (as the initial Stack UI build did) makes it a literal string instead of an evaluated expression, causing the date comparison to never match.
- **Inside foreach, reference $marina not $FuelPrices1:** The initial XanoScript build incorrectly referenced `$FuelPrices1.recheck_date` inside the foreach loop. Inside a foreach block, the current item is `$marina` (the alias set in `each as $marina`). Using the query result variable (`$FuelPrices1`) references the entire list, not the current item.
- **db.edit data block should not include id: null:** An early version set `data = {id: null, recheck_date: null, last_content_hash: null}` which attempted to null the primary key. The `id` field should be omitted from the data block entirely, or excluded from the metadata fields being set.
- **XanoScript task block does not support `active` field:** Including `active = true` or `active = false` in the task block causes a save error. Task activation is managed through the Xano UI (Enable Task / Disable Task button), not in XanoScript.
- **Stack UI conditions may not persist in foreach loops:** When building this task through the Stack UI, the conditional expressions set on the IF blocks did not stick after saving. The conditions showed "Nothing defined" even after being configured. Switching to XanoScript view and editing the script directly resolved the issue. This is consistent with the earlier lesson about Stack UI and XanoScript desync.
- **Date comparison format:** The `$today` variable uses `Y-m-d` format (e.g., `2026-02-16`) which matches how Xano stores date-type fields. The `<=` comparison works correctly for string-based date comparison in this format because the lexicographic order matches chronological order.

---

## 9.6 daily_maintenance Background Task Detail (renamed from daily_csv_backup in v4.32)

The `daily_maintenance` Background Task (#5, renamed from `daily_csv_backup` in v4.32) runs once daily at 11:59 PM Pacific. It performs two jobs: (1) exports the entire FuelPrices table to a dated CSV file in Xano's public file storage, providing a backup layer beyond Xano's built-in 7-day rolling backups, and (2) deletes `mfd_analytics` records older than 90 days to keep the My Fuel Dock analytics table lean. The analytics cleanup was merged into this task (rather than a separate monthly task) to conserve the 10-task Xano plan limit.

### Why This Task Exists

Xano's native backup is a 7-day rolling snapshot of the entire workspace. If a bad data write (from a scraper bug, prompt injection, or manual error) corrupts pricing data and is not caught within 7 days, the corrupted data becomes the only available version. The daily CSV export creates an independent, long-lived archive that can be used to restore individual marina records or the full table regardless of how much time has passed.

At 31 marinas the CSV is approximately 20-30 KB per file. At 3,000 marinas (nationwide scale) each file would be roughly 1.8 MB, producing about 650 MB per year of backups, well within Xano's 100 GB file storage limit on Starter and Essential plans.

### Schedule

- **Frequency:** Every 24 hours (freq: 86400 seconds)
- **Start time:** Mar 8, 2026 11:59 PM Pacific (06:59:00 UTC Mar 9, PDT)
- **Effective run time:** 11:59 PM Pacific daily
- **Status:** Active
- **Task ID:** #5

### Output

Each run produces a file named `fuel_docks_backup_YYYY-MM-DD.csv` (e.g., `fuel_docks_backup_2026-03-01.csv`) using the Pacific timezone date. Files are stored with public access in Xano's file storage and appear in the Files section of the workspace dashboard.

### Function Stack

```
1. Query All Records From FuelPrices     --> all_marinas
     Sort: id ascending
     Return type: list
     Description: Load all marina records for CSV export

2. Create Variable: header_row            --> header_row
     Value (expression): "\"" ~ ($all_marinas.0|keys|join:"\",\"") ~ "\""
     Description: Extract column names from first record, wrap each in double quotes for Excel compatibility

3. Create Variable: csv_lines             --> csv_lines
     Value (expression): []
     Description: Initialize empty array to collect one quoted-and-comma-joined string per marina

4. Create Variable: current_row           --> current_row
     Value: "" (empty string)
     Description: Temp variable for building each row's quoted string before pushing to csv_lines

5. For Each (all_marinas, each as $marina)

   5.1 Update Variable: current_row
       Value (expression): "\"" ~ ($marina|values|join:"\",\"") ~ "\""
       Description: Convert current marina values to double-quoted comma-separated string

   5.2 Update Variable: csv_lines
       Value (expression): $var.csv_lines|push:$var.current_row
       Description: Append the quoted row to the csv_lines array

6. Create Variable: csv_content           --> csv_content
     Value (expression): $var.header_row ~ "\n" ~ ($var.csv_lines|join:"\n")
     Description: Concatenate header row with all data rows separated by newlines

7. Create Variable: filename              --> filename
     Value (expression): "fuel_docks_backup_" ~ (now|format_timestamp:"Y-m-d":"America/Los_Angeles") ~ ".csv"
     Description: Generate dated filename using Pacific timezone

8. Create File Resource                   --> file_resource
     filename: $var.filename
     filedata: $var.csv_content
     Description: Write CSV string to Xano file storage as a file resource

9. Create Attachment From file_resource   --> attachment
     value: $file_resource
     access: public
     Description: Create attachment metadata so file appears in Xano Files section
```

### XanoScript (Production, v3.19)

```xanoscript
task daily_csv_backup {
  description = "Nightly export of FuelPrices table to dated CSV file in Xano file storage. Values are double-quoted for Excel compatibility."
  stack {
    db.query FuelPrices {
      sort = {FuelPrices.id: "asc"}
      return = {type: "list"}
    } as $all_marinas

    var $header_row {
      value = `"\"" ~ ($all_marinas.0|keys|join:"\",\"") ~ "\""`
    }

    var $csv_lines {
      value = `[]`
    }

    var $current_row {
      value = ""
    }

    foreach ($var.all_marinas) {
      each as $marina {
        var.update $current_row {
          value = `"\"" ~ ($marina|values|join:"\",\"") ~ "\""`
        }
        var.update $csv_lines {
          value = `$var.csv_lines|push:$var.current_row`
        }
      }
    }

    var $csv_content {
      value = `$var.header_row ~ "\n" ~ ($var.csv_lines|join:"\n")`
    }

    var $filename {
      value = `"fuel_docks_backup_" ~ (now|format_timestamp:"Y-m-d":"America/Los_Angeles") ~ ".csv"`
    }

    storage.create_file_resource {
      filename = $var.filename
      filedata = $var.csv_content
    } as $file_resource

    storage.create_attachment {
      value = $file_resource
      access = "public"
    } as $attachment
  }

  schedule = [{starts_on: 2026-03-08 06:59:00+0000, freq: 86400}]
}
```

### CSV Format Note

The CSV wraps every value in double quotes (RFC 4180 style), so fields containing commas (such as closure notes, hours, or freeform comments) do not cause column misalignment when opened in Excel or other spreadsheet tools. The quoting is implemented by joining values with `","` (quote-comma-quote) and capping the beginning and end of each row with a quote character. This was upgraded from the original unquoted `values|join` approach in v3.19 after the first nightly backup (March 1, 2026) produced a CSV where fields like Fair Harbor Marina's closure note split across extra columns in Excel.

Note: if a field value itself contains a literal double-quote character, proper RFC 4180 would require escaping it as two double-quotes (`""`). The current implementation does not handle this edge case. For the FuelPrices dataset this is unlikely to occur in practice, but could be addressed if needed by applying a `replace` filter to each value before joining.

### Considered and Rejected: price_history Table

Before choosing the CSV approach, a `price_history` table (with columns for marina_id, gas_price, diesel_price, source, and timestamp) was evaluated for trend analysis and granular rollback. This was rejected for the current 31-marina scale because Xano's 7-day backup, combined with hash-based change detection and Mailgun alerts, already covers most "bad update" scenarios. A price_history table can be revisited when scaling to 3,000+ marinas where trend reporting and per-field rollback become more valuable.

### Implementation Lessons

- **XanoScript `csv_create` filter requires 5 arguments:** The `csv_create` filter expects headers, delimiter, enclosure, and escape character (e.g., `$var.rows|csv_create:$var.headers:",":"\"":"\\"`). Passing only 2 arguments (rows and headers) produces "Too few arguments to function closure, 2 passed and exactly 5 expected." The Xano transformer search panel shows `csv_create` but does not document the required argument count.
- **`csv_create` expects an array of arrays, not an array of objects:** Passing `$all_marinas` (an array of objects) directly to `csv_create` produces malformed output where each entire JSON object becomes a single cell. The filter needs each row to be an array of values in the same order as the headers array.
- **Simple `values|join` approach avoids csv_create complexity:** Building CSV manually with `$marina|values|join:","` for each row, then joining all rows with newlines, is simpler and more predictable than debugging `csv_create`'s underdocumented argument requirements.
- **Unquoted CSV values break Excel when fields contain commas (v3.19 fix):** The original v3.15 implementation used plain `values|join:","` without quoting. Fields containing commas (closure notes, hours, comments) caused column misalignment when opened in Excel. The fix wraps every value in double quotes by joining with `","` (quote-comma-quote) and prepending/appending a quote to each row. A separate `$current_row` temp variable is needed because the quoting expression is too complex to nest inside a `push` argument.
- **XanoScript file storage operations require visual editor:** `storage.create_file_resource` and `storage.create_attachment` work in XanoScript but were initially built through the visual Stack editor because MCP `updateTask` calls timed out. The XanoScript syntax for these operations uses `filename`, `filedata`, `value`, and `access` as field names.
- **Create Variable with `[]` must be an expression, not text:** Setting a Create Variable step's value to `[]` as plain text creates the literal string `"[]"`, not an empty array. The value must be converted to an expression (backtick syntax in XanoScript: `` value = `[]` ``) for subsequent `push` operations to work.
- **Foreach loop variable reference:** When a foreach loop uses `each as $marina`, the current item is referenced as `$marina` directly in expressions, not as `$item.marina`. Using `$item.marina` produces empty values because `$item` does not contain a `marina` property.

---

## 9.7 daily_call_report Background Task Detail

The `daily_call_report` Background Task (#6) runs once daily at 2:00 AM Pacific. It sends Ken an overnight email listing all Method=Call marinas currently due for a call, ready to review before opening FD Dialer.

### Why This Exists

The FD Dialer app now supports app icon badge counts via Expo Push Notifications (v4.6). The `push_badge_update` background task sends silent badge updates every 15 minutes. This daily email remains as a complementary overnight summary so Ken can see the pending call count before opening the app each morning.

### Filter Logic

Applies the identical six filters used by the `call_queue` endpoint to ensure the email list matches exactly what FD Dialer shows:

0. **DNC (Do Not Call):** Skip if `legal == "DNC"` (absolute exclusion, added v4.25)
0b. **Closed today:** Skip if `hours_json` indicates the marina is closed on the current day of the week in the current season (added v4.25)
1. **Snooze:** Skip if `call_snooze_until` is in the future
2. **Recheck date:** Skip if `recheck_date` is after today (Pacific)
3. **Suspend until:** Skip if `suspend_until` is after today (Pacific)
4. **Cadence:** Skip if elapsed time since `last_call_connection` < cadence threshold (default 7 days). Only gates on successful connections, not snooze actions. Timestamps are in milliseconds so cadence = days * 86400000.

**Important:** Cannot use a `WHERE` clause in `db.query` inside a Background Task (XanoScript parser limitation). Instead, queries all FuelPrices records and filters `Method == "Call"` inside the foreach loop.

### Schedule

- **Frequency:** Daily (freq: 86400 seconds)
- **starts_on:** 2026-03-08 09:00:00 UTC = 2:00 AM PDT
- **DST:** No adjustment needed. 09:00 UTC is pegged to PDT. Will shift to 1:00 AM PST when clocks fall back in November -- adjust at that time if desired.

### Email Format

- **From:** `alerts@mg.fueldocks.app`
- **To:** `ken@navigatormktg.com`
- **Subject:** `Fuel Docks - # calls to make today` (# is the count of due marinas)
- **Body (when marinas due):** Numbered list of marina name, city, and last updated date in last-updated-ascending order, followed by "Open FD Dialer to start calling."
- **Body (zero due):** `No marinas are due for calls today.`
- Always sends regardless of count. No weekend skip.

### XanoScript

The XanoScript below reflects the current published version (v4.25), which includes DNC exclusion (Filter 0), closed-today check (Filter 0b), and Filters 1-4. See the [Xano MCP `getTask` for task #6] for the live version.

### Implementation Notes

1. **Subject format:** `"Fuel Docks - " ~ $counter ~ " calls to make today"` produces "Fuel Docks - 7 calls to make today" or "Fuel Docks - 0 calls to make today".
2. **Zero-due sends intentionally:** Receiving a "0 calls" email each day confirms the task ran successfully. Absence of the email signals a task failure.
3. **No weekend skip:** Unlike `send_outbound_emails`, this task runs 7 days a week. Call-method marinas accumulate through the weekend and the Monday morning email reflects the full queue.
4. **Filter parity with call_queue (v4.25):** Full parity achieved. Both `call_queue` and `daily_call_report` now apply the same six filters: DNC (Filter 0), closed today (Filter 0b), snooze (Filter 1), recheck_date (Filter 2), suspend_until (Filter 3), and cadence (Filter 4). The v4.19 parity gap (DNC missing from daily email) has been resolved.
5. **db.query workaround:** Background Task XanoScript parse error with `search` blocks requires querying all records and filtering `Method != "Call"` via `continue` inside foreach. Safe at current record count (~47 marinas).
6. **DST:** Task schedule is `starts_on: 2026-03-08 09:00:00+0000` = 2:00 AM PDT. No adjustment needed for spring DST. Will shift to 1:00 AM PST when clocks fall back in November -- adjust at that time if desired.
7. **Mailgun auth pattern:** Uses `MAILGUN_API_KEY` (mg.fueldocks.app domain key), same as all other alert emails. Auth header built via `"api:" ~ $env.MAILGUN_API_KEY` then base64-encoded.

## 9.8 register_push_token Endpoint Detail (v4.6)

The `register_push_token` endpoint (#51, POST) registers an Expo push token for badge update notifications. Lives in the "Fuel Docks API" group.

### Authentication

Same pattern as `call_queue`, `submit_call`, `snooze_call`: validates `$input.api_token` against `$env.FD_API_TOKEN` or `$env.DIALER_API_TOKEN` via precondition.

### Inputs

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `api_token` | text | Yes | API authentication token |
| `expo_push_token` | text (trimmed) | Yes | Expo push token from the device (e.g., `ExponentPushToken[...]`) |

### Function Stack

1. **Precondition:** Validate `api_token` against env vars
2. **Query** `dialer_push_tokens` where `expo_push_token` matches input
3. **Conditional:** If count == 0, insert new record; otherwise skip (token already registered)

### register_push_token XanoScript

```xanoscript
// Register an Expo push token for badge update notifications
query register_push_token verb=POST {
  api_group = "Fuel Docks API"

  input {
    // API authentication token
    text api_token

    // Expo push token from the device
    text expo_push_token filters=trim
  }

  stack {
    precondition ($input.api_token == $env.FD_API_TOKEN || $input.api_token == $env.DIALER_API_TOKEN) {
      error_type = "accessdenied"
      error = "Unauthorized"
    }

    // Check if this token already exists
    db.query dialer_push_tokens {
      where = $db.dialer_push_tokens.expo_push_token == $input.expo_push_token
      return = {type: "list"}
    } as $existing

    conditional {
      if (($existing|count) == 0) {
        // Insert new push token
        db.add dialer_push_tokens {
          data = {expo_push_token: $input.expo_push_token}
        } as $new_token
      }
    }
  }

  response = {success: true}
  history = false
}
```

### Implementation Notes

1. **Upsert pattern:** Uses query + conditional insert instead of relying on the unique index constraint. This avoids a database error when the same device re-registers the same token (e.g., after app update or reinstall).
2. **No request history:** `history = false` because token registration happens on every app launch and would create excessive log entries with no diagnostic value.
3. **No user association:** The `dialer_push_tokens` table stores tokens without linking them to user accounts. The call queue is shared across all dialer users, so every registered device receives the same badge count.
4. **Client-side caching:** The FD Dialer app caches the registered token in AsyncStorage (`expo_push_token` key) and only calls this endpoint when the token changes or is new, minimizing unnecessary API calls.

---

## 9.9 push_badge_update Background Task Detail (v4.6)

The `push_badge_update` Background Task (#7) runs every 15 minutes. It queries the call queue count and sends a silent Expo push notification to all registered devices, updating the app icon badge to show the number of pending calls.

### Why This Exists

The FD Dialer app's badge count previously only updated when the app was opened (via `Notifications.setBadgeCountAsync()` inside `useFocusEffect` → `fetchQueue()`). This meant Ken couldn't see pending calls at a glance without opening the app. Silent push notifications update the badge in the background via APNs.

### Schedule

- **Frequency:** Every 15 minutes (freq: 900 seconds)
- **starts_on:** 2026-03-11 16:00:00 UTC = 9:00 AM PDT
- **DST:** Fixed UTC schedule. Badge updates are useful around the clock so no hour-of-day filtering is applied.

### Function Stack

1. **Query all push tokens** from `dialer_push_tokens`
2. **Early exit** if no tokens registered
3. **Call `call_queue` endpoint** via internal HTTP GET to get due marina count (reuses the existing endpoint's filtering logic rather than duplicating it)
4. **Extract count** from `$queue_response.response.result.due_marinas|count`
5. **Extract token strings** from query results via `$tokens[$$].expo_push_token`
6. **Send silent push** to Expo Push API (`https://exp.host/--/api/v2/push/send`) with `badge` set to due count, `sound: null`, and `_contentAvailable: true`
7. **Clean up invalid tokens:** Iterate over Expo's response tickets; for any `DeviceNotRegistered` error, delete the corresponding token from `dialer_push_tokens`

### push_badge_update XanoScript

```xanoscript
// Every 15 minutes, fetch the call queue count and send a silent push notification to all registered devices to update the app badge.
task push_badge_update {
  stack {
    // Step 1: Get all registered push tokens
    db.query dialer_push_tokens {
      return = {type: "list"}
    } as $tokens

    // If no tokens registered, exit early
    conditional {
      if (($tokens|count) == 0) {
        debug.log {
          value = "No push tokens registered, skipping"
        }

        return {
          value = "No tokens"
        }
      }
    }

    // Step 2: Call the call_queue endpoint to get the due marina count
    api.request {
      url = "https://xlba-eg1u-i4nx.n7e.xano.io/api:-GTDJqKH/call_queue"
      method = "GET"
      params = {api_token: $env.DIALER_API_TOKEN}
      headers = []
        |push:"Content-Type: application/json"
      timeout = 30
      verify_host = false
      verify_peer = false
    } as $queue_response

    // Number of marinas currently due for a call
    var $due_count {
      value = $queue_response.response.result.due_marinas|count
    }

    debug.log {
      value = "Due marinas: " ~ $due_count ~ ", Tokens: " ~ ($tokens|count)
    }

    // Step 3: Build array of push token strings
    var $token_strings {
      value = $tokens[$$].expo_push_token
    }

    // Step 4: Send silent push notification to Expo Push API
    api.request {
      url = "https://exp.host/--/api/v2/push/send"
      method = "POST"
      params = {
        to               : $token_strings
        badge            : $due_count
        sound            : null
        _contentAvailable: true
      }

      headers = []
        |push:"Content-Type: application/json"
      timeout = 30
      verify_host = false
      verify_peer = false
    } as $push_response

    // Expo push response
    debug.log {
      value = $push_response.response.result
    }

    // Step 5: Clean up invalid tokens from the response
    var $push_data {
      value = $push_response.response.result.data
    }

    conditional {
      if ($push_data != null) {
        var $i {
          value = 0
        }

        foreach ($push_data) {
          each as $ticket {
            conditional {
              if ($ticket.status == "error") {
                conditional {
                  if ($ticket.details != null) {
                    conditional {
                      if ($ticket.details.error == "DeviceNotRegistered") {
                        // Remove invalid token from database
                        var $bad_token {
                          value = $token_strings[$i]
                        }

                        db.query dialer_push_tokens {
                          where = $db.dialer_push_tokens.expo_push_token == $bad_token
                          return = {type: "list"}
                        } as $to_delete

                        conditional {
                          if (($to_delete|count) > 0) {
                            db.del dialer_push_tokens {
                              field_name = "id"
                              field_value = ($to_delete|first).id
                            }

                            debug.log {
                              value = "Removed invalid token: " ~ $bad_token
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }

            var.update $i {
              value = $i + 1
            }
          }
        }
      }
    }
  }

  schedule = [{starts_on: 2026-03-11 16:00:00+0000, freq: 900}]
  history = 100
}
```

### Implementation Notes

1. **Internal API call instead of duplicated logic:** The task calls the existing `call_queue` endpoint via HTTP GET rather than duplicating the five-condition filtering logic. This ensures badge count always matches what the app shows when opened. Trade-off: adds ~100ms of network latency per run, but avoids divergent filter logic bugs.
2. **Silent push:** The combination of `sound: null` and `_contentAvailable: true` creates a "content-available" push that updates the badge without showing a notification banner or playing a sound. This maps to APNs `content-available: 1` on iOS.
3. **Token cleanup:** The Expo Push API returns one ticket per token in the `data` array. When a ticket has `status: "error"` and `details.error: "DeviceNotRegistered"`, the token is stale (app was uninstalled or token was rotated). The task correlates tickets to tokens by array index ($i) and deletes the stale record from `dialer_push_tokens`.
4. **Expo Push API batch format:** When `to` is an array, the Expo API treats it as a batch send of the same message to multiple devices. This is more efficient than individual sends and counts as a single API call.
5. **Request history:** `history = 100` retains the last 100 runs for debugging. At 96 runs/day (every 15 min), this covers roughly one day of history.
6. **No Try/Catch:** The task does not wrap the Expo Push API call in Try/Catch because a failed badge update is non-critical and will self-correct on the next 15-minute run. If the `call_queue` internal API call fails, the task will error and appear in Xano's task error logs.
7. **DST:** No DST adjustment needed. Badge updates run around the clock with no hour-of-day filtering.

## 9.10 parse_hours_json Background Task Detail (v4.25)

The `parse_hours_json` Background Task (#8) runs nightly at 1:00 AM Pacific. It backfills the `hours_json` field for marinas that have free-text `hours` but no structured `hours_json`, using Claude Haiku to parse the hours text.

### Why This Exists

The `call_queue` and `daily_call_report` filters use `hours_json` to skip marinas that are closed on the current day of the week. The `hours` field is a free-text string (e.g., "May-Sep: Daily 8:00am-6:00pm; Oct-Apr: Mon, Wed, Fri, Sat-Sun 9:00am-3:00pm, Tue and Thu Closed") that cannot be reliably parsed with simple string matching in XanoScript. Claude Haiku parses the text into a structured array that the filters can evaluate programmatically.

### hours_json Format

```json
[
  {"start_month": 5, "end_month": 9, "closed_days": []},
  {"start_month": 10, "end_month": 4, "closed_days": ["tue", "thu"]}
]
```

Each schedule object covers a date range (`start_month` to `end_month`, integers 1-12, supports year-wrapping like Oct-Apr). `closed_days` is an array of lowercase 3-letter day abbreviations for days the marina is closed. Empty array means open every day in that season.

### Trigger Conditions

A marina is processed when ALL of the following are true:
- `hours_json` is null
- `hours` is not null
- `hours` has length > 0

Marinas already having `hours_json` are skipped. This means the task is effectively a no-op once all marinas are backfilled, unless `hours_json` is nulled out (e.g., by `submit_call` when Claude parses new hours from call notes).

### Re-parse Flow

When `submit_call` receives call notes containing hours information, Claude parses the notes and writes the new `hours` text to the database. If Claude returns a non-null `hours` value, `submit_call` also sets `hours_json = null`. The next night, `parse_hours_json` detects the null `hours_json` and re-parses the updated `hours` text.

### Schedule

- **Frequency:** Daily (freq: 86400 seconds)
- **starts_on:** 2026-03-18 08:00:00 UTC = 1:00 AM PDT
- **Runs before daily_call_report** (1 AM vs 2 AM) so newly parsed schedules are available for the morning email and call queue.

### Error Handling

Each marina's Claude call is wrapped in try/catch. If parsing fails for one marina, the error is sent via Mailgun alert email (`alerts@mg.fueldocks.app` to `ken@navigatormktg.com`) and processing continues with the next marina. Failed marinas remain with null `hours_json` and are retried the next night.

### XanoScript

See the [Xano MCP `getTask` for task #8] for the live version.

---

## 9.11 daily_tos_check Background Task Detail (v4.28)

The `daily_tos_check` Background Task (#9) runs nightly at 1:00 AM Pacific. It checks scraped marinas that have a blank `legal` field for Terms of Service or robots.txt restrictions that prohibit automated price scraping.

### Why This Exists

The `legal` field was introduced in v4.18 with a manual TOS review of all 17 scraped marina websites. Three were flagged with "TOS no scrape" and the rest were cleared. This task automates ongoing monitoring so new scraped marinas (or marinas whose `legal` field is blank) are automatically checked against their website's TOS and robots.txt.

### Trigger Conditions

A marina is processed when ALL of the following are true:
- `Method` = "HTML" or "Javascript" (scraped marinas only)
- `legal` is null or empty string

Most nights, no marinas match these conditions (all existing scraped marinas already have `legal` set from the v4.18 review), so the task exits immediately after the query.

### Processing Flow

For each qualifying marina:

1. **Fetch robots.txt** — `api.request GET {website}/robots.txt` with try/catch (404s are expected and handled)
2. **Fetch website HTML** — `api.request GET {website}` with try/catch, truncated to 4,000 characters
3. **Claude Haiku analysis** — Sends both fetched contents to `Create chat completion - Claude` (function #34) with a system prompt asking for a YES/NO determination on whether the site prohibits scraping, crawling, spiders, or data mining. Response format: `YES: <reason>` or `NO: <reason>`.
4. **Email results** — Both outcomes send a prescriptive email to ken@navigatormktg.com:
   - **Restrictions found (YES):** Subject "Fuel Docks Alert: TOS Review Needed — {marina}". Body includes Claude's finding and prescriptive instruction: "Set the `legal` field to `TOS no scrape` for this marina in the FuelPrices table."
   - **No restrictions (NO):** Subject "Fuel Docks: TOS Cleared — {marina}". Body includes Claude's finding and suggested action: "Set the `legal` field to `OK` for this marina in the FuelPrices table to stop nightly rechecks."

### Key Design Decisions

- **Email-only, no database writes.** The task never modifies the `legal` field. Ken reviews each finding and manually sets the value. This keeps a human in the loop for legal compliance decisions.
- **Nightly rechecks until resolved.** Marinas with blank `legal` fields are rechecked every night until Ken sets the field. At current marina count this is inexpensive (one Claude Haiku call + two HTTP fetches per marina).
- **Try/catch per marina.** One failure does not stop the run. Errors are logged and the task continues to the next marina.
- **HTML truncation.** Website content is truncated to 4,000 characters and robots.txt to 2,000 characters to keep Haiku token costs low.

### Schedule

- **Frequency:** Daily (freq: 86400 seconds)
- **starts_on:** 2026-03-19 08:00:00 UTC = 1:00 AM PDT
- **Runs at same time as `parse_hours_json`** (#8). Both are lightweight tasks that typically exit after the initial query.

### Error Handling

Each marina's fetch and Claude call is wrapped in try/catch. If processing fails for one marina, the error is logged and processing continues with the next marina. Failed marinas remain with blank `legal` and are retried the next night.

### XanoScript

See the [Xano MCP `getTask` for task #9] for the live version.

---

## 10. Apify Configuration

### Actor Types

Two custom Apify actors handle web scraping, selected per-marina based on the Method field:

**Fuel Docks HTML Scraper (Cheerio, for Method = "HTML"):**
- Actor ID: `h27M51Qk8s4lveFFA`
- Actor name in Apify: `navigatorpmw/fuel-docks-html-scraper`
- Built from "Crawlee + Cheerio (JavaScript)" template
- Fetches raw HTML via HTTP request (no browser launched)
- Extracts the fuel section using the CSS selector, or full body text with scripts/nav/footers removed if no selector defined
- Fast and lightweight, roughly 10x cheaper in compute than Playwright
- Handles 12 marinas
- Performance: ~17 seconds, ~$0.001 per run

**Fuel Docks JS Scraper (Playwright, for Method = "Javascript"):**
- Actor ID: `9bd2ESbz4PrSOcqV0`
- Actor name in Apify: `navigatorpmw/fuel-docks-js-scraper`
- Built from "Crawlee + Playwright + Chrome" template
- Launches a headless browser with stealth features (see below) that renders JavaScript
- Waits for dynamic content to load, then extracts the fuel section using the CSS selector
- Required for sites where prices are loaded by JavaScript after the initial page load, or sites that block Cheerio with HTTP 403
- Handles 6 marinas
- Performance: ~59 seconds, ~$0.021 per run

### Stealth Features (Playwright Actor)

The Playwright actor includes several anti-detection features that were added after two Seattle Boat Company sites (IDs 21 and 22) blocked standard headless browser requests:

- **Browser fingerprinting**: Uses Crawlee's `useFingerprints: true` with Chrome on Windows profiles
- **Automation flag override**: Removes the `navigator.webdriver` property via `addInitScript`
- **Resource blocking**: Blocks images, fonts, and icons to reduce bandwidth and speed up loading
- **Chrome launch args**: Uses `--disable-blink-features=AutomationControlled` to avoid Chromium automation detection
- **Network idle timeout**: Waits up to 15 seconds for network idle, then proceeds anyway (some sites have background scripts that never fully stop)

These stealth features resolved all 403 errors without needing residential proxies ($0 additional cost).

### Webhook Authentication

Both actors send a `webhook_token` field in the POST body when calling the Xano `apify_webhook` endpoint. The token value is read from an Apify environment variable named `APIFY_WEBHOOK_TOKEN` (configured per-actor on the **Source** tab under **Environment variables**, with the **Secret** checkbox enabled).

Both actors also pass the same token as a `token` query parameter when calling the Xano `apify_marina_list` endpoint (e.g., `?token=${WEBHOOK_TOKEN}&method=HTML`). The endpoint validates the token against `$env.APIFY_WEBHOOK_TOKEN` via a precondition and returns HTTP 403 "Unauthorized" if missing or incorrect. This was added in H2 remediation (February 2026) because the endpoint previously exposed marina IDs, names, website URLs, and CSS selectors without any authentication, revealing the full list of monitored sites and how each one is scraped.

### How Both Actors Work

1. Actor reads optional `marina_id` from run input (`await Actor.getInput()`). When provided, the actor operates in single-marina mode (triggered by `report_price` endpoint). When absent, the actor operates in batch mode (triggered by scheduled task).
2. Actor calls Xano's `apify_marina_list` endpoint with `?token=${WEBHOOK_TOKEN}&method=HTML` (or `Javascript`). In single-marina mode, appends `&id=${marinaId}` so the endpoint returns a single-item array.
3. Receives a list of marina objects: `{ id, fuel_dock, website, css_selector }`
4. For each marina, the actor fetches/renders the page and extracts text content from the element matching css_selector (or full body text with scripts/nav/footers removed if no selector defined)
5. Content is truncated to 10,000 characters to keep Claude API costs down
6. Actor POSTs `{ marina_id, scraped_content, scrape_url, webhook_token, http_status }` to Xano's `apify_webhook` endpoint
7. Actor also pushes a record to the Apify dataset for each marina (`Actor.pushData`) to enable the "results count" monitoring alert
8. No URLs, selectors, or marina data are stored in Apify. Xano is the single source of truth.

**Duplicate URL handling (Playwright actor, v3.23):** When multiple marinas share the same website URL (e.g., Seattle Boat Company operates two fuel docks from one pricing page), Crawlee's `PlaywrightCrawler` would normally deduplicate them by URL and only scrape once. The Playwright actor handles this by setting `uniqueKey: marina-${marina.id}` on each request and looking up marina records by ID (via `request.userData.marinaId`) rather than by URL. This ensures each marina gets its own scrape and its own webhook callback with the correct `marina_id`, even when multiple marinas point to the same page. The internal `marinaMap` is keyed by marina ID, not URL, so duplicate URLs do not overwrite each other. The Cheerio actor is not affected by this issue because it processes marinas sequentially in a simple `for` loop with individual `fetch()` calls (no request queue deduplication).

### Scheduling

Scheduling is controlled by Xano, not Apify. The `trigger_apify_scrapers` Background Task (#2) runs every 3 hours and triggers each actor via the Apify API. The task includes a Pacific time check so actors are only triggered when the hour is >= 6 and < 21 (5 effective runs per day: 6am, 9am, 12pm, 3pm, 6pm). See Section 9 for full task detail and the known off-by-one note about the 9pm run.

**Why Xano controls the schedule:** Xano already controls what gets scraped (the marina list, URLs, and selectors). Having Xano also control when scraping happens keeps all orchestration logic in one place. If Ken wants to change the cadence, skip a marina, or move a marina from HTML to Javascript, he only touches Xano. Apify just does what it's told.

### Monitoring Alerts

Each actor has 3 monitoring alerts configured in Apify (6 total), all sending email notifications to ken@navigatormktg.com:

| Alert | HTML Scraper | JS Scraper |
|-------|-------------|------------|
| Run status (failed/timed out/aborted) | Yes | Yes |
| Duration exceeds threshold | > 120 seconds | > 180 seconds |
| Results count less than 1 | Yes | Yes |

The "results count" alert requires `Actor.pushData()` in the actor code. Both actors push a record for each successfully scraped marina, so a run that completes but produces zero results triggers the alert.

### Apify Environment Variables

Environment variables in Apify are configured per-actor on the **Source** tab (not the Settings tab), under the **Environment variables** section below the code editor.

| Variable | Value | Secret | Both Actors |
|----------|-------|--------|-------------|
| `APIFY_WEBHOOK_TOKEN` | Shared secret matching Xano's `$env.APIFY_WEBHOOK_TOKEN` | Yes | Yes |

### Batching

All marinas of each type are processed in a single actor run per type. This is more efficient than individual runs because it avoids repeated actor startup overhead and consumes fewer compute units.

### Cost Estimate

- Cheerio runs are very lightweight (HTTP fetch only, no browser): ~$0.001 per run
- Playwright runs require headless browser with stealth features: ~$0.021 per run
- Combined cost per scrape cycle: ~$0.022
- At 5 runs/day: ~$0.11/day, ~$3.30/month
- Fits well within Apify free tier ($5/month in compute)
- If usage exceeds free tier as marina count scales nationwide, upgrade to Apify Starter plan (~$49/month)

### Cleanup History

Old Apify assets deleted during Step 3:
- Old "Cheerio Scraper" (apify/cheerio-scraper) store actor and its saved task
- Old "Playwright Scraper" (apify/playwright-scraper) store actor and its saved task
- Old schedules tied to the above tasks

---

## 11. Mailgun Configuration

### Domains

Two Mailgun domains are configured:

**mg.fueldocks.app** (alerts and system emails):
- Subdomain of fueldocks.app (Ken owns this domain via GoDaddy)
- Used for error alert emails from `alerts@mg.fueldocks.app`
- All 5 DNS records verified in Mailgun dashboard

**navigatorpnw.com** (marina correspondence):
- Used for outbound price check emails to marinas and receiving their replies
- MX records point to Mailgun for inbound email receiving
- All DNS records verified in Mailgun dashboard

### DNS Records for mg.fueldocks.app (Verified)

All 5 DNS records were added via GoDaddy and verified in the Mailgun dashboard:

| Type | Host | Value | Purpose |
|------|------|-------|---------|
| TXT | mg | `v=spf1 include:mailgun.org ~all` | SPF (sender authorization) |
| TXT | krs._domainkey.mg | `k=rsa; p=MIGf...` (DKIM public key) | DKIM (email signing) |
| MX | mg | `mxa.mailgun.org` (priority 10) | Inbound mail routing |
| MX | mg | `mxb.mailgun.org` (priority 10) | Inbound mail routing (backup) |
| CNAME | email.mg | `mailgun.org` | Email tracking |

### DNS Records for navigatorpnw.com

MX records must point to Mailgun for inbound email receiving:
- MX priority 10: `mxa.mailgun.org`
- MX priority 10: `mxb.mailgun.org`

**Status:** MX records confirmed pointing to Mailgun. Inbound emails to @navigatorpnw.com are successfully received and routed to the Xano `mailgun_inbound` endpoint. Verified with end-to-end test: email from Outlook to ken@navigatorpnw.com was received, parsed by Claude, and written to the database.

**DMARC (Added February 14, 2026):** TXT record on `_dmarc` hostname in Hover with value `v=DMARC1; p=none; rua=mailto:ken@navigatorpnw.com`. Currently in monitor mode (p=none). Aggregate reports will be emailed to ken@navigatorpnw.com from providers like Gmail and Microsoft, showing which IPs sent email as navigatorpnw.com and whether SPF/DKIM passed. Plan to review reports and tighten to p=quarantine or p=reject after Step 6 outbound emails have been live for 3-4 weeks.

### DNS Records for navigatorpnw.com (All Verified)

| Type | Host | Value | Purpose |
|------|------|-------|---------|
| TXT | @ | `v=spf1 include:mailgun.org ~all` | SPF (sender authorization) |
| TXT | mailo._domainkey | `k=rsa; p=MIGfMA0G...` (DKIM public key) | DKIM (email signing) |
| MX | @ | `mxa.mailgun.org` (priority 10) | Inbound mail routing |
| MX | @ | `mxb.mailgun.org` (priority 10) | Inbound mail routing (backup) |
| CNAME | email | `mailgun.org` | Email tracking |
| TXT | _dmarc | `v=DMARC1; p=none; rua=mailto:ken@navigatorpnw.com` | DMARC (monitor mode) |

**Note:** The A record (216.40.34.41) and Adalo CNAME records (fueldock, fueldocks) also exist on this domain for the web app. These do not conflict with email DNS records.

### API Keys (Domain Sending Keys)

Mailgun authentication uses two domain-scoped Domain Sending Keys, which replaced a single Admin-role Account API key in M2 remediation (February 2026). Domain Sending Keys follow the principle of least privilege: each key can only call POST /messages and /events for its specific domain. They cannot modify account settings, delete logs, create routes, or send from other domains.

| Xano Env Variable | Mailgun Domain | Scope | Used By |
|-------------------|---------------|-------|---------|
| `MAILGUN_API_KEY` | mg.fueldocks.app | Alert and error emails | `apify_webhook` catch, `trigger_apify_scrapers` catches, `mailgun_inbound` catch, `send_outbound_emails` error and unanswered alerts, H4 flag alerts |
| `MAILGUN_KEY_NAVIGATOR` | navigatorpnw.com | Marina outbound emails | `send_price_check_email` Custom Function |

**Orphaned Admin key:** The original Admin-role Account API key ("Fuel Docks Xano", created 02/11/26) still appears on the Mailgun API Keys page because Mailgun does not allow deleting the last remaining Account API key. Its secret value is no longer stored in any Xano environment variable, so it is effectively orphaned and unusable by the system.

### Webhook Signing Key

Mailgun's HTTP Webhook Signing Key is stored as Xano environment variable `MAILGUN_SIGNING_KEY`. This key is used exclusively for HMAC-SHA256 signature verification on inbound webhook requests (see Section 8.5). It is a separate key from the Mailgun API key.

**Where to find it in Mailgun:** Settings (gear icon in sidebar) > Security & Users > HTTP Webhook Signing Key (under the Account Settings heading).

**How it works:** Mailgun includes three fields in every forwarded inbound message: `timestamp`, `token`, and `signature`. The `signature` is an HMAC-SHA256 hash of the concatenation of `timestamp` + `token`, computed using this signing key. The `mailgun_inbound` endpoint recomputes the hash and compares it against the provided signature to verify the request is genuinely from Mailgun.

### Inbound Route (Configured)

A Mailgun inbound route has been created to forward marina email replies to Xano:

| Setting | Value |
|---------|-------|
| Expression type | Match Recipient |
| Recipient pattern | `.*@navigatorpnw.com` |
| Action: Forward | `https://xlba-eg1u-i4nx.n7e.xano.io/api:-GTDJqKH/mailgun_inbound` |
| Action: Stop | Enabled (prevents subsequent route evaluation) |
| Priority | 0 |
| Description | Forward inbound marina email replies to Xano for fuel price parsing |

**How it works:** When an email arrives at any address @navigatorpnw.com, Mailgun parses the email and POSTs the parsed fields (sender, subject, stripped-text, body-plain, etc.) to the Xano `mailgun_inbound` endpoint. Xano then looks up the marina by the sender's email, calls Claude to extract prices, and updates the database.

**Route location in Mailgun UI:** Send (left sidebar) > RECEIVING section > Routes.

### Alert Emails (Implemented)

Error alerts are sent from `alerts@mg.fueldocks.app` to `ken@navigatormktg.com`. Currently implemented in:
- The `apify_webhook` endpoint's Catch block (Claude parsing errors)
- The `trigger_apify_scrapers` task's Catch blocks (actor trigger failures)
- The `mailgun_inbound` endpoint's Catch block (email parsing errors)

**Alert email format (apify_webhook):**
- **Subject:** `Fuel Docks Alert: [marina name] (ID [marina_id])`
- **Body:**
  ```
  Xano Endpoint: apify_webhook
  Marina: [marina name]
  Marina ID: [id]
  Scrape URL: [url]

  Error Type: [error type from Claude API]
  Error Message: [error message]
  HTTP Status: [status code]
  ```

**Alert email format (trigger_apify_scrapers):**
- **Subject:** `Fuel Docks Alert: HTML Scraper trigger failed` or `Fuel Docks Alert: JS Scraper trigger failed`
- **Body:** `The trigger_apify_scrapers task failed to start the [HTML/JS] Scraper actor.`

**Alert email format (mailgun_inbound):**
- **Subject:** `Fuel Docks Alert: Email Parse Error - [marina name]`
- **Body:**
  ```
  Marina: [marina name]
  Marina ID: [id]
  Sender: [sender email from $sender_email variable]
  Subject: [email subject from $var.mailgun_raw|get:"subject"]

  Xano Endpoint: mailgun_inbound
  Error: [error message]
  Error Code: [error code]
  ```

**Alert email format (send_outbound_emails -- unanswered):**
- **Subject:** `Fuel Docks Alert: [count] unanswered emails - [marina name]`
- **Body:**
  ```
  Marina: [marina name]
  Marina ID: [id]
  Contact: [contact_email]
  Consecutive unanswered emails: [count]
  Cadence: every [cadence] days

  This marina was just sent email #[count] since their last reply.
  Consider calling or adjusting the contact method.
  ```

**Alert email format (send_outbound_emails -- failure):**
- **Subject:** `Fuel Docks Alert: Outbound Email Failed - [marina name]`
- **Body:**
  ```
  Marina: [marina name]
  Marina ID: [id]
  Contact: [contact_email]

  Xano Task: send_outbound_emails
  Error: [error message]
  Error Code: [error code]
  ```

**Authentication approach:** Mailgun uses HTTP Basic Auth with username "api" and the API key as password. In Xano, this is built by creating a variable `mailgun_auth` with an expression that concatenates "api:" with the appropriate Domain Sending Key, then base64-encoding it and inserting it into an `Authorization: Basic %s` header via sprintf. Alert sends (from mg.fueldocks.app) use `"api:" ~ $env.MAILGUN_API_KEY`, while marina outbound sends (from navigatorpnw.com) use `"api:" ~ $env.MAILGUN_KEY_NAVIGATOR`. The auth pattern itself is identical; only the environment variable differs based on the sending domain. This workaround is necessary because Xano's External API Request cannot directly concatenate environment variables in the sprintf filter's Additional Arguments field.

### Outbound (Sending Price Requests) -- IMPLEMENTED

Outbound price check emails are sent from `ken@navigatorpnw.com` to marina contact emails.

**Architecture:**
- `send_price_check_email` Custom Function (Library > Functions > Fuel Docks) contains all send logic
- `send_outbound_email` endpoint is a thin wrapper for manual single-marina sends
- `send_outbound_emails` Background Task automates sends based on cadence

**Template system:**
- Each marina can have a custom `email_subject` and `email_body` in the database
- If empty, defaults are used: subject "Current fuel prices?" and a generic template
- Body supports placeholders: `{{fuel_dock}}`, `{{gas_price}}`, `{{diesel_price}}`
- Literal `\n` in custom templates is converted to real newlines at send time
- Example custom template: John Wayne Marina (ID 46) has custom subject and body for harbormaster Ron
- Example placeholder template: Hood Canal Marina (ID 47) uses `{{fuel_dock}}`, `{{gas_price}}`, `{{diesel_price}}` in the body

**Cadence logic (in send_outbound_emails task):**
- `email_cadence` field (integer, days) controls how often each marina is emailed
- Reference timestamp (v3.18): uses whichever is more recent between `last_email_sent` and `last_email_response`. If both are null, due immediately (never emailed). Previously `last_email_response` took unconditional priority over `last_email_sent`, which caused stale/seed response dates to override recent sends — e.g., a marina with a 2025 seed `last_email_response` would be emailed daily even if `last_email_sent` was yesterday.
- Default cadence: 7 days if `email_cadence` is null or 0
- Date-based comparison (v3.18): the task adds cadence days (as milliseconds) to the reference timestamp, formats the result as a `Y-m-d` date string in Pacific time, and compares against today's `Y-m-d` string. If `due_date <= $today`, the marina is due. This means "7 days after Feb 23 at 3:37 PM" = "due on March 2" regardless of what time the task runs on March 2, eliminating time-of-day drift when manual sends occur outside the 10am task window. Previously used millisecond-elapsed comparison which caused sends to be delayed a day when the original email was sent after 10am.
- Weekday-only: task runs at 10am Pacific Monday through Friday, skips Saturday and Sunday. Emails that become due on a weekend are held and sent on Monday.

**Escalating unanswered alerts:**
- `consecutive_unanswered` counter increments on each send, resets to 0 when any reply arrives (via `mailgun_inbound`)
- When counter reaches 2 or more, an alert email fires to ken@navigatormktg.com after each send
- Subject: "Fuel Docks Alert: [count] unanswered emails - [marina name]"
- Body includes marina details, count, cadence, and message: "This marina was just sent email #[count] since their last reply. Consider calling or adjusting the contact method."
- Alerts escalate indefinitely (2, 3, 4, etc.) until a reply resets the counter

**Mailgun threading note:** Mailgun API sends fresh emails, not threaded replies. Cannot maintain In-Reply-To/References headers without storing Message-IDs. Workaround: consistent subject lines cause email clients to group messages by subject matching.

### Free Tier Limits

Mailgun's Foundation 50k Trial plan allows approximately 50,000 emails. This is sufficient for error alerts and marina outreach. When email outreach to marinas is implemented, plan limits should be reviewed.

---

## 12. Hash-Based Change Detection

### What is a Hash?

A hash is a fingerprint for a block of text. Running page content through a hash function (such as HMAC-SHA256) produces a short, fixed-length string. If even one character changes, the hash is completely different. If the content is identical, the hash is always the same.

### Implementation in Xano

Xano has built-in filters for hashing: `md5` and `hmac_sha256`. The apify_webhook uses HMAC-SHA256 via the filter `$webhook1.scraped_content|hmac_sha256:$env.APIFY_WEBHOOK_TOKEN:false`. This was upgraded from MD5 in v3.14 (M5 security remediation) for stronger collision resistance. The HMAC variant uses `APIFY_WEBHOOK_TOKEN` as the key, which avoids the (theoretical) risk of MD5 collisions on very similar page content.

**Critical: the variable reference must be unquoted.** Writing `"$webhook1.scraped_content"|hmac_sha256:...` (with quotes) hashes the literal string `$webhook1.scraped_content` instead of the variable's contents. This produces the same hash for every marina on every run, causing the change detection to always report "no_change" after the first run. See "XanoScript hash filters require unquoted variable references" in Section 19.

### Flow

1. Apify (either actor) sends raw page content to Xano
2. Xano computes the hash using the `hmac_sha256` filter (keyed with `APIFY_WEBHOOK_TOKEN`)
3. Xano compares the new hash against `last_content_hash` stored for that marina
4. **Match:** Page unchanged. Update `last_checked` only. No Claude API call.
5. **No match:** Something changed. Call Claude Function Pack, update data, store new hash.

### Why Not Hash the Entire Page?

Dynamic elements (timestamps, ads, session tokens, random element IDs) change on every page load even when fuel prices haven't changed. This would produce a different hash every time and trigger unnecessary Claude API calls. Apify extracts only the fuel-relevant section (via CSS selector) before sending to Xano, so the hash is based on stable, relevant content.

### Null Hash Handling

When `last_content_hash` is null (first run for a marina, or manually cleared for re-testing), the conditional check `$FuelPrices1.last_content_hash != null` evaluates as false, which skips the IF branch and falls through to the Else branch for Claude processing. This was verified working in Step 2 testing.

**Forcing re-parse after prompt changes:** When the Claude system prompt is updated (e.g., adding date-aware closure logic), existing marinas will not benefit from the new prompt until their page content actually changes and produces a different hash. To force an immediate re-parse with the updated prompt, manually clear the `last_content_hash` field for the affected marina(s) in the database. The next scraper run will treat the content as new and call Claude. This was necessary when adding the date-aware closure logic: Des Moines Marina (ID 6) had already been hashed with the old prompt and needed its hash cleared to get the corrected "Open" status.

---

## 13. Tax Handling

### Washington State Rules

- **Marine gasoline:** Not taxed at the pump (exempt)
- **Marine diesel:** Taxed at the pump

### Current Approach

The `diesel_tax` field stores the tax rate as a decimal (e.g., 0.083 = 8.3%). The `price_processing_rule` field controls how each marina's prices are processed. For marinas with `price_processing_rule = "add_tax_diesel"`, both `apify_webhook` and `mailgun_inbound` automatically apply the tax after Claude extraction: `diesel_price = raw_price * (1 + diesel_tax)`, rounded to 2 decimal places. The raw pre-tax price is stored in `diesel_price_pretax`. Claude extracts whatever price appears on the website or in the email — it never calculates tax. The `diesel_tax` rate is maintained manually. Of the 14 marinas with `add_tax_diesel`, 6 have non-zero tax rates; the remaining 8 have `diesel_tax = 0` (pending setup). The `submit_call` endpoint handles tax separately via its `diesel_tax_included` input parameter. The MFD endpoints (`mfd_update_prices`, `mfd_email_inbound`) use the newer `tax_type_*`/`tax_rate_*` per-fuel-type fields.

### Future Expansion

Tax rules vary significantly by state. For the Washington-only proof of concept, the rules are simple. National expansion will require per-state tax configuration. A state-by-state reference of marine fuel taxation was partially researched but found to be inconsistent and hard to verify. The recommended approach is to research each state individually as marinas in that state are added to the system.

---

## 14. Build Order

The system is built center-out, starting with Xano (the hub) and working outward to each input channel.

### Test Marinas

Two marinas were designated for initial testing before full migration:

- **Port of Anacortes** (id=5)
- **Port of Poulsbo** (id=17)

Their Distill monitors were disabled during testing. All other marinas continued on the January architecture until the new pipeline was validated.

### Step 1: Xano Database Schema -- COMPLETE

Added 11 new fields to the existing FuelPrices table: last_content_hash, css_selector, closure_note, contact_email, email_cadence, last_email_sent, last_email_response, call_cadence, last_call, call_snooze_until, last_call_connection. All new fields are nullable. Changed existing "Distill" Method values to "HTML". Changed "Call VM" to "Call" on Port Orchard Marina (id=28) with comment noting VM has prices.

### Step 2: Xano Webhook + Claude Integration + Error Handling -- COMPLETE

**Completed:**
- Anthropic API account created at console.anthropic.com
- API key stored as Xano environment variable `anthropic_api_key` (lowercase, required by Function Pack)
- Claude Function Pack installed from Xano Marketplace (provides `createChatCompletion` function)
- Function Pack model enum updated to include `claude-haiku-4-5` and `claude-haiku-4-5-20251001`, with `claude-haiku-4-5` set as default
- `apify_webhook` (POST #36) endpoint built in "Fuel Docks API" group with full function stack
- System prompt written and refined
- `ai_comment` field added to FuelPrices table
- field_value bug fixed in Edit Record steps
- End-to-end test successful with Port of Poulsbo (id=17): gas $5.15, diesel $4.89, hours "8am-5pm daily", ai_comment "Cash and credit accepted"
- End-to-end test successful with Port of Anacortes (id=5): gas $4.61, diesel $4.44, open "Open"
- Mailgun account created, domain mg.fueldocks.app verified (all 5 DNS records green)
- Mailgun Domain Sending Keys stored as `MAILGUN_API_KEY` (mg.fueldocks.app alerts) and `MAILGUN_KEY_NAVIGATOR` (navigatorpnw.com outbound) environment variables. Replaced single Admin-role Account API key in M2 remediation (February 2026).
- Try/Catch error handling with Mailgun alert emails tested and working
- Endpoint published to live

### Step 3: Apify Actors + Cleanup -- COMPLETE

**Completed:**
- `apify_marina_list` (GET) endpoint built in "Fuel Docks API" group with input parameter `method` (text, default "HTML"), filter on FuelPrices.Method, and customized output (id, fuel_dock, website, css_selector). H2 remediation (February 2026) added a required `token` input parameter with precondition validating against `$env.APIFY_WEBHOOK_TOKEN`; unauthenticated requests return HTTP 403.
- **Fuel Docks HTML Scraper** (Cheerio actor) created and deployed:
  - Built from "Crawlee + Cheerio (JavaScript)" template
  - Fetches marina list from Xano, scrapes each page, POSTs content to apify_webhook
  - First run: 12 of 17 HTML marinas scraped successfully in 17 seconds ($0.001)
  - 5 marinas returned HTTP 403 (blocked by Cloudflare or similar protection)
- 5 blocked marinas moved from Method = "HTML" to Method = "Javascript":
  - Seattle Boat Newport (ID 22)
  - Point Roberts Marina (ID 19)
  - Skyline Marine Center (ID 18)
  - Seattle Boat Lake Union (ID 21)
  - Port of Anacortes (ID 5)
- **Fuel Docks JS Scraper** (Playwright actor) created and deployed:
  - Built from "Crawlee + Playwright + Chrome" template
  - Initial run: 3 of 5 succeeded, 2 Seattle Boat sites still blocked
  - Added stealth features (fingerprinting, resource blocking, automation flag removal, Chrome args)
  - Second run with stealth: all 5 marinas scraped successfully in 59 seconds ($0.021)
  - No residential proxy needed ($0 additional cost)
- `Actor.pushData()` added to both actors for monitoring alert support
- **6 Apify monitoring alerts configured** (3 per actor): run status, duration threshold, results count
- **Full pipeline validated:** 17/17 marinas scraping and updating prices in Xano successfully
- **Deprecated services cleaned up:**
  - `airtable_webhook` endpoint deleted from Xano
  - `AIRTABLE_TOKEN` environment variable deleted from Xano
  - Distill webhooks removed (now watchdog only, no data writes)
  - Distill trimmed from 33 to 25 monitors (5 cloud at 4x/day, 20 local) and downgraded to free plan ($0/month)
  - Old Apify actors (Cheerio Scraper, Playwright Scraper from store) and their saved tasks/schedules deleted
  - SendGrid API key deleted (account inert, no subscription charges)
  - Airtable subscription cancelled, workspace and base trash emptied

**Known issue (unresolved):** Foss Harbor (ID TBD) reported gas price of $3.62 which appears incorrect (expected ~$4.59/$4.99). Identified during Step 3 testing. No follow-up investigation has been documented. May require checking the CSS selector or verifying the marina's website format.

### Step 3.5: Webhook Security -- COMPLETE

**Completed:**
- `APIFY_WEBHOOK_TOKEN` environment variable created in Xano (renamed from legacy `FUELDOCKS_WEBHOOK_TOKEN` for clarity)
- Precondition added to `apify_webhook` function stack validating `$webhook1.webhook_token == $env.APIFY_WEBHOOK_TOKEN`
- Token sent in POST body (not HTTP header) because `util.get_raw_input` does not expose headers
- `marina_id` type conversion added as separate `$marina_id` variable with `|to_int` filter (inline filter on `db.get field_value` did not work)
- `APIFY_WEBHOOK_TOKEN` environment variable added to both Apify actors (Source tab > Environment variables > Secret checkbox enabled)
- Both actor codebases updated to include `webhook_token` in POST body
- End-to-end test: all 17 marinas (12 HTML + 5 JS) authenticated and processed successfully
- `apify_marina_list` endpoint also secured with the same `APIFY_WEBHOOK_TOKEN` via a required `token` query parameter and precondition (H2 remediation, February 2026). Both Apify actors updated to include the token in the marina list fetch URL. Unauthenticated requests return an input validation error ("Missing param: token"). Authenticated requests return the marina list as before.

### Step 4: Xano Background Task Scheduling -- COMPLETE

**Completed:**
- Old `sync_airtable_marinas` Background Task (#1) deleted (legacy Airtable sync, no longer needed)
- Three new Xano environment variables created:
  - `APIFY_API_TOKEN`: Apify Personal API Token (from Settings > Integrations in Apify)
  - `APIFY_HTML_ACTOR_ID`: `h27M51Qk8s4lveFFA`
  - `APIFY_JS_ACTOR_ID`: `9bd2ESbz4PrSOcqV0`
- `trigger_apify_scrapers` Background Task (#2) built and activated:
  - Schedule: every 3 hours (freq: 10800 seconds), starting Feb 12, 2026 6:00 AM Pacific
  - Time window check: gets current Pacific hour, only triggers actors if between 6am (hour >= 6) and before 9pm (hour < 21). Note: this excludes the 9pm hour itself, so the last effective run is 6pm. See Section 9 for the off-by-one detail.
  - Triggers HTML Scraper via POST to Apify API with `build: "latest"` param
  - Triggers JS Scraper via POST to Apify API with `build: "latest"` param
  - Each trigger wrapped in independent try_catch with Mailgun error alerts
- Debugger test confirmed both actors triggered successfully (HTML Scraper run #8, JS Scraper run #6)
- Task published and set to Active status

### Step 5: Mailgun Inbound Email Processing -- COMPLETE

**Completed:**
- Mailgun account created
- mg.fueldocks.app domain added and all DNS records verified
- navigatorpnw.com domain added and DNS records verified
- API key created and stored in Xano environment variables
- Alert emails sending successfully from alerts@mg.fueldocks.app
- `mailgun_inbound` (POST #39) endpoint built in "Fuel Docks API" group:
  - Uses `util.get_raw_input` with `x-www-form-urlencoded` encoding to capture Mailgun's raw POST data
  - Extracts email body via `$var.mailgun_raw|get:"stripped-text"` pipe filter
  - Extracts sender via `$var.mailgun_raw|get:"sender"` pipe filter
  - Query: db.query FuelPrices where contact_email == $sender_email (using `$db.FuelPrices.contact_email` syntax)
  - Precondition: FuelPrices1 != null (stops if no marina matches sender)
  - Try block: Claude Function Pack call with email parsing prompt using $var.email_body, parsed_response extraction, database update with prices and timestamps
  - Catch block: Mailgun error alert email with marina details and error info
  - Authentication: Originally disabled; HMAC-SHA256 signature verification added post-Step 5 (see Section 8.5)
- `contact_email` field type changed from "email" to "text" in database schema (email type does not support query filtering)
- Mailgun inbound route created:
  - Match Recipient: `.*@navigatorpnw.com`
  - Forward to: `https://xlba-eg1u-i4nx.n7e.xano.io/api:-GTDJqKH/mailgun_inbound`
  - Stop: enabled
  - Priority: 0
- **End-to-end test successful with real email:** Email sent from ken.clements@outlook.com to ken@navigatorpnw.com, routed through Mailgun to Xano. Fair Harbor Marina (ID 3) updated: gas_price 5.33, diesel_price 4.33, open "Open", hours "7 days a week, 8am to 5pm", last_email_response set. Manually maintained fields (cash_card, vol_discount, gas_comment, diesel_comment, diesel_tax) preserved. Mailgun logs confirmed Delivered status.
- Response changed from $mailgun_raw (debugging) to $FuelPrices1 (production)
- Endpoint published
- **DMARC record added** to navigatorpnw.com: TXT record on `_dmarc` hostname with value `v=DMARC1; p=none; rua=mailto:ken@navigatorpnw.com`. Monitor mode for now, to be tightened after Step 6 outbound emails have been live for 3-4 weeks.

**Key debugging discovery:** Initial builds used named Xano inputs (`stripped_text`, `body_plain`) which worked in the Xano debugger but failed with real Mailgun traffic. Mailgun sends `x-www-form-urlencoded` data with hyphenated field names (`stripped-text`, `body-plain`). The underscore-named inputs received empty values. The fix was switching to `util.get_raw_input` with the `|get` pipe filter to access hyphenated keys directly from the raw payload.

**DMARC:** Added to navigatorpnw.com DNS in Hover. TXT record on `_dmarc` with `v=DMARC1; p=none; rua=mailto:ken@navigatorpnw.com`. Monitor mode. Review and tighten after Step 6 has been live for 3-4 weeks.

### Step 6: Email Outbound -- COMPLETE

- DMARC already configured in monitor mode (completed in Step 5). Review aggregate reports and tighten policy (p=quarantine or p=reject) after outbound has been live for 3-4 weeks.

**Completed:**
- `send_price_check_email` Custom Function created in Library > Functions > Fuel Docks folder. Contains all per-marina send logic: database lookup, custom/default template selection, placeholder replacement (`{{fuel_dock}}`, `{{gas_price}}`, `{{diesel_price}}`), literal `\n` to newline conversion, Mailgun send via navigatorpnw.com domain with `o:store=yes` (enables Quick View and MIME tab content in Mailgun logs for debugging), `last_email_sent` timestamp update, `consecutive_unanswered` counter increment. Published February 12, 2026.
- `send_outbound_email` endpoint refactored from 93 lines to 18 lines. Now a thin wrapper that passes `marina_id` to the Custom Function. Published.
- `send_outbound_emails` Background Task built with daily schedule at 10am Pacific, Monday through Friday (starts_on: 2026-03-08 17:00:00 UTC, freq: 86400 seconds). Weekend skip via `now|format_timestamp:"N":"America/Los_Angeles"|to_int` (ISO day-of-week, 1=Monday through 7=Sunday) with early return when day >= 6. Queries all marinas, filters for Method=Email with contact_email in the loop. Date-based cadence logic (v3.18): adds cadence days to reference timestamp (`last_email_response` or `last_email_sent`), formats as `Y-m-d` Pacific, sends if due date <= today. Eliminates time-of-day drift from manual sends. Defaults cadence to 7 days if null or zero. Try/catch per marina so one failure does not block others. Published and active.
- `consecutive_unanswered` integer field added to FuelPrices table (nullable, default 0). Tracks how many outbound emails have been sent without receiving a reply.
- `email_subject` and `email_body` text fields added to FuelPrices table for per-marina custom templates.
- Escalating alert system: after each successful send, task checks if `consecutive_unanswered` >= 2. If so, sends alert to ken@navigatormktg.com via Mailgun (mg.fueldocks.app) with marina name, ID, contact email, unanswered count, cadence, and suggestion to call or adjust contact method. Alerts fire every cycle indefinitely (2, 3, 4, etc.)
- `mailgun_inbound` endpoint updated: resets `consecutive_unanswered` to 0 on both normal price reply path and forward-to-human path (any reply resets the counter)
- End-to-end tested:
  - Task correctly skips marinas not yet due based on cadence
  - Task correctly sends to due marinas via Custom Function
  - Custom email template with placeholders delivered correctly (Hood Canal Marina, ID 47, test address ken.clements@outlook.com)
  - Counter increments on each send (1, 2, 3...)
  - Escalating alert fires when consecutive_unanswered reaches 2
  - Alert subject: "Fuel Docks Alert: 2 unanswered emails - Hood Canal Marina"
  - Alert body: "This marina was just sent email #2 since their last reply. Consider calling or adjusting the contact method."
  - Error catch block tested: sends separate failure alert per marina
  - Weekend skip verified: task correctly exits with early return on Saturday/Sunday
- Task published and active. Activated with real marina contact emails populated.

**Custom Function approach:** The send logic lives in one place (`send_price_check_email`). Both the manual `send_outbound_email` endpoint and the automated `send_outbound_emails` task call the same function. Future changes to email templates or Mailgun configuration only need to be made once.

**Design origin:** The outbound email template system was designed and initially built in thread 4d ("Customizable outbound email") as a standalone `test_outbound_email` endpoint. Key design decisions made during that thread: plain text over HTML for deliverability, no separate `contact_name` field (names embedded in templates), `\n` literal characters in database converted to real newlines at send time, and conditional fallback logic for custom vs. default templates. The `forward_to_human` feature was also added to `mailgun_inbound` in that thread. The endpoint was renamed to `send_outbound_email` and later refactored into the Custom Function pattern during Step 6.

**XanoScript note:** `db.query` with a `search` block inside a Background Task caused "Invalid block: search on line X" parse errors. The workaround is querying all records without a search filter and filtering inside the foreach loop using conditionals. With 31 records this has negligible performance impact.

### Step 7: Adalo Call Data Entry -- COMPLETE

**Completed:**
- Full Step 7 specification written (thread "7. Dialing App"): Adalo screen layout, 3 Xano endpoints, Claude call-notes prompt, diesel tax logic, queue filtering, data flow
- Three Xano endpoints built in "Fuel Docks API" group:
  - `call_queue` (GET #42): Returns Method=Call marinas due for a call with five-condition filter and next_call_due. Hand-written XanoScript with complex conditional logic for filtering.
  - `snooze_call` (POST #43): Snoozes marina for 1 hour or until 12:01 AM Pacific tomorrow (originally 8am, changed to 12:01am in v3.11.1 so snoozed marinas reappear at start of day). Initially built in Stack UI but auto-generated XanoScript used quoted expressions for timestamps that were treated as literal strings. Fixed by converting to dollar-sign variable references.
  - `submit_call` (POST #44): Processes completed calls with optional diesel tax subtraction, conditional Claude call for notes, and full FuelPrices record update. Initially had critical bugs where conditionals compared string literals ("input.notes") instead of variable references ($input.notes), causing Claude to fire on every submit even with empty notes. Fixed with wholesale XanoScript replacement (thread "7.1 Dialing App").
- Diesel tax calculation tested: correctly subtracting 0.092 from 5.00 to get 4.908 (thread "7.1")
- Claude call-notes parsing tested: correctly extracting future closure dates and setting appropriate recheck_date values (thread "7.1")
- "FD Dialer" Adalo app built (thread "7.2 Dialing app"):
  - Welcome screen with orange LOG IN button
  - Home screen displaying call queue as marina card list (each card shows name, city, open status)
  - Call Detail screen with full marina info block, open/closure status in red/orange, Call button (tel: URI), comment display, gas/diesel price inputs (numeric keypad, empty fields with current prices shown in label text for reference), diesel tax field with contextual label, diesel tax checkbox, notes text input, and three action buttons
  - All three action buttons (Submit, Call Back - 1 Hour, Call Back Tomorrow) wired to correct Xano endpoints and return to Home
  - Screen consolidation: originally had separate Call List screen, but moved all content to Home screen for cleaner navigation
- TestFlight deployment (thread "7.3 Dialing app"):
  - Adalo "Publish to App Store" completed with Build 1.0 (104)
  - App Store Connect configured with Internal Testing group
  - Apple encryption compliance question answered (No)
  - Apple ID mismatch between App Store Connect tester account and TestFlight device identified as common gotcha
  - Initial device testing performed on iPhone 17 Pro running iOS 26.4
- Post-build refinements (thread "Conditional extension display in mobile app"):
  - Phone and extension split from one combined text component into two separate Adalo text components so extension can be independently hidden
  - Extension text component set to Sometimes Visible in Adalo (only renders when extension field is not empty)
  - Phone number text on Call Detail screen wired as tap-to-call via Website link action with `tel:` URI, "Use In-app Browser" set to Off (opens native dialer on mobile devices, does not work in Adalo previewer)
  - Tap-to-call confirmed working on iPhone 17 Pro, iOS 26.4 after fresh TestFlight publish
- Post-build Adalo Custom Action fixes (thread "Adalo/Xano snooze button fix"):
  - Root cause: all three button Custom Actions (Submit, Snooze 1 Hour, Snooze Tomorrow) had hardcoded values in their JSON body instead of Magic Text chip references. Inputs were defined in the Custom Action but not wired into the body, so Adalo sent static values (e.g., marina_id: 1, snooze_type: "") regardless of which marina was selected.
  - Discovery: Xano request history showed snooze_call receiving marina_id: 1 (hardcoded) and snooze_type: "" (empty) with 400 status. Database confirmed call_snooze_until remained null for the target marina.
  - Adalo JSON validation constraint: Custom Action bodies cannot contain unquoted Magic Text chips for numeric types. `{"marina_id": [chip]}` triggers "Please enter a valid JSON body" error. All values must be quoted: `{"marina_id": "[chip]"}`.
  - Xano endpoint changes: both `snooze_call` (#43) and `submit_call` (#44) changed all numeric inputs from `int`/`decimal` to `text`, with internal `|to_int` and `|to_decimal` casting. Guard clause added to both endpoints returning null when marina_id is 0/empty, allowing Adalo's RUN TEST REQUEST to succeed.
  - XanoScript `to_float` does not exist: initial attempt used `to_float` filter which produced "Invalid filter name" error. Correct filter is `to_decimal`.
  - Each Adalo button has its own independent Custom Action instance (not shared). All three buttons required separate fixes.
  - All three Custom Actions rebuilt with Magic Text chips in body, tested via RUN TEST REQUEST (200 with null response), saved, and input mappings verified at button level.

**Key design decisions:**
- Extension displayed visually on card (not auto-sent via tel: URI comma pauses) because timing varies per marina phone system
- Gas and diesel price fields are optional (allows submission with just notes, e.g., marina reports closure)
- Diesel tax math lives in submit_call endpoint, not in Adalo (Adalo sends checkbox state and raw entered price)
- Claude only fires when notes text is provided (does not extract prices from notes, only status/closure/hours)
- Navigation is action-button-driven: Submit or snooze advances back to Home, showing the next card or the empty-queue screen
- Submit_call sets `last_call` and `last_call_connection` to now and clears `call_snooze_until`; snooze_call sets only `last_call` to now (attempt recorded, but no connection)

**H3 Security Remediation (February 2026):**
- `call_queue` (#42) endpoint secured with FD_API_TOKEN precondition: `api_token` text input with trim filter, precondition checking `$input.api_token == $env.FD_API_TOKEN`, returns HTTP 403 "Unauthorized" on mismatch. Same pattern as `submit_call` and `send_outbound_email`.
- Adalo FD Dialer app updated: "Call Queue" external collection Get All URL updated to include `api_token` as a query parameter. Token value contains `&` character which required URL-encoding as `%26` in the Adalo URL field.
- Verified: unauthenticated requests return 403 (tested by omitting token), authenticated requests return full marina data (Test Connection successful in Adalo).
- `submit_call` (#44) Authentication section in this document corrected: the endpoint already had the FD_API_TOKEN precondition in its function stack (added previously), but the Authentication subsection still said "disabled." Fixed to accurately reflect the implemented auth.

### Step 8: Daily CSV Backup -- COMPLETE (v3.15, updated v3.19)

**Completed:**
- `daily_csv_backup` Background Task (#5) created in Xano workspace
- Exports entire FuelPrices table to a dated CSV file (`fuel_docks_backup_YYYY-MM-DD.csv`) in Xano public file storage
- Schedule: daily at 11:59 PM Pacific (06:59 UTC), frequency 86400 seconds
- Function stack: query all records sorted by id, extract headers from first record with `|keys`, loop all records converting each to double-quoted comma-separated values, concatenate header + data rows with newlines, write to file storage
- Initial implementation attempted `csv_create` filter but encountered underdocumented 5-argument requirement and array-of-arrays expectation; switched to manual `values|join` approach
- Tested via Debug: 56 statements in 170ms, CSV verified with 48 lines (1 header + 47 data rows matching FuelPrices record count)
- Task published and active
- v3.19: Added double-quoting to all CSV values for Excel compatibility. First nightly backup (March 1, 2026) revealed that fields containing commas (closure notes, hours, comments) caused column misalignment in Excel. Fix wraps every header and value in double quotes using `"\"" ~ (values|join:"\",\"") ~ "\""` pattern. Required adding a `$current_row` temp variable because the quoting expression was too complex to nest inside `push`.
- See Section 9.6 for full task detail, XanoScript, and implementation lessons

### Step 9: Consumer App Marina Detail Pages -- COMPLETE (v3.24)

**Completed:**
- Three detail screens added to the consumer-facing Fuel Docks Adalo app: **Gas Detail**, **Diesel Detail**, and **Closed Fuel Docks**
- Each list screen (Gas, Diesel, Closed) has a Row Action (Link) on its table component that navigates to the corresponding detail screen, passing the current row's collection data
- Each detail screen displays: marina name (fuel_dock), gas and diesel prices with dollar signs, last updated date (last_updated), ethanol free status, volume discount status, cash/card info, city, phone, and website
- Closed Fuel Docks detail screen shows the `open` field (closure status/note) in red text instead of gas/diesel prices
- Back navigation button using Unicode triangle character (U+25C0) with Link action returning to the originating list screen
- Phone number tappable via External Link action with `tel:` URI and "Use In-app Browser" Off (triggers native phone dialer)
- Website tappable via External Link action with website field URL and "Use In-app Browser" On (opens in-app web view)
- Xano `marina_detail` endpoint (#46, api_id 46) created via MCP in the Fuel Docks API group. Returns a single marina by ID with the same H1 field whitelist and `last_updated_relative` computation as the list endpoints. 60-second cache. Tagged "adalo apis"
- Xano-Marina-Detail External Collection created in Adalo with Get One configured for `?id={{id}}` query parameter format. Test connection passed using `gas_price_low_to_high` as the Get All URL (Adalo requires a passing Get All test to save any External Collection)

**Architecture decision: three detail screens instead of one shared screen:**

The original plan was a single shared detail screen backed by the `marina_detail` Xano endpoint. All three list screens would pass just the marina ID, and the detail screen would fetch the full record via Get One. However, Adalo treats each External Collection as an independent data source. When three different source screens link to one destination screen, Adalo creates three separate "Available Data" slots (one per source collection), each "Missing from" the other two source screens. Magic Text wired to one collection's field is blank when the user arrives from a different collection.

The practical fix was creating three separate detail screens (Gas Detail, Diesel Detail, Closed Fuel Docks), each wired to its own source collection's data via the Link action. The list row data is passed directly through the Link action, so no Xano endpoint call is needed at runtime. This means:
- The Xano-Marina-Detail External Collection is not actively used by any Adalo screen (retained in case a future use arises)
- The `marina_detail` Xano endpoint (#46) was live but not called by the Adalo app. It is now actively called by the React Native/Expo consumer app's detail screen (v4.0), which fetches marina data by ID on each detail screen load
- Each detail screen is a copy of the Gas Detail screen with Magic Text chips swapped to the correct collection source
- Layout changes only need to be replicated across three screens (manageable at current scale)

**Key implementation notes:**
- Adalo External Collections always run a Get All test at Step 3 (Test Connection). If the endpoint only supports Get One (single object response), the test fails because Adalo expects an array. Workaround: set the Get All URL to an existing list endpoint that returns an array with matching field names, then configure Get One separately with the actual single-record endpoint URL
- Adalo External Collection Get One URL format: use `?id={{id}}` query parameter syntax, not the default path segment `/{id}` format, to match Xano's query parameter input pattern
- Adalo does not have a toggle to disable individual endpoints in an External Collection. Unconfigured endpoints (Create, Update, Delete) are simply left with default/blank URLs and are never called
- Screen duplication in Adalo uses keyboard shortcuts: Ctrl+C on a selected screen, then Ctrl+V to paste a copy. This copies all components, Magic Text references, click actions, and styling
- When duplicating a detail screen, all Magic Text chips must be individually swapped to the new collection source. There is no bulk-replace capability in Adalo

---

### Step 10: Report Price Feature -- COMPLETE (v3.25)

**Purpose:** Allow consumer app users to report incorrect marina fuel prices. User input is compiled into an alert email to Ken, and the system takes automated action to re-verify prices based on the marina's collection method.

**Completed (Xano backend):**
- `CONSUMER_API_TOKEN` environment variable created (separate from `FD_API_TOKEN` for independent rotation)
- `APIFY_API_TOKEN`, `APIFY_HTML_ACTOR_ID`, `APIFY_JS_ACTOR_ID` environment variables created (for triggering Apify actor runs from Xano)
- `apify_marina_list` (api_id 38) updated with optional `id` parameter for single-marina lookups. Uses early `return` for the single-marina path to avoid XanoScript variable scoping issues with conditional branches
- `report_price` endpoint (api_id 47) created with full logic: CONSUMER_API_TOKEN auth, input validation ($2-$15 range, at least one data field required), alert email construction, and all five Method-specific automated actions (HTML: trigger Cheerio actor, Javascript: trigger Playwright actor, Call: null last_call_connection, Email: send immediate price check email and update last_email_sent/consecutive_unanswered, Facebook: no automated action noted in alert email)
- Tax toggle fields (`gas_tax_included`, `diesel_tax_included`) removed from endpoint inputs during implementation. Adalo toggle components do not appear in Magic Text pickers for Custom Action input mapping, and Ken verifies prices manually from the alert email anyway

**Completed (Apify actors):**
- Cheerio actor (build 0.0.11) updated: reads optional `marina_id` from actor input via `Actor.getInput()`, appends `&id=${marinaId}` to the `apify_marina_list` URL when present
- Playwright actor (build 0.0.10) updated: same pattern as Cheerio actor
- In single-marina mode, the list endpoint returns a single-item array so the existing loop runs exactly once. No other actor logic changes required.

**Completed (Adalo consumer app):**
- Two Report Price screens: **Gas - Report Price** (receives data from Gas Detail screen via Xano-Gas-pricesort) and **Diesel - Report Price** (receives data from Diesel Detail screen via Xano-Diesel-pricesort). Two screens required because Adalo treats each External Collection as an independent data source; a single shared screen shows blank Magic Text when navigated from the wrong source collection (same pattern as Step 9 detail screens).
- Gas Detail and Diesel Detail screens each have a "REPORT PRICE CHANGE" button with a Link action to the corresponding Report Price screen, passing the current marina's collection data
- Each Report Price screen displays: marina name, current prices, last updated date, explanatory callout about first-gallon pricing and tax inclusion, three form inputs (gas price, diesel price, comments), and a Submit button
- Diesel price input uses "Sometimes Visible" condition where `diesel_price` is not equal to `9999` (hides for gas-only marinas)
- Submit button has two actions: (1) Custom Action POST to `report_price` endpoint, (2) Link to Confirmation screen
- **Confirmation** screen with thank-you message and "DONE" button linking back to home
- Back navigation uses Adalo's built-in "Back" screen option, which returns to whichever detail screen the user came from

**Custom Action body configuration (critical Adalo learning):**
- The Adalo Custom Action body supports Magic Text chips (orange inline tokens) inserted via the T* icon. These chips are correctly substituted at runtime.
- The `{{input_name}}` double-curly-brace template syntax does NOT work. Adalo sends the literal string `{{input_name}}` to the server instead of substituting the input value. This was discovered after multiple failed test submissions where the Xano request history showed literal `{{marina_id}}` arriving as the marina_id value.
- The correct pattern: define named Inputs in the right panel of the Custom Action wizard (step 2), then in the Body field use the T* icon to insert those Inputs as orange chips inside quoted JSON values. Static values (like api_token) are typed directly as plain text. After saving, the Inputs appear on the button's action config for mapping to screen data via Magic Text.

**Key implementation notes:**
- Reported prices are never written to the database. The endpoint only sends an alert email and triggers re-verification.
- Email-method marinas: the report_price endpoint sends an immediate price check email and treats it as a regular send (updates `last_email_sent` and increments `consecutive_unanswered`), restarting the cadence from now.
- Call-method marinas: nulling `last_call_connection` causes the marina to appear in the call queue immediately (cadence only applies after a successful connection).
- Apify actor runs are triggered via the Apify REST API (`/v2/acts/{actorId}/runs?token={apiToken}`) with the `marina_id` passed as the run input JSON body.
- XanoScript variable scoping: variables declared inside conditional branches (if/else) are not accessible outside the conditional. The `apify_marina_list` endpoint required restructuring to use early `return` for the single-marina path and a top-level query for the batch path. Attempts to use `var.update` on an outer variable from inside a conditional, or to use `as $response` inside both branches, both failed at runtime with "Unable to locate response" errors.

---

### Step 11: In-App Map -- COMPLETE (v3.27)

**Purpose:** Replace the external Google My Maps link with a native in-app map showing all fuel dock locations as tappable pins that navigate to the marina detail screen.

**Previous state:** The consumer app's side navigation had a "Map" menu item (Menu Item 4) that opened an External Link to a Google My Maps page (`google.com/maps/d/viewer?mid=...`). This opened in the device's browser or the Google Maps app, with limited information on each pin and no way to navigate back into the Fuel Docks app from a pin tap.

**Completed (Xano backend):**
- `map_marinas` endpoint (api_id 48, GET, no auth, 60s cache) created via MCP. Returns all marinas with no status or price filters. Uses the same H1 field whitelist (20 display fields) as other consumer endpoints. Sorted alphabetically by `fuel_dock`. Computes `last_updated_relative` from `last_checked`. Tagged "adalo apis"
- No rate limiting (Xano plan limitation). The 60-second response cache provides meaningful protection against repeated requests

**Completed (Google Cloud):**
- Google Maps Platform billing account created ("My Maps Billing Account") under the existing "Fuel Docks locator" Google Cloud project (project number 251292635018). Google provides $200/month free credit for Maps Platform usage, sufficient for the app's scale
- Maps JavaScript API, Maps SDK for iOS, and Maps SDK for Android enabled on the project
- Existing API key renamed from "API key 1" to "Google My Maps - Fuel Docks" for clarity (renaming does not change the key value)
- New API key "Adalo Map - Fuel Docks" created and restricted to three APIs: Maps JavaScript API, Maps SDK for Android, Maps SDK for iOS

**Completed (Adalo consumer app):**
- Xano-marinas-map External Collection created. Base URL: `https://xlba-eg1u-i4nx.n7e.xano.io/api:-GTDJqKH/map_marinas`. Only Get All configured (no Results Key or Request Key needed; endpoint returns a flat JSON array)
- Adalo Map marketplace component installed (made by Adalo, uses Google Maps under the hood)
- New "Map" screen created with the Map component configured: Google Maps API key set, "Multiple Markers" mode, Marker Collection set to Xano-marinas-map, Marker Address uses Magic Text `latitude, longitude` (comma-separated lat/lng pair), "Show Current Location" toggle enabled (shows user's blue dot)
- Pin click action: Link to Gas Detail screen, passing "Current Xano-marinas-map" data. The Gas Detail screen receives the full marina record from the map collection and displays it the same way it does when navigated from the Gas price list
- Side Navigation Menu Item 4 ("Map") updated: External Link action (Google My Maps URL) deleted and replaced with a Link action to the new Map screen

**Map behavior and limitations:**
- The Adalo Map component auto-fits the zoom level to show all markers. There is no setting for initial zoom, center point, or zoom constraints
- With all ~31 marinas in the PNW, the auto-fit zoom is reasonable. National expansion will cause the map to zoom out to show the entire continent, at which point the endpoint should be updated to accept lat/lng and a radius to return only nearby marinas
- The component fetches data once on screen load. Zooming in or out does not trigger a new API call; all pins are loaded upfront
- The map style is "Roadmap" (default). Custom styling is available via the "Custom Style JSON" field but not configured
- The component does not support marker clustering, custom pin icons, or info window popups. Pin taps navigate directly to the detail screen

**Key implementation notes:**
- Adalo Map component requires a Google Maps API key with billing enabled. Without billing, the Maps JavaScript API cannot be enabled. Google's free tier ($200/month) covers approximately 28,000 dynamic map loads per month
- The Marker Address field accepts comma-separated latitude/longitude coordinates as an alternative to street addresses. Format: `{latitude}, {longitude}` using Magic Text tokens. Google's geocoder resolves the coordinates to a map pin position
- The "Marker Source" dropdown (Default vs Custom) controls pin icon style, not coordinate source. "Custom" allows custom pin images but does not add lat/lng input fields
- The "Using from this Link" warning ("Current Xano-Gas-pricesort Now Unavailable on Gas Detail Screen") is expected and harmless. It indicates that when arriving from the map (instead of the gas price list), the Gas Detail screen does not have Xano-Gas-pricesort data available. The screen works correctly because it reads from whichever collection record was passed via the Link action

---

### Step 12: React Native Consumer App Migration -- IN PROGRESS (v4.0–v4.16)

**Purpose:** Replace the Adalo consumer-facing app with a native React Native/Expo app for better performance, customization, and feature flexibility. The Adalo app's no-code constraints (especially around data passing between screens, map customization, and UI styling) motivated the migration to a code-based approach.

**Technology stack:**
- **Expo SDK 54** with TypeScript and Expo Router (file-based routing)
- **React Native 0.81.5** with React 19.1
- **Three-font system:** PTSans_400Regular (body text), PTSans_700Bold (bold/emphasis), PTSansNarrow_700Bold (screen titles)
- **Brand colors:** blue `#070531` (primary text/navigation), red `#E33500` (accent/alerts), green `#4CD964` (splash screen)
- **axios** for API calls to Xano (base URL: `https://xlba-eg1u-i4nx.n7e.xano.io/api:-GTDJqKH`)
- **expo-location** for device GPS (nearby fuel sort), **react-native-maps** for native map
- **expo-clipboard** for coordinate copying, **expo-file-system/legacy** + **expo-sharing** for GPX export
- **@react-native-async-storage/async-storage** for local device persistence (first-launch detection and offline data cache)
- **@react-native-community/netinfo** for event-driven network state monitoring (passive offline detection)
- **@expo/vector-icons** (Ionicons) for UI icons

**App structure (Expo Router file-based routing):**

| File | Screen | Description |
|------|--------|-------------|
| `app/_layout.tsx` | Root layout | Font loading (PT Sans family), welcome splash screen, Stack navigator, NetworkProvider context wrapper (v4.2), LocationProvider context wrapper (v4.3), DisclaimerProvider context wrapper (v4.12). Fire-and-forget `versionPing()` call on mount (v4.37) — sends device_id, app_version, and platform to Xano once per session; uses `useRef` guard to prevent double-fire in React strict mode; errors silently ignored. Stack screens: `(tabs)`, `marina/[id]` ("Fuel Dock Details"), `marina/map` ("Map", v4.16), `report-price/[id]` ("Report Change"), `privacy-policy`, `terms-of-service`, `location-help`. One-time pricing modal removed (v4.12) — disclaimer now accessible only via PriceDisclaimerFooter tap-to-open modal on Price and Nearby tabs. |
| `app/(tabs)/_layout.tsx` | Tab bar | Bottom tab navigation in order: Map, Price, Nearby, Closed, About (v4.27, previously Gas, Diesel, Nearby, Closed, Map, About). Nearby (`index.tsx`) is the default landing screen. Tab label font size 13px (v4.27). Per-tab active icon/label colors (v4.27): Map `#30B0C7` (cyan), Price `#47D45A` (green), Nearby `#007AFF` (blue), Closed `#FF3B30` (red), About `#E33500` (Navigator red); inactive tabs use theme default gray (`tabIconDefault`). `TAB_COLORS` constant defines the color map. Each tab uses `focused` prop in `tabBarIcon` and per-screen `tabBarActiveTintColor` to color both icon and label when selected. Map tab greyed out and disabled when offline: icon color changes to #ccc, label turns grey, taps suppressed via Pressable with onPress=undefined, opacity 0.4 (v4.4). Tab bar has 2px top padding for spacing between divider line and icons (v4.11). Closed tab icon changed from `xmark.circle.fill` (X-in-circle, looked like a "close app" button) to `MaterialIcons` `event-busy` (calendar with X) imported directly — bypasses `IconSymbol` abstraction because `calendar.badge.xmark` SF Symbol is not available in the `sf-symbols-typescript` type definitions bundled with expo-symbols (v4.30) |
| `app/(tabs)/index.tsx` | Gas prices | Gas prices sorted low-to-high, pulls from `gas_price_low_to_high` via cached API wrapper. Offline banner, auto-refresh on reconnect (v4.2). Passes user coordinates to cached API for 75-mile cache filtering (v4.3). Fixed price disclaimer footer bar above tab bar (v4.9). SafeAreaView uses `edges={['top', 'left', 'right']}` on all states (main, loading, error) to prevent double bottom inset with tab bar (v4.23) |
| `app/(tabs)/closed.tsx` | Closed marinas | Closed marinas list, pulls from `closed_marinas` via cached API wrapper. Offline banner, auto-refresh on reconnect (v4.2). Passes user coordinates to cached API for 75-mile cache filtering (v4.3). SafeAreaView uses `edges={['top', 'left', 'right']}` on all states (v4.23) |
| `app/(tabs)/nearby.tsx` | Nearby fuel | Distance-sorted prices using shared LocationContext (v4.3, previously local expo-location), pulls from `gas_prices_by_distance` / `diesel_prices_by_distance` via cached API wrapper with gas/diesel toggle. Offline banner, auto-refresh on reconnect (v4.2). 75-mile cache filtering via shared coordinates (v4.3). Fixed price disclaimer footer bar above tab bar (v4.9). SafeAreaView uses `edges={['top', 'left', 'right']}` on all states (v4.23) |
| `app/(tabs)/map.tsx` | Map | Native react-native-maps MapView with pins for all marinas, pulls from `map_marinas`. Map centering uses shared LocationContext (v4.3, previously local expo-location). When offline, displays "Map does not work when your device is not connected to the internet." instead of loading the map (v4.4). **Pin colors (v4.24):** open marinas `#47D45A` (green), closed marinas `#D65A5D` (red) — previously `Brand.blue`/`#999`. **Platform-specific pin interaction (v4.14):** On iOS, tapping a pin shows a native `Callout` bubble (`tooltip={false}`) with marina name, gas/diesel prices, and "Tap for details" link; tapping the Callout navigates to marina detail. On Android, tapping a pin shows a custom info card overlay at the bottom of the map (same content); tapping the card navigates to marina detail; tapping the map background dismisses the card. Android uses the overlay because Google Maps renders custom Callout content as clipped static bitmaps (v4.12). |
| `app/(tabs)/about.tsx` | About | App info (app icon 140x140 (v4.10), "FUEL DOCKS" 40px `FontFamily.title` with letter spacing (v4.11), tagline "Compare marina fuel prices" bold (v4.20, previously "Marina fuel prices at your fingertips"), version without build number in `Brand.red` (v4.20, build number removed)). Privacy Policy and Terms of Service links (moved above orange box, v4.12). Pricing disclaimer box (red `#E33500` background, white bold 18px centered text: "All prices include tax. Volume discounts are not reflected and may lower your final cost." — third sentence removed (v4.12), `marginTop: 32`). Disclaimer section (bordered card with bold `Brand.blue` title + body text, body updated v4.12: "often" replaces "regularly", "cannot be held responsible" replaces "is not responsible", `marginTop: 0`). Navigator branding footer. |
| `app/marina/[id].tsx` | Marina detail | Full marina detail with prices, hours, contact info. Coordinates row in info table with inline copy icon (v4.13, previously in top section). Map and Export GPX buttons side-by-side below info table (v4.13, previously stacked in top section). Map button navigates to in-app `marina/map` screen (v4.16, previously opened native maps app via `Linking.openURL`). "Report Change" small outlined button inline on "Last updated" row (v4.13, previously full-width "Report Price Change" button in actions section). YouTube video thumbnail with play overlay (v4.5). Disabled when offline (v4.2). |
| `app/marina/map.tsx` | Marina map | In-app map screen showing a single fuel dock pin (v4.16). Receives marina data (id, fuel_dock, latitude, longitude, gas_price, diesel_price, open, City) via route params from the detail screen — no API call needed. Uses same platform-specific pin interaction as the bottom nav map: iOS shows native `Callout` bubble, Android shows custom info card overlay. Tapping the callout/card navigates back to the marina detail screen. Stack screen with header title "Map" and back button to "Fuel Dock Details". |
| `app/report-price/[id].tsx` | Report price | Price correction form (header title "Report Change", v4.14 — previously "Report Price Change"), submits to `report_price` endpoint. Notice box text updated (v4.14): "All prices include tax..." and "prices do not have volume discounts applied." Submit disabled when offline with message (v4.2) |
| `app/privacy-policy.tsx` | Privacy policy | Static privacy policy text. Includes "Automatic Data Deletion" subsection under Server Logs in Section 1, documenting that personal information is deleted automatically through log retention cycles (v4.17). Last Updated: March 16, 2026. Uses `SafeAreaView edges={['bottom', 'left', 'right']}` to avoid double top padding on Android (v4.10) |
| `app/terms-of-service.tsx` | Terms of service | Static terms of service text with safety warning box (yellow `#FFF8E1` background, dark goldenrod `#8B6914` bold text). Linked from About screen. Same SafeAreaView edge configuration as privacy policy (v4.10) |

**API service layer (`services/api.ts`):**
- Centralized axios instance with 10s timeout
- Axios request interceptor attaches `X-App-Version` (from `Constants.expoConfig.version`), `X-Platform` (from `Platform.OS`), and `X-Device-Id` (from `services/deviceId.ts`) headers to every outbound API call (v4.37). Headers are informational for future debugging; the actual version tracking is done by the `versionPing()` call on launch.
- Functions: `getGasPrices()`, `getDieselPrices()`, `getMarinaDetail(id)`, `getGasPricesByDistance(lat, lng)`, `getDieselPricesByDistance(lat, lng)`, `getClosedMarinas()`, `getMapMarinas()`, `reportPrice(input)`, `versionPing()` (v4.37)
- `CONSUMER_API_TOKEN` stored in the service file for `report_price` endpoint authentication

**Offline cache layer (v4.2):**

New files added for offline mode support:

| File | Purpose |
|------|---------|
| `services/cache.ts` | AsyncStorage wrapper with typed cache entries (data + timestamp per endpoint key). Functions: `getCache<T>(key)`, `setCache<T>(key, data)`. No TTL — always uses fresh data when online, falls back to whatever is cached when offline. |
| `services/cachedApi.ts` | Network-first API wrappers returning `CachedResult<T>` with `{ data, fromCache, cacheTimestamp }`. Generic `withCache<T>()` function wraps each `api.ts` function: tries network first (with retry, v4.5), caches on success, falls back to cache on failure. API retry logic via `fetchWithRetry()` attempts each API call up to 2 times with 1-second delay between attempts before falling back to cache (v4.5). Optional `cacheFilter` parameter narrows data before caching while returning full dataset to caller (v4.3). All five marina-list functions use `withCacheAndPreCacheDetails()` wrapper which, after a fresh API fetch, also pre-caches each marina individually under `cache_marina_detail_${id}` so detail pages work offline without requiring a prior detail page visit (v4.4). Functions: `getCachedGasPrices`, `getCachedDieselPrices`, `getCachedGasPricesByDistance`, `getCachedDieselPricesByDistance`, `getCachedClosedMarinas`, `getCachedMarinaDetail` — all marina-list functions accept optional `latitude`/`longitude` for 75-mile cache filtering (v4.3). NOT wrapped: `getMapMarinas` (no offline map support), `reportPrice` (POST requires connectivity). |
| `contexts/NetworkContext.tsx` | React context providing `isOffline`, `cacheTimestamp`, `setOfflineFromCache(timestamp)`, `markOnline()`. Dual-layer detection: passive NetInfo listener catches airplane mode/Wi-Fi disconnect; active detection via failed API requests calling `setOfflineFromCache()`. Auto-clears offline state when NetInfo detects connectivity restored. |
| `components/OfflineBanner.tsx` | Animated red banner (`#FF0000` background (v4.4, previously `Brand.red` #E33500), white bold text, 36px height (v4.5, reduced from 50px)). Slides in/out via `Animated.timing` (0↔36px, 300ms). Displays "OFFLINE MODE • Data from Xm ago" with 60-second refresh interval on the time-ago text. Consumes `useNetwork()` context. Placed as first child inside each screen's SafeAreaView. |
| `components/PriceDisclaimerFooter.tsx` | Fixed red disclaimer footer bar (`Brand.red` #E33500 background, white text). Entire bar is a single `TouchableOpacity` with centered underlined text: "Tap here for details on how prices are captured." (v4.11). Tapping opens a Modal dialog with `maxHeight: '34%'` and `ScrollView` (v4.13) — only bold title paragraphs visible initially, user scrolls to read body text and reach "I understand" button. Three-paragraph bold title in `Brand.blue` ("All prices include tax. / Volume discounts... / Prices are updated regularly but not in realtime...") and a body paragraph about informational use and liability (v4.12). "I understand" button (`Brand.red` #E33500) permanently dismisses the footer via shared `DisclaimerContext` (v4.12). Placed outside FlatList as a fixed element between FlatList and SafeAreaView closing tag on Price and Nearby tabs (v4.9). |
| `contexts/DisclaimerContext.tsx` | React context providing shared disclaimer dismissed state across Price and Nearby tabs (v4.12). `dismissed` (boolean or null for loading), `dismiss()` sets state and persists to AsyncStorage (`price_disclaimer_dismissed` key). Wrapped at root layout level in `_layout.tsx`. Consumed via `useDisclaimer()` hook in `PriceDisclaimerFooter`. Replaces independent local state that caused the footer to persist on one tab after being dismissed on another. |


**Anonymous device identification (v4.37):**

| File | Purpose |
|------|---------|
| `services/deviceId.ts` | Generates and persists a random anonymous UUID (v4 format) on first app launch via AsyncStorage (`@fuel_docks_device_id` key). Exported `getDeviceId()` returns the stored ID on subsequent calls. No device permissions required. Used by the axios interceptor in `api.ts` (for `X-Device-Id` header) and by `versionPing()` (for the `device_id` POST body field). |

**Location-aware caching (v4.3):**

New files added for 75-mile cache radius and shared location state:

| File | Purpose |
|------|---------|
| `utils/geo.ts` | Haversine distance calculation between two lat/lng coordinate pairs, returning distance in miles. Pure function used by `cachedApi.ts` to filter marinas before caching. |
| `contexts/LocationContext.tsx` | React context providing shared GPS state: `location` (coordinates or null), `locationPermission` (`'undetermined'` / `'granted'` / `'denied'`), `isLoadingLocation` (boolean). Requests `expo-location` foreground permission once on mount. Permission prompt string (v4.17): "Fuel Docks uses your location to sort marinas by distance. Your coordinates are not stored." (configured in `app.json` via `NSLocationWhenInUseUsageDescription` and `locationWhenInUsePermission`). Replaces duplicate location code that was previously in `nearby.tsx` and `map.tsx`. Consumed via `useLocation()` hook in Price, Nearby, Closed, and Map tabs. |

**Architecture:** "No limit online, 75-mile cache only." When connected, the app displays ALL marinas returned by the API (no server-side filtering). Before writing to AsyncStorage, the `withCache<T>()` function applies an optional `cacheFilter` that removes marinas beyond 75 miles of the user's GPS position. When offline, only the cached nearby subset is available. If location is unavailable (permission denied or not yet resolved), the full dataset is cached (same as v4.2 behavior). Individual marina details (`getCachedMarinaDetail`) are always cached regardless of distance.

**TypeScript type system (`types/marina.ts`):**
- `Marina` interface with 22 fields matching Xano API response (20 standard H1 fields + `youtube` + `last_updated_relative`)
- Optional `distance_mi` field (present only in distance endpoint responses)
- `FuelType` union type: `'gas' | 'diesel'`

**Theme system (`constants/theme.ts`):**
- `Brand` object: `blue`, `red`, `green`, `white`
- `FontFamily` object: `regular`, `bold`, `title`
- `Colors` object with light/dark mode variants

**Completed features (React Native app):**

- **Marina detail screen** (`app/marina/[id].tsx`): Fetches marina data from `marina_detail` endpoint by ID. Displays fuel dock name (22px bold), city (17px grey, `marginTop: 1`), gas/diesel price cards (30px bold prices, optional comment text e.g. "ETHANOL FREE" in regular-weight #E33500), "Last updated" row with inline "Report Change" outlined button (v4.13, previously full-width "Report Price Change" in actions), info table (Hours, Cash/Card, Volume Discount, Coordinates with inline copy icon), side-by-side Map and Export GPX buttons (dark navy `#070531`, v4.13) with one-time GPX export tooltip (v4.15), Call/Visit Website buttons, YouTube video thumbnail. Map button navigates to in-app `marina/map` screen (v4.16, previously opened native maps app via `Linking.openURL`). Section spacing: `paddingTop: 9` below hairline, `actions marginTop: 10`.
- **Coordinate copy:** Tapping the clipboard icon (positioned inline immediately after the longitude digits, v4.13 — previously right-justified) copies `latitude, longitude` to device clipboard via `expo-clipboard`. Icon changes to green checkmark for 2 seconds after copy.
- **GPX export:** "Export GPX" button (dark navy `#070531` background with white text and share icon, v4.5). Now displayed side-by-side with Map button below the info table (v4.13, previously standalone in top coordinates section). Creates a GPX XML waypoint file with the marina's coordinates, name, and city. Uses `expo-file-system/legacy` (required for Expo SDK 54) for file writing and `expo-sharing` for the native share sheet. Includes `escapeXml()` function to safely encode `&`, `<`, `>`, `"`, `'` in marina names. Wrapped in try/catch with user-friendly error alert.
- **YouTube video thumbnail** (v4.5, replaced red YouTube button): Conditionally rendered 16:9 video thumbnail image extracted from the YouTube URL using `getYouTubeVideoId()` helper (regex extracts 11-character video ID from `v=` or `youtu.be/` patterns). Displays `https://img.youtube.com/vi/{videoId}/hqdefault.jpg` with a semi-transparent dark overlay and centered white play circle icon (Ionicons `play-circle`, 56px). Tapping opens the YouTube URL via `Linking.openURL()`. Positioned above the Report Price Change button. Only appears when `marina.youtube` is truthy.
- **Report Price Change:** Small outlined "Report Change" button (13px bold `Brand.blue` text, 1.5px border, `borderRadius: 6`, `paddingVertical: 4`, `paddingHorizontal: 10`) positioned inline on the "Last updated" row via `justifyContent: 'space-between'` (v4.13, previously full-width "Report Price Change" button in actions section). Links to `report-price/[id]` screen with form for gas/diesel price and comments, submitting to Xano `report_price` endpoint. Client-side validation checks price range ($2–$15) before submission. Server-side error messages from Xano are surfaced to the user instead of a generic failure message (v4.1.1). When offline, shows "Offline" text with greyed-out styling.
- **One-time pricing modal:** Removed (v4.12). Previously displayed on first app launch with "Got it" button and `hasSeenPricingNote` AsyncStorage key. Disclaimer content is now accessible only via the PriceDisclaimerFooter tap-to-open modal on Price and Nearby tabs.
- **About page pricing box:** Pricing disclaimer in a `#E33500` red box with white bold 18px centered text: "All prices include tax. Volume discounts are not reflected and may lower your final cost." (v4.12, third sentence about calling the fuel dock moved to the disclaimer section below). Always visible (not gated by first-launch logic). `marginTop: 32` for spacing below Privacy Policy/TOS links (v4.12).
- **Welcome splash screen:** Custom `WelcomeScreen` component shown on app load before main navigation. Displays app icon, "FUEL DOCKS" title (40px `FontFamily.title`), tagline "Compare marina fuel prices" (v4.20, previously "Marina fuel prices at your fingertips"), version without build number in `Brand.red` (v4.20, build number removed), Navigator logo, and copyright. Version positioned under tagline in top section (v4.11, previously in bottom section next to copyright)
- **Gas/Diesel price tabs** (`app/(tabs)/index.tsx`): Default landing screen showing all marinas sorted by price (low to high). Header reads "Fuel Docks sorted by price". `FuelTypeToggle` component at top switches between `getGasPrices()` and `getDieselPrices()` API calls. FlatList with `MarinaListItem` rows showing marina name, city, price (right-aligned), and `last_updated_relative` in red. Pull-to-refresh triggers re-fetch. Loading spinner, error state with retry button, empty state handled. Tapping a row navigates to `marina/[id]` detail screen via Expo Router.
- **Nearby tab** (`app/(tabs)/nearby.tsx`): **New feature not present in the Adalo app.** Location-based marina sorting that uses the two distance API endpoints (`gas_prices_by_distance`, `diesel_prices_by_distance`) which were built in the Xano backend but never consumed by Adalo. **Two-phase loading flow:** (1) On mount, requests foreground location permission via `expo-location` `requestForegroundPermissionsAsync()`. If denied, displays a persistent error message: "Location permission is required to find nearby marinas. Please enable it in Settings." with no retry button (user must grant permission in OS settings). If granted, calls `getCurrentPositionAsync()` to get device GPS coordinates. During this phase, the loading spinner shows with "Getting your location..." subtext. (2) Once coordinates are obtained, calls the appropriate distance endpoint with `latitude` and `longitude` parameters. The Xano endpoint returns marinas sorted by distance with a computed `distance_mi` field. **Gas/Diesel toggle:** Same `FuelTypeToggle` component as the Price tab. Switching fuel type re-fetches from the corresponding distance endpoint using the same cached coordinates (location is fetched once and stored in state). **Distance display:** `MarinaListItem` component conditionally renders `distance_mi` (e.g., "4.2 miles") in red text below the price when the field is present — this only appears on the Nearby tab since the price-sorted endpoints don't return `distance_mi`. **Reactive data fetching:** `useEffect` depends on `[fuelType, location, fetchData]` so any change to fuel type or location triggers a new API call. **Error handling:** Network errors show "Failed to load nearby marinas" with a retry button (retry only appears if location was successfully obtained). **Pull-to-refresh:** Re-fetches distance data with the same coordinates. Header reads "Fuel Docks sorted by distance".
- **Shared components:** `FuelTypeToggle` (two-button segmented control with red `#E33500` active state, `#f0f0f0` background, used by Price and Nearby tabs) and `MarinaListItem` (marina row with left section for name/city/updated-date, right section for price or closed status, conditional distance display, tap navigation to detail screen via `router.push`). Both components accept `fuelType` prop to display the correct price column. `MarinaListItem` handles three display states: open marina (shows formatted price), closed marina (shows closure reason in red bold text, max width 140), and sentinel value 9999 (shows "N/A" for gas-only marinas on diesel view or vice versa).
- **Location-aware 75-mile cache radius** (v4.3): When connected, the app displays ALL marinas from the API (no server-side filtering). Before writing API responses to the offline cache, the app filters to only marinas within 75 miles of the user's GPS position using a haversine distance calculation. This ensures offline data is relevant and storage-efficient when the app goes nationwide. Shared `LocationContext` centralizes GPS permission and coordinate state, replacing duplicate `expo-location` code in `nearby.tsx` and `map.tsx`. Graceful fallback: if location is unavailable, the full dataset is cached.
- **Marina detail pre-caching from list responses** (v4.4): All five marina-list API wrappers now pre-cache each marina individually under `cache_marina_detail_${id}` after a fresh API fetch. Previously, marina detail pages were only cached if the user explicitly visited that detail page while online — browsing a list and going offline meant detail pages would fail with "No cached data available." Now, any marina visible in any list (Price, Nearby, Closed) automatically has its detail page available offline. Implementation: `preCacheIndividualMarinas()` helper iterates over the list and calls `setCache()` for each marina; `withCacheAndPreCacheDetails()` wrapper calls this fire-and-forget after `withCache()` succeeds. `getCachedMarinaDetail` is unchanged — it still tries the API first and falls back to cache, which is now populated from list pre-caching.
- **Map tab offline behavior** (v4.4): Map tab icon and label grey out when offline (icon color `#ccc`, label grey, opacity 0.4). Taps are suppressed by replacing `HapticTab` with a `Pressable` whose `onPress` is `undefined`. The Map screen itself shows "Map does not work when your device is not connected to the internet." when `isOffline` is true, checked before the loading state. Uses `useNetwork()` from `NetworkContext`.
- **UI refinements** (v4.4): About screen pricing disclaimer box text centered (`textAlign: 'center'`) with increased padding (16px → 24px). Offline banner background color changed from `Brand.red` (#E33500) to `#FF0000` (pure red) for higher visibility.
- **API retry logic** (v4.5): Added `fetchWithRetry()` function to `cachedApi.ts` that retries transient API failures up to 2 times with a 1-second delay between attempts before falling back to cache. Root cause: a tester encountered an error on the Diesel tab that resolved on retry — a race condition where the first API call failed transiently (e.g., server cold start, brief network hiccup) and no cache existed yet. The retry wrapper sits between `withCache()` and the actual API call, so all cached endpoints benefit automatically.
- **Offline banner height reduction** (v4.5): OfflineBanner animated height reduced from 50px to 36px to make the banner less visually dominant while still clearly visible.
- **Export GPX button color** (v4.5): Changed from `#E33500` (red) to `#070531` (dark navy/Brand.blue) for better visual consistency with the app's primary brand color.
- **YouTube video thumbnail** (v4.5): Replaced the red YouTube button (`#FF0000` background with `logo-youtube` icon) with a 16:9 video thumbnail image (`img.youtube.com/vi/{videoId}/hqdefault.jpg`) overlaid with a semi-transparent dark backdrop and centered play circle icon. More visually engaging and provides a preview of the video content.
- **About page styling** (v4.5): App name `fontSize` increased from 28 to 32. Tagline `fontFamily` changed from regular to bold. Pricing disclaimer `fontSize` increased from 15 to 18 with `lineHeight` 24. Privacy Policy link gains `marginTop: 12` for breathing room.
- **Terms of Service screen** (v4.10): New `app/terms-of-service.tsx` screen with static TOS text. Includes a safety warning box (yellow `#FFF8E1` background, dark goldenrod `#8B6914` bold uppercase text) warning against using the app while operating watercraft or vehicles. Linked from the About screen below the Privacy Policy link. Stack screen with header title "Terms of Service".
- **About page icon and links** (v4.10): App icon enlarged from 100x100 to 140x140. Terms of Service link added below Privacy Policy link with matching underlined style.
- **Android SafeAreaView fix** (v4.10): Privacy Policy and Terms of Service screens use `SafeAreaView edges={['bottom', 'left', 'right']}` instead of the default `edges` (all four sides). On Android, the default `SafeAreaView` added extra top padding below the Stack navigator header, creating a visible gap between the header and content. Excluding the `'top'` edge eliminates this because the Stack header already handles top safe area insets.
- **Map pin interaction — platform-specific** (v4.12, updated v4.14, applied to detail map v4.16): **iOS:** Tapping a pin shows a native `Callout` bubble (`tooltip={false}`) with marina name (14px bold), gas/diesel prices (13px) or "Closed" status, and "Tap for details" link (11px `Brand.blue`). Tapping the Callout navigates to marina detail via `router.push`. Callout container width 220px with 8px padding. **Android:** Tapping a pin shows a custom absolutely-positioned info card overlay at the bottom of the map (`position: 'absolute', bottom: 24, left: 16, right: 16`). Card displays marina name (16px bold), city, gas/diesel prices or "Closed" status, and "Tap for details" link. White background with `borderRadius: 12`, padding, and elevation shadow. Tapping the card navigates to marina detail. Tapping the map background dismisses the card (`MapView onPress`). **Why platform-specific:** Android Google Maps renders custom Callout content as static bitmaps, causing text clipping. iOS renders Callouts natively without this issue. `Platform.OS` checks gate both the `Marker onPress` handler (Android only) and the `Callout` child component (iOS only). **Both map screens** (`app/(tabs)/map.tsx` and `app/marina/map.tsx`) use this same platform-specific pattern (v4.16).
- **Map pin colors updated** (v4.24): Pin colors changed from `Brand.blue` (#070531) / `#999` (grey) to `#47D45A` (green) for open marinas and `#D65A5D` (red) for closed marinas. Applied to both `app/(tabs)/map.tsx` and `app/marina/map.tsx`. Green/red provides immediate visual distinction between open and closed marinas at a glance.
- **WelcomeScreen positioning** (v4.10): Welcome splash screen layout adjusted so the app icon sits higher and the Navigator logo/copyright footer sits lower, matching the iOS layout. Previously the content was vertically centered differently on Android.
- **Tagline update** (v4.11, updated v4.20): App tagline changed to "Compare marina fuel prices" across the WelcomeScreen splash and About screen (v4.20, previously "Marina fuel prices at your fingertips", originally "Boat fuel prices for the Puget Sound").
- **Disclaimer text update** (v4.11, refined v4.12): Pricing disclaimer title: "All prices include tax. Volume discounts are not reflected and may lower your final cost. Prices are updated regularly but not in realtime, so call the fuel dock to confirm before you go." Applied to PriceDisclaimerFooter modal (three bold paragraphs) and About screen disclaimer section title. About screen orange pricing box contains only the first two sentences (v4.12). One-time pricing modal in `_layout.tsx` removed (v4.12). Disclaimer body text updated (v4.12): "regularly" → "often", "is not responsible" → "cannot be held responsible" in both PriceDisclaimerFooter modal and About screen disclaimer section.
- **Build number display** (v4.11, removed v4.20): Version display previously included build number in parentheses, e.g., "Version 2.0.0 (310)". Build number removed from display in v4.20 — now shows only "Version 2.0.0". `Platform` import and `buildNumber` variable removed from both `WelcomeScreen` and `about.tsx`.
- **About screen title styling** (v4.11): App name changed from "Fuel Docks" (32px `FontFamily.bold`) to "FUEL DOCKS" (40px `FontFamily.title` with `letterSpacing: 1`), matching the WelcomeScreen splash title.
- **WelcomeScreen version repositioning** (v4.11): Version moved from the bottom section (next to copyright) to the top section under the tagline, matching the About screen layout. Styled in `Brand.red` with `fontSize: 14` and `marginTop: 8`. Build number removed from display (v4.20).
- **About screen disclaimer section** (v4.11, updated v4.12): Bordered card section below the orange pricing box (`marginTop: 0`, `marginBottom: 12`). Bold title in `Brand.blue`: "Prices are updated regularly but not in realtime, so call the fuel dock to confirm before you go." Body text: "This app is for informational purposes only. Each fuel dock reports its own prices, and we check in with them often. The date of the last update is shown for each location. If a listing hasn't been updated recently, it means we haven't been able to reach that fuel dock. Navigator PNW LLC cannot be held responsible for pricing accuracy, as prices may change before this app can acquire an update." (v4.12, "regularly" → "often", "is not responsible" → "cannot be held responsible").
- **Privacy Policy updated** (v4.17): Added "Automatic Data Deletion" subsection under Server Logs in Section 1 of the Privacy Policy. Text: "Because we do not maintain user accounts or persistent identifiers, we do not retain personal information beyond the automatic server log retention periods described above. Deletion of personal information occurs automatically through these retention cycles. No manual deletion request is necessary, as there is no persistent data to delete." Last Updated date changed from March 11, 2026 to March 16, 2026. Updated in both `app/privacy-policy.tsx` (in-app) and the standalone Word document (`Fuel_Docks_privacy_policy_16MAR2026.docx`). Motivated by CCPA-readiness analysis: documents that the app's architecture satisfies data deletion requirements by default through automatic log retention cycles.
- **Location permission prompt updated** (v4.17): iOS and Android location permission strings in `app.json` changed from "Fuel Docks uses your location to find nearby marinas and fuel prices." to "Fuel Docks uses your location to sort marinas by distance. Your coordinates are not stored." Updated in both `NSLocationWhenInUseUsageDescription` (iOS `infoPlist`) and `locationWhenInUsePermission` (expo-location plugin). More specific about the purpose (sort by distance) and explicitly states coordinates are not stored, which Apple prefers for App Store review and doubles as a privacy disclosure at the OS permission prompt level.
- **About screen layout reorder** (v4.12): Privacy Policy and Terms of Service links moved above the orange pricing box (previously below it). Spacing: `pricingBox marginTop: 32` (equal to gap between version and Privacy Policy link), `disclaimerSection marginTop: 0` (tight spacing between orange box and disclaimer card).
- **Footer bar redesign** (v4.11, color updated v4.24): `PriceDisclaimerFooter` redesigned from a two-part layout (truncated text on left + separate "Tap here" link on right) to a single centered underlined text: "Tap here for details on how prices are captured." Entire bar wrapped in `TouchableOpacity` (previously `View` with nested `TouchableOpacity`). "I understand" button color changed from `Brand.blue` to `Brand.red` (#E33500), then to `#EA3539` (v4.24). Footer banner background also changed from `Brand.red` (#E33500) to `#EA3539` (v4.24) to visually match the closed-marina pin color on iOS map rendering.
- **Shared disclaimer context** (v4.12): New `contexts/DisclaimerContext.tsx` provides shared dismissed state via React Context so that dismissing the PriceDisclaimerFooter on either the Price or Nearby tab dismisses it on both. Previously each `PriceDisclaimerFooter` instance maintained independent local state — dismissing on one tab left it visible on the other. `DisclaimerProvider` wraps the app at root layout level, reads from AsyncStorage on mount, and persists dismissal. The footer component now uses `useDisclaimer()` instead of local `useState`/`AsyncStorage`.
- **PriceDisclaimerFooter modal body text restored** (v4.12): The modal dialog now displays a three-paragraph bold title ("All prices include tax. / Volume discounts are not reflected and may lower your final cost. / Prices are updated regularly but not in realtime, so call the fuel dock to confirm before you go.") followed by a body paragraph with the same text as the About screen disclaimer section. Body text updated: "often" replaces "regularly", "cannot be held responsible" replaces "is not responsible".
- **Disclaimer modal scrollable** (v4.13): PriceDisclaimerFooter modal dialog content wrapped in a `ScrollView` with `maxHeight: '34%'` on the dialog container. Only the bold title paragraphs are visible on initial open; the user must scroll down to read the body text and reach the "I understand" button. This ensures users see the key pricing facts before dismissing.
- **Marina detail layout redesign** (v4.13): Coordinates section moved from the top of the page into the info table as the last row (after Volume Discount), with the copy icon positioned inline immediately after the longitude digits (`marginLeft: 4`). Map and Export GPX buttons moved from the top coordinates section to side-by-side buttons below the info table (`flexDirection: 'row'`, `gap: 12`, each `flex: 1`). The Map button navigates to a dedicated map view for that marina. "Report Price Change" full-width button removed from the actions section and replaced with a compact "Report Change" outlined button (13px, `borderRadius: 6`) positioned inline on the "Last updated" row.
- **Marina detail spacing refinements** (v4.13): City text `marginTop: 1` (tighter to marina name). Info section `paddingTop: 9` below hairline (reduced from 14). Actions section `marginTop: 10` (reduced from 16). Coordinates-to-buttons gap reduced accordingly.
- **Platform-specific map callouts** (v4.14): iOS uses native `Callout` component (renders correctly on Apple Maps); Android uses custom info card overlay (avoids Google Maps bitmap rendering bug). `Platform.OS` check gates `Marker onPress` (Android only sets `selectedMarina` state) and `Callout` child (iOS only). `Callout` import restored from `react-native-maps`.
- **Report screen renamed** (v4.14): Header title changed from "Report Price Change" to "Report Change" in `_layout.tsx` Stack screen options. Matches the compact "Report Change" button text on the marina detail screen (v4.13).
- **Report screen notice text updated** (v4.14): Maroon notice box on `report-price/[id].tsx` reworded from "Prices shown in this app are for the first gallon before volume discounts, with applicable taxes added..." to "PLEASE NOTE: All prices include tax. If the fuel dock has signage that shows a pre-tax price, it may explain why it does not match the app." followed by "The prices shown in this app do not have volume discounts applied."
- **In-app detail map screen** (v4.16, pin colors updated v4.24): New `app/marina/map.tsx` screen showing a single fuel dock pin on a native `react-native-maps` MapView. Launched from the marina detail screen's "Map" button, which previously opened the device's native maps app (Apple Maps / Google Maps) via `Linking.openURL`. The new screen receives marina data (id, fuel_dock, latitude, longitude, gas_price, diesel_price, open, City) via Expo Router route params — no API call needed. Uses the same platform-specific pin interaction as the bottom nav map (`app/(tabs)/map.tsx`): **iOS** shows a native `Callout` bubble with marina name, prices, and "Tap for details"; **Android** shows a custom info card overlay at the bottom of the map. Tapping the callout/card navigates to the marina detail screen. Map is centered on the marina coordinates with `latitudeDelta: 0.05` / `longitudeDelta: 0.05` zoom level. `showsUserLocation` enabled. Open marinas use `#47D45A` (green) pin color; closed marinas use `#D65A5D` (red) (v4.24, previously `Brand.blue`/`#999`). Stack screen registered in `app/_layout.tsx` with header title "Map" and `headerBackTitle: 'Back'`. `Platform` import removed from `app/marina/[id].tsx` (no longer needed after removing `Linking.openURL` map logic). **No Xano backend changes.**
- **One-time GPX export tooltip** (v4.15, updated v4.21): Orange speech bubble tooltip (`#D84315` background, 21px bold white text) appears above the Export GPX button the first time a user visits any Fuel Dock Details screen. Text reads "Use this button to export to your Boat Navigation app" with a "TAP HERE TO REMOVE" dismissal hint below (13px bold `#FFAB91` light orange, underlined, v4.21). Downward-pointing triangular notch (15px CSS triangle) points at the Export GPX button. Tapping anywhere on the tooltip dismisses it permanently via AsyncStorage (`gpxTipShown` key). Uses absolute positioning with negative offsets (`left: -180`, `right: 14`) to extend the bubble across the full width of the button row. `borderRadius: 10`, `paddingVertical: 12`, `paddingHorizontal: 16`. The tooltip only renders after marina data has loaded (gated by `[marina]` useEffect dependency). **No Xano backend changes.**
- **Tab screen SafeAreaView bottom inset fix** (v4.23): All `SafeAreaView` instances in the Price, Nearby, and Closed tab screens (main, loading, and error states — 9 total) updated to use `edges={['top', 'left', 'right']}`, excluding the bottom edge. The tab bar already handles the bottom safe area inset; without this fix, `SafeAreaView` added a redundant ~34px bottom padding on iPhones with the home indicator, creating a visible blank bar between the list content and the tab bar. Same principle as the v4.10 Android SafeAreaView fix for Privacy Policy and Terms of Service screens, but opposite edge: v4.10 excluded `'top'` because the Stack header handles it; v4.23 excludes `'bottom'` because the tab bar handles it.
- **Tab bar padding** (v4.11): Added `paddingTop: 2` to tab bar style in `app/(tabs)/_layout.tsx` for 2px spacing between the divider line and tab icons.
- **Tab reorder and Nearby as default screen** (v4.27): Tab order changed from Gas, Diesel, Nearby, Closed, Map, About to Map, Price, Nearby, Closed, About. The Nearby screen is now the default landing tab (`index.tsx` in expo-router). Tab label font size increased to 13px.
- **Per-tab active icon colors** (v4.27): Each tab has a unique color when selected; inactive tabs remain theme-default gray (`tabIconDefault`). Colors defined in `TAB_COLORS` constant: Map `#30B0C7` (cyan), Price `#47D45A` (green), Nearby `#007AFF` (blue), Closed `#FF3B30` (red), About `#E33500` (Navigator red). Implementation uses `focused` prop in `tabBarIcon` and per-screen `tabBarActiveTintColor` so both the icon and label text match the active color.
- **Closed tab icon changed to calendar** (v4.30): Closed tab icon changed from `xmark.circle.fill` / MaterialIcons `cancel` (X-in-circle) to MaterialIcons `event-busy` (calendar with X). The previous icon looked like a "close app" button, causing user confusion. The new calendar-with-X icon clearly conveys "seasonal / date-based closures." The Closed tab imports `MaterialIcons` directly from `@expo/vector-icons/MaterialIcons` instead of using the `IconSymbol` abstraction, because the corresponding SF Symbol (`calendar.badge.xmark`) is not available in the `sf-symbols-typescript` type definitions bundled with the project's version of expo-symbols. A mapping entry (`'calendar.badge.xmark': 'event-busy'`) was also added to `icon-symbol.tsx` for potential future web/Android use via `IconSymbol`. Same `#FF3B30` red color scheme.
- **Price disclaimer footer** (v4.9, redesigned v4.11, updated v4.12, color updated v4.24): Fixed red banner (`#EA3539`, v4.24 — previously `Brand.red` #E33500) at the bottom of the Price and Nearby tabs, above the tab bar. Entire bar is a single `TouchableOpacity` with centered underlined white text: "Tap here for details on how prices are captured." (v4.11). Tapping opens a centered modal dialog with a three-paragraph bold title in `Brand.blue`: "All prices include tax. / Volume discounts are not reflected and may lower your final cost. / Prices are updated regularly but not in realtime, so call the fuel dock to confirm before you go." Below that, a body paragraph: "This app is for informational purposes only. Each fuel dock reports its own prices, and we check in with them often. The date of the last update is shown for each location. If a listing hasn't been updated recently, it means we haven't been able to reach that fuel dock. Navigator PNW LLC cannot be held responsible for pricing accuracy, as prices may change before this app can acquire an update." (v4.12, body text restored to modal, wording refined). An "I understand" button (`#EA3539`, v4.24 — previously `Brand.red` #E33500) permanently dismisses the footer via shared `DisclaimerContext` (v4.12, previously independent local state — dismissing on one tab now dismisses on both). The footer never appears again after dismissal. **Key architectural decision:** The component is placed outside the FlatList as a sibling element between `<FlatList />` and `</SafeAreaView>`, not as `ListFooterComponent`. Using `ListFooterComponent` placed the footer at the very bottom of the scrollable content (hidden behind the tab bar with many list items), while placing it outside FlatList makes it a fixed bar always visible above the tab bar.
- **Offline mode with local data cache** (v4.2): "Network-first with cache fallback" architecture. Every API call tries the network first; on success, the response is cached to AsyncStorage; on failure, the app loads from cache and shows a persistent red banner ("OFFLINE MODE • Data from Xm ago"). When connectivity is restored, all visible screens auto-refresh via a `useRef`/`useEffect` pattern tracking the `isOffline` state transition from true→false. **Dual-layer offline detection:** passive via `@react-native-community/netinfo` event listener (catches airplane mode, Wi-Fi disconnect), active via failed API requests (handles captive portals, API outages). **Cache keys:** `cache_gas_prices`, `cache_diesel_prices`, `cache_gas_prices_distance`, `cache_diesel_prices_distance`, `cache_closed_marinas`, `cache_marina_detail_${id}` (one per marina). **No TTL/expiration** — always prefers fresh data when online, shows whatever cached data exists when offline. **Screens affected:** Price tab, Nearby tab, Closed tab, Marina detail, Report Price (6 files modified). **NOT offline-enabled:** Map tab (react-native-maps requires connectivity for tile rendering; tab greyed out and disabled when offline, v4.4). **Report Price when offline:** Submit button disabled with text "You must be online to submit". **Marina detail when offline:** "Report Change" button greyed out with text "Offline" (v4.13, previously full-width "Report Price (Offline)"). **First launch offline:** No cache exists, screens show "No cached data available. Connect to the internet to load marina prices."

**Completed (Xano backend changes for React Native app):**
- `youtube` text column added to FuelPrices table (nullable, public access). Description: "YouTube video URL for this marina. Displayed as a button on the detail screen when populated."
- `marina_detail` endpoint (#46) field whitelist updated to include `youtube` (21 fields total). This endpoint is now actively called by the React Native app (previously created but unused by Adalo).
- `gas_comment` and `diesel_comment` text columns added to FuelPrices table (nullable). `gas_comment` populated with "ETHANOL FREE" for all marinas where the former `ethanol_free` column was "Yes" (43 marinas). The `ethanol_free` column was then removed from the database. These comments are displayed below the corresponding fuel price on the detail screen in bold `#E33500` text. (v4.1)
- `marina_detail` endpoint (#46) field whitelist updated: removed `ethanol_free`, added `gas_comment` and `diesel_comment` (22 fields total, up from 21). All other consumer endpoints updated similarly (21 standard fields, up from 20). (v4.1)

**Key implementation notes:**
- **expo-file-system/legacy:** Expo SDK 54 deprecated the `writeAsStringAsync`, `cacheDirectory`, and `EncodingType` exports from `expo-file-system`. The new API uses `File` and `Directory` classes from `expo-file-system/next`. The React Native app uses `import * as FileSystem from 'expo-file-system/legacy'` for backward compatibility.
- **Xano API compatibility:** The React Native app consumes the exact same Xano API endpoints as the Adalo app. No backend changes were required for the migration except adding the `youtube` field to the `marina_detail` whitelist. The `marina_detail` endpoint, previously unused by Adalo, is now the primary data source for the detail screen.
- **Development environment:** The app is developed using Claude Code (Anthropic's AI-powered CLI) with direct Xano MCP server integration. This allows database schema changes, API endpoint updates, and code generation to happen in a single conversation context.
- **Location-aware cache filtering (v4.3):** The 75-mile cache radius is implemented entirely client-side — no Xano endpoint changes were needed. The `withCache<T>()` function in `cachedApi.ts` accepts an optional `cacheFilter` callback. For marina-list endpoints, a `marinaCacheFilter()` builder creates a filter that uses `haversineDistanceMiles()` from `utils/geo.ts` to remove distant marinas before `setCache()`. The full unfiltered data is still returned to the calling screen, so online users see everything. The `LocationContext` wraps inside `NetworkProvider` at the root layout level and provides coordinates via `useLocation()` hook.
- **Offline cache architecture (v4.2):** The cache layer (`services/cachedApi.ts`) wraps every read-only API function from `services/api.ts` without modifying the original service. Each wrapper calls the API function inside a generic `withCache<T>()` that handles caching on success and cache fallback on failure. This means `api.ts` remains unchanged and could be used directly if offline support is not needed. The `NetworkContext` wraps the entire app at the root layout level and provides offline state to all screens via `useNetwork()` hook.
- **Auto-refresh on reconnect pattern (v4.2):** Each screen that consumes cached data implements the same pattern: a `useRef` stores the previous `isOffline` value, and a `useEffect` watching `isOffline` triggers a data refresh when transitioning from offline (true) to online (false). This ensures screens automatically show fresh data when connectivity is restored without requiring the user to manually pull-to-refresh.
- **Marina detail pre-caching architecture (v4.4):** The v4.2 offline cache stored marina lists as complete arrays (e.g., all gas prices under `cache_gas_prices`) and individual marina details under separate `cache_marina_detail_{id}` keys. However, individual detail keys were only populated when the user explicitly visited a detail page while online. This meant tapping a marina from a cached list while offline would fail — the list cache existed, but the individual detail cache did not. The v4.4 fix adds a `preCacheIndividualMarinas()` function that extracts each marina from a list response and stores it individually. A new `withCacheAndPreCacheDetails()` wrapper calls this fire-and-forget (`.catch(() => {})`) after a successful network fetch, so pre-caching never blocks or delays the list response. The existing `getCachedMarinaDetail()` function is unchanged — it naturally finds the pre-cached data on fallback.
- **API retry for transient failures (v4.5):** The `fetchWithRetry()` function wraps every API call made through `withCache()`, retrying up to `MAX_RETRIES` (2) times with `RETRY_DELAY_MS` (1000ms) delay between attempts. This addresses first-launch scenarios where no cache exists and a single transient API failure (server cold start, brief network blip) would surface an error to the user. The retry is transparent to calling code — `withCache()` calls `fetchWithRetry(fetcher)` instead of `fetcher()` directly. If all retries fail, the normal cache fallback path activates.
- **Price disclaimer footer placement (v4.9) and shared context (v4.12):** The `PriceDisclaimerFooter` component must be placed *outside* the FlatList as a sibling element, not as `ListFooterComponent`. FlatList's `ListFooterComponent` renders at the very end of the scrollable content — with many list items, it scrolls off-screen and can be hidden behind the tab bar. Placing the component between `<FlatList />` and `</SafeAreaView>` makes it a fixed bar that always appears above the tab bar regardless of list length. **Shared dismiss state (v4.12):** The component uses `useDisclaimer()` from `DisclaimerContext` instead of local `useState`/`AsyncStorage`. This ensures dismissing the footer on the Price tab also dismisses it on the Nearby tab (and vice versa). Previously each instance maintained independent state — a bug where dismissing on one tab left the footer visible on the other. The `DisclaimerProvider` wraps the app at root layout level and handles AsyncStorage reads/writes centrally with `.catch(() => {})` error handlers to prevent silent crashes.
- **No backend changes for offline mode (v4.2):** The offline cache is entirely a client-side feature. No Xano endpoints, database schema, or API responses were modified. The cache stores the exact API response payloads and replays them when offline.

---

### Step 13: FD Dialer Push Notification Badge -- COMPLETE (v4.6)

**Purpose:** Update the FD Dialer app's home screen badge count in the background without requiring the user to open the app. Previously, the badge only updated when the app was opened (triggered by `useFocusEffect` calling `fetchQueue()` which calls `setBadgeCountAsync()`). With this feature, Xano sends a silent push notification every 15 minutes containing the current count of marinas due for a call, and iOS updates the badge automatically.

**Completed (Xano backend):**
- `dialer_push_tokens` table (ID 36) created with `id` (auto), `created_at` (auto), and `expo_push_token` (text) fields. Unique index on `expo_push_token` to prevent duplicate registrations. Simple flat table with no user association — the call queue is shared across all users, so token is stored per device.
- `register_push_token` endpoint (POST #51) created in the Fuel Docks API group. Accepts `api_token` and `expo_push_token`. Validates `api_token` against `DIALER_API_TOKEN` environment variable (same pattern as other FD Dialer endpoints). Upserts the push token — inserts if not exists, ignores if duplicate (leverages unique index).
- `push_badge_update` Background Task (#7) created, running every 15 minutes (`freq: 900`). Calls the existing `call_queue` endpoint internally to get the count of due marinas. Queries all tokens from `dialer_push_tokens`. POSTs to `https://exp.host/--/api/v2/push/send` with silent push payload: `badge` set to the due marina count, `sound: null`, `_contentAvailable: true` (triggers iOS background processing without a visible notification banner). Handles expired/invalid tokens by checking the Expo Push API response tickets for `DeviceNotRegistered` errors and removing those tokens from the table.

**Completed (React Native FD Dialer app):**
- `expo-notifications` plugin added to `app.json` plugins array.
- Push token registration added to `app/_layout.tsx`: on app startup, requests notification permissions via `Notifications.requestPermissionsAsync()`, retrieves the Expo push token via `Notifications.getExpoPushTokenAsync()` using the EAS project ID, and sends it to Xano via the new `/register_push_token` endpoint. Token is cached in AsyncStorage under `expo_push_token` key to avoid redundant registration calls on subsequent launches — only registers with Xano when the token changes or is new.
- `registerPushToken()` function added to `services/api.ts` to POST push tokens to the Xano endpoint.
- EAS Build 17 (version 1.1.0) submitted to iOS TestFlight with push notification entitlement.

**Key design decisions:**
- Silent push only — no visible notification banner. The badge count communicates urgency without being intrusive.
- No user association on tokens — the call queue is the same for all FD Dialer users, so every registered device gets the same badge count.
- 15-minute interval balances timeliness with Expo Push API rate limits.
- Token cleanup on `DeviceNotRegistered` prevents stale tokens from accumulating in the database.
- AsyncStorage caching on the client side avoids hitting the Xano endpoint on every app launch.

---

## 15. Error Handling and Alerting

All error alerts are sent via Mailgun to ken@navigatormktg.com from alerts@mg.fueldocks.app.

### Implemented Alerts

**apify_webhook Precondition (Token validation):**
The `apify_webhook` endpoint validates the `webhook_token` field in the POST body against `$env.APIFY_WEBHOOK_TOKEN` before any processing. Requests with missing or incorrect tokens receive a 401 "Unauthorized" response immediately.

**apify_webhook Catch Block (Mailgun email):**
The `apify_webhook` endpoint wraps the Claude call, JSON parsing, and database write in a Try/Catch block. When any of these steps fail, the Catch block sends a detailed alert email via Mailgun with marina name, ID, scrape URL, error type, error message, and HTTP status. Tested with empty scraped_content (Claude returns 400, alert email sent with full error details).

**mailgun_inbound Precondition (Signature verification):**
The `mailgun_inbound` endpoint verifies the HMAC-SHA256 signature on every inbound request before any other processing. Requests with missing or invalid signatures are rejected with "Access Denied" (HTTP 403). This prevents unauthorized third parties from POSTing fabricated data to the endpoint URL.

**mailgun_inbound Precondition (Marina match validation):**
The `mailgun_inbound` endpoint queries FuelPrices by sender email (lowercased, with display name stripped via regex). If no marina matches, processing stops with "No marina found with this contact_email" error.

**mailgun_inbound Catch Block (Mailgun email):**
The `mailgun_inbound` endpoint wraps the Claude call, JSON parsing, and database write in a Try/Catch block. When any step fails, the Catch block sends an alert email with marina name, ID, sender email, subject, and error details.

**trigger_apify_scrapers Catch Blocks (Mailgun email):**
The Background Task wraps each actor trigger in an independent Try/Catch block. If either API call to Apify fails, an alert email is sent identifying which scraper failed to start. The other scraper still runs regardless.

**Apify Monitoring Alerts (6 total, Apify native):**
Each actor has 3 alerts configured in Apify's built-in monitoring, sending email to ken@navigatormktg.com:
- Run status is failed, timed out, or aborted
- Run duration exceeds threshold (HTML: 120s, JS: 180s)
- Results count less than 1 (catches runs that complete but produce no data)

**Distill Watchdog (25 monitors):**
Distill.io runs independently as a change-detection verification layer on the free plan. 5 cloud monitors check 4x/day (cron: `0 6,11,16,21 * * *`), 20 local monitors run on Ken's machine. Email-only alerts (30/month on free plan), no webhooks, no data writes.

**send_outbound_emails Consecutive Unanswered Alert (Escalating, Mailgun email):**
The `send_outbound_emails` Background Task checks `consecutive_unanswered` after each successful send. When the count reaches 2 or more:
- Subject: "Fuel Docks Alert: [count] unanswered emails - [marina name]"
- Body includes marina name, ID, contact email, consecutive count, cadence, and message: "This marina was just sent email #[count] since their last reply. Consider calling or adjusting the contact method."
- Alerts fire every cycle indefinitely (2, 3, 4, etc.) until a reply is received via `mailgun_inbound` which resets the counter to 0

**send_outbound_emails Catch Block (Mailgun email):**
The `send_outbound_emails` Background Task wraps each marina's send in a Try/Catch block. When sending fails:
- Subject: "Fuel Docks Alert: Outbound Email Failed - [marina name]"
- Body includes marina name, ID, contact email, Xano task name, error message, and error code
- Each marina fails independently so one error does not block the rest

**send_outbound_email Precondition (API token validation):**
The `send_outbound_email` endpoint validates the `api_token` input against `$env.FD_API_TOKEN` before any processing. Requests with missing or incorrect tokens receive a 403 "Unauthorized" response immediately. Same authentication pattern as `submit_call` and `call_queue`. Added per security audit C3 (February 2026).

**call_queue Precondition (API token validation):**
The `call_queue` endpoint validates the `api_token` input against `$env.FD_API_TOKEN` before any processing. Requests with missing or incorrect tokens receive a 403 "Unauthorized" response immediately. Same authentication pattern as `submit_call` and `send_outbound_email`. Added per security audit H3 (February 2026).

**apify_webhook H4 Flag Alert (Mailgun email):**
After Claude parsing, `apify_webhook` calls `validate_claude_output` to check price ranges, open field format, HTML content, and price spikes. When `$validated.has_flags` is true, a flag alert email is sent via Mailgun with subject "Fuel Docks H4 Flag: [marina name]" and body containing marina name, ID, scrape URL, and the full `$validated.flag_summary` text listing each validation issue. The validated (sanitized) data is still written to the database; the alert is informational so Ken can review. Added per security audit H4 (February 2026).

**mailgun_inbound H4 Flag Alert (Mailgun email):**
After Claude parsing, `mailgun_inbound` calls `validate_claude_output` with the same validation rules. When `$validated.has_flags` is true, a flag alert email is sent via Mailgun with subject "Fuel Docks H4 Flag: [marina name] (Email)" and body containing marina name, ID, sender email, and the full `$validated.flag_summary`. Added per security audit H4 (February 2026).

### Planned Alerts (Not Yet Implemented)

- Xano webhook receiving malformed data
- Claude Function Pack returning low confidence or unparseable results
- Hash changed but Claude finds no meaningful price/status data (possible site redesign)
- Email reply received that Claude cannot interpret
- Mailgun delivery failures
- **Staleness alert:** If last_updated for any Apify-monitored marina (Method = "HTML" or "Javascript") is older than 7 days, send an alert via Mailgun. This catches Cheerio failures on JavaScript-rendered sites (where the hash never changes because the placeholder HTML never changes) and prompts investigation to determine whether the marina should be switched to a different Method.

**Confidence flag:** When Claude is not confident in its parsing (ambiguous content, possible site redesign, conflicting information), it returns a `confidence: "low"` indicator. Xano flags these records as `needs_review` rather than silently writing potentially bad data.

---

## 16. MCP (Model Context Protocol)

MCP is not needed for the production data pipeline. The Fuel Docks scraping, email, and phone workflows are fixed and predictable, with every step predetermined. Nothing in production needs to be discovered or decided dynamically by the AI.

However, MCP is actively used for **development and debugging** across two environments:

**Claude.ai project (browser-based):**

1. **Xano MCP Server** (Read Only): Connected via Xano's Metadata API. Provides Claude with direct visibility into database records, API endpoint configurations, XanoScript code, and request history. Used for live debugging sessions (e.g., inspecting Kingston marina's scraped content and database values during the diesel price investigation). The Xano MCP connection works in claude.ai but not in Claude Desktop due to OAuth authentication requirements that Xano's MCP servers do not support. Xano support is investigating persistent 500 errors on the SSE/streaming endpoints.

2. **Apify MCP Server**: Connected via Apify's API token with tools limited to `actors, runs, datasets, key-value-stores`. Provides Claude with visibility into Actor run history, logs, and scrape results. Useful for verifying scraper execution and debugging extraction issues.

**Claude Code (CLI-based, added v4.0):**

3. **Xano MCP Server** (Read/Write via Access Token): Connected in Claude Code's MCP settings. Unlike the read-only claude.ai connection, this provides full read/write access to the Xano backend, enabling Claude Code to directly modify database schemas (e.g., adding the `youtube` column), update API endpoint configurations (e.g., adding fields to the `marina_detail` whitelist), and manage XanoScript code. Used for the React Native app development workflow where backend and frontend changes happen in a single conversation.

MCP could also become relevant for a future user-facing chatbot (e.g., "which marina near me has the cheapest diesel?") where an AI would need to query the database on the fly.

---

## 17. Services Removed or Demoted in February Architecture

| Service | Was Used For | Current Status |
|---------|-------------|----------------|
| **Distill.io** | Website monitoring via CSS selectors, webhooks to Airtable | Demoted to watchdog. Free plan, 25 monitors (5 cloud, 20 local), email alerts only, no webhooks, no data writes. |
| **Airtable** | Data storage, manual editing UI, webhook relay to Xano | Removed entirely. Subscription cancelled, webhook deleted, token removed from Xano, trash emptied. |
| **SendGrid** | Error/alert emails to Ken | Removed. API key deleted, account inert. Replaced by Mailgun. |

---

## 18. Key Design Principles

1. **Xano is the single source of truth.** All data lives in Xano. No other system stores authoritative data.

2. **Xano is the orchestrator and scheduler.** All input channels POST to Xano. Xano decides when to call Claude, when to trigger Apify, and when to send emails. Claude and Apify are tools Xano calls on demand.

3. **AI replaces brittle selectors.** An LLM understands context (closures, tax notes, status changes) that CSS selectors cannot. One universal "reader" handles all marina website formats.

4. **Hash before AI.** Content hashing minimizes Claude API calls by only invoking the LLM when something has actually changed on a page.

5. **Four input methods, one processing pipeline.** HTML scraping, Javascript scraping, email, and phone all feed the same Xano logic and Claude Function Pack. Adding a new marina means choosing the right method and adding a record to the database.

6. **Right tool for each site.** Cheerio (fast, cheap) is the default for scraping. Playwright with stealth (heavier, more capable) handles JavaScript-rendered sites and sites with bot protection. Email and Call handle sites that resist scraping entirely. The system self-sorts marinas into the right method.

7. **Build center-out.** Start with Xano (database, Function Pack, endpoints), then connect external services (Apify, Mailgun, Adalo).

8. **Parallel operation during migration.** The new February architecture is built alongside the existing January architecture. Marinas are migrated in batches with validation before cutting over.

9. **Designed for nationwide scale.** The architecture minimizes human touch so it can grow from 31 marinas to hundreds or thousands. Method selection, CSS selectors, and email cadence are all per-marina configuration in the database, not hardcoded logic.

10. **Use official integrations.** Prefer platform-supported tools (like Xano's Claude Function Pack) over custom workarounds (like manual External API Requests). Official integrations handle authentication, versioning, and edge cases.

11. **Authenticate all webhooks and state-changing endpoints.** External services posting to Xano endpoints must be verified before processing. The system uses three authentication mechanisms: (1) shared token in POST body (`APIFY_WEBHOOK_TOKEN`) for `apify_webhook` and as query parameter for `apify_marina_list`, (2) HMAC-SHA256 signature verification (`MAILGUN_SIGNING_KEY`) for `mailgun_inbound`, and (3) API token input validated against environment variable (`FD_API_TOKEN`) for `submit_call`, `snooze_call`, and `send_outbound_email`. All three approaches prevent unauthorized third parties from injecting data or triggering actions in the pipeline.

12. **Always test with real traffic.** The Xano debugger bypasses HTTP content-type parsing, field name matching, and encoding handling. An endpoint can pass all debugger tests perfectly but fail with real external traffic. Always validate webhooks by sending actual external requests (real Mailgun emails, real Apify POST calls) before considering an endpoint complete.

13. **Consumer endpoints return only display-relevant fields via explicit whitelisting, never full database records.** Internal fields (hashing, contact info, cadence tracking, AI notes) are excluded at the API layer to prevent data leakage.

---

## 19. Xano Implementation Lessons Learned

These notes capture technical gotchas discovered during development, useful for future debugging.

**Environment variables in headers (historical):** Xano's External API Request cannot concatenate environment variables directly in header push operations. Attempting `|push:"x-api-key: " + $env.anthropic_api_key` produces "Not numeric" errors. The workaround is creating a separate variable step with `|concat` filter, but this entire issue is avoided by using the Claude Function Pack (which is the current approach).

**Function Pack API key naming:** The Claude Function Pack specifically requires the environment variable name `anthropic_api_key` (all lowercase). Using an uppercase name like `ANTHROPIC_API_KEY` causes the Function Pack to return `authentication_error: x-api-key header is required` (status 401). Only the lowercase version is needed since the External API Request approach was abandoned in favor of the Function Pack. Xano's Learning Assistant confirmed this requirement.

**Function Pack response structure:** The Custom Function wraps Claude's API response in a `result` object. The path to Claude's text output is `func1.result.content[0].text`, NOT `api1.content[0].text` (which is the path for External API Requests). The `content` field is an array even when there's only one response block, so the `[0]` index is always required.

**Function Pack error response structure:** When Claude returns an error (e.g., empty prompt), the response structure changes. Instead of `func1.result.content[0].text`, the error details are at `func1.result.error.type` (e.g., "invalid_request_error"), `func1.result.error.message` (e.g., "messages.0: user messages must have non-empty content"), and `func1.status` (e.g., 400). The `$try_catch.message` and `$try_catch.code` variables were empty for this type of error, so error reporting must reference `$func1` directly.

**Function Pack model enum restrictions:** The Claude Function Pack's model dropdown has a fixed list of allowed values that may lag behind Anthropic's latest releases. Typing a model name not in the allowed list produces "not one of the allowable values" errors at runtime. To add new models: open Library > Functions > "Create chat completion - Claude" #34 > click the `model` input box > add new values to the enum list > update the Default value > Done > Review & Publish. This was done to add `claude-haiku-4-5` and `claude-haiku-4-5-20251001` when the Function Pack only shipped with Claude 3.x models.

**Claude Haiku 4.5 code fence behavior:** Despite a system prompt containing "CRITICAL: Output ONLY raw JSON. Never use markdown, backticks, or code fences," Claude Haiku 4.5 still wraps JSON responses in markdown code fences (` ```json ... ``` `). This causes `json_decode` to fail with "Error parsing JSON: Syntax error." The fix is chaining replace and trim filters before json_decode: `|replace:"```json":""|replace:"```":""|trim|json_decode`. This approach works regardless of whether fences are present, and it works in Xano's Expression Editor (unlike earlier attempts using Xano's `replace` filter in the Stack UI, which could not match backtick characters).

**json_decode filter requirement:** Claude returns its response as a JSON string inside the `text` field. The `|json_decode` filter must be applied when creating the `parsed_response` variable. Without it, `$parsed_response.gas_price` contains the literal string rather than a number, causing "Input is not a valid decimal number" errors when writing to decimal database fields.

**Replace filter and special characters:** Xano's `replace` filter in the Stack UI does not reliably match backtick characters (`` ` ``) when used standalone. However, when used within the Expression Editor as part of a chained expression (e.g., `|replace:"```json":""`), backtick replacement works correctly. This distinction between Stack UI replace and Expression Editor replace was discovered during the model upgrade from Claude 3 Haiku to Claude Haiku 4.5.

**Edit Record field_value and variable types:** The `field_value` parameter in `db.edit` must be a resolved variable with the type dropdown set to **"var: any"**, not "text". Similarly, the `id` field in the data section must also be variable type. When set to text type, Xano treats `$FuelPrices1.id` as a literal string and throws "Value is not a valid integer" errors at runtime, even though the expression looks correct in the Stack UI. Always verify the type dropdown next to each value field.

**Expression Editor vs Variable Picker:** For complex variable paths that need filters (like `$var.func1.result.content[0].text|replace:"```json":""|replace:"```":""|trim|json_decode`), use Xano's Expression Editor rather than the standard variable picker. Access it by clicking the chain-link icon on a variable value field, or by clicking "Convert to expression." The Expression Editor allows typing the full path with filters directly. Variables use the `$var.` prefix in expressions (e.g., `$var.func1` instead of just `$func1`).

**XanoScript Try/Catch syntax:** XanoScript does not support `try` and `catch` as standalone keywords. The correct syntax is `try_catch { try { ... } catch { ... } }`. Attempting to write `try { ... } catch { ... }` produces "unexpected 'try'" errors. The correct syntax was discovered by first adding a Try/Catch block via the Stack UI "Add function" menu (search for "try"), then switching to XanoScript view to see the generated syntax. The `finally` block is also available but optional.

**XanoScript precondition syntax:** XanoScript preconditions use `error_type` and `error` fields (not `code` and `message`). The correct syntax is: `precondition ($condition) { error_type = "accessdenied" error = "Unauthorized" }`. Using `throw { code = 401 message = "..." }` produces syntax errors because XanoScript does not support `throw` as a standalone block.

**XanoScript precondition error_type must be a recognized value:** The `error_type` field in preconditions only accepts specific values (e.g., "accessdenied", "notfound"). Custom values like `"skip"` produce "Input 'skip' is not one of the allowable values" errors at runtime. If you need to conditionally skip execution without throwing a recognized error, use a `conditional` block instead of a precondition.

**XanoScript does not support `||` (logical OR) in conditional blocks:** Using `||` in a `conditional` expression (e.g., `if ($hour < 6 || $hour >= 21)`) produces "Invalid repeating block" syntax errors. Use `&&` (AND) instead and restructure the logic. For example, instead of checking "before 6 OR after 21", check "between 6 AND 21" and put the logic inside that branch. Alternatively, use separate `if`/`elseif` branches for each OR condition. **Important exception:** `||` does work correctly in `precondition` expressions (e.g., `precondition ($input.snooze_type == "1hour" || $input.snooze_type == "tomorrow")`). This distinction between preconditions and conditionals was discovered during the snooze_call endpoint build (thread "7. Dialing App").

**Empty params `{}` sends an array, not an object:** In XanoScript, `params = {}` is serialized as an empty array `[]` in the HTTP request body, not an empty JSON object `{}`. APIs that expect an object body (like Apify's actor run endpoint) return HTTP 400 "The input JSON must be object, got 'array' instead." The fix is to include at least one key-value pair using the `|set` filter: `params = {} |set:"build":"latest"`. This forces Xano to serialize it as a proper JSON object.

**util.get_raw_input does not expose HTTP headers:** When using `util.get_raw_input` for webhook endpoints, the `$webhook1._headers` path does not reliably provide access to HTTP request headers. Attempting to read a custom header (e.g., `$webhook1._headers.x-webhook-token`) causes "Not numeric" precondition errors. The workaround is to send authentication tokens in the POST body rather than as HTTP headers.

**Inline filters on db.get field_value:** Applying filters directly on the `db.get field_value` line (e.g., `field_value = $webhook1.marina_id|to_int`) does not always work. The safer approach is to create a separate variable step that performs the conversion first, then reference that variable in the `db.get`. This pattern was confirmed when `|to_int` inline on `db.get` still produced "Not numeric" errors, but a separate `var $marina_id { value = $webhook1.marina_id|to_int }` step resolved the issue.

**Mailgun auth in External API Request:** Xano's External API Request sprintf filter cannot accept expression syntax (like `"api:" ~ $env.MAILGUN_API_KEY`) in the Additional Arguments field. The Additional Arguments field only accepts direct variable references or environment variables, not expressions. The workaround is creating a separate Create Variable step that builds the full auth string (e.g., `"api:" ~ $env.MAILGUN_API_KEY`), then referencing that variable from the sprintf filter. The same pattern applies to both Domain Sending Keys; the variable name depends on which domain you are sending from: `MAILGUN_API_KEY` for mg.fueldocks.app (alert emails) or `MAILGUN_KEY_NAVIGATOR` for navigatorpnw.com (marina outbound emails). The Xano Security tab on External API Requests does not offer Basic Auth, only SSL certificate options.

**XanoScript vs Stack UI:** Some values set in the Stack UI visual editor do not persist reliably (conditions, nested expressions). Switching to XanoScript view to verify and manually edit values is more reliable for complex configurations. Always verify in XanoScript after making changes in the visual editor. The Review & Publish diff view is also useful for confirming changes before publishing.

**XanoScript input syntax:** XanoScript's input block syntax can be finicky, especially for default values and type declarations. When XanoScript produces syntax errors on inputs, it's often faster to add inputs via the Stack UI instead and then switch to XanoScript for the rest of the function stack.

**Apify environment variables location:** In Apify, environment variables for actors are configured on the **Source** tab (below the code editor), not on the Settings tab. The Settings tab contains actor-level options like timeout, memory, and permissions but not environment variables.

**Apify API token in URL vs header:** The Apify API authenticates via a `token` query parameter in the URL (e.g., `?token=apify_api_...`), not via an Authorization header. This is the standard Apify API authentication pattern.

**Xano community as a resource:** When the Function Pack lacked support for newer models, the Xano community forum (community.xano.com) provided the solution: edit the enum directly on the installed function. Xano team members are active on the forum and provide timely responses. The community also shared a standalone XanoScript function as an alternative to the Function Pack for more advanced use cases (tool use, extended thinking).

**XanoScript db.query search block in Background Tasks:** Using `db.query` with a `search` block inside a Background Task produces "Syntax error, while parsing: 'db.query FuelPrices {' - Invalid block: search on line X" errors. This appears to be a XanoScript parser limitation specific to tasks. The workaround is removing the `search` block entirely, querying all records with just `return = {type: "list"}`, and filtering the results inside a `foreach` loop using conditionals. With small record counts (e.g., 31 marinas) this has no meaningful performance impact.

**Custom Functions for shared logic:** When the same logic is needed in multiple places (e.g., sending an email from both a manual endpoint and an automated task), extract it into a Custom Function under Library > Functions. This keeps the logic in one place so future changes only need to be made once. The calling code becomes a thin wrapper: `function.run "Folder/function_name" { input = {key: value} } as $result`. The function's response is available in the `$result` variable.

**XanoScript literal newline handling:** Xano's `replace` filter can convert literal `\n` sequences to real newlines. The expression `$var.body|replace:"\\n":"\n"` converts the two-character sequence `\n` (as stored in a database text field) into an actual line break in the output string. This is useful for custom email templates where the user enters `\n` in the database field to indicate where line breaks should go.

**db.query WHERE clause syntax requires $db.TableName.field_name:** When using XanoScript's `db.query` (Query All Records), the WHERE clause must reference fields using the `$db.TableName.field_name` pattern. For example: `where = $db.FuelPrices.contact_email == $input.sender`. Using a quoted string like `where = "contact_email" == $input.sender` silently fails and returns null without any error message. This is different from `db.get` (Get Record) which uses `field_name = "id"` and `field_value = $variable`. The Xano Logic Assistant identified this syntax requirement after extensive manual debugging failed to find the issue.

**Precondition null check must use != null, not != "":** When `db.query` with `return = {type: "single"}` finds no matching record, it returns `null`, not an empty string. A precondition checking `$FuelPrices1 != ""` will always pass (because null is not equal to empty string), allowing execution to continue even when no record was found. The correct check is `$FuelPrices1 != null`. This was identified by the Xano Logic Assistant.

**Xano email field type breaks query filtering:** Database fields with the "email" type (shown with an envelope icon in the schema) apply automatic validation rules (trim, lowercase) and do not work correctly with `==` comparisons in `db.query` WHERE clauses. Queries against email-type fields return `ParseError: Invalid value for param:"contact_email"` when using `contains`, and silently return null when using `==`. The fix is to change the field type from "email" to "text" in the database schema. The stored data is unaffected by the type change.

**Stack UI and XanoScript desync:** Extensive switching between Stack UI and XanoScript view during debugging can cause the endpoint to enter a corrupted state where queries that should work consistently return null. When this happens, the most reliable fix is to delete the problematic function step and recreate it fresh, either entirely in the Stack UI or entirely in XanoScript, without switching between views during configuration.

**Mailgun inbound route location in UI:** The Mailgun control panel does not show "Receiving" as a top-level sidebar item. To find inbound routes: click **Send** in the left sidebar to expand it, then look for the **RECEIVING** section at the bottom of the expanded menu, and click **Routes**.

**Mailgun sends x-www-form-urlencoded, not JSON:** Mailgun's inbound route forwarding sends parsed email data as `x-www-form-urlencoded` POST, not as JSON. When using `util.get_raw_input` to capture this data, the encoding parameter must be set to `"x-www-form-urlencoded"`. Using `"json"` encoding will fail to parse the payload correctly.

**Mailgun uses hyphenated field names that Xano inputs cannot handle:** Mailgun sends inbound email data with hyphenated field names like `stripped-text`, `body-plain`, and `body-html`. Xano's input system cannot define inputs with hyphens in the name. Even if you create underscore-named inputs (`stripped_text`, `body_plain`), they will not match the hyphenated field names Mailgun sends, resulting in empty values. The solution is to use `util.get_raw_input` to capture the entire raw payload, then extract individual fields using the `|get` pipe filter: `$var.mailgun_raw|get:"stripped-text"`. This pipe filter syntax correctly accesses keys with hyphens that would be misinterpreted as subtraction in dot notation.

**Xano debugger bypasses input parsing issues:** The Xano debugger sends test data directly through named inputs, completely bypassing the content-type parsing and field name matching that happens with real HTTP POST requests. This means an endpoint can pass all debugger tests perfectly but fail with real Mailgun (or other external) traffic due to encoding mismatches or field name differences. Always validate webhooks by sending actual external requests, not just debugger tests.

**XanoScript `|is_empty` filter not valid in precondition syntax:** Using `$var.FuelPrices1.contact_email|is_empty == false` as a precondition condition produces syntax errors. The correct approach is `$var.FuelPrices1.contact_email != ""` for checking that a text field is not empty. The `|is_empty` filter works in variable expressions but not directly in precondition conditions. This was discovered during the initial build of the `test_outbound_email` endpoint in thread 4d.

**`|default` filter fallback behavior in XanoScript:** Xano's `|default` filter (e.g., `$var.FuelPrices1.email_subject|default:"Current fuel prices?"`) was initially used to implement "use custom if defined, otherwise use generic" logic. During testing in thread 4d, the `|default` filter did not reliably work in XanoScript for all cases. The working approach uses a conditional: set the default value first, then overwrite it with the custom value only if the field is not empty. For example, `var $email_subject { value = "Current fuel prices?" }` followed by `conditional { if ($var.FuelPrices1.email_subject != "") { var.update $email_subject { value = $var.FuelPrices1.email_subject } } }`. This pattern is more verbose but reliable.

**Apify displays run times in the user's local timezone, not UTC:** When viewing actor run timestamps in the Apify dashboard, the displayed times use the browser's local timezone (e.g., Pacific for Ken). This caused initial confusion during debugging when comparing Apify run times against Xano execution logs (which display in UTC). The times appeared mismatched, but both systems were reporting the same events correctly in their respective timezones.

**Xano Background Task execution logs show UTC times:** When verifying Background Task execution history in the Xano Tasks panel, log timestamps are in UTC. Overnight runs that complete in 0.04-0.07 seconds indicate the time window check exited early (outside 6am-9pm Pacific). Daytime runs that take 0.7-0.96 seconds indicate API calls to Apify were actually made. This execution duration pattern is a quick way to verify the time window logic is working correctly.

**Detection gaps from 3-hour scraping interval:** During post-deployment monitoring, Port of Everett and Des Moines Marina updated their fuel prices after the last daytime scraper run (6pm Pacific) on February 13, 2026. These changes were not detected until the following morning's 6am run. Distill.io (running as a watchdog) caught the changes independently, confirming the new system's detection gap. This demonstrated that the 3-hour interval with a 6pm effective last run can miss same-day price changes made in the evening. Potential mitigations: reduce the interval from 3 hours to 1 hour, fix the off-by-one to include the 9pm run, or accept the delay as tolerable for the current use case.

**XanoScript hash filters require unquoted variable references (originally discovered with md5, applies to hmac_sha256 too):** Writing `value = "$webhook1.scraped_content"|md5:false` (with the variable inside double quotes) causes Xano to hash the literal string `$webhook1.scraped_content` instead of the variable's actual contents. Every marina produces the identical hash `69debe6d98aa935507a285017e84a134` on every run. The first run bypasses this because `last_content_hash` is null, so Claude is called correctly and prices are written. But all subsequent runs match the bogus hash and return "no_change," silently freezing every marina's prices. The fix is `value = $webhook1.scraped_content|hmac_sha256:$env.APIFY_WEBHOOK_TOKEN:false` with no quotes. This same quoting rule applies to any Xano filter. The original MD5 version of this bug went undetected for 4 days (Feb 10-14, 2026) because `last_checked` was still updating (giving the appearance of activity) while `last_updated` never advanced. The discrepancy between `last_checked` and `last_updated` timestamps across multiple marinas was the diagnostic clue. The hash algorithm was upgraded from MD5 to HMAC-SHA256 in v3.14 (M5 security remediation).

**XanoScript response field expects a variable reference, not a quoted string:** Writing `response = "webhook1"` returns the literal string "webhook1" to the caller instead of the `$webhook1` object. The correct syntax is `response = $webhook1`. This is consistent with how XanoScript handles variable references elsewhere: quotes create string literals, bare names reference variables.

**XanoScript cannot parse escaped quotes in double-quoted strings for concatenation:** When building a dynamic string that includes both a variable and quoted text (like a system prompt containing `$today_date`), using double quotes with escaped inner quotes (e.g., `"... Set \"Closed\" ONLY if ..."`) causes the XanoScript parser to throw a syntax error. The working approach is single-quoted string segments joined with the `~` concatenation operator: `'Set "Closed" ONLY if the marina is closed TODAY (' ~ $today_date ~ ').'`. Apostrophes inside single-quoted strings also break parsing, so text must avoid contractions (change "Today's date" to "The current date is", change "marina's status" to "the status of the marina").

**Claude needs explicit current date context to evaluate closures correctly:** Without knowing the current date, Claude interprets any closure notice on a marina website as a current closure, setting `open: "Closed"` even when the closure is scheduled for a future date. For example, Des Moines Marina's website mentioned "All Services Closed 02/16/2026 in Observance of Presidents Day" and Claude set the status to "Closed" on Feb 14 (two days before the actual closure). Injecting the current Pacific date into the system prompt via `now|format_timestamp:"m/d/Y":"America/Los_Angeles"` and adding explicit rules about evaluating closures relative to TODAY resolved this. The `closure_note` field captures all closure information (current and future) so upcoming closures are still recorded even when `open` is "Open".

**Hash-based change detection prevents retroactive fixes from prompt changes:** When the Claude system prompt is updated (e.g., adding date-aware closure logic), marinas whose page content has not changed since the last scrape will not be re-parsed because the content hash still matches. The updated prompt only takes effect when a page's content actually changes and produces a different hash. To force an immediate re-parse, manually clear the `last_content_hash` field for the affected marina(s) in the Xano database. The next scraper run will treat the null hash as new content and call Claude with the updated prompt.

**Xano hmac_sha256 filter output format:** Xano's `hmac_sha256` filter with the `false` parameter (e.g., `$var.verification_string|hmac_sha256:$env.MAILGUN_SIGNING_KEY:false`) produces a 64-character lowercase hexadecimal string. The `false` parameter means "do not output raw binary" and instead output the hex-encoded representation. This matches the format Mailgun uses for its webhook `signature` field, allowing direct string comparison with `==`. If the filter produced uppercase hex or raw binary, the comparison would fail silently. Confirmed via a dedicated test endpoint before deploying to production.

**Mailgun inbound webhook includes signature fields automatically:** When Mailgun forwards an inbound email via a route, it automatically appends `timestamp`, `token`, and `signature` fields to the POST body alongside the email data (sender, subject, stripped-text, etc.). These fields are accessible via `util.get_raw_input` and the `|get` pipe filter just like the email fields. No configuration is needed in Mailgun to enable signature fields; they are always present on route forwards.

**Incorrect scrape URL can silently produce valid but wrong results:** Kingston marina (ID 20) had its `website` field set to `https://portofkingston.org/fuel-dock-pump-out/` (a subpage) instead of `https://portofkingston.org/` (the homepage where prices are displayed). The subpage returned valid HTML with some fuel dock content but lacked actual price data, so the Cheerio actor reported success and the hash remained stable. Claude received real content but could not find current prices. The fix was correcting the URL to the homepage. Lesson: when a marina's prices appear stale, verify the scrape URL actually contains the price data before investigating the prompt or scraper logic.

**Claude may calculate tax instead of reading displayed pump price:** During Kingston debugging, the website displayed "$4.89" as the diesel pump price (tax included), but Claude Haiku returned $4.892 (which equals $4.478 base price times 1.092 tax rate). Claude was performing its own tax calculation rather than reading the clearly labeled pump price. The system prompt's Rule 2 was strengthened to say "NEVER calculate tax yourself" and "always use the HIGHEST number because that is what the customer actually pays." This resolved the issue, but it illustrates that LLMs may perform unwanted arithmetic even when instructed to extract a specific displayed value.

**Xano MCP server works in claude.ai but not Claude Desktop:** The Xano Metadata API MCP Server connects successfully as a connector in claude.ai, providing read-only access to database tables, API endpoints, and XanoScript. However, Claude Desktop requires OAuth authentication for MCP server connections, which Xano's MCP servers do not support. Attempts to use the mcp-remote npm package with SSE and Streamable HTTP transport methods all resulted in 500 server errors from Xano's infrastructure. Xano support confirmed the feature should work on the Starter plan and is investigating server-side logs.

**Xano `number_format` filter requires all four arguments:** Using `number_format:2` alone causes a "Too few arguments to function closure, 2 passed and exactly 4 expected" error. The correct syntax is `number_format:2:".":""` (decimals, decimal separator, thousands separator). Even if you do not want a thousands separator, you must pass an empty string as the fourth argument. This is needed when converting decimal database values to strings for display, since Xano drops trailing zeros (e.g., 4.50 becomes "4.5").

**Design doc claims must be verified against actual implementation:** The `suspend_until` field was documented in the system design as pausing outbound emails during seasonal closures, and `daily_closure_recheck` properly cleared it when the date passed. However, `send_outbound_emails` never actually checked the field before sending. The gap existed from v2.10 (when `suspend_until` was introduced) through v2.15. Lesson: when a new field is added with cross-cutting behavior (affecting multiple tasks or endpoints), audit every component that should respect it, not just the one that clears or resets it.

**XanoScript does not support `else if` syntax:** Using `else if (condition)` in a `conditional` block causes a parser error: `Syntax error, while parsing: 'else if ...' - Invalid arg: if`. Multi-branch logic requires nested `conditional` blocks inside an `else`. For example, a three-way branch (A / B / C) must be structured as: outer `conditional` with `if (A)` and `else { conditional { if (B) ... else { C } } }`. This was discovered when adding three-way routing to `mailgun_inbound` (forward-to-human / new prices / no change).

**"No change" email replies must not advance `last_updated`:** When Claude returns null prices with `forward_to_human: false` (indicating a reply like "no changes" or "same as last week"), the database update must not set `last_updated` or overwrite existing prices with null. Prior to v2.17, the `mailgun_inbound` endpoint had only two paths: forward-to-human (no price update) and everything else (full price update including `last_updated`). This meant "no change" replies followed the full update path, incorrectly stamping `last_updated` as though prices had been confirmed. The diagnostic clue was `last_updated` and `last_checked` having identical timestamps on a marina that reported no change. The scraping channel (`apify_webhook`) does not have this bug because hash-based change detection exits before Claude is called when content is unchanged.

**XanoScript beta save hangs when creating endpoints from scratch:** Attempting to create a new endpoint entirely via the XanoScript editor causes the save operation to hang indefinitely without persisting any code. The workaround is creating the endpoint first through the visual Stack builder (or as a Custom endpoint stub), then switching to the XanoScript tab within the existing endpoint to paste or modify code. This approach consistently saves and executes without hanging.

**Auto-generated XanoScript quotes expressions as literal strings:** When building endpoints through the Stack UI visual editor, Xano auto-generates XanoScript that wraps variable expressions in single quotes (e.g., `'now|transform_timestamp:"+1 hour":"America/Los_Angeles"'`). The quoted format causes the expression to be treated as a literal string rather than being evaluated, producing errors like "Invalid timestamp format." Converting to unquoted variable references with dollar-sign syntax (e.g., `$now|transform_timestamp:"+1 hour":"America/Los_Angeles"`) resolves the issue. This was discovered during the `snooze_call` endpoint build (thread "7. Dialing App").

**XanoScript conditionals comparing string literals instead of variable references:** In `submit_call`, conditionals like `if ("input.notes" != "")` compared the literal string "input.notes" to an empty string, which was always true. This caused the Claude API call to fire on every submission even when no notes were entered, sending blank prompts that returned unparseable JSON. The fix is using variable references with `$` prefix: `if ($input.notes != "")`. The visual Stack editor can make these look correct while the underlying XanoScript contains literal strings. Using `getAPI` with `include_xanoscript: True` via the Xano MCP server revealed the actual compiled conditionals that the visual editor obscured (thread "7.1 Dialing App").

**XanoScript strlen for robust empty-string checking:** In addition to `!= ""` checks, using `$input.notes|strlen > 0` provides more robust empty-string checking in XanoScript, especially for input values that might be null, empty, or whitespace-only. This was adopted for the `submit_call` endpoint after the string literal comparison bug (thread "7.1 Dialing App").

**Xano Debug mode does not persist database changes:** When running an endpoint through the Xano debugger, the function stack executes and returns output, but `db.edit` operations do not actually write to the database. The endpoint must be published via "Review & Publish" before database writes take effect. This can cause confusion when debugging appears to show correct output but the database remains unchanged. Always publish before validating actual database writes (thread "7.1 Dialing App").

**Adalo screen deletion breaks all link actions referencing that screen:** When you delete or rename a screen in Adalo, every button or action that linked to that screen silently breaks. There is no warning at deletion time. After consolidating the Call List screen into the Home screen in the FD Dialer app, four buttons (LOG IN on Welcome, Submit/Snooze 1 Hour/Snooze Tomorrow on Call Detail) had to be manually updated to point to "Home" instead of the deleted "Call List" screen (thread "7.2 Dialing app").

**TestFlight internal testing vs external testing:** Apple's TestFlight distinguishes between internal testers (added via App Store Connect, get immediate access to builds) and external testers (require Apple review before distribution). For development testing, create an Internal Testing group and assign the build there. External testing shows "Waiting for Review" and delays access. The Apple ID on the testing device must match the email address added as a tester in App Store Connect; a mismatch causes the build to not appear in the TestFlight app (thread "7.3 Dialing app").

**Apple encryption compliance for TestFlight:** Before a TestFlight build becomes available to testers, Apple requires answering an export compliance question about whether the app uses encryption. For apps that only use standard HTTPS (like the FD Dialer connecting to Xano APIs), the answer is "No." Until this question is answered, the build shows "No Builds Available" in TestFlight even when correctly assigned to a testing group (thread "7.3 Dialing app").

**Invisible Unicode characters break database sorting:** Jarrell's Cove Marina (ID 2) appeared to sort incorrectly in the call queue (after "M" entries despite starting with "J"). The `fuel_dock` field contained invisible zero-width space Unicode characters (`\u200b`) at the beginning, likely copied from an external source. These hidden characters caused alphabetical sorting to place the record after all standard ASCII entries. The fix was clearing the field completely and retyping the name in the Xano database editor. Lesson: when sorting appears broken despite correct sort configuration, check for invisible Unicode characters in the data by examining raw JSON responses (discovered during FD Dialer testing).

**Adalo conditional visibility requires splitting combined text components:** To conditionally show or hide part of a text display (e.g., showing an extension only when the field is populated), the content must be in a separate Adalo text component. A single component containing both the phone number and extension cannot selectively hide just the extension portion. Split the combined component into two: one for always-visible content (phone number) and one for conditionally-visible content (extension), then apply "Sometimes Visible" to the conditional component only.

**Adalo diesel section grouped visibility using a sentinel value:** To hide an entire input group (diesel price, diesel tax, diesel tax checkbox, and helper text) for gas-only marinas, all four components are placed under a single "Sometimes Visible" condition: `diesel_price` is not equal to 9999. The value 9999 acts as a sentinel in the database meaning "this marina does not sell diesel." This approach avoids needing a separate boolean field like `sells_diesel` by reusing the existing `diesel_price` field with a value that would never be a real fuel price. The grouping pattern (one visibility condition controlling multiple related components) is cleaner than applying individual visibility rules to each component separately and ensures the diesel section appears or disappears as a unit.

**Adalo tel: links require "Use In-app Browser" Off and a fresh TestFlight publish:** When wiring a phone number as a tappable dial link in Adalo, set the click action to Link > Website with `tel:` followed by the phone magic text. Under "Show Advanced", set "Use In-app Browser" to Off so iOS hands the `tel:` protocol to the native dialer instead of trying to render it in a web view. The link will not work in the Adalo web previewer or desktop browser. Changes to click actions do not take effect on the device until a new build is published from Adalo and updated in TestFlight.

**Adalo Custom Action JSON bodies require Magic Text chips, not typed input names:** When configuring a Custom Action's API Request body in Adalo, input references must be inserted using the Magic Text icon (T* button) which creates orange pill-shaped chips. Typing the input name as plain text sends the literal string, not the input's value. A body with hardcoded values like `{"marina_id": 1, "snooze_type": ""}` will always send those exact values regardless of the screen's data context. The fix is rebuilding the body using Magic Text chips: `{"marina_id": "[marina_id chip]", "snooze_type": "[snooze_type chip]"}`. This was the root cause of all three Call Detail buttons failing to write to the database (thread "Adalo/Xano snooze button fix").

**Adalo Custom Actions cannot send unquoted numeric values in JSON bodies:** Adalo's JSON validator rejects unquoted Magic Text chips for number types. `{"marina_id": [chip]}` triggers "Please enter a valid JSON body" error. The workaround is quoting all values: `{"marina_id": "[chip]"}` and handling type conversion server-side. This required changing Xano endpoint inputs from `int`/`decimal` to `text` with internal `|to_int` and `|to_decimal` casting. Both `snooze_call` and `submit_call` were affected (thread "Adalo/Xano snooze button fix").

**Adalo Custom Actions are per-button, not shared across an app:** Each button in Adalo has its own independent Custom Action instance. Fixing the Custom Action on the "Call Back - 1 Hour" button does not automatically fix the same configuration on "Call Back Tomorrow" or "Submit." All buttons calling the same endpoint must be fixed independently. The Custom Action editor is accessed by expanding the action on the button, then clicking the pencil icon (left of HIDE ADVANCED) to open the 3-step wizard (thread "Adalo/Xano snooze button fix").

**XanoScript `to_float` filter does not exist; use `to_decimal`:** The Xano expression filter for converting text to a floating-point number is `to_decimal`, not `to_float`. Using `to_float` produces "Invalid filter name: to_float" error. This is consistent with Xano's type system where the numeric decimal type is called `decimal`, not `float` (thread "Adalo/Xano snooze button fix").

**Adalo RUN TEST REQUEST sends empty placeholder values:** When saving a Custom Action in Adalo, the "RUN TEST REQUEST" button on Step 2 (API Request) sends empty or zero placeholder values for all defined inputs. Xano endpoints must handle these gracefully to avoid 400/404 errors during the test. The recommended pattern is a guard clause that checks `$marina_id_int > 0` and returns null when the ID is invalid, allowing the test to return 200 with a null response body. Without this guard, `to_int` on an empty string produces 0, which causes a 404 when looking up a non-existent record (thread "Adalo/Xano snooze button fix").

**`last_updated` must only advance on actual price changes across all input channels:** All three price-writing endpoints (`apify_webhook`, `mailgun_inbound`, `submit_call`) must distinguish between "we checked and prices are the same" and "we checked and prices changed." The `last_checked` timestamp always advances (confirms contact/check occurred), but `last_updated` only advances when at least one price value differs from the current database record. This was first implemented for `mailgun_inbound` (v2.17, three-way routing for "no change" email replies), then applied to `submit_call` (v3.3). For `apify_webhook`, the hash-based change detection inherently provides this behavior (matching hashes skip the Claude call entirely, so prices and `last_updated` are never touched). The pattern for `submit_call` uses a `$prices_changed` boolean flag and compares the post-tax-adjustment diesel price (not the raw input) against the stored value.

**Adalo Default Value property causes backspace bug on mobile:** When an Adalo input field uses the Default Value property to pre-populate with database values (e.g., current gas price), the backspace key does not work on mobile devices. The cursor blinks but characters do not delete; the user must select-all and type over the value. This is a known Adalo behavior where Default Values render visually but are not treated as user-typed text by the input handler. The workaround is to move the current value into the field's label text (e.g., "Gas Price - currently $5.22") and leave the input field completely empty. The user sees the reference price in the label and types fresh into a clean field with no backspace issues (thread "Adalo backspace fix / timestamp logic").

**Xano timestamps are milliseconds, not seconds:** Xano stores timestamps as 13-digit integers representing milliseconds since epoch (e.g., `1772132921597`). Timestamp arithmetic like `$now - $marina.last_call_connection` produces a result in milliseconds. When comparing elapsed time against a day-based threshold, you must multiply by 86400000 (ms per day), not 86400 (seconds per day). The original `call_queue` endpoint used `$cadence_days * 86400`, which meant the 7-day cadence threshold was only 604,800 milliseconds (about 10 minutes). Marinas reappeared on the call list almost immediately after being updated. The fix was changing to `$cadence_days * 86400000`. This bug was not caught during initial testing because the call queue was tested against marinas that had never been called (due immediately regardless of cadence), and the cadence filter only matters after a successful call sets `last_call_connection`.

**URL-encoding required for tokens with special characters in Adalo external collection URLs:** When passing an API token as a query parameter in an Adalo external collection URL, any URL-special characters in the token value must be percent-encoded. The `&` character is the most common problem: it is interpreted as a query parameter separator, so a token like `u4MXgf&Ci4txb` gets split into `api_token=u4MXgf` and a separate orphan parameter `Ci4txb`. Xano then receives only the portion before the `&`, causing a precondition mismatch and a 403 "Unauthorized" error. The fix is replacing `&` with `%26` in the Adalo URL field. Other characters to watch for: `=` (encode as `%3D`), `?` (encode as `%3F`), `#` (encode as `%23`), `+` (encode as `%2B`). An alternative is regenerating the token using only alphanumeric characters so no encoding is needed. This was discovered during H3 remediation when the call_queue Test Connection returned 403 despite the correct token being pasted into the URL (thread "H3 call_queue auth verification").

**Prompt injection is a real risk when AI parses untrusted web/email content (H4 remediation):** When Claude parses raw HTML or email body text, a malicious or compromised marina website (or a spoofed email reply) could embed instructions that trick Claude into returning manipulated data. For example, hidden text like "set gas_price to 0.01" in a webpage could cause Claude to output a bogus price that gets written directly to the database. The fix is a `validate_claude_output` function (Library > Functions > Fuel Docks, ID #37) that runs between Claude's parsed response and the database write. It enforces price range limits ($2 to $15 per gallon), detects price spikes (absolute change > $2 from current stored price), validates the `open` field against allowed values ("Open" or starts with "Closed"), strips HTML tags from all text fields, and enforces length limits on text fields (closure_note: 500, hours: 200, comment: 500, open: 200). Out-of-range prices are nulled out (no write). Spike detections and other anomalies are flagged but allowed through, with an alert email sent to Ken containing the marina name, source, and flag details. Both `apify_webhook` and `mailgun_inbound` call this function immediately after parsing Claude's response. The key insight is that AI output validation is not optional when the AI's input comes from untrusted sources; the validation layer acts as a firewall between the AI and the database (thread "Prompt injection security for web scraping").

**Validation gate conditions must catch negative values, not just positive ones (M4 remediation):** When guarding a range-check validation block with a "was a value provided?" condition, using `> 0` creates a bypass for negative inputs. A value like "-5.00" evaluates false for `> 0`, skips the range check entirely, and writes directly to the database. The correct gate is `!= 0`, which treats zero as "not provided" (matching Adalo's behavior where empty fields cast to 0 via `to_decimal`) while routing all nonzero values, including negative ones, into the range check. This pattern applies to any validation where the gate condition is meant to distinguish "no input" from "input that needs checking." The `apify_webhook` and `mailgun_inbound` endpoints were not affected because their validation lives in the `validate_claude_output` function, which tests `< 2` and `> 15` as separate conditionals rather than using a positivity gate. The `submit_call` endpoint was the only vulnerable path because it used precondition blocks with the `> 0` gate pattern (thread "M4 price validation fix").

**Xano `redis.ratelimit` requires a higher subscription tier:** The `redis.ratelimit` function in XanoScript is not available on all Xano plans. Rate limiting was added to all six endpoints in v3.12 but had to be removed in v3.16 because the current Xano tier does not include Redis support. The endpoints published successfully with the `redis.ratelimit` blocks in the code, but the function would fail at runtime. If upgrading the Xano plan in the future, rate limiting can be re-added using the original configuration documented in v3.12 through v3.15 of this document. See Section 8.11 for the full history and original settings.

**Crawlee PlaywrightCrawler deduplicates requests by URL by default (v3.23 fix):** Crawlee's `PlaywrightCrawler` uses the request URL as the default `uniqueKey` in its internal request queue. If two marinas share the same website URL (e.g., a fuel dock company with multiple locations on one pricing page), the crawler adds the first request and silently drops the second as a duplicate. Only one webhook callback fires, using whichever marina ID was queued first. The fix has two parts: (1) set a custom `uniqueKey` that includes the marina ID (`uniqueKey: marina-${marina.id}`) so the crawler treats each marina as a distinct request, and (2) key the internal `marinaMap` by marina ID instead of URL, and pass the marina ID via `request.userData` so the request handler can look up the correct marina record. Without both changes, the URL-keyed map would have the second marina overwrite the first, and the handler would resolve the wrong marina for one of the two requests. The Cheerio actor does not use Crawlee's request queue (it uses a sequential `for` loop with plain `fetch()` calls) so it is not affected.

**Timestamp-based cadence with millisecond comparison causes time-of-day drift (v3.18 fix):** The original `send_outbound_emails` cadence logic compared elapsed milliseconds (`$now_ms - $marina.last_email_sent`) against a threshold (`$cadence * 86400000`). This worked correctly when the automated task sent at 10am every day, but when a manual send occurred at an odd hour (e.g., 3:37 PM via the `send_outbound_email` endpoint), the next automated 10am run would see only ~6 days 18 hours elapsed, falling short of the 7-day threshold. The email would be delayed an extra day. The fix was switching to date-based comparison: add cadence days to the reference timestamp, format as `Y-m-d` in Pacific time, and compare date strings (`$due_date <= $today`). This way "7 days after Feb 23 at 3:37 PM" computes a due date of "2026-03-02", and any run on March 2 (regardless of time) treats it as due. This matches the pattern already used by `daily_closure_recheck` for `recheck_date` and `suspend_until`, and by `call_queue` for its date-based filters. The `call_queue` endpoint still uses millisecond comparison for its cadence (against `last_call_connection`) because call times are always set by the `submit_call` endpoint during normal working hours, making drift unlikely.

**Mailgun does not store message content by default -- Quick View and MIME tabs require `o:store=yes` (v3.20):** When viewing a sent message in Mailgun logs (Sending > Logs > click a message), the Quick View tab and MIME tab are empty unless message storage was explicitly requested at send time. Mailgun does not retain message body content by default. The fix is passing `o:store=yes` as an additional form-data parameter in the `api.request` call. This tells Mailgun to retain a full copy of the message for up to 3 days. Once added, both tabs populate immediately on the next send. This parameter has no effect on deliverability and does not change the recipient experience. The `o:store=yes` parameter was added to the `send_price_check_email` Custom Function in v3.20 via the `params` chain: `|set:"o:store":"yes"`. Because both `send_outbound_email` (manual endpoint) and `send_outbound_emails` (Background Task) delegate to this single Custom Function, the fix applies to all outbound email sends with one change.

**Adalo shared detail screens do not work with multiple source collections (v3.24):** When three different list screens (Gas, Diesel, Closed) link to a single detail screen, Adalo creates three separate "Available Data" slots on the destination screen, one per source collection. Each slot shows "Missing from [other two screens]". Magic Text wired to one collection's field displays blank when the user navigates from a different collection. The workaround is creating separate detail screens per source collection, each wired to its own collection's data via the Link action. The list row already contains all the fields needed for display, so no additional API call is required. This pattern trades more screens to maintain for simpler, reliable data flow.

**Adalo External Collection test always runs Get All, even if only Get One is configured (v3.24):** At Step 3 (Test Connection), Adalo always calls the Get All endpoint regardless of which endpoints you intend to use. If your API only returns a single object (not an array), the test fails with "Could not find any results." The workaround is pointing the Get All URL at an existing list endpoint that returns an array with the same field names, purely to pass the test. The Get All URL is never called at runtime if no list component references the collection.

**Adalo External Collection Get One requires query parameter format for Xano endpoints (v3.24):** By default, Adalo generates the Get One URL as `{base_url}/{id}` (path segment format). Xano endpoints expect query parameters: `{base_url}?id={id}`. Change the Get One URL manually from `.../marina_detail/{{id}}` to `.../marina_detail?id={{id}}` during External Collection setup.

**Xano `$output` as a variable name corrupts XanoScript response line:** When using `$output` as a variable name in XanoScript, Xano appends a trailing dot to the `response = $output` line, producing `response = $output.` which breaks the endpoint. Use a descriptive name like `$detail_record` instead. The `$output` name likely conflicts with an internal Xano identifier.

**Xano `db.get` requires `field_value`, not `where` clause:** Unlike `db.query` which supports `where` expressions, `db.get` uses a different syntax for record lookup. For filtered single-record lookups, use `db.query` with `return = {type: "list"}` and extract the record via a `foreach` loop or array index. The `|first` filter on a query result caused a 502 runtime crash; the safer pattern is capturing the record into a variable inside a `foreach` loop.

**Adalo Custom Action body: Magic Text chips work, `{{}}` template syntax does not (v3.25):** The Adalo Custom Action body field supports two apparent methods for inserting dynamic values, but only one actually works. The T* icon inserts orange "Magic Text chips" that are correctly substituted at runtime. The `{{input_name}}` double-curly-brace syntax (which appears to be a template placeholder) sends the literal string to the server without any substitution. This was discovered when Xano request history showed `"marina_id": "{{marina_id}}"` arriving verbatim, causing the `to_int` cast to return 0 and the guard clause to silently return null. The correct pattern: define named Inputs in the right panel of step 2, then in the Body field use T* to insert those Inputs as orange chips inside quoted JSON values. After saving, map each Input to screen data on the button's action config. This is distinct from the earlier Adalo learning about quoting all values (the chips must also be quoted: `"marina_id": "[chip]"`).

**Adalo toggle components are invisible to Custom Action Magic Text pickers (v3.25):** When mapping Custom Action inputs on the button's action config screen, Adalo's Magic Text picker shows text inputs under "Other Components" but does not show toggle components. There is no workaround within Adalo for passing a toggle's true/false value to a Custom Action. Options: replace the toggle with a text-based alternative (dropdown), hardcode a default value, or remove the field entirely and handle it server-side. For the `report_price` feature, the tax toggle fields were removed from both the UI and the endpoint because Ken verifies prices manually from the alert email.

**If/elseif priority structures can silently ignore valid data in fallback branches (v3.18/v4.31):** When using `if ($field_a != null) { ... } elseif ($field_b != null) { ... }` to choose between two data sources, the elseif branch is completely skipped whenever field_a is non-null — even if field_a contains stale or incorrect data and field_b has the correct value. In `send_outbound_emails`, `last_email_response` (set to a 2025 seed date) took priority over `last_email_sent` (set yesterday), causing daily emails instead of respecting cadence. The fix: compute the reference value from both fields (e.g., use whichever is more recent) rather than treating one as a priority fallback. This pattern applies anywhere two timestamps or counters could independently hold relevant data.

**XanoScript variables declared inside conditional branches are not accessible outside (v3.25):** When `var $response` is declared inside an `if` or `else` branch, the `response = $response` line at the stack's top level cannot find it. Similarly, `var.update $response` inside a branch does not reliably update a variable declared before the conditional. The pattern that works: use early `return` inside the conditional to exit with the single-path result, then place the default-path logic at the top level of the stack after the conditional closes. This was discovered while implementing the `apify_marina_list` optional `id` parameter, which required both a single-marina path and a batch path returning the same response shape.

---

## 20. Xano Environment Variables

| Variable | Purpose | Status |
|----------|---------|--------|
| `FD_API_TOKEN` | Shared secret for Adalo-to-Xano endpoint authentication (submit_call, snooze_call, send_outbound_email, call_queue). Note: token value contains URL-special characters; must be URL-encoded when passed as a query parameter (e.g., `&` encoded as `%26` in the call_queue external collection URL). | Active |
| `CONSUMER_API_TOKEN` | Shared secret for consumer app endpoint authentication (report_price). Separate from FD_API_TOKEN so the consumer-facing token can be rotated independently if compromised without affecting the FD Dialer admin app. Created March 2026. | Active |
| `APIFY_WEBHOOK_TOKEN` | Shared secret for Apify-to-Xano authentication (webhook POST body for `apify_webhook`, query parameter for `apify_marina_list`) | Active |
| `anthropic_api_key` | Claude API key (lowercase, required by Claude Function Pack) | Active |
| `MAILGUN_API_KEY` | Mailgun Domain Sending Key for mg.fueldocks.app (alert and error emails). Replaced Admin-role Account API key in M2 remediation (February 2026). | Active |
| `MAILGUN_KEY_NAVIGATOR` | Mailgun Domain Sending Key for navigatorpnw.com (marina outbound emails). Created in M2 remediation (February 2026). | Active |
| `MAILGUN_SIGNING_KEY` | Mailgun HTTP Webhook Signing Key (for HMAC-SHA256 inbound webhook verification) | Active |
| `APIFY_API_TOKEN` | Apify Personal API Token (for triggering actor runs from Xano) | Active |
| `APIFY_HTML_ACTOR_ID` | Actor ID for Fuel Docks HTML Scraper (`h27M51Qk8s4lveFFA`) | Active |
| `APIFY_JS_ACTOR_ID` | Actor ID for Fuel Docks JS Scraper (`9bd2ESbz4PrSOcqV0`) | Active |
| `FUELDOCKS_WEBHOOK_TOKEN` | Legacy name, renamed to APIFY_WEBHOOK_TOKEN then deleted (L2 remediation, March 2026) | **Deleted** |
| `AIRTABLE_TOKEN` | Airtable API token | **Deleted** (Step 3) |

---

## 21. Xano Background Tasks

| Task | ID | Schedule | Status | Description |
|------|----|----------|--------|-------------|
| `trigger_apify_scrapers` | #2 | Every 3 hours (freq: 10800s), starts Mar 8 2026 6:00 AM Pacific (13:00 UTC) | Active | Checks Pacific time hour, triggers HTML and JS Apify scraper actors if between 6am-9pm (see Section 9 off-by-one note). Each trigger has independent error handling with Mailgun alerts. |
| `send_outbound_emails` | #3 | Daily at 10am Pacific, Mon-Fri (freq: 86400s), starts Mar 8 2026 17:00 UTC | **Active** | Skips weekends via day-of-week check (early return on Sat/Sun). Loops all FuelPrices records, filters for Method=Email with contact_email. Skips marinas where `suspend_until` has not yet passed (seasonal closure hold). Date-based cadence (v3.18): adds cadence days to reference timestamp, formats as Y-m-d Pacific, sends if due date <= today. Calls send_price_check_email Custom Function per marina. Escalating alert when consecutive_unanswered >= 2. Try/catch per marina. |
| `daily_closure_recheck` | -- | Daily (freq: 86400s), starts Mar 8 2026 midnight Pacific (07:00 UTC) | Active | Proactively reopens marinas whose closure period has passed (sets `open` to "Open"). Clears `last_content_hash` and `recheck_date` for marinas where recheck_date <= today (forces re-parse). Clears `suspend_until` where date has passed (resumes outbound contact). See Section 9.5. |
| `daily_maintenance` (renamed from `daily_csv_backup` in v4.32) | #5 | Daily at 11:59 PM Pacific (freq: 86400s), starts Mar 8 2026 06:59 UTC | Active | Two jobs: (1) Exports entire FuelPrices table to a dated CSV file in Xano file storage (`fuel_docks_backup_YYYY-MM-DD.csv`). (2) Deletes `mfd_analytics` records older than 90 days (MFD analytics cleanup, merged from separate task to conserve 10-task plan limit). See Section 9.6. |
| `daily_call_report` | #6 | Daily at 2:00 AM Pacific (freq: 86400s), starts Mar 8 2026 09:00 UTC | Active | Sends overnight email to ken@navigatormktg.com listing all Method=Call marinas due for a call. Applies same six-filter logic as `call_queue` endpoint (DNC, closed today, snooze, recheck, suspend, cadence). Full filter parity achieved v4.25. Numbered list in last-updated-ascending order. Always sends (zero-due days confirm task health). Subject: "Fuel Docks - # calls to make today". 09:00 UTC = 2:00 AM PDT, no DST adjustment needed. See Section 9.7. |
| `push_badge_update` | #7 | Every 15 minutes (freq: 900s), starts Mar 11 2026 16:00 UTC | Active | Queries `call_queue` endpoint to get count of due marinas, sends silent Expo push notification with badge count to all registered tokens in `dialer_push_tokens` table. Auto-cleans invalid tokens (`DeviceNotRegistered`) from the database. Created v4.6. |
| `parse_hours_json` | #8 | Daily at 1:00 AM Pacific (freq: 86400s), starts Mar 18 2026 08:00 UTC | Active | Backfills `hours_json` for marinas that have free-text `hours` but null `hours_json`. For each qualifying marina, sends the `hours` text to Claude Haiku with a structured prompt that returns a JSON array of `[{start_month, end_month, closed_days}]` schedule objects. Writes the parsed result to `hours_json`. Try/catch per marina with Mailgun error alerts. Runs before `daily_call_report` (1 AM vs 2 AM) so newly parsed schedules are available for the morning email. Created v4.25. See Section 9.10. |
| `daily_tos_check` | #9 | Daily at 1:00 AM Pacific (freq: 86400s), starts Mar 19 2026 08:00 UTC | Active | Checks scraped marinas (Method = "HTML" or "Javascript") with blank `legal` field for TOS/robots.txt restrictions. Fetches website + robots.txt, sends to Claude Haiku for analysis. Emails Ken with prescriptive instructions — never writes to the `legal` field directly. Most nights exits immediately (no blank `legal` fields to check). Created v4.28. See Section 9.11. |
| `sync_airtable_marinas` | #1 | Every 3 hours | **Deleted** | Legacy task that synced Airtable data. Removed after Airtable was fully deprecated. |

### DST Schedule Maintenance

Xano `starts_on` values are fixed UTC timestamps and do not auto-adjust for Daylight Saving Time. All in-code logic (Pacific hour checks, date formatting, cadence comparisons) uses `format_timestamp` with `America/Los_Angeles` and is automatically DST-aware. Only the `starts_on` UTC offsets need manual adjustment twice per year.

**Spring forward (second Sunday of March):** Subtract 1 hour from each `starts_on` UTC value. Completed March 8, 2026 (v3.26).

**Fall back (first Sunday of November):** Add 1 hour to each `starts_on` UTC value. The `daily_call_report` (#6), `parse_hours_json` (#8), and `daily_tos_check` (#9) were all set during PDT, so they will need +1 hour at fall-back to maintain their Pacific target times (2:00 AM, 1:00 AM, and 1:00 AM respectively).

---

## 22. Document History

## Document History

| Date | Version | Changes |
|------|---------|---------|
| February 14, 2026 | 1.0 | Initial document based on architecture planning conversation |

| February 14, 2026 | 1.1 | Updated based on pre-build planning session: two Apify actors (Cheerio + Puppeteer) instead of one Playwright actor; Xano owns scheduling instead of Apify; Method values changed from Apify/Email/Phone to HTML/Javascript/Email/Call; Apify free tier instead of Starter plan; Mailgun domain set to fueldocks.app; database schema updated to match actual FuelPrices table structure; voice/Retell.AI removed (WA two-party consent); test marinas identified (Anacortes id=5, Poulsbo id=17); staleness alert added for detecting Cheerio failures; build order refined with 7 explicit steps |

| February 14, 2026 | 1.2 | Step 1 complete. Added 4 call-related fields (call_cadence, last_call, call_snooze_until, last_call_connection) bringing total new fields to 11. All fields nullable. email_cadence type changed from text to integer (days between checks). Added email resend logic. Added call cadence/snooze logic. Port Orchard Marina (id=28) changed from "Call VM" to "Call". All "Distill" Method values changed to "HTML". |

| February 14, 2026 | 1.3 | Step 2 in progress. Migrated from manual External API Request to Xano's official Claude Function Pack (Marketplace install). Added Section 5 (Claude Integration via Function Pack) with full prompt, model selection, and output format. Added Section 8 (apify_webhook Endpoint Detail) with complete function stack documentation. Added Section 18 (Xano Implementation Lessons Learned). Added ai_comment field to schema. Model set to claude-3-haiku-20240307 (Function Pack limitation). |

| February 14, 2026 | 1.4 | Step 2 debugging session. Resolved Function Pack authentication (requires lowercase `anthropic_api_key` env variable). Documented Function Pack response structure. Fixed Edit Record field_value and id fields from text type to variable type. Added json_decode filter to parsed_response expression. Expanded Section 18 with five new lessons learned. |

| February 14, 2026 | 1.5 | Step 2 complete. Upgraded Claude model to claude-haiku-4-5. Added code fence stripping to parsed_response expression. End-to-end test successful with Port of Poulsbo (gas $5.15, diesel $4.89). Updated Technology Stack to reflect Haiku 4.5. Full XanoScript added to Section 8. |

| February 14, 2026 | 1.6 | Mailgun setup and error handling complete. Created Mailgun account, added mg.fueldocks.app domain, verified all 5 DNS records via GoDaddy. Added Try/Catch error handling to apify_webhook with Mailgun alert emails. Tested both error path and happy path. |

| February 14, 2026 | 2.0 | Step 3 complete. Comprehensive update incorporating all implementation work. Added apify_marina_list endpoint (GET, filtered by Method). Built and deployed two Apify actors: Fuel Docks HTML Scraper (Cheerio, 12 marinas, ~17s, $0.001/run) and Fuel Docks JS Scraper (Playwright with stealth, 5 marinas, ~59s, $0.021/run). All 17 marinas scraping successfully. 5 marinas moved from HTML to Javascript after HTTP 403 errors. Stealth features added to Playwright actor (fingerprinting, resource blocking, automation flag removal). pushData added to both actors for monitoring. 6 Apify monitoring alerts configured (3 per actor). Deprecated services fully cleaned up: airtable_webhook deleted, AIRTABLE_TOKEN removed, Distill demoted to free-tier watchdog (25 monitors: 5 cloud, 20 local), old Apify actors deleted, SendGrid API key deleted, Airtable subscription cancelled. Updated all sections to reflect current architecture. Added actor source code details, stealth configuration, performance metrics, and cleanup history. Added XanoScript input syntax lesson learned. Updated environment variables with deletion status. |

| February 14, 2026 | 2.1 | Step 3.5: Webhook security. Added APIFY_WEBHOOK_TOKEN authentication to apify_webhook endpoint via XanoScript precondition. Token sent in POST body (not HTTP header) because util.get_raw_input does not expose headers. Added marina_id to_int conversion as separate variable (inline filter on db.get did not work). Both Apify actors updated to send webhook_token in POST body. APIFY_WEBHOOK_TOKEN environment variable added to both actors (Source tab, Secret). FUELDOCKS_WEBHOOK_TOKEN renamed to APIFY_WEBHOOK_TOKEN. Added Section 8 webhook authentication documentation. Added design principle #11 (authenticate all webhooks). Added 4 new lessons learned: precondition syntax, util.get_raw_input header limitation, inline filters on db.get, Apify env var location. Updated environment variables table. All 17 marinas verified working with token authentication. |

| February 14, 2026 | 2.2 | Step 4 complete. Built and activated `trigger_apify_scrapers` Background Task (#2). Three new Xano environment variables added: APIFY_API_TOKEN, APIFY_HTML_ACTOR_ID (`h27M51Qk8s4lveFFA`), APIFY_JS_ACTOR_ID (`9bd2ESbz4PrSOcqV0`). Schedule: every 3 hours (freq 10800s), starting Feb 12 6am Pacific. Time window check via conditional (hour >= 6 AND hour < 21). Each actor trigger wrapped in independent try_catch with Mailgun alerts. Deleted legacy `sync_airtable_marinas` task (#1). Added Section 9 (trigger_apify_scrapers Background Task Detail) with full XanoScript. Added Section 21 (Xano Background Tasks). Added Actor IDs to Section 10. Added trigger_apify_scrapers alert format to Section 11. Added 4 new lessons learned: precondition error_type must be recognized value, XanoScript does not support logical OR, empty params sends array not object, Apify API token in URL. Updated environment variables table with 3 new variables. |

| February 14, 2026 | 2.3 | Step 5 partially complete. Built `mailgun_inbound` (POST #39) endpoint in "Fuel Docks API" group with full function stack: db.query lookup by contact_email, precondition for marina match, Claude Function Pack call with email-specific system prompt, parsed_response extraction, database update with prices and timestamps, Try/Catch error handling with Mailgun alerts. Changed `contact_email` field type from "email" to "text" in database schema (email type does not support query filtering). End-to-end test successful with Fair Harbor Marina (ID 3). Added Section 8.5 (mailgun_inbound Endpoint Detail) with full XanoScript. Mailgun inbound route created matching `.*@navigatorpnw.com` forwarding to Xano endpoint. Added email parsing system prompt to Section 5. Updated Section 11 with inbound route configuration, navigatorpnw.com domain details, and mailgun_inbound alert format. Updated Section 15 with mailgun_inbound error handling. Added 5 new lessons learned: db.query WHERE syntax requires $db.TableName.field_name, precondition null check must use != null, email field type breaks query filtering, Stack UI and XanoScript desync, Mailgun route location in UI. Remaining: verify navigatorpnw.com MX records, add DMARC, test full inbound pipeline with real email. |

| February 14, 2026 | 2.4 | Step 5 complete. Resolved critical Mailgun field name mismatch: Mailgun sends x-www-form-urlencoded data with hyphenated field names (stripped-text, body-plain) that Xano named inputs cannot handle. Rebuilt `mailgun_inbound` endpoint to use `util.get_raw_input` with `x-www-form-urlencoded` encoding, extracting fields via pipe filter syntax (`$var.mailgun_raw|get:"stripped-text"`). End-to-end test successful with real email: Outlook to ken@navigatorpnw.com routed through Mailgun to Xano, Claude parsed gas 5.33 / diesel 4.33, Fair Harbor Marina (ID 3) updated correctly. Response changed from $mailgun_raw (debugging) to $FuelPrices1 (production). Updated Section 4.2 Email Channel with util.get_raw_input flow and field name explanation. Rewrote Section 8.5 with new function stack, XanoScript, and implementation notes reflecting the raw input approach. Updated Step 5 status from PARTIALLY COMPLETE to COMPLETE. Added design principle #12 (always test with real traffic). Added 3 new lessons learned: Mailgun sends x-www-form-urlencoded not JSON, Mailgun hyphenated field names require pipe filter extraction, Xano debugger bypasses input parsing issues. DMARC deferred to Step 6. |

| February 14, 2026 | 2.5 | DMARC record added to navigatorpnw.com DNS. TXT record on _dmarc hostname in Hover with value v=DMARC1; p=none; rua=mailto:ken@navigatorpnw.com. Currently in monitor mode. Added DNS records table for navigatorpnw.com to Section 11 documenting all 6 records (SPF, DKIM, 2x MX, CNAME, DMARC). Updated Step 5 build status to include DMARC completion. Updated Step 6 to note DMARC is already in place. Plan to review DMARC aggregate reports and tighten to p=quarantine or p=reject after Step 6 outbound emails have been live for 3-4 weeks. |

| February 14, 2026 | 2.6 | Step 6 (Email Outbound) complete. Created `send_price_check_email` Custom Function in Library > Functions > Fuel Docks folder containing shared per-marina send logic (template selection, placeholder replacement for {{fuel_dock}}/{{gas_price}}/{{diesel_price}}, literal \n conversion, Mailgun send via navigatorpnw.com, timestamp update, consecutive_unanswered increment). Refactored `send_outbound_email` endpoint from 93 lines to 18 lines as thin wrapper calling Custom Function. Built `send_outbound_emails` Background Task running every 3 hours (6am-9pm Pacific) that loops all marinas, filters for Method=Email with contact_email, checks cadence logic (days since last_email_response or last_email_sent or never emailed), sends via Custom Function with try/catch per marina. Added 3 new database fields: `email_subject` (text), `email_body` (text), `consecutive_unanswered` (integer, default 0). Escalating alert system fires when consecutive_unanswered >= 2 after each send, alerting ken@navigatormktg.com with count and suggestion to call. Updated `mailgun_inbound` to reset consecutive_unanswered to 0 on both normal replies and forwarded-to-human emails. Added send_outbound_email endpoint, Custom Functions subsection, and Background Tasks subsection to Section 7. Rewrote Mailgun Outbound section with full implementation details. Updated Section 4.2 outbound steps. Added 2 new implemented alerts to Section 15. Removed escalating alerts from planned list. Added 4 new lessons learned (db.query search block in tasks, Custom Functions for shared logic, literal newline handling, XanoScript Background Task filtering). Task published but inactive, ready to activate when real contact emails populated. |

| February 14, 2026 | 2.7 | Incorporated thread 4d (Customizable outbound email). Updated Section 5 email parsing prompt with `forward_to_human` field and rules for distinguishing "no changes" replies from unrelated emails. Added separate expected JSON output examples for web scraping vs email parsing. Updated Section 8.5 `mailgun_inbound` function stack and XanoScript with complete `forward_to_human` conditional logic (forward non-price emails to Ken, reset `consecutive_unanswered` on both paths, prefix `ai_comment` with "FORWARDED TO HUMAN:"). Added full XanoScript for `send_price_check_email` Custom Function and `send_outbound_email` thin wrapper endpoint to Section 7. Documented endpoint naming history (`test_outbound_email` built in thread 4d, renamed to `send_outbound_email`, then refactored to 18-line wrapper). Added design origin note to Step 6 build status. Added 2 new lessons learned: `|is_empty` filter not valid in precondition syntax, `|default` filter fallback behavior vs conditional approach. Added `forward_to_human` and `consecutive_unanswered` implementation notes to Section 8.5. |

| February 14, 2026 | 2.8 | Completeness audit across all 17 project threads. Incorporated findings from "Xano workflow missing marina price updates" debugging thread (previously undocumented). Documented off-by-one bug in trigger_apify_scrapers time window check: condition `$current_hour < 21` excludes the 9pm run, resulting in 5 effective daily runs (6am, 9am, 12pm, 3pm, 6pm) not 6. Corrected run count from 6 to 5 in Section 4.1 (hash explanation), Section 9 (schedule), Section 10 (scheduling and cost estimate). Added known off-by-one note to Section 9 with mitigation options. Documented detection gap incident: Port of Everett and Des Moines Marina price updates on Feb 13 were missed because they occurred after the 6pm last effective run. Added `send_outbound_emails` task to Section 21 (Background Tasks summary table, previously only documented in Section 7). Updated Foss Harbor known issue to note it remains unresolved. Added 3 new lessons learned: Apify displays run times in local timezone not UTC, Xano Background Task execution log duration as a diagnostic tool, detection gaps from 3-hour scraping interval with evening cutoff. |

| February 15, 2026 | 2.9 | Fixed two bugs in `apify_webhook` XanoScript discovered during post-deployment debugging. Bug 1 (hash quoting): `value = "$webhook1.scraped_content"|md5:false` hashed a literal string instead of the variable contents, producing identical hashes for all marinas and freezing prices from Feb 10-14. Fixed to `value = $webhook1.scraped_content|md5:false`. Bug 2 (response quoting): `response = "webhook1"` returned literal string instead of payload. Fixed to `response = $webhook1`. Added date-aware closure logic to both `apify_webhook` and `mailgun_inbound` system prompts: inject current Pacific date via `$today_date` variable so Claude can distinguish current closures from future ones (resolved Des Moines Marina incorrectly showing "Closed" for an upcoming Presidents Day closure). System prompts moved from inline strings to `$system_prompt` variables using single-quote concatenation with `~` operator. Updated Section 5 (both prompts rewritten with date injection and explicit current-vs-future closure rules), Section 8 (function stack renumbered to 6.3-6.5 for new steps, full XanoScript corrected, 5 new implementation notes), Section 8.5 (function stack renumbered to 6.1-6.9 for new steps, full XanoScript updated, 1 new implementation note), Section 12 (fixed md5 filter documentation, added quoting bug warning, added hash-clearing guidance for prompt changes). Added 5 new lessons learned: XanoScript md5 filter requires unquoted variable reference, XanoScript response field expects variable not string, XanoScript escaped quotes in double-quoted strings cause parser failure, Claude needs explicit current date for closure evaluation, hash-based change detection prevents retroactive prompt fixes. |

| February 16, 2026 | 2.10 | Incorporated "Marina closure explanation field updates" thread. Added closure automation features: `recheck_date` (date, nullable) and `suspend_until` (date, nullable) fields to database schema (Section 6). Updated both Claude system prompts (Section 5) with three changes: (1) `open` field now returns descriptive closure reasons instead of bare "Closed" (e.g., "Closed for Presidents Day", "By appointment only until March"), (2) Rule 3 restructured to lead with date check ("FIRST check dates...") before descriptive examples to prevent Claude pattern-matching on closure keywords before evaluating whether closure is in effect today, (3) new `recheck_date` field (Rule 5) tells system when to force re-evaluation of marina status. Added new `daily_closure_recheck` Background Task (Section 9.5) running daily at 5:30am Pacific that clears `last_content_hash` and `recheck_date` for marinas where recheck_date has arrived (forcing Claude re-parse), and clears `suspend_until` where date has passed (resuming outbound contact). Updated `apify_webhook` XanoScript (Section 8) and `mailgun_inbound` XanoScript (Section 8.5) with new system prompts and `recheck_date` in db.edit data blocks. Updated Background Tasks tables in Section 7 and Section 21. Added key prompt design decisions explaining descriptive closures, Rule 3 ordering, and recheck_date automation. Updated expected JSON output examples to include `recheck_date`. Added 6 new implementation notes in Section 9.5: $today must not be quoted, foreach references $marina not $FuelPrices1, db.edit data block should not include id: null, task block does not support active field, Stack UI conditions may not persist in foreach, date comparison format Y-m-d. |

| February 17, 2026 | 2.11 | Enhanced `daily_closure_recheck` with proactive reopening and midnight scheduling. Two changes: (1) Moved task schedule from 5:30am Pacific to midnight Pacific (starts_on changed from 2026-02-16 13:30 UTC to 2026-02-17 08:00 UTC) so status transitions happen at beginning of day rather than waiting for the 6am scrape. (2) Added proactive reopening logic: when `recheck_date` fires and the marina's `open` field is not "Open", the task now immediately sets `open` to "Open" rather than waiting for the 6am scrape to call Claude. This addresses marina website latency where closure notices remain posted for hours or days after the closure period ends (confirmed with Des Moines Marina on Feb 17, where the Presidents Day closure notice was still on the website 13+ hours after the holiday). The hash is still cleared so the 6am scrape provides a safety net via Claude re-parse. The recheck_date branch now has two sub-branches: one for marinas currently showing a closure status (sets "Open", clears hash and recheck_date) and one for marinas already "Open" (clears hash and recheck_date only, letting Claude set the closure status on next scrape). Rewrote Section 9.5 with updated schedule, three-operation description, expanded "Why This Task Exists" section explaining website latency problem, revised lifecycle example showing midnight proactive reopening at step 4, added Function Stack outline, updated XanoScript with nested conditional, and added 3 new implementation notes (proactive reopening rationale, two db.edit branches, nested conditionals in XanoScript foreach). Updated Background Tasks tables in Section 7 and Section 21 with new schedule and description. |

| February 21, 2026 | 2.12 | Implemented HMAC-SHA256 webhook signature verification for `mailgun_inbound` endpoint, completing security across all inbound webhooks. Added `MAILGUN_SIGNING_KEY` environment variable (Mailgun's HTTP Webhook Signing Key from Settings > Security & Users). Updated Section 8.5: changed Authentication subsection from "disabled" to full HMAC-SHA256 explanation; added 6 new function stack steps (2-7) for extracting timestamp/token/signature from raw POST data, computing HMAC-SHA256 hash, and comparing against Mailgun's signature; renumbered all subsequent steps; updated full XanoScript with signature verification between raw input capture and email body extraction; replaced "authentication disabled" implementation note with 5 new notes covering signature verification mechanism, signing key source, hmac_sha256 filter format, verification placement, and debugger test behavior. Updated Section 7 `mailgun_inbound` endpoint description to mention HMAC-SHA256 verification. Added Webhook Signing Key subsection to Section 11 (Mailgun Configuration) documenting the key's purpose, dashboard location, and verification mechanism. Added signature verification rejection to Section 15 (Implemented Alerts). Updated Section 18 design principle #11 to reflect both authentication methods (shared token for Apify, HMAC-SHA256 for Mailgun). Added 2 new lessons learned to Section 19: Xano hmac_sha256 filter output format (64-char lowercase hex with false parameter), and Mailgun inbound webhook signature fields included automatically on route forwards. Added `MAILGUN_SIGNING_KEY` to Section 20 environment variables table. Updated Step 5 build status authentication note to reference Section 8.5. Verified with end-to-end test: legitimate email from ken.clements@outlook.com successfully updated Hood Canal Marina (ID 47); debugger test with empty inputs properly rejected by signature precondition. |

| February 21, 2026 | 2.13 | Updated `send_outbound_emails` Background Task from every-3-hour schedule (6am-9pm Pacific) to once-daily at 10am Pacific, Monday through Friday only. Two changes: (1) Schedule changed from freq: 10800 to freq: 86400, starts_on changed from 2026-02-13 14:00 UTC to 2026-02-23 18:00 UTC (10am Pacific on Monday Feb 23). (2) Replaced Pacific hour time window check (`$pacific_hour >= 6 && < 21`) with day-of-week weekend skip using `format_timestamp:"N"` (ISO day-of-week, 1=Monday through 7=Sunday) and early return when `$current_day >= 6`. Emails that become due on Saturday or Sunday are naturally held until Monday since the task does not run on weekends. The manual `send_outbound_email` endpoint remains unrestricted for ad-hoc sends on any day or time. Updated Section 4.2 email channel diagram, detailed outbound step 1, Section 7 Background Tasks table, Mailgun cadence logic section, Step 6 build status notes, Step 6 testing notes, and Section 21 Background Tasks summary table. DST note: when DST starts (March 8, 2026), the starts_on of 18:00 UTC will shift to 11am Pacific; adjust to 17:00 UTC at that time to maintain 10am send time. |

| February 23, 2026 | 2.14 | Incorporated "Manual webscrape execution" and "Manual webscrape execution with Xano MCP" debugging threads. Resolved Kingston marina (ID 20) diesel price extraction issue: root cause was incorrect `website` URL pointing to subpage (`/fuel-dock-pump-out/`) instead of homepage (`/`). Corrected URL, cleared `css_selector` to null (full body text extraction). Strengthened Claude system prompt Rule 2 with explicit "NEVER calculate tax yourself" and "always use the HIGHEST number" language after Claude Haiku persistently calculated $4.892 instead of reading the displayed $4.89 pump price. Kingston now extracting correctly: gas $5.22, diesel $4.89. Rewrote Section 16 (MCP) from "not needed" to documenting active use of Xano MCP Server (read-only, connected in claude.ai) and Apify MCP Server (actors, runs, datasets, key-value-stores) for development and debugging. Noted Xano MCP connection to Claude Desktop blocked by OAuth requirement and 500 server errors (Xano support investigating). Added 4 new lessons learned: incorrect scrape URL producing valid but wrong results, Claude calculating tax instead of reading pump price, Xano MCP working in claude.ai but not Claude Desktop, MCP servers as development/debugging tools. |

| February 23, 2026 | 2.15 | Fixed outbound email price formatting. Prices displayed with one decimal (4.5, 4.4) instead of two (4.50, 4.40) because Xano drops trailing zeros when converting decimals to strings for placeholder replacement. Added `$formatted_gas_price` and `$formatted_diesel_price` variables using `number_format:2:".":""` filter in `send_price_check_email` Custom Function. Updated placeholder replacement to use formatted variables. Xano's `number_format` filter requires all four arguments (decimals, decimal separator, thousands separator); passing only the decimals count causes a "Too few arguments" closure error. Added 1 new lesson learned: Xano `number_format` filter syntax. |

| February 23, 2026 | 2.16 | Added `suspend_until` enforcement to `send_outbound_emails` Background Task (#3). The field was introduced in v2.10 to pause outbound emails during seasonal closures, and `daily_closure_recheck` properly cleared it when the date passed, but `send_outbound_emails` never checked it before sending. Added `$today` variable (`now|format_timestamp:"Y-m-d":"America/Los_Angeles"`) after the weekend skip check, then a conditional with `continue` statement that skips any marina where `suspend_until` is not null and the date has not yet passed. The check runs inside the Method=="Email" filter, before cadence logic. Tested via debugger: Fair Harbor (ID 3, suspend_until 2026-05-25) and Coupeville Wharf (ID 45, suspend_until 2026-05-25) both skipped, no emails sent. Updated Section 7 Background Tasks table, Section 21 Background Tasks summary table. Added 1 new lesson learned: design doc claims must be verified against actual implementation when fields have cross-cutting behavior. |

| February 24, 2026 | 2.17 | Fixed `mailgun_inbound` endpoint incorrectly stamping `last_updated` on "no change" email replies. Root cause: the endpoint had two-way routing (forward-to-human vs. everything else), so "no change" replies (null prices, `forward_to_human: false`) took the full update path which always set `last_updated: now`. Refactored to three-way routing using nested `conditional` blocks: (1) forward-to-human, (2) new prices provided (at least one non-null), (3) no change reported (both prices null). Path 3 updates `last_checked` and `last_email_response` but NOT `last_updated`, and does not overwrite existing prices with null. Discovered that XanoScript does not support `else if` syntax (parser error), requiring nested `conditional` blocks for multi-branch logic. Updated Section 4.2 inbound step 10 with three-way routing description, Section 8.5 Function Stack step 12.5 with nested conditional detail, Section 8.5 XanoScript with nested conditional implementation, two implementation notes (timestamps and response routing) rewritten. Added 2 new lessons learned: XanoScript does not support `else if`, "no change" email replies must not advance `last_updated`. |

| February 25, 2026 | 3.0 | Incorporated Dialing App build across four threads ("7. Dialing App", "7.1 Dialing App", "7.2 Dialing app", "7.3 Dialing app"). Step 7 marked COMPLETE. Three new Xano endpoints built: `call_queue` (GET #42), `snooze_call` (POST #43), `submit_call` (POST #44). "FD Dialer" Adalo app built with Welcome, Home (call queue list), and Call Detail screens, deployed via TestFlight for iOS internal testing. Expanded Section 4.3 (Call Channel) with full implementation detail: five-condition queue filtering, diesel tax checkbox logic, Claude call-notes integration, extension handling, snooze behavior, and FD Dialer app screen descriptions. Added call-notes Claude system prompt to Section 5 with expected output example, updated "When Claude is Called" to include call notes as third trigger. Added three new endpoints to Section 7 endpoint table. Updated Step 7 build status in Section 14 with full completion details covering all four threads. Added 10 new lessons learned to Section 19: XanoScript beta save hangs on new endpoints, auto-generated XanoScript quoting expressions as literals, string literal vs variable reference conditionals, strlen for robust empty checks, Debug mode not persisting db writes, Adalo screen deletion breaking link actions, TestFlight internal vs external testing, Apple encryption compliance, invisible Unicode characters breaking sorting. |

| February 25, 2026 | 3.0.1 | Deep review of "7. Dialing App" thread against v3.0 to ensure completeness. Corrected reversed endpoint IDs: v3.0 incorrectly listed submit_call as #43 and snooze_call as #44; actual deployed IDs are snooze_call #43 and submit_call #44. Fixed in Section 7 endpoint table (already corrected in v3.0), Step 7 build status notes, and v3.0 Document History entry. Added three new XanoScript-documented endpoint sections: Section 8.6 (call_queue with 200+ line XanoScript, 7-step function stack, 6 implementation notes), Section 8.7 (snooze_call with 50-line XanoScript, 4-step function stack, 5 implementation notes), Section 8.8 (submit_call with 150-line XanoScript, 6-step function stack, 6 implementation notes). Updated Section 4.3 diesel tax logic with accurate decimal implementation: Adalo sends diesel_tax amount as decimal (not boolean), endpoint subtracts when > 0, writes value back to diesel_tax field. Added diesel tax checkbox defaults table and submit calculations table. Updated Section 19 `||` operator lesson learned to note the important exception that `||` works in `precondition` expressions even though it fails in `conditional` blocks (discovered in snooze_call build). |

| February 25, 2026 | 3.0.3 | Deep review of "7.2 Dialing app" thread against v3.0.1 confirmed the thread's content was already well captured (screen consolidation, broken navigation links, four-button fix). However, review identified the adjacent "Conditional extension display in mobile app" thread with two undocumented Call Detail screen changes. Updated Section 4.3 extension handling: added Sometimes Visible conditional in Adalo so extension only renders when the field is not empty, added "(ext. X)" display format detail. Added new phone number tap-to-call paragraph to Section 4.3: phone number text wired as Website link with tel: URI, opens native dialer on mobile devices, does not work in Adalo previewer or browser. Updated Section 4.3 Call Detail screen description to mention conditional extension visibility and tap-to-call phone number. Added "Conditional extension display" thread to Step 7 build status completion notes. Note: v3.0.2 (deep review of "7.1 Dialing App" thread) was generated in a separate session but not yet uploaded to project files; those changes should be merged separately. |

| February 25, 2026 | 3.0.3a | Deep review of "7.3 Dialing app" thread against v3.0.3 identified three undocumented Call Detail screen UI details visible in 7.3 testing screenshots. Updated Section 4.3 Call Detail screen description: (1) added open/closure status display with red/orange visual emphasis for closure reasons, (2) added that gas/diesel price input fields are pre-populated with current database values so the caller sees last known prices before calling, (3) added diesel tax field display showing current value with contextual label (e.g., "0 = included"). Updated Step 7 build status Call Detail bullet to match the expanded description. Added initial test device details (iPhone 17 Pro, iOS 26.4) to TestFlight deployment notes. |

| February 25, 2026 | 3.1 | Added Adalo implementation details for Call Detail screen refinements. Updated Section 4.3 extension handling: documented that the phone and extension were split from one combined Adalo text component into two separate components so the extension could use conditional visibility independently. Updated Section 4.3 tap-to-call: added "Use In-app Browser" must be Off for iOS to handle the `tel:` protocol natively, noted that link action changes require a fresh Adalo publish and TestFlight update to take effect on device, confirmed working on iPhone 17 Pro with iOS 26.4. Updated Step 7 build status post-build refinements with expanded details (component split, Use In-app Browser setting, confirmed device testing). Added 2 new lessons learned to Section 19: Adalo conditional visibility requires splitting combined text components, Adalo tel: links require "Use In-app Browser" Off and a fresh TestFlight publish. Note: v3.0.2 (deep review of "7.1 Dialing App" thread) was generated in a separate session but not yet uploaded to project files; those changes should be merged separately. |

| February 25, 2026 | 3.2 | Fixed Adalo Custom Action wiring for all three Call Detail buttons (Submit, Call Back - 1 Hour, Call Back Tomorrow). Root cause: Custom Action JSON bodies contained hardcoded values instead of Magic Text chip references, so buttons always sent static data regardless of the selected marina. Adalo's JSON validator rejects unquoted Magic Text chips for number types, requiring all values to be quoted strings in the body. Both `snooze_call` (#43) and `submit_call` (#44) endpoints refactored: all numeric inputs changed from `int`/`decimal` to `text` with internal `|to_int` and `|to_decimal` casting; guard clause added to both returning null when marina_id is 0/empty (allows Adalo RUN TEST REQUEST to succeed). Discovered `to_float` filter does not exist in XanoScript (correct filter is `to_decimal`). Discovered Adalo Custom Actions are per-button instances, not shared. Rewrote Section 8.7 (snooze_call) with text inputs, type casting variables, guard clause, nested conditionals, and 7 implementation notes replacing previous 5. Rewrote Section 8.8 (submit_call) with text inputs, type casting variables, guard clause, and 11 implementation notes replacing previous 7. Updated Section 7 endpoint table descriptions for both endpoints noting text inputs and guard clauses. Updated Step 7 build status with post-build Adalo Custom Action fixes subsection. Added 6 new lessons learned to Section 19: Custom Action JSON bodies require Magic Text chips, Adalo cannot send unquoted numeric values, Custom Actions are per-button, `to_float` does not exist, RUN TEST REQUEST sends empty values, Custom Action editor access path. |

| February 26, 2026 | 3.3 | Two changes from "Adalo backspace fix / timestamp logic" thread. (1) Fixed Adalo Call Detail screen backspace bug: moved current gas/diesel price display from the input field's Default Value property to the field label text (e.g., "Gas Price - currently $5.22"), leaving input fields empty. Adalo's Default Value renders visually but is not treated as user-typed text, so backspace does not work on mobile; empty fields with label-based reference prices eliminate the issue. Updated Section 4.3 Call Detail screen description and Step 7 build status Call Detail bullet to reflect label-based price display instead of pre-populated inputs. (2) Added differential timestamp logic to `submit_call` endpoint (#44): `last_checked` always advances (confirms contact was made), but `last_updated` only advances when the submitted gas price or tax-adjusted diesel price actually differs from the current database values. Implemented via `$prices_changed` boolean flag, two comparison conditionals (gas vs `$FuelPrices1.gas_price`, adjusted diesel vs `$FuelPrices1.diesel_price`), and `$new_last_updated` variable that defaults to preserving `$FuelPrices1.last_updated` unless prices changed. This aligns `submit_call` with the same "no change preserves last_updated" behavior already in `mailgun_inbound` (v2.17) and `apify_webhook` (hash-based). Also documents three security improvements deployed earlier in the same session: API token authentication via `FD_API_TOKEN` environment variable (precondition as first stack operation), input validation rejecting prices outside $2-$15 range, and marina existence precondition (`$FuelPrices1 != null`). Also documents Try/Catch with Mailgun error alerting for Claude call failures (previously noted as a recommended future improvement, now implemented). Rewrote Section 8.8 Function Stack with new steps 0 (precondition), 6.1.1-6.1.3 (validations), 6.5 Try/Catch wrapper, 6.6a (price-change detection), and 6.6b (updated db.edit using `$new_last_updated`). Rewrote Section 8.8 XanoScript with complete deployed code including all security, validation, Try/Catch, and price-change logic. Rewrote Section 8.8 implementation notes: 14 notes replacing previous 11, adding API token auth, input validation, marina existence check, Try/Catch error alerting, and price-change detection notes; removed "No Try/Catch" note. Updated Section 7 `submit_call` endpoint table description with token auth, input validation, Try/Catch, and differential timestamps. Added `FD_API_TOKEN` to Section 20 environment variables table. Added 2 new lessons learned to Section 19: `last_updated` consistency across all input channels, Adalo Default Value backspace bug workaround. |

| February 26, 2026 | 3.3.1 | Fixed milliseconds-vs-seconds bug in `call_queue` endpoint (#42) cadence filter. The cadence check computed `$cadence_days * 86400` (seconds per day) but compared it against `$now - $marina.last_call_connection` which produces milliseconds (Xano timestamps are 13-digit ms values). This meant the 7-day cadence threshold was only ~10 minutes in milliseconds, so marinas reappeared on the call list almost immediately after being updated. Fixed by changing `$cadence_seconds` to `$cadence_ms` and multiplying by `86400000` instead of `86400`. Both the `last_call_connection` path and `last_call` fallback path had the same bug. Updated Section 8.6 Function Stack step 6.6 description (`cadence_ms`, `86400000`). Updated Section 8.6 XanoScript with corrected Filter 4 code and bug-fix comment block. Added 1 new lesson learned to Section 19: Xano timestamps are milliseconds not seconds, with explanation of why the bug was not caught during initial testing. |

| February 27, 2026 | 3.3.2 | Two updates to Section 8.7 (`snooze_call` endpoint #43). (1) Changed "tomorrow" snooze time from 8:00 AM to 12:01 AM Pacific so snoozed marinas reappear at the start of the next day rather than mid-morning. Updated Function Stack step 5.1.3 concat value (`" 00:01:00"` replaces `" 08:00:00"`), XanoScript top comment, else-block comment, snooze_until variable comment, and concat expression. Rewrote "Tomorrow 8am construction" implementation note as "Tomorrow 12:01 AM construction" with rationale for the change. (2) Documented root cause of marinas not hiding after snooze/submit: all three Call Detail buttons (Submit, Call Back - 1 Hour, Call Back - Tomorrow) had hardcoded literal values in their Adalo Custom Action JSON bodies (e.g., `{"marina_id": "1", "snooze_type": ""}`) instead of Magic Text chip references. This caused every button press to write to marina ID 1 regardless of which marina was on screen, so the displayed marina never received a snooze/submit timestamp and kept appearing on the call list. Fix was rebuilding each button's body using the Magic Text icon ("T*" button) to insert dynamic orange pill-shaped chips. Added as new implementation note in Section 8.7 referencing thread "Adalo/Xano snooze button fix". |

| February 27, 2026 | 3.4 | Fixed diesel tax logic bug in `submit_call` endpoint (#44). The `diesel_tax` field stores a percentage rate (e.g., 0.089 = 8.9%), but the old logic subtracted it as a flat dollar amount (`$diesel_price_dec - $diesel_tax_rate`), producing incorrect results. The corrected logic multiplies by `(1 + rate)` to add the percentage-based tax (`$diesel_price_dec * (1 + $diesel_tax_rate)`). Example: $4.35 entered with 0.089 rate = $4.35 x 1.089 = $4.737 stored in `diesel_price`. Four areas updated: (1) Section 4.3 diesel tax checkbox logic paragraph rewritten to describe multiplication instead of subtraction, example rate changed from 0.50 to 0.089. (2) Section 4.3 diesel tax submit calculation table replaced with multiplication examples showing the new formula. (3) Section 7 endpoint registry `submit_call` row updated: "per-gallon tax amount to subtract" changed to "percentage tax rate to apply via multiplication", "Performs diesel tax subtraction" changed to "Performs diesel tax addition by multiplying diesel_price by (1 + rate)". (4) Section 8.8 (`submit_call` endpoint detail) updated throughout: intro line, Function Stack steps 4, 6.3, and 6.4 descriptions, full XanoScript block (input comment, Step 3 comment, Step 4 comment block and formula, all subtraction references replaced with multiplication), and "diesel_tax_included is a decimal" implementation note. Also updated Section 4.3 diesel tax checkbox defaults table to use 0.089 as example rate instead of 0.50. Build history entries (Section 14 lines referencing original subtraction testing) left unchanged as accurate historical records. |

| February 27, 2026 | 3.5 | Added diesel section conditional visibility for gas-only marinas on the Call Detail screen. In Adalo, the diesel price input, diesel tax field, diesel tax checkbox, and "0 = included" helper text are now grouped together and set to "Sometimes Visible" with the condition: `diesel_price` is not equal to 9999. The value 9999 is the sentinel value meaning "marina does not sell diesel"; when set, the entire diesel input group is hidden so the caller only sees the gas price input. Four areas updated: (1) Section 4.3 Call Detail screen description rewritten to describe the diesel section as a conditionally visible group rather than listing the components individually. (2) New "Diesel section visibility for gas-only marinas" paragraph added to Section 4.3 after the Extension handling paragraph, documenting the grouping approach, the 9999 sentinel meaning, and how the pattern parallels the extension conditional visibility. (3) Database field definition for `diesel_price` in the FuelPrices schema expanded to document that 9999 is the sentinel value for "does not sell diesel." (4) New lesson learned added to Section 19: "Adalo diesel section grouped visibility using a sentinel value," documenting the pattern of reusing an existing field with a sentinel value to control group visibility instead of adding a separate boolean field. |

| February 27, 2026 | 3.6 | C3 security remediation for `send_outbound_email` endpoint (#40). Changed HTTP verb from GET to POST (state-changing action should not use GET). Added FD_API_TOKEN authentication via precondition as the first stack operation, matching the pattern used by `submit_call` (#44) and `snooze_call` (#43). New `api_token` input (text, trim filter) validated against `$env.FD_API_TOKEN`; requests with missing or incorrect tokens receive HTTP 403 "Unauthorized" before any processing occurs. Tested in production: bad token correctly rejected at precondition, valid token successfully sent email (320ms, 22 statements). Six areas updated: (1) Section 7 endpoint table row updated from GET to POST, added #40 to ID column, added authentication description and C3 audit note. (2) Section 7 XanoScript block replaced with deployed production code including api_token input and precondition. (3) New `send_outbound_email Endpoint Detail` subsection added above the XanoScript block with authentication description. (4) Section 15 (Error Handling and Alerting) new `send_outbound_email Precondition (API token validation)` entry added to Implemented Alerts. (5) Section 18 design principle #11 expanded from "Authenticate all webhooks" to "Authenticate all webhooks and state-changing endpoints" with all three authentication mechanisms enumerated and `send_outbound_email` included. (6) Section 20 `FD_API_TOKEN` environment variable purpose updated to include `send_outbound_email` alongside `submit_call` and `snooze_call`. Also added Section 22 (Document History) to the system design document itself. |

| February 28, 2026 | 3.7 | H1 security remediation across five consumer-facing endpoints (`closed_marinas` #18, `gas_price_low_to_high` #19, `diesel_price_low_to_high` #20, `gas_prices_by_distance` #21, `diesel_prices_by_distance` #45). Added response field whitelisting (20 display fields, 18 internal fields excluded), 60-second response caching, and server-side relative timestamp computation. Created new `diesel_prices_by_distance` endpoint #45. Fixed `gas_prices_by_distance` #21 sort direction to nearest-first. Added Section 8.9 (Consumer Endpoint H1 Hardening), updated Section 7 endpoint tables with H1 notes and endpoint numbers, added computed fields subsection to Section 6, added design principle #13. |

| February 28, 2026 | 3.8 | H2 security remediation: `apify_marina_list` endpoint now requires authentication via `APIFY_WEBHOOK_TOKEN` query parameter with precondition returning HTTP 403 on mismatch. Both Apify actors (HTML Scraper, JS Scraper) updated to include token in marina list fetch URL. Updated Section 4.1 (step 5), Section 7 (endpoint table), Section 10 (Webhook Authentication and How Both Actors Work), Section 14 (Build Order Steps 3 and 3.5), Section 18 (design principle #11), and Section 20 (environment variables). Moved document history out of the system design document and into this separate file. |

| February 28, 2026 | 3.9 | H3 security remediation: `call_queue` endpoint (#42) now requires authentication via `FD_API_TOKEN` query parameter with precondition returning HTTP 403 "Unauthorized" on mismatch. Adalo FD Dialer app's "Call Queue" external collection Get All URL updated to include `api_token` as a query parameter; token value contains `&` character requiring URL-encoding as `%26` in the Adalo URL field. Verified end-to-end: unauthenticated requests return 403, authenticated requests return marina data (Adalo Test Connection successful). Also fixed pre-existing documentation inconsistency where `submit_call` (#44) Section 8.8 Authentication said "disabled" despite having a working FD_API_TOKEN precondition in its function stack. Seven areas updated: (1) Section 7 endpoint table `call_queue` row updated with authentication note and H3 reference. (2) Section 8.6 Authentication subsection replaced from "disabled" to full auth description including Adalo external collection integration and URL-encoding details. (3) Section 8.6 Function Stack updated with new Step 0 precondition. (4) Section 8.6 XanoScript updated with `api_token` input, trim filter, and precondition block. (5) Section 8.6 Implementation Notes expanded with two new bullets covering H3 precondition rationale and Adalo external collection token delivery pattern. (6) Section 8.8 Authentication subsection corrected to reflect the existing FD_API_TOKEN precondition. (7) Section 15 (Error Handling) updated `send_outbound_email` entry cross-references and added new `call_queue Precondition` entry. (8) Section 20 `FD_API_TOKEN` environment variable purpose updated to include `call_queue` and note URL-encoding requirement. (9) Section 14 Step 7 build log updated with H3 Security Remediation block. (10) New lesson learned added to Section 19: URL-encoding required for tokens with special characters in Adalo external collection URLs, with percent-encoding reference table for common characters. |

| February 28, 2026 | 3.10 | H4 security remediation: prompt injection protection for Claude AI output. Created `validate_claude_output` function (Library > Functions > Fuel Docks, ID #37) that sanitizes Claude's parsed response before any database write. Validation rules: price range enforcement ($2-$15/gallon, out-of-range values nulled), price spike detection (absolute change > $2 from current stored price, flagged but allowed), `open` field validation (must be "Open" or start with "Closed"), HTML tag stripping from all text fields, and length limits on text fields (closure_note: 500, hours: 200, comment: 500, open: 200). Function returns validated fields plus `has_flags` boolean and `flag_summary` text. When flags are detected, an informational alert email is sent to Ken with marina name, source, and flag details; validated data is still written to the database. Both `apify_webhook` and `mailgun_inbound` updated to call `validate_claude_output` immediately after Claude parsing and before the db.edit operation. Nine areas updated: (1) Section 7 Custom Functions table: added `validate_claude_output` (ID 37) entry with description, inputs/outputs summary, calling endpoints, and publish date. (2) Section 8 `apify_webhook` Function Stack: inserted step 6.5.3 (call validate_claude_output), step 6.5.4 (conditional H4 flag alert email), updated step 6.5.5 to source from `$validated` instead of `$parsed_response`, renumbered catch block steps 6.5.7-6.5.11. (3) Section 8.5 `mailgun_inbound` Function Stack: inserted step 12.4a (call validate_claude_output), step 12.4b (conditional H4 flag alert email), updated step 12.5 note on db.edit sourcing. (4) New Section 8.10 (H4 Security: Claude Output Validation): security finding description with threat model, complete function specification with inputs/outputs tables and 5 numbered validation rules, integration pattern subsection documenting the 4-step sequence both endpoints follow. (5) Section 15 (Error Handling): added `apify_webhook H4 Flag Alert` entry with subject format "Fuel Docks H4 Flag: [marina name]" and body contents. (6) Section 15: added `mailgun_inbound H4 Flag Alert` entry with subject format "Fuel Docks H4 Flag: [marina name] (Email)" and body contents. (7) Section 19 (Lessons Learned): added "Prompt injection is a real risk when AI parses untrusted web/email content" entry documenting the threat, remediation approach, and key insight that AI output validation is not optional when input comes from untrusted sources. (8) New Section 22 (Document History): added inline version changelog to the system design document itself with v3.9 and v3.10 entries. (9) Version header updated from v3.9 to v3.10. |

| March 1, 2026 | 3.11 | M2 security remediation: Replaced single Admin-role Mailgun Account API key with two domain-scoped Domain Sending Keys (least-privilege). Domain Sending Keys can only call POST /messages and /events for their specific domain; they cannot modify account settings, delete logs, create routes, or send from other domains. `MAILGUN_API_KEY` env var value overwritten with a Domain Sending Key scoped to mg.fueldocks.app, used by all alert/error email sends (`apify_webhook` catch, `trigger_apify_scrapers` catches, `mailgun_inbound` catch, `send_outbound_emails` error and unanswered alerts, H4 flag alerts). New `MAILGUN_KEY_NAVIGATOR` env var created holding a Domain Sending Key scoped to navigatorpnw.com, used by `send_price_check_email` Custom Function for all marina outbound emails. The `send_price_check_email` `mailgun_auth` variable updated from `"api:" ~ $env.MAILGUN_API_KEY` to `"api:" ~ $env.MAILGUN_KEY_NAVIGATOR`. The original Admin Account API key ("Fuel Docks Xano", created 02/11/26) remains on the Mailgun API Keys page because Mailgun does not allow deleting the last remaining Account API key; its secret value is no longer stored in any Xano environment variable (effectively orphaned). Removed Section 22 (Document History) from the system design document; version history maintained in this separate file. Ten areas updated in system design doc: (1) Section 7 Custom Functions table `send_price_check_email` row: added `MAILGUN_KEY_NAVIGATOR` authentication note. (2) Section 7 `send_price_check_email` XanoScript: changed `mailgun_auth` variable comment and value to reference `$env.MAILGUN_KEY_NAVIGATOR`. (3) Section 8.5 Implementation Notes: `MAILGUN_SIGNING_KEY source` bullet updated to clarify three distinct keys (two Domain Sending Keys plus the Signing Key). (4) Section 13 API Keys subsection: replaced single-key description with "API Keys (Domain Sending Keys)" subsection containing two-key table, domain/scope mapping, and orphaned Admin key note. (5) Section 13 Authentication approach paragraph: updated to explain both Domain Sending Keys with domain-based variable selection. (6) Section 14 Step 2 build status: Mailgun key line updated to reflect two-key setup with M2 remediation note. (7) Section 19 Lessons Learned "Mailgun auth in External API Request": added note that the same pattern applies to both Domain Sending Keys with variable name depending on sending domain. (8) Section 20 Environment Variables table: `MAILGUN_API_KEY` row updated from Admin-role description to mg.fueldocks.app Domain Sending Key; new `MAILGUN_KEY_NAVIGATOR` row added for navigatorpnw.com Domain Sending Key. (9) Section 22 (Document History) removed; entries moved to document history file. (10) Version header updated from v3.10 to v3.11. |

| February 28, 2026 | 3.11.1 | Changed `snooze_call` endpoint (#43) "Call back tomorrow" snooze time from 8:00 AM Pacific to 12:01 AM Pacific so snoozed marinas reappear at the start of the next day rather than mid-morning. XanoScript updated: concat value changed from `" 08:00:00"` to `" 00:01:00"`, comments updated throughout. Four areas updated in system design doc: (1) Section 4.3 snooze flow diagram: "tomorrow 8am Pacific" changed to "tomorrow 12:01am Pacific". (2) Section 4.3 snooze behavior description: "8:00 AM Pacific" changed to "12:01 AM Pacific". (3) Section 7 endpoint table `snooze_call` row: "tomorrow morning (8am Pacific)" changed to "tomorrow at 12:01 AM Pacific". (4) Section 14 build log `snooze_call` entry: updated to "12:01 AM Pacific tomorrow" with parenthetical noting the change from 8am in v3.11.1. Section 19 lesson learned "Tomorrow 12:01 AM construction" already documented the 12:01 AM change and required no update. |

| March 1, 2026 | 3.12 | Redis-based rate limiting added to all six write-capable and webhook endpoints using Xano's `redis.ratelimit` function. Each rate limit is positioned immediately after the authentication precondition (or HMAC signature verification for `mailgun_inbound`) and before any business logic. Rate limits are global (not per-user), keyed with an `rl:` namespace prefix, and use a 60-second sliding window. Configuration: `send_outbound_email` (#40) at 5/60s, `submit_call` (#44) at 10/60s, `apify_webhook` (#36) at 70/60s (headroom above 62 normal calls from 31 marinas x 2 actors), `call_queue` (#42) at 10/60s, `snooze_call` (#43) at 10/60s, `mailgun_inbound` (#39) at 20/60s. Consumer GET endpoints excluded (already protected by 60-second response caching from H1 hardening). Also fixed `snooze_call` Section 8.7 authentication documentation that incorrectly stated "Authentication is disabled" when the live endpoint already had FD_API_TOKEN precondition; replaced the entire XanoScript with the live version including `api_token` input, auth precondition, rate limit, and marina existence check (`db.get` + `precondition != null`). Seventeen areas updated: (1) Section 7 endpoint table: added "Rate limited to X requests per 60 seconds via Redis" to all six endpoint descriptions; also added FD_API_TOKEN authentication note to `snooze_call` row. (2) Section 8 `send_outbound_email` Endpoint Detail: updated authentication paragraph with rate limit note. (3) Section 8 `send_outbound_email` XanoScript: inserted `redis.ratelimit` block after precondition. (4) Section 8 `apify_webhook` intro: added rate limit note. (5) Section 8 `apify_webhook` Function Stack pseudocode: added step 2.5 Redis Rate Limit. (6) Section 8 `apify_webhook` XanoScript: inserted `redis.ratelimit` block after precondition. (7) Section 8.5 `mailgun_inbound` intro: added rate limit note. (8) Section 8.5 `mailgun_inbound` Function Stack pseudocode: added step 7.5 Redis Rate Limit. (9) Section 8.5 `mailgun_inbound` XanoScript: inserted `redis.ratelimit` block after HMAC signature precondition. (10) Section 8.6 `call_queue` intro and authentication: added rate limit notes. (11) Section 8.6 `call_queue` Function Stack pseudocode: added step 0.5 Redis Rate Limit. (12) Section 8.6 `call_queue` XanoScript: inserted `redis.ratelimit` block after precondition. (13) Section 8.7 `snooze_call` intro: added rate limit note. (14) Section 8.7 `snooze_call` Authentication: replaced "Authentication is disabled" with full FD_API_TOKEN description. (15) Section 8.7 `snooze_call` Function Stack pseudocode: added steps 0 (auth precondition) and 0.5 (Redis Rate Limit). (16) Section 8.7 `snooze_call` XanoScript: wholesale replaced with live production code including `api_token` input, auth precondition, rate limit, marina existence validation, and `var.update` syntax. (17) New Section 8.11 (Redis Rate Limiting): dedicated reference section with implementation pattern, configuration table for all six endpoints, XanoScript template, and design notes covering global keys, `rl:` namespace prefix, apify_webhook headroom rationale, and consumer endpoint exclusion reasoning. |

| March 1, 2026 | 3.13 | M4 security remediation: hardened `submit_call` (#44) price range validation to prevent negative values from bypassing the $2-$15 range check. The original validation gate used `> 0` as the condition for entering the range check block; a negative value like "-5.00" evaluated false for `> 0`, skipped the range check entirely, and could write directly to the database. Fix: changed the gate condition from `> 0` to `!= 0` in both gas and diesel validation blocks so that zero/null still mean "not provided" (Adalo compatibility) while all nonzero values, including negatives, enter the range check. The `apify_webhook` (#36) and `mailgun_inbound` (#39) endpoints were confirmed not affected because their validation routes through the `validate_claude_output` function (ID #37), which tests `< 2` and `> 15` as separate conditionals rather than using a positivity gate. Eight areas updated: (1) Section 8.8 intro: added M4 remediation reference. (2) Section 8.8 Function Stack pseudocode steps 6.1.2 and 6.1.3: conditions changed from `> 0` to `!= 0`, labels tagged with "(M4)", descriptions expanded to explain the bypass prevention and zero-as-not-provided semantics. (3) Section 8.8 XanoScript top-level description comment: added M4 summary line. (4) Section 8.8 XanoScript gas validation block: condition changed from `> 0` to `!= 0`, comment updated to "M4 Input validation" with explanation. (5) Section 8.8 XanoScript diesel validation block: same changes as gas block. (6) Section 8.8 Implementation Notes "Input validation for price range" bullet: renamed to "(M4 security)", rewritten to document the bypass vulnerability, the fix, and the before/after behavior. (7) New Section 8.12 (M4 Security: Input Price Range Validation Hardening): security finding with threat description, affected/unaffected endpoint analysis, root cause with code example, fix with corrected code, before/after behavior table covering null/negative/low/valid/high inputs, and validation approach comparison documenting the hard-rejection (submit_call) vs. soft-nulling (validate_claude_output) strategies. (8) Section 19 Lessons Learned: new entry "Validation gate conditions must catch negative values, not just positive ones (M4 remediation)" documenting the general pattern that `> 0` gates create negative-value bypasses and `!= 0` is the correct alternative when zero means "not provided." |

| March 1, 2026 | 3.14 | M5 security remediation: upgraded content change detection hash algorithm from MD5 to HMAC-SHA256 in the `apify_webhook` endpoint (#36). MD5 is cryptographically broken; while the practical risk for change detection is low (collision attacks are impractical for this use case), HMAC-SHA256 eliminates the concern entirely and avoids the theoretical edge case of MD5 collisions on very similar page content. The HMAC is keyed with the existing `APIFY_WEBHOOK_TOKEN` environment variable, requiring no new secrets. The `last_content_hash` field in FuelPrices is a text type, so no schema change was needed (SHA-256 produces a 64-character hex string vs. MD5's 32 characters). One-time side effect: all ~31 stored MD5 hashes will mismatch on the first scrape cycle after deployment, triggering Claude API calls for every web-scraped marina (estimated cost $0.10-0.15); change detection resumes normally after that first pass. Twelve areas updated: (1) Version header: updated from v3.13 to v3.14. (2) Section 4.1 data flow step 12: "MD5 hash" changed to "HMAC-SHA256 hash (keyed with APIFY_WEBHOOK_TOKEN)". (3) Section 6 FuelPrices schema table `last_content_hash` row: description updated from "MD5 hash" to "HMAC-SHA256 hash of last scraped page content, keyed with APIFY_WEBHOOK_TOKEN" with M5 upgrade note. (4) Section 8 `apify_webhook` Function Stack pseudocode step 4: filter changed from `md5:false` to `hmac_sha256:$env.APIFY_WEBHOOK_TOKEN:false`, description updated to reference M5. (5) Section 8 `apify_webhook` XanoScript `$content_hash` variable: filter changed from `md5:false` to `hmac_sha256:$env.APIFY_WEBHOOK_TOKEN:false` with three-line M5 comment block documenting the upgrade, rationale, and one-time mismatch note. (6) Section 8 Implementation Notes `content_hash` bug fix bullet: added parenthetical noting the algorithm was later upgraded from MD5 to HMAC-SHA256 in v3.14 and the same unquoted-variable rule applies. (7) New Section 8.13 (M5 Security: Content Hashing Algorithm Upgrade): security finding with threat description, affected endpoint, before/after code comparison, "Why HMAC-SHA256 Instead of Plain SHA-256" rationale subsection, one-time hash mismatch deployment note, and field description update documentation. (8) Section 12 "What is a Hash" subsection: updated example from "MD5 or SHA256" to "such as HMAC-SHA256". (9) Section 12 "Implementation in Xano" subsection: rewritten to document the current `hmac_sha256` filter with upgrade history from MD5, and updated the unquoted-variable warning to reference `hmac_sha256` syntax. (10) Section 12 "Flow" step 2: changed from "md5 filter" to "hmac_sha256 filter (keyed with APIFY_WEBHOOK_TOKEN)". (11) Section 12 cross-reference: updated from "XanoScript md5 filter requires unquoted variable reference" to "XanoScript hash filters require unquoted variable references" to match renamed Section 19 entry. (12) Section 19 Lessons Learned: renamed entry from "XanoScript md5 filter requires unquoted variable reference" to "XanoScript hash filters require unquoted variable references (originally discovered with md5, applies to hmac_sha256 too)" with broadened applicability note, updated fix example to show current `hmac_sha256` syntax, and added v3.14 M5 upgrade reference. Also updated the `last_content_hash` field description directly in the Xano FuelPrices table schema. |

| March 1, 2026 | 3.14.1 | L2 security finding remediation (documentation only, no Xano changes). Verified via Xano MCP server scan that the legacy `FUELDOCKS_WEBHOOK_TOKEN` environment variable has zero references in any XanoScript across the workspace: all API endpoints (Fuel Docks API group #4), all custom functions, all background tasks, all middleware, all workspace triggers, and all addons were checked. The variable is safe to delete from Xano Settings > Environment Variables. One area updated in system design doc: Section 20 (Xano Environment Variables table) `FUELDOCKS_WEBHOOK_TOKEN` row status changed from **Renamed** to **Deleted**, and purpose text updated from "Legacy name, renamed to APIFY_WEBHOOK_TOKEN" to "Legacy name, renamed to APIFY_WEBHOOK_TOKEN then deleted (L2 remediation, March 2026)." The historical note in Section 14 Step 3.5 build log referencing the original rename was left as-is since it documents what happened during that step. |

| March 1, 2026 | 3.14.2 | L1 environment variable cleanup (documentation only, no Xano changes). Consolidated all references to the Anthropic API key environment variable to the lowercase form `anthropic_api_key`, which is the only version that exists in Xano. The uppercase `ANTHROPIC_API_KEY` was originally created for the direct External API Request approach to calling Claude, which was abandoned early in Step 2 in favor of the Claude Function Pack. The Function Pack requires the lowercase name. The uppercase variable had already been deleted from Xano at some earlier point; this update brings the documentation in line with reality. Five areas updated: (1) Section 5 (Claude Integration) status block: replaced the "TWO Xano environment variables" description with a single-line reference to `anthropic_api_key`. (2) Section 14 Step 2 completed items: consolidated two bullet points (uppercase and lowercase keys) into one referencing only `anthropic_api_key`. (3) Section 19 Lessons Learned "Environment variables in headers": marked as historical, changed example from `$env.ANTHROPIC_API_KEY` to `$env.anthropic_api_key`, added note that the Function Pack is the current approach. (4) Section 19 Lessons Learned "Function Pack API key naming": reworded from "create both or rename" to "only the lowercase version is needed" since the External API Request approach was abandoned. (5) Section 20 (Xano Environment Variables table): removed the `ANTHROPIC_API_KEY` row entirely, kept only the `anthropic_api_key` row. The sole remaining mention of the uppercase form is in the Section 19 lesson learned entry explaining the naming requirement, where it serves as a cautionary "what not to do" example. |

| March 1, 2026 | 3.15 | Daily CSV backup task added. New `daily_csv_backup` Background Task (#5) exports the entire FuelPrices table to a dated CSV file in Xano public file storage nightly at 11:59 PM Pacific. Provides long-lived backup beyond Xano's 7-day rolling snapshots for emergency data restoration. Output files named `fuel_docks_backup_YYYY-MM-DD.csv`. Function stack: queries all records sorted by id, extracts headers with `|keys`, loops records converting each to comma-separated values with `|values|join:","`, concatenates header + data rows with newlines, writes to file storage via `storage.create_file_resource` and `storage.create_attachment`. At 31 marinas each CSV is approximately 20-30 KB; at 3,000 marinas (nationwide scale) approximately 1.8 MB per file, 650 MB per year, well within Xano's 100 GB file storage limit. A `price_history` table approach was evaluated and rejected for the current scale. Six implementation lessons documented including: `csv_create` filter's underdocumented 5-argument requirement and array-of-arrays expectation, Create Variable `[]` must be an expression not text, and foreach loop variable reference syntax (`$marina` not `$item.marina`). Five areas updated: (1) Version header: updated from v3.14.2 to v3.15. (2) New Section 9.6 (daily_csv_backup Background Task Detail): full task documentation with purpose, schedule, function stack pseudocode, production XanoScript, CSV format note, rejected alternatives analysis, and implementation lessons. (3) Section 14 (Build Order): new Step 8 (Daily CSV Backup) added after Step 7 with completion summary and cross-reference to Section 9.6. (4) Section 21 (Xano Background Tasks table): new `daily_csv_backup` row added with task ID #5, schedule, active status, and description with Section 9.6 cross-reference. |

| March 1, 2026 | 3.16 | Removed Redis-based rate limiting from all six endpoints because the current Xano subscription tier does not support Redis. The `redis.ratelimit` function is not available on this plan. Affected endpoints: `apify_webhook` (#36, was 70/60s), `mailgun_inbound` (#39, was 20/60s), `send_outbound_email` (#40, was 5/60s), `call_queue` (#42, was 10/60s), `snooze_call` (#43, was 10/60s), `submit_call` (#44, was 10/60s). All six endpoints republished. No other logic changed. Remaining protections after removal: authentication preconditions on all endpoints, 60-second response caching on consumer GET endpoints, content hash deduplication on `apify_webhook`, and single-operator traffic profile. Practical risk is low at current scale. Original rate limit configuration preserved in v3.12 through v3.15 of this document for future re-addition if the Xano plan is upgraded. Twenty-seven areas updated: (1) Version header: updated from v3.15 to v3.16. (2-7) Section 7 endpoint table: removed "Rate limited to X requests per 60 seconds via Redis" from all six endpoint descriptions (`apify_webhook`, `mailgun_inbound`, `send_outbound_email`, `call_queue`, `snooze_call`, `submit_call`). (8) Section 8 `send_outbound_email` authentication paragraph: removed rate limit sentence. (9) Section 8 `send_outbound_email` XanoScript header comment: removed "Rate limited to 5 requests per 60 seconds." (10) Section 8 `send_outbound_email` XanoScript: removed `redis.ratelimit` block. (11) Section 8 `apify_webhook` Function Stack pseudocode: removed step 2.5 Redis Rate Limit. (12) Section 8 `apify_webhook` XanoScript: removed `redis.ratelimit` block. (13) Section 8.5 `mailgun_inbound` Function Stack pseudocode: removed step 7.5 Redis Rate Limit. (14) Section 8.5 `mailgun_inbound` XanoScript: removed `redis.ratelimit` block. (15) Section 8.6 `call_queue` intro and authentication: removed rate limit sentences. (16) Section 8.6 `call_queue` Function Stack pseudocode: removed step 0.5 Redis Rate Limit. (17) Section 8.6 `call_queue` XanoScript: removed `redis.ratelimit` block. (18) Section 8.7 `snooze_call` intro: removed rate limit sentence. (19) Section 8.7 `snooze_call` Function Stack pseudocode: removed step 0.5 Redis Rate Limit. (20) Section 8.7 `snooze_call` XanoScript header comment: removed "Rate limited to 10 requests per 60 seconds." (21) Section 8.7 `snooze_call` XanoScript: removed `redis.ratelimit` block. (22) Section 8.8 `submit_call` intro: removed rate limit sentence. (23) Section 8.8 `submit_call` authentication paragraph: removed rate limit sentence. (24) Section 8.8 `submit_call` Function Stack pseudocode: removed step 0.5 Redis Rate Limit. (25) Section 8.8 `submit_call` XanoScript: removed `redis.ratelimit` block. (26) Section 8.11: rewrote from active documentation to historical record; header updated to "(v3.12, removed v3.16)"; replaced implementation pattern, configuration table, XanoScript template, and design notes with removal explanation, affected endpoints table with former limits, historical design notes in past tense, and risk assessment of remaining protections. (27) Section 19 Lessons Learned: new entry "Xano `redis.ratelimit` requires a higher subscription tier" documenting that the function is not available on all Xano plans, with cross-reference to Section 8.11 and versions v3.12 through v3.15 for original configuration. |

| March 2, 2026 | 3.17 | Bug fix: `call_queue` endpoint (#42) cadence logic was incorrectly preventing snoozed marinas from reappearing after their snooze expired. Root cause: the cadence check had three branches: (a) if `last_call_connection` exists, check cadence against it; (b) if `last_call` exists, check cadence against it; (c) if neither exists, due immediately. Branch (b) was the problem. When `snooze_call` runs, it sets `last_call` to record the attempt. So after a snooze expired, branch (b) would check cadence against `last_call` (set during the snooze) and hide the marina for another 7 days, even though no one was ever reached. Fix: removed branch (b) entirely. Cadence now only applies when `last_call_connection` is not null (a successful call was made). If `last_call_connection` is null, the marina is always due immediately, regardless of `last_call` value. The `last_call` field is still set by `snooze_call` for historical tracking (knowing when the last attempt was made) but no longer participates in the cadence filter. Endpoint updated via MCP and published. Confirmed working by refreshing FD Dialer app and seeing 13 previously hidden marinas reappear on the call list. Six areas updated: (1) Version header: updated from v3.16 to v3.17. (2) Section 4.3 call queue filtering logic condition 5: rewritten from three-branch description to two-branch (connection cadence or always due), with bug fix note. (3) Section 8.6 Function Stack pseudocode step 6.6: updated from three-tier description to connection-only cadence with v3.17 bug fix note. (4) Section 8.6 `call_queue` XanoScript Filter 4 block: removed the `elseif ($marina.last_call != null)` branch that checked cadence against `last_call`; moved `$cadence_ms` variable inside the `last_call_connection` block; added detailed bug fix comments documenting both the March 2 fix and the prior February 26 milliseconds fix. (5) Section 8.7 `snooze_call` implementation note "last_call updated, last_call_connection NOT updated": rewritten to explain that `last_call` is now for historical tracking only and no longer participates in cadence gating, so snoozed marinas reappear immediately when the snooze expires. (6) Section 7 endpoint table `call_queue` row: added "Cadence only applies to successfully connected marinas (v3.17 fix)." |

| March 2, 2026 | 3.18 | Changed `send_outbound_emails` Background Task (#3) cadence logic from millisecond-elapsed comparison to date-based (Y-m-d) comparison to eliminate time-of-day drift. Root cause: the original cadence check computed elapsed milliseconds (`$now_ms - $marina.last_email_sent`) and compared against a threshold (`$cadence * 86400000`). This worked when the automated task sent at 10am daily, but when a manual send occurred at a non-standard time (e.g., 3:37 PM via the `send_outbound_email` endpoint), the next 10am task run would see only ~6 days 18 hours elapsed, falling short of the 7-day threshold, delaying the email an extra day. Fix: replaced millisecond math with date-based comparison. The task now adds cadence days (as milliseconds) to the reference timestamp, formats the result as a `Y-m-d` date string in Pacific time, and compares against today's `Y-m-d` string (`$due_date <= $today`). This way "7 days after Feb 23 at 3:37 PM" computes a due date of "2026-03-02", and any run on March 2 treats it as due regardless of time of day. This matches the pattern already used by `daily_closure_recheck` for `recheck_date` and `suspend_until` comparisons, and by `call_queue` for its date-based filters. Task also confirmed as active status (previously documented as inactive). Task updated via Xano MCP server and published. Eight areas updated: (1) Version header: updated from v3.17 to v3.18. (2) Section 5 outbound email steps, step 3: rewritten from "check if days since last response >= email_cadence" to date-based due date computation with "send if due date <= today" language. (3) Section 7.1 Background Tasks table `send_outbound_emails` row: description updated with date-based cadence language and v3.18 tag; removed "Currently inactive, ready to activate" note. (4) Section 8.5 `mailgun_inbound` implementation note "Timestamps updated on success": clarified that `last_email_response` is the preferred reference timestamp for the v3.18 date-based cadence comparison. (5) Section 11 Cadence logic detail: expanded with full date-based comparison explanation, concrete drift example ("7 days after Feb 23 at 3:37 PM = due on March 2"), and note about what the previous millisecond approach caused. (6) Section 14 Step 6 completed items, `send_outbound_emails` bullet: updated cadence description to date-based logic with v3.18 tag and "eliminates time-of-day drift" note; changed "Published, currently inactive" to "Published and active." (7) Section 14 Step 6 completed items, task status bullet: changed from "Task published but inactive" to "Task published and active." (8) Section 19 Lessons Learned: new entry "Timestamp-based cadence with millisecond comparison causes time-of-day drift (v3.18 fix)" documenting the root cause, fix pattern, and note that `call_queue` still uses millisecond comparison because call times are set during normal working hours. (9) Section 21 Xano Background Tasks table `send_outbound_emails` row: status changed from **Inactive** to **Active**; description updated with date-based cadence language and v3.18 tag. |

| March 2, 2026 | 3.19 | Excel compatibility fix for `daily_csv_backup` Background Task (#5). The first nightly backup (March 1, 2026) produced a CSV where fields containing commas (such as Fair Harbor Marina's closure note) caused column misalignment when opened in Excel. Root cause: the v3.15 implementation used plain `$marina|values|join:","` without quoting, so commas inside field values were interpreted as column separators. Fix: every header and data value is now wrapped in double quotes using the pattern `"\"" ~ (values|join:"\",\"") ~ "\""`, which joins values with `","` (quote-comma-quote) and caps each row with opening and closing quotes. This required adding a `$current_row` temp variable because the quoting expression was too complex to nest inside a `push` argument. The output now follows RFC 4180 style (with one noted edge case: field values containing literal double-quote characters are not escaped as `""`, though this is unlikely in the FuelPrices dataset). Task XanoScript updated and published. Seven areas updated: (1) Version header: updated from v3.18 to v3.19. (2) Section 9.6 Function Stack pseudocode: expanded from 8 steps to 9; variable `headers` renamed to `header_row` with quoting expression; new step 4 for `$current_row` temp variable; foreach body split into two sub-steps (5.1 quoting into `$current_row`, 5.2 pushing to `csv_lines`); descriptions updated throughout. (3) Section 9.6 XanoScript: replaced v3.15 code with v3.19 production code; task description updated to include "Values are double-quoted for Excel compatibility"; `$header_row` uses quoting expression; new `$current_row` variable; foreach body uses two-step quote-then-push pattern. (4) Section 9.6 CSV Format Note: rewritten from "does not quote, could cause misalignment" caveat to documenting the quoting approach, the Fair Harbor incident that prompted the fix, and the remaining double-quote-in-value edge case. (5) Section 9.6 Implementation Lessons: updated `values|join` bullet to remove "tradeoff is no quoting" note; added new lesson "Unquoted CSV values break Excel when fields contain commas (v3.19 fix)" documenting the symptom, fix pattern, and `$current_row` temp variable requirement. (6) Section 14 Step 8 title: updated from "(v3.15)" to "(v3.15, updated v3.19)". (7) Section 14 Step 8 completed items: added v3.19 bullet documenting the double-quoting fix, the Fair Harbor symptom, the `"\"" ~ (values|join:"\",\"") ~ "\""` pattern, and the `$current_row` temp variable addition. |

| March 5, 2026 | 3.20 | Added `o:store=yes` parameter to the Mailgun `api.request` call in the `send_price_check_email` Custom Function (Function ID 36). Root cause: Mailgun does not retain message body content by default, leaving the Quick View and MIME tabs empty in Mailgun's log detail view (Sending > Logs > click any sent message). Without stored content, debugging deliverability issues and auditing what was actually sent requires inferring from Xano data rather than reading the original message. Fix: added `|set:"o:store":"yes"` to the `params` chain in the `api.request` block. This instructs Mailgun to retain a full copy of each sent message for up to 3 days, populating both the Quick View tab (rendered preview) and the MIME tab (raw message headers and body). The parameter has no effect on deliverability or recipient experience. Because both the manual `send_outbound_email` endpoint (#40) and the automated `send_outbound_emails` Background Task (#3) delegate all send logic to this single Custom Function, the fix covers all outbound email sends with one change. Implemented directly via Xano MCP `updateFunction` call (no manual UI edits required). Four areas updated: (1) Version header: updated from v3.19 to v3.20. (2) Section 8 Custom Functions table `send_price_check_email` row: added "with `o:store=yes` to enable Quick View and MIME tab content in Mailgun logs" to the Mailgun send description. (3) Section 8 `send_price_check_email` XanoScript block: updated `api.request` `params` chain to include `|set:"o:store":"yes"`; updated inline comment from "Send outbound price check email via Mailgun" to explain that `o:store=yes` enables message storage for debugging and audit review. (4) Section 14 Step 6 completed items, `send_price_check_email` bullet: added `o:store=yes` mention with parenthetical explaining Quick View and MIME tab benefit. (5) Section 19 Lessons Learned: new entry "Mailgun does not store message content by default -- Quick View and MIME tabs require `o:store=yes` (v3.20)" documenting the symptom (empty tabs), the fix (`o:store=yes` as a form-data param in `api.request`), the 3-day retention window, and the scope benefit of the single Custom Function pattern covering all send paths. (6) New Section 22 (Document Version History): added a version history table with entries for v3.17 through v3.20 to provide a quick-reference summary of recent changes directly within the system design document. |

| March 6, 2026 | 3.21 | Added `daily_call_report` Background Task (#6). Background: the FD Dialer app cannot display an iOS app icon badge count showing pending call queue size because Adalo's OneSignal integration abstracts device token registration, making it impossible to capture tokens for direct APNs delivery from Xano. This daily email is the practical alternative until FD Dialer migrates off Adalo. The task runs every day at 9:00 AM Pacific (no weekend skip) and sends an email to ken@navigatormktg.com listing all Method=Call marinas currently due for a call. Subject line format: "Fuel Docks - # calls to make today" where # is the count of due marinas. The email body is a numbered list of marinas in last-updated-ascending order (same sort as FD Dialer), each showing marina name, city, and last updated date. Always sends even on zero-due days ("No marinas are due for calls today.") so absence of the email signals a task failure rather than an empty queue. The task applies the identical four-filter logic as the `call_queue` endpoint: (1) snooze -- skip if `call_snooze_until` is in the future; (2) recheck_date -- skip if `recheck_date` is after today Pacific; (3) suspend_until -- skip if `suspend_until` is after today Pacific; (4) cadence -- skip if elapsed time since `last_call_connection` < cadence threshold, with default 7 days. Includes the March 2, 2026 bug fix: cadence only gates on `last_call_connection` (successful calls), not `last_call` (set during snooze). Timestamps are milliseconds so cadence_ms = days * 86400000. Cannot use a WHERE clause in `db.query` inside a Background Task (XanoScript parser limitation); instead queries all FuelPrices records and filters `Method == "Call"` via `continue` inside the foreach loop. Uses `MAILGUN_API_KEY` (mg.fueldocks.app Domain Sending Key) for Mailgun send, same as all other alert emails. Created and published directly via Xano MCP `createTask` call. Subject line updated from an initial date-based format ("Fuel Docks Daily Call Report - {date} ({count} due)") to the current concise format ("Fuel Docks - # calls to make today") in a follow-up `updateTask` call in the same session. DST action required: `starts_on` is set to `2026-03-06 17:00:00 UTC` (9am PST). After DST on March 8, 2026, update to `2026-03-09 16:00:00 UTC` to restore 9am Pacific. Four areas updated: (1) Version header: updated from v3.20 to v3.21. (2) Section 7 Background Tasks table: new `daily_call_report` row added with schedule, description, and DST note. (3) New Section 9.7 (daily_call_report Background Task Detail): full documentation including why it exists (Adalo APNs limitation), four-filter logic explanation, schedule details with DST note, email format spec (subject/body/zero-due behavior), complete XanoScript, and 7 implementation notes. (4) Section 21 Xano Background Tasks summary table: new `daily_call_report` row added with Task ID #6, schedule, Active status, description, and Section 9.7 cross-reference. |

| March 6, 2026 | 3.22 | Changed `daily_call_report` Background Task (#6) schedule from 9:00 AM PST (17:00 UTC) to 2:00 AM PDT (09:00 UTC). Root cause: DST spring-forward on March 8, 2026 would shift the 17:00 UTC run from 9:00 AM PST to 10:00 AM PDT, delivering the report after the workday had already started. Rather than adjusting to 16:00 UTC (which would need reverting in November), the task was moved to 2:00 AM Pacific (09:00 UTC) so DST shifts only move it between 2:00 AM PDT and 1:00 AM PST, both of which are overnight hours with no user impact. `starts_on` updated to `2026-03-08 09:00:00+0000` via Xano MCP `updateTask` call. Seven areas updated: (1) Version header: updated from v3.21 to v3.22. (2) Section 7 Background Tasks table `daily_call_report` row: schedule changed from "Daily at 9:00 AM Pacific" to "Daily at 2:00 AM Pacific (09:00 UTC)"; DST note updated. (3) Section 9.7 intro sentence: time changed from 9:00 AM to 2:00 AM. (4) Section 9.7 Schedule subsection: `starts_on` and DST lines updated. (5) Section 9.7 XanoScript comment block and schedule line: updated to 09:00 UTC / 2:00 AM PDT. (6) Section 9.7 implementation note #6: rewritten for 09:00 UTC schedule. (7) Section 21 Background Tasks summary table `daily_call_report` row: schedule and DST note updated. |

| March 6, 2026 | 3.23 | Fixed Playwright actor duplicate URL handling. Root cause: Crawlee's `PlaywrightCrawler` uses the request URL as the default `uniqueKey` in its internal request queue. When the `apify_marina_list` endpoint returned two marinas with the same website URL (Seattle Boat Company marina #21 Lake Union and marina #22 Newport, both pointing to `https://www.seattleboat.com/fuel-dock-boats-dealership--fuel-docks`), the crawler added the first request and silently dropped the second as a duplicate. Only marina #21's webhook callback ever fired; marina #22's `last_checked` and prices were never updated by the scraping pipeline. Additionally, the actor's internal `marinaMap` was keyed by URL, so the second marina's entry overwrote the first, meaning even if both requests somehow ran, the handler would resolve the wrong marina for one of them. Fix (two parts): (1) Changed `marinaMap` from URL-keyed (`marinaMap.set(marina.website, marina)`) to ID-keyed (`marinaMap.set(marina.id, marina)`) so multiple marinas sharing a URL each keep their own entry. (2) Added `userData: { marinaId: marina.id }` to each request object and updated both `requestHandler` and `failedRequestHandler` to look up the marina via `request.userData.marinaId` instead of `request.loadedUrl` or `request.url`. The `uniqueKey: marina-${marina.id}` was already present in the code (added during initial actor development) but was insufficient alone because the URL-keyed map still caused the wrong marina to be resolved. Playwright actor build bumped from 0.0.8 to 0.0.9. Cheerio actor confirmed unaffected: it processes marinas sequentially in a `for` loop with individual `fetch()` calls and no request queue deduplication. Marina #22 now receives its own webhook callback with the correct `marina_id` and updates independently. This fix also future-proofs the system for national expansion where other multi-location fuel dock companies may share a single pricing page. Five areas updated in system design doc: (1) Version header: updated from v3.22 to v3.23. (2) Section 10 Playwright actor details: marina count updated from 5 to 6. (3) Section 10 How Both Actors Work: new "Duplicate URL handling" paragraph documenting the `uniqueKey`, `userData`, and ID-keyed `marinaMap` pattern, with note that Cheerio is unaffected. (4) Section 19 Lessons Learned: new entry "Crawlee PlaywrightCrawler deduplicates requests by URL by default (v3.23 fix)" documenting both parts of the fix and why both are needed together. (5) Section 22 Document Version History: v3.23 row added. |

| March 7, 2026 | 3.24 | Consumer app marina detail pages. Added three detail screens to the consumer-facing Fuel Docks Adalo app: Gas Detail, Diesel Detail, and Closed Fuel Docks. Each list screen (Gas, Diesel, Closed) has a Row Action (Link) on its table component that navigates to the corresponding detail screen, passing the current row's collection data. Each detail screen displays: marina name (`fuel_dock`), gas and diesel prices with dollar signs, last updated date (`last_updated`), ethanol free status, volume discount status, cash/card info, city, tappable phone (`tel:` URI with "Use In-app Browser" Off), and tappable website (External Link with "Use In-app Browser" On). Closed Fuel Docks detail screen shows the `open` field (closure status/note) in red text instead of gas/diesel prices. Back navigation uses Unicode triangle character (U+25C0) with Link action returning to the originating list screen. Xano `marina_detail` endpoint (#46, api_id 46) created via MCP in the Fuel Docks API group: returns a single marina by ID with same H1 field whitelist and `last_updated_relative` computation as list endpoints, 60-second cache, tagged "adalo apis". Xano-Marina-Detail External Collection created in Adalo with Get One configured for `?id={{id}}` query parameter format; test connection passed using `gas_price_low_to_high` as the Get All URL (Adalo requires a passing Get All test to save any External Collection). Architecture decision: original plan was a single shared detail screen backed by the `marina_detail` endpoint, but Adalo treats each External Collection as an independent data source. When three source screens link to one destination, Adalo creates three separate "Available Data" slots (one per source collection), each "Missing from" the other two. Magic Text wired to one collection's field is blank when the user arrives from a different collection. The fix was three separate detail screens, each wired to its own source collection's data via the Link action. List row data passes directly through the Link action so no Xano endpoint call is needed at runtime. The `marina_detail` endpoint and Xano-Marina-Detail External Collection are retained but not actively used. Section 22 (inline Document Version History) removed from system design doc; full history maintained in this separate file. Six areas updated in system design doc: (1) Version header: updated from v3.23 to v3.24. (2) Section 7 endpoints table: `marina_detail` #46 added with note that it is retained but unused by Adalo at runtime. (3) Section 8.9 H1 Hardening: count updated from five to six consumer endpoints; `marina_detail` #46 added to the list. (4) New Section 14 Step 9 (Consumer App Marina Detail Pages): full implementation details including architecture decision, Adalo screen setup, Link actions, Magic Text wiring, and key implementation notes. (5) Section 19 Lessons Learned: five new entries -- Adalo shared detail screen limitation, External Collection Get All test requirement, Get One query parameter format, Xano `$output` variable name corruption, Xano `db.get` vs `db.query` syntax. (6) Section 22 removed (version history now lives exclusively in this separate file). |

| March 7, 2026 | 3.25 | Report Price feature (Workstreams 1-5). Allows consumer app users to report incorrect marina fuel prices. User input is compiled into an alert email to Ken, and the system takes automated action to re-verify prices based on the marina's collection method. **Xano backend:** Created `CONSUMER_API_TOKEN` environment variable (separate from `FD_API_TOKEN` for independent rotation). Created `APIFY_API_TOKEN`, `APIFY_HTML_ACTOR_ID` (`h27M51Qk8s4lveFFA`), and `APIFY_JS_ACTOR_ID` (`9bd2ESbz4PrSOcqV0`) environment variables for triggering Apify actor runs from Xano. Updated `apify_marina_list` endpoint (#38) with optional `id` parameter for single-marina lookups; when `id` is provided and > 0, returns a single-item array for that marina (used by `report_price` triggered runs); when absent or 0, returns all marinas for the given Method (existing batch behavior). Uses early `return` pattern inside conditional for the single-marina path to avoid XanoScript variable scoping issues (variables declared inside conditional branches are not accessible from the response line). Created `report_price` endpoint (#47, POST) with full logic: CONSUMER_API_TOKEN auth, text inputs for Adalo compatibility (marina_id cast to int, prices cast to decimal), guard clause returning null for marina_id=0 (Adalo test requests), at-least-one-field validation, $2-$15 price range validation, alert email construction with current vs. reported prices, and five Method-specific automated actions (HTML: trigger Cheerio actor, Javascript: trigger Playwright actor, Call: null `last_call_connection` so marina enters call queue immediately, Email: send immediate price check email and update `last_email_sent`/`consecutive_unanswered`, Facebook: no automated action noted in alert email). Reported prices are never written to the database. Tax toggle fields (`gas_tax_included`, `diesel_tax_included`) removed from endpoint during implementation because Adalo toggle components do not appear in Custom Action Magic Text pickers. **Apify actors:** Cheerio actor updated to build 0.0.11 and Playwright actor updated to build 0.0.10, both reading optional `marina_id` from actor input via `Actor.getInput()` and appending `&id=${marinaId}` to the `apify_marina_list` URL when present; in single-marina mode the list returns one item so the existing loop runs exactly once. **Adalo consumer app:** Two Report Price screens created (Gas - Report Price and Diesel - Report Price) because Adalo treats each External Collection as an independent data source, requiring separate screens per source collection (same pattern as Step 9 detail screens). Gas Detail and Diesel Detail screens each have a "REPORT PRICE CHANGE" button with Link action to the corresponding Report Price screen. Each Report Price screen displays marina name, current prices, last updated date, explanatory callout about first-gallon pricing and tax inclusion, three form inputs (gas price, diesel price, comments), and a Submit button. Diesel price input uses "Sometimes Visible" where `diesel_price` is not equal to 9999. Submit button has two actions: Custom Action POST to `report_price` endpoint, then Link to Confirmation screen. Confirmation screen with thank-you message and "DONE" button linking back to home. **Critical Adalo Custom Action learning:** The `{{input_name}}` double-curly-brace template syntax in Custom Action bodies does NOT work; Adalo sends the literal string to the server without substitution. The correct method is inserting orange Magic Text chips via the T* icon in the Body field. This was discovered after Xano request history showed literal `{{marina_id}}` arriving as the marina_id value, causing the guard clause to return null silently. Twelve areas updated in system design doc: (1) Version header: updated from v3.24 to v3.25. (2) Section 7 endpoints table: `apify_marina_list` description updated with optional `id` parameter, api_id #38 added. (3) Section 7 endpoints table: `report_price` #47 added with full description. (4) Section 10 Apify Configuration "How Both Actors Work": rewritten to document the `marina_id` input for single-marina mode via `Actor.getInput()`. (5) New Section 14 Step 10 (Report Price Feature): full implementation details covering Xano backend, Apify actors, Adalo consumer app, Custom Action body configuration learning, and key implementation notes. (6) Section 19 Lessons Learned: three new entries: "Adalo Custom Action body: Magic Text chips work, {{}} template syntax does not", "Adalo toggle components are invisible to Custom Action Magic Text pickers", and "XanoScript variables declared inside conditional branches are not accessible outside". (7) Section 20 Environment Variables table: `CONSUMER_API_TOKEN` added with usage context and separation rationale. |

| March 7, 2026 | 3.25.1 | Added full endpoint detail sections for the two endpoints created/modified in v3.25. New Section 8.14 (apify_marina_list Endpoint Detail, Updated v3.25): complete documentation with authentication, inputs table, function stack walkthrough, full XanoScript (production code pulled from Xano MCP), and 3 implementation notes covering the early-return variable scoping pattern, optional int defaulting to 0, and identical response shape for both paths. New Section 8.15 (report_price Endpoint Detail, v3.25): complete documentation with authentication, inputs table, 14-step function stack walkthrough, full XanoScript (production code pulled from Xano MCP), and 8 implementation notes covering no-database-write design decision, token separation rationale, Email-method direct send vs Custom Function, Call-method queue reset mechanics, Apify REST API triggering pattern, Facebook-method limitation, missing contact_email edge case, and absence of Try/Catch wrappers (noted as future improvement). |

| March 8, 2026 | 3.26 | DST spring-forward schedule adjustment. Daylight Saving Time started March 8, 2026, shifting Pacific time from PST (UTC-8) to PDT (UTC-7). Adjusted `starts_on` UTC values for four of five Background Tasks to maintain their intended Pacific execution times. Changes: `trigger_apify_scrapers` (#2) from 14:00 UTC to 13:00 UTC (maintains 6:00 AM Pacific); `send_outbound_emails` (#3) from 18:00 UTC to 17:00 UTC (maintains 10:00 AM Pacific); `daily_closure_recheck` (#4) from 08:00 UTC to 07:00 UTC (maintains midnight Pacific); `daily_csv_backup` (#5) from 07:59 UTC to 06:59 UTC (maintains 11:59 PM Pacific). `daily_call_report` (#6) was already configured at 09:00 UTC during PDT (v3.22) and required no change. All in-code logic (Pacific hour checks via `format_timestamp:"H":"America/Los_Angeles"`, weekend day-of-week checks, date-based cadence comparisons) is automatically DST-aware and required no changes. Each task's XanoScript updated with a DST comment noting the old and new UTC values. `daily_closure_recheck` also received a proper description (previously empty). All four tasks published via Xano MCP. Fifteen areas updated in system design doc: (1) Version header: updated from v3.25.1 to v3.26. (2) Section 7 Background Tasks table `trigger_apify_scrapers` row: schedule changed from `2026-02-13 06:00 PST` to `2026-03-08 13:00 UTC`. (3) Section 7 table `send_outbound_emails` row: schedule changed from `2026-02-23 18:00 UTC` to `2026-03-08 17:00 UTC`. (4) Section 7 table `daily_closure_recheck` row: schedule changed from `2026-02-17 08:00 UTC` to `2026-03-08 07:00 UTC`. (5) Section 9 `trigger_apify_scrapers` start time: changed to Mar 8, 2026 13:00 UTC (PDT). (6) Section 9 `trigger_apify_scrapers` XanoScript schedule line: updated to `2026-03-08 13:00:00+0000`. (7) Section 9.5 `daily_closure_recheck` start time: changed to Mar 8, 2026 07:00 UTC (PDT). (8) Section 9.5 `daily_closure_recheck` XanoScript schedule line: updated to `2026-03-08 07:00:00+0000`. (9) Section 9.6 `daily_csv_backup` start time: changed to Mar 8, 2026 06:59 UTC (PDT); removed stale DST-will-shift note. (10) Section 9.6 `daily_csv_backup` XanoScript schedule line: updated to `2026-03-08 06:59:00+0000`. (11) Section 14 Step 6 `send_outbound_emails` build status: UTC reference changed from 18:00 to 17:00. (12) Section 14 Step 8 `daily_csv_backup` build status: UTC reference changed from 07:59 to 06:59. (13) Section 21 summary table: all four affected task rows updated with new `starts_on` dates and explicit UTC values. (14) New Section 21 DST Schedule Maintenance subsection: documents that `starts_on` values are fixed UTC and do not auto-adjust, that in-code logic is DST-aware, and provides spring-forward/fall-back instructions including the note that `daily_call_report` will also need adjustment at fall-back. (15) Section 19 not updated (no new lessons; DST adjustment was already anticipated in v2.13 and v3.22 notes). |

| March 8, 2026 | 3.27 | In-app map feature. Replaced the external Google My Maps link with a native Adalo Map component showing all fuel dock locations as tappable pins. **Xano backend:** Created `map_marinas` endpoint (api_id 48, GET, no auth, 60s cache) via MCP. Returns all marinas with no status or price filters applied, using the same H1 field whitelist (20 display fields) as other consumer endpoints. Sorted alphabetically by `fuel_dock`. Computes `last_updated_relative` from `last_checked`. Tagged "adalo apis". Added to Section 8.9 H1 Hardening endpoints list. No rate limiting (Xano plan limitation); 60-second response cache provides meaningful protection. **Google Cloud:** Google Maps Platform billing account ("My Maps Billing Account") created under existing "Fuel Docks locator" project (251292635018). Google provides $200/month free credit for Maps Platform usage. Maps JavaScript API, Maps SDK for iOS, and Maps SDK for Android enabled. Existing API key renamed from "API key 1" to "Google My Maps - Fuel Docks" (renaming does not change the key value). New API key "Adalo Map - Fuel Docks" created and restricted to three APIs: Maps JavaScript API, Maps SDK for Android, Maps SDK for iOS. **Adalo consumer app:** Xano-marinas-map External Collection created with Base URL `https://xlba-eg1u-i4nx.n7e.xano.io/api:-GTDJqKH/map_marinas`, Get All only, no Results Key or Request Key (flat JSON array). Adalo Map marketplace component installed (made by Adalo, uses Google Maps). New "Map" screen created with Map component: Google Maps API key set to "Adalo Map - Fuel Docks", "Multiple Markers" mode, Marker Collection set to Xano-marinas-map, Marker Address uses Magic Text `latitude, longitude` (comma-separated), "Show Current Location" toggle enabled. Pin click action: Link to Gas Detail screen passing "Current Xano-marinas-map" data. Side Navigation Menu Item 4 ("Map") updated from External Link (Google My Maps URL) to Link action targeting the new Map screen. **Limitations and future considerations:** Adalo Map component auto-fits zoom to show all markers (no zoom/center controls available). At ~31 PNW marinas this is acceptable. National expansion will require updating the endpoint to accept lat/lng and radius to return only nearby marinas, since the component fetches data once on screen load and zooming does not trigger new API calls. No marker clustering, custom pin icons, or info window popups available in this component. Five areas updated in system design doc: (1) Version header: updated from v3.26 to v3.27. (2) Section 7 Existing consumer endpoints table: `map_marinas` #48 added. (3) Section 8.9 Consumer Endpoint H1 Hardening: `map_marinas` #48 added to endpoints covered list. (4) New Section 14 Step 11 (In-App Map): full implementation details covering Xano endpoint, Google Cloud setup, Adalo configuration, map behavior/limitations, and key implementation notes. |

| March 9, 2026 | 3.28 | Affirmative email confirmation context injection for `mailgun_inbound` (#39). Root cause: when outbound emails ask "Are your prices still at $X for gas and $Y for diesel?", marina contacts often reply with a single word like "Yup!" or "Yes". Claude Haiku only saw the reply body in isolation with no context about what was asked, so it found no price data, set `forward_to_human: true`, and sent Ken an unnecessary "RESPONSE REQUIRES ATTENTION" alert. The marina's reply was actually a valid "no change" confirmation that should have been handled silently by Path 3. **Fix (two parts):** (1) New `$price_context` variable (step 12.1a) built from `$FuelPrices1` (already loaded in step 10) that injects the marina's current on-file gas and diesel prices into the system prompt. Example expansion: "The prices currently on file for this marina are: gas $5.99/gallon and diesel $5.69/gallon (a value of 9999.00 means this fuel type is not sold). Our outbound email asked the marina to confirm whether these prices are still current." (2) New IMPORTANT rule appended to the system prompt listing common affirmative reply patterns ("Yes", "Yup", "Correct", "That is right", "Same", "Yep", "Still the same", "No change", "Sure is", "Uh huh", "Yeppers") and instructing Claude to treat them as fuel-dock-related "no change" responses with null prices and `forward_to_human: false`. Both parts work together: the price context tells Claude what was asked, and the affirmative rule tells Claude how to interpret the confirmation. Result: affirmative replies now route to Path 3 (no-change), updating `last_checked` and `last_email_response` without touching prices, `last_updated`, or sending an alert. Also updated Rule 2 (diesel_price) in the email prompt to match the web scraping prompt's "NEVER calculate tax yourself, use the HIGHEST number" language. Also replaced the embedded XanoScript in the doc with the currently deployed version, which includes the H4 `$validated` field sourcing that was present in the live endpoint but had drifted from the previous doc version. Seven areas updated in system design doc: (1) Version header: updated from v3.27 to v3.28. (2) Section 7 Email Parsing Prompt: replaced with updated prompt text showing `{price_context}` placeholder, affirmative confirmation rule, and updated diesel Rule 2; added explanatory paragraph about `$price_context` expansion. (3) Section 7 Key Prompt Design Decisions: two new bullets documenting `$price_context` rationale and affirmative confirmation rule. (4) Section 8.5 Function Stack pseudocode: added step 12.1a (`$price_context`); updated step 12.2 description to "date-aware and price-aware". (5) Section 8.5 no-change path (12.5.5) description: added "or affirmative confirmation like 'Yup!'". (6) Section 8.5 Full XanoScript: wholesale replaced with currently deployed production code (includes H4 `$validated` sourcing, `$price_context` variable, and updated system prompt). (7) Section 8.5 Implementation Notes: new learning "Affirmative confirmation context injection (v3.28)" documenting the root cause and two-part fix. |

| March 9, 2026 | 4.0 | React Native / Expo consumer app migration (Step 12). Replaced Adalo consumer app with a native React Native app built with Expo SDK 54, TypeScript, and Expo Router (file-based routing). Developed entirely in Claude Code with Xano MCP server integration for direct backend management. **App architecture:** Four-tab bottom navigation (Price, Nearby, Map, About) using `app/(tabs)/_layout.tsx`. Price tab with Gas/Diesel segmented toggle and FlatList of marinas sorted by price; Nearby tab with location-based sorting via `expo-location`; Map tab with `react-native-maps` MapView showing all marina pins with callout navigation; About tab with app info, pricing note box, privacy policy link, and Navigator branding. Dynamic route `app/marina/[id].tsx` for marina detail screen with full info display, tappable phone/website links, coordinate copy (`expo-clipboard`), GPX waypoint export (`expo-file-system/legacy` + `expo-sharing`), and YouTube button for marinas with video content. **Theming:** Three-font system (PTSans_400Regular, PTSans_700Bold, PTSansNarrow_700Bold) via `expo-font` and `@expo-google-fonts`. Brand colors centralized in `constants/theme.ts`: blue #070531, red #E33500, green #4CD964. **UX features:** WelcomeScreen splash animation on app launch. One-time pricing disclaimer modal on first launch using `@react-native-async-storage/async-storage` (key `hasSeenPricingNote`). Pull-to-refresh on all list screens. Loading spinners and error states with retry. Report Price screen (`app/report-price/[id].tsx`) with price validation and POST to `report_price` endpoint (#47) using `CONSUMER_API_TOKEN`. Privacy Policy screen (`app/privacy-policy.tsx`). **Xano backend changes:** `youtube` column (text, nullable) added to FuelPrices table (table_id 2) for marina YouTube video URLs. `marina_detail` endpoint (#46) output whitelist updated from 20 to 21 fields (added `youtube`). Endpoint now actively used by the React Native app (was retained-but-unused by Adalo). No other backend changes required — all existing consumer API endpoints work unchanged. **GPX export implementation:** Generates GPX 1.1 XML with marina coordinates as a waypoint, writes to `FileSystem.cacheDirectory` via `writeAsStringAsync`, shares via `expo-sharing`. Uses `expo-file-system/legacy` import for Expo SDK 54 compatibility (new File/Directory API replaced the old API). Custom `escapeXml()` utility for safe XML character encoding. **Claude Code + MCP workflow:** Xano MCP server (`xano-fuel-docks`) connected to Claude Code for direct database schema edits, API endpoint updates, and table content management without leaving the IDE. Used for adding the `youtube` column, updating the `marina_detail` field whitelist, and verifying endpoint responses. Ten areas updated in system design doc: (1) Version header: v3.28 → v4.0. (2) Section 1 System Overview: frontend updated from Adalo to React Native/Expo. (3) Section 2 Architecture Evolution: new "March 2026 Architecture (Current)" subsection. (4) Section 3 Technology Stack: React Native/Expo and Claude Code rows added, Adalo marked as replaced. (5) Section 6 Database Schema: `youtube` column documented. (6) Section 7 API Endpoints: `marina_detail` description updated for youtube field and active usage. (7) Section 8.9 H1 Hardening: `marina_detail` noted as 21 fields (others remain 20). (8) Section 9 Step 9: `marina_detail` note updated to "actively used". (9) Section 14 Build Order: comprehensive Step 12 added covering entire React Native migration. (10) Section 16 MCP: Claude Code MCP connection documented. |

| March 9, 2026 | 4.0.1 | Expanded Step 12 "Completed features" section with detailed documentation for three previously under-documented areas. (1) **Gas/Diesel price tabs** (`app/(tabs)/index.tsx`): documented the default landing screen including header text ("Fuel Docks sorted by price"), `FuelTypeToggle` component switching between `getGasPrices()` / `getDieselPrices()`, FlatList with `MarinaListItem` rows, pull-to-refresh, loading/error/empty states, and tap-to-detail navigation. (2) **Nearby tab** (`app/(tabs)/nearby.tsx`): comprehensive documentation of this **new feature not present in the Adalo app**. The Nearby tab is the first consumer of the `gas_prices_by_distance` and `diesel_prices_by_distance` Xano endpoints, which were built during backend development but never used by Adalo. Documented the two-phase loading flow (location permission request via `expo-location` `requestForegroundPermissionsAsync()` → GPS coordinates via `getCurrentPositionAsync()` → distance API call), permission denial handling (persistent error message with no retry button), "Getting your location..." loading subtext, Gas/Diesel toggle reusing cached coordinates, `distance_mi` conditional display in `MarinaListItem` (only appears on Nearby tab), reactive `useEffect` on `[fuelType, location, fetchData]`, error handling with conditional retry button, and pull-to-refresh behavior. (3) **Shared components**: documented `FuelTypeToggle` (segmented control with red `#E33500` active state) and `MarinaListItem` (three display states: open marina with formatted price, closed marina with red closure text, sentinel 9999 showing "N/A"). |

| March 9, 2026 | 4.1 | Database schema and detail screen updates for flexible fuel comments. **Database changes:** (1) Added `gas_comment` text column (nullable) to FuelPrices table — consumer-facing comment displayed below gas price on detail screen. Populated with "ETHANOL FREE" for all 43 marinas where the former `ethanol_free` column was "Yes" via `patchTableContentBySearch`. (2) Added `diesel_comment` text column (nullable) — consumer-facing comment displayed below diesel price. (3) Removed `ethanol_free` column from database — replaced by the more flexible `gas_comment` system that supports arbitrary comment text beyond just ethanol status. **API endpoint changes:** All consumer endpoint field whitelists updated: removed `ethanol_free`, added `gas_comment` and `diesel_comment`. Standard field set increased from 20 to 21 fields; `marina_detail` endpoint (#46) increased from 21 to 22 fields (21 standard + `youtube`). **React Native detail screen changes:** (1) Price card labels ("Gas", "Diesel") changed from `FontFamily.regular` to `FontFamily.bold` for improved visual weight. (2) New `priceComment` style renders `gas_comment`/`diesel_comment` text below each price inside the grey price boxes — bold, `#E33500` (Brand.red), 13px, 4px margin-top. Comments only rendered when non-null. (3) Removed "Ethanol Free" InfoRow from detail screen info section. (4) `Marina` TypeScript interface updated: removed `ethanol_free`, added `gas_comment` and `diesel_comment`. Eight areas updated in system design doc: (1) Version header: v4.0.1 → v4.1. (2) Section 6 Database Schema original fields table: `ethanol_free` row replaced with `gas_comment` and `diesel_comment` rows. (3) Section 6 Step 12 new fields table: `gas_comment` and `diesel_comment` rows added. (4) Section 7 API endpoint table: `marina_detail` description updated to 22 fields. (5) Section 7 Claude AI exclusion note: `ethanol_free` replaced with `gas_comment`/`diesel_comment`. (6) Section 8.9 field whitelist: standard set updated to 21 fields, `marina_detail` to 22. (7) Step 12 "Completed features" detail screen description updated. (8) Step 12 "Completed (Xano backend changes)" section expanded with v4.1 entries. |

| March 9, 2026 | 4.1.1 | Detail screen style refinements and Report Price validation fix. **Detail screen (`app/marina/[id].tsx`):** (1) `priceLabel` style (Gas/Diesel labels) updated: fontSize 15→16, color changed from `#687076` (grey) to `#000000` (black); fontFamily remains `FontFamily.bold` (set in v4.1). (2) `priceComment` style (`gas_comment`/`diesel_comment` text) updated: fontFamily changed from `FontFamily.bold` to `FontFamily.regular` for a lighter visual weight beneath the price values. **Report Price screen (`app/report-price/[id].tsx`):** (3) Added client-side price validation matching the Xano server-side range ($2–$15). Prices outside this range now show a specific alert (e.g. "Diesel price must be between $2.00 and $15.00.") before any network call is made. Previously, out-of-range prices were submitted to Xano, which rejected them with a 400 error, but the app showed only a generic "Failed to submit report" message. (4) Server error messages from Xano are now surfaced to the user: the catch block extracts `e.response.data.message` or `e.response.data.error` and displays it in the alert dialog. The generic message is retained only as a fallback for network failures. Three areas updated in system design doc: (1) Version header: v4.1 → v4.1.1. (2) Step 12 "Completed features" marina detail screen description: updated label styling (bold black 16px) and comment styling (regular-weight). (3) Step 12 "Completed features" Report Price Change description: added client-side validation and server error surfacing notes. |

| March 9, 2026 | 4.2 | Offline mode with local data cache. Added "network-first with cache fallback" architecture so the app works without a data connection — the primary use case for boaters who lose cellular signal on the water. **New dependency:** `@react-native-community/netinfo` installed via `npx expo install` for event-driven network state monitoring. **Four new files created:** (1) `services/cache.ts`: AsyncStorage wrapper with typed cache entries storing data + timestamp per endpoint key. Cache keys: `cache_gas_prices`, `cache_diesel_prices`, `cache_gas_prices_distance`, `cache_diesel_prices_distance`, `cache_closed_marinas`, `cache_marina_detail_${id}`. No TTL/expiration — always prefers fresh data when online, shows whatever is cached when offline. (2) `services/cachedApi.ts`: Network-first API wrappers returning `CachedResult<T>` interface (`{ data, fromCache, cacheTimestamp }`). Generic `withCache<T>()` function wraps each read-only `api.ts` function: tries network → caches on success → falls back to cache on failure → throws "No cached data available" if no cache exists. Functions: `getCachedGasPrices`, `getCachedDieselPrices`, `getCachedGasPricesByDistance`, `getCachedDieselPricesByDistance`, `getCachedClosedMarinas`, `getCachedMarinaDetail`. NOT wrapped: `getMapMarinas` (no offline map support), `reportPrice` (POST requires connectivity). (3) `contexts/NetworkContext.tsx`: React context providing `isOffline`, `cacheTimestamp`, `setOfflineFromCache(timestamp)`, `markOnline()`. Dual-layer offline detection: passive via NetInfo `addEventListener` (catches airplane mode, Wi-Fi disconnect), active via failed API requests calling `setOfflineFromCache()` (handles captive portals, API outages). Auto-clears offline state when NetInfo detects connectivity restored. (4) `components/OfflineBanner.tsx`: Animated red banner (`Brand.red` #E33500 background, white bold text, 50px height). Slides in/out via React Native `Animated.timing` (height 0↔50px, 300ms). Displays "OFFLINE MODE • Data from Xm ago" with 60-second refresh interval computing relative time from `cacheTimestamp`. Placed as first child inside each screen's SafeAreaView. **Six files modified:** (1) `app/_layout.tsx`: wrapped `ThemeProvider` with `<NetworkProvider>` to provide offline state context to entire app. (2) `app/(tabs)/index.tsx`: replaced `getGasPrices`/`getDieselPrices` with `getCachedGasPrices`/`getCachedDieselPrices`; added OfflineBanner; on `fromCache: true` calls `setOfflineFromCache(timestamp)`, on fresh data calls `markOnline()`; auto-refresh on reconnect via `useRef`+`useEffect` pattern tracking `isOffline` transition true→false. (3) `app/(tabs)/nearby.tsx`: same pattern with `getCachedGasPricesByDistance`/`getCachedDieselPricesByDistance`; offline with cached distance data shows stale distances (acceptable since user can pull-to-refresh on reconnect). (4) `app/(tabs)/closed.tsx`: replaced `getClosedMarinas` with `getCachedClosedMarinas`; added OfflineBanner, error state UI with retry button, auto-refresh on reconnect. (5) `app/marina/[id].tsx`: replaced `getMarinaDetail` with `getCachedMarinaDetail`; added OfflineBanner; Report Price Change button disabled when offline (greyed out, text: "Report Price (Offline)"); auto-refresh on reconnect. Refactored `load()` from inside `useEffect` to standalone async function for scope accessibility. (6) `app/report-price/[id].tsx`: replaced `getMarinaDetail` with `getCachedMarinaDetail` for form header display; added OfflineBanner; Submit button disabled when offline with text "You must be online to submit". **Unchanged files:** `services/api.ts` (cachedApi.ts wraps it without modification), `app/(tabs)/map.tsx` (no offline map support — react-native-maps requires connectivity for tile rendering), `app/(tabs)/about.tsx` (static content), all component and type files. **No backend changes:** entirely client-side feature; no Xano endpoints, database schema, or API responses modified. Nine areas updated in system design doc: (1) Version header: v4.1.1 → v4.2. (2) Section 3 Technology Stack: React Native row updated with offline mode mention. (3) Step 12 technology stack: `@react-native-community/netinfo` added, `@react-native-async-storage/async-storage` description expanded. (4) Step 12 app structure table: six file descriptions updated with (v4.2) annotations. (5) New "Offline cache layer (v4.2)" subsection with table documenting the four new files. (6) Step 12 completed features: new "Offline mode with local data cache" bullet with full architecture description. (7) Step 12 key implementation notes: three new notes on cache architecture, auto-refresh pattern, and no-backend-changes. (8) Step 12 header version range updated to v4.0–v4.2. (9) Document history: this entry. |

| March 9, 2026 | 4.3 | Location-aware 75-mile cache radius. Added client-side cache filtering so only marinas within 75 miles of the user are stored in the offline cache, while online users continue to see all marinas. This prepares the app for nationwide expansion where caching the full dataset would be wasteful. **Two new files created:** (1) `utils/geo.ts`: Haversine distance calculation between two lat/lng coordinate pairs, returning distance in miles. Pure function with ~15 lines of code. (2) `contexts/LocationContext.tsx`: React context providing shared GPS state (`location`, `locationPermission`, `isLoadingLocation`). Requests `expo-location` foreground permission once on mount via `requestForegroundPermissionsAsync()`. Replaces duplicate location code that was previously in `nearby.tsx` and `map.tsx`. Consumed via `useLocation()` hook. **One file significantly modified:** `services/cachedApi.ts`: Generic `withCache<T>()` function gains an optional `cacheFilter` parameter — a callback applied to the data before writing to AsyncStorage while the full unfiltered data is returned to the calling screen. New `filterMarinasByRadius()` helper uses `haversineDistanceMiles()` to filter marina arrays. New `marinaCacheFilter()` builder creates the filter when user coordinates are available. All five marina-list functions (`getCachedGasPrices`, `getCachedDieselPrices`, `getCachedGasPricesByDistance`, `getCachedDieselPricesByDistance`, `getCachedClosedMarinas`) gain optional `latitude`/`longitude` parameters. `getCachedMarinaDetail` unchanged (always caches regardless of distance). `CACHE_RADIUS_MILES` constant set to 75. **Five files modified with minor changes:** (1) `app/_layout.tsx`: `<LocationProvider>` wrapper added inside `<NetworkProvider>`. (2) `app/(tabs)/index.tsx`: imports `useLocation()`, passes `location?.latitude`, `location?.longitude` to cached API calls, adds `location` to `useEffect` dependency arrays. (3) `app/(tabs)/closed.tsx`: same pattern as index.tsx. (4) `app/(tabs)/nearby.tsx`: removed local `expo-location` import and permission/coordinate code (~10 lines); replaced with `useLocation()` from shared context; added `useEffect` for permission-denied error state. (5) `app/(tabs)/map.tsx`: removed local `expo-location` import and permission/coordinate code; replaced with `useLocation()` from shared context; map centering responds to location changes via separate `useEffect`. **No Xano backend changes.** No `services/api.ts` changes. **Fallback behavior:** If GPS location is unavailable (permission denied or not yet resolved), `cacheFilter` is `undefined` and the full dataset is cached (identical to v4.2 behavior). Nine areas updated in system design doc: (1) Version header: v4.2 → v4.3. (2) Step 12 header version range: v4.0–v4.2 → v4.0–v4.3. (3) Step 12 app structure table: six file descriptions updated with (v4.3) annotations. (4) Step 12 offline cache layer table: `cachedApi.ts` description updated with `cacheFilter` and optional lat/lng parameters. (5) New "Location-aware caching (v4.3)" subsection with table documenting two new files and architecture description. (6) Step 12 completed features: new "Location-aware 75-mile cache radius" bullet. (7) Step 12 key implementation notes: new note on client-side cache filtering architecture. (8) Document history: this entry. |

| March 10, 2026 | 4.4 | Marina detail pre-caching and offline UI enhancements. **Marina detail pre-caching (services/cachedApi.ts):** Fixed marina detail pages not loading in offline mode. Previously, individual marina details were only cached when the user explicitly visited a detail page while online — browsing a list and going offline meant tapping into any marina would fail with "No cached data available." Root cause: list responses were cached as complete arrays under keys like `cache_gas_prices`, but the detail screen looked for separate `cache_marina_detail_{id}` keys that didn't exist. Fix: Added `preCacheIndividualMarinas()` helper that iterates over a marina list and calls `setCache()` for each marina under its own `cache_marina_detail_{id}` key. New `withCacheAndPreCacheDetails()` wrapper calls this fire-and-forget after `withCache()` succeeds with fresh data. All five marina-list functions (`getCachedGasPrices`, `getCachedDieselPrices`, `getCachedGasPricesByDistance`, `getCachedDieselPricesByDistance`, `getCachedClosedMarinas`) now use `withCacheAndPreCacheDetails` instead of `withCache` directly. `getCachedMarinaDetail` unchanged — it naturally finds the pre-cached data on fallback. **Map tab offline behavior ( pp/(tabs)/_layout.tsx):** Map tab icon and label now grey out when offline. Icon color changes to `#ccc`, label turns grey via `tabBarLabelStyle`, opacity reduced to 0.4 via Pressable wrapper with `onPress={undefined}` to suppress taps. Added `Pressable` import from react-native and `useNetwork` hook from NetworkContext. When online, the tab reverts to normal `HapticTab` behavior. **Map screen offline message ( pp/(tabs)/map.tsx):** Added `useNetwork` import and `isOffline` check. When offline, the screen returns a SafeAreaView with centered text: "Map does not work when your device is not connected to the internet." This check runs before the loading state check. **About screen styling ( pp/(tabs)/about.tsx):** Centered text in the orange pricing disclaimer box (added `textAlign: 'center'` to `pricingNote` style). Increased padding around all edges from 16px to 24px in `pricingBox` style. **Offline banner color (components/OfflineBanner.tsx):** Changed banner background color from `Brand.red` (#E33500) to `#FF0000` (pure red) for higher visibility. **No backend changes.** Ten areas updated in system design doc: (1) Version header: v4.3 → v4.4. (2) Step 12 header version range: v4.0–v4.3 → v4.0–v4.4. (3) Step 12 app structure table: `_layout.tsx`, `map.tsx`, `about.tsx` descriptions updated with (v4.4) annotations. (4) Step 12 offline cache layer table: `cachedApi.ts` description updated with `withCacheAndPreCacheDetails` and pre-caching behavior. (5) `OfflineBanner.tsx` description: color updated to `#FF0000`. (6) Step 12 completed features: three new bullets (marina detail pre-caching, Map tab offline behavior, UI refinements). (7) Step 12 offline mode bullet: updated NOT offline-enabled note for Map tab with greyed-out behavior. (8) Step 12 key implementation notes: new note on marina detail pre-caching architecture. (9) Document history: this entry. |

| March 11, 2026 | 4.5 | API retry logic, YouTube video thumbnail, and UI refinements. **API retry logic (`services/cachedApi.ts`):** Added `fetchWithRetry()` function that retries transient API failures up to 2 times with 1-second delay between attempts before falling back to cache. Root cause: a tester encountered an error on the Diesel tab on first launch — the API call failed transiently (e.g., server cold start) and no cache existed yet. Added constants `MAX_RETRIES = 2` and `RETRY_DELAY_MS = 1000`. Modified `withCache()` to call `fetchWithRetry(fetcher)` instead of `fetcher()` directly, so all cached endpoints benefit automatically. **YouTube video thumbnail (`app/marina/[id].tsx`):** Replaced the red YouTube button (`#FF0000` background with `logo-youtube` Ionicon) with a 16:9 video thumbnail image. New `getYouTubeVideoId()` helper extracts the 11-character video ID from YouTube URLs via regex (handles both `v=` and `youtu.be/` patterns). Thumbnail image fetched from `https://img.youtube.com/vi/{videoId}/hqdefault.jpg`. Semi-transparent dark overlay (`rgba(0,0,0,0.25)`) with centered white play circle icon (Ionicons `play-circle`, 56px, `rgba(255,255,255,0.9)`). `Image` added to React Native imports. New styles: `youtubeThumbnail` (borderRadius 8, overflow hidden), `youtubeThumbnailImage` (full width, 16:9 aspect ratio), `youtubePlayOverlay` (absoluteFill, centered). Old styles `youtubeButton` and `youtubeText` removed. **Export GPX button color (`app/marina/[id].tsx`):** Changed from `#E33500` (red) to `#070531` (dark navy/Brand.blue) for visual consistency with the app's primary brand color. **Offline banner height reduction (`components/OfflineBanner.tsx`):** Animated banner height reduced from 50px to 36px (`toValue: isOffline ? 36 : 0`). Makes the offline indicator less visually dominant while remaining clearly visible. **About page styling (`app/(tabs)/about.tsx`):** (1) `appName` fontSize: 28→32. (2) `tagline` fontFamily: `FontFamily.regular`→`FontFamily.bold`. (3) `pricingNote` fontSize: 15→18, lineHeight: 22→24. (4) `privacyLink` added `marginTop: 12` for spacing above Privacy Policy link. **Build 10 published to iOS TestFlight** (v2.0.0, Build 10). Android build pending Google Play Service Account Key configuration. **No Xano backend changes.** Eleven areas updated in system design doc: (1) Version header: v4.4 → v4.5. (2) Step 12 header version range: v4.0–v4.4 → v4.0–v4.5. (3) Step 12 app structure table: `marina/[id].tsx` description updated with YouTube thumbnail and GPX button color. (4) Step 12 app structure table: `about.tsx` description updated with v4.5 styling changes. (5) Step 12 offline cache layer table: `cachedApi.ts` description updated with retry logic. (6) `OfflineBanner.tsx` description: height updated from 50px to 36px. (7) Step 12 completed features: YouTube button replaced with thumbnail description; GPX export button color noted. (8) Step 12 completed features: six new bullets (API retry logic, offline banner height, Export GPX color, YouTube thumbnail, About page styling, build status). (9) Step 12 key implementation notes: new note on API retry architecture. (10) Document history: this entry. |

| March 11, 2026 | 4.6 | FD Dialer push notification badge updates. Added silent push notifications so the FD Dialer app's home screen badge shows the current count of marinas due for a call, updated every 15 minutes without requiring the user to open the app. **Xano backend (3 new objects):** (1) `dialer_push_tokens` table (ID 36) created with `expo_push_token` text field and unique index — simple flat table with no user association since the call queue is shared across all users. (2) `register_push_token` endpoint (POST #51) in Fuel Docks API group — accepts `api_token` and `expo_push_token`, validates against `DIALER_API_TOKEN`, upserts token (insert if not exists, leverages unique index for duplicate prevention). (3) `push_badge_update` Background Task (#7, every 15 minutes) — calls existing `call_queue` endpoint internally to get the due marina count, queries all tokens from `dialer_push_tokens`, POSTs to `https://exp.host/--/api/v2/push/send` with silent push payload (`badge: <count>`, `sound: null`, `_contentAvailable: true`), and handles expired tokens by checking Expo Push API response tickets for `DeviceNotRegistered` errors and removing those tokens from the table. **React Native FD Dialer app (3 files modified):** (1) `app.json`: added `expo-notifications` to plugins array. (2) `app/_layout.tsx`: added push token registration on app startup — requests notification permissions, gets Expo push token via `getExpoPushTokenAsync()` with EAS project ID, sends to Xano via `/register_push_token`, caches token in AsyncStorage to avoid redundant registration on subsequent launches. (3) `services/api.ts`: added `registerPushToken()` function. EAS Build 17 (v1.1.0) submitted to iOS TestFlight. **System design doc updates (10 areas):** (1) Version header: v4.5 → v4.6. (2) Section 2 Architecture: added FD Dialer migration note. (3) Section 3 Tech Stack: Adalo row updated to "Fully retired" (both consumer app and FD Dialer migrated to React Native/Expo). (4) Section 4.3 FD Dialer description: changed from "Adalo app" to "React Native/Expo app" with push notification badge details. (5) Section 6 Database Schema: added `dialer_push_tokens` table. (6) Section 7 API Endpoints: added `register_push_token` #51. (7) Section 9.7 `daily_call_report`: updated "Why This Exists" — badge limitation now resolved, email remains as complementary overnight summary. (8) New Section 9.8: `register_push_token` endpoint detail with full XanoScript. (9) New Section 9.9: `push_badge_update` background task detail with full XanoScript. (10) Section 21 Background Tasks table: added `push_badge_update` #7. (11) New Step 13 in Build Order: FD Dialer Push Notification Badge — COMPLETE (v4.6). (12) Step 12 version range updated to v4.0–v4.6. |

| March 11, 2026 | 4.7 | Privacy policy updated from June 2025 to March 2026. The original policy (written before distance sorting, Report Price, offline caching, and Google Maps integration) contained several inaccurate claims, most notably that location data was "only used locally" and "not transmitted." Xano request history confirmed that GPS coordinates, IP addresses, and User-Agent strings are logged for every API call. **Nine sections rewritten or added:** (1) Section 1 location bullets: replaced "only used locally...not transmitted" with accurate disclosure that GPS coordinates are sent to Xano (distance sort) and Google (maps) and may appear in server request logs. (2) Section 1 PII bullet: changed to "We do NOT require accounts, logins, or registration" (more precise than blanket "no personal information" claim). (3) New Section 1 subsection "User-Submitted Price Reports": discloses Report Price feature data flow, advises users not to include personal information in the comments field, and discloses that any voluntarily-included PII will be retained in server logs and email records. (4) New Section 1 subsection "On-Device Data Storage": discloses AsyncStorage offline cache (marina data, first-launch pricing disclaimer flag). (5) New Section 1 subsection "Server Logs": discloses IP address, User-Agent, timestamps, and GPS coordinates in Xano request history. (6) Section 2: expanded from "enhance user experience" to four specific uses (distance sorting, price verification, offline access, security monitoring). (7) Section 3: replaced "does not share data with third-party services" with disclosure of Google Maps and Xano, affirming no advertising/analytics/tracking. (8) Section 4: added Report Price Change choice, updated Uninstalling bullet to mention cached data clearing. (9) Section 5: replaced "no risk" statement with honest security posture (HTTPS, token auth, rate limiting, no absolute guarantee). (10) New Section 7 "Children's Privacy" added (COPPA-style, standard for App Store compliance). (11) Sections 7-8 renumbered to 8-9; Changes to Policy section now references "Last Updated" date and About screen. **App update required:** The privacy policy lives in `app/privacy-policy.tsx` as static text in the React Native consumer app. Updating requires replacing the file content and publishing a new build via EAS/TestFlight. **No Xano backend changes.** |

| March 11, 2026 | 4.8 | Privacy policy additions based on GasBuddy gap analysis and Xano log retention research. **Data retention (Section 1, Server Logs subsection):** Confirmed via Xano MCP and official Xano documentation that API request history is retained for 24 hours and background task history for 7 days. Appended three sentences disclosing these retention periods. **New Section 7 (State Privacy Rights):** Brief CCPA acknowledgment explaining that because the app does not collect personally identifying information, most state privacy rights do not apply. **New Section 8 (Do Not Track):** Affirmative statement that the app does not track users across third-party sites. **New Section 11 (Governing Law):** Washington state governing law clause. **Renumbering:** Total sections increased from 9 to 12. **App update required** alongside the v4.7 changes. **No Xano backend changes.** |

| March 12, 2026 | 4.9 | Price disclaimer footer added to Price and Nearby tabs. **New file created:** `components/PriceDisclaimerFooter.tsx` — fixed red banner (`Brand.red` #E33500 background, white text) displaying truncated "Prices are regularly updated but not realtime…" with underlined "Tap here" link. Tapping opens a React Native Modal dialog with the full disclaimer in bold (`Brand.blue` color, `FontFamily.bold`) and a body paragraph about informational use and liability. "I understand" button permanently dismisses the footer via AsyncStorage (`price_disclaimer_dismissed` key). Uses `useState<boolean | null>(null)` for three-state initialization (null = loading, true = dismissed, false = show). AsyncStorage `.getItem()` and `.setItem()` both wrapped in `.catch(() => {})` to prevent silent component crashes from unhandled promise rejections. **Two files modified:** (1) `app/(tabs)/index.tsx`: `<PriceDisclaimerFooter />` placed between `<FlatList />` and `</SafeAreaView>` closing tag. (2) `app/(tabs)/nearby.tsx`: same placement pattern. **Key architectural decision:** The footer is placed *outside* the FlatList as a fixed sibling element, NOT as `ListFooterComponent`. `ListFooterComponent` renders at the end of scrollable content — with many list items it scrolls off-screen and hides behind the tab bar. Placing outside FlatList makes it a fixed bar always visible above the tab bar. **No Xano backend changes.** Seven areas updated in system design doc. |

| March 14, 2026 | 4.10 | Android UI parity and Terms of Service. **New file created:** `app/terms-of-service.tsx` — static Terms of Service screen with safety warning box (yellow `#FFF8E1` background, dark goldenrod `#8B6914` bold uppercase text warning against using the app while operating watercraft/vehicles). Stack screen with header title "Terms of Service". Linked from About screen below Privacy Policy. **Android SafeAreaView fix:** Privacy Policy and Terms of Service screens changed from default `SafeAreaView` to `edges={['bottom', 'left', 'right']}`. On Android, the default SafeAreaView added extra top padding below the Stack navigator header, creating a visible gap between header and content. Excluding the `'top'` edge eliminates this because the Stack header already handles top safe area insets. **Map callout bubbles restored:** Replaced direct `Marker onPress` navigation (which skipped the callout bubble) with `Callout` component wrapping marina name, gas/diesel prices, and "Tap for details" link. `Callout onPress` navigates to marina detail. Uses `tooltip={false}` to force native callout rendering on Android (without this, custom Callout content may not render). Callout styles: title 14px bold, prices 13px #687076, tap link 11px `Brand.blue`. **About screen updates:** App icon enlarged from 100x100 to 140x140. Terms of Service link added below Privacy Policy with matching underlined style. **WelcomeScreen positioning:** Splash screen layout adjusted so app icon sits higher and Navigator logo/copyright footer sits lower on Android, matching iOS layout. **Android EAS submit configuration:** Added `production` submit profile in `eas.json` with `track: "internal"` for Google Play Store submissions. **No Xano backend changes.** Eight areas updated in system design doc. |

| March 14, 2026 | 4.11 | UI polish, copy updates, and build number display. **Tagline update:** Changed from "Boat fuel prices for the Puget Sound" to "Marina fuel prices at your fingertips" in both `components/WelcomeScreen.tsx` and `app/(tabs)/about.tsx`. **Disclaimer text update:** All pricing disclaimer text updated to "All prices include tax. Volume discounts are not reflected and may lower your final cost. Prices are updated regularly but not in realtime, so call the fuel dock to confirm before you go." Applied to three locations: one-time pricing modal in `app/_layout.tsx`, About screen red pricing box, and PriceDisclaimerFooter modal dialog. **Build number display:** Version now shows build number, e.g., "Version 2.0.0 (310)". Uses `Platform.OS` to read iOS `buildNumber` or Android `versionCode` from `expo-constants`. Added `Platform` import to both `components/WelcomeScreen.tsx` and `app/(tabs)/about.tsx`. **About screen title styling:** App name changed from "Fuel Docks" (32px `FontFamily.bold`) to "FUEL DOCKS" (40px `FontFamily.title` with `letterSpacing: 1`). **WelcomeScreen version repositioning:** Version/build number moved from bottom section (next to copyright) to top section under the tagline. Styled in `Brand.red`, fontSize 14, marginTop 8. **About screen disclaimer section:** New bordered card added below Terms of Service link with bold `Brand.blue` title and body paragraph about informational use and liability — content previously only accessible via the PriceDisclaimerFooter modal. **Footer bar redesign (`components/PriceDisclaimerFooter.tsx`):** Redesigned from two-part layout (truncated text + separate "Tap here" link) to single centered underlined text: "Tap here for details on how prices are captured." Entire bar wrapped in `TouchableOpacity` (previously `View` with nested `TouchableOpacity`). Modal body paragraph removed (title-only). "I understand" button color changed from `Brand.blue` to `Brand.red` (#E33500). **Tab bar padding:** Added `paddingTop: 2` to `tabBarStyle` in `app/(tabs)/_layout.tsx` for 2px spacing between divider line and tab icons. **Android Build 310 published** to Google Play internal track (versionCode 310, v2.0.0). **No Xano backend changes.** Twelve areas updated in system design doc. |

| March 14, 2026 | 4.12 | UI fixes, shared disclaimer state, map info card, copy refinements, Android Build 312. **One-time interstitial modal removed** from `app/_layout.tsx` — the Modal that displayed on first app launch with "Got it" button and `hasSeenPricingNote` AsyncStorage key was deleted entirely. Pricing disclaimer is now accessible only via the PriceDisclaimerFooter tap-to-open modal on Price and Nearby tabs. **New file created:** `contexts/DisclaimerContext.tsx` — React Context providing shared dismissed state (`dismissed: boolean | null`, `dismiss()`) so that dismissing the PriceDisclaimerFooter on either the Price or Nearby tab dismisses it on both. Previously each PriceDisclaimerFooter instance had independent local `useState`/`AsyncStorage` state — dismissing on one tab left the footer visible on the other (bug discovered in Build 312). `DisclaimerProvider` added to root layout wrapping the app inside `LocationProvider`. **Map native Callout replaced with custom info card:** Android Google Maps renders custom React Native Callout content as static bitmaps, causing text clipping that could not be fixed with sizing, `tooltip` prop, or explicit dimensions. Replaced `Callout` component entirely with a custom absolutely-positioned `TouchableOpacity` info card overlay at the bottom of the map (`position: 'absolute', bottom: 24, left: 16, right: 16`, white background, `borderRadius: 12`, elevation shadow). Card shows marina name (16px bold), gas/diesel prices or "Closed" status, and "Tap for details" link (`Brand.blue`). Tapping the card navigates to marina detail via `router.push`. Tapping the map background dismisses the card via `MapView onPress={() => setSelectedMarina(null)}`. `Callout` import removed from `react-native-maps`. **About screen layout reorder:** Privacy Policy and Terms of Service links moved above the orange pricing box (previously below). Orange box text trimmed to two sentences ("All prices include tax. Volume discounts are not reflected and may lower your final cost." — third sentence moved to disclaimer section title). Spacing: `pricingBox marginTop: 32`, `disclaimerSection marginTop: 0`. **Disclaimer body text refined** in both `PriceDisclaimerFooter.tsx` modal and `about.tsx` disclaimer section: "regularly" → "often", "is not responsible" → "cannot be held responsible". Full body text: "This app is for informational purposes only. Each fuel dock reports its own prices, and we check in with them often. The date of the last update is shown for each location. If a listing hasn't been updated recently, it means we haven't been able to reach that fuel dock. Navigator PNW LLC cannot be held responsible for pricing accuracy, as prices may change before this app can acquire an update." **PriceDisclaimerFooter modal updated:** Now uses `useDisclaimer()` from shared context instead of local state. Modal dialog displays three-paragraph bold title (tax / volume discounts / call to confirm) with body paragraph restored below (previously removed in v4.11 redesign). **Android Build 312 published** to Google Play internal track (versionCode 312, v2.0.0, EAS auto-bumped from 311). **No Xano backend changes.** Thirteen areas updated in system design doc: (1) Version header: v4.11 → v4.12. (2) App structure table: `_layout.tsx` updated (modal removed, DisclaimerProvider added). (3) `map.tsx` description updated (custom info card replaces Callout). (4) `about.tsx` description rewritten (layout reorder, text changes). (5) Offline cache layer table: `PriceDisclaimerFooter.tsx` updated (shared context, modal body). (6) New `DisclaimerContext.tsx` row added. (7) Completed features: one-time modal marked removed, About pricing box updated, map callout rewritten as info card. (8) Disclaimer text, About disclaimer section, footer bar bullets updated. (9) Five new completed feature bullets (layout reorder, shared context, modal body restored, Android Build 312). (10) Key implementation note updated (shared context). (11) Document history: this entry. |

| March 14, 2026 | 4.13 | Marina detail layout redesign and disclaimer modal scroll. **Disclaimer modal scrollable:** PriceDisclaimerFooter modal dialog content wrapped in `ScrollView` with `maxHeight: '34%'` on dialog container. Only bold title paragraphs visible on initial open; user scrolls to read body text and reach "I understand" button. **Marina detail layout redesign (`app/marina/[id].tsx`):** (1) Coordinates moved from top section into the info table as the last row (after Volume Discount). Copy icon repositioned inline immediately after longitude digits (`marginLeft: 4`, previously right-justified to margin). (2) Map and Export GPX buttons moved from top section to side-by-side buttons below info table (`flexDirection: 'row'`, `gap: 12`, each `flex: 1`). Map button navigates to `/map-view/{id}`. (3) "Report Price Change" full-width outlined button removed from actions section. Replaced with compact inline "Report Change" button (13px bold `Brand.blue`, `borderWidth: 1.5`, `borderRadius: 6`, `paddingVertical: 4`, `paddingHorizontal: 10`) on the "Last updated" row via `justifyContent: 'space-between'`. Shows "Offline" when offline. (4) Spacing refinements: city `marginTop: 1` (tighter to name), section `paddingTop: 9` (reduced from 14), actions `marginTop: 10` (reduced from 16). **No Xano backend changes.** Nine areas updated in system design doc: (1) Version header: v4.12 → v4.13, file renamed to `fuel_docks_system_design_v4_13.md`. (2) App structure table: `marina/[id].tsx` description rewritten (coordinates in table, inline buttons, compact report). (3) Offline cache layer table: `PriceDisclaimerFooter.tsx` updated (scrollable modal). (4) Completed features: Marina detail screen bullet rewritten. (5) Coordinate copy bullet updated (inline positioning). (6) GPX export bullet updated (side-by-side with Map). (7) Report Price Change bullet rewritten (compact inline button). (8) Three new completed feature bullets (scrollable modal, layout redesign, spacing refinements). (9) Offline mode bullet updated (Report Change text). (10) Document history: this entry. |

| March 14, 2026 | 4.14 | Platform-specific map callouts, report screen updates. **Platform-specific map pin interaction (`app/(tabs)/map.tsx`):** iOS now uses native `Callout` component (`tooltip={false}`) with marina name, prices, and "Tap for details" link — renders correctly on Apple Maps. Android continues to use the custom info card overlay at the bottom of the map (v4.12) to avoid Google Maps bitmap rendering bug. `Platform.OS` checks gate the `Marker onPress` handler (Android only) and `Callout` child component (iOS only). `Callout` import restored from `react-native-maps` alongside `Platform` import from `react-native`. iOS callout styles: `calloutContainer` (width 220, padding 8), `calloutTitle` (14px bold), `calloutPrice` (13px #687076), `calloutClosed` (13px bold `Brand.red`), `calloutTap` (11px `Brand.blue`). **Report screen title renamed** from "Report Price Change" to "Report Change" in `_layout.tsx` Stack screen options, matching the compact button text on the marina detail screen (v4.13). **Report screen notice text updated** (`app/report-price/[id].tsx`): Maroon notice box reworded from "Prices shown in this app are for the first gallon before volume discounts, with applicable taxes added. If fuel dock signs show a pre-tax price, that may explain why you see a difference." to "PLEASE NOTE: All prices include tax. If the fuel dock has signage that shows a pre-tax price, it may explain why it does not match the app." followed by line break and "The prices shown in this app do not have volume discounts applied." **No Xano backend changes.** Seven areas updated in system design doc: (1) Version header: v4.13 → v4.14, file renamed to `fuel_docks_system_design_v4_14.md`. (2) App structure table: `map.tsx` description rewritten (platform-specific behavior). (3) `report-price/[id].tsx` description updated (title, notice text). (4) Completed features: map pin interaction bullet rewritten (platform-specific). (5) Three new completed feature bullets (platform callouts, report rename, notice text). (6) Document history: this entry. |

| March 15, 2026 | 4.15 | One-time GPX export tooltip on marina detail screen. **New feature added to `app/marina/[id].tsx`:** Orange speech bubble tooltip (`#D84315` background, 21px bold white `FontFamily.bold` text) appears above the Export GPX button the first time a user visits any Fuel Dock Details screen. Text: "Use this button to export to your Boat Navigation app." Downward-pointing triangular notch (15px CSS border triangle) points at the Export GPX button. Tapping the tooltip dismisses it permanently via AsyncStorage (`gpxTipShown` key). Tooltip positioned with absolute offsets (`left: -180`, `right: 14`, `marginBottom: 7`) to span the full button row width. `borderRadius: 10`, `paddingVertical: 12`, `paddingHorizontal: 16`. Tooltip only renders after marina data loads (gated by `[marina]` useEffect dependency). Export GPX button wrapped in an additional `<View style={{ flex: 1 }}>` container to serve as the positioning parent for the absolutely-positioned tooltip. `AsyncStorage` import added (already a project dependency from `DisclaimerContext`). **No Xano backend changes.** Four areas updated in system design doc: (1) Version header: v4.14 → v4.15, file to be renamed to `fuel_docks_system_design_v4_15.md`. (2) Marina detail screen bullet: added GPX tooltip mention. (3) New completed feature bullet for one-time GPX export tooltip. (4) Document history: this entry. |

| March 15, 2026 | 4.16 | In-app detail map screen. **New file created:** `app/marina/map.tsx` — in-app map screen showing a single fuel dock pin on a native `react-native-maps` MapView. Launched from the marina detail screen's "Map" button, which previously opened the device's native maps app (Apple Maps / Google Maps) via `Linking.openURL`. The new screen receives marina data (id, fuel_dock, latitude, longitude, gas_price, diesel_price, open, City) via Expo Router route params — no API call needed. Uses the same platform-specific pin interaction as the bottom nav map: iOS shows native `Callout` bubble (marina name, prices, "Tap for details"); Android shows custom info card overlay at the bottom of the map. Tapping callout/card navigates to marina detail. Map centered on marina with `latitudeDelta: 0.05` / `longitudeDelta: 0.05`. `showsUserLocation` enabled. Open pins use `Brand.blue`, closed pins use `#999`. **Two files modified:** (1) `app/_layout.tsx`: added `marina/map` Stack screen with title "Map" and `headerBackTitle: 'Back'`. (2) `app/marina/[id].tsx`: Map button changed from `Linking.openURL` (native maps) to `router.push({ pathname: '/marina/map', params: {...} })` with marina data as route params. `Platform` import removed (no longer needed). **No Xano backend changes.** Six areas updated in system design doc: (1) Version header: v4.15 → v4.16, file to be renamed to `fuel_docks_system_design_v4_16.md`. (2) Step 12 version range: v4.0–v4.6 → v4.0–v4.16. (3) App structure table: `_layout.tsx` updated (marina/map Stack screen listed), `marina/[id].tsx` updated (Map button navigates to in-app screen), new `marina/map.tsx` row added. (4) Marina detail screen completed feature bullet updated (Map button change noted). (5) New completed feature bullet for in-app detail map screen. (6) Document history: this entry. |

| March 16, 2026 | 4.17 | Privacy policy update and location permission prompt improvement. **Privacy Policy updated:** Added new "Automatic Data Deletion" subsection under Server Logs in Section 1, documenting that personal information is deleted automatically through log retention cycles and no manual deletion request is necessary. Last Updated date changed from March 11, 2026 to March 16, 2026. Updated in three places: `app/privacy-policy.tsx` (in-app), standalone Word document (new file `Fuel_Docks_privacy_policy_16MAR2026.docx`). Motivated by data privacy risk analysis covering Washington state privacy laws (My Health My Data Act, Consumer Protection Act) and CCPA-readiness for future national scale — documents that the app's no-accounts, 24-hour-log-retention architecture satisfies deletion requirements by default. **Location permission prompt strings updated** in `app.json`: changed from "Fuel Docks uses your location to find nearby marinas and fuel prices." to "Fuel Docks uses your location to sort marinas by distance. Your coordinates are not stored." Applied to both `NSLocationWhenInUseUsageDescription` (iOS infoPlist) and `locationWhenInUsePermission` (expo-location plugin). More specific purpose statement and explicit privacy assurance, which Apple prefers for App Store review. Takes effect on next native build. **No Xano backend changes.** Five areas updated in system design doc: (1) Version header: v4.16 → v4.17, file to be renamed to `fuel_docks_system_design_v4_17.md`. (2) App structure table: `privacy-policy.tsx` description updated (Automatic Data Deletion subsection, date). (3) LocationContext description updated (permission prompt string documented). (4) Two new completed feature bullets (privacy policy update, location permission prompt). (5) Document history: this entry. |

| March 16, 2026 | 4.18 | Legal field and TOS review. **New database field:** `legal` (text, nullable) added to FuelPrices table after `website`. Tracks legal restrictions that affect how a marina can be monitored. Defined values: `DNC` (Do Not Call — marina explicitly told us not to call), `TOS no scrape` (website Terms of Service prohibit automated scraping), empty/null (no known restrictions). **Rosario Resort (id=24):** Method changed from "DNC" to "Call"; DNC restriction moved to the new `legal` field. **TOS review of all scraped marina websites:** All Method = "HTML" (11 marinas) and Method = "Javascript" (6 marinas) websites reviewed for Terms of Service, Privacy Policy, and robots.txt scraping restrictions. Three marinas flagged `TOS no scrape`: Skyline Marine Center (id=18) — skylinemarinecenter.com TOS prohibits software robots, spiders, and crawlers; Seattle Boat Lake Union (id=21) and Seattle Boat Newport (id=22) — seattleboat.com TOS prohibits robots, spiders, scraping, data mining, and any commercial use of content. All other scraped sites cleared: government/public port sites (Port of Anacortes, Port of Everett, Oak Harbor, Port of Edmonds, Swantown/Port of Olympia, Port of Brownsville, Port of Kingston) had no TOS; private marina sites (Des Moines Marina, Foss Harbor, Semiahmoo, Blakely Island, Tacoma Fuel Dock, Point Roberts Marina, Port of Poulsbo) had no TOS or terms that did not restrict scraping. Port of Poulsbo website (portofpoulsbo.com) confirmed as a Wix site with no TOS — the Facebook URL in the website field is for price scraping but Facebook's TOS prohibits scraping (noted but not flagged since the marina has its own domain). **New section added:** "Legal Field Values" table with value definitions, current assignments, and TOS review summary. Three areas updated in system design doc: (1) Version header: v4.17 → v4.18. (2) Database schema: `legal` field added after `website` in existing fields table. (3) New "Legal Field Values" section added after Method Field Values migration note. (4) Document history: this entry. |

| March 16, 2026 | 4.19 | DNC (Do Not Call) filter added to `call_queue` endpoint. **`call_queue` endpoint (#42) updated:** New "Filter 0: DNC" added as the first check inside the foreach loop, before snooze, recheck_date, suspend_until, and cadence filters. Any marina with `legal == "DNC"` is immediately excluded from the call queue. Positioned as Filter 0 because DNC is an absolute exclusion and no other filter logic matters for marinas that have told us not to call. Triggered by Rosario Resort (id=24) appearing in FD Dialer despite having `legal` set to `"DNC"`. Filter count increased from four to five (six total conditions including the Method WHERE clause). XanoScript block in Section 8.6 replaced with current published version, which also reflects the DIALER_API_TOKEN dual-auth precondition (previously only FD_API_TOKEN in the doc). Function Stack pseudocode renumbered: DNC is 6.3 (Filter 0), snooze becomes 6.4 (Filter 1), recheck 6.5 (Filter 2), suspend 6.6 (Filter 3), cadence 6.7 (Filter 4), price formatting 6.8. New implementation note added for DNC filter. **PARITY GAP flagged:** `daily_call_report` background task (#6) still uses four-filter logic and does not yet include the DNC exclusion. DNC marinas may still appear in the daily email until the task is updated. Parity gap noted in three locations: daily_call_report background task table row, daily_call_report detail section filter parity note, and second background task summary table row. **No Expo app changes. No new database fields.** Six areas updated in system design doc: (1) Version header: v4.18 to v4.19. (2) `call_queue` API table row: five conditions to six, DNC noted, DIALER_API_TOKEN added. (3) Section 8.6 Function Stack pseudocode: Filter 0 DNC added, steps renumbered. (4) Section 8.6 XanoScript block: wholesale replacement with published version. (5) Section 8.6 Implementation Notes: DNC filter note added. (6) `daily_call_report` parity gap flagged in three locations. (7) Document history: this entry. |

| March 16, 2026 | 4.20 | Tagline update and build number removal. **Tagline changed** from "Marina fuel prices at your fingertips" to "Compare marina fuel prices" in both `components/WelcomeScreen.tsx` (splash screen) and `app/(tabs)/about.tsx` (About screen). Previous tagline could not be used. **Build number removed from display** in both screens. Version now shows "Version 2.0.0" instead of "Version 2.0.0 (23)". `buildNumber` variable and `Platform` import removed from both files (no longer needed). **No Xano backend changes.** Six areas updated in system design doc: (1) Version header: v4.19 → v4.20. (2) App structure table: `about.tsx` description updated (new tagline, build number removed). (3) Welcome splash screen bullet updated (new tagline, build number removed). (4) Tagline update bullet updated (new tagline text). (5) Build number display bullet updated (removed). (6) WelcomeScreen version repositioning bullet updated (build number removed). (7) Document history: this entry. |

| March 16, 2026 | 4.21 | GPX export tooltip dismiss hint. **Added "TAP HERE TO REMOVE" text** to the one-time GPX export tooltip bubble on the marina detail screen (`app/marina/[id].tsx`). New `<Text>` element rendered below the main tooltip message and above the arrow, styled as `gpxTipDismiss`: 13px bold, `#FFAB91` (light orange), underlined, centered, `marginTop: 4`. Provides an explicit visual cue that the tooltip is tappable/dismissible — previously users had no indication they could tap the bubble to remove it. Tapping still triggers `dismissGpxTip` (same as before, entire bubble is a `TouchableOpacity`). **No Xano backend changes.** Three areas updated in system design doc: (1) Version header: v4.20 → v4.21. (2) One-time GPX export tooltip completed feature bullet updated (dismiss hint text, style, version tag). (3) Document history: this entry. |

| March 16, 2026 | 4.22 | M6 data integrity fix: empty price overwrite prevention in `submit_call`. **Bug:** When a call was submitted for a marina that only sells one fuel type (e.g., gas only), the FD Dialer hid the other price field, sending an empty value. The `submit_call` endpoint cast the empty string to 0 via `|to_decimal` and wrote it unconditionally to the database, overwriting the 9999 sentinel value (meaning "does not sell this fuel"). This caused affected marinas to appear in price lists at $0.00. **Discovery:** North Lake Marina (Kenmore, WA, ID 42) — a gas-only marina with `sells_diesel: false` — appeared at the top of the consumer app's diesel price list showing $0.00. The `diesel_price` had been overwritten from 9999 to 0 by a prior `submit_call` submission. **Fix:** Added Step 6b-prep to `submit_call` with three guard variables (`$final_gas_price`, `$final_diesel_price`, `$final_diesel_tax`) that fall back to the existing database value from `$FuelPrices1` when the submitted price is 0 or null. Step 6b now writes the `$final_*` variables instead of the raw input values. The precondition was also updated to accept `DIALER_API_TOKEN` in addition to `FD_API_TOKEN` (matching the live endpoint). **No consumer app changes.** Six areas updated in system design doc: (1) Version header: v4.21 → v4.22. (2) Section 8.8 description: added M6 cross-reference. (3) Section 8.8 Function Stack pseudocode: added Step 6b-prep, updated Step 6b to use `final_*` variables. (4) Section 8.8 XanoScript: replaced Step 6b with fixed code including 6b-prep guards, updated auth precondition. (5) Section 8.8 Implementation Notes: added M6 bullet, updated diesel_tax bullet. (6) New Section 8.16: full M6 finding writeup (threat, root cause, discovery, fix, behavior table). (7) Document history: this entry. |

| March 16, 2026 | 4.23 | Tab screen SafeAreaView bottom inset fix. **Bug:** A blank ~34px bar appeared between the list content and the tab bar on the Price, Nearby, and Closed tabs (all three main screens). Caused by `SafeAreaView` from `react-native-safe-area-context` applying a bottom safe area inset on iPhones with the home indicator, even though the tab bar already accounts for the bottom safe area — resulting in a double bottom inset. **Fix:** Added `edges={['top', 'left', 'right']}` to all `SafeAreaView` instances across the three tab screens, covering main, loading, and error states (9 instances total: 3 in `index.tsx`, 3 in `nearby.tsx`, 3 in `closed.tsx`). Same principle as the v4.10 Android SafeAreaView fix (Privacy Policy and Terms of Service excluded `'top'` because the Stack header handles it); this fix excludes `'bottom'` because the tab bar handles it. **No Xano backend changes.** Five areas updated in system design doc: (1) Version header: v4.22 → v4.23. (2) App structure table: `index.tsx`, `nearby.tsx`, `closed.tsx` descriptions updated (SafeAreaView edges noted). (3) New completed feature bullet for tab screen SafeAreaView bottom inset fix. (4) Document history: this entry. |

| March 17, 2026 | 4.24 | Map pin colors and PriceDisclaimerFooter color update. See previous entry for details. |

| March 17, 2026 | 4.26 | Two fixes to the email workflow and one data integrity finding. **Fix 1 — mailgun_inbound catch block:** When the Claude API returns a transient error (e.g., HTTP 500), the catch block now resets `consecutive_unanswered` to 0, sets `last_email_response` to `now`, and writes `ai_comment` = "PARSE ERROR: {error message}". Previously, a Claude API failure caused the marina's reply to be silently lost — the marina responded but `consecutive_unanswered` was never decremented, and `last_email_response` was never set. Discovered when Covich Williams (ID 44) replied with prices but the record still showed `consecutive_unanswered: 5` and `last_email_response: null` due to Anthropic API error `req_011CZ9KFPLEmTJ7VGzqLYDLd`. **Fix 2 — M7 Data Integrity (report_price input-column name collision):** Renamed `gas_price`/`diesel_price` input parameters to `reported_gas`/`reported_diesel` in both the Xano `report_price` endpoint and the Expo consumer app (`services/api.ts`, `app/report-price/[id].tsx`). Root cause: Xano silently auto-merges API input values into `db.edit` operations when input field names match database column names. The endpoint's `db.edit` only specified `{last_email_sent, consecutive_unanswered}` but Xano injected the user-reported prices because the inputs were named `gas_price` and `diesel_price` — identical to FuelPrices columns. Confirmed via nightly CSV backup comparison: marina 44 had gas=4.50/diesel=4.40 in the backup, changed to gas=2/diesel=2 after a test report submission with those values. New Section 8.17 (M7) added with full root cause analysis and design principle: never name API inputs identically to database columns in endpoints with `db.edit` on the same table. **Seven areas updated:** (1) Version header: v4.25 → v4.26. (2) Section 8.5 mailgun_inbound implementation notes: `consecutive_unanswered` reset note rewritten to cover catch block behavior. (3) Section 8.15 report_price inputs table: `gas_price`/`diesel_price` renamed to `reported_gas`/`reported_diesel` with M7 cross-reference. (4) Section 8.15 implementation note #1: updated with v4.26 rename explanation and M7 cross-reference. (5) New Section 8.17: M7 Data Integrity finding with root cause, discovery, fix, and design principle. (6) Document history: this entry. |

| March 18, 2026 | 4.27 | Tab bar reorder, default screen change, and per-tab active icon colors. **Tab reorder:** Tab order changed from Gas, Diesel, Nearby, Closed, Map, About to Map, Price, Nearby, Closed, About. Nearby (`index.tsx`) is now the default landing screen (expo-router uses `index` as default route). **Tab label font size:** Increased to 13px via `tabBarLabelStyle: { fontSize: 13 }` in global `screenOptions`. Map tab's per-screen `tabBarLabelStyle` always includes `fontSize: 13` (previously set to `undefined` when online, which could override the global style). **Per-tab active colors:** New `TAB_COLORS` constant in `_layout.tsx` defines unique active colors per tab: Map `#30B0C7` (cyan), Price `#47D45A` (green), Nearby `#007AFF` (blue), Closed `#FF3B30` (red), About `#E33500` (Navigator red). Each tab's `tabBarIcon` uses `focused` prop (instead of `color`) to conditionally apply the active color or theme default gray (`tabIconDefault`). Each tab also sets per-screen `tabBarActiveTintColor` so the label text matches the icon color when selected. Inactive tabs display in the theme's `tabIconDefault` gray. **No Xano backend changes.** Four areas updated in system design doc: (1) Version header: v4.26 → v4.27. (2) App structure table: `_layout.tsx` description rewritten with new tab order, active colors, and `TAB_COLORS` constant. (3) New completed feature bullets: tab reorder/default screen and per-tab active icon colors. (4) Document history: this entry. |

| March 18, 2026 | 4.28 | Automated daily TOS check task. **New background task:** `daily_tos_check` (#9) runs nightly at 1:00 AM Pacific (08:00 UTC, PDT). Queries FuelPrices for scraped marinas (Method = "HTML" or "Javascript") with blank `legal` field. For each qualifying marina, fetches the website HTML (truncated to 4,000 chars) and robots.txt (truncated to 2,000 chars), sends both to Claude Haiku via `Create chat completion - Claude` function (#34) with a system prompt asking for YES/NO determination on whether the site prohibits scraping. Both outcomes generate a prescriptive email to ken@navigatormktg.com: restrictions found emails say "Set the `legal` field to `TOS no scrape`"; no restrictions emails say "Set the `legal` field to `OK` to stop nightly rechecks." The task never writes to the database — Ken manually sets the `legal` field after reviewing each email. Try/catch per marina so one failure does not stop the run. Most nights the task exits immediately after the initial query because all existing scraped marinas already have `legal` set from the v4.18 manual review. Automates the manual TOS review process from v4.18 so new scraped marinas are caught automatically. **Six areas updated in system design doc:** (1) Version header: v4.27 → v4.28. (2) Section 7 Background Tasks table: `daily_tos_check` row added. (3) New Section 9.11: `daily_tos_check` task detail with trigger conditions, processing flow, design decisions, schedule, and error handling. (4) Section 21 Background Tasks summary table: `daily_tos_check` #9 row added. (5) DST Schedule Maintenance: `daily_tos_check` added to fall-back note. (6) Document history: this entry. |

| March 18, 2026 | 4.29 | **Bug fix — mailgun_inbound sender email parsing.** Mailgun's `sender` field arrives in RFC 5322 display name format (`"Bob Williams <Bob@covichwilliams.com>"`) but the endpoint was comparing this full string directly against `contact_email` in the database (which stores only the bare email address). This caused a silent lookup failure — the Step 11 precondition returned "No marina found with this contact_email" and the marina's reply was never processed. Discovered when marina #44 (Covich Williams) replied at 10:04 AM on March 18, 2026 but the webhook returned 500 on both the initial attempt and Mailgun's retry. Because the response was never recorded, `last_email_response` retained a stale seed date from initial data import (March 2025 — before the system existed), and the outbound email task treated the marina as overdue, sending an unwanted email. **Fix:** Split Step 9 into three parts: (9) capture raw sender string, (9b) use `regex_replace` with pattern `^.*<([^>]+)>.*$` to extract the email from angle brackets (falls back to full string if no brackets), (9c) normalize to lowercase via `to_lower`. Step 10's WHERE clause also lowercases `contact_email` for case-insensitive matching. **Five areas updated in system design doc:** (1) Version header: v4.28 → v4.29. (2) Section 8.5 Function Stack: Steps 9/9b/9c and Step 10 rewritten. (3) Section 8.5 XanoScript: Steps 9-10 replaced with sender extraction and case-insensitive query. (4) Section 8.5 Implementation Notes: new note on sender email extraction from Mailgun format. (5) Document history: this entry. |

| March 18, 2026 | 4.30 | **Closed tab icon changed from X-circle to calendar-with-X.** User feedback reported the `xmark.circle.fill` (MaterialIcons `cancel`) icon on the Closed tab looked like a "close app" button. Changed to MaterialIcons `event-busy` (calendar with X overlay), which clearly conveys seasonal/date-based closures. The Closed tab now imports `MaterialIcons` directly from `@expo/vector-icons/MaterialIcons` in `_layout.tsx` instead of using the `IconSymbol` wrapper, because the corresponding SF Symbol (`calendar.badge.xmark`) is not in the `sf-symbols-typescript` type definitions bundled with expo-symbols. A fallback mapping (`'calendar.badge.xmark': 'event-busy'`) was added to `icon-symbol.tsx` for web/Android use. Same `#FF3B30` red color scheme. **No Xano backend changes.** Four areas updated: (1) Version header: v4.29 → v4.30. (2) App structure table: `_layout.tsx` description updated with Closed tab icon change. (3) New completed feature bullet: Closed tab icon change. (4) Document history: this entry. |

| March 19, 2026 | 4.31 | **Bug fix — `send_outbound_emails` cadence logic using stale `last_email_response` instead of most recent activity.** The cadence check used an if/elseif structure that prioritized `last_email_response` over `last_email_sent`. When `last_email_response` was non-null, the task computed the due date from that field alone and never checked `last_email_sent`. Marina #44 (Covich Williams) had `last_email_response` set to March 17, 2025 — a seed date from initial data import that predated the system (built January 2026). The v4.29 `mailgun_inbound` sender parsing fix prevented Bob Williams' March 18 reply from being recorded, so the stale 2025 date persisted. The task computed: March 17, 2025 + 7 days = March 24, 2025, which is in the past, so `$is_due` evaluated to true every day — causing daily emails instead of respecting the 7-day cadence. **Fix (v3.18):** Replaced the if/elseif priority structure with a `$reference_timestamp` variable set to whichever is more recent between `last_email_sent` and `last_email_response` (using `>=` comparison when both exist). If both are null, the marina is due immediately. This ensures that even with stale data in one field, a recent send or response in the other field correctly blocks premature re-sends. For marina #44, `last_email_sent` (March 19, 2026) is now used as the reference, producing a due date of March 26, 2026. **Five areas updated in system design doc:** (1) Version header: v4.30 → v4.31. (2) Section 7 Background Tasks table: `send_outbound_emails` description updated with new cadence logic. (3) Cadence logic section: reference timestamp description rewritten from "last_email_response if it exists, otherwise last_email_sent" to "whichever is more recent between last_email_sent and last_email_response" with explanation of the bug. (4) Document history: this entry. (5) Lesson learned: if/elseif priority structures can silently ignore valid data in the fallback branch when the primary branch contains stale data. |

| March 25, 2026 | 4.37 | **App version tracking system.** Solves the problem that App Store and Google Play dashboards don't reliably show what percentage of the install base has upgraded (Apple only counts users who opt in to share analytics data). Three-part implementation: Xano backend, app headers, and app launch ping. **New Xano table:** `app_version_log` (table ID 43) with fields `id`, `device_id` (text, unique index), `app_version` (text), `platform` (text), `last_seen` (timestamp, default now). **New Xano endpoints:** `POST /version_ping` (#82) upserts `app_version_log` by `device_id` using `db.add_or_edit` — creates new record for first-time devices, updates `app_version`/`platform`/`last_seen` for returning devices. No auth required. `GET /version_stats` (#83) returns `{versions: [{app_version, count, ios, android}, ...]}` grouped by `app_version`, filtering to devices seen in last 30 days (2,592,000 seconds cutoff). Uses `array.group_by` and `array.filter` for platform breakdown. No auth required. **New app file:** `services/deviceId.ts` generates a random UUID v4 on first launch, persists it in AsyncStorage (`@fuel_docks_device_id` key), reuses it on all subsequent launches. No device permissions required. **App changes to `services/api.ts`:** Axios request interceptor added — attaches `X-App-Version` (from `Constants.expoConfig.version`), `X-Platform` (from `Platform.OS`), and `X-Device-Id` (from `deviceId.ts`) headers to every outbound API call. New `versionPing()` export function POSTs `device_id`, `app_version`, and `platform` to `/version_ping`. **App changes to `app/_layout.tsx`:** `useEffect` with `useRef` guard calls `versionPing()` once per session on mount (fire-and-forget, errors silently caught). Does not block UI. **Seven areas updated in system design doc:** (1) Version header: v4.36 → v4.37. (2) Section 6 Database Schema: `app_version_log` table added. (3) Section 7 API Endpoints: `version_ping` and `version_stats` rows added. (4) API service layer description: interceptor and `versionPing()` added. (5) App structure table: `_layout.tsx` description updated. (6) Anonymous device identification section: `services/deviceId.ts` added. (7) Document history: this entry. |

| March 23, 2026 | 4.36 | **`ADALO_API_TOKEN` renamed to `FD_API_TOKEN`.** Legacy env var name from when Adalo was the frontend. All 5 endpoints that referenced `ADALO_API_TOKEN` updated to use `FD_API_TOKEN`: `send_outbound_email` (#40), `call_queue` (#42), `snooze_call` (#43), `submit_call` (#44), `register_push_token` (#51). New `FD_API_TOKEN` env var created with the same value. `ADALO_API_TOKEN` env var deleted. No impact on the published FD Dialer app — it uses `DIALER_API_TOKEN`, which is unchanged. The 4 dual-auth endpoints (42, 43, 44, 51) now accept `FD_API_TOKEN` or `DIALER_API_TOKEN`. `send_outbound_email` (#40) accepts `FD_API_TOKEN` only. All `ADALO_API_TOKEN` references in this document replaced with `FD_API_TOKEN`. **No app code changes. No database changes.** Two areas updated: (1) Version header: v4.35 → v4.36. (2) Global find-replace of ADALO_API_TOKEN → FD_API_TOKEN across all sections. (3) Document history: this entry. |

| March 23, 2026 | 4.35 | **Price precision fix applied to `apify_webhook`.** Same `decimal` input truncation bug as v4.34 Bug 2. The `apify_webhook` endpoint (#36) wrote `$validated.gas_price`/`$validated.diesel_price` to the database, which were truncated by `validate_claude_output`'s `decimal` input type. **Fix:** Same pattern as `mailgun_inbound` v4.34: added `$write_gas`/`$write_diesel` variables sourced from `$parsed_response` (full precision), with null-check to respect H4 range rejections. `submit_call` (#44) confirmed clean — it does not pass prices through `validate_claude_output`. **Two areas updated:** (1) Version header: v4.34 → v4.35. (2) Document history: this entry. |

| March 23, 2026 | 4.34 | **Two `mailgun_inbound` bug fixes: sender email extraction and price precision.** **Bug 1 — regex_replace returning empty string:** The v4.29 sender email extraction used `regex_replace:"^.*<([^>]+)>.*$":"$1"` to extract the email from angle brackets. This worked when the sender field contained angle brackets (e.g., `"Bob <bob@example.com>"`), but Xano's `regex_replace` returns an empty string — not the original string — when the pattern doesn't match. Mailgun's `sender` field is the SMTP MAIL FROM envelope sender, which is always a bare email address without angle brackets (e.g., `owner@westmarkmarina.com`). The regex matched the `.*` greedily, found no `<...>` capture group, and replaced the entire string with empty `$1`. This caused `$sender_email` to be empty, failing the Step 10 contact_email lookup for every inbound email. The endpoint had been silently broken since v4.29 (March 18) — Mailgun retried each webhook 7 times over ~8 hours before giving up, meaning every marina reply since March 18 was lost. Discovered via Coupeville Wharf (ID 45) reply from Danielle on March 23. Debug email injection confirmed: `sender_raw: [owner@westmarkmarina.com]`, `sender_email (after regex+lower): []`. **Fix:** Removed regex entirely. Steps 9/9b/9c collapsed to a single step: `($mailgun_raw|get:"sender")|to_lower`. No regex needed because Mailgun's `sender` field never contains display names or angle brackets. **Bug 2 — price precision truncation:** The `validate_claude_output` function's `decimal` input type silently truncates prices to 1 decimal place (e.g., 6.11 → 6.1, 6.58 → 6.5). The function only performs range checks ($2-$15) and spike detection — prices that pass validation are returned unchanged, but the `decimal` input type loses precision at the function boundary. **Fix:** db.edit now writes `$write_gas`/`$write_diesel` variables sourced from the original `$parsed_response` (full precision from Claude's JSON), not from `$validated` (truncated by `decimal` input). If validation rejected a price (nulled it for being out of range), `$write_gas`/`$write_diesel` respect the rejection. Verified with test: "gas is 5.73 diesel is 6.28" → stored as 5.73 and 6.28. **Five areas updated:** (1) Version header: v4.33 → v4.34. (2) Section 8.5 Function Stack pseudocode: Steps 9/9b/9c collapsed, routing description updated for $write_gas/$write_diesel. (3) Section 8.5 XanoScript: Steps 9-9c replaced with single-step sender extraction; $write_gas/$write_diesel added after validation. (4) Section 8.5 line 12.5 routing note updated: price fields now sourced from $write_gas/$write_diesel. (5) Document history: this entry. |

| March 23, 2026 | 4.33 | **Added `MFD` Method value for My Fuel Dock self-service marinas.** New Method value `MFD` added to Method Field Values table (Section 6) for marinas that self-maintain prices via the My Fuel Dock portal (myfueldock.com), mobile app, or email to prices@myfueldock.com. Apify scraping, outbound emails, and call queue all skip MFD records. System overview updated from four to five input methods. Previously documented as `MyFuelDock` in the My Fuel Dock system design doc; standardized to `MFD` across both documents. **Three areas updated:** (1) Version header: v4.32 → v4.33. (2) Section 1 System Overview: five input methods, MFD bullet added. (3) Section 6 Method Field Values table: `MFD` row added. (4) Document history: this entry. |

| March 22, 2026 | 4.32 | **`daily_csv_backup` renamed to `daily_maintenance` and merged with MFD analytics cleanup.** Task #5 now performs two jobs nightly at 11:59 PM Pacific: (1) CSV backup of FuelPrices table (unchanged), (2) deletes `mfd_analytics` records older than 90 days (new). The analytics cleanup was originally designed as a separate monthly `mfd_analytics_cleanup` task in the My Fuel Dock system design, but was merged into this existing task to conserve the 10-task Xano plan limit. **New Mailgun domain:** `myfueldock.com` added and verified in Mailgun for sending/receiving My Fuel Dock confirmation emails. DNS records (MX, SPF, DKIM, CNAME) added to Cloudflare. New "MFD All Domains" account-level API key created (`ccbfdc2c-318f3cd4`) and stored in Xano `MAILGUN_API_KEY` env var, replacing the previous mg.fueldocks.app-scoped Domain Sending Key. The old "Fuel Docks Xano" key (`f9517a64-63b589cb`) remains active but is no longer referenced by any env var. **New FuelPrices schema fields:** `price_reminder_days` (int, default 14, 0=disabled) for per-marina configurable stale price alert threshold; `fuel_available` (text, nullable) for temporary fuel status; `fuel_available_revert_at` (timestamp, nullable) for auto-clear timing. **Five areas updated:** (1) Version header: v4.31 → v4.32. (2) Section 9.6: heading and description updated to `daily_maintenance` with merged analytics cleanup. (3) Section 21 Background Tasks table: `daily_csv_backup` row renamed to `daily_maintenance` with updated description. (4) Mailgun API Keys: note about new "MFD All Domains" key replacing domain-scoped key in `MAILGUN_API_KEY`. (5) Document history: this entry. |

| March 25, 2026 | 4.38 | **Bug fix — diesel tax not applied in `apify_webhook` and `mailgun_inbound`.** The `price_processing_rule` and `diesel_tax` fields existed on FuelPrices records but neither `apify_webhook` (#36) nor `mailgun_inbound` (#39) ever checked them. Claude extracted the pre-tax diesel price from the website or email, and it was written directly to `diesel_price` without tax. Discovered when Skyline Marine Center (ID 18, `price_processing_rule = "add_tax_diesel"`, `diesel_tax = 0.083`) updated prices — gas was correct but diesel was stored at $5.94 (pre-tax) instead of $6.43 (with 8.3% tax). **Fix:** Added tax application logic to both endpoints. After Claude extraction and H4 validation, both now check: if `price_processing_rule == "add_tax_diesel"` AND `diesel_tax > 0` AND diesel price is non-null, the raw price is saved to `diesel_price_pretax` and `diesel_price` is set to `raw * (1 + diesel_tax)`, rounded to 2 decimal places. `submit_call` (#44) was already correct (handles tax via `diesel_tax_included` input). MFD endpoints (`mfd_update_prices`, `mfd_email_inbound`) were already correct (use newer `tax_type_*`/`tax_rate_*` fields). Marina #18 manually corrected: `diesel_price` updated from $5.94 to $6.43, `diesel_price_pretax` set to $5.94. 14 marinas have `add_tax_diesel` rule; 6 have non-zero `diesel_tax` rates (now active); 8 have `diesel_tax = 0` (pending setup). **Six areas updated in system design doc:** (1) Version header: v4.37 → v4.38. (2) Section 4.1 detailed steps: new step 19 for tax application, renumbered step 20/21. (3) Section 4.2 inbound steps: new step 10 for tax application, renumbered step 11/12. (4) Claude prompt implementation notes: `diesel_price` bullet rewritten (now describes automated tax application). (5) Section 13 Tax Handling current approach: rewritten with full tax pipeline description. (6) Document history: this entry. |

| March 17, 2026 | 4.25 | Closed-today filtering, DNC email parity, and hours_json auto-parsing. **New database field:** `hours_json` (json, nullable) added to FuelPrices table. Stores structured weekly hours parsed from the free-text `hours` field. Format: array of schedule objects `[{start_month, end_month, closed_days}]` where `start_month`/`end_month` are integers 1-12 and `closed_days` is an array of lowercase 3-letter day abbreviations for days the marina is closed. Supports year-wrapping ranges (e.g., Oct-Apr = start_month: 10, end_month: 4). La Conner Landing (id=31) populated with two schedules: May-Sep open daily, Oct-Apr closed Tue/Thu. **`call_queue` endpoint (#42) updated:** New Filter 0b (closed today) added after Filter 0 (DNC). Computes `$current_month` (int 1-12 via `format_timestamp:"n"|* 1`) and `$current_day_abbr` (lowercase 3-letter day via `format_timestamp:"D"|to_lower`) once before the foreach loop. For each marina with non-null `hours_json`, iterates schedule array to find the matching month range, then iterates `closed_days` to check if today matches. Marinas with null `hours_json` pass through. Filter count increased from six to seven (DNC, closed today, snooze, recheck, suspend, cadence, plus Method WHERE clause). **`daily_call_report` task (#6) updated:** Full filter parity with `call_queue` achieved. Added DNC exclusion (via `continue`) and closed-today check (via `continue`), resolving the v4.19 parity gap. Task description updated from "four-filter" to "six-filter" logic. **`submit_call` endpoint (#44) updated:** When Claude parses call notes and returns a non-null `hours` value, the db.edit now also sets `hours_json = null`, triggering the nightly `parse_hours_json` task to re-parse the updated hours text. Implemented as a conditional branch: one db.edit includes `hours_json: null` (hours changed), the other omits it (hours unchanged). **New background task:** `parse_hours_json` (#8) runs nightly at 1:00 AM Pacific (08:00 UTC, PDT). Queries all FuelPrices, finds marinas with null `hours_json` and non-empty `hours`, sends each `hours` text to Claude Haiku with a structured prompt, writes the parsed JSON array to `hours_json`. Try/catch per marina with Mailgun error alerts. Runs before `daily_call_report` (1 AM vs 2 AM) so newly parsed schedules are available for the morning email. **FD Dialer (React Native):** No app code changes needed — the `hoursParser.ts` client-side parser already computes Open/Closed from the free-text `hours` field for display labels. The new server-side filtering removes closed marinas from the API response entirely. EAS Build 18 (v1.1.0) submitted to iOS TestFlight with the DNC filter fix from earlier in the session. **Twelve areas updated in system design doc:** (1) Version header: v4.24 → v4.25. (2) Database schema: `hours_json` field added in two locations (existing fields table and v4.25 field description). (3) `call_queue` Function Stack pseudocode: Steps 3b/3c and Filter 0b added. (4) `call_queue` XanoScript: replaced with reference to live version. (5) `call_queue` Implementation Notes: closed-today filter note added. (6) `daily_call_report` Filter Logic: updated from four to six filters. (7) `daily_call_report` XanoScript: replaced with reference to live version, parity gap resolved. (8) `submit_call` Implementation Notes: hours_json auto-invalidation note added. (9) Background Tasks table: `daily_call_report` row updated, `parse_hours_json` #8 added. (10) New Section 9.10: `parse_hours_json` task detail. (11) DST Schedule Maintenance: `parse_hours_json` added to fall-back note. (12) Document history: this entry. **Map pin colors changed** in both `app/(tabs)/map.tsx` and `app/marina/map.tsx`: open marinas changed from `Brand.blue` (#070531) to `#47D45A` (green), closed marinas changed from `#999` (grey) to `#D65A5D` (red). Green/red provides immediate visual distinction between open and closed marinas at a glance. **PriceDisclaimerFooter color changed** in `components/PriceDisclaimerFooter.tsx`: both the footer banner background and "I understand" dismiss button background changed from `Brand.red` (#E33500) to `#EA3539`. The new color was chosen to visually match the iOS rendering of the `#D65A5D` closed-marina map pin, which iOS renders with added saturation. Verified side-by-side on Android where both the pin and footer render identically at `#EA3539`. **No Xano backend changes.** Seven areas updated in system design doc: (1) Version header: v4.23 → v4.24. (2) App structure table: `app/(tabs)/map.tsx` description updated (pin colors noted). (3) App structure table: `app/marina/map.tsx` description updated (pin colors noted). (4) Map pin interaction completed feature bullet: new "Map pin colors updated" sub-entry. (5) In-app detail map screen completed feature bullet: pin colors updated. (6) Price disclaimer footer completed feature bullet: color updated. (7) Footer bar redesign completed feature bullet: color updated. (8) Document history combined into system design doc as Section 22 and this entry appended. |

# Fuel Docks Risk Register

**Owner:** Ken Clements, Navigator Marketing
**Created:** March 1, 2026
**Last Updated:** March 1, 2026 (v3)

---

## How to Use This Document

Each risk is assigned a status: OPEN (needs action), ACCEPTED (acknowledged, no action now), or CLOSED (remediated). Review this register monthly or when the system architecture changes significantly.

---

## OPEN Risks

### RISK-001: DMARC Policy in Monitor Mode (Security Finding M1)

| Field | Value |
|---|---|
| Status | OPEN |
| Severity | Medium |
| Category | Email Security |
| Date Identified | February 21, 2026 |
| Target Remediation | April 2026 |

**Current state:** The navigatorpnw.com DMARC record is set to `v=DMARC1; p=none; rua=mailto:ken@navigatorpnw.com`, which is monitor-only mode. Email providers log authentication failures but do not block spoofed messages.

**What could go wrong:** An attacker could send emails pretending to be ken@navigatorpnw.com to marina contacts. This could result in phishing attacks targeting marina staff, damage to the navigatorpnw.com domain reputation, or marina employees being tricked into sharing sensitive information.

**Remediation plan:**

1. Review DMARC aggregate reports arriving at ken@navigatorpnw.com (or ken.clements@outlook.com if redirected)
2. Verify SPF and DKIM pass rates are consistently high
3. Tighten DMARC policy to `p=quarantine` first
4. After confirming no legitimate mail is being quarantined, tighten to `p=reject`
5. Update the `_dmarc` TXT record in Hover DNS

**Where to make the change:** Hover DNS management for navigatorpnw.com. Edit the `_dmarc` TXT record value.

---

### RISK-002: No Per-Endpoint Rate Limiting (Redis Removed in v3.16)

| Field | Value |
|---|---|
| Status | OPEN |
| Severity | Medium |
| Category | Abuse Prevention |
| Date Identified | February 21, 2026 |
| History | Originally identified in security audit as M3 (no rate limiting). Per-endpoint Redis rate limits added in v3.12 (March 1, 2026) and RISK-002 moved to ACCEPTED. Redis rate limits removed in v3.16 (March 1, 2026) because the current Xano subscription tier does not support Redis. RISK-002 reinstated to OPEN. |
| Target Remediation | When Xano plan is upgraded to a tier that supports Redis |

**Current state:** All six write-capable and webhook endpoints have no per-endpoint rate limiting. The `redis.ratelimit` blocks added in v3.12 were removed in v3.16 because the Xano tier does not include Redis. The only remaining request-volume protection is the Xano API group-level rate limit (100 requests/min per IP on the Fuel Docks API group), which applies broadly across all endpoints in the group rather than per-endpoint.

**Affected endpoints (former per-endpoint limits in parentheses):**

- `apify_webhook` #36 (was 70/60s)
- `mailgun_inbound` #39 (was 20/60s)
- `send_outbound_email` #40 (was 5/60s)
- `call_queue` #42 (was 10/60s)
- `snooze_call` #43 (was 10/60s)
- `submit_call` #44 (was 10/60s)

**What could go wrong:** Without per-endpoint rate limits, a compromised or malfunctioning automated caller (Apify loop, Mailgun replay flood, Adalo polling bug) could hit write endpoints at high volume. The group-level 100/min limit provides some protection but is too coarse to catch endpoint-specific abuse patterns (for example, a runaway Apify actor producing 62+ webhook calls in rapid succession would stay under 100/min group limit but far exceed the former 70/60s endpoint limit).

**Mitigating factors (why practical risk is low at current scale):**

- Authentication preconditions on all six endpoints (token or HMAC signature)
- Content hash deduplication on `apify_webhook` prevents unnecessary Claude API calls regardless of request volume
- 60-second response caching on consumer GET endpoints (unaffected by this change)
- Single-operator traffic profile (Ken is the only user; Apify, Mailgun, and Adalo are the only automated callers)
- Group-level 100 requests/min per IP still active

**Remediation plan:** Upgrade the Xano subscription to a tier that includes Redis support, then re-add per-endpoint `redis.ratelimit` blocks using the original configuration documented in the system design doc v3.12 through v3.15 (Section 8.11).

**Cross-references:** System design doc Section 8.11 (Redis Rate Limiting, v3.12, removed v3.16). Section 19 gotcha entry "Xano `redis.ratelimit` requires a higher subscription tier."





## ACCEPTED Risks

---

### RISK-003: Static Shared Secrets Do Not Rotate

| Field | Value |
|---|---|
| Status | ACCEPTED |
| Severity | Low |
| Category | Credential Management |
| Date Identified | February 21, 2026 |
| Target Remediation | None planned |

**Current state:** The APIFY_WEBHOOK_TOKEN and ADALO_API_TOKEN are static shared secrets that never expire and are not rotated on a schedule. If intercepted once, they remain valid indefinitely.

**Why this is accepted:** Ken is the sole operator. The tokens travel over HTTPS (encrypted in transit). The Xano endpoint URLs are not publicly listed. An attacker would need to compromise Ken's Xano account, Apify account, or Adalo configuration to obtain the tokens, at which point they would already have broader access.

**Trigger to revisit:** Adding team members, experiencing a suspected credential compromise, or scaling to a multi-operator model. At that point, implement quarterly rotation with a documented runbook covering all three places each token is stored (Xano env var, Apify actor secret, Adalo custom action header).

---

### RISK-004: Consumer Endpoints Have No Authentication

| Field | Value |
|---|---|
| Status | ACCEPTED |
| Severity | Low |
| Category | Data Protection |
| Date Identified | February 21, 2026 |
| Target Remediation | None planned |

**Current state:** The five consumer-facing read endpoints (gas_price_low_to_high, diesel_price_low_to_high, closed_marinas, gas_prices_by_distance, diesel_prices_by_distance) require no authentication. Anyone who discovers the URLs can read fuel price data.

**Why this is accepted:** The data served is public information already available on individual marina websites. The system aggregates it but does not create proprietary data. Response caching (60-second TTL) limits the load from repeated requests. The group-level rate limit (100/min per IP) prevents automated scraping at scale.

**Trigger to revisit:** If the dataset becomes commercially valuable enough that competitors would want to bulk-scrape it, consider adding API key authentication for consumer endpoints or implementing stricter per-endpoint rate limits.

---

### RISK-005: Apify Webhook Token Visible in Xano Request Logs

| Field | Value |
|---|---|
| Status | ACCEPTED |
| Severity | Low |
| Category | Credential Exposure |
| Date Identified | February 21, 2026 |
| Target Remediation | None planned |

**Current state:** The APIFY_WEBHOOK_TOKEN is sent in the POST body (not HTTP headers, due to Xano's `util.get_raw_input` limitation). This means the token appears in Xano's Run & Debug request history for the apify_webhook endpoint.

**Why this is accepted:** Only Ken has access to the Xano dashboard. The token is encrypted in transit via HTTPS. Xano request logs are not externally accessible. This is an account security concern, not a network security concern.

**Trigger to revisit:** Adding team members with Xano dashboard access. At that point, consider moving to HMAC-based verification (similar to the Mailgun webhook pattern) so the shared secret never appears in request payloads.

---

### RISK-006: Error Responses May Leak Internal Details (Security Finding L3)

| Field | Value |
|---|---|
| Status | ACCEPTED |
| Severity | Low |
| Category | Information Disclosure |
| Date Identified | March 1, 2026 |
| Target Remediation | None planned |

**Current state:** When preconditions fail, Xano returns specific error messages such as "No marina found with this contact_email" or "Unauthorized." While relatively benign, these messages confirm to an attacker which endpoints exist and reveal internal logic about how they work.

**Ideal remediation (not implementing):** Replace specific error messages with generic responses like "Bad Request" for production HTTP responses. Keep detailed messages only in internal logging and email alerts.

**Why this is accepted:** The information disclosed is low-sensitivity (endpoint existence and basic validation logic). All admin endpoints already require authentication tokens, so an attacker would need valid credentials before encountering these messages. The effort to standardize error messages across all endpoints outweighs the minimal security benefit at current scale.

**Trigger to revisit:** If the system scales to serve a larger user base or becomes a target for active probing, consider standardizing error responses across all endpoints to reduce reconnaissance value.

---

## CLOSED Risks

| ID | Description | Finding | Closed Date | Notes |
|---|---|---|---|---|
| H1 | mailgun_inbound had no authentication | Security Audit | Feb 21, 2026 | HMAC-SHA256 signature verification implemented |
| H2 | apify_webhook had no authentication | Security Audit | Feb 14, 2026 | APIFY_WEBHOOK_TOKEN precondition implemented |
| H3 | Admin endpoints had no authentication | Security Audit | Feb 2026 | ADALO_API_TOKEN precondition on all admin endpoints |
| H4 | Consumer endpoints returned all database fields | Security Audit | Feb 2026 | Field whitelisting implemented on all consumer endpoints |
| M3 | No rate limiting on any endpoint | Security Audit | Mar 1, 2026 | Group-level 100 req/min per IP on Fuel Docks API group remains active. Per-endpoint Redis rate limits added in v3.12 were removed in v3.16 (Xano tier does not support Redis). See RISK-002 (reinstated to OPEN). |

---

## Document History

| Date | Change |
|---|---|
| March 1, 2026 | Initial creation. Populated from security audit findings (H1-H4, M1, M3). Added RISK-001 through RISK-005. Closed H1-H4 and M3. |
| March 1, 2026 | Added RISK-006 (L3 error response information leakage) as ACCEPTED. |
| March 1, 2026 | RISK-002 reinstated from ACCEPTED to OPEN with full formatting. Per-endpoint Redis rate limits removed in system design v3.16 because Xano tier does not support Redis. Updated M3 closed entry to note subsequent removal. |

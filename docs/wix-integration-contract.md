# Wix ↔ HootOwl billing integration contract

Version 1. Share this file with Wix Symphony. Never put secrets in it.

## Goal
Wix Pricing Plans is the source of truth for who has paid. HootOwl stores each customer's
subscription status and only provisions or keeps a Twilio number active while the plan is active.

## Endpoint
`POST https://<staging-or-prod-host>/integrations/wix/billing/events`

- The host must be public HTTPS. `hootowl.net` is the Wix site, so the app needs its own hostname.
- Rate limit: 120 requests per minute.
- Content type: `application/json`.

## Authentication
`Authorization: Bearer <WIX_INTAKE_SECRET>`

The secret is shared out of band (never in chat or the repo). This is the Wix Automation
"HTTP request" pattern. It is **not** Wix's signed app-webhook (JWT) format. If Symphony can only
send signed JWT webhooks, tell us and we will add verification for that format.

## Request body
| Field | Required | Notes |
|---|---|---|
| `event_id` | yes | Unique and stable per Wix event. Retries must reuse it (idempotency key). Max 200 chars. |
| `event_type` | yes | One of the values below. |
| `plan_id` | yes | Wix Pricing Plans plan ID. |
| `buyer_email` | yes | Must equal the email on the customer's HootOwl portal account. |
| `subscription_id` | no | Wix order or subscription ID. |
| `period_end` | no | ISO 8601 datetime, for example `2026-11-23T00:00:00.000Z`. |
| `occurred_at` | no | ISO 8601 datetime of the Wix event. Older events never overwrite newer ones. |

### Event types and resulting status
| `event_type` | Status |
|---|---|
| `plan_purchased` | active |
| `payment_succeeded` | active |
| `plan_renewed` | active |
| `payment_failed` | past_due |
| `plan_cancelled` | cancelled |
| `plan_expired` | cancelled |
| `payment_refunded` | refunded |

Status changes to or from `active` suspend or reactivate the customer's Twilio subaccount.

## Responses
| Code | Meaning |
|---|---|
| 202 | Accepted. Body `{ "accepted": true, "duplicate": false, "outcome": "applied" \| "unmatched" \| "ignored" }` |
| 200 | Duplicate `event_id`. Safe to treat as success. |
| 400 | Invalid body. Do not retry unchanged. |
| 401 | Missing or wrong secret. |

`unmatched` means no customer has that email yet. The event is stored and applied automatically
once the customer exists (operators can also press "Reconcile now"). `ignored` means the plan ID
is not in `WIX_PLAN_IDS`, or `WIX_PLAN_IDS` is empty or unset (an empty list rejects every plan).

## Example (redacted)
```json
{
  "event_id": "evt_example_001",
  "event_type": "plan_purchased",
  "plan_id": "<wix-plan-id>",
  "subscription_id": "<wix-order-id>",
  "buyer_email": "owner@example.com",
  "period_end": "2026-11-23T00:00:00.000Z",
  "occurred_at": "2026-10-23T12:00:00.000Z"
}
```

## Wix Automations endpoint (used in production)
Wix Automations' "Send HTTP request" step cannot set headers, so it uses a second endpoint with
Wix's own field names and the secret in the body (never in the URL, which proxies may log):

`POST https://hootowl-lead-recovery-production.up.railway.app/integrations/wix/automation`

| Field | Required | Source in the Pricing Plans trigger |
|---|---|---|
| `secret` | yes | The `WIX_INTAKE_SECRET` value |
| `event` | yes | Fixed per automation: `plan_purchased`, `plan_cancelled` or `plan_expired` |
| `plan_id` | yes | `plan_id` |
| `order_id` | yes | `plan_order_id` (the idempotency key is `event:order_id`) |
| `email` | yes | `contact.email` |
| `first_name`, `last_name` | no | `contact.name.first`, `contact.name.last` |
| `valid_until` | no | `plan_valid_until_iso`; empty means no end date |

For `plan_purchased` from an email with no HootOwl account, the app creates a workspace named
after the buyer and a 7-day portal invitation. The response carries the link to email:
`{ "accepted": true, "duplicate": false, "outcome": "applied", "invited": true, "onboarding_link": "https://…/portal/#invite=…" }`.
Existing accounts get `invited: false` and the portal sign-in address. A retried order returns 200
and a fresh link. Plans not in `WIX_PLAN_IDS` are ignored and create nothing. An empty or unset `WIX_PLAN_IDS` ignores every plan, and the server logs an error at startup.

## Open items for Wix Symphony to confirm
1. The exact Wix event names it can emit, and how they map to the event types above.
2. Whether it can send a custom `Authorization` header and a JSON body in this shape.
3. Whether retries reuse the same `event_id`.
4. The real plan IDs, to set `WIX_PLAN_IDS`.
5. A redacted real payload for each event type, so tests can be written against it.
6. Whether the buyer email always equals the email customers use to sign in to HootOwl.

## Acceptance test (staging only)
Send purchase, duplicate purchase, renewal, payment failure, cancellation and refund for a test
customer. Expect 202, 200, 202, 202, 202, 202, and the portal "Plan & security" page showing the
matching status after each one.

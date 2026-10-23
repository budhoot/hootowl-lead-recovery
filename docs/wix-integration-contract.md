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
is not in `WIX_PLAN_IDS`.

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

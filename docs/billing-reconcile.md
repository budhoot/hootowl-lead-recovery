# Daily Wix billing check

Report only. It never changes a subscription, a billing event or a Twilio subaccount.

Wix Automations are the only way this app learns about purchases, cancellations and expiries. If one never arrives, a cancelled contractor keeps service or a paying one is suspended. This check reads the Wix Pricing Plans orders once a day and lists where Wix and this app disagree.

## It is inactive until three settings exist
| Variable | Value |
|---|---|
| `WIX_ORDERS_API_KEY` | A Wix API key limited to reading Pricing Plans orders. Never commit it. |
| `WIX_SITE_ID` | The Wix site id (metaSiteId) of hootowl.net. Not a secret. |
| `WIX_PLAN_IDS` | Already required. Only orders on these plans are compared. |

With any of them missing the app logs one line at startup (`[billing-reconcile] Inactive: ...`) and nothing else happens: no Wix call, no timer.

## What it calls
`GET https://www.wixapis.com/pricing-plans/v2/orders?limit=50&offset=N` with the header `Authorization: <key>` and `wix-site-id: <site id>`. Read-only. Permission scope: `SCOPE.DC-PAIDPLANS.READ-ORDERS`.

## Matching
The app stores the Wix order id in `billing_subscriptions.wix_subscription_id` (the `order_id` the automation sends). Wix order `id` is compared with it.

## Four cases
1. **wix_active_backend_not**: Wix order is ACTIVE on one of your plans and the backend has no active subscription for that order id.
2. **backend_active_wix_not**: backend says active, Wix says the order is CANCELED, ENDED, PAUSED, or cannot find it. Active rows with no order id cannot be checked and are only counted.
3. **unmatched_event_stale**: a billing event still `unmatched` after 48 hours (buyer emails are masked in the report).
4. **active_past_period_end**: active, `current_period_end` has passed, and no billing event has arrived since. Production sends no renewal events, so a healthy monthly subscriber can appear here. Compare with case 1 and 2 before acting.

## Where results show
- Operator dashboard, Customer accounts page: "Daily Wix billing check" card, with a "Run check now" button.
- Server log: one summary line plus one `[billing-reconcile]` warning per finding.
- Table `billing_reconcile_runs` (kept 60 days).

## Schedule
The app has no scheduler or worker, so this uses an in-process timer: it wakes every 30 minutes and runs when the last good run is 23 hours old (a failed run retries after 6 hours). A database lock stops two app instances running it at once. It first runs two minutes after startup.

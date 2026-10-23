# HootOwl Lead Recovery — voice answering MVP

This Node.js/PostgreSQL service answers the Nocona Hills Repair & Replace line with an AI voice agent, records the call, and can book a visit by voice. SMS sending and inbound SMS handling are disabled.

## Start the dashboard locally (Windows PowerShell)

1. Install Node.js 22 LTS and PostgreSQL locally, or use a PostgreSQL service you already have. Create a database and login role for HootOwl.
2. Open PowerShell in the project folder and run `Copy-Item .env.example .env`.
3. Set `DATABASE_URL` in `.env` to the PostgreSQL connection string. Set `ADMIN_API_KEY` to a random secret, for example with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
4. Run `.\scripts\start-local.ps1`. It installs dependencies if needed, applies pending database migrations, and starts the Node.js server.
5. Open `http://127.0.0.1:3000/operator/`. The dashboard is local to your computer; `/health` checks process liveness and `/ready` checks database readiness.

This local dashboard setup runs directly in Node.js and PostgreSQL. It does not need Docker, Docker Compose, pgAdmin, or a tunnel. `npm start` can be used instead of the PowerShell script after dependencies are installed and migrations have been applied.

## Twilio configuration

The dashboard works locally without Twilio credentials or a public tunnel. To receive real calls, Twilio must be able to reach the API over public HTTPS: set `TWILIO_PUBLIC_BASE_URL` to the deployed API's exact HTTPS origin, then configure the number's incoming Voice webhook as `POST https://YOUR-API/webhooks/twilio/voice`. Do not configure or use an SMS webhook. Incoming Twilio webhooks and the ConversationRelay WebSocket handshake require valid Twilio signatures. The voice agent WebSocket is served at `wss://YOUR-API/webhooks/twilio/agent`.

## Register your first client

In PowerShell, replace the values:

```powershell
$headers = @{ Authorization = "Bearer YOUR_ADMIN_KEY" }
$body = @{
 name = "Example Repair Shop"
 twilio_number = "+18005550100"
 destination_number = "+14155550123"
 booking_url = "https://your-existing-booking-page.example"
 intake_enabled = $true
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/admin/clients" -Headers $headers -ContentType "application/json" -Body $body
```

Save the returned client and route IDs. List routes with GET `/admin/clients`. AI voice answering can be enabled with PATCH `/admin/phone-numbers/ROUTE_ID`, JSON `{"is_active":true,"intake_enabled":true}` and the same Authorization header. This is a global operator API, not a customer login portal; keep the admin key private and never place it in Wix/browser code. Legacy missed-call and text records remain available for audit, but SMS is disabled.

## AI voice answering and call recording

The service uses Twilio ConversationRelay for live speech recognition and spoken responses. The first TwiML verb is a six-second `<Pause>`, which delays pickup; the call is then recorded in dual-channel mode and ConversationRelay plays: “How may Nocona Hills Repair & Replace help you today?” Twilio documents that an initial `<Pause>` delays pickup. Ring cadence varies by carrier, so six seconds approximates the second ring but cannot guarantee the same ring count on every network. See [Twilio’s `<Pause>` reference](https://www.twilio.com/docs/voice/twiml/pause).

The AI can collect the caller's name, requested service, full street address, and issue details, validate the address against the Nocona Hills boundary, check Google Calendar, and book a 60-minute visit after the caller clearly confirms a time. The existing 10-minute travel buffer and 15-minute slot increments apply. It prioritizes visit starts within an hour of the call when possible and otherwise offers later openings. It confirms the booking verbally. The service does not send or respond to SMS. If anyone may be in immediate danger, the AI is instructed to tell them to call 911.

### Trial configuration

1. In `.env`, set `TRIAL_TWILIO_NUMBER=+19403405234`, `OPENAI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and the exact public HTTPS origin in `TWILIO_PUBLIC_BASE_URL`. `OPENAI_MODEL` defaults to `gpt-4.1-mini`. Keep all keys and tokens in `.env` or a production secret manager; do not commit them.
2. In Twilio Console, complete ConversationRelay onboarding and accept its applicable AI/ML terms. Configure the number's Voice webhook to `POST https://YOUR-API/webhooks/twilio/voice`. Leave incoming SMS unconfigured. The API provides the secure relay endpoint at `wss://YOUR-API/webhooks/twilio/agent`.
3. Enable the Google Calendar API and Google Maps Geocoding API in a Google Cloud project. Configure a server-side OAuth client and refresh token authorized with `https://www.googleapis.com/auth/calendar.events` and `https://www.googleapis.com/auth/calendar.events.freebusy` scopes. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, and `GOOGLE_CALENDAR_ID` (usually `primary`). Restrict `GOOGLE_MAPS_API_KEY` to the Geocoding API and the server's allowed IPs where possible.
4. Run `npm run db:migrate`, then register the intake-only route:

   ```powershell
   $headers = @{ Authorization = "Bearer $env:ADMIN_API_KEY" }
   $body = @{
     name = "Nocona Hills Repair & Replace"
     twilio_number = "+19403405234"
     intake_enabled = $true
   } | ConvertTo-Json
   Invoke-RestMethod -Method Post -Uri "https://YOUR-API/admin/clients" -Headers $headers -ContentType "application/json" -Body $body
   ```

   The route does not require or dial a forwarding destination. Store the returned client and route IDs for operator follow-up.

5. Test with a controlled phone: verify the exact greeting, recording completion in Twilio, rejection of an out-of-area address, calendar slot selection, and verbal booking confirmation. Recording metadata and the Twilio recording URL are stored in `voice_agent_sessions`; listen to recordings in the Twilio Console and restrict access there.

The user selected no recording announcement. Recording-notice and consent rules vary by caller location; verify applicable requirements before live use. Audio remains in Twilio. This service stores recording metadata but does not persist caller transcripts.

## Legacy recovery data

Older recovery tables and message records remain for historical compatibility, but no inbound SMS endpoint is mounted and the recovery worker cannot send messages. These legacy records are not used by the voice agent.

## Recovery and operations

## Billing, 2FA and customer phone numbers

- **Wix billing.** A Wix Automation (trigger: Pricing Plans purchase, payment, cancellation or refund) sends an HTTP request to `POST <TWILIO_PUBLIC_BASE_URL>/integrations/wix/billing/events` (the HTTPS address of this service, for example `https://app.hootowl.net`, not the Wix site itself) with `Authorization: Bearer <WIX_INTAKE_SECRET>`. Body: `event_id`, `event_type` (`plan_purchased`, `payment_succeeded`, `plan_renewed`, `payment_failed`, `plan_cancelled`, `plan_expired`, `payment_refunded`), `plan_id`, `buyer_email`, optional `subscription_id`, `period_end`, `occurred_at`. Events are idempotent by `event_id`, stale events cannot overwrite newer ones, and events for buyers without a portal account stay in the operator's unmatched list until reconciled (`POST /admin/customer-workspaces/billing/reconcile`). Set the real public URL of this service, not the Wix site.
- **Two-step verification.** Customers can enable an authenticator app (TOTP) and/or SMS codes, with recovery codes. Set `TWOFA_ENCRYPTION_KEY`. SMS needs `TWILIO_AUTH_FROM` and `SMS_SEND_ENABLED=true`; authentication messages are recorded as non-billable usage.
- **Twilio subaccounts.** After consent and with an active subscription, a customer gets a Twilio subaccount and a number, stored with the token encrypted by `CREDENTIAL_ENCRYPTION_KEY`. The number stays inactive until the customer saves a forwarding number. Subaccounts are suspended when a subscription ends. Twilio allows 1,000 subaccounts by default. Configure the number's status callback to `/webhooks/twilio/call-status` so call minutes are recorded.
- Usage is recorded in `usage_ledger` only; no customer is charged automatically.

Provider/database failures and live telephone behavior require staging verification. This service does not send messages, including legacy recovery messages, other than sign-in codes when enabled.

Use HTTPS, restricted database access, backups and controlled access to caller data and recordings. No credentials are included. The local dashboard is served directly by the Node.js process; use a hosting provider's HTTPS endpoint if Twilio needs to reach a deployed instance.

## Validation

`npm run test:mvp` runs API/worker boundary tests without a live database or sending SMS. `npm test` runs the original Jest tests after a clean `npm ci`. See VALIDATION.md for this delivery's results and limitations.

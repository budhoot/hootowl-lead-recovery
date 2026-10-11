# HootOwl Lead Recovery — voice answering MVP

This Node.js/PostgreSQL service answers the Nocona Hills Repair & Replace line with an AI voice agent, records the call, and can book a visit by voice. SMS sending and inbound SMS handling are disabled.

## Start here (Windows PowerShell)

1. Install Node.js 22 LTS and PostgreSQL. Create a database named `hootowl` and a database user/password.
2. Open PowerShell in the project folder.
3. Run `npm ci`. The repository excludes installed dependencies and private credentials.
4. Run `Copy-Item .env.example .env`. Edit `.env` with your PostgreSQL connection string and Twilio credentials. Set `TWILIO_PUBLIC_BASE_URL` to the exact HTTPS origin of your API, with no path. Generate the admin key with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and paste it into `.env`.
5. Run `npm run db:migrate`, then `npm start`.
6. Do not run `npm run worker`; the legacy recovery SMS worker is disabled.
7. Check `http://localhost:3000/health` (or the port set in `PORT`) for process liveness and `/ready` for database readiness.

## Twilio configuration

Configure the Twilio number's incoming Voice webhook as `POST https://YOUR-API/webhooks/twilio/voice`. Do not configure or use an SMS webhook. Incoming Twilio webhooks and the ConversationRelay WebSocket handshake require valid Twilio signatures. The voice agent WebSocket is served at `wss://YOUR-API/webhooks/twilio/agent`.

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

Provider/database failures and live telephone behavior require staging verification. This service does not send messages, including legacy recovery messages.

Use HTTPS, restricted database access, backups and controlled access to caller data and recordings. No credentials are included. The Dockerfile runs the API as a non-root user; run migrations separately before starting the service. The old Python import check and empty legacy Docker file are not the app entry point.

## Validation

`npm run test:mvp` runs API/worker boundary tests without a live database or sending SMS. `npm test` runs the original Jest tests after a clean `npm ci`. See VALIDATION.md for this delivery's results and limitations.

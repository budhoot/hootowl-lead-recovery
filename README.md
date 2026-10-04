# HootOwl Lead Rescue — backend MVP

This Node.js/PostgreSQL API forwards incoming Twilio calls to a business, queues a recovery text for unanswered/busy/failed calls, stores caller replies, and provides an operator API. It supports multiple businesses in one installation.

## Start here (Windows PowerShell)

1. Install Node.js 22 LTS and PostgreSQL. Create a database named `hootowl` and a database user/password.
2. Extract this ZIP. Open PowerShell inside its `HootOwl-Lead_Recovery` folder.
3. Run `npm ci`. The ZIP intentionally excludes installed dependencies and your private credentials.
4. Run `Copy-Item .env.example .env`. Edit `.env` with your PostgreSQL connection string and Twilio credentials. Set `TWILIO_PUBLIC_BASE_URL` to the exact HTTPS origin of your API, with no path. Generate the admin key with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and paste it into `.env`.
5. Run `npm run db:migrate`, then `npm start`.
6. In a SECOND PowerShell window in the same folder, run `npm run worker`. Both processes must remain running. Use a service manager or two hosting services for continuous operation.
7. Check `http://localhost:3000/health`. This proves the API process is running; it does not verify database/Twilio connectivity.

## Twilio configuration

Use an SMS-capable Twilio number per client. Configure its incoming voice webhook as POST to `https://YOUR-API/webhooks/twilio/voice`. Configure incoming SMS as POST to `/webhooks/twilio/sms`. The worker sets `/webhooks/twilio/sms-status` for delivery updates. All Twilio routes require valid Twilio signatures; unsigned browser/curl calls are rejected.

Configure Twilio Advanced Opt-Out confirmations for STOP, START and HELP; this backend stores opt-outs and leaves confirmations to Twilio. Complete the applicable Twilio messaging onboarding before enabling client recovery. Recovery defaults to disabled; enable it only when the business has approved its messaging use and configuration. Test with a controlled phone before taking clients live. The business phone rings for about 20 seconds (`DIAL_TIMEOUT_SECONDS=15` plus Twilio's roughly 5-second buffer) so the call normally ends before carrier voicemail picks up. If voicemail does answer first (phone off, Do Not Disturb, call declined), Twilio counts the call as answered and no text is sent; this MVP does not detect voicemail.

## Register your first client

In PowerShell, replace the values:

```powershell
$headers = @{ Authorization = "Bearer YOUR_ADMIN_KEY" }
$body = @{
 name = "Example Repair Shop"
 twilio_number = "+18005550100"
 destination_number = "+14155550123"
 booking_url = "https://your-existing-booking-page.example"
 recovery_enabled = $false
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/admin/clients" -Headers $headers -ContentType "application/json" -Body $body
```

Save the returned client and route IDs. List routes with GET `/admin/clients`. Enable recovery with PATCH `/admin/phone-numbers/ROUTE_ID`, JSON `{"is_active":true,"recovery_enabled":true}` and the same Authorization header. Disable with `recovery_enabled:false`. Obtain recent missed calls and replies with GET `/admin/leads?client_id=CLIENT_ID`. This is a global operator API, not a customer login portal; keep the admin key private and never place it in Wix/browser code. API responses are limited to the latest 200 records per category.

## What happens after a missed call

The callback inserts the missed call and its queued text in one SQL statement. Repeated callbacks for the same CallSid do not add messages. The worker sends the business name, a request for the caller's name and needs, optional booking link, and STOP instructions. It suppresses disabled routes, opted-out callers and repeat recovery attempts within 24 hours. Replies appear in the operator inbox for human follow-up. A booking link requests an appointment through your existing scheduling service; the backend does not create calendar appointments or run an AI conversation.

## Recovery and operations

The API can accept missed calls while the worker is offline; pending messages persist in PostgreSQL. Multiple workers claim jobs with row locks. Sending is persisted before calling Twilio. If a send fails or times out, the message is flagged `review` and is NOT retried automatically: Twilio may already have accepted it. A process crash can leave `sending` rows. Inspect `sending` older than 5 minutes and `review` rows in PostgreSQL, compare Twilio logs, and resolve them manually. Never requeue a message until you establish it was not accepted. This favors avoiding duplicate texts over guaranteed delivery. Existing missed-call rows are not automatically backfilled with texts.

Status callbacks update a matched message SID. A callback arriving before the worker saves the SID can be missed; reconcile its final status with Twilio logs. Provider/database failures and live telephone behavior require staging verification.

Use HTTPS, restricted database access, backups and controlled access to lead data. No credentials are included. Dockerfile runs the API as a non-root user; use the same image with `node src/worker.js` for the worker and run migrations separately before starting services. The old Python import check and empty legacy Docker file are not the app entry point.

## Validation

`npm run test:mvp` runs API/worker boundary tests without a live database or sending SMS. `npm test` runs the original Jest tests after a clean `npm ci`. See VALIDATION.md for this delivery's results and limitations.

# Text messages: sign-in codes only

HootOwl is a calls-only AI receptionist. It never sends marketing, recovery or reminder texts.

- The only code that can send an SMS is `src/sms.js`. Its only caller is `src/routes/customer-2fa.js`, which uses it to deliver a one-time sign-in code when a customer has chosen SMS two-step verification. A test (`test/sms-fence.test.js`) fails if any other file imports it.
- Sending is off unless `SMS_SEND_ENABLED` is exactly the string `true`. Unset, empty or any other value means off. `.env.example` ships it as `false`.
- Even when enabled, nothing is sent without `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_AUTH_FROM`.
- Older recovery tables (`missed_calls`, `recovery_messages` and related tables from migrations 001 to 003) and the SMS-era operator queue remain only for historical compatibility. No current code inserts new rows into them, and the recovery worker (`src/worker.js`) is a disabled stub. Do not delete the tables or migrations without a deliberate data decision.

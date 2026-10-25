// SIGN-IN CODES ONLY (see docs/sms-policy.md). This module exists for one purpose: the one-time codes of customer two-step verification
// (src/routes/customer-2fa.js is its only caller). HootOwl never sends marketing, recovery, reminder or any other
// text message, and the product is a calls-only AI receptionist. Do not use this module for anything else.
// Sends authentication SMS from the HootOwl master Twilio account. Off by default: nothing is sent unless
// SMS_SEND_ENABLED is exactly the string "true" (unset, empty or any other value means off).
// setSender() replaces the sender and skips the flag; it exists for tests and must never be called from application code.
let sender = null;
function setSender(fn) { sender = fn; }

async function sendSms(to, body) {
  if (sender) return sender(to, body);
  if (process.env.SMS_SEND_ENABLED !== 'true') return { sent: false, reason: 'disabled' };
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_AUTH_FROM } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_AUTH_FROM) return { sent: false, reason: 'not_configured' };
  const message = await require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN).messages.create({ to, from: TWILIO_AUTH_FROM, body });
  return { sent: true, sid: message.sid };
}
module.exports = { sendSms, setSender };

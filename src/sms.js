// Sends authentication SMS from the HootOwl master Twilio account. Disabled unless SMS_SEND_ENABLED=true.
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

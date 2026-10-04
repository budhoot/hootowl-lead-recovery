const express = require('express');
const twilio = require('twilio');
const db = require('../db');

const router = express.Router();
const missedCallStatuses = new Set(['no-answer', 'busy', 'failed']);

function validateTwilioWebhook(req, res, next) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const publicBaseUrl = process.env.TWILIO_PUBLIC_BASE_URL;

  if (!authToken || !publicBaseUrl) {
    console.error('Twilio webhook verification requires TWILIO_AUTH_TOKEN and TWILIO_PUBLIC_BASE_URL.');
    return res.status(503).json({ error: 'Twilio webhook verification is not configured.' });
  }

  if (!req.is('application/x-www-form-urlencoded')) {
    return res.status(400).json({ error: 'Twilio webhooks must use form encoding.' });
  }

  let requestUrl;
  try {
    const baseUrl = new URL(publicBaseUrl);
    if (
      baseUrl.protocol !== 'https:' ||
      baseUrl.pathname !== '/' ||
      baseUrl.search ||
      baseUrl.hash ||
      baseUrl.username ||
      baseUrl.password
    ) {
      throw new Error('TWILIO_PUBLIC_BASE_URL must be an HTTPS origin without a path.');
    }
    requestUrl = new URL(req.originalUrl, baseUrl).toString();
  } catch (error) {
    console.error('Invalid TWILIO_PUBLIC_BASE_URL configuration:', error.message);
    return res.status(503).json({ error: 'Twilio webhook verification is not configured correctly.' });
  }

  const signature = req.get('X-Twilio-Signature') || '';
  if (!twilio.validateRequest(authToken, signature, requestUrl, req.body || {})) {
    return res.status(403).json({ error: 'Invalid Twilio signature.' });
  }

  next();
}

// Stop ringing the business before its carrier voicemail picks up. If voicemail answers,
// Twilio reports the call as answered and no recovery text is queued. Twilio adds about
// 5 seconds to this value, so 15 means roughly 20 seconds of ringing.
function dialTimeoutSeconds() {
  const value = Number.parseInt(process.env.DIAL_TIMEOUT_SECONDS, 10);
  return Number.isInteger(value) && value >= 5 && value <= 60 ? value : 15;
}

function createTwiML() {
  return new twilio.twiml.VoiceResponse();
}

function sendTwiML(res, response) {
  return res.type('text/xml').send(response.toString());
}

router.post('/voice', express.urlencoded({ extended: false }), validateTwilioWebhook, async (req, res) => {
  const { From: callerNumber, To: twilioNumber } = req.body;
  if (!callerNumber || !twilioNumber) {
    return res.status(400).json({ error: 'Twilio voice webhook is missing From or To.' });
  }

  try {
    const result = await db.query(
      `SELECT id, destination_number
       FROM client_phone_numbers
       WHERE twilio_number = $1 AND is_active = TRUE`,
      [twilioNumber],
    );
    const phoneNumber = result.rows[0];

    const response = createTwiML();
    if (!phoneNumber) {
      console.error('No active client phone-number route is configured for an incoming Twilio call.');
      response.say('This number is not configured yet. Please try again later.');
      response.hangup();
      return sendTwiML(res, response);
    }

    const dialResultUrl = new URL(
      '/webhooks/twilio/dial-result',
      process.env.TWILIO_PUBLIC_BASE_URL,
    ).toString();
    response.dial(
      { action: dialResultUrl, method: 'POST', timeout: dialTimeoutSeconds() },
      phoneNumber.destination_number,
    );
    return sendTwiML(res, response);
  } catch (error) {
    console.error('Failed to route incoming Twilio call:', error);
    return res.status(500).json({ error: 'Unable to route incoming call.' });
  }
});

router.post('/dial-result', express.urlencoded({ extended: false }), validateTwilioWebhook, async (req, res) => {
  const { CallSid: callSid, DialCallStatus: callStatus, From: callerNumber, To: twilioNumber } = req.body;

  if (!callSid || !callStatus) {
    return res.status(400).json({ error: 'Twilio dial result is missing CallSid or DialCallStatus.' });
  }

  const response = createTwiML();
  if (!missedCallStatuses.has(callStatus)) {
    return sendTwiML(res, response);
  }

  if (!callerNumber || !twilioNumber) {
    return res.status(400).json({ error: 'Missed-call callback is missing From or To.' });
  }

  if (!/^\+[1-9][0-9]{1,14}$/.test(callerNumber)) {
    return sendTwiML(res, response);
  }

  try {
    const result = await db.query(
      `SELECT id
       FROM client_phone_numbers
       WHERE twilio_number = $1 AND is_active = TRUE`,
      [twilioNumber],
    );
    const phoneNumber = result.rows[0];

    if (!phoneNumber) {
      console.error('Received a missed-call callback for an unknown Twilio phone number.');
      return res.status(404).json({ error: 'No client phone-number route exists for this callback.' });
    }

    await db.query(
      `WITH recorded AS (
         INSERT INTO missed_calls (call_sid, client_phone_number_id, caller_number, call_status)
         VALUES ($1, $2, $3, $4) ON CONFLICT (call_sid) DO NOTHING RETURNING *
       ) INSERT INTO recovery_messages (call_sid, client_phone_number_id, recipient)
         SELECT call_sid, client_phone_number_id, caller_number FROM recorded
         ON CONFLICT (call_sid) DO NOTHING`,
      [callSid, phoneNumber.id, callerNumber, callStatus],
    );

    return sendTwiML(res, response);
  } catch (error) {
    console.error('Failed to persist missed-call callback:', error);
    return res.status(500).json({ error: 'Unable to record missed call.' });
  }
});

module.exports = router;
module.exports.validateTwilioWebhook = validateTwilioWebhook;

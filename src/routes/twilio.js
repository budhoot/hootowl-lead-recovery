const express = require('express');
const twilio = require('twilio');
const db = require('../db');
const voiceAgent = require('../voice-agent');
const provisioning = require('../provisioning');
const usage = require('../usage');

const router = express.Router();
const missedCallStatuses = new Set(['no-answer', 'busy', 'failed']);

async function validateTwilioWebhook(req, res, next) {
  const publicBaseUrl = process.env.TWILIO_PUBLIC_BASE_URL;

  if (!process.env.TWILIO_AUTH_TOKEN || !publicBaseUrl) {
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
  // The claimed AccountSid only selects which token to verify with; an unknown or forged account fails the signature check.
  let authToken = process.env.TWILIO_AUTH_TOKEN;
  try {
    const claimed = req.body?.AccountSid;
    if (claimed && claimed !== process.env.TWILIO_ACCOUNT_SID) authToken = await provisioning.tokenForAccount(claimed);
  } catch (error) {
    console.error('Unable to load subaccount credentials for webhook verification:', error.message);
    return res.status(503).json({ error: 'Twilio webhook verification is not configured correctly.' });
  }
  if (!authToken || !twilio.validateRequest(authToken, signature, requestUrl, req.body || {})) {
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

function callbackUrl(path) {
  const baseUrl = process.env.TWILIO_PUBLIC_BASE_URL;
  if (!baseUrl) throw new Error('TWILIO_PUBLIC_BASE_URL is not configured.');
  return new URL(path, baseUrl).toString();
}

router.post('/voice', express.urlencoded({ extended: false }), validateTwilioWebhook, async (req, res) => {
  const { From: callerNumber, To: twilioNumber, CallSid: callSid } = req.body;
  if (!callerNumber || !twilioNumber) {
    return res.status(400).json({ error: 'Twilio voice webhook is missing From or To.' });
  }

  try {
    const result = await db.query(
      `SELECT p.id,p.destination_number,p.intake_enabled,c.name
       FROM client_phone_numbers p JOIN clients c ON c.id=p.client_id
       WHERE p.twilio_number = $1 AND p.is_active = TRUE`,
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

    if (phoneNumber.intake_enabled) {
      if (!callSid) {
        return res.status(400).json({ error: 'Twilio voice webhook is missing CallSid.' });
      }
      if (!process.env.TRIAL_TWILIO_NUMBER || twilioNumber !== process.env.TRIAL_TWILIO_NUMBER) {
        console.error('The intake route does not match TRIAL_TWILIO_NUMBER.');
        response.say('This number is not configured yet. Please try again later.');
        response.hangup();
        return sendTwiML(res, response);
      }
      const relayUrl = voiceAgent.websocketUrl(process.env.TWILIO_PUBLIC_BASE_URL);
      await db.query(
        `INSERT INTO voice_agent_sessions(call_sid,client_phone_number_id,caller_number)
         VALUES($1,$2,$3) ON CONFLICT(call_sid) DO NOTHING`,
        [callSid, phoneNumber.id, callerNumber],
      );
      response.pause({ length: 6 });
      response.start().recording({
        channels: 'dual',
        track: 'both',
        trim: 'do-not-trim',
        recordingStatusCallback: callbackUrl('/webhooks/twilio/recording-status'),
        recordingStatusCallbackMethod: 'POST',
        recordingStatusCallbackEvent: 'in-progress completed absent',
      });
      const connect = response.connect({
        action: callbackUrl('/webhooks/twilio/conversation-ended'),
        method: 'POST',
      });
      connect.conversationRelay({
        url: relayUrl,
        welcomeGreeting: voiceAgent.GREETING,
        welcomeGreetingInterruptible: 'any',
        language: 'en-US',
        ttsProvider: process.env.OWL_TTS_PROVIDER || 'ElevenLabs',
        voice: process.env.OWL_TTS_VOICE || 'UgBBYS2sOqTuMpoF3BR0',
      });
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

router.post('/call-status', express.urlencoded({ extended: false }), validateTwilioWebhook, async (req, res) => {
  const { CallSid: callSid, CallStatus: status, CallDuration: duration, To: to } = req.body;
  if (!callSid || !to) return res.status(400).json({ error: 'Call status is missing CallSid or To.' });
  if (status === 'completed') await usage.recordCall(callSid, to, duration);
  return res.sendStatus(204);
});

router.post('/recording-status', express.urlencoded({ extended: false }), validateTwilioWebhook, async (req, res) => {
  const { CallSid: callSid, RecordingSid: recordingSid, RecordingUrl: recordingUrl,
    RecordingStatus: recordingStatus, RecordingDuration: duration } = req.body;
  if (!callSid || !['in-progress', 'completed', 'absent'].includes(recordingStatus)) {
    return res.status(400).json({ error: 'Recording callback is missing a valid call or recording status.' });
  }
  if (recordingUrl) {
    try {
      const url = new URL(recordingUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'api.twilio.com') {
        return res.status(400).json({ error: 'Recording callback URL is invalid.' });
      }
    } catch {
      return res.status(400).json({ error: 'Recording callback URL is invalid.' });
    }
  }
  const seconds = duration === undefined ? null : Number.parseInt(duration, 10);
  if (seconds !== null && (!Number.isInteger(seconds) || seconds < 0)) {
    return res.status(400).json({ error: 'Recording duration is invalid.' });
  }
  try {
    const result = await db.query(
      `UPDATE voice_agent_sessions
       SET recording_sid=COALESCE($2,recording_sid),
           recording_url=COALESCE($3,recording_url),
           recording_status=$4,
           recording_duration=COALESCE($5,recording_duration),
           updated_at=NOW()
       WHERE call_sid=$1`,
      [callSid, recordingSid || null, recordingUrl || null, recordingStatus, seconds],
    );
    if (!result.rowCount) return res.sendStatus(404);
    return res.sendStatus(204);
  } catch (error) {
    console.error('Failed to save Twilio recording status:', error.code || error.name);
    return res.status(500).json({ error: 'Unable to save recording status.' });
  }
});

router.post('/conversation-ended', express.urlencoded({ extended: false }), validateTwilioWebhook, async (req, res) => {
  const { CallSid: callSid } = req.body;
  if (!callSid) return res.status(400).json({ error: 'Conversation callback is missing CallSid.' });
  try {
    await db.query(
      `UPDATE voice_agent_sessions SET status='completed',updated_at=NOW()
       WHERE call_sid=$1 AND status='active'`,
      [callSid],
    );
    const response = createTwiML();
    response.hangup();
    return sendTwiML(res, response);
  } catch (error) {
    console.error('Failed to close Twilio voice session:', error.code || error.name);
    return res.status(500).json({ error: 'Unable to close voice session.' });
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

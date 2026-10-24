const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;
const twilio = require('twilio');
const db = require('./db');
const { geocodeServiceAddress } = require('./geocoding');
const { createBooking, isSlotAvailable, suggestSlots } = require('./google-calendar');
const { formatSlot } = require('./booking');
const { generateReply } = require('./openai-voice');

const SOCKET_PATH = '/webhooks/twilio/agent';
const GREETING = 'Hey thanks for calling Nocona Hills Repair and Replace. How can we assist you today?';
const UNVERIFIED_STEP = 'The details are saved. The address could not be checked automatically, so treat it as inside the service area.';
const CALLBACK_STEP = 'The details are saved but online booking is unavailable right now. Tell the caller a team member will call them back to schedule. Do not offer appointment times.';

function websocketUrl(publicBaseUrl) {
  const base = new URL(publicBaseUrl);
  if (
    base.protocol !== 'https:' ||
    base.pathname !== '/' ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  ) {
    throw new Error('TWILIO_PUBLIC_BASE_URL must be an HTTPS origin without a path.');
  }
  const url = new URL(SOCKET_PATH, base);
  url.protocol = 'wss:';
  return url.toString();
}

function validateUpgrade(request) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const publicBaseUrl = process.env.TWILIO_PUBLIC_BASE_URL;
  const signature = request.headers['x-twilio-signature'];
  if (!authToken || !publicBaseUrl || !signature) return false;

  try {
    const base = new URL(publicBaseUrl);
    if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash) return false;
    // Twilio signs the wss:// URL it was given; also accept the https:// form of the same endpoint.
    const requestUrl = new URL(request.url, base);
    if (twilio.validateRequest(authToken, signature, requestUrl.toString(), {})) return true;
    requestUrl.protocol = 'wss:';
    return twilio.validateRequest(authToken, signature, requestUrl.toString(), {});
  } catch {
    return false;
  }
}

async function loadCall(callSid, from, to) {
  const result = await db.query(
    `SELECT s.*,c.name
     FROM voice_agent_sessions s
     JOIN client_phone_numbers p ON p.id=s.client_phone_number_id
     JOIN clients c ON c.id=p.client_id
     WHERE s.call_sid=$1 AND s.caller_number=$2 AND p.twilio_number=$3
       AND s.status='active'`,
    [callSid, from, to],
  );
  return result.rows[0] || null;
}

async function getCall(callSid) {
  const result = await db.query(
    `SELECT s.*,c.name
     FROM voice_agent_sessions s
     JOIN client_phone_numbers p ON p.id=s.client_phone_number_id
     JOIN clients c ON c.id=p.client_id
     WHERE s.call_sid=$1`,
    [callSid],
  );
  if (!result.rows[0]) throw new Error('Voice session was not found.');
  return result.rows[0];
}

async function saveServiceRequest(callSid, args) {
  const fields = [
    ['customer_name', 80],
    ['service_type', 160],
    ['service_address', 300],
    ['issue_description', 1200],
  ];
  for (const [field, maxLength] of fields) {
    if (typeof args[field] !== 'string' || !args[field].trim() || args[field].trim().length > maxLength) {
      return { ok: false, reason: `${field} is missing or too long. Ask the caller to repeat it.` };
    }
  }

  const address = args.service_address.trim();
  // If verification itself is unavailable, keep the lead and hand it to a person instead of losing it.
  let geocoding;
  try {
    geocoding = await geocodeServiceAddress(address);
  } catch (error) {
    console.error('Address verification unavailable:', error.message);
    geocoding = { status: 'unavailable' };
  }
  const verified = geocoding.status !== 'unavailable';
  if (geocoding.status === 'not_found') {
    return { ok: false, reason: 'Could not verify a full street address.' };
  }
  if (geocoding.status === 'outside_area') {
    return { ok: false, reason: 'Address is outside the Nocona Hills service area; do not book.' };
  }

  const issue = args.issue_description.trim();
  const riskFlag = /\b(fire|smoke|gas leak|smell gas|carbon monoxide|sparking|sparks|live wire|electrical shock)\b/i
    .test(issue);
  const result = await db.query(
    `UPDATE voice_agent_sessions
     SET customer_name=$2,service_type=$3,service_address=$4,issue_description=$5,
         risk_flag=$6,address_verified=$7,callback_requested=$8,updated_at=NOW()
     WHERE call_sid=$1 AND status='active'`,
    [
      callSid,
      args.customer_name.trim(),
      args.service_type.trim(),
      address,
      issue,
      riskFlag,
      verified,
      !verified,
    ],
  );
  if (!result.rowCount) throw new Error('Voice session is no longer active.');
  if (!verified) return { ok: true, booking_available: false, urgent_safety_reminder: riskFlag, next_step: UNVERIFIED_STEP };
  return { ok: true, in_service_area: true, urgent_safety_reminder: riskFlag };
}

async function findCallSlots(callSid) {
  const call = await getCall(callSid);
  if (!call.customer_name || !call.service_type || !call.service_address || !call.issue_description) {
    return { ok: false, reason: 'Service details have not been saved and verified.' };
  }
  if (call.google_event_id) return { ok: false, reason: 'A visit is already booked for this call.' };
  if (!call.address_verified) return { ok: false, booking_available: false, next_step: CALLBACK_STEP };
  let slots;
  try {
    slots = await suggestSlots(new Date(call.call_started_at));
  } catch (error) {
    console.error('Calendar unavailable:', error.message);
    await db.query(
      'UPDATE voice_agent_sessions SET callback_requested=TRUE,updated_at=NOW() WHERE call_sid=$1',
      [callSid],
    );
    return { ok: false, booking_available: false, next_step: CALLBACK_STEP };
  }
  if (!slots.length) return { ok: false, reason: 'No open appointment options were found in the next 14 days.' };
  await db.query(
    'UPDATE voice_agent_sessions SET offered_slots=$2,updated_at=NOW() WHERE call_sid=$1 AND status=$3',
    [callSid, JSON.stringify(slots), 'active'],
  );
  return {
    ok: true,
    slots: slots.map((slot, index) => ({
      choice: index + 1,
      start: slot.start,
      spoken_time: formatSlot(slot),
      within_one_hour_of_call: slot.withinOneHour,
    })),
  };
}

async function prepareBooking(callSid, choice) {
  if (!Number.isInteger(choice) || choice < 1 || choice > 3) {
    return { ok: false, reason: 'That appointment choice is invalid.' };
  }
  const call = await getCall(callSid);
  if (call.google_event_id) return { ok: false, reason: 'A visit is already booked for this call.' };
  const slots = Array.isArray(call.offered_slots) ? call.offered_slots : [];
  const slot = slots[choice - 1];
  if (!slot) return { ok: false, reason: 'That choice is no longer available. Offer fresh appointment options.' };

  const result = await db.query(
    `UPDATE voice_agent_sessions SET pending_slot_index=$2,updated_at=NOW()
     WHERE call_sid=$1 AND status='active' AND google_event_id IS NULL`,
    [callSid, choice],
  );
  if (!result.rowCount) throw new Error('Voice session is no longer active.');
  return { ok: true, confirmation_required: true, selected_time: formatSlot(slot) };
}

async function bookVisit(callSid, choice) {
  if (!Number.isInteger(choice) || choice < 1 || choice > 3) {
    return { ok: false, reason: 'That appointment choice is invalid.' };
  }
  const connection = await db.connect();
  try {
    await connection.query('BEGIN');
    await connection.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      ['voice-booking:' + process.env.TRIAL_TWILIO_NUMBER],
    );
    const call = (await connection.query(
      'SELECT * FROM voice_agent_sessions WHERE call_sid=$1 AND status=$2 FOR UPDATE',
      [callSid, 'active'],
    )).rows[0];
    if (!call) throw new Error('Voice session is no longer active.');
    if (call.google_event_id) {
      await connection.query('COMMIT');
      return { ok: true, already_booked: true };
    }
    if (call.pending_slot_index !== choice) {
      await connection.query('COMMIT');
      return { ok: false, reason: 'The caller has not explicitly confirmed this appointment choice.' };
    }

    const slots = Array.isArray(call.offered_slots) ? call.offered_slots : [];
    const slot = slots[choice - 1];
    if (!slot) {
      await connection.query('COMMIT');
      return { ok: false, reason: 'That choice is no longer available. Offer fresh appointment options.' };
    }
    if (!(await isSlotAvailable(slot))) {
      await connection.query(
        'UPDATE voice_agent_sessions SET offered_slots=$2,pending_slot_index=NULL,updated_at=NOW() WHERE call_sid=$1',
        [callSid, JSON.stringify([])],
      );
      await connection.query('COMMIT');
      return { ok: false, reason: 'That time is no longer available. Offer fresh appointment options.' };
    }

    const booking = await createBooking(call, slot);
    await connection.query(
      `UPDATE voice_agent_sessions
       SET google_event_id=$2,booked_start=$3,booked_end=$4,pending_slot_index=NULL,updated_at=NOW()
       WHERE call_sid=$1`,
      [callSid, booking.eventId, slot.start, slot.end],
    );
    await connection.query('COMMIT');
    return { ok: true, booked_time: formatSlot(slot) };
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}

async function runTool(callSid, name, args) {
  switch (name) {
    case 'save_service_request':
      return saveServiceRequest(callSid, args);
    case 'get_available_slots':
      return findCallSlots(callSid);
    case 'prepare_booking':
      return prepareBooking(callSid, args.choice);
    default:
      throw new Error('Unsupported voice-agent tool.');
  }
}

function confirmationIntent(text) {
  if (typeof text !== 'string') return null;
  const words = text.toLowerCase().match(/[a-z']+/g) || [];
  if (!words.length) return null;
  if (words.some(word => ['no', 'nope', 'not', 'dont', "don't", 'cancel', 'rather'].includes(word))) return 'no';
  if (words.some(word => ['yes', 'yeah', 'yep', 'correct', 'confirm', 'absolutely', 'sure'].includes(word))) return 'yes';
  return null;
}

async function handlePendingConfirmation(callSid, callerText) {
  const call = await getCall(callSid);
  if (!Number.isInteger(call.pending_slot_index)) return null;

  const words = typeof callerText === 'string' ? callerText.toLowerCase().match(/[a-z']+/g) || [] : [];
  const intent = words.length <= 4 ? confirmationIntent(callerText) : null;
  if (intent === 'no') {
    await db.query(
      'UPDATE voice_agent_sessions SET pending_slot_index=NULL,updated_at=NOW() WHERE call_sid=$1 AND status=$2',
      [callSid, 'active'],
    );
    return 'Okay, I will not book that visit. Would you like to hear another appointment time?';
  }
  if (intent !== 'yes') return 'Please say yes or no. I will not book the visit unless you clearly say yes.';

  const result = await bookVisit(callSid, call.pending_slot_index);
  if (result.ok) return `Your visit is booked for ${result.booked_time}.`;
  return 'That time is no longer available, so I did not book it. I can look for another appointment time.';
}

function sendSpokenText(socket, text) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: 'text',
    token: text,
    last: true,
    interruptible: true,
  }));
}

function handleConnection(socket) {
  let call = null;
  const history = [];
  let turnQueue = Promise.resolve();

  socket.on('message', (raw) => {
    turnQueue = turnQueue.then(async () => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        throw new Error('Conversation Relay sent invalid JSON.');
      }

      if (message.type === 'setup') {
        const setupCall = await loadCall(message.callSid, message.from, message.to);
        if (!setupCall) {
          socket.close(1008, 'Call session is invalid.');
          return;
        }
        call = setupCall;
        return;
      }

      if (message.type !== 'prompt' || message.last !== true) return;
      if (!call) {
        socket.close(1008, 'Call setup is required.');
        return;
      }
      try {
        const confirmationReply = await handlePendingConfirmation(call.call_sid, message.voicePrompt);
        if (confirmationReply) {
          history.push(
            { role: 'user', content: String(message.voicePrompt || '').slice(0, 2000) },
            { role: 'assistant', content: confirmationReply },
          );
          if (history.length > 40) history.splice(0, history.length - 40);
          sendSpokenText(socket, confirmationReply);
          return;
        }
        const currentCall = await getCall(call.call_sid);
        if (Number.isInteger(currentCall.pending_slot_index)) {
          const selectedSlot = currentCall.offered_slots[currentCall.pending_slot_index - 1];
          const confirmationPrompt = selectedSlot
            ? `Would you like me to book ${formatSlot(selectedSlot)}? Please say yes or no.`
            : 'I need to refresh the appointment options before booking. Would you like me to check again?';
          history.push(
            { role: 'user', content: String(message.voicePrompt || '').slice(0, 2000) },
            { role: 'assistant', content: confirmationPrompt },
          );
          if (history.length > 40) history.splice(0, history.length - 40);
          sendSpokenText(socket, confirmationPrompt);
          return;
        }
        const text = await generateReply(
          history,
          message.voicePrompt,
          (name, args) => runTool(call.call_sid, name, args),
        );
        sendSpokenText(socket, text);
      } catch (error) {
        console.error('Voice-agent turn failed:', error.message);
        sendSpokenText(
          socket,
          'I am sorry, I cannot complete that request right now. Please call back later.',
        );
      }
    }).catch((error) => {
      console.error('Conversation Relay session failed:', error.message);
      socket.close(1011, 'Voice session failed.');
    });
  });
}

function attachVoiceAgent(server) {
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    let path;
    try {
      path = new URL(request.url, process.env.TWILIO_PUBLIC_BASE_URL).pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (path !== SOCKET_PATH || !validateUpgrade(request)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit('connection', websocket, request);
    });
  });
  websocketServer.on('connection', handleConnection);
  return websocketServer;
}

module.exports = {
  GREETING,
  SOCKET_PATH,
  attachVoiceAgent,
  bookVisit,
  handlePendingConfirmation,
  findCallSlots,
  handleConnection,
  prepareBooking,
  saveServiceRequest,
  validateUpgrade,
  websocketUrl,
};

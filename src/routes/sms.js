const express = require('express');
const twilio = require('twilio');
const db = require('../db');
const { validateTwilioWebhook } = require('./twilio');
const router = express.Router();
router.use(express.urlencoded({ extended: false, limit: '32kb' }), validateTwilioWebhook);
router.post('/sms', async (req, res) => {
  const { MessageSid, From, To, Body, OptOutType } = req.body;
  if (!MessageSid || !From || !To || typeof Body !== 'string') return res.sendStatus(400);
  const connection = await db.connect();
  try {
    await connection.query('BEGIN');
    const route = (await connection.query('SELECT id FROM client_phone_numbers WHERE twilio_number=$1', [To])).rows[0];
    if (!route) { await connection.query('ROLLBACK'); return res.sendStatus(404); }
    // This same row lock serializes opt-outs with outgoing sends for this business number.
    await connection.query('SELECT id FROM client_phone_numbers WHERE id=$1 FOR UPDATE', [route.id]);
    const stored = await connection.query(`INSERT INTO inbound_messages(message_sid,client_phone_number_id,caller_number,body)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING message_sid`, [MessageSid, route.id, From, Body]);
    const keyword = Body.trim().toUpperCase();
    const stop = OptOutType === 'STOP' || ['STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT','REVOKE','OPTOUT'].includes(keyword);
    const start = OptOutType === 'START' || ['START','UNSTOP'].includes(keyword);
    if (stored.rowCount && stop) await connection.query('INSERT INTO sms_opt_outs VALUES($1,$2) ON CONFLICT DO NOTHING', [route.id, From]);
    if (stored.rowCount && start) await connection.query('DELETE FROM sms_opt_outs WHERE client_phone_number_id=$1 AND caller_number=$2', [route.id, From]);
    await connection.query('COMMIT');
    // Twilio Advanced Opt-Out provides confirmations; do not duplicate them here.
    res.type('text/xml').send(new twilio.twiml.MessagingResponse().toString());
  } catch (error) { await connection.query('ROLLBACK'); throw error; }
  finally { connection.release(); }
});
router.post('/sms-status', async (req, res) => {
  const { MessageSid, MessageStatus } = req.body;
  if (!MessageSid || !MessageStatus) return res.sendStatus(400);
  await db.query('UPDATE recovery_messages SET delivery_status=$2,updated_at=NOW() WHERE message_sid=$1', [MessageSid, MessageStatus]);
  res.sendStatus(204);
});
module.exports = router;

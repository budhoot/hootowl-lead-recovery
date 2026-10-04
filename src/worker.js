require('dotenv').config({ quiet: true });
const db = require('./db');
const twilio = require('twilio');
async function processOne(client) {
  const connection = await db.connect();
  let job;
  try {
    await connection.query('BEGIN');
    job = (await connection.query(`SELECT r.*, p.twilio_number,p.client_id
      FROM recovery_messages r JOIN client_phone_numbers p ON p.id=r.client_phone_number_id
      WHERE r.state='pending' ORDER BY r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED`)).rows[0];
    if (!job) { await connection.query('COMMIT'); return false; }
    await connection.query('SELECT id FROM client_phone_numbers WHERE id=$1 FOR UPDATE', [job.client_phone_number_id]);
    const route = (await connection.query(`SELECT p.*,c.name,c.booking_url FROM client_phone_numbers p
      JOIN clients c ON c.id=p.client_id WHERE p.id=$1`, [job.client_phone_number_id])).rows[0];
    const blocked = (await connection.query(`SELECT 1 FROM sms_opt_outs WHERE client_phone_number_id=$1 AND caller_number=$2`, [route.id, job.recipient])).rowCount;
    const recent = (await connection.query(`SELECT 1 FROM recovery_messages WHERE client_phone_number_id=$1 AND recipient=$2
      AND state IN ('sent','sending','review') AND created_at>NOW()-INTERVAL '24 hours' AND id<>$3`, [route.id, job.recipient, job.id])).rowCount;
    if (!route.is_active || !route.recovery_enabled || blocked || recent) {
      await connection.query("UPDATE recovery_messages SET state='suppressed',updated_at=NOW() WHERE id=$1", [job.id]);
      await connection.query('COMMIT'); return true;
    }
    await connection.query("UPDATE recovery_messages SET state='sending',updated_at=NOW() WHERE id=$1", [job.id]);
    await connection.query('COMMIT');
    // Persist sending before contacting Twilio. An uncertain result is reviewed, never auto-retried.
    await connection.query('BEGIN');
    await connection.query('SELECT id FROM client_phone_numbers WHERE id=$1 FOR UPDATE', [route.id]);
    const currentRoute = (await connection.query('SELECT is_active,recovery_enabled FROM client_phone_numbers WHERE id=$1', [route.id])).rows[0];
    const optedOut = (await connection.query('SELECT 1 FROM sms_opt_outs WHERE client_phone_number_id=$1 AND caller_number=$2', [route.id, job.recipient])).rowCount;
    if (optedOut || !currentRoute.is_active || !currentRoute.recovery_enabled) {
      await connection.query("UPDATE recovery_messages SET state='suppressed',updated_at=NOW() WHERE id=$1", [job.id]);
    } else {
      const message = await client.messages.create({from: route.twilio_number, to: job.recipient,
        body: `${route.name}: Sorry we missed your call. Reply with your name and what you need help with.${route.booking_url ? ' Request an appointment: ' + route.booking_url : ''} Reply STOP to opt out.`,
        statusCallback: new URL('/webhooks/twilio/sms-status', process.env.TWILIO_PUBLIC_BASE_URL).toString()});
      await connection.query("UPDATE recovery_messages SET state='sent',message_sid=$2,updated_at=NOW() WHERE id=$1", [job.id,message.sid]);
    }
    await connection.query('COMMIT'); return true;
  } catch (error) {
    await connection.query('ROLLBACK');
    if (job) await connection.query("UPDATE recovery_messages SET state='review',updated_at=NOW() WHERE id=$1 AND state IN ('pending','sending')", [job.id]);
    throw error;
  } finally { connection.release(); }
}
async function run() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PUBLIC_BASE_URL) throw new Error('Configure Twilio before starting worker');
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN, { timeout: 10000 });
  let stopped=false;
  process.on('SIGTERM',()=>{stopped=true;}); process.on('SIGINT',()=>{stopped=true;});
  while (!stopped) {
    try { if (await processOne(client)) continue; } catch { console.error('Recovery worker failed; inspect review queue.'); }
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  await db.end();
}
if (require.main === module) run().catch(()=>{console.error('Worker configuration failed');process.exitCode=1;});
module.exports = { processOne };

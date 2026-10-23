const db = require('./db');

// Twilio bills voice per started minute, so usage is recorded the same way.
function billableMinutes(durationSeconds) {
  const seconds = Number.parseInt(durationSeconds, 10);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : 0;
}

// Keyed by CallSid: a retried or replayed callback changes nothing.
async function recordCall(callSid, twilioNumber, durationSeconds) {
  const owner = (await db.query('SELECT client_id FROM client_phone_numbers WHERE twilio_number=$1', [twilioNumber])).rows[0];
  if (!owner) return { recorded: false };
  const minutes = billableMinutes(durationSeconds);
  if (!minutes) return { recorded: false };
  const result = await db.query(`INSERT INTO usage_ledger(client_id,kind,provider_sid,quantity) VALUES($1,'call',$2,$3)
    ON CONFLICT(provider_sid) DO NOTHING RETURNING id`, [owner.client_id, callSid, minutes]);
  return { recorded: result.rowCount === 1, minutes };
}

async function summary(clientId, days = 30) {
  const { rows } = await db.query(`SELECT kind, sum(quantity)::float AS quantity, count(*)::int AS events FROM usage_ledger
    WHERE client_id=$1 AND occurred_at>=NOW()-make_interval(days => $2) GROUP BY kind ORDER BY kind`, [clientId, days]);
  return rows;
}
module.exports = { billableMinutes, recordCall, summary };

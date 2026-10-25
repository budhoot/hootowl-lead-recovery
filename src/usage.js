const db = require('./db');
const { planFor } = require('./plans');

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

// AI receptionist minutes, from the session start (the webhook) to the end of the conversation, per started minute.
// Keyed by CallSid like calls; previews are not metered (they are capped per day instead).
async function recordAiSession(callSid) {
  const result = await db.query(`INSERT INTO usage_ledger(client_id,kind,provider_sid,quantity)
    SELECT p.client_id,'ai_voice','ai:'||s.call_sid,CEIL(GREATEST(EXTRACT(EPOCH FROM NOW()-s.call_started_at),1)/60)
    FROM voice_agent_sessions s JOIN client_phone_numbers p ON p.id=s.client_phone_number_id
    WHERE s.call_sid=$1 AND NOT s.is_preview
    ON CONFLICT(provider_sid) DO NOTHING RETURNING quantity`, [callSid]);
  return { recorded: result.rowCount === 1, minutes: result.rows[0] ? Number(result.rows[0].quantity) : 0 };
}

// This calendar month's AI minutes (in the customer's time zone) against what its plan or override allows.
async function aiStatus(clientId) {
  const { rows } = await db.query(`SELECT c.ai_unlimited,c.ai_minutes_override,b.wix_plan_id,b.status,
    COALESCE((SELECT sum(u.quantity) FROM usage_ledger u WHERE u.client_id=c.id AND u.kind='ai_voice'
      AND u.occurred_at>=(date_trunc('month',NOW() AT TIME ZONE c.timezone) AT TIME ZONE c.timezone)),0)::float AS used
    FROM clients c LEFT JOIN billing_subscriptions b ON b.client_id=c.id WHERE c.id=$1`, [clientId]);
  const row = rows[0];
  if (!row) return { unlimited: false, allowance: 0, used: 0, remaining: 0, plan: null, source: 'none' };
  const plan = row.status === 'active' ? planFor(row.wix_plan_id) : null;
  const override = row.ai_minutes_override;
  const allowance = row.ai_unlimited ? null : override ?? (plan ? plan.aiMinutes : 0);
  return {
    unlimited: row.ai_unlimited,
    allowance,
    used: row.used,
    remaining: row.ai_unlimited ? null : Math.max(0, allowance - row.used),
    plan: plan?.name || null,
    source: row.ai_unlimited ? 'unlimited' : override != null ? 'override' : plan ? 'plan' : 'none',
  };
}

const canUseAi = (status) => status.unlimited || status.used < status.allowance;

async function summary(clientId, days = 30) {
  const { rows } = await db.query(`SELECT kind, sum(quantity)::float AS quantity, count(*)::int AS events FROM usage_ledger
    WHERE client_id=$1 AND occurred_at>=NOW()-make_interval(days => $2) GROUP BY kind ORDER BY kind`, [clientId, days]);
  return rows;
}
module.exports = { aiStatus, billableMinutes, canUseAi, recordAiSession, recordCall, summary };

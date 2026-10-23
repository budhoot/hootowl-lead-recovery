const db = require('./db');

const STATUS_BY_EVENT = {
  plan_purchased: 'active',
  payment_succeeded: 'active',
  plan_renewed: 'active',
  payment_failed: 'past_due',
  plan_cancelled: 'cancelled',
  plan_expired: 'cancelled',
  payment_refunded: 'refunded'
};
const EVENT_TYPES = Object.keys(STATUS_BY_EVENT);

function allowedPlans() {
  return (process.env.WIX_PLAN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
}

async function findClientByEmail(email) {
  const { rows } = await db.query(
    `SELECT client_id FROM customer_users WHERE lower(email) = lower($1)
     UNION SELECT client_id FROM customer_invites WHERE lower(email) = lower($1) LIMIT 1`, [email]);
  return rows[0] ? rows[0].client_id : null;
}

// Applies one Wix billing event exactly once. Replays return duplicate=true without touching state.
async function applyWixEvent(event) {
  const plans = allowedPlans();
  const known = plans.length === 0 || plans.includes(event.plan_id);
  const inserted = await db.query(
    `INSERT INTO billing_events(source,event_id,event_type,outcome,payload) VALUES('wix',$1,$2,$3,$4)
     ON CONFLICT(source,event_id) DO NOTHING RETURNING id`,
    [event.event_id, event.event_type, known ? 'unmatched' : 'ignored', JSON.stringify(event)]);
  if (!inserted.rowCount) return { duplicate: true };
  if (!known) return { duplicate: false, outcome: 'ignored' };

  const clientId = await findClientByEmail(event.buyer_email);
  if (!clientId) return { duplicate: false, outcome: 'unmatched' };

  const status = STATUS_BY_EVENT[event.event_type];
  await db.query(
    `INSERT INTO billing_subscriptions(client_id,wix_plan_id,wix_subscription_id,status,buyer_email,current_period_end,last_event_at)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(client_id) DO UPDATE SET wix_plan_id=EXCLUDED.wix_plan_id,
       wix_subscription_id=COALESCE(EXCLUDED.wix_subscription_id,billing_subscriptions.wix_subscription_id),
       status=EXCLUDED.status, buyer_email=EXCLUDED.buyer_email,
       current_period_end=COALESCE(EXCLUDED.current_period_end,billing_subscriptions.current_period_end),
       last_event_at=EXCLUDED.last_event_at, updated_at=NOW()
     WHERE EXCLUDED.last_event_at >= billing_subscriptions.last_event_at`,
    [clientId, event.plan_id, event.subscription_id || null, status, event.buyer_email, event.period_end || null, event.occurred_at || new Date().toISOString()]);
  await db.query(`UPDATE billing_events SET outcome='applied', client_id=$1 WHERE source='wix' AND event_id=$2`, [clientId, event.event_id]);
  // Best effort: provider failures must not make Wix retry an event that is already recorded.
  try {
    const provisioning = require('./provisioning');
    const current = (await db.query('SELECT status FROM billing_subscriptions WHERE client_id=$1', [clientId])).rows[0].status;
    await provisioning.setSubaccountStatus(clientId, current === 'active' ? 'active' : 'suspended');
  } catch (error) { console.error('Unable to update Twilio subaccount status:', error.message); }
  return { duplicate: false, outcome: 'applied', status };
}

async function isSubscriptionActive(clientId) {
  const { rows } = await db.query(`SELECT status FROM billing_subscriptions WHERE client_id=$1`, [clientId]);
  return rows[0] ? rows[0].status === 'active' : false;
}

// Operator re-run for an event that arrived before the buyer had a portal account.
async function reconcileUnmatched() {
  const { rows } = await db.query(`SELECT id,payload FROM billing_events WHERE outcome='unmatched' ORDER BY received_at`);
  let applied = 0;
  for (const row of rows) {
    const ev = row.payload;
    const clientId = await findClientByEmail(ev.buyer_email);
    if (!clientId) continue;
    await db.query(`DELETE FROM billing_events WHERE id=$1`, [row.id]);
    const r = await applyWixEvent(ev);
    if (r.outcome === 'applied') applied++;
  }
  return { applied };
}

module.exports = { EVENT_TYPES, applyWixEvent, isSubscriptionActive, reconcileUnmatched };

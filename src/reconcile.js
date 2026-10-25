// Daily, report-only check of Wix Pricing Plans orders against billing_subscriptions.
// It NEVER changes a subscription, a billing event or a Twilio subaccount. It reads Wix, reads the database,
// records one row in billing_reconcile_runs and writes log lines. It does nothing at all until
// WIX_ORDERS_API_KEY and WIX_SITE_ID are set (see docs/billing-reconcile.md).
const db = require('./db');

const WIX_ORDERS_URL = 'https://www.wixapis.com/pricing-plans/v2/orders';
const PAGE_SIZE = 50;            // the List Orders maximum
const MAX_PAGES = 40;            // 2000 orders; beyond this the run is marked truncated
const STALE_UNMATCHED_HOURS = 48;
const CHECK_EVERY_MS = 30 * 60 * 1000;
const OK_RUN_EVERY_MS = 23 * 3600 * 1000;
const ERROR_RETRY_MS = 6 * 3600 * 1000;
const FIRST_CHECK_DELAY_MS = 2 * 60 * 1000;
const LOCK_KEY = 7139022;
const KINDS = ['wix_active_backend_not', 'backend_active_wix_not', 'unmatched_event_stale', 'active_past_period_end'];

function planIds(env) { return (env.WIX_PLAN_IDS || '').split(',').map(s => s.trim()).filter(Boolean); }

function config(env = process.env) {
  const apiKey = (env.WIX_ORDERS_API_KEY || '').trim();
  const siteId = (env.WIX_SITE_ID || '').trim();
  const plans = planIds(env);
  const missing = [];
  if (!apiKey) missing.push('WIX_ORDERS_API_KEY');
  if (!siteId) missing.push('WIX_SITE_ID');
  if (!plans.length) missing.push('WIX_PLAN_IDS');
  return { ok: missing.length === 0, missing, apiKey, siteId, plans };
}

function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return 'unknown email';
  const [name, domain] = email.split('@');
  return `${name.slice(0, 1)}***@${domain}`;
}

// GET /pricing-plans/v2/orders, 50 per page, offset paging. Auth is the API key itself in the Authorization header;
// an API key is not tied to a site, so the target site goes in the wix-site-id header.
async function fetchWixOrders({ apiKey, siteId, fetchImpl = globalThis.fetch }) {
  const orders = new Map();
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await fetchImpl(`${WIX_ORDERS_URL}?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`, {
      method: 'GET',
      headers: { Authorization: apiKey, 'wix-site-id': siteId, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      let detail = '';
      try { const body = await response.json(); if (typeof body?.message === 'string') detail = `: ${body.message.slice(0, 160)}`; } catch { /* no body */ }
      throw new Error(`Wix returned HTTP ${response.status}${detail}`);
    }
    const body = await response.json();
    const batch = Array.isArray(body?.orders) ? body.orders : [];
    for (const order of batch) if (order && order.id) orders.set(order.id, order);
    if (batch.length < PAGE_SIZE) return { orders: [...orders.values()], truncated: false };
    if (page === MAX_PAGES - 1) truncated = true;
  }
  return { orders: [...orders.values()], truncated };
}

const dayMs = 24 * 3600 * 1000;

// Pure comparison. subs: billing_subscriptions rows. eventsByOrder: Map orderId -> [{outcome,event_type}].
function compare({ orders, subs, eventsByOrder, staleEvents, plans, truncated, now }) {
  const findings = [];
  const byOrder = new Map(subs.filter(s => s.wix_subscription_id).map(s => [s.wix_subscription_id, s]));
  const wixById = new Map(orders.map(o => [o.id, o]));

  // 1. Wix says active, the backend does not.
  for (const order of orders) {
    if (order.status !== 'ACTIVE' || !plans.includes(order.planId)) continue;
    const row = byOrder.get(order.id);
    if (row && row.status === 'active') continue;
    const events = eventsByOrder.get(order.id) || [];
    const eventNote = events.length
      ? ` Events received for this order: ${events.map(e => `${e.event_type} (${e.outcome})`).join(', ')}.`
      : ' No billing event for this order was ever received.';
    const pay = order.lastPaymentStatus && order.lastPaymentStatus !== 'PAID' ? `, last payment ${order.lastPaymentStatus}` : '';
    findings.push({
      kind: 'wix_active_backend_not', order_id: order.id, plan_id: order.planId, plan_name: order.planName || null,
      created_date: order.createdDate || null, client_id: row ? Number(row.client_id) : null,
      backend_status: row ? row.status : 'no_subscription_record', events_seen: events.length,
      summary: `Wix shows order ${order.id} (${order.planName || order.planId}) as ACTIVE${pay}. Backend: ${row ? `subscription is "${row.status}"` : 'no subscription record'}.${eventNote}`
    });
  }

  // 2. The backend says active, Wix does not.
  let unverifiable = 0;
  for (const row of subs) {
    if (row.status !== 'active') continue;
    if (!row.wix_subscription_id) { unverifiable++; continue; }
    const order = wixById.get(row.wix_subscription_id);
    if (order && order.status === 'ACTIVE') continue;
    if (!order && truncated) continue; // an incomplete Wix list cannot prove an order is missing
    findings.push({
      kind: 'backend_active_wix_not', order_id: row.wix_subscription_id, client_id: Number(row.client_id),
      plan_id: row.wix_plan_id, wix_status: order ? order.status : 'not_found',
      cancellation_cause: order?.cancellation?.cause || null,
      summary: `Backend shows client ${row.client_id} as active on order ${row.wix_subscription_id}. Wix: ${order ? `order status is ${order.status}${order.cancellation?.cause ? ` (${order.cancellation.cause})` : ''}` : 'that order was not found among its orders'}.`
    });
  }

  // 3. Unmatched billing events older than 48 hours.
  for (const e of staleEvents) {
    const hours = Math.floor((now - new Date(e.received_at)) / 3600000);
    findings.push({
      kind: 'unmatched_event_stale', event_id: String(e.id), event_type: e.event_type, plan_id: e.plan_id || null,
      order_id: e.order_id || null, buyer_email_masked: maskEmail(e.buyer_email), received_at: new Date(e.received_at).toISOString(), hours_old: hours,
      summary: `Unmatched ${e.event_type} for ${maskEmail(e.buyer_email)} received ${hours} hours ago. No portal account has that email yet.`
    });
  }

  // 4. Active, past current_period_end, and no billing event since the period ended.
  for (const row of subs) {
    if (row.status !== 'active' || !row.current_period_end) continue;
    const end = new Date(row.current_period_end);
    if (!(end < now)) continue;
    if (row.last_event_at && new Date(row.last_event_at) > end) continue;
    const days = Math.floor((now - end) / dayMs);
    findings.push({
      kind: 'active_past_period_end', client_id: Number(row.client_id), order_id: row.wix_subscription_id || null,
      period_end: end.toISOString(), days_overdue: days,
      summary: `Client ${row.client_id} is active but its period ended ${days} day${days === 1 ? '' : 's'} ago (${end.toISOString().slice(0, 10)}) and no billing event has arrived since.`
    });
  }
  return { findings, unverifiable };
}

async function recordRun(run) {
  await db.query(
    `INSERT INTO billing_reconcile_runs(status,error,wix_orders_seen,truncated,counts,findings) VALUES($1,$2,$3,$4,$5,$6)`,
    [run.status, run.error || null, run.wix_orders_seen || 0, !!run.truncated, JSON.stringify(run.counts || {}), JSON.stringify(run.findings || [])]);
  await db.query(`DELETE FROM billing_reconcile_runs WHERE ran_at < NOW() - INTERVAL '60 days'`);
}

// One check. Returns the run it recorded, or {status:'skipped'} when the Wix settings are not all present.
async function runReconciliation({ env = process.env, fetchImpl = globalThis.fetch, now = new Date(), log = console.log, warn = console.warn } = {}) {
  const cfg = config(env);
  if (!cfg.ok) return { status: 'skipped', missing: cfg.missing };
  let fetched;
  try {
    fetched = await fetchWixOrders({ apiKey: cfg.apiKey, siteId: cfg.siteId, fetchImpl });
  } catch (error) {
    const run = { status: 'error', error: String(error.message || error).slice(0, 300) };
    warn(`[billing-reconcile] Could not read Wix orders: ${run.error}`);
    await recordRun(run);
    return run;
  }
  const subs = (await db.query(
    `SELECT client_id,wix_plan_id,wix_subscription_id,status,current_period_end,last_event_at FROM billing_subscriptions`)).rows;
  const orderIds = fetched.orders.filter(o => o.status === 'ACTIVE').map(o => o.id);
  const eventsByOrder = new Map();
  if (orderIds.length) {
    const ev = (await db.query(
      `SELECT payload->>'subscription_id' AS order_id,event_type,outcome FROM billing_events
       WHERE source='wix' AND payload->>'subscription_id' = ANY($1::text[])`, [orderIds])).rows;
    for (const e of ev) { if (!eventsByOrder.has(e.order_id)) eventsByOrder.set(e.order_id, []); eventsByOrder.get(e.order_id).push(e); }
  }
  const cutoff = new Date(now.getTime() - STALE_UNMATCHED_HOURS * 3600000);
  const staleEvents = (await db.query(
    `SELECT id,event_type,payload->>'buyer_email' AS buyer_email,payload->>'plan_id' AS plan_id,
            payload->>'subscription_id' AS order_id,received_at
     FROM billing_events WHERE outcome='unmatched' AND received_at < $1 ORDER BY received_at LIMIT 200`, [cutoff])).rows;

  const { findings, unverifiable } = compare({ orders: fetched.orders, subs, eventsByOrder, staleEvents, plans: cfg.plans, truncated: fetched.truncated, now });
  const counts = Object.fromEntries(KINDS.map(k => [k, findings.filter(f => f.kind === k).length]));
  counts.active_without_order_id = unverifiable;
  const run = { status: 'ok', wix_orders_seen: fetched.orders.length, truncated: fetched.truncated, counts, findings };
  await recordRun(run);
  log(`[billing-reconcile] Done. Wix orders read: ${fetched.orders.length}${fetched.truncated ? ' (list cut off at the page limit)' : ''}. Findings: ${findings.length} (${KINDS.map(k => `${k}=${counts[k]}`).join(', ')}). Active subscriptions with no Wix order id to check: ${unverifiable}.`);
  for (const f of findings) warn(`[billing-reconcile] ${f.kind}: ${f.summary}`);
  return run;
}

async function latestRun() {
  const row = (await db.query(
    `SELECT ran_at,status,error,wix_orders_seen,truncated,counts,findings FROM billing_reconcile_runs ORDER BY ran_at DESC LIMIT 1`)).rows[0];
  return row || null;
}

function isDue(last, now) {
  if (!last) return true;
  const age = now - new Date(last.ran_at);
  return age >= (last.status === 'ok' ? OK_RUN_EVERY_MS : ERROR_RETRY_MS);
}

// Runs the check if one is due. A Postgres advisory lock keeps two app instances from running it at once.
async function runIfDue(opts = {}) {
  const now = opts.now || new Date();
  const client = await db.connect();
  try {
    const locked = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY])).rows[0].ok;
    if (!locked) return { status: 'skipped', reason: 'locked' };
    try {
      if (!isDue(await latestRun(), now)) return { status: 'skipped', reason: 'not_due' };
      return await runReconciliation({ ...opts, now });
    } finally { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); }
  } finally { client.release(); }
}

// Smallest in-process schedule (the app has no scheduler or worker): check every 30 minutes, run when the last
// good run is 23 hours old. Returns null, after ONE log line, when the Wix settings are not all present.
function startSchedule({ env = process.env, log = console.log } = {}) {
  const cfg = config(env);
  if (!cfg.ok) {
    log(`[billing-reconcile] Inactive: ${cfg.missing.join(', ')} not set, so the daily Wix billing check does not run. See docs/billing-reconcile.md.`);
    return null;
  }
  const tick = () => runIfDue({ env }).catch(error => console.error('[billing-reconcile] Check failed:', error.message));
  const first = setTimeout(tick, FIRST_CHECK_DELAY_MS);
  const timer = setInterval(tick, CHECK_EVERY_MS);
  first.unref?.(); timer.unref?.();
  log('[billing-reconcile] Daily Wix billing check scheduled (report only, about once a day).');
  return { stop() { clearTimeout(first); clearInterval(timer); } };
}

module.exports = { config, compare, fetchWixOrders, runReconciliation, runIfDue, latestRun, startSchedule, isDue, maskEmail, KINDS };

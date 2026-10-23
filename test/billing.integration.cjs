// Isolated schema; mocks nothing external because billing events arrive over HTTP only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ quiet: true });
const { Client } = require('pg');

test('wix billing: auth, validation, idempotency, ordering, tenant match, reconciliation', async () => {
 const schema = 'billing_verification_' + Date.now();
 const setup = new Client({ connectionString: process.env.DATABASE_URL }); await setup.connect();
 await setup.query(`CREATE SCHEMA ${schema}`);
 const url = new URL(process.env.DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`); process.env.DATABASE_URL = url.toString();
 process.env.ADMIN_API_KEY = 'billing-integration-'.repeat(3); process.env.WIX_INTAKE_SECRET = 'billing-intake-secret-'.repeat(3);
 process.env.WIX_PLAN_IDS = 'plan-basic'; process.env.SMS_SEND_ENABLED = 'false';
 const db = require('../src/db'), request = require('supertest'), app = require('../src/server'), billing = require('../src/billing');
 const post = body => request(app).post('/integrations/wix/billing/events').set('Authorization', 'Bearer ' + process.env.WIX_INTAKE_SECRET).send(body);
 const ev = (over = {}) => ({ event_id: 'e1', event_type: 'plan_purchased', plan_id: 'plan-basic', buyer_email: 'owner@example.invalid', occurred_at: '2026-01-01T00:00:00.000Z', ...over });
 const status = async id => (await db.query('SELECT status FROM billing_subscriptions WHERE client_id=$1', [id])).rows[0]?.status;
 try {
  for (const file of fs.readdirSync(path.join(__dirname, '../db/migrations')).filter(f => f.endsWith('.sql')).sort()) await db.query(fs.readFileSync(path.join(__dirname, '../db/migrations', file), 'utf8'));
  const client = (await db.query("INSERT INTO clients(name) VALUES('Billing Test') RETURNING id")).rows[0];
  await db.query("INSERT INTO customer_invites(token_hash,client_id,email,expires_at) VALUES('h',$1,'owner@example.invalid',NOW()+INTERVAL '1 day')", [client.id]);

  assert.equal((await request(app).post('/integrations/wix/billing/events').send(ev())).status, 401);
  assert.equal((await post({ event_id: 'bad' })).status, 400);
  assert.equal((await post(ev({ event_type: 'free_money' }))).status, 400);
  assert.equal((await post(ev({ buyer_email: 'not-an-email' }))).status, 400);

  const first = await post(ev());
  assert.equal(first.status, 202); assert.equal(first.body.outcome, 'applied');
  assert.equal(await status(client.id), 'active');
  assert.equal(await billing.isSubscriptionActive(client.id), true);

  const replay = await post(ev({ event_type: 'plan_cancelled' }));
  assert.equal(replay.status, 200); assert.equal(replay.body.duplicate, true);
  assert.equal(await status(client.id), 'active');

  assert.equal((await post(ev({ event_id: 'e2', event_type: 'plan_cancelled', occurred_at: '2026-02-01T00:00:00.000Z' }))).status, 202);
  assert.equal(await status(client.id), 'cancelled');
  await post(ev({ event_id: 'e3', event_type: 'payment_succeeded', occurred_at: '2026-01-15T00:00:00.000Z' }));
  assert.equal(await status(client.id), 'cancelled');
  assert.equal(await billing.isSubscriptionActive(client.id), false);
  await post(ev({ event_id: 'e4', event_type: 'payment_refunded', occurred_at: '2026-03-01T00:00:00.000Z' }));
  assert.equal(await status(client.id), 'refunded');

  assert.equal((await post(ev({ event_id: 'e5', plan_id: 'plan-other' }))).body.outcome, 'ignored');
  const stranger = await post(ev({ event_id: 'e6', buyer_email: 'late@example.invalid' }));
  assert.equal(stranger.body.outcome, 'unmatched');
  assert.equal(await billing.isSubscriptionActive(999999), false);

  const late = (await db.query("INSERT INTO clients(name) VALUES('Late Buyer') RETURNING id")).rows[0];
  await db.query("INSERT INTO customer_invites(token_hash,client_id,email,expires_at) VALUES('h2',$1,'late@example.invalid',NOW()+INTERVAL '1 day')", [late.id]);
  assert.deepEqual(await billing.reconcileUnmatched(), { applied: 1 });
  assert.equal(await status(late.id), 'active');
  assert.equal(await status(client.id), 'refunded');

  const operator = request.agent(app);
  assert.equal((await request(app).get('/admin/customer-workspaces/billing/unmatched')).status, 401);
  await operator.post('/operator/session').send({ key: process.env.ADMIN_API_KEY });
  const list = await operator.get('/admin/customer-workspaces');
  assert.equal(list.body.find(c => c.id === String(late.id) || c.id === late.id).subscription_status, 'active');
 } finally {
  await db.end().catch(() => {});
  await setup.query(`DROP SCHEMA ${schema} CASCADE`); await setup.end();
 }
});

// Isolated schema. An upgrade followed by the old order's cancellation must leave the new plan active.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ quiet: true });
const { Client } = require('pg');

test('wix billing: a cancel for the old order does not cancel the upgraded plan', async () => {
 const schema = 'plan_change_verification_' + Date.now();
 const setup = new Client({ connectionString: process.env.DATABASE_URL }); await setup.connect();
 await setup.query(`CREATE SCHEMA ${schema}`);
 const url = new URL(process.env.DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`); process.env.DATABASE_URL = url.toString();
 process.env.ADMIN_API_KEY = 'plan-change-integration-'.repeat(3); process.env.WIX_INTAKE_SECRET = 'plan-change-intake-secret-'.repeat(3);
 process.env.WIX_PLAN_IDS = 'plan-watch,plan-pro'; process.env.SMS_SEND_ENABLED = 'false';
 const db = require('../src/db'), request = require('supertest'), app = require('../src/server');
 const post = body => request(app).post('/integrations/wix/billing/events').set('Authorization', 'Bearer ' + process.env.WIX_INTAKE_SECRET).send(body);
 const ev = (over = {}) => ({ event_id: 'x', event_type: 'plan_purchased', plan_id: 'plan-watch', subscription_id: 'order-old', buyer_email: 'upg@example.invalid', occurred_at: '2026-05-01T00:00:00.000Z', ...over });
 const row = async id => (await db.query('SELECT status,wix_plan_id,wix_subscription_id FROM billing_subscriptions WHERE client_id=$1', [id])).rows[0];
 try {
  for (const file of fs.readdirSync(path.join(__dirname, '../db/migrations')).filter(f => f.endsWith('.sql')).sort()) await db.query(fs.readFileSync(path.join(__dirname, '../db/migrations', file), 'utf8'));
  const client = (await db.query("INSERT INTO clients(name) VALUES('Upgrader') RETURNING id")).rows[0];
  await db.query("INSERT INTO customer_invites(token_hash,client_id,email,expires_at) VALUES('h',$1,'upg@example.invalid',NOW()+INTERVAL '1 day')", [client.id]);

  assert.equal((await post(ev({ event_id: 'u1' }))).body.outcome, 'applied');
  assert.equal((await post(ev({ event_id: 'u2', plan_id: 'plan-pro', subscription_id: 'order-new', occurred_at: '2026-05-02T00:00:00.000Z' }))).body.outcome, 'applied');
  assert.deepEqual(await row(client.id), { status: 'active', wix_plan_id: 'plan-pro', wix_subscription_id: 'order-new' });

  const stale = await post(ev({ event_id: 'u3', event_type: 'plan_cancelled', occurred_at: '2026-05-03T00:00:00.000Z' }));
  assert.equal(stale.status, 202); assert.equal(stale.body.outcome, 'ignored');
  assert.deepEqual(await row(client.id), { status: 'active', wix_plan_id: 'plan-pro', wix_subscription_id: 'order-new' });
  const expired = await post(ev({ event_id: 'u3b', event_type: 'plan_expired', occurred_at: '2026-05-03T01:00:00.000Z' }));
  assert.equal(expired.body.outcome, 'ignored'); assert.equal((await row(client.id)).status, 'active');

  const real = await post(ev({ event_id: 'u4', event_type: 'plan_cancelled', plan_id: 'plan-pro', subscription_id: 'order-new', occurred_at: '2026-05-04T00:00:00.000Z' }));
  assert.equal(real.body.outcome, 'applied'); assert.equal((await row(client.id)).status, 'cancelled');
 } finally {
  await db.end().catch(() => {});
  await setup.query(`DROP SCHEMA ${schema} CASCADE`); await setup.end();
 }
});

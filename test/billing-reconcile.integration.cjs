// Isolated schema. Wix is faked; nothing leaves the machine.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ quiet: true });
const { Client } = require('pg');

test('daily Wix billing check: four cases, report only, dashboard endpoints', async () => {
 const schema = 'reconcile_verification_' + Date.now();
 const setup = new Client({ connectionString: process.env.DATABASE_URL }); await setup.connect();
 await setup.query(`CREATE SCHEMA ${schema}`);
 const url = new URL(process.env.DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`); process.env.DATABASE_URL = url.toString();
 process.env.ADMIN_API_KEY = 'reconcile-integration-'.repeat(3); process.env.WIX_INTAKE_SECRET = 'reconcile-intake-secret-'.repeat(3);
 process.env.WIX_PLAN_IDS = 'plan-a'; process.env.SMS_SEND_ENABLED = 'false';
 delete process.env.WIX_ORDERS_API_KEY; delete process.env.WIX_SITE_ID;
 const db = require('../src/db'), request = require('supertest'), app = require('../src/server'), reconcile = require('../src/reconcile');
 const quiet = { log() {}, warn() {} };
 try {
  for (const file of fs.readdirSync(path.join(__dirname, '../db/migrations')).filter(f => f.endsWith('.sql')).sort()) await db.query(fs.readFileSync(path.join(__dirname, '../db/migrations', file), 'utf8'));
  const mk = async name => (await db.query('INSERT INTO clients(name) VALUES($1) RETURNING id', [name])).rows[0].id;
  const [c1, c2, c3, c4] = [await mk('Agrees'), await mk('Cancelled in Wix'), await mk('Missed purchase'), await mk('Overdue')];
  const sub = (id, order, status, end, last) => db.query(
   `INSERT INTO billing_subscriptions(client_id,wix_plan_id,wix_subscription_id,status,buyer_email,current_period_end,last_event_at) VALUES($1,'plan-a',$2,$3,'x@example.invalid',$4,$5)`, [id, order, status, end, last]);
  await sub(c1, 'ord-ok', 'active', null, '2026-10-01T00:00:00Z');
  await sub(c2, 'ord-cancelled', 'active', null, '2026-10-01T00:00:00Z');
  await sub(c4, 'ord-overdue', 'active', '2026-10-05T00:00:00Z', '2026-09-05T00:00:00Z');
  await db.query(`INSERT INTO billing_events(source,event_id,event_type,outcome,payload,received_at) VALUES('wix','old','plan_purchased','unmatched',$1,NOW()-INTERVAL '50 hours'),('wix','new','plan_purchased','unmatched',$1,NOW()-INTERVAL '2 hours')`,
   [JSON.stringify({ buyer_email: 'late@example.invalid', plan_id: 'plan-a', subscription_id: 'ord-unmatched' })]);
  const before = (await db.query('SELECT * FROM billing_subscriptions ORDER BY client_id')).rows;
  const eventsBefore = (await db.query('SELECT id,outcome FROM billing_events ORDER BY id')).rows;

  // Inert without settings: no row, no Wix call.
  let called = 0;
  assert.equal((await reconcile.runReconciliation({ env: {}, fetchImpl: async () => { called++; }, ...quiet })).status, 'skipped');
  assert.equal(called, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM billing_reconcile_runs')).rows[0].n, 0);

  const wix = [
   { id: 'ord-ok', planId: 'plan-a', status: 'ACTIVE' },
   { id: 'ord-cancelled', planId: 'plan-a', status: 'CANCELED', cancellation: { cause: 'MEMBER_ACTION' } },
   { id: 'ord-new', planId: 'plan-a', planName: 'Voicemail WATCH', status: 'ACTIVE' },
   { id: 'ord-overdue', planId: 'plan-a', status: 'ACTIVE' }
  ];
  const env = { WIX_ORDERS_API_KEY: 'fake-key', WIX_SITE_ID: 'site', WIX_PLAN_IDS: 'plan-a' };
  const run = await reconcile.runReconciliation({ env, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ orders: wix }) }), now: new Date(), ...quiet });
  assert.equal(run.status, 'ok');
  assert.deepEqual(run.findings.map(f => f.kind).sort(), ['active_past_period_end', 'backend_active_wix_not', 'unmatched_event_stale', 'wix_active_backend_not']);
  assert.equal(run.findings.find(f => f.kind === 'unmatched_event_stale').hours_old >= 50, true);
  assert.equal(run.findings.filter(f => f.kind === 'unmatched_event_stale').length, 1);

  // Report only: subscriptions and events untouched.
  assert.deepEqual((await db.query('SELECT * FROM billing_subscriptions ORDER BY client_id')).rows, before);
  assert.deepEqual((await db.query('SELECT id,outcome FROM billing_events ORDER BY id')).rows, eventsBefore);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM billing_reconcile_runs')).rows[0].n, 1);
  assert.equal((await reconcile.latestRun()).findings.length, 4);

  // Not due again right away.
  assert.equal((await reconcile.runIfDue({ env, fetchImpl: async () => { called++; }, ...quiet })).reason, 'not_due');
  assert.equal(called, 0);

  // Operator endpoints.
  assert.equal((await request(app).get('/admin/customer-workspaces/billing/reconcile-report')).status, 401);
  const operator = request.agent(app);
  await operator.post('/operator/session').send({ key: process.env.ADMIN_API_KEY });
  const report = await operator.get('/admin/customer-workspaces/billing/reconcile-report');
  assert.equal(report.status, 200);
  assert.equal(report.body.configured, false);
  assert.deepEqual(report.body.missing.sort(), ['WIX_ORDERS_API_KEY', 'WIX_SITE_ID']);
  assert.equal(report.body.latest.findings.length, 4);
  const runNow = await operator.post('/admin/customer-workspaces/billing/reconcile-report/run').set('X-HootOwl-Request', 'operator').send({});
  assert.equal(runNow.status, 409);
 } finally {
  await db.end().catch(() => {});
  await setup.query(`DROP SCHEMA ${schema} CASCADE`); await setup.end();
 }
});

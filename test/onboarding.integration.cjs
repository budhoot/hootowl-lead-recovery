// Wix Automations onboarding against an isolated schema: body-secret auth, auto workspace + invite, retries, plan filter.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ quiet: true });
const { Client } = require('pg');

test('wix automation: pays, gets a workspace and invite, registers, and cancels', async () => {
 const schema = 'onboarding_verification_' + Date.now();
 const setup = new Client({ connectionString: process.env.DATABASE_URL }); await setup.connect();
 await setup.query(`CREATE SCHEMA ${schema}`);
 const url = new URL(process.env.DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`); process.env.DATABASE_URL = url.toString();
 process.env.ADMIN_API_KEY = 'onboarding-integration-'.repeat(3); process.env.WIX_INTAKE_SECRET = 'onboarding-intake-secret-'.repeat(3);
 process.env.WIX_PLAN_IDS = 'plan-pro'; process.env.TWILIO_PUBLIC_BASE_URL = 'https://api.example.test';
 const db = require('../src/db'), request = require('supertest'), app = require('../src/server'), billing = require('../src/billing');
 const secret = process.env.WIX_INTAKE_SECRET;
 const post = body => request(app).post('/integrations/wix/automation').send({ secret, ...body });
 const buy = (over = {}) => ({ event: 'plan_purchased', plan_id: 'plan-pro', order_id: 'order-1', email: 'Jane@Example.invalid',
  first_name: 'Jane', last_name: 'Doe', valid_until: '', ...over });
 const token = link => new URL(link).hash.replace('#invite=', '');
 const clientCount = async () => Number((await db.query('SELECT count(*) FROM clients')).rows[0].count);
 try {
  for (const file of fs.readdirSync(path.join(__dirname, '../db/migrations')).filter(f => f.endsWith('.sql')).sort()) await db.query(fs.readFileSync(path.join(__dirname, '../db/migrations', file), 'utf8'));

  assert.equal((await request(app).post('/integrations/wix/automation').send(buy())).status, 401);
  assert.equal((await request(app).post('/integrations/wix/automation').send({ ...buy(), secret: 'wrong' })).status, 401);
  assert.equal((await post({ ...buy(), email: 'nope' })).status, 400);
  assert.equal((await post({ ...buy(), event: 'free_money' })).status, 400);

  // A new buyer gets a workspace named after them, an active subscription, and a working 7-day invite.
  const first = await post(buy());
  assert.equal(first.status, 202); assert.equal(first.body.invited, true); assert.equal(first.body.outcome, 'applied');
  assert.match(first.body.onboarding_link, /^https:\/\/api\.example\.test\/portal\/#invite=[a-f0-9]{64}$/);
  const client = (await db.query("SELECT c.id,c.name FROM clients c JOIN customer_invites i ON i.client_id=c.id WHERE i.email='jane@example.invalid'")).rows[0];
  assert.equal(client.name, 'Jane Doe');
  assert.equal(await billing.isSubscriptionActive(client.id), true);
  const expires = (await db.query("SELECT expires_at>NOW()+INTERVAL '6 days' AS ok FROM customer_invites WHERE email='jane@example.invalid'")).rows[0].ok;
  assert.equal(expires, true);

  // A Wix retry of the same order is a duplicate, keeps the same workspace, and replaces the unsent link.
  const retry = await post(buy());
  assert.equal(retry.status, 200); assert.equal(retry.body.duplicate, true); assert.equal(retry.body.invited, true);
  assert.equal(await clientCount(), 1);
  const reject = await request(app).post('/portal/api/invitation').set('X-HootOwl-Request', 'customer').send({ token: token(first.body.onboarding_link) });
  assert.equal(reject.status, 400);
  const accept = await request(app).post('/portal/api/invitation').set('X-HootOwl-Request', 'customer').send({ token: token(retry.body.onboarding_link) });
  assert.equal(accept.status, 200); assert.equal(accept.body.email, 'jane@example.invalid');

  const registered = await request(app).post('/portal/api/register').set('X-HootOwl-Request', 'customer').send({ token: token(retry.body.onboarding_link), display_name: 'Jane', password: 'correct horse battery' });
  assert.equal(registered.status, 201);

  // Someone who already has an account gets the sign-in page instead of a new workspace.
  const again = await post(buy({ order_id: 'order-2' }));
  assert.equal(again.status, 202); assert.equal(again.body.invited, false);
  assert.equal(again.body.onboarding_link, 'https://api.example.test/portal/');
  assert.equal(await clientCount(), 1);

  // A plan that is not on the list is ignored and creates nothing.
  const other = await post(buy({ order_id: 'order-3', plan_id: 'plan-unknown', email: 'stranger@example.invalid' }));
  assert.equal(other.body.outcome, 'ignored'); assert.equal(other.body.invited, false);
  assert.equal(await clientCount(), 1);

  // Cancelling turns the subscription off; the original header auth still works too.
  assert.equal((await post({ ...buy({ order_id: 'order-2', event: 'plan_cancelled' }) })).status, 202);
  assert.equal(await billing.isSubscriptionActive(client.id), false);
  const header = await request(app).post('/integrations/wix/billing/events').set('Authorization', 'Bearer ' + secret)
   .send({ event_id: 'e-header', event_type: 'plan_purchased', plan_id: 'plan-pro', buyer_email: 'jane@example.invalid' });
  assert.equal(header.status, 202);
 } finally {
  await db.end().catch(() => {});
  await setup.query(`DROP SCHEMA ${schema} CASCADE`); await setup.end();
 }
});

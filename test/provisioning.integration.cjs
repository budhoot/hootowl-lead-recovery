// Isolated schema; Twilio is replaced by an in-memory fake, so no accounts or numbers are ever created.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ quiet: true });
const { Client } = require('pg');

test('twilio provisioning: consent, subscription gate, idempotency, failure/retry, subaccount webhooks, usage', async () => {
 const schema = 'prov_verification_' + Date.now();
 const setup = new Client({ connectionString: process.env.DATABASE_URL }); await setup.connect();
 await setup.query(`CREATE SCHEMA ${schema}`);
 const url = new URL(process.env.DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`); process.env.DATABASE_URL = url.toString();
 const MASTER = 'AC' + '1'.repeat(32), SUB = 'AC' + '2'.repeat(32);
 Object.assign(process.env, { ADMIN_API_KEY: 'prov-integration-'.repeat(3), WIX_INTAKE_SECRET: 'prov-intake-secret-'.repeat(3), SMS_SEND_ENABLED: 'false',
  CREDENTIAL_ENCRYPTION_KEY: 'cd'.repeat(32), TWILIO_ACCOUNT_SID: MASTER, TWILIO_AUTH_TOKEN: 'master-token', TWILIO_PUBLIC_BASE_URL: 'https://example.test' });
 const db = require('../src/db'), request = require('supertest'), twilio = require('twilio'), app = require('../src/server');
 const provisioning = require('../src/provisioning'), usage = require('../src/usage'), billing = require('../src/billing');

 const calls = { create: 0, buy: 0, status: [] }; let failBuy = false; let numberOwned = null;
 provisioning.setClientFactory((sid, token) => sid === MASTER ? {
  api: { v2010: { accounts: Object.assign(sidArg => ({ update: async body => { calls.status.push([sidArg, body.status]); } }),
   { create: async () => { calls.create++; return { sid: SUB, authToken: 'sub-token' }; } }) } }
 } : {
  incomingPhoneNumbers: { list: async () => numberOwned ? [{ phoneNumber: numberOwned }] : [],
   create: async body => { if (failBuy) throw new Error('boom ' + token); calls.buy++; numberOwned = body.phoneNumber; assert.match(body.voiceUrl, /^https:\/\/example\.test\/webhooks\/twilio\/voice$/); return { phoneNumber: body.phoneNumber }; } },
  availablePhoneNumbers: () => ({ local: { list: async () => [{ phoneNumber: '+19405550100' }] } })
 });

 const signedPost = (route, params, accountSid, token) => request(app).post('/webhooks/twilio' + route)
  .set('X-Twilio-Signature', twilio.getExpectedTwilioSignature(token, 'https://example.test/webhooks/twilio' + route, params)).type('form').send(params);
 const write = (agent, url, body) => agent.post(url).set('X-HootOwl-Request', 'customer').send(body);
 try {
  for (const file of fs.readdirSync(path.join(__dirname, '../db/migrations')).filter(f => f.endsWith('.sql')).sort()) await db.query(fs.readFileSync(path.join(__dirname, '../db/migrations', file), 'utf8'));
  const client = (await db.query("INSERT INTO clients(name) VALUES('Prov Test') RETURNING id")).rows[0];
  const other = (await db.query("INSERT INTO clients(name) VALUES('Other') RETURNING id")).rows[0];
  const hashToken = 'd'.repeat(64);
  await db.query("INSERT INTO customer_invites(token_hash,client_id,email,expires_at) VALUES($1,$2,'p@example.invalid',NOW()+INTERVAL '1 day')", [require('../src/auth').hash(hashToken), client.id]);
  const user = request.agent(app);
  await write(user, '/portal/api/register', { token: hashToken, display_name: 'P', password: 'a long test passphrase 451' });

  // No subscription: setup is refused and nothing is created.
  assert.equal((await write(user, '/portal/api/provisioning', { consent: true })).status, 402);
  assert.equal(calls.create, 0);
  assert.equal((await write(user, '/portal/api/provisioning', { consent: false })).status, 400);
  assert.equal((await write(user, '/portal/api/provisioning', { consent: true, area_code: '12' })).status, 400);
  assert.equal((await request(app).post('/portal/api/provisioning').send({ consent: true })).status, 403);

  await db.query("INSERT INTO billing_subscriptions(client_id,wix_plan_id,status) VALUES($1,'p','active')", [client.id]);
  failBuy = true;
  assert.equal((await write(user, '/portal/api/provisioning', { consent: true })).status, 502);
  let prov = (await db.query('SELECT * FROM twilio_provisioning WHERE client_id=$1', [client.id])).rows[0];
  assert.equal(prov.status, 'failed'); assert.equal(prov.subaccount_sid, SUB);
  assert.ok(!prov.credential_ref.includes('sub-token')); assert.ok(!prov.last_error.includes('sub-token')); assert.match(prov.last_error, /redacted/);

  failBuy = false;
  assert.equal((await write(user, '/portal/api/provisioning', { consent: true, area_code: '940' })).status, 201);
  assert.equal(calls.create, 1, 'retry must reuse the existing subaccount');
  assert.equal((await write(user, '/portal/api/provisioning', { consent: true })).status, 200);
  assert.equal(calls.buy, 1); assert.equal(calls.create, 1);
  const route = (await db.query("SELECT * FROM client_phone_numbers WHERE client_id=$1", [client.id])).rows[0];
  assert.equal(route.twilio_number, '+19405550100'); assert.equal(route.is_active, false); assert.equal(route.destination_number, null);
  assert.equal((await user.get('/portal/api/subscription')).body.provisioning.status, 'active');

  // Saving a forwarding number activates a provisioned route and turns off intake for it.
  assert.equal((await user.patch('/portal/api/routes/' + route.id).set('X-HootOwl-Request', 'customer').send({ destination_number: '+19405550199' })).status, 200);
  const live = (await db.query('SELECT is_active,intake_enabled,destination_number FROM client_phone_numbers WHERE id=$1', [route.id])).rows[0];
  assert.deepEqual(live, { is_active: true, intake_enabled: false, destination_number: '+19405550199' });

  // Webhooks from the subaccount verify with the subaccount token, not the master token.
  const params = { AccountSid: SUB, CallSid: 'CA' + 'a'.repeat(32), To: '+19405550100', From: '+15550001111' };
  assert.equal((await signedPost('/voice', params, SUB, 'sub-token')).status, 200);
  assert.equal((await signedPost('/voice', params, SUB, 'master-token')).status, 403);
  assert.equal((await signedPost('/voice', { ...params, AccountSid: 'AC' + '9'.repeat(32) }, '', 'sub-token')).status, 403);
  assert.equal((await signedPost('/voice', { ...params, AccountSid: 'not-a-sid' }, '', 'sub-token')).status, 403);
  assert.equal((await signedPost('/voice', { ...params, AccountSid: MASTER }, MASTER, 'master-token')).status, 200);

  // Usage: per started minute, once per CallSid; incomplete and unknown calls are ignored.
  const done = { ...params, CallStatus: 'completed', CallDuration: '61' };
  assert.equal((await signedPost('/call-status', done, SUB, 'sub-token')).status, 204);
  assert.equal((await signedPost('/call-status', done, SUB, 'sub-token')).status, 204);
  assert.equal((await signedPost('/call-status', { ...done, CallSid: 'CA' + 'b'.repeat(32), CallStatus: 'ringing' }, SUB, 'sub-token')).status, 204);
  assert.equal((await signedPost('/call-status', { ...done, CallSid: 'CA' + 'c'.repeat(32), To: '+19990000000' }, SUB, 'sub-token')).status, 204);
  assert.deepEqual(await usage.summary(client.id), [{ kind: 'call', quantity: 2, events: 1 }]);
  assert.deepEqual(await usage.summary(other.id), []);
  assert.equal(usage.billableMinutes('0'), 0); assert.equal(usage.billableMinutes('abc'), 0); assert.equal(usage.billableMinutes('60'), 1); assert.equal(usage.billableMinutes('61'), 2);

  // Cancellation suspends the subaccount; reactivation restores it; stale events do not.
  await db.query("INSERT INTO customer_users(client_id,email,display_name,password_hash) VALUES($1,'p2@example.invalid','x','x')", [client.id]);
  process.env.WIX_PLAN_IDS = 'p';
  const ev = (id, type, at) => request(app).post('/integrations/wix/billing/events').set('Authorization', 'Bearer ' + process.env.WIX_INTAKE_SECRET)
   .send({ event_id: id, event_type: type, plan_id: 'p', buyer_email: 'p@example.invalid', occurred_at: at });
  await db.query("UPDATE billing_subscriptions SET last_event_at='2020-01-01'");
  await ev('x1', 'plan_cancelled', '2026-01-01T00:00:00.000Z');
  assert.deepEqual(calls.status.at(-1), [SUB, 'suspended']);
  await ev('x2', 'plan_purchased', '2025-06-01T00:00:00.000Z');
  assert.deepEqual(calls.status.at(-1), [SUB, 'suspended']);
  await ev('x3', 'plan_purchased', '2026-02-01T00:00:00.000Z');
  assert.deepEqual(calls.status.at(-1), [SUB, 'active']);
  assert.equal(await billing.isSubscriptionActive(client.id), true);
 } finally {
  provisioning.setClientFactory(null);
  await db.end().catch(() => {});
  await setup.query(`DROP SCHEMA ${schema} CASCADE`); await setup.end();
 }
});

// Isolated schema; SMS sending is replaced by an in-memory sender.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ quiet: true });
const { Client } = require('pg');

test('customer 2FA: TOTP + SMS enrollment, login challenge, recovery codes, lockout, replay, disable', async () => {
 const schema = 'twofa_verification_' + Date.now();
 const setup = new Client({ connectionString: process.env.DATABASE_URL }); await setup.connect();
 await setup.query(`CREATE SCHEMA ${schema}`);
 const url = new URL(process.env.DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`); process.env.DATABASE_URL = url.toString();
 process.env.ADMIN_API_KEY = 'twofa-integration-'.repeat(3); process.env.TWOFA_ENCRYPTION_KEY = 'ab'.repeat(32); process.env.SMS_SEND_ENABLED = 'false';
 const db = require('../src/db'), request = require('supertest'), app = require('../src/server'), twofa = require('../src/twofa'), sms = require('../src/sms');
 const sent = []; let sidCounter = 0;
 sms.setSender(async (to, body) => { sent.push({ to, body }); return { sent: true, sid: 'SMtest' + (++sidCounter) }; });
 const lastCode = () => sent[sent.length - 1].body.match(/\b(\d{6})\b/)[1];
 const write = (agent, method, url, body) => agent[method](url).set('X-HootOwl-Request', 'customer').send(body);
 const pw = 'a long test passphrase 451';
 try {
  for (const file of fs.readdirSync(path.join(__dirname, '../db/migrations')).filter(f => f.endsWith('.sql')).sort()) await db.query(fs.readFileSync(path.join(__dirname, '../db/migrations', file), 'utf8'));
  const client = (await db.query("INSERT INTO clients(name) VALUES('2FA Test') RETURNING id")).rows[0];
  const token = 'c'.repeat(64);
  await db.query("INSERT INTO customer_invites(token_hash,client_id,email,expires_at) VALUES($1,$2,'u@example.invalid',NOW()+INTERVAL '1 day')", [require('../src/auth').hash(token), client.id]);
  const user = request.agent(app);
  assert.equal((await write(user, 'post', '/portal/api/register', { token, display_name: 'U', password: pw })).status, 201);

  assert.equal((await user.get('/portal/api/2fa')).body.totp, false);
  assert.equal((await request(app).get('/portal/api/2fa')).status, 401);
  assert.equal((await write(user, 'post', '/portal/api/2fa/totp/confirm', { code: '123456' })).status, 400);

  const setupRes = await write(user, 'post', '/portal/api/2fa/totp/setup', {});
  assert.match(setupRes.body.otpauth_uri, /^otpauth:\/\/totp\//);
  const secret = setupRes.body.secret;
  assert.notEqual((await db.query('SELECT secret_enc FROM customer_totp')).rows[0].secret_enc, secret);
  assert.equal((await write(user, 'post', '/portal/api/2fa/totp/confirm', { code: '000000' })).status, 400);
  const step = twofa.currentStep();
  const confirm = await write(user, 'post', '/portal/api/2fa/totp/confirm', { code: twofa.totpAt(secret, step) });
  assert.equal(confirm.status, 200); assert.equal(confirm.body.recovery_codes.length, 8);
  const recovery = confirm.body.recovery_codes;
  assert.equal((await db.query('SELECT code_hash FROM customer_recovery_codes WHERE code_hash=$1', [recovery[0]])).rowCount, 0);
  assert.equal((await write(user, 'post', '/portal/api/2fa/totp/setup', {})).status, 409);

  // Password alone no longer signs in.
  const fresh = () => request.agent(app);
  const start = async () => (await write(fresh(), 'post', '/portal/api/session', { email: 'u@example.invalid', password: pw })).body;
  let a = fresh(); const res1 = await write(a, 'post', '/portal/api/session', { email: 'u@example.invalid', password: pw });
  assert.equal(res1.body.two_factor_required, true); assert.equal(res1.headers['set-cookie'], undefined);
  assert.equal((await a.get('/portal/api/workspace')).status, 401);

  // Replay protection: the code used at enrollment is rejected at login; the next step works.
  assert.equal((await write(a, 'post', '/portal/api/session/2fa', { challenge: res1.body.challenge, method: 'totp', code: twofa.totpAt(secret, step) })).status, 401);
  const next = await write(a, 'post', '/portal/api/session/2fa', { challenge: res1.body.challenge, method: 'totp', code: twofa.totpAt(secret, step + 1) });
  assert.equal(next.status, 200); assert.equal((await a.get('/portal/api/workspace')).status, 200);
  assert.equal((await write(a, 'post', '/portal/api/session/2fa', { challenge: res1.body.challenge, method: 'totp', code: twofa.totpAt(secret, step + 1) })).status, 401);

  // Lockout after repeated wrong codes, even if the right one follows.
  const c2 = (await start()).challenge;
  for (let i = 0; i < 5; i++) assert.equal((await write(fresh(), 'post', '/portal/api/session/2fa', { challenge: c2, method: 'totp', code: '000000' })).status, 401);
  assert.equal((await write(fresh(), 'post', '/portal/api/session/2fa', { challenge: c2, method: 'totp', code: twofa.totpAt(secret, step + 2) })).status, 401);
  assert.equal((await write(fresh(), 'post', '/portal/api/session/2fa', { challenge: 'f'.repeat(64), method: 'totp', code: '123456' })).status, 401);
  assert.equal((await write(fresh(), 'post', '/portal/api/session/2fa', { method: 'totp', code: '123456' })).status, 401);

  // Recovery code works once.
  const c3 = (await start()).challenge, b = fresh();
  assert.equal((await write(b, 'post', '/portal/api/session/2fa', { challenge: c3, method: 'recovery', code: recovery[0] })).status, 200);
  const c4 = (await start()).challenge;
  assert.equal((await write(fresh(), 'post', '/portal/api/session/2fa', { challenge: c4, method: 'recovery', code: recovery[0] })).status, 401);

  // SMS enrollment and login.
  assert.equal((await write(user, 'post', '/portal/api/2fa/sms/setup', { phone: '5551234567' })).status, 400);
  assert.equal((await write(user, 'post', '/portal/api/2fa/sms/setup', { phone: '+15551234567' })).status, 200);
  assert.equal((await write(user, 'post', '/portal/api/2fa/sms/confirm', { code: '000000' })).status, 400);
  assert.equal((await write(user, 'post', '/portal/api/2fa/sms/confirm', { code: lastCode() })).status, 200);
  const status = (await user.get('/portal/api/2fa')).body;
  assert.equal(status.sms, true); assert.match(status.sms_phone, /^\+1\*+4567$/);
  const c5 = (await start()).challenge, d = fresh();
  assert.equal((await write(d, 'post', '/portal/api/session/2fa/sms', { challenge: c5 })).status, 200);
  assert.equal((await write(d, 'post', '/portal/api/session/2fa', { challenge: c5, method: 'sms', code: '000000' })).status, 401);
  assert.equal((await write(d, 'post', '/portal/api/session/2fa', { challenge: c5, method: 'sms', code: lastCode() })).status, 200);
  const ledger = (await db.query("SELECT billable FROM usage_ledger WHERE kind='auth_sms'")).rows;
  assert.equal(ledger.length, 2); assert.ok(ledger.every(r => r.billable === false));

  // Management requires the password; disabling returns login to password-only.
  assert.equal((await write(user, 'post', '/portal/api/2fa/disable', { password: 'wrong password here' })).status, 400);
  assert.equal((await write(user, 'post', '/portal/api/2fa/recovery-codes', { password: pw })).body.recovery_codes.length, 8);
  assert.equal((await write(user, 'post', '/portal/api/2fa/disable', { password: pw })).status, 200);
  assert.equal((await write(fresh(), 'post', '/portal/api/session', { email: 'u@example.invalid', password: pw })).body.authenticated, true);
 } finally {
  sms.setSender(null);
  await db.end().catch(() => {});
  await setup.query(`DROP SCHEMA ${schema} CASCADE`); await setup.end();
 }
});

// Isolated schema; never contacts Twilio or creates production accounts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ quiet: true });
const { Client } = require('pg');

test('customer portal: invitations, tenant isolation, preferences, forwarding, password/session lifecycle', async () => {
 const schema = 'customer_verification_' + Date.now();
 const setup = new Client({ connectionString: process.env.DATABASE_URL }); await setup.connect();
 await setup.query(`CREATE SCHEMA ${schema}`);
 const url = new URL(process.env.DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`); process.env.DATABASE_URL = url.toString();
 process.env.ADMIN_API_KEY = 'customer-integration-'.repeat(3); process.env.SMS_SEND_ENABLED = 'false';
 const db = require('../src/db'), request = require('supertest'), app = require('../src/server');
 const operator = request.agent(app), alice = request.agent(app), bob = request.agent(app);
 const write = (agent, method, url, body) => agent[method](url).set('X-HootOwl-Request', 'customer').send(body);
 const admin = (url, body) => operator.post(url).set('X-HootOwl-Request', 'operator').send(body);
 const goodPassword = 'a long test passphrase 451';
 try {
  for (const file of fs.readdirSync(path.join(__dirname, '../db/migrations')).filter(f => f.endsWith('.sql')).sort()) await db.query(fs.readFileSync(path.join(__dirname, '../db/migrations', file), 'utf8'));
  assert.equal((await request(app).get('/portal/')).status, 200);
  assert.equal((await request(app).get('/portal/manifest.webmanifest')).body.scope, '/portal/');
  assert.equal((await request(app).get('/portal/api/workspace')).status, 401);
  assert.equal((await request(app).post('/admin/customer-workspaces').send({})).status, 401);
  assert.equal((await operator.post('/operator/session').send({ key: process.env.ADMIN_API_KEY })).status, 200);
  const a = await admin('/admin/customer-workspaces', { name: 'Test A', email: 'a@example.invalid' });
  const b = await admin('/admin/customer-workspaces', { name: 'Test B', email: 'b@example.invalid' });
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  const tokenA = a.body.invitation_path.split('=')[1], tokenB = b.body.invitation_path.split('=')[1];
  assert.equal((await write(alice, 'post', '/portal/api/invitation', { token: tokenA })).body.name, 'Test A');
  assert.equal((await write(alice, 'post', '/portal/api/register', { token: tokenA, display_name: 'Alice', password: 'short' })).status, 400);
  assert.equal((await alice.post('/portal/api/register').send({ token: tokenA, display_name: 'Alice', password: goodPassword })).status, 403);
  const reg = await write(alice, 'post', '/portal/api/register', { token: tokenA, display_name: 'Alice', password: goodPassword });
  assert.equal(reg.status, 201); assert.match(reg.headers['set-cookie'][0], /HttpOnly/); assert.match(reg.headers['set-cookie'][0], /SameSite=Strict/); assert.match(reg.headers['set-cookie'][0], /Path=\/portal/);
  assert.equal((await write(bob, 'post', '/portal/api/register', { token: tokenB, display_name: 'Bob', password: goodPassword })).status, 201);
  assert.equal((await write(alice, 'post', '/portal/api/register', { token: tokenA, display_name: 'Alice', password: goodPassword })).status, 400);
  const work = await alice.get('/portal/api/workspace'); assert.equal(work.body.business.name, 'Test A'); assert.equal(work.body.voice_only, true);
  assert.equal(work.headers['cache-control'], 'no-store'); assert.equal(work.body.user.password_hash, undefined);
  assert.equal((await alice.get('/admin/clients')).status, 401);
  assert.equal((await operator.get('/portal/api/workspace')).status, 401);
  const prefs = { display_name: 'Alice Updated', theme: 'dark', accent: 'ocean', density: 'compact', time_format: '24' };
  assert.equal((await alice.patch('/portal/api/preferences').set('X-HootOwl-Request', 'customer').set('Origin', 'https://evil.invalid').send(prefs)).status, 403);
  assert.equal((await write(alice, 'patch', '/portal/api/preferences', { ...prefs, client_id: b.body.client.id })).status, 400);
  assert.equal((await write(alice, 'patch', '/portal/api/preferences', prefs)).status, 200);
  assert.equal((await alice.get('/portal/api/workspace')).body.user.theme, 'dark'); assert.equal((await bob.get('/portal/api/workspace')).body.user.theme, 'system');
  const business = { name: 'Alice Plumbing', contact_name: 'Alice', timezone: 'America/Chicago', booking_url: 'https://example.invalid/book', complete_setup: true };
  assert.equal((await write(alice, 'patch', '/portal/api/business', { ...business, booking_url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await write(alice, 'patch', '/portal/api/business', { ...business, timezone: 'Wrong/Zone' })).status, 400);
  assert.equal((await write(alice, 'patch', '/portal/api/business', business)).status, 200);
  assert.ok((await alice.get('/portal/api/workspace')).body.business.onboarding_completed_at);
  assert.equal((await bob.get('/portal/api/workspace')).body.business.name, 'Test B');
  const routeA = await admin(`/admin/customer-workspaces/${a.body.client.id}/routes`, { twilio_number: '+15005550006', destination_number: '+15005550007' });
  const routeB = await admin(`/admin/customer-workspaces/${b.body.client.id}/routes`, { twilio_number: '+15005550008', destination_number: '+15005550009' });
  assert.equal(routeA.status, 201); assert.equal(routeB.status, 201);
  assert.equal((await admin(`/admin/customer-workspaces/${a.body.client.id}/routes`, {
    twilio_number: '+15005550013', intake_enabled: true,
  })).status, 201);
  assert.equal((await admin(`/admin/customer-workspaces/${a.body.client.id}/routes`, {
    twilio_number: '+15005550014',
  })).status, 400);
  assert.equal((await write(alice, 'patch', '/portal/api/routes/' + routeB.body.id, { destination_number: '+15005550010' })).status, 400);
  assert.equal((await write(alice, 'patch', '/portal/api/routes/' + routeA.body.id, { destination_number: '+15005550008' })).status, 400);
  assert.equal((await write(alice, 'patch', '/portal/api/routes/' + routeA.body.id, { destination_number: '+15005550010', recovery_enabled: true })).status, 400);
  assert.equal((await write(alice, 'patch', '/portal/api/routes/' + routeA.body.id, { destination_number: '+15005550010' })).status, 200);
  assert.equal((await write(alice, 'post', '/portal/api/routes/' + routeA.body.id + '/pause', {})).status, 404);
  await db.query(`INSERT INTO missed_calls(call_sid,client_phone_number_id,caller_number,call_status,operator_notes) VALUES('CAalice',$1,'+15005550011','busy','private operator note'),('CAbob',$2,'+15005550012','busy','other business')`, [routeA.body.id, routeB.body.id]);
  await db.query(`INSERT INTO inbound_messages(message_sid,client_phone_number_id,caller_number,body) VALUES('SMalice',$1,'+15005550011','Alice reply'),('SMbob',$2,'+15005550012','Bob reply')`, [routeA.body.id, routeB.body.id]);
  const leadResult = (await alice.get('/portal/api/leads?client_id=' + b.body.client.id)).body;
  assert.equal(leadResult.calls.length, 1); assert.equal(leadResult.calls[0].call_sid, 'CAalice'); assert.equal(leadResult.calls[0].operator_notes, undefined); assert.equal(leadResult.replies[0].body, 'Alice reply');
  assert.equal((await write(alice, 'patch', '/portal/api/leads/CAbob', { status: 'resolved', notes: 'wrong tenant' })).status, 404);
  assert.equal((await write(alice, 'patch', '/portal/api/leads/CAalice', { status: 'in_progress', notes: '<script>not executed</script>' })).status, 200);
  assert.equal((await alice.get('/portal/api/leads')).body.calls[0].customer_notes, '<script>not executed</script>');
  const secondSession = request.agent(app);
  assert.equal((await write(secondSession, 'post', '/portal/api/session', { email: 'A@EXAMPLE.INVALID', password: goodPassword })).status, 200);
  assert.equal((await write(alice, 'post', '/portal/api/password', { current_password: 'incorrect', new_password: goodPassword + 'new' })).status, 400);
  assert.equal((await write(alice, 'post', '/portal/api/password', { current_password: goodPassword, new_password: goodPassword + 'new' })).status, 200);
  assert.equal((await secondSession.get('/portal/api/workspace')).status, 401);
  assert.equal((await alice.get('/portal/api/workspace')).status, 200);
  assert.equal((await write(alice, 'delete', '/portal/api/session', {})).status, 204);
  assert.equal((await alice.get('/portal/api/workspace')).status, 401);
  assert.equal((await write(alice, 'post', '/portal/api/session', { email: 'a@example.invalid', password: goodPassword })).status, 401);
  assert.equal((await write(alice, 'post', '/portal/api/session', { email: 'a@example.invalid', password: goodPassword + 'new' })).status, 200);
  const invite = await admin(`/admin/customer-workspaces/${a.body.client.id}/invitations`, { email: 'expired@example.invalid' });
  await db.query("UPDATE customer_invites SET expires_at=NOW()-INTERVAL '1 second' WHERE email='expired@example.invalid'");
  assert.equal((await write(bob, 'post', '/portal/api/register', { token: invite.body.invitation_path.split('=')[1], display_name: 'Expired', password: goodPassword })).status, 400);
  assert.equal((await write(bob, 'post', '/portal/api/invitation', { token: '0'.repeat(64) })).status, 400);
  // Public TLS termination still issues Secure cookies and supports same-origin writes.
  const secureLogin = await request(app).post('/portal/api/session').set('Host', 'portal.example.invalid').set('Origin', 'https://portal.example.invalid').set('X-HootOwl-Request', 'customer').send({ email: 'b@example.invalid', password: goodPassword });
  // An unconfigured HTTPS origin is correctly rejected.
  assert.equal(secureLogin.status, 403);
 } finally { await db.end(); await setup.query(`DROP SCHEMA ${schema} CASCADE`); await setup.end(); }
});

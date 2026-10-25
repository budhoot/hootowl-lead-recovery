// Customer AI receptionist page against an isolated schema: save, voice limits, preview call, preview session, daily limit.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
require('dotenv').config({ quiet: true });
const { Client } = require('pg');

test('receptionist: customer saves its assistant, previews it on its own phone, within limits', async () => {
 const schema = 'receptionist_verification_' + Date.now();
 const setup = new Client({ connectionString: process.env.DATABASE_URL }); await setup.connect();
 await setup.query(`CREATE SCHEMA ${schema}`);
 const url = new URL(process.env.DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`); process.env.DATABASE_URL = url.toString();
 process.env.ADMIN_API_KEY = 'receptionist-integration-'.repeat(3); process.env.TWILIO_PUBLIC_BASE_URL = 'https://api.example.test';
 process.env.TWILIO_ACCOUNT_SID = 'AC' + '1'.repeat(32); process.env.TWILIO_AUTH_TOKEN = 'receptionist-token';
 const db = require('../src/db'), request = require('supertest'), twilio = require('twilio'), app = require('../src/server');
 const provisioning = require('../src/provisioning'), voiceAgent = require('../src/voice-agent'), { VOICES } = require('../src/voices');
 const placed = [];
 provisioning.setClientFactory(() => ({ calls: { create: async (params) => { placed.push(params); return { sid: 'CA' + String(placed.length).padStart(32, '0') }; } } }));
 const signed = (route, body) => request(app).post('/webhooks/twilio/' + route).type('form')
  .set('X-Twilio-Signature', twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN, 'https://api.example.test/webhooks/twilio/' + route, body)).send(body);
 const operator = request.agent(app), owner = request.agent(app);
 const write = (method, path, body) => owner[method](path).set('X-HootOwl-Request', 'customer').send(body);
 const profile = { assistant_name: 'Max', business_name: 'Austin Air Pros', name_only_when_asked: true, started_on: '',
  greeting: 'Thanks for calling Austin Air Pros!', closing_line: '', services: 'AC repair', service_area_label: 'Austin, Texas',
  service_radius_miles: 40, place_hints: '', voice_id: VOICES[3].id, ready: false };
 try {
  for (const file of fs.readdirSync(path.join(__dirname, '../db/migrations')).filter(f => f.endsWith('.sql')).sort()) await db.query(fs.readFileSync(path.join(__dirname, '../db/migrations', file), 'utf8'));
  await operator.post('/operator/session').send({ key: process.env.ADMIN_API_KEY });
  const ws = await operator.post('/admin/customer-workspaces').set('X-HootOwl-Request', 'operator').send({ name: 'Austin Air Pros', email: 'max@example.invalid' });
  const token = ws.body.invitation_path.split('=')[1], clientId = ws.body.client.id;
  assert.equal((await write('post', '/portal/api/register', { token, display_name: 'Max', password: 'correct horse battery' })).status, 201);
  await db.query(`INSERT INTO client_phone_numbers(client_id,twilio_number,destination_number,recovery_enabled,intake_enabled,is_active)
   VALUES($1,'+15125550199',NULL,FALSE,TRUE,FALSE)`, [clientId]);

  // Before saving: six voices offered, no profile, and no preview yet.
  const empty = await owner.get('/portal/api/receptionist');
  assert.equal(empty.status, 200); assert.equal(empty.body.profile, null); assert.equal(empty.body.voices.length, 6);
  assert.equal((await write('post', '/portal/api/receptionist/preview', {})).status, 409);

  // Only listed voices; strict fields; the operator-only service center cannot be set here.
  assert.equal((await write('put', '/portal/api/receptionist', { ...profile, voice_id: 'NotAListedVoice' })).status, 400);
  assert.equal((await write('put', '/portal/api/receptionist', { ...profile, service_latitude: 30 })).status, 400);
  assert.equal((await write('put', '/portal/api/receptionist', { ...profile, greeting: '' })).status, 400);
  assert.equal((await owner.put('/portal/api/receptionist').send(profile)).status, 403);
  assert.equal((await write('put', '/portal/api/receptionist', profile)).status, 200);
  const saved = (await owner.get('/portal/api/receptionist')).body;
  assert.equal(saved.profile.assistant_name, 'Max'); assert.equal(saved.profile.has_service_center, false); assert.equal(saved.profile.voice_id, VOICES[3].id);

  // A voice HootOwl set for them stays allowed after the operator changes it.
  await db.query("UPDATE agent_profiles SET voice_id='customVoice123' WHERE client_id=$1", [clientId]);
  assert.equal((await write('put', '/portal/api/receptionist', { ...profile, voice_id: 'customVoice123' })).status, 200);

  // Preview needs a forwarding phone; then it calls that phone from the HootOwl number.
  assert.equal((await write('post', '/portal/api/receptionist/preview', {})).status, 409);
  await db.query("UPDATE client_phone_numbers SET destination_number='+15125550100' WHERE client_id=$1", [clientId]);
  const preview = await write('post', '/portal/api/receptionist/preview', {});
  assert.equal(preview.status, 202); assert.equal(preview.body.calling, '+•••••••0100');
  assert.deepEqual({ to: placed[0].to, from: placed[0].from, url: placed[0].url },
   { to: '+15125550100', from: '+15125550199', url: 'https://api.example.test/webhooks/twilio/preview' });

  // Twilio fetches the preview webhook: the assistant answers with this customer's greeting and voice, even while not ready.
  const answered = await signed('preview', { CallSid: 'CApreview1', From: '+15125550199', To: '+15125550100', AccountSid: process.env.TWILIO_ACCOUNT_SID });
  assert.match(answered.text, /Thanks for calling Austin Air Pros!/); assert.match(answered.text, /voice="customVoice123"/);
  assert.doesNotMatch(answered.text, /<Recording/);
  const session = (await db.query("SELECT is_preview,caller_number FROM voice_agent_sessions WHERE call_sid='CApreview1'")).rows[0];
  assert.deepEqual(session, { is_preview: true, caller_number: '+15125550100' });

  // The relay accepts the preview session (From is the HootOwl number on a call HootOwl placed) and rejects a forged one.
  const relay = (callSid, from, to) => new Promise(resolve => {
   const socket = Object.assign(new EventEmitter(), { readyState: 1, close: code => resolve('closed ' + code), send() {} });
   voiceAgent.handleConnection(socket);
   socket.emit('message', Buffer.from(JSON.stringify({ type: 'setup', callSid, from, to })));
   setTimeout(() => resolve('open'), 300);
  });
  assert.equal(await relay('CApreview1', '+15125550199', '+15125550100'), 'open');
  assert.equal(await relay('CApreview1', '+15125550100', '+15125550199'), 'closed 1008');

  // Previews stay out of the real call list and are limited per day.
  await operator.get('/admin/voice-sessions').then(r => assert.equal(r.body.length, 0));
  for (let i = 2; i <= 10; i++) await db.query(`INSERT INTO voice_agent_sessions(call_sid,client_phone_number_id,caller_number,is_preview)
   SELECT $1,id,'+15125550100',TRUE FROM client_phone_numbers WHERE client_id=$2`, ['CApreview' + i, clientId]);
  assert.equal((await owner.get('/portal/api/receptionist')).body.previews_left, 0);
  assert.equal((await write('post', '/portal/api/receptionist/preview', {})).status, 429);
  assert.equal(placed.length, 1);
 } finally {
  provisioning.setClientFactory(null);
  await db.end().catch(() => {});
  await setup.query(`DROP SCHEMA ${schema} CASCADE`); await setup.end();
 }
});

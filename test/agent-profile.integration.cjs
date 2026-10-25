// Migration 009 against an isolated schema: seeds the existing Nocona customer, then a second
// customer gets its own receptionist through the operator API and the voice webhook.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ quiet: true });
const { Client } = require('pg');

test('agent profiles: Nocona carried over, second customer answered with its own profile', async () => {
 const schema = 'agent_profile_verification_' + Date.now();
 const setup = new Client({ connectionString: process.env.DATABASE_URL }); await setup.connect();
 await setup.query(`CREATE SCHEMA ${schema}`);
 const url = new URL(process.env.DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`); process.env.DATABASE_URL = url.toString();
 process.env.ADMIN_API_KEY = 'agent-profile-integration-'.repeat(3); process.env.TWILIO_PUBLIC_BASE_URL = 'https://api.example.test';
 process.env.TWILIO_AUTH_TOKEN = 'agent-profile-token'; delete process.env.TRIAL_TWILIO_NUMBER;
 const db = require('../src/db'), request = require('supertest'), twilio = require('twilio'), app = require('../src/server');
 const dir = path.join(__dirname, '../db/migrations');
 const run = file => db.query(fs.readFileSync(path.join(dir, file), 'utf8'));
 const voice = (to, sid) => {
  const body = { CallSid: sid, From: '+19405550100', To: to };
  const sig = twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN, 'https://api.example.test/webhooks/twilio/voice', body);
  return request(app).post('/webhooks/twilio/voice').type('form').set('X-Twilio-Signature', sig).send(body);
 };
 try {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  for (const file of files.filter(f => f < '009')) await run(file);
  const nocona = (await db.query("INSERT INTO clients(name) VALUES('Nocona Hills Repair & Replacement') RETURNING id")).rows[0].id;
  await db.query(`INSERT INTO client_phone_numbers(client_id,twilio_number,destination_number,recovery_enabled,intake_enabled)
   VALUES($1,'+19403405234','+19403662774',FALSE,TRUE)`, [nocona]);
  for (const file of files.filter(f => f >= '009')) await run(file);
  await run('009_agent_profiles.sql'); // deploys re-run every migration; a second run must change nothing

  const seeded = (await db.query("SELECT assistant_name,ready,voice_id,to_char(started_on,'FMMonth FMDD, YYYY') AS started FROM agent_profiles WHERE client_id=$1", [nocona])).rows;
  assert.deepEqual(seeded, [{ assistant_name: 'CindyLou Hoot', ready: true, voice_id: 'aEO01A4wXwd1O8GPgGlF', started: 'October 24, 2026' }]);
  const noconaCall = await voice('+19403405234', 'CAnocona');
  assert.match(noconaCall.text, /Hey thanks for calling Nocona Hills Repair and Replace/);
  assert.match(noconaCall.text, /voice="aEO01A4wXwd1O8GPgGlF"/);

  // A second customer: forwards until its profile is ready, then answers with its own greeting and voice.
  const second = (await db.query("INSERT INTO clients(name) VALUES('Austin Air Pros') RETURNING id")).rows[0].id;
  // On Receptionist Pro, so it has AI minutes (customers without a plan forward instead).
  await db.query("INSERT INTO billing_subscriptions(client_id,wix_plan_id,status) VALUES($1,'db1024e0-f106-4c82-84c8-9fa6f96d06fa','active')", [second]);
  await db.query(`INSERT INTO client_phone_numbers(client_id,twilio_number,destination_number,recovery_enabled,intake_enabled)
   VALUES($1,'+15125550199','+15125550100',FALSE,TRUE)`, [second]);
  assert.match((await voice('+15125550199', 'CAsecond1')).text, /<Dial[^>]*>\+15125550100<\/Dial>/);

  const operator = request.agent(app);
  assert.equal((await request(app).put(`/admin/agent-profiles/${second}`).send({})).status, 401);
  await operator.post('/operator/session').send({ key: process.env.ADMIN_API_KEY });
  const put = body => operator.put(`/admin/agent-profiles/${second}`).set('X-HootOwl-Request', 'operator').send(body);
  const profile = { assistant_name: 'Max', business_name: 'Austin Air Pros', greeting: 'Thanks for calling Austin Air Pros, this is Max.',
   service_latitude: 30.2672, service_longitude: -97.7431, service_radius_miles: 40, service_area_label: 'Austin, Texas',
   tts_provider: 'Google', voice_id: 'en-US-Journey-O', ready: true };
  assert.equal((await put({ ...profile, greeting: 'x'.repeat(301) })).status, 400);
  assert.equal((await put({ ...profile, service_longitude: null })).status, 400);
  assert.equal((await put({ ...profile, surprise: 1 })).status, 400);
  assert.equal((await put(profile)).status, 200);
  assert.equal((await operator.get(`/admin/agent-profiles/${second}`)).body.business_name, 'Austin Air Pros');

  const answered = await voice('+15125550199', 'CAsecond2');
  assert.match(answered.text, /Thanks for calling Austin Air Pros, this is Max\./);
  assert.match(answered.text, /ttsProvider="Google"/);
  assert.doesNotMatch(answered.text, /Nocona/);
  assert.match((await voice('+19403405234', 'CAnocona2')).text, /Nocona Hills Repair and Replace/);
 } finally {
  await db.end().catch(() => {});
  await setup.query(`DROP SCHEMA ${schema} CASCADE`); await setup.end();
 }
});

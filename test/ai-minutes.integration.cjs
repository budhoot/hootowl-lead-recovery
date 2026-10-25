// AI minutes against an isolated schema: metering on conversation end, plan allowances, monthly reset,
// forwarding when used up, operator overrides, the customer's Ready switch, and Nocona's unlimited carry-over.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ quiet: true });
const { Client } = require('pg');

const PRO = 'db1024e0-f106-4c82-84c8-9fa6f96d06fa';

test('ai minutes: metered, limited by plan, reset monthly, forwarded when used up, overridable', async () => {
 const schema = 'ai_minutes_verification_' + Date.now();
 const setup = new Client({ connectionString: process.env.DATABASE_URL }); await setup.connect();
 await setup.query(`CREATE SCHEMA ${schema}`);
 const url = new URL(process.env.DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`); process.env.DATABASE_URL = url.toString();
 process.env.ADMIN_API_KEY = 'ai-minutes-integration-'.repeat(3); process.env.TWILIO_PUBLIC_BASE_URL = 'https://api.example.test';
 process.env.TWILIO_AUTH_TOKEN = 'ai-minutes-token';
 const db = require('../src/db'), request = require('supertest'), twilio = require('twilio'), app = require('../src/server'), usage = require('../src/usage');
 const dir = path.join(__dirname, '../db/migrations'), files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
 const signed = (route, body) => request(app).post('/webhooks/twilio/' + route).type('form')
  .set('X-Twilio-Signature', twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN, 'https://api.example.test/webhooks/twilio/' + route, body)).send(body);
 const call = sid => signed('voice', { CallSid: sid, From: '+19405550100', To: '+15125550199' });
 const end = sid => signed('conversation-ended', { CallSid: sid });
 try {
  for (const file of files.filter(f => f < '011')) await db.query(fs.readFileSync(path.join(dir, file), 'utf8'));
  const nocona = (await db.query("INSERT INTO clients(name) VALUES('Nocona Hills Repair & Replacement') RETURNING id")).rows[0].id;
  for (const file of files.filter(f => f >= '011')) await db.query(fs.readFileSync(path.join(dir, file), 'utf8'));
  assert.equal((await usage.aiStatus(nocona)).unlimited, true);

  // A Receptionist Pro customer with a ready assistant and a forwarding phone.
  const pro = (await db.query("INSERT INTO clients(name) VALUES('Pro Customer') RETURNING id")).rows[0].id;
  await db.query("INSERT INTO billing_subscriptions(client_id,wix_plan_id,status) VALUES($1,$2,'active')", [pro, PRO]);
  await db.query(`INSERT INTO client_phone_numbers(client_id,twilio_number,destination_number,recovery_enabled,intake_enabled)
   VALUES($1,'+15125550199','+15125550100',FALSE,TRUE)`, [pro]);
  await db.query(`INSERT INTO agent_profiles(client_id,assistant_name,business_name,greeting,ready) VALUES($1,'Max','Pro Customer','Thanks for calling Pro Customer!',TRUE)`, [pro]);
  assert.deepEqual(await usage.aiStatus(pro), { unlimited: false, allowance: 75, used: 0, remaining: 75, plan: 'Receptionist Pro', source: 'plan' });

  // A 4.2-minute AI conversation is metered as 5 minutes, once, however often Twilio repeats the callback.
  assert.match((await call('CAmeter1')).text, /<ConversationRelay/);
  await db.query("UPDATE voice_agent_sessions SET call_started_at=NOW()-INTERVAL '252 seconds' WHERE call_sid='CAmeter1'");
  await end('CAmeter1'); await end('CAmeter1');
  assert.equal((await usage.aiStatus(pro)).used, 5);

  // Last month's minutes do not count; once this month's reach the allowance, calls forward to the business.
  await db.query(`INSERT INTO usage_ledger(client_id,kind,provider_sid,quantity,occurred_at) VALUES($1,'ai_voice','ai:old',500,NOW()-INTERVAL '40 days')`, [pro]);
  assert.equal((await usage.aiStatus(pro)).used, 5);
  await db.query(`INSERT INTO usage_ledger(client_id,kind,provider_sid,quantity) VALUES($1,'ai_voice','ai:bulk',70)`, [pro]);
  assert.equal((await usage.aiStatus(pro)).remaining, 0);
  const forwarded = await call('CAover1');
  assert.match(forwarded.text, /<Dial[^>]*>\+15125550100<\/Dial>/); assert.doesNotMatch(forwarded.text, /ConversationRelay/);

  // With nowhere to forward, the assistant still answers rather than drop the caller.
  await db.query("UPDATE client_phone_numbers SET destination_number=NULL WHERE client_id=$1", [pro]);
  assert.match((await call('CAover2')).text, /<ConversationRelay/);
  await db.query("UPDATE client_phone_numbers SET destination_number='+15125550100' WHERE client_id=$1", [pro]);

  // Operator overrides: more minutes, unlimited, then back to the plan.
  const operator = request.agent(app);
  await operator.post('/operator/session').send({ key: process.env.ADMIN_API_KEY });
  const allow = body => operator.patch(`/admin/customer-workspaces/${pro}/ai-allowance`).set('X-HootOwl-Request', 'operator').send(body);
  assert.equal((await allow({ unlimited: false, minutes: -1 })).status, 400);
  assert.equal((await allow({ unlimited: false, minutes: 400 })).body.remaining, 325);
  assert.match((await call('CAoverride')).text, /<ConversationRelay/);
  assert.equal((await allow({ unlimited: true, minutes: null })).body.unlimited, true);
  assert.equal((await allow({ unlimited: false, minutes: null })).body.source, 'plan');
  const listed = (await operator.get('/admin/customer-workspaces')).body.find(c => String(c.id) === String(pro));
  assert.equal(listed.ai_minutes.allowance, 75);

  // A cancelled subscription has no AI minutes; previews are never metered.
  await db.query("UPDATE billing_subscriptions SET status='cancelled' WHERE client_id=$1", [pro]);
  assert.equal((await usage.aiStatus(pro)).allowance, 0);
  await db.query(`INSERT INTO voice_agent_sessions(call_sid,client_phone_number_id,caller_number,is_preview,call_started_at)
   SELECT 'CApreviewm',id,'+15125550100',TRUE,NOW()-INTERVAL '3 minutes' FROM client_phone_numbers WHERE client_id=$1`, [pro]);
  await end('CApreviewm');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM usage_ledger WHERE provider_sid='ai:CApreviewm'")).rows[0].n, 0);

  // The customer's Ready switch turns AI answering on for its numbers.
  await db.query("UPDATE client_phone_numbers SET intake_enabled=FALSE WHERE client_id=$1", [pro]);
  const ws = await operator.post('/admin/customer-workspaces/' + pro + '/invitations').set('X-HootOwl-Request', 'operator').send({ email: 'max@example.invalid' });
  const owner = request.agent(app);
  await owner.post('/portal/api/register').set('X-HootOwl-Request', 'customer').send({ token: ws.body.invitation_path.split('=')[1], display_name: 'Max', password: 'correct horse battery' });
  const page = (await owner.get('/portal/api/receptionist')).body;
  assert.equal(page.ai.allowance, 0);
  const save = await owner.put('/portal/api/receptionist').set('X-HootOwl-Request', 'customer').send({ assistant_name: 'Max', business_name: 'Pro Customer',
   name_only_when_asked: true, started_on: '', greeting: 'Thanks for calling Pro Customer!', closing_line: '', services: '', service_area_label: '',
   service_radius_miles: 50, place_hints: '', voice_id: require('../src/voices').VOICES[0].id, ready: true });
  assert.equal(save.status, 200);
  assert.equal((await db.query('SELECT intake_enabled FROM client_phone_numbers WHERE client_id=$1', [pro])).rows[0].intake_enabled, true);
 } finally {
  await db.end().catch(() => {});
  await setup.query(`DROP SCHEMA ${schema} CASCADE`); await setup.end();
 }
});

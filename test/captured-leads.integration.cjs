// Isolated schema; never contacts Twilio. Real Postgres check that a customer reads only their own captured requests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ quiet: true });
const { Client } = require('pg');

test('captured requests: tenant isolation, previews left out, no recording fields', async () => {
 const schema = 'captured_verification_' + Date.now();
 const setup = new Client({ connectionString: process.env.DATABASE_URL }); await setup.connect();
 await setup.query(`CREATE SCHEMA ${schema}`);
 const url = new URL(process.env.DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`); process.env.DATABASE_URL = url.toString();
 const db = require('../src/db'), request = require('supertest'), app = require('../src/server'), { hash } = require('../src/auth');
 try {
  for (const file of fs.readdirSync(path.join(__dirname, '../db/migrations')).filter(f => f.endsWith('.sql')).sort()) await db.query(fs.readFileSync(path.join(__dirname, '../db/migrations', file), 'utf8'));
  const tokens = {}, routes = {};
  for (const [key, number] of [['a', '+15005550031'], ['b', '+15005550032']]) {
   const client = (await db.query('INSERT INTO clients(name) VALUES($1) RETURNING id', ['Business ' + key])).rows[0].id;
   routes[key] = (await db.query('INSERT INTO client_phone_numbers(client_id,twilio_number,destination_number) VALUES($1,$2,$3) RETURNING id', [client, number, '+15005550099'])).rows[0].id;
   const user = (await db.query('INSERT INTO customer_users(client_id,email,display_name,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [client, key + '@example.invalid', key, 'x:y'])).rows[0].id;
   tokens[key] = (key.charCodeAt(0).toString(16).padStart(2, '0')).repeat(32);
   await db.query("INSERT INTO customer_sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '1 day')", [hash(tokens[key]), user]);
  }
  const get = (key, query = '') => request(app).get('/portal/api/captured' + query).set('Cookie', `hootowl_customer=${tokens[key]}`);
  assert.equal((await request(app).get('/portal/api/captured')).status, 401);
  assert.deepEqual((await get('a')).body, { requests: [] });
  await db.query(`INSERT INTO voice_agent_sessions(call_sid,client_phone_number_id,caller_number,customer_name,service_type,service_address,issue_description,recording_url,recording_sid,is_preview,created_at)
   VALUES('VSa1',$1,'+15005550021','Older caller of A','Plumbing','1 A St','Leak','https://api.twilio.com/rec/secret','RE1',FALSE,NOW()-INTERVAL '2 hours'),
   ('VSa4',$1,'+15005550025','Newer caller of A','Electrical','3 A St','Sparks from outlet',NULL,NULL,FALSE,NOW()),
   ('VSa2',$1,'+15005550022','Preview Person','Plumbing','1 A St','Leak',NULL,NULL,TRUE,NOW()),
   ('VSa3',$1,'+15005550023','','','','',NULL,NULL,FALSE,NOW()),
   ('VSb1',$2,'+15005550024','Caller of B','HVAC','2 B St','No heat',NULL,NULL,FALSE,NOW())`, [routes.a, routes.b]);
  const a = await get('a', '?client_id=2'), b = await get('b');
  assert.deepEqual(a.body.requests.map(r => r.customer_name), ['Newer caller of A', 'Older caller of A']);
  assert.deepEqual(b.body.requests.map(r => r.customer_name), ['Caller of B']);
  assert.equal(a.headers['cache-control'], 'no-store');
  assert.doesNotMatch(JSON.stringify(a.body), /recording|twilio\.com|RE1|VSa1/);
  assert.equal((await request(app).get('/portal/api/captured').set('Cookie', 'hootowl_customer=' + '0'.repeat(64))).status, 401);
 } finally { await db.end(); await setup.query(`DROP SCHEMA ${schema} CASCADE`); await setup.end(); }
});

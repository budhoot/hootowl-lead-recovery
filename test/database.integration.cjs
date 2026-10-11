// Uses a separate schema in the configured PostgreSQL database. Never sends SMS.
const {test}=require('node:test');
const assert=require('node:assert/strict');
require('dotenv').config({quiet:true});
const {Client}=require('pg');
const fs=require('node:fs');
const path=require('node:path');
test('real PostgreSQL: migrations, API sessions, routes, intake, callback deduplication, STOP, worker concurrency',async()=>{
 const schema='verification_'+Date.now();
 const setup=new Client({connectionString:process.env.DATABASE_URL});await setup.connect();
 await setup.query(`CREATE SCHEMA ${schema}`);
 const url=new URL(process.env.DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);process.env.DATABASE_URL=url.toString();
 process.env.TWILIO_AUTH_TOKEN='integration-only-token';process.env.TWILIO_PUBLIC_BASE_URL='https://integration.example.test';
 process.env.ADMIN_API_KEY='integration-key-'.repeat(3);process.env.WIX_INTAKE_SECRET='integration-intake-'.repeat(3);process.env.SMS_SEND_ENABLED='true';
 const db=require('../src/db');
 try {
  for(const name of fs.readdirSync(path.join(__dirname,'../db/migrations')).sort())await db.query(fs.readFileSync(path.join(__dirname,'../db/migrations',name),'utf8'));
  const request=require('supertest'),twilio=require('twilio'),app=require('../src/server'),{processOne}=require('../src/worker');
  const session=request.agent(app);
  assert.equal((await session.post('/operator/session').send({key:process.env.ADMIN_API_KEY})).status,200);
  assert.equal((await session.get('/admin/clients')).status,200);
  const create=await session.post('/admin/clients').set('X-HootOwl-Request','operator').send({name:'Integration test business',twilio_number:'+15005550006',destination_number:'+15005550007',recovery_enabled:true});
  assert.equal(create.status,201);const routeId=create.body.route.id;
  const signed=(route,body)=>request(app).post('/webhooks/twilio/'+route).type('form').set('X-Twilio-Signature',twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN,process.env.TWILIO_PUBLIC_BASE_URL+'/webhooks/twilio/'+route,body)).send(body);
  const call={CallSid:'CAintegration1',DialCallStatus:'no-answer',From:'+15005550008',To:'+15005550006'};
  const duplicate=await Promise.all([signed('dial-result',call),signed('dial-result',call)]);assert.ok(duplicate.every(r=>r.status===200));
  assert.equal((await db.query('SELECT count(*) FROM recovery_messages')).rows[0].count,'1');
  await signed('dial-result',{...call,CallSid:'CAintegration2'});
  let sends=0;
  const provider={messages:{create:async()=>{sends++;return {sid:'SM'+'a'.repeat(32)};}}};
  await Promise.all([processOne(provider),processOne(provider)]);assert.equal(sends,1);
  assert.equal((await db.query("SELECT count(*) FROM recovery_messages WHERE state='suppressed'")).rows[0].count,'1');
  assert.equal((await signed('sms',{MessageSid:'SMinbound',From:call.From,To:call.To,Body:'STOP'})).status,200);
  assert.equal((await db.query('SELECT count(*) FROM sms_opt_outs')).rows[0].count,'1');
  await signed('dial-result',{...call,CallSid:'CAintegration3'});await processOne(provider);assert.equal(sends,1);
  assert.equal((await signed('sms-status',{MessageSid:'SM'+'a'.repeat(32),MessageStatus:'delivered'})).status,204);
  assert.equal((await db.query("SELECT delivery_status FROM recovery_messages WHERE state='sent'")).rows[0].delivery_status,'delivered');
  const lead={submission_id:'integration-form',name:'Test lead',email:'test@example.invalid',message:'Integration test only'};
  const intake=()=>request(app).post('/integrations/wix/leads').set('Authorization','Bearer '+process.env.WIX_INTAKE_SECRET).send(lead);
  assert.equal((await intake()).status,201);assert.equal((await intake()).body.duplicate,true);
  const web=(await session.get('/admin/website-leads')).body;assert.equal(web.length,1);
  assert.equal((await session.patch('/admin/website-leads/'+web[0].id).set('X-HootOwl-Request','operator').send({status:'resolved',notes:'Verified'})).status,200);
  assert.equal((await session.patch('/admin/missed-calls/'+call.CallSid).set('X-HootOwl-Request','operator').send({status:'in_progress',notes:'Operator follow-up'})).status,200);
  assert.equal((await session.patch('/admin/routes/'+routeId).set('X-HootOwl-Request','operator').send({destination_number:call.To,is_active:true,recovery_enabled:false})).status,400);
  process.env.SMS_SEND_ENABLED='false';assert.equal(await processOne(provider),false);assert.equal(sends,1);
  assert.equal((await session.delete('/operator/session').set('X-HootOwl-Request','operator')).status,204);
  assert.equal((await session.get('/admin/clients')).status,401);
 } finally {await db.end();await setup.query(`DROP SCHEMA ${schema} CASCADE`);await setup.end();}
});

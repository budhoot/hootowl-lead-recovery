const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const dbPath=require.resolve('../src/db');
let queries=[], rows=[];
const db={ query:async(sql,params)=>{queries.push({sql,params});return rows.shift()||{rows:[],rowCount:0};},connect:async()=>({...db,release(){}})};
require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:db};
const request=require('supertest');
const twilio=require('twilio');
const app=require('../src/server');
const {processOne}=require('../src/worker');
function post(path,body){return request(app).post(path).type('form').set('X-Twilio-Signature',twilio.getExpectedTwilioSignature('test-token','https://api.example.test'+path,body)).send(body);}
beforeEach(()=>{queries=[];rows=[];process.env.TWILIO_AUTH_TOKEN='test-token';process.env.TWILIO_PUBLIC_BASE_URL='https://api.example.test';process.env.ADMIN_API_KEY='x'.repeat(32);});
test('invalid signature cannot enqueue messages',async()=>{const r=await request(app).post('/webhooks/twilio/dial-result').type('form').send({CallSid:'CA1'});assert.equal(r.status,403);assert.equal(queries.length,0);});
test('missed call records and enqueues atomically',async()=>{rows=[{rows:[{id:'1'}]},{rows:[],rowCount:1}];const r=await post('/webhooks/twilio/dial-result',{CallSid:'CA1',DialCallStatus:'no-answer',From:'+14155550100',To:'+18005550100'});assert.equal(r.status,200);assert.match(queries[1].sql,/WITH recorded/);assert.match(queries[1].sql,/INSERT INTO recovery_messages/);});
test('answered calls never enqueue',async()=>{assert.equal((await post('/webhooks/twilio/dial-result',{CallSid:'CA1',DialCallStatus:'completed'})).status,200);assert.equal(queries.length,0);});
test('anonymous caller is not texted',async()=>{assert.equal((await post('/webhooks/twilio/dial-result',{CallSid:'CA1',DialCallStatus:'busy',From:'anonymous',To:'+18005550100'})).status,200);assert.equal(queries.length,0);});
test('admin requires token and validates numbers',async()=>{assert.equal((await request(app).get('/admin/clients')).status,401);assert.equal((await request(app).post('/admin/clients').set('Authorization','Bearer '+'x'.repeat(32)).send({name:'shop',twilio_number:'bad'})).status,400);});
test('STOP stores suppression with reply',async()=>{rows=[{}, {rows:[{id:'1'}]}, {}, {rowCount:1}, {}, {}];const r=await post('/webhooks/twilio/sms',{MessageSid:'SM1',From:'+14155550100',To:'+18005550100',Body:'STOP'});assert.equal(r.status,200);assert.ok(queries.some(q=>q.sql.startsWith('INSERT INTO sms_opt_outs')));});
function workerRows(blocked=0){return [{},{rows:[{id:'1',client_phone_number_id:'2',recipient:'+14155550100'}]},{},{rows:[{id:'2',name:'Shop',twilio_number:'+18005550100',is_active:true,recovery_enabled:true}]},{rowCount:blocked},{rowCount:0}];}
test('worker sends recovery SMS and persists SID',async()=>{rows=[...workerRows(),{},{},{},{},{rows:[{is_active:true,recovery_enabled:true}]},{rowCount:0},{},{}];let sent;await processOne({messages:{create:async v=>{sent=v;return {sid:'SM1'};}}});assert.equal(sent.to,'+14155550100');assert.match(sent.body,/Shop: Sorry we missed your call/);assert.ok(queries.some(q=>q.params?.includes('SM1')));});
test('opt-out suppresses sending',async()=>{rows=[...workerRows(1),{},{}];let sent=false;await processOne({messages:{create:async()=>{sent=true;}}});assert.equal(sent,false);assert.ok(queries.some(q=>q.sql.includes("state='suppressed'")));});
test('uncertain provider response flags review',async()=>{rows=[...workerRows(),{},{},{},{},{rows:[{is_active:true,recovery_enabled:true}]},{rowCount:0},{},{}];await assert.rejects(processOne({messages:{create:async()=>{throw Error('timeout');}}}));assert.ok(queries.some(q=>q.sql.includes("state='review'")));});

test('cooldown suppresses repeated caller',async()=>{const setup=workerRows();setup[5]={rowCount:1};rows=[...setup,{},{}];let sent=false;await processOne({messages:{create:async()=>{sent=true;}}});assert.equal(sent,false);});
test('replayed inbound webhook cannot change opt-out state',async()=>{rows=[{}, {rows:[{id:'1'}]}, {}, {rowCount:0}, {}];assert.equal((await post('/webhooks/twilio/sms',{MessageSid:'SM1',From:'+14155550100',To:'+18005550100',Body:'START'})).status,200);assert.equal(queries.filter(q=>q.sql.startsWith('DELETE FROM sms_opt_outs')).length,0);});

test('health responds',async()=>{const r=await request(app).get('/health');assert.equal(r.status,200);assert.deepEqual(r.body,{status:'ok'});});
test('incoming call forwards to configured business',async()=>{rows=[{rows:[{id:'1',destination_number:'+14155550123'}]}];const r=await post('/webhooks/twilio/voice',{From:'+14155550100',To:'+18005550100'});assert.equal(r.status,200);assert.match(r.text,/<Dial/);assert.match(r.text,/\+14155550123/);assert.match(r.text,/dial-result/);assert.match(r.text,/timeout="15"/);});
test('dial timeout is configurable and falls back when invalid',async()=>{const body={From:'+14155550100',To:'+18005550100'};try{process.env.DIAL_TIMEOUT_SECONDS='20';rows=[{rows:[{id:'1',destination_number:'+14155550123'}]}];assert.match((await post('/webhooks/twilio/voice',body)).text,/timeout="20"/);process.env.DIAL_TIMEOUT_SECONDS='abc';rows=[{rows:[{id:'1',destination_number:'+14155550123'}]}];assert.match((await post('/webhooks/twilio/voice',body)).text,/timeout="15"/);}finally{delete process.env.DIAL_TIMEOUT_SECONDS;}});

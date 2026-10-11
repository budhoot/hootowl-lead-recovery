jest.mock('../src/db',()=>({query:jest.fn()}));
const request=require('supertest');
const db=require('../src/db');
const app=require('../src/server');
beforeEach(()=>{process.env.ADMIN_API_KEY='operator-test-'.repeat(4);process.env.WIX_INTAKE_SECRET='intake-test-'.repeat(4);db.query.mockReset();});
test('operator assets are served without leaking configuration',async()=>{
 const r=await request(app).get('/operator/');expect(r.status).toBe(200);expect(r.text).toContain('Your operator workspace');expect(r.text).not.toContain(process.env.ADMIN_API_KEY);
 expect(r.headers['content-security-policy']).toContain("script-src 'self'");
});
test('operator login rejects invalid types and incorrect keys',async()=>{
 expect((await request(app).post('/operator/session').send({key:123})).status).toBe(401);
 expect((await request(app).post('/operator/session').send({key:'wrong'})).status).toBe(401);expect(db.query).not.toHaveBeenCalled();
});
test('login issues an HttpOnly SameSite session; only a hash is persisted',async()=>{
 db.query.mockResolvedValue({rows:[],rowCount:1});
 const r=await request(app).post('/operator/session').send({key:process.env.ADMIN_API_KEY});
 expect(r.status).toBe(200);expect(r.headers['set-cookie'][0]).toContain('HttpOnly');expect(r.headers['set-cookie'][0]).toContain('SameSite=Strict');
 const token=r.headers['set-cookie'][0].split(';')[0].split('=')[1];expect(db.query.mock.calls[1][1][0]).not.toEqual(token);
});
test('cookie writes require same origin and operator request header',async()=>{
 expect((await request(app).patch('/admin/clients/1').set('Cookie','hootowl_session='+'a'.repeat(64)).send({})).status).toBe(403);
 expect((await request(app).patch('/admin/clients/1').set('Cookie','hootowl_session='+'a'.repeat(64)).set('X-HootOwl-Request','operator').set('Origin','https://hostile.example').send({})).status).toBe(403);
 expect(db.query).not.toHaveBeenCalled();
});
test('Wix intake rejects unauthenticated callers and validates contact fields',async()=>{
 expect((await request(app).post('/integrations/wix/leads').send({})).status).toBe(401);
 expect((await request(app).post('/integrations/wix/leads').set('Authorization','Bearer '+process.env.WIX_INTAKE_SECRET).send({submission_id:'1',name:'Test'})).status).toBe(400);
 expect(db.query).not.toHaveBeenCalled();
});
test('Wix duplicate delivery is acknowledged without an extra lead',async()=>{
 db.query.mockResolvedValue({rowCount:0,rows:[]});
 const r=await request(app).post('/integrations/wix/leads').set('Authorization','Bearer '+process.env.WIX_INTAKE_SECRET).send({submission_id:'1',name:'Test',email:'test@example.com'});
 expect(r.status).toBe(200);expect(r.body).toEqual({accepted:true,duplicate:true});
});
test('global pause leaves the queue untouched',async()=>{
 process.env.SMS_SEND_ENABLED='false';const provider={messages:{create:jest.fn()}};
 expect(await require('../src/worker').processOne(provider)).toBe(false);expect(db.query).not.toHaveBeenCalled();expect(provider.messages.create).not.toHaveBeenCalled();
});

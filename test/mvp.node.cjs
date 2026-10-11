const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const dbPath = require.resolve('../src/db');
let queries = [];
let rows = [];
const db = {
  query: async (sql, params) => {
    queries.push({ sql, params });
    return rows.shift() || { rows: [], rowCount: 0 };
  },
  connect: async () => ({ ...db, release() {} }),
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };

const request = require('supertest');
const twilio = require('twilio');
const app = require('../src/server');
const { processOne } = require('../src/worker');

function post(path, body) {
  const signature = twilio.getExpectedTwilioSignature(
    'test-token',
    `https://api.example.test${path}`,
    body,
  );
  return request(app).post(path).type('form').set('X-Twilio-Signature', signature).send(body);
}

beforeEach(() => {
  queries = [];
  rows = [];
  process.env.SMS_SEND_ENABLED = 'true';
  process.env.TWILIO_AUTH_TOKEN = 'test-token';
  process.env.TWILIO_PUBLIC_BASE_URL = 'https://api.example.test';
  process.env.ADMIN_API_KEY = 'x'.repeat(32);
});

test('invalid signature cannot enqueue messages', async () => {
  const response = await request(app)
    .post('/webhooks/twilio/dial-result')
    .type('form')
    .send({ CallSid: 'CA1' });
  assert.equal(response.status, 403);
  assert.equal(queries.length, 0);
});

test('missed-call callbacks are stored without an outbound message worker', async () => {
  rows = [{ rows: [{ id: '1' }] }, { rows: [], rowCount: 1 }];
  const response = await post('/webhooks/twilio/dial-result', {
    CallSid: 'CA1',
    DialCallStatus: 'no-answer',
    From: '+14155550100',
    To: '+18005550100',
  });
  assert.equal(response.status, 200);
  assert.match(queries[1].sql, /WITH recorded/);
  assert.match(queries[1].sql, /INSERT INTO recovery_messages/);
});

test('admin requires token and validates numbers', async () => {
  assert.equal((await request(app).get('/admin/clients')).status, 401);
  const response = await request(app)
    .post('/admin/clients')
    .set('Authorization', `Bearer ${'x'.repeat(32)}`)
    .send({ name: 'shop', twilio_number: 'bad' });
  assert.equal(response.status, 400);
});

test('admin can register an intake-only route without a forwarding destination', async () => {
  rows = [
    {},
    { rows: [{ id: '5', name: 'Nocona Hills Repair & Replace' }] },
    { rows: [{ id: '8', destination_number: null, intake_enabled: true }] },
    {},
  ];
  const response = await request(app)
    .post('/admin/clients')
    .set('Authorization', `Bearer ${process.env.ADMIN_API_KEY}`)
    .send({
      name: 'Nocona Hills Repair & Replace',
      twilio_number: '+19403405234',
      intake_enabled: true,
      recovery_enabled: false,
    });
  assert.equal(response.status, 201);
  assert.equal(response.body.route.destination_number, null);
  assert.equal(response.body.route.intake_enabled, true);
  assert.equal(queries[2].params[2], null);
});

test('admin route edits always keep SMS recovery disabled', async () => {
  rows = [{ rows: [{ id: '8', intake_enabled: true, recovery_enabled: false }], rowCount: 1 }];
  const response = await request(app)
    .patch('/admin/routes/8')
    .set('Authorization', `Bearer ${'x'.repeat(32)}`)
    .send({
      destination_number: '',
      is_active: true,
      intake_enabled: true,
    });
  assert.equal(response.status, 200);
  assert.match(queries[0].sql, /recovery_enabled=FALSE/);
  assert.deepEqual(queries[0].params, ['8', null, true, true]);
});

test('admin route cannot remove forwarding unless AI answering is enabled', async () => {
  const response = await request(app)
    .patch('/admin/routes/8')
    .set('Authorization', `Bearer ${'x'.repeat(32)}`)
    .send({ destination_number: '', is_active: true, intake_enabled: false });
  assert.equal(response.status, 400);
  assert.equal(queries.length, 0);
});

test('the inbound SMS webhook is not registered', async () => {
  const response = await request(app).post('/webhooks/twilio/sms').type('form').send({ Body: 'book me' });
  assert.equal(response.status, 404);
  assert.equal(queries.length, 0);
});

test('legacy recovery sender is inert even when the old SMS toggle is enabled', async () => {
  const result = await processOne({
    messages: { create: async () => { throw new Error('SMS must never be sent'); } },
  });
  assert.equal(result, false);
  assert.equal(queries.length, 0);
});

test('health responds', async () => {
  const response = await request(app).get('/health');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok' });
});

test('incoming legacy call forwarding remains available for non-trial routes', async () => {
  rows = [{ rows: [{ id: '1', destination_number: '+14155550123', intake_enabled: false }] }];
  const response = await post('/webhooks/twilio/voice', {
    From: '+14155550100',
    To: '+18005550100',
  });
  assert.equal(response.status, 200);
  assert.match(response.text, /<Dial/);
  assert.match(response.text, /\+14155550123/);
  assert.match(response.text, /dial-result/);
  assert.match(response.text, /timeout="15"/);
});

test('dial timeout is configurable and falls back when invalid', async () => {
  const body = { From: '+14155550100', To: '+18005550100' };
  try {
    process.env.DIAL_TIMEOUT_SECONDS = '20';
    rows = [{ rows: [{ id: '1', destination_number: '+14155550123' }] }];
    assert.match((await post('/webhooks/twilio/voice', body)).text, /timeout="20"/);
    process.env.DIAL_TIMEOUT_SECONDS = 'abc';
    rows = [{ rows: [{ id: '1', destination_number: '+14155550123' }] }];
    assert.match((await post('/webhooks/twilio/voice', body)).text, /timeout="15"/);
  } finally {
    delete process.env.DIAL_TIMEOUT_SECONDS;
  }
});

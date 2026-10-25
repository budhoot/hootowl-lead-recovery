jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../src/billing', () => ({
  applyWixEvent: jest.fn(), isKnownPlan: jest.fn(() => true), reconcileUnmatched: jest.fn(), isSubscriptionActive: jest.fn(),
  EVENT_TYPES: ['plan_purchased'],
}));
jest.mock('../src/onboarding', () => ({ ensureCustomer: jest.fn(), issueInvite: jest.fn() }));
const request = require('supertest');
const db = require('../src/db');
const billing = require('../src/billing');
const onboarding = require('../src/onboarding');
const app = require('../src/server');

const SECRET = 'intake-test-'.repeat(4);
const KEY = 'mail-key-should-never-be-logged';
const TOKEN = 'abc123tokenvalue';
const body = { event: 'plan_purchased', plan_id: '35700e0f-3c66-4ded-9505-032132e2cf67', order_id: 'order-1',
  email: 'Buyer@Example.com', first_name: 'Sam', last_name: 'Plumber' };
const settle = () => new Promise(resolve => setImmediate(resolve));
let logs;

beforeEach(() => {
  process.env.WIX_INTAKE_SECRET = SECRET;
  process.env.TWILIO_PUBLIC_BASE_URL = 'https://app.example.test';
  delete process.env.MAIL_API_KEY; delete process.env.MAIL_FROM; delete process.env.OWNER_ALERT_EMAIL;
  db.query.mockReset(); db.query.mockResolvedValue({ rows: [], rowCount: 1 });
  billing.applyWixEvent.mockReset(); billing.applyWixEvent.mockResolvedValue({ duplicate: false, outcome: 'applied' });
  onboarding.ensureCustomer.mockReset();
  onboarding.ensureCustomer.mockResolvedValue({ client_id: 7, existing_account: false, invitation_path: `/portal/#invite=${TOKEN}` });
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'msg_1' }) });
  logs = [];
  jest.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
  jest.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));
});
afterEach(() => { jest.restoreAllMocks(); });

const post = () => request(app).post('/integrations/wix/automation').set('Authorization', `Bearer ${SECRET}`).send(body);

test('sends the invitation to the buyer and records it when mail is configured', async () => {
  process.env.MAIL_API_KEY = KEY; process.env.MAIL_FROM = 'HootOwl <hello@example.test>';
  const r = await post(); await settle();
  expect(r.status).toBe(202);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toBe('https://api.resend.com/emails');
  expect(options.headers.Authorization).toBe(`Bearer ${KEY}`);
  const sent = JSON.parse(options.body);
  expect(sent.to).toEqual(['buyer@example.com']);
  expect(sent.text).toContain(`https://app.example.test/portal/#invite=${TOKEN}`);
  expect(sent.text).toContain('for calls only');
  expect(sent.text).not.toMatch(/\u2014|\u2013/);
  const insert = db.query.mock.calls.find(c => /INSERT INTO invitation_emails/.test(c[0]));
  expect(insert[1]).toEqual([7, 'buyer@example.com', 'order-1', 'sent', 'msg_1']);
});

test('does nothing but one log line when MAIL_API_KEY is not set', async () => {
  const r = await post(); await settle();
  expect(r.status).toBe(202);
  expect(global.fetch).not.toHaveBeenCalled();
  expect(db.query.mock.calls.find(c => /invitation_emails/.test(c[0]))).toBeUndefined();
  expect(logs).toEqual(['Invitation email skipped: MAIL_API_KEY is not set.']);
});

test('a mail failure does not change the purchase response and is recorded without secrets', async () => {
  process.env.MAIL_API_KEY = KEY; process.env.MAIL_FROM = 'hello@example.test';
  global.fetch.mockResolvedValue({ ok: false, status: 422, json: async () => ({ message: `bad ${KEY}` }) });
  const r = await post(); await settle();
  expect(r.status).toBe(202);
  expect(r.body.invited).toBe(true);
  const insert = db.query.mock.calls.find(c => /INSERT INTO invitation_emails/.test(c[0]));
  expect(insert[1]).toEqual([7, 'buyer@example.com', 'order-1', 'failed', 'http_422']);
});

test('a network error and a database error while recording are both swallowed', async () => {
  process.env.MAIL_API_KEY = KEY; process.env.MAIL_FROM = 'hello@example.test';
  global.fetch.mockRejectedValue(new Error(`connect failed ${KEY} ${TOKEN}`));
  db.query.mockRejectedValue(Object.assign(new Error('db down'), { code: 'ECONNREFUSED' }));
  const r = await post(); await settle();
  expect(r.status).toBe(202);
});

test('the link and the key never appear in logs', async () => {
  process.env.MAIL_API_KEY = KEY; process.env.MAIL_FROM = 'hello@example.test';
  global.fetch.mockRejectedValueOnce(new Error(`boom ${KEY} ${TOKEN}`));
  await post(); await settle();
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ id: 'msg_2' }) });
  await post(); await settle();
  const all = logs.join('\n');
  expect(all).not.toContain(KEY);
  expect(all).not.toContain(TOKEN);
  expect(all).not.toContain('/portal/#invite');
});

test('owner alert has the plan and buyer email but no link', async () => {
  process.env.MAIL_API_KEY = KEY; process.env.MAIL_FROM = 'hello@example.test'; process.env.OWNER_ALERT_EMAIL = 'owner@example.test';
  await post(); await settle();
  expect(global.fetch).toHaveBeenCalledTimes(2);
  const alert = JSON.parse(global.fetch.mock.calls[1][1].body);
  expect(alert.to).toEqual(['owner@example.test']);
  expect(alert.subject).toBe('New HootOwl purchase');
  expect(alert.text).toContain('buyer@example.com');
  expect(alert.text).toContain('Voicemail WATCH');
  expect(alert.text).not.toContain(TOKEN);
  expect(alert.text).not.toContain('/portal/');
});

test('an existing account gets no buyer email and no record', async () => {
  process.env.MAIL_API_KEY = KEY; process.env.MAIL_FROM = 'hello@example.test';
  onboarding.ensureCustomer.mockResolvedValue({ client_id: 7, existing_account: true });
  const r = await post(); await settle();
  expect(r.status).toBe(202); expect(r.body.invited).toBe(false);
  expect(global.fetch).not.toHaveBeenCalled();
});

test('non-purchase events never send mail', async () => {
  process.env.MAIL_API_KEY = KEY; process.env.MAIL_FROM = 'hello@example.test';
  await request(app).post('/integrations/wix/automation').set('Authorization', `Bearer ${SECRET}`).send({ ...body, event: 'plan_cancelled' });
  await settle();
  expect(global.fetch).not.toHaveBeenCalled();
});

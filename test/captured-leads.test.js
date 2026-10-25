jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
const request = require('supertest');
const db = require('../src/db');
const app = require('../src/server');

const TOKEN = 'a'.repeat(64);
const row = (name, extra = {}) => ({ customer_name: name, caller_number: '+15005550101', service_type: 'Plumbing',
  service_address: '1 Main St', issue_description: 'Leaking sink', risk_flag: false, address_verified: true,
  callback_requested: false, booked_start: null, created_at: '2026-10-25T10:00:00Z', ...extra });
const DATA = { 1: [row('Caller of A', { created_at: '2026-10-25T11:00:00Z' })], 2: [row('Caller of B')] };
let sessionClient;

beforeEach(() => {
  sessionClient = 1;
  db.query.mockReset();
  db.query.mockImplementation(async (sql, params) => {
    if (/FROM customer_sessions/.test(sql)) {
      return { rowCount: 1, rows: [{ id: 5, client_id: sessionClient, email: 'a@example.test', display_name: 'A', theme: 'system', accent: 'forest', density: 'comfortable', time_format: '12' }] };
    }
    if (/FROM voice_agent_sessions/.test(sql)) return { rowCount: 1, rows: DATA[params[0]] || [] };
    return { rowCount: 0, rows: [] };
  });
});

const get = (url = '/portal/api/captured') => request(app).get(url).set('Cookie', `hootowl_customer=${TOKEN}`);
const capturedCall = () => db.query.mock.calls.filter(([sql]) => /FROM voice_agent_sessions/.test(sql)).pop();

describe('captured requests in the client workspace', () => {
  test('needs a signed-in session', async () => {
    const response = await request(app).get('/portal/api/captured');
    expect(response.status).toBe(401);
    expect(capturedCall()).toBeUndefined();
  });

  test('returns only the signed-in customer\'s requests', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.body.requests.map(r => r.customer_name)).toEqual(['Caller of A']);
    expect(capturedCall()[1]).toEqual([1]);
    sessionClient = 2;
    expect((await get()).body.requests.map(r => r.customer_name)).toEqual(['Caller of B']);
    expect(capturedCall()[1]).toEqual([2]);
  });

  test('ignores a client id sent in the query string', async () => {
    const response = await get('/portal/api/captured?client_id=2&clientId=2');
    expect(response.body.requests.map(r => r.customer_name)).toEqual(['Caller of A']);
    expect(capturedCall()[1]).toEqual([1]);
  });

  test('a customer with no requests gets an empty list', async () => {
    sessionClient = 99;
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ requests: [] });
  });

  test('the query leaves out previews and never selects recordings or call ids', async () => {
    await get();
    const sql = capturedCall()[0];
    expect(sql).toMatch(/NOT s\.is_preview/);
    expect(sql).toMatch(/p\.client_id=\$1/);
    expect(sql).not.toMatch(/recording|call_sid|offered_slots|google_event_id/);
  });

  test('responses are not cached', async () => {
    expect((await get()).headers['cache-control']).toBe('no-store');
  });
});

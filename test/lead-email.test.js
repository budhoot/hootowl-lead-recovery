jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../src/geocoding', () => ({ geocodeServiceAddress: jest.fn() }));
jest.mock('../src/google-calendar', () => ({ createBooking: jest.fn(), isSlotAvailable: jest.fn(), suggestSlots: jest.fn() }));
const db = require('../src/db');
const { geocodeServiceAddress } = require('../src/geocoding');
const { notifyCapturedRequest, leadMessage } = require('../src/lead-email');
const { saveServiceRequest } = require('../src/voice-agent');

const KEY = 'mail-key-should-never-be-logged';
const lead = { client_id: 7, business_name: 'Sam Plumbing', timezone: 'America/Chicago', customer_name: 'Pat Caller',
  caller_number: '+15005550101', service_type: 'Water heater', service_address: '12 Oak St, Nocona, TX',
  issue_description: 'No hot water since last night', risk_flag: false, address_verified: true, call_started_at: '2026-10-25T15:00:00Z' };
let logs;

beforeEach(() => {
  delete process.env.MAIL_API_KEY; delete process.env.MAIL_FROM;
  process.env.TWILIO_PUBLIC_BASE_URL = 'https://app.example.test';
  db.query.mockReset();
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'msg_1' }) });
  logs = [];
  jest.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
  jest.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));
});
afterEach(() => jest.restoreAllMocks());

const configure = () => { process.env.MAIL_API_KEY = KEY; process.env.MAIL_FROM = 'HootOwl <hello@example.test>'; };
const claim = (rows = [lead], users = [{ email: 'owner@example.test' }]) => db.query.mockImplementation(async (sql) => {
  if (/UPDATE voice_agent_sessions s SET owner_notified_at=NOW/.test(sql)) return { rows, rowCount: rows.length };
  if (/FROM customer_users/.test(sql)) return { rows: users, rowCount: users.length };
  return { rows: [], rowCount: 1 };
});

describe('new captured request email', () => {
  test('does nothing at all while mail is not configured', async () => {
    expect(await notifyCapturedRequest('CA1')).toEqual({ status: 'skipped' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('does nothing when only the key is set', async () => {
    process.env.MAIL_API_KEY = KEY;
    expect(await notifyCapturedRequest('CA1')).toEqual({ status: 'skipped' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('emails the details to the business workspace users when configured', async () => {
    configure(); claim();
    expect(await notifyCapturedRequest('CA1')).toEqual({ status: 'sent' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    const sent = JSON.parse(options.body);
    expect(sent.to).toEqual(['owner@example.test']);
    for (const text of ['Pat Caller', '+15005550101', 'Water heater', '12 Oak St, Nocona, TX', 'No hot water since last night', 'https://app.example.test/portal/']) {
      expect(sent.text).toContain(text);
    }
    expect(sent.text).not.toMatch(/recording|\.mp3|\.wav|api\.twilio\.com|\u2014|\u2013/i);
    expect(sent.text).not.toMatch(/text message|sms/i);
    expect(JSON.stringify(logs)).not.toContain(KEY);
  });

  test('flags a possible safety issue and an unchecked address', () => {
    const message = leadMessage({ ...lead, risk_flag: true, address_verified: false });
    expect(message.text).toContain('Safety:');
    expect(message.text).toContain('could not be checked automatically');
  });

  test('a mail provider failure releases the claim and never throws', async () => {
    configure(); claim();
    global.fetch.mockResolvedValue({ ok: false, status: 422 });
    expect(await notifyCapturedRequest('CA1')).toEqual({ status: 'failed' });
    expect(db.query.mock.calls.some(([sql]) => /SET owner_notified_at=NULL/.test(sql))).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(KEY);
  });

  test('a database error never throws', async () => {
    configure();
    db.query.mockRejectedValue(Object.assign(new Error('boom'), { code: 'XX000' }));
    expect(await notifyCapturedRequest('CA1')).toEqual({ status: 'failed' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('an already notified call or a preview sends nothing', async () => {
    configure(); claim([]);
    expect(await notifyCapturedRequest('CA1')).toEqual({ status: 'not_needed' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a business with no workspace user sends nothing and releases the claim', async () => {
    configure(); claim([lead], []);
    expect(await notifyCapturedRequest('CA1')).toEqual({ status: 'failed' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('saving a caller request', () => {
  const args = { customer_name: 'Pat Caller', service_type: 'Water heater', service_address: '12 Oak St', issue_description: 'No hot water' };
  const settle = () => new Promise(resolve => setImmediate(resolve));

  test('with mail unset it behaves as before and makes no extra calls', async () => {
    geocodeServiceAddress.mockResolvedValue({ status: 'inside_area' });
    db.query.mockResolvedValue({ rowCount: 1 });
    await expect(saveServiceRequest('CA1', args)).resolves.toEqual({ ok: true, in_service_area: true, urgent_safety_reminder: false });
    await settle();
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('with mail configured the call still succeeds even when sending fails', async () => {
    configure();
    geocodeServiceAddress.mockResolvedValue({ status: 'inside_area' });
    db.query.mockImplementation(async (sql) => {
      if (/UPDATE voice_agent_sessions s SET owner_notified_at=NOW/.test(sql)) return { rows: [lead], rowCount: 1 };
      if (/FROM customer_users/.test(sql)) return { rows: [{ email: 'owner@example.test' }], rowCount: 1 };
      return { rowCount: 1, rows: [] };
    });
    global.fetch.mockRejectedValue(new Error('network down'));
    await expect(saveServiceRequest('CA1', args)).resolves.toEqual({ ok: true, in_service_area: true, urgent_safety_reminder: false });
    await settle(); await settle();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

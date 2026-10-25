jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
const request = require('supertest');
const db = require('../src/db');
const { warnOnBuyerEmailMismatch } = require('../src/onboarding');
const app = require('../src/server');

let warn, error;
beforeEach(() => { db.query.mockReset(); db.connect.mockReset(); warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); error = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

describe('warnOnBuyerEmailMismatch', () => {
  test('warns, with masked emails, when the registered email differs from the subscription buyer email', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ buyer_email: 'buyer@shop.example' }] });
    expect(await warnOnBuyerEmailMismatch(5, 'owner@other.example')).toBe(true);
    const line = warn.mock.calls[0][0];
    expect(line).toContain('BUYER EMAIL MISMATCH');
    expect(line).toContain('ow***@other.example');
    expect(line).toContain('bu***@shop.example');
    expect(line).not.toContain('owner@other.example');
  });
  test('stays quiet when emails agree (any case), when there is no subscription, and when there is no buyer email', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ buyer_email: 'Owner@Shop.example' }] });
    expect(await warnOnBuyerEmailMismatch(5, 'owner@shop.example')).toBe(false);
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await warnOnBuyerEmailMismatch(5, 'a@b.example')).toBe(false);
    db.query.mockResolvedValueOnce({ rows: [{ buyer_email: null }] });
    expect(await warnOnBuyerEmailMismatch(5, 'a@b.example')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
  test('never throws: a database failure is logged and swallowed', async () => {
    db.query.mockRejectedValueOnce(new Error('down'));
    await expect(warnOnBuyerEmailMismatch(5, 'a@b.example')).resolves.toBe(false);
    expect(error).toHaveBeenCalled();
  });
});

describe('POST /portal/api/register', () => {
  test('still registers (201) when the emails differ, and logs the warning', async () => {
    const connection = { release: jest.fn(), query: jest.fn(async (sql) => {
      if (/FROM customer_invites/.test(sql)) return { rows: [{ client_id: 5, email: 'owner@other.example' }] };
      if (/INSERT INTO customer_users/.test(sql)) return { rows: [{ id: 9 }] };
      return { rows: [], rowCount: 1 };
    }) };
    db.connect.mockResolvedValue(connection);
    db.query.mockResolvedValue({ rows: [{ buyer_email: 'buyer@shop.example' }] });
    const res = await request(app).post('/portal/api/register').set('X-HootOwl-Request', 'customer')
      .send({ token: 'a'.repeat(64), display_name: 'Owner', password: 'a-long-enough-password' });
    expect(res.status).toBe(201);
    expect(warn.mock.calls.some(c => String(c[0]).includes('BUYER EMAIL MISMATCH'))).toBe(true);
    expect(connection.query.mock.calls.some(c => c[0] === 'COMMIT')).toBe(true);
  });
});

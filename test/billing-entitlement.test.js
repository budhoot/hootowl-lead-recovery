jest.mock('../src/db', () => ({ query: jest.fn() }));
const db = require('../src/db');
const billing = require('../src/billing');
const usage = require('../src/usage');

const DAY = 86400000;
const PRO = 'db1024e0-f106-4c82-84c8-9fa6f96d06fa';
const now = new Date('2026-11-20T12:00:00.000Z');
const daysAgo = n => new Date(now.getTime() - n * DAY).toISOString();
let saved;
beforeEach(() => { saved = process.env.BILLING_PERIOD_GRACE_DAYS; delete process.env.BILLING_PERIOD_GRACE_DAYS; db.query.mockReset(); });
afterEach(() => { if (saved === undefined) delete process.env.BILLING_PERIOD_GRACE_DAYS; else process.env.BILLING_PERIOD_GRACE_DAYS = saved; jest.useRealTimers(); });

describe('isEntitled', () => {
  test('only an active status can be entitled', () => {
    for (const s of ['past_due', 'cancelled', 'refunded', undefined]) expect(billing.isEntitled(s, daysAgo(-30), now)).toBe(false);
  });
  test('active with no end date is valid until cancelled', () => {
    expect(billing.isEntitled('active', null, now)).toBe(true);
    expect(billing.isEntitled('active', undefined, now)).toBe(true);
  });
  test('active with a future end date is entitled', () => {
    expect(billing.isEntitled('active', daysAgo(-3), now)).toBe(true);
  });
  test('an end date that passed inside the default 7 day grace is still entitled', () => {
    expect(billing.isEntitled('active', daysAgo(6), now)).toBe(true);
    expect(billing.isEntitled('active', daysAgo(7), now)).toBe(true);
  });
  test('an end date that passed more than 7 days ago is not entitled', () => {
    expect(billing.isEntitled('active', daysAgo(8), now)).toBe(false);
  });
  test('BILLING_PERIOD_GRACE_DAYS changes the grace and "off" ignores the end date', () => {
    process.env.BILLING_PERIOD_GRACE_DAYS = '2';
    expect(billing.isEntitled('active', daysAgo(1), now)).toBe(true);
    expect(billing.isEntitled('active', daysAgo(3), now)).toBe(false);
    process.env.BILLING_PERIOD_GRACE_DAYS = 'off';
    expect(billing.isEntitled('active', daysAgo(400), now)).toBe(true);
    process.env.BILLING_PERIOD_GRACE_DAYS = 'garbage';
    expect(billing.isEntitled('active', daysAgo(8), now)).toBe(false);
  });
  test('an unreadable end date does not cut anyone off', () => {
    expect(billing.isEntitled('active', 'not-a-date', now)).toBe(true);
  });
});

describe('isSubscriptionActive (gates provisioning)', () => {
  test('false for a lapsed active row, true inside the grace, false with no row', async () => {
    jest.useFakeTimers().setSystemTime(now);
    db.query.mockResolvedValueOnce({ rows: [{ status: 'active', current_period_end: daysAgo(30) }] });
    expect(await billing.isSubscriptionActive(1)).toBe(false);
    db.query.mockResolvedValueOnce({ rows: [{ status: 'active', current_period_end: daysAgo(2) }] });
    expect(await billing.isSubscriptionActive(1)).toBe(true);
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await billing.isSubscriptionActive(1)).toBe(false);
  });
});

describe('aiStatus (gates AI minutes and call routing)', () => {
  const row = over => ({ rows: [{ ai_unlimited: false, ai_minutes_override: null, wix_plan_id: PRO, status: 'active', current_period_end: null, used: 0, ...over }] });
  test('an active, current subscription gets its plan allowance', async () => {
    jest.useFakeTimers().setSystemTime(now);
    db.query.mockResolvedValueOnce(row({ current_period_end: daysAgo(-10) }));
    expect(await usage.aiStatus(1)).toMatchObject({ allowance: 75, source: 'plan' });
  });
  test('an active row more than the grace past its end date gets no plan allowance, so calls forward', async () => {
    jest.useFakeTimers().setSystemTime(now);
    db.query.mockResolvedValueOnce(row({ current_period_end: daysAgo(20) }));
    const status = await usage.aiStatus(1);
    expect(status).toMatchObject({ allowance: 0, plan: null, source: 'none' });
    expect(usage.canUseAi(status)).toBe(false);
  });
  test('an operator override or unlimited still wins over a lapsed subscription', async () => {
    jest.useFakeTimers().setSystemTime(now);
    db.query.mockResolvedValueOnce(row({ current_period_end: daysAgo(20), ai_minutes_override: 30 }));
    expect(await usage.aiStatus(1)).toMatchObject({ allowance: 30, source: 'override' });
    db.query.mockResolvedValueOnce(row({ current_period_end: daysAgo(20), ai_unlimited: true }));
    expect(await usage.aiStatus(1)).toMatchObject({ unlimited: true, source: 'unlimited' });
  });
});

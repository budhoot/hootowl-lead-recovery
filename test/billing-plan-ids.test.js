jest.mock('../src/db', () => ({ query: jest.fn() }));
const db = require('../src/db');
const billing = require('../src/billing');

const event = (over = {}) => ({ event_id: 'evt-1', event_type: 'plan_purchased', plan_id: 'plan-live', buyer_email: 'owner@example.invalid', ...over });
let saved;
beforeEach(() => { saved = process.env.WIX_PLAN_IDS; db.query.mockReset(); });
afterEach(() => { if (saved === undefined) delete process.env.WIX_PLAN_IDS; else process.env.WIX_PLAN_IDS = saved; jest.restoreAllMocks(); });

test('an unset or empty WIX_PLAN_IDS rejects every plan', () => {
  delete process.env.WIX_PLAN_IDS;
  expect(billing.isKnownPlan('plan-live')).toBe(false);
  process.env.WIX_PLAN_IDS = '';
  expect(billing.isKnownPlan('plan-live')).toBe(false);
  process.env.WIX_PLAN_IDS = ' , ,';
  expect(billing.isKnownPlan('plan-live')).toBe(false);
});

test('a listed plan is known and an unlisted plan is not', () => {
  process.env.WIX_PLAN_IDS = 'plan-a, plan-live ,plan-b';
  expect(billing.isKnownPlan('plan-live')).toBe(true);
  expect(billing.isKnownPlan('plan-other')).toBe(false);
});

test('with an empty list a plan event is stored as ignored and never matched to a client', async () => {
  delete process.env.WIX_PLAN_IDS;
  db.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1 }] });
  const result = await billing.applyWixEvent(event());
  expect(result).toEqual({ duplicate: false, outcome: 'ignored' });
  expect(db.query).toHaveBeenCalledTimes(1);
  expect(db.query.mock.calls[0][1][2]).toBe('ignored');
});

test('startup logs a loud error when WIX_PLAN_IDS is unset and stays quiet when it is set', () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  delete process.env.WIX_PLAN_IDS;
  expect(billing.assertPlanConfig()).toBe(false);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0][0]).toContain('WIX_PLAN_IDS');
  process.env.WIX_PLAN_IDS = 'plan-live';
  expect(billing.assertPlanConfig()).toBe(true);
  expect(spy).toHaveBeenCalledTimes(1);
});

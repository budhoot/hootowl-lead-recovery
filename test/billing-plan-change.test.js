jest.mock('../src/db', () => ({ query: jest.fn() }));
const db = require('../src/db');

let billing;
beforeAll(() => { process.env.WIX_PLAN_IDS = 'plan-watch,plan-pro'; billing = require('../src/billing'); });
beforeEach(() => db.query.mockReset());

// Routes each query by its SQL, and records the ones that write.
function fakeDb({ currentSubscriptionId }) {
  const writes = [];
  db.query.mockImplementation(async (sql, params) => {
    if (/INSERT INTO billing_events/.test(sql)) return { rowCount: 1, rows: [{ id: 1 }] };
    if (/FROM customer_users/.test(sql)) return { rows: [{ client_id: 7 }] };
    if (/SELECT wix_subscription_id FROM billing_subscriptions/.test(sql)) {
      return { rows: currentSubscriptionId === undefined ? [] : [{ wix_subscription_id: currentSubscriptionId }] };
    }
    if (/SELECT status FROM billing_subscriptions/.test(sql)) return { rows: [{ status: 'active' }] };
    writes.push({ sql, params });
    return { rowCount: 1, rows: [] };
  });
  return writes;
}
const ev = (over = {}) => ({ event_id: 'e', event_type: 'plan_cancelled', plan_id: 'plan-watch', subscription_id: 'order-old', buyer_email: 'a@example.invalid', ...over });
const upsertRan = writes => writes.some(w => /INSERT INTO billing_subscriptions/.test(w.sql));

test('a cancel for an old order is ignored when a different order is on the row', async () => {
  const writes = fakeDb({ currentSubscriptionId: 'order-new' });
  const result = await billing.applyWixEvent(ev());
  expect(result).toEqual({ duplicate: false, outcome: 'ignored', reason: 'superseded_order' });
  expect(upsertRan(writes)).toBe(false);
  expect(writes.some(w => /UPDATE billing_events SET outcome='ignored'/.test(w.sql))).toBe(true);
});

test('an expiry for an old order is ignored the same way', async () => {
  const writes = fakeDb({ currentSubscriptionId: 'order-new' });
  expect((await billing.applyWixEvent(ev({ event_type: 'plan_expired' }))).outcome).toBe('ignored');
  expect(upsertRan(writes)).toBe(false);
});

test('a cancel for the current order still cancels', async () => {
  const writes = fakeDb({ currentSubscriptionId: 'order-old' });
  expect(await billing.applyWixEvent(ev())).toEqual({ duplicate: false, outcome: 'applied', status: 'cancelled' });
  expect(upsertRan(writes)).toBe(true);
});

test('a cancel without an order id, or on a row without one, applies as before', async () => {
  let writes = fakeDb({ currentSubscriptionId: 'order-new' });
  expect((await billing.applyWixEvent(ev({ subscription_id: undefined }))).outcome).toBe('applied');
  expect(upsertRan(writes)).toBe(true);
  db.query.mockReset();
  writes = fakeDb({ currentSubscriptionId: null });
  expect((await billing.applyWixEvent(ev())).outcome).toBe('applied');
  expect(upsertRan(writes)).toBe(true);
});

test('a purchase for a new order is never blocked by the guard (that is how an upgrade lands)', async () => {
  const writes = fakeDb({ currentSubscriptionId: 'order-old' });
  const result = await billing.applyWixEvent(ev({ event_type: 'plan_purchased', plan_id: 'plan-pro', subscription_id: 'order-new' }));
  expect(result).toEqual({ duplicate: false, outcome: 'applied', status: 'active' });
  expect(upsertRan(writes)).toBe(true);
});

test('other event types are not order-scoped', async () => {
  const writes = fakeDb({ currentSubscriptionId: 'order-new' });
  expect((await billing.applyWixEvent(ev({ event_type: 'payment_failed' }))).outcome).toBe('applied');
  expect(upsertRan(writes)).toBe(true);
});

jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
const db = require('../src/db');
const reconcile = require('../src/reconcile');

const NOW = new Date('2026-11-10T12:00:00.000Z');
const ENV = { WIX_ORDERS_API_KEY: 'test-key-not-real', WIX_SITE_ID: 'site-1', WIX_PLAN_IDS: 'plan-a,plan-b' };
const order = (over = {}) => ({ id: 'o1', planId: 'plan-a', planName: 'Voicemail WATCH', status: 'ACTIVE', lastPaymentStatus: 'PAID', createdDate: '2026-10-01T00:00:00Z', ...over });
const sub = (over = {}) => ({ client_id: '1', wix_plan_id: 'plan-a', wix_subscription_id: 'o1', status: 'active', current_period_end: null, last_event_at: '2026-10-01T00:00:00Z', ...over });
const page = (orders, ok = true, status = 200) => ({ ok, status, json: async () => ({ orders }) });

// Routes each SQL statement to canned rows. Records every statement so tests can prove nothing was changed.
function fakeDb({ subs = [], events = [], stale = [] } = {}) {
  const inserted = [];
  db.query.mockImplementation(async (sql, params) => {
    if (/FROM billing_subscriptions/.test(sql)) return { rows: subs };
    if (/payload->>'subscription_id' = ANY/.test(sql)) return { rows: events };
    if (/outcome='unmatched' AND received_at/.test(sql)) return { rows: stale };
    if (/INSERT INTO billing_reconcile_runs/.test(sql)) { inserted.push(params); return { rows: [] }; }
    if (/DELETE FROM billing_reconcile_runs/.test(sql)) return { rows: [] };
    throw new Error('unexpected SQL in test: ' + sql);
  });
  return inserted;
}
const quiet = { log: jest.fn(), warn: jest.fn() };
const kinds = run => run.findings.map(f => f.kind).sort();

beforeEach(() => { db.query.mockReset(); db.connect.mockReset(); quiet.log.mockClear(); quiet.warn.mockClear(); });

describe('inert without settings', () => {
  test('startSchedule logs one line and starts nothing when the key is unset', () => {
    const log = jest.fn();
    expect(reconcile.startSchedule({ env: { WIX_SITE_ID: 'x', WIX_PLAN_IDS: 'p' }, log })).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('WIX_ORDERS_API_KEY');
  });
  test('startSchedule is inert when the site id or plan list is missing too', () => {
    expect(reconcile.startSchedule({ env: { WIX_ORDERS_API_KEY: 'k' }, log: jest.fn() })).toBeNull();
  });
  test('runReconciliation without the key never calls Wix or the database', async () => {
    const fetchImpl = jest.fn();
    const run = await reconcile.runReconciliation({ env: {}, fetchImpl, ...quiet });
    expect(run.status).toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });
  test('with all settings the schedule starts and can be stopped', () => {
    jest.useFakeTimers();
    const handle = reconcile.startSchedule({ env: ENV, log: jest.fn() });
    expect(handle).not.toBeNull();
    handle.stop();
    jest.useRealTimers();
  });
});

describe('Wix call', () => {
  test('GETs the orders list with the key and site id in headers, and pages by 50', async () => {
    const full = Array.from({ length: 50 }, (_, i) => order({ id: 'a' + i }));
    const fetchImpl = jest.fn().mockResolvedValueOnce(page(full)).mockResolvedValueOnce(page([order({ id: 'last' })]));
    const out = await reconcile.fetchWixOrders({ apiKey: 'k', siteId: 's', fetchImpl });
    expect(out.orders).toHaveLength(51);
    expect(out.truncated).toBe(false);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://www.wixapis.com/pricing-plans/v2/orders?limit=50&offset=0');
    expect(fetchImpl.mock.calls[1][0]).toContain('offset=50');
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toBe('k');
    expect(opts.headers['wix-site-id']).toBe('s');
  });
  test('an HTTP error is thrown without echoing the key', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ message: 'forbidden' }) });
    await expect(reconcile.fetchWixOrders({ apiKey: 'secret-key', siteId: 's', fetchImpl })).rejects.toThrow('HTTP 403: forbidden');
  });
});

describe('the four cases', () => {
  const base = { orders: [], subs: [], eventsByOrder: new Map(), staleEvents: [], plans: ['plan-a'], truncated: false, now: NOW };

  test('1. Wix active, backend has no record or a cancelled record', () => {
    const { findings } = reconcile.compare({ ...base, orders: [order({ id: 'o1' }), order({ id: 'o2' })], subs: [sub({ client_id: '2', wix_subscription_id: 'o2', status: 'cancelled' })] });
    expect(findings.map(f => f.kind)).toEqual(['wix_active_backend_not', 'wix_active_backend_not']);
    expect(findings[0].backend_status).toBe('no_subscription_record');
    expect(findings[1].backend_status).toBe('cancelled');
    expect(findings[0].summary).toContain('No billing event for this order was ever received');
  });
  test('1. includes what events arrived for the order, and ignores plans we do not sell', () => {
    const events = new Map([['o1', [{ event_type: 'plan_purchased', outcome: 'unmatched' }]]]);
    const { findings } = reconcile.compare({ ...base, orders: [order(), order({ id: 'x', planId: 'other-plan' })], eventsByOrder: events });
    expect(findings).toHaveLength(1);
    expect(findings[0].summary).toContain('plan_purchased (unmatched)');
  });
  test('1. an agreeing active order is not reported', () => {
    expect(reconcile.compare({ ...base, orders: [order()], subs: [sub()] }).findings).toEqual([]);
  });
  test('2. backend active, Wix cancelled or order not found', () => {
    const { findings } = reconcile.compare({ ...base,
      orders: [order({ id: 'o1', status: 'CANCELED', cancellation: { cause: 'PAYMENT_FAILURE' } })],
      subs: [sub(), sub({ client_id: '2', wix_subscription_id: 'gone' })] });
    expect(kinds({ findings })).toEqual(['backend_active_wix_not', 'backend_active_wix_not']);
    expect(findings[0].summary).toContain('CANCELED (PAYMENT_FAILURE)');
    expect(findings[1].wix_status).toBe('not_found');
  });
  test('2. an active row with no order id is counted, not guessed at', () => {
    const out = reconcile.compare({ ...base, subs: [sub({ wix_subscription_id: null })] });
    expect(out.findings).toEqual([]);
    expect(out.unverifiable).toBe(1);
  });
  test('2. a cut-off Wix list never proves an order is missing', () => {
    expect(reconcile.compare({ ...base, truncated: true, subs: [sub()] }).findings).toEqual([]);
  });
  test('3. stale unmatched events are listed with the email masked', () => {
    const { findings } = reconcile.compare({ ...base, staleEvents: [{ id: 7, event_type: 'plan_purchased', buyer_email: 'owner@example.com', plan_id: 'plan-a', order_id: 'o9', received_at: '2026-11-07T12:00:00Z' }] });
    expect(findings[0]).toMatchObject({ kind: 'unmatched_event_stale', hours_old: 72, buyer_email_masked: 'o***@example.com' });
    expect(JSON.stringify(findings)).not.toContain('owner@example.com');
  });
  test('4. active past period end with no later event', () => {
    const { findings } = reconcile.compare({ ...base, orders: [order()], subs: [sub({ current_period_end: '2026-11-01T00:00:00Z', last_event_at: '2026-10-01T00:00:00Z' })] });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'active_past_period_end', days_overdue: 9 });
  });
  test('4. not reported when the period is still running or a later event arrived', () => {
    const future = sub({ current_period_end: '2026-12-01T00:00:00Z' });
    const renewed = sub({ client_id: '2', wix_subscription_id: 'o2', current_period_end: '2026-11-01T00:00:00Z', last_event_at: '2026-11-02T00:00:00Z' });
    const { findings } = reconcile.compare({ ...base, orders: [order(), order({ id: 'o2' })], subs: [future, renewed] });
    expect(findings).toEqual([]);
  });
});

describe('a full run', () => {
  test('records one report row, logs findings, and only reads the subscription table', async () => {
    const inserted = fakeDb({ subs: [sub({ client_id: '1', wix_subscription_id: 'old', status: 'active' })] });
    const fetchImpl = jest.fn().mockResolvedValue(page([order({ id: 'new' })]));
    const run = await reconcile.runReconciliation({ env: ENV, fetchImpl, now: NOW, ...quiet });
    expect(run.status).toBe('ok');
    expect(kinds(run)).toEqual(['backend_active_wix_not', 'wix_active_backend_not']);
    expect(inserted).toHaveLength(1);
    const sqls = db.query.mock.calls.map(c => c[0]);
    expect(sqls.some(s => /UPDATE|INSERT INTO billing_subscriptions|DELETE FROM billing_(subscriptions|events)/.test(s))).toBe(false);
    expect(quiet.warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify([quiet.log.mock.calls, quiet.warn.mock.calls, inserted])).not.toContain(ENV.WIX_ORDERS_API_KEY);
  });
  test('a Wix failure is recorded as an error run and changes nothing else', async () => {
    const inserted = fakeDb();
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    const run = await reconcile.runReconciliation({ env: ENV, fetchImpl, now: NOW, ...quiet });
    expect(run.status).toBe('error');
    expect(inserted[0][0]).toBe('error');
    expect(db.query.mock.calls.map(c => c[0]).some(s => /billing_subscriptions/.test(s))).toBe(false);
  });
});

describe('daily timing and locking', () => {
  test('isDue: never run, 24h after ok, 1h after ok, 7h after error', () => {
    const at = h => ({ ran_at: new Date(NOW - h * 3600000).toISOString() });
    expect(reconcile.isDue(null, NOW)).toBe(true);
    expect(reconcile.isDue({ ...at(24), status: 'ok' }, NOW)).toBe(true);
    expect(reconcile.isDue({ ...at(1), status: 'ok' }, NOW)).toBe(false);
    expect(reconcile.isDue({ ...at(2), status: 'error' }, NOW)).toBe(false);
    expect(reconcile.isDue({ ...at(7), status: 'error' }, NOW)).toBe(true);
  });
  test('runIfDue skips when another instance holds the lock', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ ok: false }] }), release: jest.fn() };
    db.connect.mockResolvedValue(client);
    const fetchImpl = jest.fn();
    expect(await reconcile.runIfDue({ env: ENV, fetchImpl, now: NOW, ...quiet })).toEqual({ status: 'skipped', reason: 'locked' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalled();
  });
  test('runIfDue skips when the last good run is recent, and releases the lock', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ ok: true }] }), release: jest.fn() };
    db.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [{ ran_at: new Date(NOW - 3600000).toISOString(), status: 'ok' }] });
    const fetchImpl = jest.fn();
    expect(await reconcile.runIfDue({ env: ENV, fetchImpl, now: NOW, ...quiet })).toEqual({ status: 'skipped', reason: 'not_due' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.query.mock.calls.map(c => c[0]).some(s => /pg_advisory_unlock/.test(s))).toBe(true);
  });
});

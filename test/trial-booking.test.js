const { isInNoconaHills } = require('../src/service-area');
const { findAvailableSlots } = require('../src/booking');
const { createBooking, getBusyPeriods, isSlotAvailable } = require('../src/google-calendar');

describe('Nocona Hills service area', () => {
  it('accepts points inside the published service-area polygon', () => {
    expect(isInNoconaHills(-97.64, 33.845)).toBe(true);
  });

  it('includes a point on the polygon boundary', () => {
    expect(isInNoconaHills(-97.6484608, 33.8607923)).toBe(true);
  });

  it('rejects points outside the polygon and invalid coordinates', () => {
    expect(isInNoconaHills(-97.70, 33.845)).toBe(false);
    expect(isInNoconaHills(Number.NaN, 33.845)).toBe(false);
  });
});

describe('Calendar slot selection', () => {
  const now = new Date('2026-10-09T13:00:00.000Z');
  const callStartedAt = new Date('2026-10-09T12:55:00.000Z');

  it('offers the earliest slots with a ten-minute travel lead and a one-hour target', () => {
    const slots = findAvailableSlots([], now, callStartedAt);
    expect(slots.length).toBe(3);
    expect(slots[0]).toEqual({
      start: '2026-10-09T13:15:00.000Z',
      end: '2026-10-09T14:15:00.000Z',
      withinOneHour: true,
    });
  });

  it('offers the soonest later time when no slot can start within an hour', () => {
    const busy = [{ start: now.toISOString(), end: '2026-10-09T14:30:00.000Z' }];
    const slots = findAvailableSlots(busy, now, callStartedAt);
    expect(slots[0].start).toBe('2026-10-09T14:45:00.000Z');
    expect(slots[0].withinOneHour).toBe(false);
  });

  it('applies ten-minute travel buffers around existing calendar events', () => {
    const busy = [{ start: '2026-10-09T13:30:00.000Z', end: '2026-10-09T14:30:00.000Z' }];
    const slots = findAvailableSlots(busy, now, callStartedAt);
    expect(slots.some((slot) => slot.start === '2026-10-09T13:15:00.000Z')).toBe(false);
    expect(slots.some((slot) => slot.start === '2026-10-09T14:45:00.000Z')).toBe(true);
  });
});

describe('Google Calendar API boundary', () => {
  const credentials = {
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    GOOGLE_REFRESH_TOKEN: 'test-refresh',
    GOOGLE_CALENDAR_ID: 'primary',
  };

  beforeEach(() => {
    Object.assign(process.env, credentials);
  });

  afterEach(() => {
    Object.keys(credentials).forEach((key) => delete process.env[key]);
  });

  it('refreshes OAuth and requests free/busy for the configured calendar', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'access-token' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ calendars: { primary: { busy: [] } } }),
      });

    await expect(getBusyPeriods(
      new Date('2026-10-09T13:00:00.000Z'),
      new Date('2026-10-10T13:00:00.000Z'),
      fetchImpl,
    )).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://www.googleapis.com/calendar/v3/freeBusy',
      expect.objectContaining({
        method: 'POST',
        headers: { authorization: 'Bearer access-token', 'content-type': 'application/json' },
      }),
    );
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).items).toEqual([{ id: 'primary' }]);
  });

  it('treats the travel buffer as unavailable when rechecking a chosen slot', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'access-token' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          calendars: {
            primary: {
              busy: [{ start: '2026-10-09T13:00:00.000Z', end: '2026-10-09T13:10:00.000Z' }],
            },
          },
        }),
      });
    await expect(isSlotAvailable({
      start: '2026-10-09T13:15:00.000Z',
      end: '2026-10-09T14:15:00.000Z',
    }, fetchImpl)).resolves.toBe(false);
  });

  it('creates a deterministic calendar event with the verified visit details', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'access-token' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'event-1' }) });
    const session = {
      call_sid: 'CA-test-booking',
      customer_name: 'Jordan',
      service_type: 'Plumbing',
      service_address: '123 Example Road',
      issue_description: 'Leaking faucet',
      caller_number: '+19405550123',
    };
    const slot = {
      start: '2026-10-09T13:15:00.000Z',
      end: '2026-10-09T14:15:00.000Z',
    };

    await expect(createBooking(session, slot, fetchImpl)).resolves.toEqual({
      eventId: 'event-1',
      event: { id: 'event-1' },
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      expect.objectContaining({ method: 'POST' }),
    );
    const eventBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(eventBody.summary).toBe('Plumbing - Jordan');
    expect(eventBody.location).toBe('123 Example Road');
    expect(eventBody.start.dateTime).toBe(slot.start);
    expect(eventBody.extendedProperties.private.hootowlCallSid).toBe(session.call_sid);
  });
});

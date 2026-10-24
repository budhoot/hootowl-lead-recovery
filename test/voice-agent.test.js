jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../src/geocoding', () => ({ geocodeServiceAddress: jest.fn() }));
jest.mock('../src/google-calendar', () => ({
  createBooking: jest.fn(),
  isSlotAvailable: jest.fn(),
  suggestSlots: jest.fn(),
}));

const db = require('../src/db');
const { geocodeServiceAddress } = require('../src/geocoding');
const { createBooking, isSlotAvailable, suggestSlots } = require('../src/google-calendar');
const { generateReply } = require('../src/openai-voice');
const {
  bookVisit,
  findCallSlots,
  handlePendingConfirmation,
  prepareBooking,
  saveServiceRequest,
  validateUpgrade,
  websocketUrl,
} = require('../src/voice-agent');

beforeEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
  geocodeServiceAddress.mockReset();
  createBooking.mockReset();
  isSlotAvailable.mockReset();
  suggestSlots.mockReset();
});

describe('voice booking assistant', () => {
  it('validates all caller details and saves only an in-area service request', async () => {
    geocodeServiceAddress.mockResolvedValue({ status: 'inside_area' });
    db.query.mockResolvedValue({ rowCount: 1 });

    await expect(saveServiceRequest('CA1', {
      customer_name: 'Jordan',
      service_type: 'Plumbing',
      service_address: '123 Test St, Nocona Hills, TX 76255',
      issue_description: 'Leaking sink',
    })).resolves.toEqual({ ok: true, in_service_area: true, urgent_safety_reminder: false });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE voice_agent_sessions'),
      ['CA1', 'Jordan', 'Plumbing', '123 Test St, Nocona Hills, TX 76255', 'Leaking sink', false, true, false],
    );
  });

  it('saves the lead for a callback when address verification is unavailable', async () => {
    geocodeServiceAddress.mockRejectedValue(new Error('Google Maps Geocoding is not configured.'));
    db.query.mockResolvedValue({ rowCount: 1 });

    await expect(saveServiceRequest('CA1', {
      customer_name: 'Jordan',
      service_type: 'Plumbing',
      service_address: '123 Test St, Nocona Hills, TX 76255',
      issue_description: 'Leaking sink',
    })).resolves.toMatchObject({ ok: true, booking_available: false, next_step: expect.stringContaining('details are saved') });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('callback_requested=$8'),
      ['CA1', 'Jordan', 'Plumbing', '123 Test St, Nocona Hills, TX 76255', 'Leaking sink', false, false, true],
    );
  });

  it('never offers times for an unverified address', async () => {
    db.query.mockResolvedValueOnce({ rows: [{
      customer_name: 'Jordan', service_type: 'Plumbing', service_address: '123 Test St',
      issue_description: 'Leak', address_verified: false, call_started_at: new Date().toISOString(),
    }] });
    await expect(findCallSlots('CA1')).resolves.toMatchObject({ ok: false, booking_available: false });
    expect(suggestSlots).not.toHaveBeenCalled();
  });

  it('flags a callback instead of failing when the calendar is unavailable', async () => {
    db.query.mockResolvedValueOnce({ rows: [{
      customer_name: 'Jordan', service_type: 'Plumbing', service_address: '123 Test St',
      issue_description: 'Leak', address_verified: true, call_started_at: new Date().toISOString(),
    }] }).mockResolvedValueOnce({ rowCount: 1 });
    suggestSlots.mockRejectedValue(new Error('Google Calendar OAuth is not configured.'));
    await expect(findCallSlots('CA1')).resolves.toMatchObject({ ok: false, booking_available: false });
    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining('callback_requested=TRUE'), ['CA1']);
  });

  it('does not save an address outside the service area', async () => {
    geocodeServiceAddress.mockResolvedValue({ status: 'outside_area' });
    await expect(saveServiceRequest('CA1', {
      customer_name: 'Jordan',
      service_type: 'Plumbing',
      service_address: 'Outside town, TX',
      issue_description: 'Leaking sink',
    })).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('outside') });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('rejects incomplete or oversized booking details before geocoding', async () => {
    await expect(saveServiceRequest('CA1', {
      customer_name: 'J'.repeat(81),
      service_type: 'Plumbing',
      service_address: '123 Test St',
      issue_description: 'Leak',
    })).resolves.toMatchObject({ ok: false });
    expect(geocodeServiceAddress).not.toHaveBeenCalled();
  });

  it('uses function tools for validated booking and speaks the final OpenAI response', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: [{
            type: 'function_call',
            name: 'save_service_request',
            call_id: 'call-1',
            arguments: JSON.stringify({
              customer_name: 'Jordan',
              service_type: 'Plumbing',
              service_address: '123 Test St, Nocona Hills, TX 76255',
              issue_description: 'Leaking sink',
            }),
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ output_text: 'I saved the service details.' }),
      });
    const history = [];
    const tool = jest.fn().mockResolvedValue({ ok: true, in_service_area: true });
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';

    try {
      await expect(generateReply(history, 'I need plumbing help', tool, fetchImpl))
        .resolves.toBe('I saved the service details.');
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
    }

    expect(tool).toHaveBeenCalledWith('save_service_request', expect.objectContaining({ customer_name: 'Jordan' }));
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).input).toContainEqual(
      expect.objectContaining({ type: 'function_call_output', call_id: 'call-1' }),
    );
    expect(history).toEqual([
      { role: 'user', content: 'I need plumbing help' },
      { role: 'assistant', content: 'I saved the service details.' },
    ]);
  });

  it('does not book a visit when the selected choice is invalid', async () => {
    await expect(bookVisit('CA1', 4)).resolves.toMatchObject({ ok: false });
    expect(db.connect).not.toHaveBeenCalled();
  });

  it('stages only a previously offered choice for explicit caller confirmation', async () => {
    const slot = { start: '2026-10-12T16:00:00.000Z', end: '2026-10-12T17:00:00.000Z' };
    db.query.mockResolvedValueOnce({
      rows: [{ call_sid: 'CA1', offered_slots: [slot], google_event_id: null }],
    }).mockResolvedValueOnce({ rowCount: 1 });

    await expect(prepareBooking('CA1', 1)).resolves.toMatchObject({
      ok: true,
      confirmation_required: true,
    });
    expect(db.query.mock.calls[1][0]).toContain('pending_slot_index=$2');
    expect(db.query.mock.calls[1][1]).toEqual(['CA1', 1]);
  });

  it('refuses to create a calendar event until the caller confirms the pending choice', async () => {
    const connection = {
      query: jest.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          rows: [{ call_sid: 'CA1', offered_slots: [], pending_slot_index: null }],
        })
        .mockResolvedValueOnce({}),
      release: jest.fn(),
    };
    db.connect.mockResolvedValue(connection);

    await expect(bookVisit('CA1', 1)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining('explicitly confirmed'),
    });
    expect(isSlotAvailable).not.toHaveBeenCalled();
    expect(createBooking).not.toHaveBeenCalled();
    expect(connection.query.mock.calls[3][0]).toBe('COMMIT');
  });

  it('handles explicit spoken yes/no and asks again when the confirmation is ambiguous', async () => {
    db.query.mockResolvedValue({ rows: [{ pending_slot_index: 1, offered_slots: [{}] }] });
    await expect(handlePendingConfirmation('CA1', 'Maybe later')).resolves.toContain('Please say yes or no');
    await expect(handlePendingConfirmation('CA1', 'No, thanks.')).resolves.toContain('will not book');
    await expect(handlePendingConfirmation('CA1', 'No, I need to check the time with my spouse.'))
      .resolves.toContain('will not book');
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('pending_slot_index=NULL'),
      ['CA1', 'active'],
    );
  });

  it('rechecks availability and creates a booking inside a serialized database transaction', async () => {
    const slot = {
      start: '2026-10-12T16:00:00.000Z',
      end: '2026-10-12T17:00:00.000Z',
      withinOneHour: true,
    };
    const connection = {
      query: jest.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          rows: [{
            call_sid: 'CA1',
            offered_slots: [slot],
            pending_slot_index: 1,
            customer_name: 'Jordan',
            service_type: 'Plumbing',
            service_address: '123 Test St, Nocona Hills, TX 76255',
            caller_number: '+19405550100',
          }],
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}),
      release: jest.fn(),
    };
    db.connect.mockResolvedValue(connection);
    isSlotAvailable.mockResolvedValue(true);
    createBooking.mockResolvedValue({ eventId: 'event-1' });

    await expect(bookVisit('CA1', 1)).resolves.toMatchObject({ ok: true });
    expect(isSlotAvailable).toHaveBeenCalledWith(slot);
    expect(createBooking).toHaveBeenCalledWith(expect.objectContaining({ call_sid: 'CA1' }), slot);
    expect(connection.query.mock.calls[1][0]).toContain('pg_advisory_xact_lock');
    expect(connection.query.mock.calls[3][0]).toContain('google_event_id=$2');
    expect(connection.query.mock.calls[3][0]).toContain('pending_slot_index=NULL');
    expect(connection.query.mock.calls[4][0]).toBe('COMMIT');
    expect(connection.release).toHaveBeenCalled();
  });

  it('returns a fresh-choice response if calendar availability changed', async () => {
    const slot = { start: '2026-10-12T16:00:00.000Z', end: '2026-10-12T17:00:00.000Z' };
    const connection = {
      query: jest.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ call_sid: 'CA1', offered_slots: [slot], pending_slot_index: 1 }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}),
      release: jest.fn(),
    };
    db.connect.mockResolvedValue(connection);
    isSlotAvailable.mockResolvedValue(false);

    await expect(bookVisit('CA1', 1)).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('no longer available') });
    expect(createBooking).not.toHaveBeenCalled();
    expect(connection.query.mock.calls[4][0]).toBe('COMMIT');
  });
});

it('builds a secure ConversationRelay WebSocket URL from the public HTTPS origin', () => {
  expect(websocketUrl('https://api.example.test')).toBe('wss://api.example.test/webhooks/twilio/agent');
  expect(() => websocketUrl('https://api.example.test/unexpected-path')).toThrow(/HTTPS origin/);
});

it('accepts a WebSocket upgrade signed for the wss:// URL Twilio connects to', () => {
  const twilio = require('twilio');
  process.env.TWILIO_AUTH_TOKEN = 'test-token';
  process.env.TWILIO_PUBLIC_BASE_URL = 'https://api.example.test';
  const upgrade = (signedUrl) => ({
    url: '/webhooks/twilio/agent',
    headers: { 'x-twilio-signature': twilio.getExpectedTwilioSignature('test-token', signedUrl, {}) },
  });
  expect(validateUpgrade(upgrade('wss://api.example.test/webhooks/twilio/agent'))).toBe(true);
  expect(validateUpgrade(upgrade('https://api.example.test/webhooks/twilio/agent'))).toBe(true);
  expect(validateUpgrade(upgrade('wss://evil.example.test/webhooks/twilio/agent'))).toBe(false);
  expect(validateUpgrade({ url: '/webhooks/twilio/agent', headers: {} })).toBe(false);
});

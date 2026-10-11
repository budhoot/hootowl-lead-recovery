jest.mock('../src/db', () => ({
  query: jest.fn(),
}));

const request = require('supertest');
const twilio = require('twilio');
const db = require('../src/db');
const app = require('../src/server');

const authToken = 'test-auth-token';
const publicBaseUrl = 'https://api.example.test';

function signedPost(path, params) {
  const signature = twilio.getExpectedTwilioSignature(
    authToken,
    `${publicBaseUrl}${path}`,
    params,
  );

  return request(app)
    .post(path)
    .type('form')
    .set('X-Twilio-Signature', signature)
    .send(params);
}

beforeEach(() => {
  process.env.TWILIO_AUTH_TOKEN = authToken;
  process.env.TWILIO_PUBLIC_BASE_URL = publicBaseUrl;
  db.query.mockReset();
});

describe('Twilio voice webhooks', () => {
  it('rejects webhook requests with an invalid signature', async () => {
    const response = await request(app)
      .post('/webhooks/twilio/voice')
      .type('form')
      .set('X-Twilio-Signature', 'invalid')
      .send({ From: '+14155550100', To: '+18005550100' });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Invalid Twilio signature.' });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('forwards a valid incoming call to the configured client number', async () => {
    db.query.mockResolvedValue({
      rows: [{ id: '12', destination_number: '+14155550123' }],
    });
    const response = await signedPost('/webhooks/twilio/voice', {
      CallSid: 'CA-forward',
      From: '+14155550100',
      To: '+18005550100',
    });

    expect(response.status).toBe(200);
    expect(response.type).toMatch(/xml/);
    expect(response.text).toContain('<Dial');
    expect(response.text).toContain('https://api.example.test/webhooks/twilio/dial-result');
    expect(response.text).toContain('+14155550123');
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('FROM client_phone_numbers'), [
      '+18005550100',
    ]);
  });

  it('records and connects an intake call to the voice agent after the ring delay', async () => {
    process.env.TRIAL_TWILIO_NUMBER = '+19403405234';
    db.query.mockResolvedValueOnce({
      rows: [{
        id: '12',
        destination_number: null,
        intake_enabled: true,
        name: 'Nocona Hills Repair & Replace',
      }],
    }).mockResolvedValueOnce({ rowCount: 1 });

    const response = await signedPost('/webhooks/twilio/voice', {
      CallSid: 'CA-trial',
      From: '+19405550100',
      To: '+19403405234',
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain('<Start>');
    expect(response.text.indexOf('<Pause length="6"/>')).toBeLessThan(response.text.indexOf('<Start>'));
    expect(response.text).toContain('<Recording');
    expect(response.text).toContain('channels="dual"');
    expect(response.text).toContain('track="both"');
    expect(response.text).toContain('trim="do-not-trim"');
    expect(response.text).toContain('<Pause length="6"/>');
    expect(response.text).toContain('<ConversationRelay');
    expect(response.text).toContain('wss://api.example.test/webhooks/twilio/agent');
    expect(response.text).toContain('How may Nocona Hills Repair &amp; Replace help you today?');
    expect(response.text).not.toContain('<Dial');
    expect(response.text).not.toContain('<Message');
    expect(db.query.mock.calls[1][0]).toContain('INSERT INTO voice_agent_sessions');
  });

  it('does not expose an inbound SMS webhook', async () => {
    const response = await request(app).post('/webhooks/twilio/sms').type('form').send({});
    expect(response.status).toBe(404);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('stores Twilio recording completion metadata only for a signed callback', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1 });
    const response = await signedPost('/webhooks/twilio/recording-status', {
      CallSid: 'CA-recording',
      RecordingSid: 'RE01234567890123456789012345678901',
      RecordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC/Recordings/RE',
      RecordingStatus: 'completed',
      RecordingDuration: '34',
    });

    expect(response.status).toBe(204);
    expect(db.query.mock.calls[0][0]).toContain('UPDATE voice_agent_sessions');
    expect(db.query.mock.calls[0][1]).toEqual([
      'CA-recording',
      'RE01234567890123456789012345678901',
      'https://api.twilio.com/2010-04-01/Accounts/AC/Recordings/RE',
      'completed',
      34,
    ]);
  });

  it.each(['no-answer', 'busy', 'failed'])('stores a %s callback idempotently', async (callStatus) => {
    const callbackPath = '/webhooks/twilio/dial-result';
    const missedCall = {
      CallSid: 'CA123',
      DialCallStatus: callStatus,
      From: '+14155550100',
      To: '+18005550100',
    };
    db.query.mockResolvedValueOnce({ rows: [{ id: '12' }] }).mockResolvedValueOnce({ rowCount: 1 });

    const missedResponse = await signedPost(callbackPath, missedCall);

    expect(missedResponse.status).toBe(200);
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('ON CONFLICT (call_sid) DO NOTHING'),
      ['CA123', '12', '+14155550100', callStatus],
    );
  });

  it('ignores completed calls', async () => {
    const completedResponse = await signedPost('/webhooks/twilio/dial-result', {
      CallSid: 'CA123',
      DialCallStatus: 'completed',
      From: '+14155550100',
      To: '+18005550100',
    });

    expect(completedResponse.status).toBe(200);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('returns an explicit unavailable response when signature verification is not configured', async () => {
    delete process.env.TWILIO_AUTH_TOKEN;

    const response = await request(app)
      .post('/webhooks/twilio/voice')
      .type('form')
      .send({ From: '+14155550100', To: '+18005550100' });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Twilio webhook verification is not configured.' });
    expect(db.query).not.toHaveBeenCalled();
  });
});

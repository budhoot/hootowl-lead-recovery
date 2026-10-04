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

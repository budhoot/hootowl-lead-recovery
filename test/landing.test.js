jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));

const request = require('supertest');
const app = require('../src/server');

describe('public landing page', () => {
  it('serves the landing page framable only by HootOwl and Wix hosts', async () => {
    const response = await request(app).get('/landing');
    expect(response.status).toBe(200);
    expect(response.type).toMatch(/html/);
    expect(response.text).toContain('The AI Assistant you\'ve been looking for.');
    expect(response.headers['x-frame-options']).toBeUndefined();
    const csp = response.headers['content-security-policy'];
    expect(csp).toContain('frame-ancestors \'self\' https://www.hootowl.net https://hootowl.net');
    expect(csp).toContain('default-src \'none\'');
    expect(csp).not.toContain('script-src');
  });

  it('serves the logo files and keeps every other page unframable', async () => {
    const logo = await request(app).get('/landing/hootowl-logo.webp');
    expect(logo.status).toBe(200);
    expect(logo.type).toMatch(/webp/);
    const portal = await request(app).get('/portal/');
    expect(portal.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(portal.headers['content-security-policy']).not.toContain('hootowl.net');
  });
});

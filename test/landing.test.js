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

  it.each([
    ['watch', '35700e0f-3c66-4ded-9505-032132e2cf67', '$20'],
    ['pro', 'db1024e0-f106-4c82-84c8-9fa6f96d06fa', '$50'],
    ['enterprise', '7a97db13-3c00-4e46-827b-ac5b18324344', '$100'],
  ])('serves the %s plan page with buy buttons for that plan', async (plan, planId, price) => {
    const response = await request(app).get('/landing/' + plan);
    expect(response.status).toBe(200);
    expect(response.headers['x-frame-options']).toBeUndefined();
    expect(response.headers['content-security-policy']).toContain('frame-ancestors');
    expect(response.text).toContain(price);
    const checkout = 'https://www.hootowl.net/pricing-plans/plan-customization/' + planId;
    expect(response.text.split(checkout).length - 1).toBe(3);
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

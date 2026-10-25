const fs = require('node:fs');
const path = require('node:path');
const sms = require('../src/sms');

let saved;
beforeEach(() => { saved = process.env.SMS_SEND_ENABLED; });
afterEach(() => { if (saved === undefined) delete process.env.SMS_SEND_ENABLED; else process.env.SMS_SEND_ENABLED = saved; });

test('sending is off when SMS_SEND_ENABLED is unset, empty, false or anything but "true"', async () => {
  for (const value of [undefined, '', 'false', 'TRUE', '1', 'yes']) {
    if (value === undefined) delete process.env.SMS_SEND_ENABLED; else process.env.SMS_SEND_ENABLED = value;
    expect(await sms.sendSms('+15125550100', 'code 123456')).toEqual({ sent: false, reason: 'disabled' });
  }
});

test('even when enabled, it does nothing without the sign-in sender number and Twilio credentials', async () => {
  process.env.SMS_SEND_ENABLED = 'true';
  const keep = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_AUTH_FROM'].map(k => [k, process.env[k]]);
  keep.forEach(([k]) => delete process.env[k]);
  try { expect(await sms.sendSms('+15125550100', 'x')).toEqual({ sent: false, reason: 'not_configured' }); }
  finally { keep.forEach(([k, v]) => { if (v !== undefined) process.env[k] = v; }); }
});

test('only the two-step verification route imports the sender', () => {
  const root = path.join(__dirname, '..', 'src');
  const importers = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && /require\(['"]\.{1,2}\/sms['"]\)/.test(fs.readFileSync(full, 'utf8'))) importers.push(path.relative(root, full).split(path.sep).join('/'));
    }
  })(root);
  expect(importers).toEqual(['routes/customer-2fa.js']);
});

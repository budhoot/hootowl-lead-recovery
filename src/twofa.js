const crypto = require('node:crypto');
const { hash } = require('./auth');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

// RFC 6238 / RFC 4226: HMAC-SHA1, 6 digits, 30 second step.
function totpAt(secretB32, step) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1e6;
  return String(code).padStart(6, '0');
}
function currentStep(now = Date.now()) { return Math.floor(now / 1000 / STEP); }
function generateSecret() { return base32Encode(crypto.randomBytes(20)); }
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
// Accepts the current step and one either side for clock drift; returns the matched step or null.
function verifyTotp(secretB32, code, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const step = currentStep(now);
  for (const s of [step - 1, step, step + 1]) if (safeEqual(totpAt(secretB32, s), code)) return s;
  return null;
}
function otpauthUri(secretB32, email) {
  return `otpauth://totp/HootOwl:${encodeURIComponent(email)}?secret=${secretB32}&issuer=HootOwl&digits=6&period=${STEP}`;
}

function encryptionKey() {
  const hex = process.env.TWOFA_ENCRYPTION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw new Error('TWOFA_ENCRYPTION_KEY must be 64 hex characters.');
  return Buffer.from(hex, 'hex');
}
function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function decryptSecret(stored) {
  const [iv, tag, enc] = stored.split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

function newRecoveryCodes(count = 8) {
  return Array.from({ length: count }, () => crypto.randomBytes(5).toString('hex'));
}
const recoveryHash = code => hash('recovery:' + code.toLowerCase().replace(/[^a-f0-9]/g, ''));
const smsCode = () => String(crypto.randomInt(0, 1e6)).padStart(6, '0');
const smsHash = (challenge, code) => hash(`sms:${challenge}:${code}`);

module.exports = { base32Encode, base32Decode, totpAt, currentStep, generateSecret, verifyTotp, otpauthUri,
  encryptSecret, decryptSecret, newRecoveryCodes, recoveryHash, smsCode, smsHash, safeEqual };

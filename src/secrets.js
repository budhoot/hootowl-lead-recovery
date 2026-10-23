const crypto = require('node:crypto');

// AES-256-GCM envelope for per-tenant provider credentials stored in PostgreSQL.
// In AWS the key comes from Secrets Manager; the database never holds plaintext tokens.
function key() {
  const hex = process.env.CREDENTIAL_ENCRYPTION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw new Error('CREDENTIAL_ENCRYPTION_KEY must be 64 hex characters.');
  return Buffer.from(hex, 'hex');
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function decrypt(stored) {
  const [iv, tag, enc] = stored.split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
module.exports = { encrypt, decrypt };

const express = require('express');
const crypto = require('node:crypto');
const { z } = require('zod');
const db = require('../db');
const { hash } = require('../auth');
const auth = require('../customer-auth');
const twofa = require('../twofa');
const sms = require('../sms');

const limit = (max) => require('express-rate-limit').rateLimit({ windowMs: 15 * 60000, limit: max, message: { error: 'Too many attempts. Please wait 15 minutes before trying again.' } });
const phone = z.string().regex(/^\+[1-9][0-9]{6,14}$/);
const code6 = z.string().regex(/^\d{6}$/);
const MAX_ATTEMPTS = 5;

async function methodsFor(userId) {
  const user = (await db.query('SELECT sms_2fa_verified_at FROM customer_users WHERE id=$1', [userId])).rows[0];
  const totp = (await db.query('SELECT 1 FROM customer_totp WHERE user_id=$1 AND confirmed_at IS NOT NULL', [userId])).rowCount > 0;
  return { totp, sms: !!user?.sms_2fa_verified_at };
}
async function createChallenge(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.query('DELETE FROM customer_2fa_challenges WHERE expires_at<NOW()');
  await db.query("INSERT INTO customer_2fa_challenges(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '5 minutes')", [hash(token), userId]);
  return token;
}
async function sendAuthSms(userId, to, text) {
  const result = await sms.sendSms(to, text);
  if (result.sid) {
    const client = (await db.query('SELECT client_id FROM customer_users WHERE id=$1', [userId])).rows[0];
    await db.query("INSERT INTO usage_ledger(client_id,kind,provider_sid,quantity,billable) VALUES($1,'auth_sms',$2,1,false) ON CONFLICT DO NOTHING", [client.client_id, result.sid]);
  }
  return result;
}
async function issueRecoveryCodes(userId) {
  const codes = twofa.newRecoveryCodes();
  await db.query('DELETE FROM customer_recovery_codes WHERE user_id=$1', [userId]);
  for (const c of codes) await db.query('INSERT INTO customer_recovery_codes(user_id,code_hash) VALUES($1,$2)', [userId, twofa.recoveryHash(c)]);
  return codes;
}
async function ensureRecoveryCodes(userId) {
  const left = (await db.query('SELECT 1 FROM customer_recovery_codes WHERE user_id=$1 AND used_at IS NULL', [userId])).rowCount;
  return left ? null : issueRecoveryCodes(userId);
}
const maskPhone = p => p ? p.slice(0, 2) + '*'.repeat(Math.max(0, p.length - 6)) + p.slice(-4) : null;

// Pre-authentication routes: finishing a password login that requires a second factor.
const login = express.Router();
login.post('/session/2fa/sms', limit(5), async (req, res) => {
  const p = z.object({ challenge: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Start sign-in again.' });
  const row = (await db.query(`SELECT c.user_id,u.sms_2fa_phone,u.sms_2fa_verified_at FROM customer_2fa_challenges c
    JOIN customer_users u ON u.id=c.user_id WHERE c.token_hash=$1 AND c.expires_at>NOW()`, [hash(p.data.challenge)])).rows[0];
  if (!row || !row.sms_2fa_verified_at) return res.status(400).json({ error: 'Start sign-in again.' });
  const code = twofa.smsCode();
  await db.query('UPDATE customer_2fa_challenges SET sms_code_hash=$2 WHERE token_hash=$1', [hash(p.data.challenge), twofa.smsHash(p.data.challenge, code)]);
  await sendAuthSms(row.user_id, row.sms_2fa_phone, `Your HootOwl sign-in code is ${code}. It expires in 5 minutes.`);
  res.json({ sent: true });
});
login.post('/session/2fa', limit(20), async (req, res) => {
  const p = z.object({ challenge: z.string().regex(/^[a-f0-9]{64}$/), method: z.enum(['totp', 'sms', 'recovery']), code: z.string().trim().min(6).max(20) }).safeParse(req.body);
  const fail = () => res.status(401).json({ error: 'That code was not accepted.' });
  if (!p.success) return fail();
  const { challenge, method, code } = p.data;
  // Counting the attempt before checking keeps concurrent guesses within the limit.
  const row = (await db.query(`UPDATE customer_2fa_challenges SET attempts=attempts+1 WHERE token_hash=$1 AND expires_at>NOW() AND attempts<$2
    RETURNING user_id,sms_code_hash`, [hash(challenge), MAX_ATTEMPTS])).rows[0];
  if (!row) return fail();
  let ok = false;
  if (method === 'totp' && /^\d{6}$/.test(code)) {
    const t = (await db.query('SELECT secret_enc,last_step FROM customer_totp WHERE user_id=$1 AND confirmed_at IS NOT NULL', [row.user_id])).rows[0];
    const step = t && twofa.verifyTotp(twofa.decryptSecret(t.secret_enc), code);
    if (step && (t.last_step === null || step > Number(t.last_step))) {
      ok = (await db.query('UPDATE customer_totp SET last_step=$2 WHERE user_id=$1 AND (last_step IS NULL OR last_step<$2)', [row.user_id, step])).rowCount === 1;
    }
  } else if (method === 'sms') {
    ok = !!row.sms_code_hash && twofa.safeEqual(row.sms_code_hash, twofa.smsHash(challenge, code));
  } else if (method === 'recovery') {
    ok = (await db.query('UPDATE customer_recovery_codes SET used_at=NOW() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL', [row.user_id, twofa.recoveryHash(code)])).rowCount === 1;
  }
  if (!ok) return fail();
  await db.query('DELETE FROM customer_2fa_challenges WHERE token_hash=$1', [hash(challenge)]);
  await auth.issueSession(req, res, row.user_id);
  res.json({ authenticated: true });
});

// Authenticated routes: enrollment and management.
const manage = express.Router();
manage.get('/2fa', async (req, res) => {
  const m = await methodsFor(req.customer.id);
  const u = (await db.query('SELECT sms_2fa_phone FROM customer_users WHERE id=$1', [req.customer.id])).rows[0];
  const left = (await db.query('SELECT count(*)::int AS n FROM customer_recovery_codes WHERE user_id=$1 AND used_at IS NULL', [req.customer.id])).rows[0].n;
  res.json({ totp: m.totp, sms: m.sms, sms_phone: m.sms ? maskPhone(u.sms_2fa_phone) : null, recovery_codes_remaining: left });
});
manage.post('/2fa/totp/setup', limit(10), async (req, res) => {
  if ((await methodsFor(req.customer.id)).totp) return res.status(409).json({ error: 'Authenticator app is already enabled.' });
  const secret = twofa.generateSecret();
  await db.query(`INSERT INTO customer_totp(user_id,secret_enc) VALUES($1,$2)
    ON CONFLICT(user_id) DO UPDATE SET secret_enc=EXCLUDED.secret_enc,confirmed_at=NULL,last_step=NULL`, [req.customer.id, twofa.encryptSecret(secret)]);
  res.json({ secret, otpauth_uri: twofa.otpauthUri(secret, req.customer.email) });
});
manage.post('/2fa/totp/confirm', limit(10), async (req, res) => {
  const p = z.object({ code: code6 }).safeParse(req.body);
  const t = (await db.query('SELECT secret_enc FROM customer_totp WHERE user_id=$1 AND confirmed_at IS NULL', [req.customer.id])).rows[0];
  const step = p.success && t && twofa.verifyTotp(twofa.decryptSecret(t.secret_enc), p.data.code);
  if (!step) return res.status(400).json({ error: 'That code was not accepted. Check your authenticator app and try again.' });
  await db.query('UPDATE customer_totp SET confirmed_at=NOW(),last_step=$2 WHERE user_id=$1', [req.customer.id, step]);
  res.json({ enabled: true, recovery_codes: await ensureRecoveryCodes(req.customer.id) });
});
manage.post('/2fa/sms/setup', limit(5), async (req, res) => {
  const p = z.object({ phone }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Enter your mobile number with country code, like +15551234567.' });
  const code = twofa.smsCode();
  await db.query('UPDATE customer_users SET sms_2fa_phone=$2,sms_2fa_verified_at=NULL WHERE id=$1', [req.customer.id, p.data.phone]);
  const key = hash('smsenroll:' + req.customer.id);
  await db.query(`INSERT INTO customer_2fa_challenges(token_hash,user_id,sms_code_hash,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '10 minutes')
    ON CONFLICT(token_hash) DO UPDATE SET sms_code_hash=EXCLUDED.sms_code_hash,attempts=0,expires_at=EXCLUDED.expires_at`, [key, req.customer.id, twofa.smsHash(key, code)]);
  await sendAuthSms(req.customer.id, p.data.phone, `Your HootOwl verification code is ${code}.`);
  res.json({ sent: true });
});
manage.post('/2fa/sms/confirm', limit(10), async (req, res) => {
  const p = z.object({ code: code6 }).safeParse(req.body);
  const key = hash('smsenroll:' + req.customer.id);
  const row = p.success && (await db.query(`UPDATE customer_2fa_challenges SET attempts=attempts+1 WHERE token_hash=$1 AND expires_at>NOW() AND attempts<$2
    RETURNING sms_code_hash`, [key, MAX_ATTEMPTS])).rows[0];
  if (!row || !twofa.safeEqual(row.sms_code_hash, twofa.smsHash(key, p.data.code))) return res.status(400).json({ error: 'That code was not accepted.' });
  await db.query('UPDATE customer_users SET sms_2fa_verified_at=NOW() WHERE id=$1', [req.customer.id]);
  await db.query('DELETE FROM customer_2fa_challenges WHERE token_hash=$1', [key]);
  res.json({ enabled: true, recovery_codes: await ensureRecoveryCodes(req.customer.id) });
});
async function passwordOk(req, res) {
  const p = z.object({ password: z.string().min(1).max(128) }).safeParse(req.body);
  const u = p.success && (await db.query('SELECT password_hash FROM customer_users WHERE id=$1', [req.customer.id])).rows[0];
  if (!u || !await auth.verifyPassword(p.data.password, u.password_hash)) { res.status(400).json({ error: 'Your password was not accepted.' }); return false; }
  return true;
}
manage.post('/2fa/recovery-codes', limit(5), async (req, res) => {
  if (!await passwordOk(req, res)) return;
  const m = await methodsFor(req.customer.id);
  if (!m.totp && !m.sms) return res.status(409).json({ error: 'Turn on two-step verification first.' });
  res.json({ recovery_codes: await issueRecoveryCodes(req.customer.id) });
});
manage.post('/2fa/disable', limit(5), async (req, res) => {
  if (!await passwordOk(req, res)) return;
  await db.query('DELETE FROM customer_totp WHERE user_id=$1', [req.customer.id]);
  await db.query('UPDATE customer_users SET sms_2fa_phone=NULL,sms_2fa_verified_at=NULL WHERE id=$1', [req.customer.id]);
  await db.query('DELETE FROM customer_recovery_codes WHERE user_id=$1', [req.customer.id]);
  res.json({ disabled: true });
});

module.exports = { login, manage, methodsFor, createChallenge };

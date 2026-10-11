const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { hash } = require('../auth');
const auth = require('../customer-auth');
const router = express.Router();
router.use(express.json({ limit: '16kb' }), auth.protectWrite);
const authLimit = require('express-rate-limit').rateLimit({ windowMs: 15 * 60000, limit: 30, message: { error: 'Too many attempts. Please wait 15 minutes before trying again.' } });
const email = z.string().trim().email().max(254).transform(v => v.toLowerCase());
const password = z.string().min(12).max(128);
const displayName = z.string().trim().min(1).max(80);
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
// A fixed valid hash keeps nonexistent-account login on the password verification path.
const dummyHash = '0'.repeat(32) + ':' + '0'.repeat(128);

router.post('/invitation', authLimit, async (req, res) => {
 const parsed = tokenSchema.safeParse(req.body?.token);
 if (!parsed.success) return res.status(400).json({ error: 'This invitation is invalid or has expired. Ask HootOwl for a new link.' });
 const result = await db.query(`SELECT c.name,i.email FROM customer_invites i JOIN clients c ON c.id=i.client_id
 WHERE i.token_hash=$1 AND i.used_at IS NULL AND i.expires_at>NOW()`, [hash(parsed.data)]);
 if (!result.rowCount) return res.status(400).json({ error: 'This invitation is invalid or has expired. Ask HootOwl for a new link.' });
 res.json(result.rows[0]);
});
router.post('/register', authLimit, async (req, res) => {
 const parsed = z.object({ token: tokenSchema, display_name: displayName, password }).safeParse(req.body);
 if (!parsed.success) return res.status(400).json({ error: 'Enter your name and a password between 12 and 128 characters.' });
 const v = parsed.data;
 const hashed = await auth.passwordHash(v.password);
 const connection = await db.connect();
 try {
  await connection.query('BEGIN');
  const invitation = (await connection.query(`SELECT * FROM customer_invites WHERE token_hash=$1 AND used_at IS NULL AND expires_at>NOW() FOR UPDATE`, [hash(v.token)])).rows[0];
  if (!invitation) { await connection.query('ROLLBACK'); return res.status(400).json({ error: 'This invitation is invalid or has expired. Ask HootOwl for a new link.' }); }
  const user = (await connection.query('INSERT INTO customer_users(client_id,email,display_name,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [invitation.client_id, invitation.email, v.display_name, hashed])).rows[0];
  await connection.query('UPDATE customer_invites SET used_at=NOW() WHERE token_hash=$1', [hash(v.token)]);
  await auth.issueSession(req, res, user.id, connection);
  await connection.query('COMMIT');
  res.status(201).json({ authenticated: true });
 } catch (error) {
  await connection.query('ROLLBACK');
  if (error.code === '23505') return res.status(409).json({ error: 'An account already exists for this email. Please sign in.' });
  throw error;
 } finally { connection.release(); }
});
router.post('/session', authLimit, async (req, res) => {
 const parsed = z.object({ email, password: z.string().min(1).max(128) }).safeParse(req.body);
 if (!parsed.success) return res.status(401).json({ error: 'Email or password was not accepted.' });
 const user = (await db.query('SELECT id,password_hash FROM customer_users WHERE email=$1', [parsed.data.email])).rows[0];
 const valid = await auth.verifyPassword(parsed.data.password, user?.password_hash || dummyHash);
 if (!user || !valid) return res.status(401).json({ error: 'Email or password was not accepted.' });
 await db.query('DELETE FROM customer_sessions WHERE expires_at<NOW()');
 await auth.issueSession(req, res, user.id);
 res.json({ authenticated: true });
});
router.use(auth.requireCustomer);
router.delete('/session', async (req, res) => {
 await db.query('DELETE FROM customer_sessions WHERE token_hash=$1', [hash(auth.tokenFrom(req))]);
 res.clearCookie(auth.cookieName, { ...auth.cookieOptions(req), maxAge: undefined }); res.sendStatus(204);
});
router.get('/workspace', async (req, res) => {
 const client = (await db.query('SELECT id,name,booking_url,contact_name,timezone,onboarding_completed_at FROM clients WHERE id=$1', [req.customer.client_id])).rows[0];
 const routes = (await db.query('SELECT id,twilio_number,destination_number,is_active,intake_enabled FROM client_phone_numbers WHERE client_id=$1 ORDER BY id', [req.customer.client_id])).rows;
 res.json({ user: req.customer, business: client, routes, voice_only: true });
});
router.patch('/business', async (req, res) => {
 const parsed = z.object({ name: displayName, contact_name: displayName,
  booking_url: z.union([z.literal(''), z.string().url().max(2048).refine(v => { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password; })]),
  timezone: z.string().max(80).refine(v => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }),
  complete_setup: z.boolean().optional()
 }).strict().safeParse(req.body);
 if (!parsed.success) return res.status(400).json({ error: 'Enter your business name, contact name, valid time zone, and an HTTPS booking link (or leave the link blank).' });
 const v = parsed.data;
 await db.query(`UPDATE clients SET name=$2,contact_name=$3,booking_url=$4,timezone=$5,
 onboarding_completed_at=CASE WHEN $6 THEN COALESCE(onboarding_completed_at,NOW()) ELSE onboarding_completed_at END WHERE id=$1`, [req.customer.client_id, v.name, v.contact_name, v.booking_url || null, v.timezone, !!v.complete_setup]);
 res.json({ saved: true });
});
router.patch('/preferences', async (req, res) => {
 const parsed = z.object({ display_name: displayName, theme: z.enum(['system', 'light', 'dark']), accent: z.enum(['forest', 'ocean', 'plum']), density: z.enum(['comfortable', 'compact']), time_format: z.enum(['12', '24']) }).strict().safeParse(req.body);
 if (!parsed.success) return res.status(400).json({ error: 'Select valid appearance and display preferences.' });
 const v = parsed.data;
 await db.query('UPDATE customer_users SET display_name=$2,theme=$3,accent=$4,density=$5,time_format=$6 WHERE id=$1', [req.customer.id, v.display_name, v.theme, v.accent, v.density, v.time_format]);
 res.json({ saved: true });
});
router.patch('/routes/:id', async (req, res) => {
 const parsed = z.object({ destination_number: z.union([z.literal(''), z.string().regex(/^\+[1-9][0-9]{1,14}$/)]) }).strict().safeParse(req.body);
 if (!parsed.success || !/^[1-9][0-9]*$/.test(req.params.id)) return res.status(400).json({ error: 'Enter a phone number with country code, such as +12125550123.' });
 const destination = parsed.data.destination_number || null;
 const result = await db.query(`UPDATE client_phone_numbers SET destination_number=$3::varchar WHERE id=$1 AND client_id=$2
 AND ($3::varchar IS NOT NULL OR intake_enabled=TRUE)
 AND ($3::varchar IS NULL OR NOT EXISTS(SELECT 1 FROM client_phone_numbers WHERE twilio_number=$3::varchar)) RETURNING id`, [req.params.id, req.customer.client_id, destination]);
 if (!result.rowCount) return res.status(400).json({ error: 'This route is unavailable or that number would forward back into HootOwl.' });
 res.json({ saved: true });
});
router.get('/leads', async (req, res) => {
 const clientId = req.customer.client_id;
 const calls = await db.query(`SELECT m.call_sid,m.caller_number,m.call_status,m.created_at,m.follow_up_status,m.customer_notes,r.state,r.delivery_status
 FROM missed_calls m JOIN client_phone_numbers p ON p.id=m.client_phone_number_id LEFT JOIN recovery_messages r ON r.call_sid=m.call_sid
 WHERE p.client_id=$1 ORDER BY m.created_at DESC LIMIT 200`, [clientId]);
 const replies = await db.query(`SELECT i.message_sid,i.caller_number,i.body,i.created_at FROM inbound_messages i
 JOIN client_phone_numbers p ON p.id=i.client_phone_number_id WHERE p.client_id=$1 ORDER BY i.created_at DESC LIMIT 200`, [clientId]);
 res.json({ calls: calls.rows, replies: replies.rows });
});
router.patch('/leads/:sid', async (req, res) => {
 const parsed = z.object({ status: z.enum(['new', 'in_progress', 'resolved']), notes: z.string().max(4000) }).strict().safeParse(req.body);
 if (!parsed.success || req.params.sid.length > 100) return res.status(400).json({ error: 'Choose a valid follow-up status and notes up to 4,000 characters.' });
 const result = await db.query(`UPDATE missed_calls m SET follow_up_status=$3,customer_notes=$4 FROM client_phone_numbers p
 WHERE m.client_phone_number_id=p.id AND m.call_sid=$1 AND p.client_id=$2 RETURNING m.call_sid`, [req.params.sid, req.customer.client_id, parsed.data.status, parsed.data.notes]);
 if (!result.rowCount) return res.sendStatus(404);
 res.json({ saved: true });
});
router.post('/password', authLimit, async (req, res) => {
 const parsed = z.object({ current_password: z.string().min(1).max(128), new_password: password }).safeParse(req.body);
 if (!parsed.success) return res.status(400).json({ error: 'Use a new password between 12 and 128 characters.' });
 const connection = await db.connect();
 try {
  await connection.query('BEGIN');
  const user = (await connection.query('SELECT password_hash FROM customer_users WHERE id=$1 FOR UPDATE', [req.customer.id])).rows[0];
  if (!await auth.verifyPassword(parsed.data.current_password, user.password_hash)) { await connection.query('ROLLBACK'); return res.status(400).json({ error: 'Your current password was not accepted.' }); }
  await connection.query('UPDATE customer_users SET password_hash=$2 WHERE id=$1', [req.customer.id, await auth.passwordHash(parsed.data.new_password)]);
  await connection.query('DELETE FROM customer_sessions WHERE user_id=$1', [req.customer.id]);
  await auth.issueSession(req, res, req.customer.id, connection);
  await connection.query('COMMIT'); res.json({ saved: true });
 } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
});
module.exports = router;

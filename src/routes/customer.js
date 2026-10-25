const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { hash } = require('../auth');
const auth = require('../customer-auth');
const twoFactor = require('./customer-2fa');
const { VOICES: voices, isAllowedVoice } = require('../voices');
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
 const factors = await twoFactor.methodsFor(user.id);
 if (factors.totp || factors.sms) {
  return res.json({ authenticated: false, two_factor_required: true, challenge: await twoFactor.createChallenge(user.id), methods: factors });
 }
 await db.query('DELETE FROM customer_sessions WHERE expires_at<NOW()');
 await auth.issueSession(req, res, user.id);
 res.json({ authenticated: true });
});
router.use(twoFactor.login);
router.use(auth.requireCustomer);
router.use(twoFactor.manage);
router.get('/subscription', async (req, res) => {
 const clientId = req.customer.client_id;
 const sub = (await db.query('SELECT status,current_period_end FROM billing_subscriptions WHERE client_id=$1', [clientId])).rows[0];
 const prov = (await db.query('SELECT status,last_error FROM twilio_provisioning WHERE client_id=$1', [clientId])).rows[0];
 res.json({ subscription: sub || { status: 'none' }, provisioning: prov ? { status: prov.status, failed: prov.status === 'failed' } : { status: 'not_started' }, usage_30_days: await require('../usage').summary(clientId) });
});
router.post('/provisioning', authLimit, async (req, res) => {
 const parsed = z.object({ consent: z.literal(true), area_code: z.string().regex(/^[2-9][0-9]{2}$/).optional() }).strict().safeParse(req.body);
 if (!parsed.success) return res.status(400).json({ error: 'Confirm consent and, optionally, enter a 3-digit area code.' });
 const provisioning = require('../provisioning');
 const requested = await provisioning.requestProvisioning(req.customer.client_id);
 if (!requested.ok) return res.status(402).json({ error: 'An active HootOwl subscription is required before we can set up your phone number.' });
 const result = await provisioning.provision(req.customer.client_id, { areaCode: parsed.data.area_code });
 if (!result.ok) return res.status(502).json({ error: 'We could not finish setup yet. HootOwl has been notified and will retry.' });
 res.status(result.already ? 200 : 201).json({ status: 'active' });
});
router.delete('/session', async (req, res) => {
 await db.query('DELETE FROM customer_sessions WHERE token_hash=$1', [hash(auth.tokenFrom(req))]);
 res.clearCookie(auth.cookieName, { ...auth.cookieOptions(req), maxAge: undefined }); res.sendStatus(204);
});
router.get('/workspace', async (req, res) => {
 const client = (await db.query('SELECT id,name,booking_url,contact_name,timezone,onboarding_completed_at FROM clients WHERE id=$1', [req.customer.client_id])).rows[0];
 const routes = (await db.query('SELECT id,twilio_number,destination_number,is_active,intake_enabled FROM client_phone_numbers WHERE client_id=$1 ORDER BY id', [req.customer.client_id])).rows;
 res.json({ user: req.customer, business: client, routes, voice_only: true });
});
const PREVIEWS_PER_DAY = 10;
const receptionistText = (min, max) => z.string().trim().min(min).max(max);
async function previewsToday(clientId) {
 const { rows } = await db.query(`SELECT count(*)::int AS n FROM voice_agent_sessions s JOIN client_phone_numbers p ON p.id=s.client_phone_number_id
 WHERE p.client_id=$1 AND s.is_preview AND s.created_at>NOW()-INTERVAL '24 hours'`, [clientId]);
 return rows[0].n;
}
router.get('/receptionist', async (req, res) => {
 const clientId = req.customer.client_id;
 const profile = (await db.query(`SELECT assistant_name,business_name,name_only_when_asked,to_char(started_on,'YYYY-MM-DD') AS started_on,greeting,closing_line,
 services,service_radius_miles,service_area_label,place_hints,voice_id,ready,(service_latitude IS NOT NULL) AS has_service_center
 FROM agent_profiles WHERE client_id=$1`, [clientId])).rows[0] || null;
 const routes = (await db.query('SELECT id,twilio_number,destination_number,is_active,intake_enabled FROM client_phone_numbers WHERE client_id=$1 ORDER BY id', [clientId])).rows;
 res.json({ profile, voices, routes, previews_left: Math.max(0, PREVIEWS_PER_DAY - await previewsToday(clientId)) });
});
// Customers edit what their assistant says and sounds like; the service center and AI answering stay with HootOwl.
router.put('/receptionist', async (req, res) => {
 const parsed = z.object({ assistant_name: receptionistText(1, 60), business_name: receptionistText(1, 120), name_only_when_asked: z.boolean(),
  started_on: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]), greeting: receptionistText(1, 300), closing_line: receptionistText(0, 300),
  services: receptionistText(0, 1000), service_area_label: receptionistText(0, 200), service_radius_miles: z.number().int().min(1).max(500),
  place_hints: receptionistText(0, 600), voice_id: z.string().max(100), ready: z.boolean() }).strict().safeParse(req.body);
 if (!parsed.success) return res.status(400).json({ error: 'Check each field: names, greeting, and closing line have length limits, and the radius is 1 to 500 miles.' });
 const v = parsed.data, clientId = req.customer.client_id;
 const current = (await db.query('SELECT voice_id FROM agent_profiles WHERE client_id=$1', [clientId])).rows[0];
 if (!isAllowedVoice(v.voice_id, current?.voice_id)) return res.status(400).json({ error: 'Choose one of the listed voices.' });
 await db.query(`INSERT INTO agent_profiles(client_id,assistant_name,business_name,name_only_when_asked,started_on,greeting,closing_line,services,
 service_area_label,service_radius_miles,place_hints,tts_provider,voice_id,ready)
 VALUES($1,$2,$3,$4,NULLIF($5,'')::date,$6,$7,$8,$9,$10,$11,'ElevenLabs',$12,$13)
 ON CONFLICT(client_id) DO UPDATE SET assistant_name=EXCLUDED.assistant_name,business_name=EXCLUDED.business_name,
 name_only_when_asked=EXCLUDED.name_only_when_asked,started_on=EXCLUDED.started_on,greeting=EXCLUDED.greeting,closing_line=EXCLUDED.closing_line,
 services=EXCLUDED.services,service_area_label=EXCLUDED.service_area_label,service_radius_miles=EXCLUDED.service_radius_miles,
 place_hints=EXCLUDED.place_hints,tts_provider=EXCLUDED.tts_provider,voice_id=EXCLUDED.voice_id,ready=EXCLUDED.ready,updated_at=NOW()`,
 [clientId, v.assistant_name, v.business_name, v.name_only_when_asked, v.started_on, v.greeting, v.closing_line, v.services,
  v.service_area_label, v.service_radius_miles, v.place_hints, v.voice_id, v.ready]);
 res.json({ saved: true });
});
// Calls the customer's own forwarding phone from their HootOwl number so they can talk to their assistant.
router.post('/receptionist/preview', authLimit, async (req, res) => {
 const clientId = req.customer.client_id;
 const route = (await db.query(`SELECT p.twilio_number,p.destination_number FROM client_phone_numbers p JOIN agent_profiles a ON a.client_id=p.client_id
 WHERE p.client_id=$1 AND p.destination_number IS NOT NULL ORDER BY p.id LIMIT 1`, [clientId])).rows[0];
 if (!route) return res.status(409).json({ error: 'Save your AI receptionist and a forwarding phone number first. We call that phone for the preview.' });
 if (await previewsToday(clientId) >= PREVIEWS_PER_DAY) return res.status(429).json({ error: 'You have used today’s preview calls. Please try again tomorrow.' });
 try {
  const twilioClient = await require('../provisioning').clientForCustomer(clientId);
  await twilioClient.calls.create({ to: route.destination_number, from: route.twilio_number, timeout: 30,
   url: new URL('/webhooks/twilio/preview', process.env.TWILIO_PUBLIC_BASE_URL).toString(), method: 'POST' });
  res.status(202).json({ calling: route.destination_number.slice(0, -4).replace(/\d/g, '•') + route.destination_number.slice(-4) });
 } catch (error) {
  console.error('Unable to place receptionist preview call:', error.code || error.name);
  res.status(502).json({ error: 'We could not place the preview call right now. Please try again in a few minutes.' });
 }
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
 const result = await db.query(`UPDATE client_phone_numbers SET destination_number=$3::varchar,
 is_active=(is_active OR $3::varchar IS NOT NULL),
 intake_enabled=(intake_enabled AND NOT (NOT is_active AND $3::varchar IS NOT NULL)) WHERE id=$1 AND client_id=$2
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

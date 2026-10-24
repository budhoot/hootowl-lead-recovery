const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { requireOperator } = require('../auth');
const { issueInvite: invite } = require('../onboarding');
const router = express.Router();
router.use(requireOperator, express.json({ limit: '8kb' }));
const inviteSchema = z.object({ email: z.string().trim().email().max(254).transform(v => v.toLowerCase()) });
router.get('/', async (req, res) => {
 res.json((await db.query(`SELECT c.id,c.name,c.onboarding_completed_at,
 (SELECT count(*) FROM customer_users u WHERE u.client_id=c.id) AS accounts,
 (SELECT count(*) FROM client_phone_numbers p WHERE p.client_id=c.id) AS phone_routes,
 COALESCE(b.status,'none') AS subscription_status, b.current_period_end,
 COALESCE(tp.status,'not_provisioned') AS twilio_status
 FROM clients c LEFT JOIN billing_subscriptions b ON b.client_id=c.id
 LEFT JOIN twilio_provisioning tp ON tp.client_id=c.id ORDER BY c.id DESC`)).rows);
});
router.get('/billing/unmatched', async (req, res) => {
 res.json((await db.query(`SELECT id,event_type,payload->>'buyer_email' AS buyer_email,payload->>'plan_id' AS plan_id,received_at
 FROM billing_events WHERE outcome='unmatched' ORDER BY received_at DESC LIMIT 200`)).rows);
});
router.post('/billing/reconcile', async (req, res) => {
 res.json(await require('../billing').reconcileUnmatched());
});
router.post('/:id/provision', async (req, res) => {
 if (!/^[1-9][0-9]*$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid customer.' });
 const provisioning = require('../provisioning');
 await db.query('UPDATE twilio_provisioning SET attempts=0 WHERE client_id=$1', [req.params.id]);
 const result = await provisioning.provision(req.params.id, { areaCode: req.body?.area_code });
 res.status(result.ok ? 200 : 409).json({ ok: result.ok, reason: result.reason || null });
});
router.post('/', async (req, res) => {
 const parsed = inviteSchema.extend({ name: z.string().trim().min(1).max(80) }).safeParse(req.body);
 if (!parsed.success) return res.status(400).json({ error: 'Enter a business name and valid customer email.' });
 const connection = await db.connect();
 try {
  await connection.query('BEGIN');
  const exists = await connection.query('SELECT 1 FROM customer_users WHERE email=$1', [parsed.data.email]);
  if (exists.rowCount) { await connection.query('ROLLBACK'); return res.status(409).json({ error: 'This email already has an account. Use its existing workspace.' }); }
  const client = (await connection.query('INSERT INTO clients(name) VALUES($1) RETURNING id,name', [parsed.data.name])).rows[0];
  const result = await invite(connection, client.id, parsed.data.email);
  await connection.query('COMMIT');
  res.status(201).json({ client, ...result });
 } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
});
router.post('/:id/invitations', async (req, res) => {
 const parsed = inviteSchema.safeParse(req.body);
 if (!parsed.success || !/^[1-9][0-9]*$/.test(req.params.id)) return res.status(400).json({ error: 'Enter a valid customer email.' });
 const connection = await db.connect();
 try {
  await connection.query('BEGIN');
  const client = await connection.query('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [req.params.id]);
  if (!client.rowCount) { await connection.query('ROLLBACK'); return res.sendStatus(404); }
  const exists = await connection.query('SELECT 1 FROM customer_users WHERE email=$1', [parsed.data.email]);
  if (exists.rowCount) { await connection.query('ROLLBACK'); return res.status(409).json({ error: 'This email already has an account.' }); }
  const result = await invite(connection, req.params.id, parsed.data.email);
  await connection.query('COMMIT'); res.status(201).json(result);
 } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
});
router.post('/:id/routes', async (req, res) => {
 const phone = z.string().regex(/^\+[1-9][0-9]{1,14}$/);
 const parsed = z.object({
  twilio_number: phone,
  destination_number: z.union([z.literal(''), phone]).optional(),
  intake_enabled: z.boolean().default(false),
 }).refine(v => (v.intake_enabled || !!v.destination_number) &&
  (!v.destination_number || v.twilio_number !== v.destination_number)).safeParse(req.body);
 if (!parsed.success || !/^[1-9][0-9]*$/.test(req.params.id)) return res.status(400).json({ error: 'Provide a forwarding number or enable AI voice answering, using country-code phone numbers.' });
 const client = await db.query('SELECT id FROM clients WHERE id=$1', [req.params.id]);
 if (!client.rowCount) return res.sendStatus(404);
 try {
  const result = await db.query(`INSERT INTO client_phone_numbers(client_id,twilio_number,destination_number,recovery_enabled,intake_enabled)
  VALUES($1,$2,$3,FALSE,$4) RETURNING id`, [req.params.id, parsed.data.twilio_number, parsed.data.destination_number || null, parsed.data.intake_enabled]);
  res.status(201).json(result.rows[0]);
 } catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'That Twilio number is already assigned.' }); throw error; }
});
module.exports = router;

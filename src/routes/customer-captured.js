const express = require('express');
const db = require('../db');
const auth = require('../customer-auth');
const router = express.Router();

// Requests the AI receptionist captured for THIS business only. The business comes from the signed-in session,
// never from the request. Previews are left out, and call audio and recording links are never selected.
const limit = require('express-rate-limit').rateLimit({ windowMs: 60000, limit: 60, message: { error: 'Too many requests. Please wait a minute and try again.' } });
router.use(auth.protectWrite, limit, auth.requireCustomer);
router.get('/', async (req, res) => {
 const { rows } = await db.query(`SELECT s.customer_name,s.caller_number,s.service_type,s.service_address,s.issue_description,
 s.risk_flag,s.address_verified,s.callback_requested,s.booked_start,s.created_at
 FROM voice_agent_sessions s JOIN client_phone_numbers p ON p.id=s.client_phone_number_id
 WHERE p.client_id=$1 AND NOT s.is_preview AND s.customer_name<>'' ORDER BY s.created_at DESC LIMIT 200`, [req.customer.client_id]);
 res.json({ requests: rows });
});
module.exports = router;

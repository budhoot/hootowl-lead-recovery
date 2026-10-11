const crypto = require('node:crypto');
const { promisify } = require('node:util');
const db = require('./db');
const { hash } = require('./auth');
const scrypt = promisify(crypto.scrypt);
const cookieName = 'hootowl_customer';

async function passwordHash(password) {
 const salt = crypto.randomBytes(16).toString('hex');
 const key = await scrypt(password, salt, 64);
 return `${salt}:${key.toString('hex')}`;
}
async function verifyPassword(password, stored) {
 const [salt, value] = stored.split(':');
 const key = await scrypt(password, salt, 64);
 const expected = Buffer.from(value, 'hex');
 return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}
function tokenFrom(req) {
 return (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
}
function publicOrigin() {
 try { return new URL(process.env.TWILIO_PUBLIC_BASE_URL).origin; } catch { return null; }
}
function allowedOrigin(req) {
 const origin = req.get('Origin');
 return !origin || origin === `${req.protocol}://${req.get('host')}` || origin === publicOrigin();
}
function protectWrite(req, res, next) {
 res.set('Cache-Control', 'no-store');
 if (!['GET', 'HEAD'].includes(req.method) && (!allowedOrigin(req) || req.get('X-HootOwl-Request') !== 'customer')) {
  return res.status(403).json({ error: 'Please submit changes from your HootOwl workspace.' });
 }
 next();
}
function cookieOptions(req) {
 // ngrok terminates TLS upstream; only the configured public host enables this fallback.
 const configured = publicOrigin();
 const secure = req.secure || !!(configured && configured.startsWith('https:') && new URL(configured).host === req.get('host'));
 return { httpOnly: true, sameSite: 'strict', secure, path: '/portal', maxAge: 7 * 86400000 };
}
async function issueSession(req, res, userId, connection = db) {
 const token = crypto.randomBytes(32).toString('hex');
 await connection.query("INSERT INTO customer_sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '7 days')", [hash(token), userId]);
 res.cookie(cookieName, token, cookieOptions(req));
}
async function requireCustomer(req, res, next) {
 const token = tokenFrom(req);
 if (!token || !/^[a-f0-9]{64}$/.test(token)) return res.status(401).json({ error: 'Sign in to your workspace.' });
 const result = await db.query(`SELECT u.id,u.client_id,u.email,u.display_name,u.theme,u.accent,u.density,u.time_format
 FROM customer_sessions s JOIN customer_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW()`, [hash(token)]);
 if (!result.rowCount) return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
 req.customer = result.rows[0];
 next();
}
module.exports = { passwordHash, verifyPassword, tokenFrom, protectWrite, issueSession, requireCustomer, cookieOptions, cookieName };

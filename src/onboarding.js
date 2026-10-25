// Creates a customer workspace and portal invitation for a buyer, shared by operators and the Wix automation.
const crypto = require('node:crypto');
const db = require('./db');
const { hash } = require('./auth');

async function issueInvite(connection, clientId, email, hours = 48) {
  const token = crypto.randomBytes(32).toString('hex');
  await connection.query('DELETE FROM customer_invites WHERE client_id=$1 AND email=$2 AND used_at IS NULL', [clientId, email]);
  await connection.query(`INSERT INTO customer_invites(token_hash,client_id,email,expires_at) VALUES($1,$2,$3,NOW()+make_interval(hours => $4::int))`,
    [hash(token), clientId, email, hours]);
  return { invitation_path: `/portal/#invite=${token}`, expires_in_hours: hours };
}

// Idempotent per email: an existing account gets no invite; a pending invite keeps its workspace and gets a fresh link.
async function ensureCustomer(email, businessName, hours = 7 * 24) {
  const connection = await db.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['onboarding:' + email]);
    const user = (await connection.query('SELECT client_id FROM customer_users WHERE email=$1', [email])).rows[0];
    if (user) {
      await connection.query('COMMIT');
      return { client_id: user.client_id, existing_account: true };
    }
    let clientId = (await connection.query(
      'SELECT client_id FROM customer_invites WHERE email=$1 ORDER BY created_at DESC LIMIT 1', [email])).rows[0]?.client_id;
    const created = !clientId;
    if (created) clientId = (await connection.query('INSERT INTO clients(name) VALUES($1) RETURNING id', [businessName])).rows[0].id;
    const invite = await issueInvite(connection, clientId, email, hours);
    await connection.query('COMMIT');
    return { client_id: clientId, existing_account: false, new_workspace: created, ...invite };
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}

// Logs a warning (never blocks, never throws) when the email an invitation registers with differs from the buyer email
// on the client's billing subscription. A difference means later Wix events for the other address cannot be matched
// to this account. Emails are masked in the log. Runs after the registration has committed, on its own connection.
function maskEmail(email) {
  const [local = '', domain = ''] = String(email).split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}
async function warnOnBuyerEmailMismatch(clientId, registeredEmail) {
  try {
    const row = (await db.query('SELECT buyer_email FROM billing_subscriptions WHERE client_id=$1', [clientId])).rows[0];
    if (!row || !row.buyer_email) return false;
    if (String(row.buyer_email).toLowerCase() === String(registeredEmail).toLowerCase()) return false;
    console.warn(`BUYER EMAIL MISMATCH: client ${clientId} registered with ${maskEmail(registeredEmail)} but the Wix buyer email on its subscription is ${maskEmail(row.buyer_email)}. Wix events for the buyer address will not match this account until the emails agree.`);
    return true;
  } catch (error) {
    console.error('Unable to check the buyer email:', error.message);
    return false;
  }
}

module.exports = { ensureCustomer, issueInvite, warnOnBuyerEmailMismatch };

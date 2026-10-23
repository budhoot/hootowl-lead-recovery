const twilio = require('twilio');
const db = require('./db');
const secrets = require('./secrets');
const billing = require('./billing');

const MAX_ATTEMPTS = 5;
let clientFactory = (sid, token) => twilio(sid, token);
function setClientFactory(fn) { clientFactory = fn || ((sid, token) => twilio(sid, token)); }

function webhookUrl(path) {
  return new URL(path, process.env.TWILIO_PUBLIC_BASE_URL).toString();
}

// Records the customer's consent. Requires an active paid subscription.
async function requestProvisioning(clientId) {
  if (!await billing.isSubscriptionActive(clientId)) return { ok: false, reason: 'subscription_required' };
  await db.query(`INSERT INTO twilio_provisioning(client_id,consent_at) VALUES($1,NOW()) ON CONFLICT(client_id) DO NOTHING`, [clientId]);
  return { ok: true };
}

// Idempotent and resumable: each step is skipped once its result is stored, so a retry never creates a second subaccount or number.
async function provision(clientId, { areaCode } = {}) {
  const row = (await db.query('SELECT * FROM twilio_provisioning WHERE client_id=$1', [clientId])).rows[0];
  if (!row) return { ok: false, reason: 'no_consent' };
  if (row.status === 'active') return { ok: true, already: true };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };
  if (!await billing.isSubscriptionActive(clientId)) return { ok: false, reason: 'subscription_required' };
  await db.query('UPDATE twilio_provisioning SET attempts=attempts+1,updated_at=NOW() WHERE client_id=$1', [clientId]);
  let token = row.credential_ref ? secrets.decrypt(row.credential_ref) : null;
  try {
    const master = clientFactory(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    let sid = row.subaccount_sid;
    if (!sid) {
      const sub = await master.api.v2010.accounts.create({ friendlyName: `HootOwl client ${clientId}` });
      sid = sub.sid; token = sub.authToken;
      await db.query('UPDATE twilio_provisioning SET subaccount_sid=$2,credential_ref=$3 WHERE client_id=$1', [clientId, sid, secrets.encrypt(token)]);
    }
    const sub = clientFactory(sid, token);
    const owned = await sub.incomingPhoneNumbers.list({ limit: 1 });
    let number = owned[0]?.phoneNumber;
    if (!number) {
      const found = await sub.availablePhoneNumbers('US').local.list({ areaCode, voiceEnabled: true, smsEnabled: true, limit: 1 });
      if (!found.length) throw new Error('No phone number available for that area code.');
      const bought = await sub.incomingPhoneNumbers.create({
        phoneNumber: found[0].phoneNumber,
        voiceUrl: webhookUrl('/webhooks/twilio/voice'), voiceMethod: 'POST',
        statusCallback: webhookUrl('/webhooks/twilio/call-status'), statusCallbackMethod: 'POST'
      });
      number = bought.phoneNumber;
    }
    await db.query(`INSERT INTO client_phone_numbers(client_id,twilio_number,destination_number,is_active,intake_enabled) VALUES($1,$2,NULL,FALSE,TRUE)
      ON CONFLICT(twilio_number) DO NOTHING`, [clientId, number]);
    await db.query(`UPDATE twilio_provisioning SET status='active',last_error=NULL,updated_at=NOW() WHERE client_id=$1`, [clientId]);
    return { ok: true, number };
  } catch (error) {
    const message = String(error.message);
    const safe = (token ? message.split(token).join('[redacted]') : message).slice(0, 300);
    await db.query(`UPDATE twilio_provisioning SET status='failed',last_error=$2,updated_at=NOW() WHERE client_id=$1`, [clientId, safe]);
    return { ok: false, reason: 'provider_error' };
  }
}

// Returns the auth token used to sign webhooks for an account, or null for accounts HootOwl does not manage.
async function tokenForAccount(accountSid) {
  if (!/^AC[a-f0-9]{32}$/i.test(accountSid || '')) return null;
  if (accountSid === process.env.TWILIO_ACCOUNT_SID) return process.env.TWILIO_AUTH_TOKEN || null;
  const row = (await db.query(`SELECT credential_ref FROM twilio_provisioning WHERE subaccount_sid=$1 AND status='active'`, [accountSid])).rows[0];
  return row?.credential_ref ? secrets.decrypt(row.credential_ref) : null;
}

// Suspends a subaccount when the customer's subscription ends so it cannot keep incurring charges.
async function setSubaccountStatus(clientId, status) {
  const row = (await db.query('SELECT subaccount_sid FROM twilio_provisioning WHERE client_id=$1', [clientId])).rows[0];
  if (!row?.subaccount_sid) return { ok: false };
  await clientFactory(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN).api.v2010.accounts(row.subaccount_sid).update({ status });
  return { ok: true };
}

module.exports = { requestProvisioning, provision, tokenForAccount, setSubaccountStatus, setClientFactory };

// Emails the contractor a short note when their AI receptionist saves a caller's request.
// Never throws, never awaited by the call flow, and does nothing at all while mail is not configured.
// The note never carries call audio, a recording link or a sign-in link.
const db = require('./db');
const { isConfigured, sendMail } = require('./mailer');

const clean = (value, max) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

function when(value, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone })
      .format(new Date(value));
  } catch {
    return new Date(value).toISOString();
  }
}

function inboxUrl() {
  try { return new URL('/portal/', process.env.TWILIO_PUBLIC_BASE_URL).toString(); } catch { return null; }
}

function leadMessage(lead) {
  const lines = [
    `Your HootOwl receptionist just took a call for ${clean(lead.business_name, 120)}.`,
    '',
    `Caller: ${clean(lead.customer_name, 80)}`,
    `Phone: ${clean(lead.caller_number, 20)}`,
    `Service: ${clean(lead.service_type, 160)}`,
    `Address: ${clean(lead.service_address, 300)}${lead.address_verified ? '' : ' (could not be checked automatically)'}`,
    `Problem: ${String(lead.issue_description ?? '').trim().slice(0, 1200)}`,
    `Call time: ${when(lead.call_started_at, lead.timezone)}`,
  ];
  if (lead.risk_flag) {
    lines.push('', 'Safety: the caller described a possible safety issue, such as fire, smoke, gas, sparks or a live wire. Call them back right away.');
  }
  lines.push('', 'The caller was told someone will be in touch. Please follow up as soon as you can.');
  const url = inboxUrl();
  if (url) lines.push('', `Every captured call is in your Inbox: ${url}`);
  return {
    subject: clean(`New call: ${lead.service_type} (${lead.customer_name})`, 120),
    text: lines.join('\n'),
  };
}

// Claims the email for this call (once), then sends it to the workspace users of that business.
// A claim that sent nothing is released so a later save of the same call can try again.
async function notifyCapturedRequest(callSid) {
  if (!isConfigured()) return { status: 'skipped' };
  let claimed = false;
  try {
    const lead = (await db.query(
      `UPDATE voice_agent_sessions s SET owner_notified_at=NOW()
       FROM client_phone_numbers p JOIN clients c ON c.id=p.client_id
       WHERE s.client_phone_number_id=p.id AND s.call_sid=$1 AND NOT s.is_preview
         AND s.owner_notified_at IS NULL AND s.customer_name<>''
       RETURNING p.client_id,c.name AS business_name,c.timezone,s.customer_name,s.caller_number,s.service_type,
         s.service_address,s.issue_description,s.risk_flag,s.address_verified,s.call_started_at`,
      [callSid],
    )).rows[0];
    if (!lead) return { status: 'not_needed' };
    claimed = true;
    const recipients = (await db.query(
      'SELECT email FROM customer_users WHERE client_id=$1 ORDER BY id LIMIT 5',
      [lead.client_id],
    )).rows.map(row => row.email);
    let sent = 0;
    if (recipients.length) {
      const message = leadMessage(lead);
      const results = await Promise.all(recipients.map(to => sendMail({ to, ...message })));
      sent = results.filter(result => result.ok).length;
      for (const result of results) if (!result.ok) console.error('Captured request email failed:', result.detail);
    }
    if (!sent) {
      await db.query('UPDATE voice_agent_sessions SET owner_notified_at=NULL WHERE call_sid=$1', [callSid]);
      return { status: 'failed' };
    }
    return { status: 'sent' };
  } catch (error) {
    console.error('Captured request email step failed:', error && (error.code || error.name));
    if (claimed) {
      try { await db.query('UPDATE voice_agent_sessions SET owner_notified_at=NULL WHERE call_sid=$1', [callSid]); } catch { /* nothing more to do */ }
    }
    return { status: 'failed' };
  }
}

module.exports = { notifyCapturedRequest, leadMessage };

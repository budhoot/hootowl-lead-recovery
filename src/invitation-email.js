// Emails the workspace invitation to a new buyer, and a link-free note to the owner.
// Runs after the Wix response has been sent. It never throws, never logs the link or the key,
// and does nothing but one log line while MAIL_API_KEY is not set.
const db = require('./db');
const { planFor } = require('./plans');
const { isConfigured, sendMail } = require('./mailer');

function buyerMessage(firstName, link) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  return {
    subject: 'Your HootOwl workspace is ready',
    text: [
      greeting,
      '',
      'Thanks for joining HootOwl. Use this link to create your login. It works for 7 days:',
      link,
      '',
      'HootOwl answers your business calls with an AI receptionist. It is for calls only.',
      'Next: create your login, get your HootOwl number, then set up your receptionist.',
      '',
      'If the link has expired or does not work, contact us through hootowl.net and we will send a new one.',
    ].join('\n'),
  };
}

async function record(clientId, email, orderId, status, detail) {
  try {
    await db.query('INSERT INTO invitation_emails(client_id,email,order_id,status,detail) VALUES($1,$2,$3,$4,$5)',
      [clientId, email, orderId, status, detail || null]);
  } catch (error) {
    console.error('Unable to record the invitation email result:', error.code || error.name);
  }
}

async function notifyPurchase({ clientId, email, orderId, planId, firstName, link }) {
  try {
    if (!process.env.MAIL_API_KEY) {
      console.log('Invitation email skipped: MAIL_API_KEY is not set.');
      return { status: 'skipped' };
    }
    if (!isConfigured()) {
      console.log('Invitation email skipped: MAIL_FROM is not set.');
      return { status: 'skipped' };
    }
    let outcome = 'not needed (account already exists)';
    let status = 'not_needed';
    if (link) {
      const message = buyerMessage(firstName, link);
      const result = await sendMail({ to: email, ...message });
      status = result.ok ? 'sent' : 'failed';
      outcome = status;
      await record(clientId, email, orderId, status, result.ok ? result.id : result.detail);
      if (result.ok) console.log('Invitation email sent.');
      else console.error('Invitation email failed:', result.detail);
    }
    const owner = process.env.OWNER_ALERT_EMAIL;
    if (owner) {
      const plan = planFor(planId)?.name || planId;
      const alert = await sendMail({ to: owner, subject: 'New HootOwl purchase',
        text: `New HootOwl purchase. Plan: ${plan}. Buyer: ${email}. Invitation email: ${outcome}.` });
      if (!alert.ok) console.error('Owner purchase alert failed:', alert.detail);
    }
    return { status };
  } catch (error) {
    console.error('Invitation email step failed:', error && error.name);
    return { status: 'failed' };
  }
}

module.exports = { notifyPurchase, buyerMessage };

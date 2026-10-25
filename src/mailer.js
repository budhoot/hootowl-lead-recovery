// Minimal transactional email over HTTPS (Resend). Inert until MAIL_API_KEY and MAIL_FROM are set. Never throws.
const ENDPOINT = 'https://api.resend.com/emails';

function isConfigured() {
  return Boolean(process.env.MAIL_API_KEY && process.env.MAIL_FROM);
}

// Returns { ok, id } on success or { ok: false, detail } on failure. The detail is a short code, never provider text.
async function sendMail({ to, subject, text }) {
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.MAIL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { ok: false, detail: `http_${response.status}` };
    let id = null;
    try { id = (await response.json()).id || null; } catch { /* the message was accepted either way */ }
    return { ok: true, id };
  } catch (error) {
    return { ok: false, detail: error && error.name === 'TimeoutError' ? 'timeout' : 'network_error' };
  }
}

module.exports = { isConfigured, sendMail };

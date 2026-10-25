require('dotenv').config({ quiet: true });

const express = require('express');
const http = require('node:http');
const twilioWebhooks = require('./routes/twilio');
const { attachVoiceAgent } = require('./voice-agent');

const app = express();
if (process.env.TRUST_PROXY === '1') app.set('trust proxy',1);
app.use(require('helmet')());
const port = process.env.PORT || 3000;

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use('/portal/api', require('./routes/customer'));
app.use('/portal', express.static(require('node:path').join(__dirname, 'customer-public'), { maxAge: 0 }));
app.use('/admin/customer-workspaces', require('./routes/customer-admin'));

app.use('/webhooks/twilio', twilioWebhooks);
app.use('/integrations/wix', require('./routes/wix'));
app.use('/operator/session', require('./routes/session'));
app.use('/operator', express.static(require('node:path').join(__dirname,'public')));
app.get('/',(req,res)=>res.redirect('/operator/'));
// Public marketing page embedded in the hootowl.net Wix site. It is the only page that may be framed, and only by
// HootOwl and Wix hosts; it loads nothing but inline styles and its embedded logo.
const marketingDir = require('node:path').join(__dirname, '..', 'marketing');
const LANDING_FRAME_ANCESTORS = "'self' https://www.hootowl.net https://hootowl.net https://*.wixsite.com https://*.wix.com https://*.filesusr.com https://*.parastorage.com";
app.get(['/landing', '/landing/'], (req, res) => {
  res.removeHeader('X-Frame-Options');
  res.set('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors ${LANDING_FRAME_ANCESTORS}`);
  res.set('Cache-Control', 'public, max-age=300');
  res.sendFile(require('node:path').join(marketingDir, 'hootowl-landing-embed.html'));
});
app.use('/landing', express.static(marketingDir, { index: false, maxAge: '1d' }));
app.get('/ready',async(req,res)=>{
 try { await require('./db').query('SELECT 1 FROM schema_migrations LIMIT 1');res.json({status:'ready'}); }
 catch { res.status(503).json({status:'unavailable'}); }
});
app.use('/admin', require('express-rate-limit').rateLimit({ windowMs: 60000, limit: 180 }));
app.use('/admin', require('./routes/admin'));
app.use((error, req, res, next) => {
  console.error('Request failed:', error.code || error.name);
  if (!res.headersSent) res.status(error.status === 400 ? 400 : 500).json({ error: 'Request could not be processed.' });
});

const server = http.createServer(app);
attachVoiceAgent(server);

if (require.main === module) {
  server.listen(port, process.env.HOST || '127.0.0.1', () => {
    console.log(`HootOwl Lead Recovery API listening on port ${port}`);
  });
}

module.exports = app;

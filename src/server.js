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

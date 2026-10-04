require('dotenv').config({ quiet: true });

const express = require('express');
const twilioWebhooks = require('./routes/twilio');

const app = express();
app.use(require('helmet')());
const port = process.env.PORT || 3000;

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use('/webhooks/twilio', twilioWebhooks);
app.use('/webhooks/twilio', require('./routes/sms'));
app.use('/admin', require('express-rate-limit').rateLimit({ windowMs: 60000, limit: 60 }));
app.use('/admin', require('./routes/admin'));
app.use((error, req, res, next) => {
  console.error('Request failed:', error.code || error.name);
  if (!res.headersSent) res.status(error.status === 400 ? 400 : 500).json({ error: 'Request could not be processed.' });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`HootOwl Lead Recovery API listening on port ${port}`);
  });
}

module.exports = app;

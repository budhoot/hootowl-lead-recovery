// Places a robot "customer" call to the HootOwl line, then saves the recording to local/.
// Usage: node scripts/test-call.js
require('dotenv').config({ quiet: true });

const fs = require('node:fs');
const path = require('node:path');
const twilio = require('twilio');

const HOOTOWL_NUMBER = '+19403405234';

// The robot customer's side of the call, in order. It cannot hear Cindy, so each
// step waits a fixed number of seconds (counted from the end of the previous step) before speaking.
const CONVERSATION = [
  // TODO(human)
];

function callerTwiml(steps) {
  const response = new twilio.twiml.VoiceResponse();
  for (const step of steps) {
    if (step.wait) response.pause({ length: step.wait });
    if (step.say) response.say({ voice: 'Polly.Joanna' }, step.say);
  }
  response.pause({ length: 8 });
  response.hangup();
  return response.toString();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (!CONVERSATION.length) throw new Error('Add at least one step to CONVERSATION first.');
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token } = process.env;
  const client = twilio(sid, token);
  const started = new Date(Date.now() - 5000);

  const call = await client.calls.create({ to: HOOTOWL_NUMBER, from: HOOTOWL_NUMBER, twiml: callerTwiml(CONVERSATION), timeout: 30 });
  console.log('Test call placed. Waiting for it to finish...');
  let status = call.status;
  while (!['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(status)) {
    await sleep(3000);
    status = (await client.calls(call.sid).fetch()).status;
  }
  console.log('Call ' + status + '.');

  const alerts = await client.monitor.v1.alerts.list({ startDate: started, limit: 5 });
  for (const alert of alerts) console.log('Twilio error ' + alert.errorCode + ': ' + decodeURIComponent(alert.alertText || '').replace(/\+/g, ' ').slice(0, 160));

  let recording;
  for (let i = 0; i < 10 && !recording; i += 1) {
    await sleep(3000);
    recording = (await client.recordings.list({ dateCreatedAfter: started, limit: 1 })).find((r) => r.status === 'completed');
  }
  if (!recording) return console.log('No recording yet; check the Twilio console in a minute.');

  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Recordings/${recording.sid}.mp3?RequestedChannels=1`;
  const audio = await fetch(url, { headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + token).toString('base64') } });
  const out = path.join(__dirname, '..', 'local', 'test-call-' + Date.now() + '.mp3');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(await audio.arrayBuffer()));
  console.log('Recording saved (' + recording.duration + 's): ' + out);
}

main().catch((error) => {
  console.error('Test call failed:', error.message);
  process.exitCode = 1;
});

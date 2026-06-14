/**
 * Check Twilio message status. Usage: node scripts/check_twilio_message.js [MessageSid]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(ENV_PATH);

const sid = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;
const msgSid = process.argv[2] || 'SM5c6475c53b5a8dcb96ade4eb5bf966e0';

if (!sid || !token) {
  console.error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set');
  process.exit(1);
}

const auth = Buffer.from(`${sid}:${token}`).toString('base64');

async function main() {
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages/${msgSid}.json`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  const data = await res.json();
  if (!res.ok) {
    console.error('API error', data);
    process.exit(1);
  }
  console.log('Message SID:', data.sid);
  console.log('Status:     ', data.status);
  console.log('To:         ', data.to);
  console.log('From:       ', data.from);
  console.log('Body:       ', (data.body || '').slice(0, 80));
  console.log('Error code: ', data.error_code || '(none)');
  console.log('Error msg:  ', data.error_message || '(none)');
  console.log('Date sent:  ', data.date_sent || '(not yet)');

  const acctRes = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}.json`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  const acct = await acctRes.json();
  console.log('Account type:', acct.type);
  console.log('TWILIO_FROM env:', process.env.TWILIO_FROM || '(not set)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Verify SendGrid + Twilio configuration and optionally send test messages.
 *
 * Usage:
 *   npm run test:notify              # config check only (no sends)
 *   npm run test:notify -- --send    # send test email/SMS to TEST_NOTIFY_* in .env
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
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
  return true;
}

function mask(value) {
  if (!value) return '(not set)';
  if (value.length <= 6) return '***';
  return `${value.slice(0, 3)}…${value.slice(-3)}`;
}

function printConfig(config) {
  console.log('\nHibret Edir — notification config\n');
  console.log('Email (SendGrid)');
  console.log(`  configured:  ${config.email.configured ? 'yes' : 'NO — set SENDGRID_API_KEY'}`);
  console.log(`  from:        ${config.email.from}`);
  console.log(`  reply-to:    ${config.email.replyTo}`);
  console.log(`  board:       ${config.email.boardRecipients.join(', ') || '(none)'}`);
  console.log('');
  console.log('SMS (Twilio)');
  console.log(`  configured:  ${config.sms.configured ? 'yes' : 'NO — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM'}`);
  console.log(`  from:        ${config.sms.from || '(not set — use E.164, e.g. +14245475594)'}`);
  console.log(`  board:       ${config.sms.boardRecipients.join(', ') || '(none)'}`);
  console.log('');
}

async function main() {
  const sendLive = process.argv.includes('--send');
  const hasEnv = loadEnvFile(ENV_PATH);
  if (!hasEnv) {
    console.warn('No .env file found — using process env only.');
    console.warn(`Copy .env.example → .env and fill in notification keys.\n`);
  }

  const { sendEmail, sendSms, getNotifyConfig } = require('../netlify/functions/notify');
  const config = getNotifyConfig();
  printConfig(config);

  if (!sendLive) {
    console.log('Dry run only. To send test messages:');
    console.log('  npm run test:notify -- --send');
    console.log('Set TEST_NOTIFY_EMAIL and TEST_NOTIFY_PHONE in .env for --send.\n');
    process.exit(config.email.configured || config.sms.configured ? 0 : 1);
  }

  const testEmail = process.env.TEST_NOTIFY_EMAIL;
  const testPhone = process.env.TEST_NOTIFY_PHONE;
  let failed = false;

  if (config.email.configured && testEmail) {
    console.log(`Sending test email → ${testEmail} …`);
    const r = await sendEmail({
      to: testEmail,
      subject: 'Hibret Edir — SendGrid test',
      text: [
        'This is a test message from scripts/test_notifications.js.',
        '',
        `SendGrid from: ${config.email.from}`,
        `Time: ${new Date().toISOString()}`,
      ].join('\n'),
    });
    console.log(r.ok ? '  ✓ Email sent' : `  ✗ Email failed: ${r.error || r.skipped || 'unknown'}`);
    if (!r.ok) failed = true;
  } else if (config.email.configured) {
    console.log('Skipping test email — set TEST_NOTIFY_EMAIL in .env');
  }

  if (config.sms.configured && testPhone) {
    console.log(`Sending test SMS → ${testPhone} …`);
    const r = await sendSms({
      to: testPhone,
      body: `Hibret Edir test SMS from notify.js (${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PT).`,
    });
    console.log(r.ok ? `  ✓ SMS sent${r.sid ? ` (${r.sid})` : ''}` : `  ✗ SMS failed: ${r.error || r.skipped || 'unknown'}`);
    if (!r.ok) failed = true;
  } else if (config.sms.configured) {
    console.log('Skipping test SMS — set TEST_NOTIFY_PHONE in .env');
  }

  console.log('');
  if (failed) process.exit(1);
  if (!config.email.configured && !config.sms.configured) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Run PayPal → PostgreSQL sync directly (no Netlify 30s limit).
 * Usage: node scripts/sync_paypal.js
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (key && process.env[key] == null) process.env[key] = value;
}

const { runPayPalSyncFullBatched } = require('../netlify/functions/paypal-sync.js');

runPayPalSyncFullBatched()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok === false ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

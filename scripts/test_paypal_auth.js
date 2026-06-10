const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
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
}

const clientId = process.env.PAYPAL_CLIENT_ID;
const secret = process.env.PAYPAL_SECRET;
const env = String(process.env.PAYPAL_ENV || '').toLowerCase();

if (!clientId || !secret) {
  console.error('Missing PAYPAL_CLIENT_ID or PAYPAL_SECRET in .env');
  process.exit(1);
}

const base = env === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';

async function main() {
  const authRes = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const authData = await authRes.json();
  if (!authData.access_token) {
    console.error('PayPal auth failed:', JSON.stringify(authData));
    process.exit(1);
  }
  console.log(`PayPal auth OK (${env})`);

  const invRes = await fetch(`${base}/v2/invoicing/invoices?page_size=5&total_count_required=true`, {
    headers: {
      Authorization: `Bearer ${authData.access_token}`,
      'Content-Type': 'application/json',
    },
  });
  const invData = await invRes.json();
  if (!invRes.ok) {
    console.error('Invoice fetch failed:', JSON.stringify(invData));
    process.exit(1);
  }
  const total = invData.total_count ?? invData.total_items ?? invData.items?.length ?? 0;
  console.log(`Invoices accessible: ${total} total (showing ${invData.items?.length || 0} on first page)`);
  if (invData.items?.[0]) {
    const inv = invData.items[0];
    const name = inv.primary_recipients?.[0]?.billing_info?.name?.full_name || '(no name)';
    console.log(`Sample: ${name} | ${inv.status} | $${inv.amount?.value || '0'}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

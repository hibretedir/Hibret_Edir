require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { loadLocalEnv, paypalApiBase } = require('../netlify/functions/paypal-env');

loadLocalEnv();

async function token() {
  const res = await fetch(`${paypalApiBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(JSON.stringify(data));
  return data.access_token;
}

async function main() {
  const access = await token();
  const base = paypalApiBase();
  const listRes = await fetch(`${base}/v2/invoicing/invoices?page=1&page_size=5&total_count_required=true`, {
    headers: { Authorization: `Bearer ${access}` },
  });
  const list = await listRes.json();
  const items = list.items || [];
  console.log('List count', items.length);

  for (const summary of items.slice(0, 3)) {
    const id = summary.id;
    const detailRes = await fetch(`${base}/v2/invoicing/invoices/${id}`, {
      headers: { Authorization: `Bearer ${access}` },
    });
    const inv = await detailRes.json();
    const itemLines = (inv.items || []).map((item) => ({
      name: item.name,
      description: item.description,
      quantity: item.quantity,
    }));
    console.log('\n--- Invoice', inv.detail?.invoice_number, inv.id, 'status', inv.status);
    console.log('items:', JSON.stringify(itemLines, null, 2));
    console.log('detail.note:', inv.detail?.note);
    console.log('detail.reference:', inv.detail?.reference);
    console.log('detail.memo:', inv.detail?.memo);
    console.log('primary_recipients name:', inv.primary_recipients?.[0]?.billing_info?.name?.full_name);
  }
}

main().catch(console.error);

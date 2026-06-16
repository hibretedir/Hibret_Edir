const path = require('path');
const fs = require('fs');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const eq = t.indexOf('=');
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null) process.env[k] = v;
  }
}
const { getDb } = require('../netlify/functions/db');

(async () => {
  const db = getDb();
  const wl = await db.query(`
    SELECT id, full_name, email, phone, status, spouse_name, applicant_role, primary_member_name, notes
    FROM waiting_list
    WHERE full_name ILIKE '%misrak%' OR full_name ILIKE '%yonas%'
       OR spouse_name ILIKE '%misrak%' OR spouse_name ILIKE '%yonas%'
       OR email ILIKE '%tesema%' OR email ILIKE '%demess%'
  `);
  console.log('waiting_list:', JSON.stringify(wl.rows, null, 2));

  const apps = await db.query(`
    SELECT ma.id, ma.waiting_list_id, ma.member_full_name, ma.spouse_full_name, ma.status,
           ma.member_id, ma.registration_fee_paid, ma.registration_invoice_id, ma.email, ma.cell_phone,
           ma.home_phone, ma.address, ma.city, ma.state, ma.zip
    FROM membership_applications ma
    WHERE ma.member_full_name ILIKE '%misrak%' OR ma.member_full_name ILIKE '%yonas%'
       OR ma.spouse_full_name ILIKE '%misrak%' OR ma.spouse_full_name ILIKE '%yonas%'
       OR ma.email ILIKE '%tesema%' OR ma.email ILIKE '%demess%'
  `);
  console.log('applications:', JSON.stringify(apps.rows, null, 2));

  const members = await db.query(`
    SELECT id, member_number, first_name, last_name, full_name, paypal_name, email, mobile, home_phone, status
    FROM members
    WHERE full_name ILIKE '%misrak%' OR full_name ILIKE '%yonas%'
       OR paypal_name ILIKE '%misrak%' OR paypal_name ILIKE '%yonas%'
       OR email ILIKE '%tesema%' OR email ILIKE '%demess%'
  `);
  console.log('members:', JSON.stringify(members.rows, null, 2));

  if (apps.rows[0]?.registration_invoice_id) {
    const inv = await db.query('SELECT * FROM invoices WHERE id = $1', [apps.rows[0].registration_invoice_id]);
    console.log('registration invoice:', JSON.stringify(inv.rows[0], null, 2));
  }

  const inv = await db.query(`
    SELECT id, invoice_number, status, amount, amount_due, member_id, recipient_name, payment_method, paid_date, paypal_invoice_id
    FROM invoices
    WHERE LOWER(COALESCE(recipient_name, '')) LIKE '%misrak%'
       OR LOWER(COALESCE(recipient_name, '')) LIKE '%demess%'
       OR LOWER(COALESCE(recipient_name, '')) LIKE '%tesema%'
    ORDER BY id DESC
  `);
  console.log('invoices:', JSON.stringify(inv.rows, null, 2));

  const cap = await db.query(`SELECT COUNT(*)::int AS active FROM members WHERE LOWER(status) = 'active'`);
  const max = await db.query('SELECT COALESCE(MAX(member_number), 0) + 1 AS n FROM members');
  console.log('active_count:', cap.rows[0], 'next_member_number:', max.rows[0]);

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

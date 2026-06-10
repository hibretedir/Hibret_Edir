require('dotenv').config();
const { getDb } = require('../netlify/functions/db');

async function invoicesForRecipient(db, pattern) {
  const r = await db.query(`
    SELECT DISTINCT ON (i.invoice_number)
      i.invoice_number, i.status, i.recipient_name, i.member_id,
      m.paypal_name, m.member_number,
      e.event_number, COALESCE(e.deceased_name,'') deceased_name
    FROM invoices i
    LEFT JOIN events e ON i.event_id = e.id
    LEFT JOIN members m ON i.member_id = m.id
    WHERE i.recipient_name ILIKE $1
    ORDER BY i.invoice_number DESC,
      (CASE WHEN i.event_id IS NOT NULL THEN 0 ELSE 1 END),
      i.updated_at DESC
  `, [pattern]);
  return r.rows;
}

async function main() {
  const db = getDb();

  const beh = await invoicesForRecipient(db, '%Behailu Aklilu%');
  const yig = await invoicesForRecipient(db, '%Yigzaw%');

  console.log(`Behailu Aklilu (by recipient_name): ${beh.length} invoices`);
  for (const r of beh.sort((a,b)=>(a.event_number||0)-(b.event_number||0)||a.invoice_number-b.invoice_number)) {
    console.log(`  #${r.event_number??'—'} ${r.deceased_name||'(early/unlinked)'} — inv #${r.invoice_number} ${r.status} [member: ${r.paypal_name}]`);
  }

  console.log(`\nYigzaw (by recipient_name): ${yig.length} invoices`);
  for (const r of yig.sort((a,b)=>(a.event_number||0)-(b.event_number||0)||a.invoice_number-b.invoice_number)) {
    console.log(`  #${r.event_number??'—'} ${r.deceased_name} — inv #${r.invoice_number} ${r.status} [member: ${r.paypal_name}]`);
  }

  const bEv = new Map();
  const yEv = new Map();
  for (const r of beh) {
    if (r.event_number) bEv.set(r.event_number, r);
    else bEv.set(`early-${r.invoice_number}`, r);
  }
  for (const r of yig) {
    if (r.event_number) yEv.set(r.event_number, r);
  }

  console.log('\n=== Yigzaw MISSING vs Behailu ===');
  for (const [key, r] of [...bEv.entries()].sort((a,b) => {
    const na = typeof a[0] === 'number' ? a[0] : 0;
    const nb = typeof b[0] === 'number' ? b[0] : 0;
    return na - nb;
  })) {
    if (!yEv.has(key)) {
      console.log(`  MISSING: Event #${r.event_number ?? '—'} ${r.deceased_name || 'early invoice #' + r.invoice_number} — Behailu inv #${r.invoice_number} ${r.status}`);
    }
  }

  // Event 22 anywhere in PayPal recipient data
  const ev22search = await db.query(`
    SELECT invoice_number, recipient_name, status,
      (SELECT event_number FROM events WHERE id = invoices.event_id) ev,
      (SELECT deceased_name FROM events WHERE id = invoices.event_id) deceased
    FROM invoices
    WHERE recipient_name ILIKE '%behailu%' OR recipient_name ILIKE '%yigzaw%'
    ORDER BY invoice_number
  `);
  const with22 = ev22search.rows.filter(r => String(r.deceased||'').includes('22') || r.ev === 22);
  console.log('\nAny event 22 refs:', with22);

  // All events 15-17 - who has them for these two
  for (const evNum of [15, 16, 17, 22]) {
    const q = await db.query(`
      SELECT m.paypal_name, m.member_number, i.invoice_number, i.recipient_name, e.deceased_name
      FROM events e
      JOIN invoices i ON i.event_id = e.id
      JOIN members m ON i.member_id = m.id
      WHERE e.event_number = $1
        AND (m.paypal_name ILIKE '%behailu%' OR m.paypal_name ILIKE '%yigzaw%'
             OR i.recipient_name ILIKE '%behailu%' OR i.recipient_name ILIKE '%yigzaw%')
    `, [evNum]);
    console.log(`\nEvent #${evNum}: ${q.rows.length} for Behailu/Yigzaw`);
    q.rows.forEach(r => console.log(`  ${r.paypal_name} inv #${r.invoice_number}`));
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

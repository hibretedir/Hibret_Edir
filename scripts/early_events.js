require('dotenv').config();
const { getDb } = require('../netlify/functions/db');

async function main() {
  const db = getDb();
  const r = await db.query(`
    SELECT e.event_number, e.deceased_name,
           MIN(i.sent_date) AS first_sent,
           COUNT(DISTINCT i.invoice_number)::int AS inv_count
    FROM events e
    LEFT JOIN invoices i ON i.event_id = e.id
    GROUP BY e.event_number, e.deceased_name
    ORDER BY e.event_number
  `);
  for (const row of r.rows) {
    console.log(`#${row.event_number} ${row.deceased_name} — first ${row.first_sent?.toISOString?.().slice(0,10)} — ${row.inv_count} invoices`);
  }

  const early = await db.query(`
    SELECT invoice_number, sent_date, recipient_name, status,
           (SELECT event_number FROM events WHERE id = invoices.event_id) ev
    FROM invoices
    WHERE invoice_number <= 50
    ORDER BY invoice_number
  `);
  console.log('\nInvoices #1-50:');
  for (const row of early.rows) {
    console.log(`  #${row.invoice_number} ${row.sent_date?.toISOString?.().slice(0,10)} ev=${row.ev??'—'} ${row.recipient_name} ${row.status}`);
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });

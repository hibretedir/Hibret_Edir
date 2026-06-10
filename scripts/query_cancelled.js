require('dotenv').config();
const { getDb } = require('../netlify/functions/db');

getDb().query(`
  SELECT invoice_number, status, paid_note, recipient_name, updated_at
  FROM invoices
  WHERE LOWER(COALESCE(status,'')) LIKE '%cancel%'
  ORDER BY invoice_number DESC
  LIMIT 30
`).then(r => {
  console.log('Cancelled in DB:', r.rows.length);
  console.log(JSON.stringify(r.rows, null, 2));
  return getDb().query(`
    SELECT invoice_number, status, paid_note, recipient_name
    FROM invoices
    WHERE LOWER(COALESCE(status,'')) = 'paid'
      AND (paid_note IS NOT NULL OR updated_at > NOW() - INTERVAL '6 hours')
    ORDER BY updated_at DESC
    LIMIT 20
  `);
}).then(r => {
  console.log('\nRecently marked Paid:');
  console.log(JSON.stringify(r.rows, null, 2));
  process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });

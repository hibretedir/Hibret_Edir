require('dotenv').config();
const { getDb } = require('../netlify/functions/db');
getDb().query(`
  SELECT invoice_number, status, paid_note, recipient_name, updated_at
  FROM invoices
  WHERE updated_at > NOW() - INTERVAL '12 hours'
    AND LOWER(COALESCE(status,'')) IN ('paid', 'cancelled')
  ORDER BY updated_at DESC
  LIMIT 50
`).then(r => {
  console.log(JSON.stringify(r.rows.filter(x =>
    x.paid_note || (x.status === 'Paid' && new Date(x.updated_at) > new Date('2026-06-10T05:45:00Z'))
  ), null, 2));
  process.exit(0);
});

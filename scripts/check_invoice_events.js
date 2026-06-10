require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /render\.com|neon\.tech|amazonaws\.com/i.test(process.env.DATABASE_URL || '')
      ? { rejectUnauthorized: false }
      : false,
  });
  const dup = await pool.query(`
    SELECT invoice_number, COUNT(*)::int AS c,
      COUNT(*) FILTER (WHERE event_id IS NOT NULL)::int AS with_event,
      COUNT(*) FILTER (WHERE paypal_invoice_id IS NOT NULL)::int AS with_paypal
    FROM invoices WHERE invoice_number IS NOT NULL
    GROUP BY invoice_number HAVING COUNT(*) > 1
    ORDER BY c DESC LIMIT 10
  `);
  const totals = await pool.query(`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE event_id IS NULL)::int AS no_event,
      COUNT(*) FILTER (WHERE paypal_invoice_id IS NOT NULL AND event_id IS NULL)::int AS paypal_no_event,
      COUNT(*) FILTER (WHERE paypal_invoice_id IS NOT NULL AND event_id IS NOT NULL)::int AS paypal_with_event,
      COUNT(*) FILTER (WHERE paypal_invoice_id IS NULL)::int AS no_paypal_id
    FROM invoices
  `);
  console.log('Totals:', totals.rows[0]);
  console.log('Duplicate invoice_number rows:', dup.rowCount, dup.rows.slice(0, 5));
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

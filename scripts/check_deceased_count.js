require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../netlify/functions/db');

(async () => {
  const db = getDb();
  const events = await db.query(
    `SELECT event_number, deceased_name, event_date
     FROM events
     WHERE deceased_name IS NOT NULL AND TRIM(deceased_name) <> ''
     ORDER BY event_number`
  );
  const linked = await db.query(
    `SELECT COUNT(DISTINCT event_id)::int AS distinct_events,
            COUNT(*)::int AS invoices,
            COUNT(event_id)::int AS with_event
     FROM invoices`
  );
  console.log('events in DB:', events.rows.length);
  console.log(events.rows);
  console.log('invoice link stats:', linked.rows[0]);
  await db.pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

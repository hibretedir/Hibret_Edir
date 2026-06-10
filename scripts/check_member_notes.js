require('dotenv').config();
const { getDb } = require('../netlify/functions/db');
getDb().query(`
  SELECT id, member_number, paypal_name, notes
  FROM members
  WHERE notes ILIKE '%marked paid%' OR notes ILIKE '%invoice #%'
  ORDER BY updated_at DESC
  LIMIT 15
`).then(r => {
  for (const row of r.rows) {
    console.log(`#${row.member_number} ${row.paypal_name}`);
    console.log(row.notes?.slice(-500));
    console.log('---');
  }
  process.exit(0);
});

require('dotenv').config();
const { getDb } = require('../netlify/functions/db');
getDb().query(`SELECT id, action, summary, created_at FROM audit_log ORDER BY id DESC LIMIT 25`)
  .then(r => { console.log(JSON.stringify(r.rows, null, 2)); process.exit(0); });

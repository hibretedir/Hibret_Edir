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
  const names = await db.query(`
    SELECT id, member_number, full_name, paypal_name, email, status
    FROM members
    WHERE full_name ILIKE '%sisay%' OR full_name ILIKE '%baheru%'
       OR full_name ILIKE '%worku%' OR full_name ILIKE '%seifu%'
       OR paypal_name ILIKE '%sisay%' OR paypal_name ILIKE '%baheru%'
       OR paypal_name ILIKE '%worku%' OR paypal_name ILIKE '%seifu%'
    ORDER BY member_number NULLS LAST, id
  `);
  console.log('matches:', JSON.stringify(names.rows, null, 2));

  const nums = await db.query(`
    SELECT id, member_number, full_name, paypal_name, email, joined_date, notes
    FROM members
    WHERE member_number IN (228, 229, 230, 231, 232, 233)
       OR id IN (439, 440, 660, 661, 662)
    ORDER BY member_number NULLS LAST, id
  `);
  console.log('numbers 228-233 + targets:', JSON.stringify(nums.rows, null, 2));

  const qa = await db.query(`
    SELECT id, member_number, full_name, email, status
    FROM members
    WHERE email ILIKE '%hibretedirtest%' OR full_name ILIKE '%QA Test%'
    ORDER BY id
  `);
  console.log('qa members:', JSON.stringify(qa.rows, null, 2));

  const max = await db.query('SELECT MAX(member_number)::int AS n FROM members');
  console.log('max member_number:', max.rows[0]);

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

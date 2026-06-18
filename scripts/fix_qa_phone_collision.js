/**
 * One-off: QA test members used the same phone as member #52 (Behailu).
 * Moves QA test phone off member #52's real mobile.
 *
 *   node scripts/fix_qa_phone_collision.js           # dry-run
 *   node scripts/fix_qa_phone_collision.js --apply
 */
require('dotenv').config();
const { Client } = require('pg');

const QA_EMAIL = 'hibretedirtest@gmail.com';
const QA_PHONE = '3105550199';

const apply = process.argv.includes('--apply');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL missing');
    process.exit(1);
  }
  const client = new Client({
    connectionString: url,
    ssl: url.includes('render.com') ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 15000,
  });
  await client.connect();

  const qa = await client.query(
    `SELECT id, member_number, full_name, email, mobile, pin_hash IS NOT NULL AS has_pin, created_at
     FROM members
     WHERE LOWER(email) = LOWER($1) OR full_name ILIKE '%QA Test%'
     ORDER BY id`,
    [QA_EMAIL]
  );
  console.log('QA rows before:', qa.rows);

  const dupes = qa.rows.filter((r) => !r.has_pin);

  for (const row of qa.rows) {
    if (row.mobile === QA_PHONE) continue;
    console.log(`${apply ? 'UPDATE' : 'WOULD UPDATE'} QA member id=${row.id} mobile → ${QA_PHONE}`);
    if (apply) {
      await client.query(
        `UPDATE members SET mobile = $1, updated_at = NOW() WHERE id = $2`,
        [QA_PHONE, row.id]
      );
    }
  }

  for (const row of dupes) {
    console.log(`Note: duplicate QA member id=${row.id} kept (may have linked invoices); phone moved off Behailu #52`);
  }

  const beh = await client.query(
    `SELECT id, member_number, first_name, full_name, mobile, pin_hash IS NOT NULL AS has_pin
     FROM members WHERE member_number = 52`
  );
  console.log('Member #52 after fix:', beh.rows[0]);

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

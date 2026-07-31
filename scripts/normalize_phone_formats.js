/**
 * Normalize US phone columns to xxx-xxx-xxxx (members + applications).
 */
require('dotenv').config();
const { Client } = require('pg');

function formatPhoneUS(value) {
  const d = String(value || '').replace(/\D/g, '');
  if (!d) return null;
  const ten = d.length > 10 ? d.slice(-10) : d;
  if (ten.length !== 10) return String(value).trim() || null;
  return `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`;
}

(async () => {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 20000,
    ssl: process.env.DATABASE_URL?.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const members = await client.query(
      `SELECT id, mobile, home_phone FROM members
       WHERE mobile IS NOT NULL OR home_phone IS NOT NULL`
    );
    let mUpdated = 0;
    for (const row of members.rows) {
      const mobile = formatPhoneUS(row.mobile);
      const home = formatPhoneUS(row.home_phone);
      if (mobile === row.mobile && home === row.home_phone) continue;
      if ((mobile || null) === (row.mobile || null) && (home || null) === (row.home_phone || null)) continue;
      await client.query(
        `UPDATE members SET mobile = COALESCE($1, mobile), home_phone = COALESCE($2, home_phone), updated_at = NOW()
         WHERE id = $3`,
        [mobile, home, row.id]
      );
      mUpdated += 1;
    }

    const apps = await client.query(
      `SELECT id, cell_phone, home_phone, office_phone, member_full_name, spouse_full_name
       FROM membership_applications`
    );
    let aUpdated = 0;
    for (const row of apps.rows) {
      const cell = formatPhoneUS(row.cell_phone);
      const home = formatPhoneUS(row.home_phone);
      const office = formatPhoneUS(row.office_phone);
      let spouse = row.spouse_full_name;
      const full = String(row.member_full_name || '');
      if (!String(spouse || '').trim() && full.includes('/')) {
        const parts = full.split('/').map((p) => p.trim()).filter(Boolean);
        if (parts.length >= 2) spouse = parts.slice(1).join(' / ');
      }
      const samePhones =
        (cell || null) === (row.cell_phone || null)
        && (home || null) === (row.home_phone || null)
        && (office || null) === (row.office_phone || null);
      const sameSpouse = (spouse || null) === (row.spouse_full_name || null);
      if (samePhones && sameSpouse) continue;
      await client.query(
        `UPDATE membership_applications
         SET cell_phone = COALESCE($1, cell_phone),
             home_phone = COALESCE($2, home_phone),
             office_phone = COALESCE($3, office_phone),
             spouse_full_name = COALESCE($4, spouse_full_name)
         WHERE id = $5`,
        [cell, home, office, spouse, row.id]
      );
      aUpdated += 1;
    }

    console.log({ membersUpdated: mUpdated, applicationsUpdated: aUpdated });
  } finally {
    await client.end();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

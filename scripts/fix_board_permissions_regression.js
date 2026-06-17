/**
 * One-off: clear legacy write_approved and reset granular perms elevated by schema re-migrate.
 * Usage: node scripts/fix_board_permissions_regression.js
 */
require('dotenv').config();
const { getDb } = require('../netlify/functions/db');

async function main() {
  const db = getDb();
  const before = await db.query(`
    SELECT email, write_approved, perm_full_access, perm_notes,
           perm_approve_operations, perm_approve_payout
    FROM board_members
    WHERE write_approved = TRUE AND NOT is_super_admin
    ORDER BY email
  `);
  if (before.rows.length) {
    console.log('Resetting elevated rows (legacy write_approved):');
    console.table(before.rows);
    await db.query(`
      UPDATE board_members
      SET write_approved = FALSE,
          perm_full_access = FALSE,
          perm_approve_payout = FALSE,
          perm_approve_operations = FALSE
      WHERE NOT is_super_admin AND write_approved = TRUE
    `);
  } else {
    console.log('No rows with write_approved=TRUE (non-super-admin).');
  }
  const after = await db.query(`
    SELECT email, write_approved, perm_full_access, perm_notes,
           perm_approve_operations, perm_approve_payout, is_super_admin
    FROM board_members
    ORDER BY id
  `);
  console.log('Current board permissions:');
  console.table(after.rows);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

/**
 * Link board_members to CRM members (member_id only) and merge login email aliases.
 * Never writes to the members (CRM) table.
 *
 * Roster is keyed by CRM member_number — no super-admin emails in source (Netlify secrets scan).
 * display_name is set from the roster only when empty — Access Management edits are kept.
 *
 * Usage:
 *   node scripts/sync_board_member_names.js           # dry-run
 *   node scripts/sync_board_member_names.js --apply   # write updates
 *   node scripts/sync_board_member_names.js --apply --force-names  # reset board display names from roster
 */
require('dotenv').config();
const { Client } = require('pg');

/** CRM member_number → board display name (no spouse names). */
const BOARD_ROSTER = [
  { member_number: 1, display_name: 'Alemu Biru' },
  { member_number: 6, display_name: 'Betelhem Mulugeta', aliases: ['lily_mulugeta@yahoo.com', 'babimuli@yahoo.com'] },
  { member_number: 14, display_name: 'Elizabeth Teshome' },
  { member_number: 66, display_name: 'Emebeth Hibret Edir' },
  { member_number: 96, display_name: 'Genene Hibret Edir', aliases: ['lulsegedge@gmail.com'] },
  { member_number: 11, display_name: 'Tsehaye Mogus', role: 'advisor', aliases: ['tsehay@usc.edu'] },
  { member_number: 52, display_name: 'Behailu Aklilu' },
];

const apply = process.argv.includes('--apply');
const forceNames = process.argv.includes('--force-names');

function normEmail(email) {
  return String(email || '').trim().toLowerCase();
}

async function findBoardForMemberNumber(client, memberNumber) {
  const linked = await client.query(
    `SELECT bm.id, bm.email, bm.display_name, bm.member_id
     FROM board_members bm
     JOIN members m ON m.id = bm.member_id
     WHERE m.member_number = $1
     LIMIT 1`,
    [memberNumber]
  );
  if (linked.rows[0]) return linked.rows[0];

  const byPrimaryEmail = await client.query(
    `SELECT bm.id, bm.email, bm.display_name, bm.member_id
     FROM board_members bm
     WHERE LOWER(bm.email) IN (
       SELECT LOWER(email) FROM members WHERE member_number = $1 AND email IS NOT NULL AND TRIM(email) <> ''
     )
     LIMIT 1`,
    [memberNumber]
  );
  if (byPrimaryEmail.rows[0]) return byPrimaryEmail.rows[0];

  const byAliasEmail = await client.query(
    `SELECT bm.id, bm.email, bm.display_name, bm.member_id
     FROM board_members bm
     JOIN board_member_emails bme ON bme.board_member_id = bm.id
     WHERE LOWER(bme.email) IN (
       SELECT LOWER(email) FROM members WHERE member_number = $1 AND email IS NOT NULL AND TRIM(email) <> ''
     )
     LIMIT 1`,
    [memberNumber]
  );
  return byAliasEmail.rows[0] || null;
}

async function ensureEmailAlias(client, boardMemberId, email, { isPrimary = false } = {}) {
  const norm = normEmail(email);
  if (!norm) return;
  if (apply) {
    await client.query(
      `INSERT INTO board_member_emails (board_member_id, email, is_primary)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE
       SET board_member_id = EXCLUDED.board_member_id,
           is_primary = EXCLUDED.is_primary`,
      [boardMemberId, norm, isPrimary]
    );
  } else {
    console.log(`  ${isPrimary ? 'PRIMARY' : 'ALIAS'} ${norm} → board#${boardMemberId}`);
  }
}

async function mergeDuplicateBoardAccount(client, primaryId, aliasEmail) {
  const norm = normEmail(aliasEmail);
  if (!norm) return;
  const dupRes = await client.query(
    `SELECT id, email FROM board_members WHERE LOWER(email) = $1 AND id <> $2 LIMIT 1`,
    [norm, primaryId]
  );
  const dup = dupRes.rows[0];
  if (!dup) {
    await ensureEmailAlias(client, primaryId, norm, { isPrimary: false });
    return;
  }
  console.log(`${apply ? 'MERGE' : 'WOULD MERGE'} board#${dup.id} into board#${primaryId} as alias`);
  if (!apply) {
    await ensureEmailAlias(client, primaryId, norm, { isPrimary: false });
    return;
  }
  await ensureEmailAlias(client, primaryId, norm, { isPrimary: false });
  await client.query(`UPDATE audit_log SET board_member_id = $1 WHERE board_member_id = $2`, [primaryId, dup.id]);
  await client.query(`DELETE FROM board_member_emails WHERE board_member_id = $1`, [dup.id]);
  await client.query(`DELETE FROM board_members WHERE id = $1`, [dup.id]);
}

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

  let updated = 0;
  for (const entry of BOARD_ROSTER) {
    const mRes = await client.query(
      `SELECT id, member_number, full_name, email FROM members WHERE member_number = $1 LIMIT 1`,
      [entry.member_number]
    );
    const member = mRes.rows[0];
    if (!member) {
      console.warn(`CRM member #${entry.member_number} not found`);
      continue;
    }
    const board = await findBoardForMemberNumber(client, entry.member_number);
    if (!board) {
      console.warn(`Board login not found for CRM #${entry.member_number} (${entry.display_name})`);
      continue;
    }
    const displayName = String(entry.display_name || '').trim();
    const hasDisplayName = !!String(board.display_name || '').trim();
    const needsLink = Number(board.member_id) !== Number(member.id);
    const needsDisplayName = forceNames
      ? board.display_name !== displayName
      : !hasDisplayName && !!displayName;
    const needsRole = entry.role && board.role !== entry.role;
    const needs = needsLink || needsDisplayName || needsRole;
    if (needs) {
      const action = [
        needsLink ? 'link' : null,
        needsDisplayName ? (forceNames ? 'rename' : 'seed name') : null,
        needsRole ? `role=${entry.role}` : null,
      ].filter(Boolean).join(' + ');
      console.log(`${apply ? 'UPDATE' : 'WOULD'} (${action}) #${member.member_number} → board#${board.id}${needsDisplayName ? ` name="${displayName}"` : ''}`);
      if (apply) {
        await client.query(
          `UPDATE board_members
           SET member_id = $1,
               display_name = CASE WHEN $2::boolean THEN $3 ELSE display_name END,
               role = COALESCE($4, role)
           WHERE id = $5`,
          [
            member.id,
            needsDisplayName,
            displayName,
            needsRole ? entry.role : null,
            board.id,
          ]
        );
        updated += 1;
      }
    } else {
      console.log(`OK  #${member.member_number} → board#${board.id}${hasDisplayName ? ` (display: ${board.display_name})` : ''}`);
    }

    const primaryEmail = normEmail(board.email) || normEmail(member.email);
    if (primaryEmail) {
      await ensureEmailAlias(client, board.id, primaryEmail, { isPrimary: true });
    }
    for (const alias of entry.aliases || []) {
      await mergeDuplicateBoardAccount(client, board.id, alias);
    }
  }

  if (apply) {
    console.log(`\nDone. Updated ${updated} board member name/link(s).`);
  } else {
    console.log('\nDry run — pass --apply to write changes.');
  }

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

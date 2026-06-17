/**
 * Link board_members to CRM members (member_id only) and merge login email aliases.
 * Never writes to the members (CRM) table.
 *
 * display_name is set from the roster only when empty — Access Management edits are kept.
 *
 * Usage:
 *   node scripts/sync_board_member_names.js           # dry-run
 *   node scripts/sync_board_member_names.js --apply   # write updates
 *   node scripts/sync_board_member_names.js --apply --force-names  # reset board display names from roster
 */
require('dotenv').config();
const { Client } = require('pg');

/** Primary login email → CRM member_number + board display name (no spouse names). */
const BOARD_ROSTER = [
  { email: 'afbiru9@gmail.com', member_number: 1, display_name: 'Alemu Biru' },
  { email: 'babimuli@gmail.com', member_number: 6, display_name: 'Betelhem Mulugeta', aliases: ['lily_mulugeta@yahoo.com', 'babimuli@yahoo.com'] },
  { email: 'eteshome@ucla.edu', member_number: 14, display_name: 'Elizabeth Teshome' },
  { email: 'emebetb@aol.com', member_number: 66, display_name: 'Emebeth Hibret Edir' },
  { email: 'lulsegedg@sbcglobal.net', member_number: 96, display_name: 'Genene Hibret Edir', aliases: ['lulsegedge@gmail.com'] },
  { email: 'emugela5@yahoo.com', member_number: 11, display_name: 'Tsehaye Mogus', role: 'advisor', aliases: ['tsehay@usc.edu'] },
  { email: 'jaklilu@gmail.com', member_number: 52, display_name: 'Behailu Aklilu' },
];

const apply = process.argv.includes('--apply');
const forceNames = process.argv.includes('--force-names');

function normEmail(email) {
  return String(email || '').trim().toLowerCase();
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
  console.log(`${apply ? 'MERGE' : 'WOULD MERGE'} board#${dup.id} ${dup.email} into board#${primaryId} as alias`);
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
    const email = normEmail(entry.email);
    const mRes = await client.query(
      `SELECT id, member_number, full_name FROM members WHERE member_number = $1 LIMIT 1`,
      [entry.member_number]
    );
    const member = mRes.rows[0];
    if (!member) {
      console.warn(`CRM member #${entry.member_number} not found`);
      continue;
    }
    const bRes = await client.query(
      `SELECT id, email, display_name, member_id FROM board_members WHERE LOWER(email) = $1 LIMIT 1`,
      [email]
    );
    const board = bRes.rows[0];
    if (!board) {
      console.warn(`Board login not found for ${email} (${entry.display_name})`);
      continue;
    }
    const displayName = String(entry.display_name || '').trim();
    const hasDisplayName = !!String(board.display_name || '').trim();
    const needsLink = Number(board.member_id) !== Number(member.id);
    const needsDisplayName = forceNames
      ? board.display_name !== displayName
      : !hasDisplayName && !!displayName;
    const needs = needsLink || needsDisplayName;
    if (needs) {
      const action = [
        needsLink ? 'link' : null,
        needsDisplayName ? (forceNames ? 'rename' : 'seed name') : null,
      ].filter(Boolean).join(' + ');
      console.log(`${apply ? 'UPDATE' : 'WOULD'} (${action}) #${member.member_number} → board#${board.id} ${board.email}${needsDisplayName ? ` name="${displayName}"` : ''}`);
      if (apply) {
        if (needsDisplayName) {
          await client.query(
            `UPDATE board_members SET member_id = $1, display_name = $2 WHERE id = $3`,
            [member.id, displayName, board.id]
          );
        } else {
          await client.query(
            `UPDATE board_members SET member_id = $1 WHERE id = $2`,
            [member.id, board.id]
          );
        }
        updated += 1;
      }
    } else {
      console.log(`OK  #${member.member_number} → ${board.email}${hasDisplayName ? ` (display: ${board.display_name})` : ''}`);
    }

    await ensureEmailAlias(client, board.id, email, { isPrimary: true });
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

/**
 * Assign member numbers: Sisay Baheru #230, Worku Seifu #231.
 * Frees numbers from stale inactive QA test rows if needed.
 *
 * Usage:
 *   node scripts/fix_sisay_worku_member_numbers.js
 *   node scripts/fix_sisay_worku_member_numbers.js --apply
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const APPLY = process.argv.includes('--apply');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(ENV_PATH);

const TARGETS = [
  { id: 439, name: 'Sisay Baheru', member_number: 230 },
  { id: 440, name: 'Worku Seifu', member_number: 231 },
];

const { getDb } = require('../netlify/functions/db');
const { logActivity } = require('../netlify/functions/audit');

async function main() {
  const db = getDb();
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    for (const target of TARGETS) {
      const row = await client.query(
        'SELECT id, full_name, member_number, email FROM members WHERE id = $1',
        [target.id]
      );
      if (!row.rows.length) {
        throw new Error(`Member id ${target.id} (${target.name}) not found`);
      }
      const member = row.rows[0];

      const conflict = await client.query(
        `SELECT id, full_name, email, status FROM members
         WHERE member_number = $1 AND id <> $2`,
        [target.member_number, target.id]
      );

      for (const other of conflict.rows) {
        const isQaStale = String(other.email || '').toLowerCase() === 'hibretedirtest@gmail.com'
          || String(other.full_name || '').includes('QA Test');
        if (!isQaStale) {
          throw new Error(
            `Member #${target.member_number} is held by ${other.full_name} (id ${other.id}) — not a QA row`
          );
        }
        console.log(`Clearing #${target.member_number} from stale QA member id=${other.id}`);
        if (APPLY) {
          await client.query(
            `UPDATE members SET member_number = NULL, updated_at = NOW() WHERE id = $1`,
            [other.id]
          );
        }
      }

      console.log(
        `${member.full_name}: ${member.member_number ?? 'null'} -> #${target.member_number}`
      );
      if (APPLY) {
        await client.query(
          `UPDATE members
           SET member_number = $2,
               notes = TRIM(BOTH FROM COALESCE(notes, '') || $3),
               updated_at = NOW()
           WHERE id = $1`,
          [
            target.id,
            target.member_number,
            `\n[Board] Member number set to #${target.member_number}.`,
          ]
        );
      }
    }

    if (!APPLY) {
      await client.query('ROLLBACK');
      console.log('\nDry run — re-run with --apply to commit.');
      return;
    }

    await client.query('COMMIT');

    await logActivity(db, {
      actor_type: 'board',
      actor_label: 'Board CRM fix',
      action: 'member.number_fix',
      entity_type: 'members',
      table_name: 'members',
      summary: 'Assigned member #230 (Sisay Baheru) and #231 (Worku Seifu)',
      new_value: { sisay_id: 439, worku_id: 440, cleared_qa_ids: [660, 661] },
    });

    const verify = await db.query(
      `SELECT id, member_number, full_name, email, status
       FROM members
       WHERE id IN (439, 440, 660, 661, 662)
       ORDER BY member_number NULLS LAST, id`
    );
    console.log('\nDone:', JSON.stringify(verify.rows, null, 2));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

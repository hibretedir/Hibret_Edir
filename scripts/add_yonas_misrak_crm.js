/**
 * Add Yonas Tesema (primary) & Misrak B. Demessie (spouse) to CRM.
 * Board verified registration fee paid; keep misrak1940@gmail.com.
 *
 * Usage:
 *   node scripts/add_yonas_misrak_crm.js           # dry run
 *   node scripts/add_yonas_misrak_crm.js --apply   # execute
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

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

const APPLY = process.argv.includes('--apply');
const WL_ID = 12;
const EMAIL = 'misrak1940@gmail.com';
const YONAS_MOBILE = '310-261-8119';
const MISRAK_PHONE = '310-508-0854';
const HOUSEHOLD_NAME = 'Yonas Tesema/Misrak B. Demessie';

const { getDb } = require('../netlify/functions/db');
const { completeMembershipFromApplication } = require('../netlify/functions/membership-completion');
const { logActivity } = require('../netlify/functions/audit');

function normalizePhone(value) {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 10) return value || null;
  const last10 = digits.slice(-10);
  return `${last10.slice(0, 3)}-${last10.slice(3, 6)}-${last10.slice(6)}`;
}

async function main() {
  const db = getDb();
  const client = await db.connect();
  let applicationId;

  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id, member_number, full_name FROM members WHERE LOWER(email) = LOWER($1)`,
      [EMAIL]
    );
    if (existing.rows.length) {
      console.log('Member already exists:', existing.rows[0]);
      await client.query('ROLLBACK');
      return;
    }

    const wl = await client.query(`SELECT * FROM waiting_list WHERE id = $1`, [WL_ID]);
    if (!wl.rows.length) {
      throw new Error(`waiting_list id ${WL_ID} not found`);
    }
    console.log('Waiting list:', wl.rows[0].full_name, wl.rows[0].status);

    let appRes = await client.query(
      `SELECT id, status, member_id FROM membership_applications WHERE waiting_list_id = $1`,
      [WL_ID]
    );

    if (!appRes.rows.length) {
      const checklist = {
        name_match: true,
        fields_complete: true,
        id_uploaded: true,
        fee_paid: true,
      };
      const inserted = await client.query(
        `INSERT INTO membership_applications (
          waiting_list_id, member_full_name, spouse_full_name, email,
          cell_phone, home_phone, applicant_role, status, notes, review_checklist,
          registration_fee_paid
        ) VALUES ($1, $2, $3, $4, $5, $6, 'primary', 'Awaiting Payment', $7, $8::jsonb, TRUE)
        RETURNING id`,
        [
          WL_ID,
          'Yonas Tesema',
          'Misrak B. Demessie',
          EMAIL,
          normalizePhone(YONAS_MOBILE),
          normalizePhone(MISRAK_PHONE),
          'Board-added to CRM — registration fee paid (Misrak B. Demessie on waiting list).',
          JSON.stringify(checklist),
        ]
      );
      applicationId = inserted.rows[0].id;
      console.log('Created membership_application id', applicationId);
    } else {
      applicationId = appRes.rows[0].id;
      if (appRes.rows[0].member_id) {
        console.log('Application already linked to member', appRes.rows[0].member_id);
        await client.query('ROLLBACK');
        return;
      }
      await client.query(
        `UPDATE membership_applications
         SET member_full_name = $2,
             spouse_full_name = $3,
             email = $4,
             cell_phone = $5,
             home_phone = $6,
             status = 'Awaiting Payment',
             registration_fee_paid = TRUE,
             review_checklist = $7::jsonb
         WHERE id = $1`,
        [
          applicationId,
          'Yonas Tesema',
          'Misrak B. Demessie',
          EMAIL,
          normalizePhone(YONAS_MOBILE),
          normalizePhone(MISRAK_PHONE),
          JSON.stringify({
            name_match: true,
            fields_complete: true,
            id_uploaded: true,
            fee_paid: true,
          }),
        ]
      );
      console.log('Updated membership_application id', applicationId);
    }

    if (!APPLY) {
      await client.query('ROLLBACK');
      console.log('\nDry run — re-run with --apply to commit.');
      return;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const actor = {
    actor_type: 'board',
    actor_label: 'Board CRM import',
  };

  const result = await completeMembershipFromApplication(db, applicationId, actor, {
    paymentMethod: 'PayPal',
    paymentReference: 'board-verified-registration',
    source: 'Board CRM import',
    force: true,
  });

  if (!result.ok) {
    throw new Error(`Completion failed: ${result.reason || 'unknown'}`);
  }

  const memberId = result.member.id;

  await db.query(
    `UPDATE members
     SET full_name = $2,
         paypal_name = 'Yonas Tesema',
         mobile = $3,
         home_phone = $4,
         notes = COALESCE(notes, '') || $5
     WHERE id = $1`,
    [
      memberId,
      HOUSEHOLD_NAME,
      normalizePhone(YONAS_MOBILE),
      normalizePhone(MISRAK_PHONE),
      ' Primary: Yonas Tesema. Spouse: Misrak B. Demessie. Registration fee paid (board verified).',
    ]
  );

  await db.query(
    `UPDATE waiting_list
     SET spouse_name = 'Yonas Tesema',
         notes = COALESCE(notes || ' ', '') || 'Household primary Yonas Tesema; spouse Misrak B. Demessie.'
     WHERE id = $1`,
    [WL_ID]
  );

  await logActivity(db, {
    ...actor,
    member_id: memberId,
    action: 'member.import',
    entity_type: 'members',
    table_name: 'members',
    record_id: memberId,
    new_value: {
      full_name: HOUSEHOLD_NAME,
      email: EMAIL,
      member_number: result.member.member_number,
    },
    summary: `Board import — ${HOUSEHOLD_NAME} added as member #${result.member.member_number}`,
  });

  const final = await db.query(
    `SELECT id, member_number, full_name, paypal_name, email, mobile, home_phone, status
     FROM members WHERE id = $1`,
    [memberId]
  );
  console.log('\nDone:', JSON.stringify(final.rows[0], null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

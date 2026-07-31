/**
 * Add Sara Mesfin (#13) and Tedjitou Dessalegn (#14) to CRM.
 * Paper applications + registration fee already paid (board verified).
 * Spouse / extra details can be edited later in Members CRM.
 *
 * Usage:
 *   node scripts/add_sara_tedjitou_crm.js           # dry run
 *   node scripts/add_sara_tedjitou_crm.js --apply   # execute
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

const ENTRIES = [
  {
    waitingListId: 13,
    fullName: 'Sara Mesfin',
    email: 'sherisarina@gmail.com',
    mobile: '(310) 309-7166',
  },
  {
    waitingListId: 14,
    fullName: 'Tedjitou Dessalegn',
    email: 'tedjitou@aol.com',
    mobile: '(310) 940-5538',
  },
];

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

async function ensureApplication(client, entry, wl) {
  const existingMember = await client.query(
    `SELECT id, member_number, full_name, status FROM members WHERE LOWER(email) = LOWER($1)`,
    [entry.email]
  );
  if (existingMember.rows.length) {
    return { skipped: true, reason: 'member_exists', member: existingMember.rows[0] };
  }

  let appRes = await client.query(
    `SELECT id, status, member_id FROM membership_applications WHERE waiting_list_id = $1`,
    [entry.waitingListId]
  );

  const checklist = {
    name_match: true,
    fields_complete: true,
    id_uploaded: true,
    fee_paid: true,
  };
  const note = 'Board-added to CRM — paper application + registration fee paid (board verified). Spouse/details to be completed in Members CRM.';
  const mobile = normalizePhone(entry.mobile || wl.phone);

  if (!appRes.rows.length) {
    const inserted = await client.query(
      `INSERT INTO membership_applications (
        waiting_list_id, member_full_name, email,
        cell_phone, home_phone, address, applicant_role, status, notes, review_checklist,
        registration_fee_paid
      ) VALUES ($1, $2, $3, $4, $5, $6, 'primary', 'Awaiting Payment', $7, $8::jsonb, TRUE)
      RETURNING id`,
      [
        entry.waitingListId,
        entry.fullName,
        entry.email,
        mobile,
        null,
        wl.address || null,
        note,
        JSON.stringify(checklist),
      ]
    );
    return { applicationId: inserted.rows[0].id, created: true };
  }

  const app = appRes.rows[0];
  if (app.member_id) {
    return { skipped: true, reason: 'application_linked', member_id: app.member_id, applicationId: app.id };
  }

  await client.query(
    `UPDATE membership_applications
     SET member_full_name = $2,
         email = $3,
         cell_phone = COALESCE($4, cell_phone),
         address = COALESCE($5, address),
         status = 'Awaiting Payment',
         registration_fee_paid = TRUE,
         review_checklist = $6::jsonb,
         notes = TRIM(BOTH FROM COALESCE(notes, '') || E'\n' || $7)
     WHERE id = $1`,
    [
      app.id,
      entry.fullName,
      entry.email,
      mobile,
      wl.address || null,
      JSON.stringify(checklist),
      note,
    ]
  );
  return { applicationId: app.id, created: false };
}

async function processEntry(entry) {
  const db = getDb();
  const client = await db.connect();
  let applicationId;

  try {
    await client.query('BEGIN');

    const wlRes = await client.query(`SELECT * FROM waiting_list WHERE id = $1`, [entry.waitingListId]);
    if (!wlRes.rows.length) {
      throw new Error(`waiting_list id ${entry.waitingListId} not found`);
    }
    const wl = wlRes.rows[0];
    console.log(`\n=== ${entry.fullName} (waiting_list #${entry.waitingListId}, status=${wl.status}) ===`);

    const prepared = await ensureApplication(client, entry, wl);
    if (prepared.skipped) {
      console.log('Skip:', prepared.reason, prepared.member || prepared.member_id);
      await client.query('ROLLBACK');
      return prepared;
    }

    applicationId = prepared.applicationId;
    console.log(prepared.created ? 'Created' : 'Updated', 'membership_application id', applicationId);

    if (!APPLY) {
      await client.query('ROLLBACK');
      console.log('Dry run — no changes committed.');
      return { dryRun: true, applicationId };
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
    paymentMethod: 'Board verified',
    paymentReference: 'board-verified-registration-paper-app',
    source: 'Board CRM import',
    force: true,
  });

  if (!result.ok) {
    throw new Error(`Completion failed for ${entry.fullName}: ${result.reason || 'unknown'}`);
  }

  await logActivity(db, {
    ...actor,
    member_id: result.member.id,
    action: 'member.import',
    entity_type: 'members',
    table_name: 'members',
    record_id: result.member.id,
    new_value: {
      full_name: entry.fullName,
      email: entry.email,
      member_number: result.member.member_number,
      waiting_list_id: entry.waitingListId,
    },
    summary: `Board import — ${entry.fullName} added as member #${result.member.member_number} (paper app, fee paid)`,
  });

  console.log('Done:', {
    id: result.member.id,
    member_number: result.member.member_number,
    full_name: result.member.full_name,
    email: result.member.email,
    mobile: result.member.mobile,
    status: result.member.status,
  });

  return { ok: true, member: result.member };
}

async function main() {
  console.log(APPLY ? 'APPLY mode — writing to database' : 'DRY RUN — no writes');
  const results = [];
  for (const entry of ENTRIES) {
    results.push(await processEntry(entry));
  }

  if (!APPLY) {
    console.log('\nRe-run with --apply to commit both members.');
  } else {
    const db = getDb();
    const check = await db.query(
      `SELECT m.member_number, m.full_name, m.email, m.mobile, m.status, wl.status AS wl_status
       FROM members m
       LEFT JOIN waiting_list wl ON LOWER(wl.email) = LOWER(m.email)
       WHERE LOWER(m.email) IN ('sherisarina@gmail.com', 'tedjitou@aol.com')
       ORDER BY m.member_number`
    );
    console.log('\nVerification:');
    console.log(JSON.stringify(check.rows, null, 2));
  }

  await getDb().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

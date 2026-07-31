/**
 * Create active member from a vetted membership application (after registration payment).
 */

const { invalidateInvoiceStatsCache } = require('./invoice-stats-cache');
const { notifyApplicationApproved } = require('./notify');
const { syncApplicationApproved } = require('./sync');
const { logActivity } = require('./audit');

function getRegistrationFee() {
  const raw = process.env.REGISTRATION_FEE;
  const n = raw != null && raw !== '' ? Number(raw) : 200;
  return Number.isFinite(n) && n > 0 ? n : 200;
}

const REGISTRATION_FEE = getRegistrationFee();

function parseJsonField(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function splitMemberName(full) {
  const text = String(full || '').trim();
  if (!text) return { first_name: 'Member', last_name: 'Unknown', full_name: 'Member Unknown' };
  const parts = text.split(/\s+/);
  if (parts.length === 1) {
    return { first_name: parts[0], last_name: parts[0], full_name: parts[0] };
  }
  return {
    first_name: parts[0],
    last_name: parts.slice(1).join(' '),
    full_name: text,
  };
}

function formatAddress(app) {
  const parts = [app.address, app.city, app.state, app.zip].filter((p) => String(p || '').trim());
  return parts.join(', ') || app.wl_address || null;
}

async function fetchApplicationForCompletion(db, applicationId) {
  const result = await db.query(
    `SELECT ma.*,
      wl.full_name AS wl_full_name,
      wl.email AS wl_email,
      wl.phone AS wl_phone,
      wl.address AS wl_address,
      wl.status AS wl_status
     FROM membership_applications ma
     JOIN waiting_list wl ON wl.id = ma.waiting_list_id
     WHERE ma.id = $1
     LIMIT 1`,
    [applicationId]
  );
  return result.rows[0] || null;
}

/**
 * @returns {{ ok: boolean, member?: object, skipped?: boolean, reason?: string }}
 */
async function completeMembershipFromApplication(db, applicationId, actor, options = {}) {
  const row = await fetchApplicationForCompletion(db, applicationId);
  if (!row) {
    return { ok: false, reason: 'not_found' };
  }
  if (row.status === 'Approved' && row.member_id) {
    return { ok: true, skipped: true, reason: 'already_approved', member_id: row.member_id };
  }
  if (!['Awaiting Payment', 'Approved'].includes(row.status) && !options.force) {
    return { ok: false, reason: 'invalid_status', status: row.status };
  }

  const checklist = parseJsonField(row.review_checklist, {});
  const reviewChecklist = {
    name_match: checklist.name_match === true,
    fields_complete: checklist.fields_complete === true,
    id_uploaded: checklist.id_uploaded === true,
    fee_paid: true,
  };

  const names = splitMemberName(row.member_full_name || row.wl_full_name);
  const mobile = row.cell_phone || row.home_phone || row.wl_phone;
  const email = (row.email || row.wl_email || '').trim().toLowerCase() || null;
  const address = formatAddress(row);
  const joinedRaw = row.submitted_at || row.created_at || null;
  let joinedDate = null;
  if (joinedRaw) {
    const d = new Date(joinedRaw);
    if (!Number.isNaN(d.getTime())) {
      joinedDate = d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    }
  }

  const nextNum = await db.query(`SELECT COALESCE(MAX(member_number), 0) + 1 AS num FROM members`);
  const memberNumber = nextNum.rows[0].num;

  const memberInsert = await db.query(
    `INSERT INTO members (
      member_number, status, first_name, last_name, full_name, paypal_name,
      email, mobile, home_phone, address, joined_date, notes
    ) VALUES ($1, 'Active', $2, $3, $4, $5, $6, $7, $8, $9, COALESCE(NULLIF($10, '')::date, CURRENT_DATE), $11)
    RETURNING id, member_number, first_name, last_name, full_name, email, mobile, home_phone, address, status, joined_date`,
    [
      memberNumber,
      names.first_name,
      names.last_name,
      row.member_full_name || names.full_name,
      names.full_name,
      email,
      mobile,
      row.home_phone || null,
      address,
      joinedDate,
      row.notes
        ? `Approved from application #${row.id}. ${row.notes}`
        : `Approved from application #${row.id}.`,
    ]
  );
  const member = memberInsert.rows[0];
  invalidateInvoiceStatsCache();

  const beneficiary = parseJsonField(row.beneficiary_member, null);
  if (beneficiary?.name) {
    await db.query(
      `INSERT INTO beneficiaries (member_id, name, phone, relationship, is_primary)
       VALUES ($1, $2, $3, $4, true)`,
      [member.id, beneficiary.name, beneficiary.phone || null, beneficiary.relationship || null]
    );
  }

  const paymentRef = options.paymentReference || `application-${row.id}`;
  const paymentMethod = options.paymentMethod || 'Registration';
  await db.query(
    `INSERT INTO payments (member_id, amount, method, reference, notes)
     VALUES ($1, $2, $3, $4, 'Hibret Edir membership registration fee')`,
    [member.id, REGISTRATION_FEE, paymentMethod, paymentRef]
  );

  if (row.registration_invoice_id) {
    await db.query(
      `UPDATE invoices
       SET member_id = $1,
           status = CASE WHEN LOWER(COALESCE(status, '')) = 'unpaid' THEN 'Paid' ELSE status END,
           paid_date = COALESCE(paid_date, CURRENT_DATE),
           payment_method = COALESCE(payment_method, $2),
           updated_at = NOW()
       WHERE id = $3`,
      [member.id, paymentMethod, row.registration_invoice_id]
    );
  }

  await db.query(
    `UPDATE membership_applications
     SET status = 'Approved',
         member_id = $1,
         review_checklist = $2::jsonb,
         registration_fee_paid = TRUE,
         reviewed_at = NOW()
     WHERE id = $3`,
    [member.id, JSON.stringify(reviewChecklist), applicationId]
  );

  await db.query(
    `UPDATE waiting_list
     SET status = 'Added as Member',
         approved_at = NOW(),
         reviewed_at = NOW(),
         notes = COALESCE(notes || ' ', '') || 'Approved and added to member CRM.'
     WHERE id = $1`,
    [row.waiting_list_id]
  );

  try {
    await notifyApplicationApproved(db, row, member);
  } catch (notifyErr) {
    console.error('Application approve notification failed:', notifyErr);
  }

  const actorEntry = actor || {
    actor_type: 'system',
    actor_label: options.source || 'Registration payment',
  };

  try {
    await syncApplicationApproved(db, applicationId, member.id, member.member_number, actorEntry);
  } catch (syncErr) {
    console.error('Application approve sync failed:', syncErr);
  }

  await logActivity(db, {
    ...actorEntry,
    member_id: member.id,
    action: 'application.paid',
    entity_type: 'membership_applications',
    table_name: 'membership_applications',
    record_id: applicationId,
    new_value: {
      member_id: member.id,
      member_number: member.member_number,
      payment_method: paymentMethod,
    },
    summary: `Registration paid — ${member.full_name} added as member #${member.member_number}`,
  });

  return { ok: true, member, application_id: applicationId };
}

/**
 * After PayPal sync, complete any registration invoices that became Paid.
 */
async function processPaidRegistrationInvoices(db, options = {}) {
  const res = await db.query(
    `SELECT i.id AS invoice_id,
            i.paypal_invoice_id,
            i.status AS invoice_status,
            i.payment_method,
            ma.id AS application_id,
            ma.status AS application_status,
            ma.member_id
     FROM invoices i
     JOIN membership_applications ma ON ma.id = i.membership_application_id
     WHERE i.membership_application_id IS NOT NULL
       AND ma.status = 'Awaiting Payment'
       AND ma.member_id IS NULL
       AND LOWER(COALESCE(i.status, '')) = 'paid'`
  );

  const completed = [];
  for (const row of res.rows) {
    const result = await completeMembershipFromApplication(db, row.application_id, null, {
      paymentMethod: row.payment_method || 'PayPal',
      paymentReference: row.paypal_invoice_id || `invoice-${row.invoice_id}`,
      source: options.source || 'PayPal sync',
    });
    if (result.ok && !result.skipped) {
      completed.push({
        application_id: row.application_id,
        member_id: result.member?.id,
        member_number: result.member?.member_number,
      });
    }
  }
  return completed;
}

module.exports = {
  getRegistrationFee,
  REGISTRATION_FEE,
  completeMembershipFromApplication,
  processPaidRegistrationInvoices,
  fetchApplicationForCompletion,
};

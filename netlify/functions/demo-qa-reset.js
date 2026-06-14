/**
 * System validation (QA) demo cycle reset.
 * Deactivates demo member, clears application pipeline, rejects waiting list row
 * so the public signup form accepts the same email again.
 */

const { invalidateInvoiceStatsCache } = require('./invoice-stats-cache');
const { logActivity } = require('./audit');
const { stampBoardNote } = require('./board-notes');

const QA_TAG = '[SYSTEM_QA]';

function isDemoQaEnabled() {
  return process.env.DEMO_QA_ENABLED === 'true';
}

function getDemoQaEmail() {
  return String(process.env.DEMO_QA_EMAIL || '').trim().toLowerCase();
}

function maskEmail(email) {
  const e = String(email || '').trim();
  if (!e || !e.includes('@')) return null;
  const [local, domain] = e.split('@');
  if (local.length <= 2) return `*@${domain}`;
  return `${local[0]}***${local.slice(-1)}@${domain}`;
}

function getDemoQaStatus() {
  const email = getDemoQaEmail();
  return {
    enabled: isDemoQaEnabled(),
    email_hint: email ? maskEmail(email) : null,
    email_full: email || null,
    member_cap: Number(process.env.MEMBER_CAP || 200),
    reserved_slot: Number(process.env.MEMBER_CAP || 200) > 200,
  };
}

/** QA test identity may use the reserved slot regardless of queue rank (slot 201 policy). */
function isDemoQaWaitingListRow(row) {
  if (!isDemoQaEnabled()) return false;
  const demoEmail = getDemoQaEmail();
  if (!demoEmail || !row) return false;
  return String(row.email || '').trim().toLowerCase() === demoEmail;
}

function isQaReservedSlotConfigured() {
  return isDemoQaEnabled() && Number(process.env.MEMBER_CAP || 200) > 200;
}

/** Member cap for real applicants — excludes the reserved QA slot when configured. */
function getProductionMemberCap() {
  const cap = Number(process.env.MEMBER_CAP || 200);
  return isQaReservedSlotConfigured() ? cap - 1 : cap;
}

/** True when active + invited/applying count is below full MEMBER_CAP (slot 201 available). */
function isQaReservedSlotOpen(slots) {
  if (!slots) return false;
  const cap = Number(process.env.MEMBER_CAP || 200);
  const committed = Number(slots.active_count || 0) + Number(slots.in_pipeline || 0);
  return committed < cap;
}

function isDemoQaInviteEligible(row, slots) {
  if (!isDemoQaWaitingListRow(row) || !slots) return false;
  if (isQaReservedSlotConfigured()) return isQaReservedSlotOpen(slots);
  return slots.invite_slots_remaining > 0;
}

function assertDemoEmailAllowed(email) {
  const target = String(email || getDemoQaEmail() || '').trim().toLowerCase();
  if (!target) {
    throw new Error('DEMO_QA_EMAIL is not configured.');
  }
  const allowed = getDemoQaEmail();
  if (allowed && target !== allowed) {
    throw new Error(`Demo reset is only allowed for ${maskEmail(allowed)}.`);
  }
  return target;
}

async function findDemoRecords(db, email) {
  const waitingListRes = await db.query(
    `SELECT * FROM waiting_list
     WHERE LOWER(email) = LOWER($1)
     ORDER BY id DESC`,
    [email]
  );
  const wlIds = waitingListRes.rows.map((r) => r.id);

  let applicationsRes;
  if (wlIds.length) {
    applicationsRes = await db.query(
      `SELECT ma.* FROM membership_applications ma
       WHERE ma.waiting_list_id = ANY($1::int[]) OR LOWER(COALESCE(ma.email, '')) = LOWER($2)`,
      [wlIds, email]
    );
  } else {
    applicationsRes = await db.query(
      `SELECT ma.* FROM membership_applications ma
       WHERE LOWER(COALESCE(ma.email, '')) = LOWER($1)`,
      [email]
    );
  }

  const memberIds = new Set(applicationsRes.rows.map((a) => a.member_id).filter(Boolean));
  const membersRes = await db.query(
    `SELECT * FROM members
     WHERE LOWER(COALESCE(email, '')) = LOWER($1)
        OR (CARDINALITY($2::int[]) > 0 AND id = ANY($2::int[]))`,
    [email, memberIds.size ? [...memberIds] : []]
  );

  const invoiceIds = new Set();
  for (const app of applicationsRes.rows) {
    if (app.registration_invoice_id) invoiceIds.add(app.registration_invoice_id);
  }
  for (const app of applicationsRes.rows) {
    const inv = await db.query(
      `SELECT id FROM invoices WHERE membership_application_id = $1`,
      [app.id]
    );
    inv.rows.forEach((r) => invoiceIds.add(r.id));
  }

  return {
    waitingList: waitingListRes.rows,
    applications: applicationsRes.rows,
    members: membersRes.rows,
    invoiceIds: [...invoiceIds],
  };
}

function buildResetPlan(records) {
  const wlToReject = records.waitingList.filter((r) => r.status !== 'Rejected');
  const membersToDeactivate = records.members.filter(
    (m) => String(m.status || '').toLowerCase() === 'active'
  );
  return {
    email: records.email,
    waiting_list_reject: wlToReject.map((r) => ({
      id: r.id,
      full_name: r.full_name,
      status: r.status,
    })),
    applications_delete: records.applications.map((a) => ({
      id: a.id,
      status: a.status,
      waiting_list_id: a.waiting_list_id,
    })),
    members_deactivate: membersToDeactivate.map((m) => ({
      id: m.id,
      member_number: m.member_number,
      full_name: m.full_name,
      status: m.status,
    })),
    invoices_cancel: records.invoiceIds,
  };
}

async function resetDemoQaCycle(db, options = {}) {
  if (!isDemoQaEnabled() && !options.allowCli) {
    throw new Error('DEMO_QA_ENABLED is not true.');
  }

  const email = assertDemoEmailAllowed(options.email);
  const records = await findDemoRecords(db, email);
  records.email = email;
  const plan = buildResetPlan(records);

  if (options.dryRun) {
    return {
      ok: true,
      dry_run: true,
      email_hint: maskEmail(email),
      plan,
      message: plan.waiting_list_reject.length || plan.applications_delete.length || plan.members_deactivate.length
        ? 'Dry run — re-run with --apply to reset the demo cycle.'
        : 'Nothing to reset for this demo email.',
    };
  }

  const client = await db.connect();
  const actorLabel = options.actor?.actor_label || 'System QA';
  const note = stampBoardNote(`${QA_TAG} Demo cycle reset — ready for next validation run.`, actorLabel);

  try {
    await client.query('BEGIN');

    for (const app of records.applications) {
      if (app.registration_invoice_id) {
        await client.query(
          `UPDATE membership_applications SET registration_invoice_id = NULL WHERE id = $1`,
          [app.id]
        );
      }
      await client.query(
        `UPDATE invoices
         SET membership_application_id = NULL,
             status = CASE WHEN LOWER(COALESCE(status, '')) IN ('unpaid', 'sent') THEN 'Cancelled' ELSE status END,
             paid_note = TRIM(BOTH FROM COALESCE(paid_note, '') || ' ${QA_TAG} demo reset'),
             updated_at = NOW()
         WHERE membership_application_id = $1 OR id = $2`,
        [app.id, app.registration_invoice_id || -1]
      );
      await client.query(`DELETE FROM membership_applications WHERE id = $1`, [app.id]);
    }

    for (const member of records.members) {
      if (String(member.status || '').toLowerCase() === 'active') {
        await client.query(
          `UPDATE members
           SET status = 'Inactive',
               notes = TRIM(BOTH FROM COALESCE(notes, '') || E'\n' || $2),
               updated_at = NOW()
           WHERE id = $1`,
          [member.id, `${QA_TAG} Deactivated after system validation demo.`]
        );
      }
      await client.query(`DELETE FROM pin_reset_requests WHERE member_id = $1`, [member.id]);
    }

    for (const row of records.waitingList) {
      if (row.status === 'Rejected') continue;
      await client.query(
        `UPDATE waiting_list
         SET status = 'Rejected',
             reviewed_at = NOW(),
             notes = TRIM(BOTH FROM COALESCE(notes, '') || E'\n' || $2)
         WHERE id = $1`,
        [row.id, note]
      );
    }

    await client.query('COMMIT');
    invalidateInvoiceStatsCache();

    if (options.actor) {
      await logActivity(db, {
        ...options.actor,
        action: 'demo_qa.reset',
        entity_type: 'system',
        summary: `${QA_TAG} Demo validation cycle reset for ${maskEmail(email)}`,
        new_value: plan,
      });
    }

    return {
      ok: true,
      dry_run: false,
      email_hint: maskEmail(email),
      plan,
      message: 'Demo cycle reset. You can sign up on the waiting list again with the same email.',
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  QA_TAG,
  isDemoQaEnabled,
  getDemoQaEmail,
  getDemoQaStatus,
  maskEmail,
  resetDemoQaCycle,
  findDemoRecords,
  isDemoQaWaitingListRow,
  isDemoQaInviteEligible,
  isQaReservedSlotConfigured,
  getProductionMemberCap,
};

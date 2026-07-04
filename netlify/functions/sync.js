/**
 * Keeps waiting list, applications, CRM members, and related records aligned.
 */

const { logActivity } = require('./audit');
const { fmtDateTimeLA } = require('./datetime-la');

function stamp() {
  return fmtDateTimeLA(new Date());
}

async function appendMemberNote(db, memberId, text, actorLabel) {
  if (!text?.trim()) return;
  const line = `[${stamp()}] ${actorLabel}: ${text.trim()}`;
  await db.query(
    `UPDATE members SET notes = TRIM(BOTH FROM COALESCE(notes, '') || E'\n' || $1), updated_at = NOW() WHERE id = $2`,
    [line, memberId]
  );
}

async function syncMemberContactToWaitingList(db, memberId, fields) {
  const appRes = await db.query(
    `SELECT waiting_list_id FROM membership_applications WHERE member_id = $1 LIMIT 1`,
    [memberId]
  );
  if (!appRes.rows.length) return;

  const wlId = appRes.rows[0].waiting_list_id;
  const updates = [];
  const values = [];
  let idx = 1;

  if (fields.email) {
    updates.push(`email = $${idx}`);
    values.push(fields.email.toLowerCase());
    idx += 1;
  }
  if (fields.mobile || fields.home_phone) {
    updates.push(`phone = $${idx}`);
    values.push(fields.mobile || fields.home_phone);
    idx += 1;
  }
  if (fields.address) {
    updates.push(`address = $${idx}`);
    values.push(fields.address);
    idx += 1;
  }
  if (!updates.length) return;

  values.push(wlId);
  await db.query(
    `UPDATE waiting_list SET ${updates.join(', ')}, reviewed_at = COALESCE(reviewed_at, NOW()) WHERE id = $${idx}`,
    values
  );
}

async function syncApplicationContactFromMember(db, memberId) {
  const memberRes = await db.query(
    `SELECT email, mobile, home_phone, address, full_name FROM members WHERE id = $1`,
    [memberId]
  );
  if (!memberRes.rows.length) return;
  const m = memberRes.rows[0];

  await db.query(
    `UPDATE membership_applications
     SET email = COALESCE($1, email),
         cell_phone = COALESCE($2, cell_phone),
         home_phone = COALESCE($3, home_phone),
         address = COALESCE($4, address),
         member_full_name = COALESCE($5, member_full_name)
     WHERE member_id = $6`,
    [m.email, m.mobile, m.home_phone, m.address, m.full_name, memberId]
  );

  await syncMemberContactToWaitingList(db, memberId, m);
}

async function syncMemberFromAdminUpdate(db, memberId, oldRow, newRow, actor) {
  const changes = {};
  const track = ['email', 'mobile', 'home_phone', 'address', 'full_name', 'first_name', 'last_name', 'status', 'paypal_name'];
  track.forEach((key) => {
    const from = oldRow?.[key] ?? '';
    const to = newRow?.[key] ?? '';
    if (String(from) !== String(to)) {
      changes[key] = { from: from || '(empty)', to: to || '(empty)' };
    }
  });
  if (!Object.keys(changes).length) return;

  await syncApplicationContactFromMember(db, memberId);

  const summary = Object.entries(changes)
    .map(([k, v]) => `${k}: ${v.from} → ${v.to}`)
    .join('; ');

  await appendMemberNote(db, memberId, `CRM updated — ${summary}`, actor.actor_label);
  await logActivity(db, {
    ...actor,
    action: 'member.updated',
    entity_type: 'members',
    table_name: 'members',
    record_id: memberId,
    old_value: changes,
    new_value: { member_id: memberId, member_number: newRow.member_number },
    summary: `Member #${newRow.member_number} updated: ${summary}`,
  });
}

async function syncMemberSelfUpdate(db, memberId, oldRow, newRow, actor, fieldChanges) {
  await syncApplicationContactFromMember(db, memberId);

  const summary = Object.entries(fieldChanges)
    .map(([k, v]) => `${k}: ${v.from} → ${v.to}`)
    .join('; ');

  await appendMemberNote(db, memberId, `Profile updated via portal — ${summary}`, actor.actor_label);
  await logActivity(db, {
    ...actor,
    action: 'member.profile_updated',
    entity_type: 'members',
    table_name: 'members',
    record_id: memberId,
    old_value: fieldChanges,
    new_value: { member_id: memberId },
    summary: `Member updated profile: ${summary}`,
  });
}

async function syncBeneficiaryUpdate(db, memberId, beneficiary, isNew, actor, opts = {}) {
  const pending = opts.pending === true;
  const action = pending ? 'beneficiary.change_requested' : (isNew ? 'beneficiary.created' : 'beneficiary.updated');
  const summary = pending
    ? `${isNew ? 'Requested to add' : 'Requested to update'} beneficiary ${beneficiary.name} (pending board approval)`
    : `${isNew ? 'Added' : 'Updated'} beneficiary ${beneficiary.name} (${beneficiary.relationship})`;
  await logActivity(db, {
    ...actor,
    action,
    entity_type: 'beneficiaries',
    table_name: pending ? 'member_change_requests' : 'beneficiaries',
    record_id: opts.requestId || memberId,
    new_value: beneficiary,
    summary,
  });
  await appendMemberNote(
    db,
    memberId,
    summary,
    actor.actor_label
  );
}

async function syncInvoiceStatusChange(db, invoice, oldStatus, newStatus, actor, memberId, options = {}) {
  const paidNote = String(options.paid_note || invoice.paid_note || '').trim();
  let summary = `Invoice #${invoice.invoice_number}: ${oldStatus || 'Unknown'} → ${newStatus}`;
  if (newStatus === 'Paid' && paidNote) {
    summary += ` — ${paidNote}`;
  }
  await logActivity(db, {
    ...actor,
    member_id: memberId || null,
    action: newStatus === 'Paid' ? 'invoice.paid' : 'invoice.updated',
    entity_type: 'invoices',
    table_name: 'invoices',
    record_id: invoice.id,
    old_value: { status: oldStatus },
    new_value: {
      status: newStatus,
      invoice_number: invoice.invoice_number,
      paid_note: paidNote || null,
    },
    summary,
  });

  if (memberId && newStatus === 'Paid') {
    const memberSummary = paidNote
      ? `Invoice #${invoice.invoice_number} marked paid: ${paidNote}`
      : summary;
    await appendMemberNote(db, memberId, memberSummary, actor.actor_label);
  }

  if (memberId && newStatus !== 'Paid' && invoice.sent_date) {
    const due = new Date(invoice.sent_date);
    due.setDate(due.getDate() + 3);
    if (due < new Date()) {
      await logActivity(db, {
        ...actor,
        actor_type: 'system',
        actor_label: 'Late Payment Monitor',
        member_id: memberId,
        action: 'invoice.overdue',
        entity_type: 'invoices',
        record_id: invoice.id,
        summary: `Invoice #${invoice.invoice_number} is overdue`,
      });
    }
  }
}

async function syncApplicationSubmitted(db, applicationId, waitingListId, applicantName, actor) {
  await logActivity(db, {
    ...actor,
    action: 'application.submitted',
    entity_type: 'membership_applications',
    table_name: 'membership_applications',
    record_id: applicationId,
    new_value: { waiting_list_id: waitingListId, applicant: applicantName },
    summary: `Application submitted by ${applicantName}`,
  });
  await db.query(
    `UPDATE waiting_list SET notes = TRIM(BOTH FROM COALESCE(notes, '') || E'\n' || $1) WHERE id = $2`,
    [`[${stamp()}] Application #${applicationId} submitted`, waitingListId]
  );
}

async function syncApplicationReview(db, applicationId, status, actor, notes) {
  await logActivity(db, {
    ...actor,
    action: 'application.reviewed',
    entity_type: 'membership_applications',
    table_name: 'membership_applications',
    record_id: applicationId,
    new_value: { status, notes },
    summary: `Application #${applicationId} → ${status}`,
  });
}

async function syncApplicationApproved(db, applicationId, memberId, memberNumber, actor) {
  await logActivity(db, {
    ...actor,
    member_id: memberId,
    action: 'application.approved',
    entity_type: 'membership_applications',
    table_name: 'membership_applications',
    record_id: applicationId,
    new_value: { member_id: memberId, member_number: memberNumber },
    summary: `Application approved — member #${memberNumber} created in CRM`,
  });
  await appendMemberNote(db, memberId, `Approved from application #${applicationId}`, actor.actor_label);
}

async function syncApplicationRejected(db, applicationId, actor, notes) {
  await logActivity(db, {
    ...actor,
    action: 'application.rejected',
    entity_type: 'membership_applications',
    table_name: 'membership_applications',
    record_id: applicationId,
    new_value: { notes },
    summary: `Application #${applicationId} rejected`,
  });
}

module.exports = {
  appendMemberNote,
  syncMemberContactToWaitingList,
  syncApplicationContactFromMember,
  syncMemberFromAdminUpdate,
  syncMemberSelfUpdate,
  syncBeneficiaryUpdate,
  syncInvoiceStatusChange,
  syncApplicationSubmitted,
  syncApplicationReview,
  syncApplicationApproved,
  syncApplicationRejected,
};

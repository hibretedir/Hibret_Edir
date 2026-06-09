/**
 * Activity / audit log — records who did what across waiting list, applications, CRM, invoices.
 */

async function logActivity(db, entry) {
  if (!db) return null;
  const {
    actor_type = 'system',
    board_member_id = null,
    member_id = null,
    actor_label = 'System',
    action,
    entity_type = null,
    table_name = null,
    record_id = null,
    old_value = null,
    new_value = null,
    summary = null,
  } = entry;

  if (!action) return null;

  try {
    const result = await db.query(
      `INSERT INTO audit_log (
        board_member_id, member_id, actor_type, actor_label, action,
        table_name, entity_type, record_id, old_value, new_value, summary
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING id, created_at`,
      [
        board_member_id,
        member_id,
        actor_type,
        actor_label,
        action,
        table_name || entity_type,
        entity_type || table_name,
        record_id,
        old_value ? JSON.stringify(old_value) : null,
        new_value ? JSON.stringify(new_value) : null,
        summary,
      ]
    );
    return result.rows[0];
  } catch (err) {
    // Fallback for databases without migrated columns
    if (err.message?.includes('column') || err.code === '42703') {
      try {
        const result = await db.query(
          `INSERT INTO audit_log (board_member_id, action, table_name, record_id, old_value, new_value)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id, created_at`,
          [
            board_member_id,
            action,
            table_name || entity_type,
            record_id,
            old_value ? JSON.stringify(old_value) : null,
            new_value ? JSON.stringify(new_value) : null,
          ]
        );
        return result.rows[0];
      } catch (fallbackErr) {
        console.warn('[audit] log failed:', fallbackErr.message);
        return null;
      }
    }
    console.warn('[audit] log failed:', err.message);
    return null;
  }
}

async function getActivityLog(db, { memberId, limit = 100, offset = 0, entityType } = {}) {
  const values = [];
  const filters = [];
  let idx = 1;

  if (memberId) {
    filters.push(`member_id = $${idx}`);
    values.push(memberId);
    idx += 1;
  }
  if (entityType) {
    filters.push(`entity_type = $${idx}`);
    values.push(entityType);
    idx += 1;
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  values.push(limit, offset);

  const mapRows = (rows) => rows.map((row) => ({
    ...row,
    actor_label: row.actor_label || (row.board_member_id ? 'Board' : 'System'),
    actor_type: row.actor_type || 'board',
    summary: row.summary || row.action,
  }));

  try {
    const result = await db.query(
      `SELECT id, board_member_id, member_id, actor_type, actor_label, action,
              table_name, entity_type, record_id, old_value, new_value, summary, created_at
       FROM audit_log
       ${where}
       ORDER BY created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      values
    );
    return mapRows(result.rows);
  } catch {
    try {
      const result = await db.query(
        `SELECT id, board_member_id, action, table_name, record_id, old_value, new_value, created_at
         FROM audit_log
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      return mapRows(result.rows);
    } catch {
      return [];
    }
  }
}

async function getMemberJourney(db, memberId) {
  const events = [];

  const memberRes = await db.query(
    `SELECT id, member_number, full_name, first_name, last_name, email, mobile, status, joined_date, notes, created_at
     FROM members WHERE id = $1`,
    [memberId]
  );
  const member = memberRes.rows[0];
  if (!member) return { member: null, timeline: [] };

  events.push({
    at: member.created_at,
    type: 'member',
    action: 'Member in CRM',
    summary: `${member.full_name || member.first_name} added as member #${member.member_number}`,
    status: member.status,
  });

  const appRes = await db.query(
    `SELECT ma.*, wl.full_name AS wl_name, wl.applied_at AS wl_applied_at
     FROM membership_applications ma
     JOIN waiting_list wl ON wl.id = ma.waiting_list_id
     WHERE ma.member_id = $1 OR ma.email = LOWER($2)
     ORDER BY ma.submitted_at DESC LIMIT 1`,
    [memberId, member.email || '']
  );
  if (appRes.rows[0]) {
    const app = appRes.rows[0];
    events.push({
      at: app.submitted_at,
      type: 'application',
      action: 'Application submitted',
      summary: `Membership application submitted (${app.status})`,
      record_id: app.id,
    });
    events.push({
      at: app.wl_applied_at,
      type: 'waiting_list',
      action: 'Waiting list',
      summary: `On waiting list as ${app.wl_name}`,
    });
    if (app.reviewed_at) {
      events.push({
        at: app.reviewed_at,
        type: 'application',
        action: app.status === 'Approved' ? 'Application approved' : `Application ${app.status}`,
        summary: app.notes || app.status,
        record_id: app.id,
      });
    }
  } else {
    const wlRes = await db.query(
      `SELECT applied_at, full_name, status FROM waiting_list
       WHERE LOWER(email) = LOWER($1) OR RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = RIGHT(REGEXP_REPLACE($2, '[^0-9]', '', 'g'), 10)
       ORDER BY applied_at DESC LIMIT 1`,
      [member.email || '', member.mobile || '']
    );
    if (wlRes.rows[0]) {
      events.push({
        at: wlRes.rows[0].applied_at,
        type: 'waiting_list',
        action: 'Waiting list',
        summary: `${wlRes.rows[0].full_name} — ${wlRes.rows[0].status}`,
      });
    }
  }

  const invRes = await db.query(
    `SELECT invoice_number, status, amount_due, sent_date, paid_date
     FROM invoices WHERE member_id = $1 ORDER BY sent_date DESC NULLS LAST LIMIT 20`,
    [memberId]
  );
  invRes.rows.forEach((inv) => {
    events.push({
      at: inv.paid_date || inv.sent_date,
      type: 'invoice',
      action: inv.status === 'Paid' ? 'Invoice paid' : 'Invoice sent',
      summary: `#${inv.invoice_number} — ${inv.status}${inv.amount_due ? ` ($${inv.amount_due})` : ''}`,
      record_id: inv.invoice_number,
    });
  });

  const auditRes = await db.query(
    `SELECT action, summary, actor_label, actor_type, entity_type, created_at
     FROM audit_log
     WHERE member_id = $1 OR (entity_type = 'members' AND record_id = $1)
     ORDER BY created_at DESC LIMIT 50`,
    [memberId]
  );
  auditRes.rows.forEach((row) => {
    events.push({
      at: row.created_at,
      type: 'activity',
      action: row.action,
      summary: row.summary || `${row.actor_label} (${row.actor_type})`,
      actor: row.actor_label,
    });
  });

  events.sort((a, b) => new Date(b.at) - new Date(a.at));
  return { member, timeline: events };
}

module.exports = { logActivity, getActivityLog, getMemberJourney };

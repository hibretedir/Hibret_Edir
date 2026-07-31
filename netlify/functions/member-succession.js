/**
 * Spouse succession + CRM updates when a funeral announcement is saved.
 */

const { stampBoardNote, mergeBoardNotes } = require('./board-notes');
const { logActivity } = require('./audit');
const { invalidateInvoiceStatsCache } = require('./invoice-stats-cache');

function splitPersonName(full) {
  const text = String(full || '').trim();
  if (!text) return { first_name: '', last_name: '' };
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { first_name: parts[0], last_name: parts[0] };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

function normalizePersonName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/^(ato|wzro|w\/ro|w\.ro|weizero|lij)\s+/i, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function namesMatch(a, b) {
  const na = normalizePersonName(a);
  const nb = normalizePersonName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.includes(nb) || nb.includes(na);
}

function householdPrimaryName(row) {
  const paypal = String(row.paypal_name || '').trim();
  if (paypal) return paypal;
  const fromSlash = String(row.full_name || '').includes('/')
    ? String(row.full_name).split('/')[0].trim()
    : '';
  if (fromSlash) return fromSlash;
  const parts = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  if (parts) return parts;
  return String(row.full_name || '').trim();
}

function householdSpouseName(row) {
  const explicit = String(row.spouse_name || '').trim();
  if (explicit) return explicit;
  if (String(row.full_name || '').includes('/')) {
    return String(row.full_name).split('/').slice(1).join('/').trim();
  }
  return '';
}

function classifyDeceasedRole(row, deceasedName) {
  const primary = householdPrimaryName(row);
  const spouse = householdSpouseName(row);
  const matchPrimary = namesMatch(deceasedName, primary);
  const matchSpouse = namesMatch(deceasedName, spouse);
  if (matchSpouse && !matchPrimary) return 'spouse';
  if (matchPrimary && !matchSpouse) return 'primary';
  if (matchPrimary && matchSpouse) return 'primary';
  return 'unknown';
}

async function fetchMemberRow(db, memberId) {
  const res = await db.query(
    `SELECT id, member_number, first_name, last_name, full_name, spouse_name, paypal_name,
            email, mobile, home_phone, address, status, joined_date, created_at, updated_at,
            notes, application_drive_url
     FROM members WHERE id = $1`,
    [memberId]
  );
  return res.rows[0] || null;
}

/**
 * When the primary dies and the surviving spouse continues the membership:
 * swap primary ↔ spouse names and mobile ↔ spouse cell. Same member # / invoices.
 */
async function makeSpousePrimary(db, memberId, actor, { noteExtra } = {}) {
  const id = Number(memberId);
  if (!Number.isFinite(id) || id <= 0) {
    return { error: 'Valid member id is required.', status: 400 };
  }

  const oldRow = await fetchMemberRow(db, id);
  if (!oldRow) {
    return { error: 'Member not found.', status: 404 };
  }

  const formerPrimary = householdPrimaryName(oldRow);
  const survivingSpouse = householdSpouseName(oldRow);
  if (!survivingSpouse) {
    return { error: 'No spouse on file to make primary.', status: 400 };
  }
  if (survivingSpouse.toLowerCase() === formerPrimary.toLowerCase()) {
    return { error: 'Primary and spouse names are the same — fix the record first.', status: 400 };
  }

  const nameParts = splitPersonName(survivingSpouse);
  const newFullName = formerPrimary
    ? `${survivingSpouse}/${formerPrimary}`
    : survivingSpouse;
  let successionNote = `Spouse succession: ${survivingSpouse} is now primary / digital ID name (former primary ${formerPrimary || '—'} deceased / transferred). Phones swapped.`;
  if (noteExtra) successionNote = `${noteExtra} ${successionNote}`;
  const notes = actor
    ? mergeBoardNotes(oldRow.notes, successionNote, actor.actor_label)
    : stampBoardNote(successionNote, 'Board');

  const result = await db.query(
    `UPDATE members SET
       paypal_name = $1,
       spouse_name = $2,
       full_name = $3,
       first_name = $4,
       last_name = $5,
       mobile = $6,
       home_phone = $7,
       status = 'Active',
       notes = $8,
       updated_at = NOW()
     WHERE id = $9
     RETURNING id, member_number, first_name, last_name, full_name, spouse_name, paypal_name,
               email, mobile, home_phone, address, status, joined_date, created_at, updated_at,
               notes, application_drive_url`,
    [
      survivingSpouse,
      formerPrimary || null,
      newFullName,
      nameParts.first_name,
      nameParts.last_name,
      oldRow.home_phone || null,
      oldRow.mobile || null,
      notes,
      id,
    ]
  );
  const newRow = result.rows[0];
  invalidateInvoiceStatsCache();

  if (actor) {
    try {
      await logActivity(db, {
        ...actor,
        member_id: id,
        action: 'member.spouse_made_primary',
        entity_type: 'members',
        table_name: 'members',
        record_id: id,
        summary: successionNote,
        old_value: {
          paypal_name: oldRow.paypal_name,
          spouse_name: oldRow.spouse_name,
          mobile: oldRow.mobile,
          home_phone: oldRow.home_phone,
          status: oldRow.status,
        },
        new_value: {
          paypal_name: newRow.paypal_name,
          spouse_name: newRow.spouse_name,
          mobile: newRow.mobile,
          home_phone: newRow.home_phone,
          status: newRow.status,
        },
      });
    } catch (err) {
      console.error('Spouse succession activity log failed:', err);
    }
  }

  return { member: newRow, message: successionNote, action: 'spouse_primary' };
}

/**
 * After funeral announcement save: update CRM for the linked household.
 * - Spouse continues → make spouse primary, keep Active
 * - No / no spouse → mark membership Deceased (when primary/unknown died)
 * - Deceased was spouse only → clear spouse fields, keep Active
 */
async function applyAnnouncementCrmUpdate(db, meta, actor, { eventLabel } = {}) {
  if (!meta || meta.not_member || !meta.member_id) {
    return { skipped: true, reason: 'not_linked' };
  }

  const id = Number(meta.member_id);
  const oldRow = await fetchMemberRow(db, id);
  if (!oldRow) {
    return { skipped: true, reason: 'member_not_found' };
  }

  const deceasedName = String(meta.deceased_name || '').trim();
  const continueStatus = String(meta.spouse_continue_status || '').trim().toLowerCase();
  const role = classifyDeceasedRole(oldRow, deceasedName);
  const label = eventLabel || 'Funeral announcement';
  const baseNote = `${label}: ${deceasedName || 'member'} deceased`
    + (continueStatus ? ` · spouse continue: ${continueStatus}` : '');

  // Surviving primary: spouse on the membership died
  if (role === 'spouse') {
    const note = `${baseNote}. Cleared spouse from CRM (primary continues).`;
    const notes = actor
      ? mergeBoardNotes(oldRow.notes, note, actor.actor_label)
      : stampBoardNote(note, 'Board');
    const primary = householdPrimaryName(oldRow);
    const result = await db.query(
      `UPDATE members SET
         spouse_name = NULL,
         full_name = $1,
         home_phone = NULL,
         notes = $2,
         updated_at = NOW()
       WHERE id = $3
       RETURNING id, member_number, status, paypal_name, spouse_name`,
      [primary || oldRow.full_name, notes, id]
    );
    invalidateInvoiceStatsCache();
    if (actor) {
      await logActivity(db, {
        ...actor,
        member_id: id,
        action: 'member.spouse_deceased',
        entity_type: 'members',
        table_name: 'members',
        record_id: id,
        summary: note,
      }).catch((err) => console.error(err));
    }
    return {
      action: 'spouse_cleared',
      message: note,
      member: result.rows[0],
    };
  }

  // Primary (or unmatched name): spouse continues the membership
  if (continueStatus === 'yes') {
    const result = await makeSpousePrimary(db, id, actor, { noteExtra: baseNote + '.' });
    if (result.error) {
      // Fall back to note if swap cannot run (e.g. no spouse on file)
      const note = `${baseNote}. Could not auto-promote spouse: ${result.error}`;
      const notes = actor
        ? mergeBoardNotes(oldRow.notes, note, actor.actor_label)
        : stampBoardNote(note, 'Board');
      await db.query(
        `UPDATE members SET notes = $1, updated_at = NOW() WHERE id = $2`,
        [notes, id]
      );
      return { action: 'note_only', message: note, error: result.error };
    }
    return result;
  }

  // Primary died — membership ends
  if (continueStatus === 'no' || continueStatus === 'no_spouse') {
    const note = `${baseNote}. CRM status set to Deceased.`;
    const notes = actor
      ? mergeBoardNotes(oldRow.notes, note, actor.actor_label)
      : stampBoardNote(note, 'Board');
    const result = await db.query(
      `UPDATE members SET
         status = 'Deceased',
         notes = $1,
         updated_at = NOW()
       WHERE id = $2
       RETURNING id, member_number, status, paypal_name, spouse_name`,
      [notes, id]
    );
    invalidateInvoiceStatsCache();
    if (actor) {
      await logActivity(db, {
        ...actor,
        member_id: id,
        action: 'member.marked_deceased',
        entity_type: 'members',
        table_name: 'members',
        record_id: id,
        summary: note,
        old_value: { status: oldRow.status },
        new_value: { status: 'Deceased' },
      }).catch((err) => console.error(err));
    }
    return {
      action: 'marked_deceased',
      message: note,
      member: result.rows[0],
    };
  }

  const note = `${baseNote}.`;
  const notes = actor
    ? mergeBoardNotes(oldRow.notes, note, actor.actor_label)
    : stampBoardNote(note, 'Board');
  await db.query(
    `UPDATE members SET notes = $1, updated_at = NOW() WHERE id = $2`,
    [notes, id]
  );
  return { action: 'note_only', message: note };
}

module.exports = {
  makeSpousePrimary,
  applyAnnouncementCrmUpdate,
  householdPrimaryName,
  householdSpouseName,
  classifyDeceasedRole,
};

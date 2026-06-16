/** Board admin permissions — super admin grants granular access. */

const WRITE_DENIED_MSG =
  'You do not have permission for this action. Ask a super admin or someone with the right approval access.';

const BOARD_MEMBER_PERM_COLUMNS = `
  id, email, is_active,
  is_super_admin,
  perm_full_access,
  perm_notes,
  perm_approve_payout,
  perm_approve_operations
`;

function adminHasBypass(adminPayload) {
  return !!adminPayload?.bypass;
}

function getSuperAdminEmails() {
  const raw = process.env.BOARD_SUPER_ADMIN_EMAILS || '';
  return raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

async function syncSuperAdminFlags(db) {
  const emails = getSuperAdminEmails();
  if (!emails.length) return;
  await db.query(
    `UPDATE board_members
     SET is_super_admin = TRUE,
         perm_full_access = TRUE,
         perm_notes = TRUE,
         perm_approve_payout = TRUE,
         perm_approve_operations = TRUE
     WHERE LOWER(email) = ANY($1::text[])`,
    [emails]
  );
}

function deriveBoardAccess(row) {
  if (!row) return null;
  const superAdmin = !!row.is_super_admin;
  const full = superAdmin || !!row.perm_full_access;
  return {
    is_super_admin: superAdmin,
    perm_full_access: !!row.perm_full_access,
    perm_notes: superAdmin || row.perm_notes !== false,
    perm_approve_payout: !!row.perm_approve_payout,
    perm_approve_operations: !!row.perm_approve_operations,
    canRead: true,
    canManageBoard: superAdmin,
    canWriteAll: full,
    canWriteNotes: superAdmin || !!row.perm_notes || full,
    canSyncPaypal: superAdmin || full || (row.perm_notes !== false),
    canApprovePayout: superAdmin || full || !!row.perm_approve_payout,
    canApproveOperations: superAdmin || full || !!row.perm_approve_operations,
    email: row.email,
  };
}

function buildPermissionsPayload(row) {
  const access = deriveBoardAccess(row);
  if (!access) return {};
  return {
    is_super_admin: access.is_super_admin,
    perm_full_access: access.perm_full_access,
    perm_notes: access.perm_notes,
    perm_approve_payout: access.perm_approve_payout,
    perm_approve_operations: access.perm_approve_operations,
    can_manage_board: access.canManageBoard,
    can_write_all: access.canWriteAll,
    can_write_notes: access.canWriteNotes,
    can_sync_paypal: access.canSyncPaypal,
    can_approve_payout: access.canApprovePayout,
    can_approve_operations: access.canApproveOperations,
  };
}

async function loadBoardMemberAccess(db, adminPayload) {
  if (!adminPayload) return null;
  if (adminHasBypass(adminPayload)) {
    return deriveBoardAccess({
      email: 'dev',
      is_super_admin: true,
      perm_full_access: true,
      perm_notes: true,
      perm_approve_payout: true,
      perm_approve_operations: true,
      is_active: true,
    });
  }
  if (!adminPayload.adminId) {
    return deriveBoardAccess({
      is_active: true,
      perm_notes: true,
    });
  }
  await syncSuperAdminFlags(db);
  const result = await db.query(
    `SELECT ${BOARD_MEMBER_PERM_COLUMNS}
     FROM board_members
     WHERE id = $1
     LIMIT 1`,
    [adminPayload.adminId]
  );
  const row = result.rows[0];
  if (!row || !row.is_active) return null;
  return deriveBoardAccess(row);
}

function writeDeniedError() {
  return WRITE_DENIED_MSG;
}

function assertCanManageBoard(access) {
  if (access?.canManageBoard) return null;
  return 'Only a super admin can manage board access and permissions.';
}

function assertCanWriteAll(access) {
  if (access?.canWriteAll) return null;
  return WRITE_DENIED_MSG;
}

function assertCanApproveOperations(access) {
  if (access?.canApproveOperations) return null;
  return 'You do not have approval permission for operations (invoices, applications, receipts, etc.).';
}

function assertCanApprovePayout(access) {
  if (access?.canApprovePayout) return null;
  return 'You do not have approval permission for payouts.';
}

function assertCanWriteNotes(access) {
  if (access?.canWriteNotes) return null;
  return 'You do not have permission to add board notes.';
}

function assertCanSyncPaypal(access) {
  if (access?.canSyncPaypal) return null;
  return 'You do not have permission to sync PayPal invoices.';
}

function assertNotesOnlyUpdate(body, allowedKeys = ['notes']) {
  const keys = Object.keys(body || {}).filter((k) => body[k] !== undefined);
  if (!keys.length) return 'Nothing to save.';
  if (!keys.every((k) => allowedKeys.includes(k))) return WRITE_DENIED_MSG;
  return null;
}

function filterMemberUpdateForAccess(data, access) {
  if (!data || access?.canWriteAll) return data;
  if (!access?.canWriteNotes) {
    return { id: data.id };
  }
  const filtered = { id: data.id };
  if (data.notes !== undefined) filtered.notes = data.notes;
  return filtered;
}

function normalizePermissionBody(body) {
  return {
    perm_full_access: body.perm_full_access === true,
    perm_notes: body.perm_notes !== false,
    perm_approve_payout: body.perm_approve_payout === true,
    perm_approve_operations: body.perm_approve_operations === true,
  };
}

module.exports = {
  WRITE_DENIED_MSG,
  BOARD_MEMBER_PERM_COLUMNS,
  adminHasBypass,
  getSuperAdminEmails,
  syncSuperAdminFlags,
  deriveBoardAccess,
  buildPermissionsPayload,
  loadBoardMemberAccess,
  writeDeniedError,
  assertCanManageBoard,
  assertCanWriteAll,
  assertCanApproveOperations,
  assertCanApprovePayout,
  assertCanWriteNotes,
  assertCanSyncPaypal,
  assertNotesOnlyUpdate,
  filterMemberUpdateForAccess,
  normalizePermissionBody,
};

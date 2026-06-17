/** Board admin permissions — individual grants (super admin sets each). */

const WRITE_DENIED_MSG =
  'You do not have permission for this action. Ask a super admin for access.';

/** Canonical list — order is display order in Admin → Access Management. */
const BOARD_PERMISSION_DEFS = [
  { key: 'view_members_crm', label: 'View Members CRM', desc: 'Read-only access to the Members CRM section only' },
  { key: 'board_notes', label: 'Board notes', desc: 'Add notes on members, applications, and payouts' },
  { key: 'sync_paypal', label: 'PayPal sync', desc: 'Run Sync PayPal on the invoices tab' },
  { key: 'edit_members', label: 'Edit member records', desc: 'Change member contact and profile fields' },
  { key: 'reset_pin', label: 'Reset member PIN', desc: 'Clear a member PIN so they can set a new one' },
  { key: 'announce', label: 'Funeral announcements', desc: 'Create and save memorial announcements' },
  { key: 'waiting_list_invite', label: 'Waiting list invite', desc: 'Send invitation to apply' },
  { key: 'waiting_list_remove', label: 'Waiting list remove', desc: 'Reject or remove someone from the queue' },
  { key: 'applications_review', label: 'Application review', desc: 'Save vetting checklist on applications' },
  { key: 'applications_approve', label: 'Application decisions', desc: 'Approve for payment, reject, mark paid, add to CRM' },
  { key: 'mark_paid', label: 'Invoice mark paid', desc: 'Submit and approve mark-paid requests' },
  { key: 'receipts', label: 'Receipt approval', desc: 'Approve uploaded Zelle or Bank of America receipts' },
  { key: 'pin_reset_approve', label: 'PIN reset approval', desc: 'Approve or reject forgot-PIN requests' },
  { key: 'beneficiary', label: 'Beneficiary approval', desc: 'Approve beneficiary change requests' },
  { key: 'messages', label: 'Contact messages', desc: 'Reply to public contact form messages' },
  { key: 'payout_manage', label: 'Manage payout cases', desc: 'Open and edit payout paperwork' },
  { key: 'payout_approve', label: 'Approve payouts', desc: 'Board-approve $15,000 payout cases' },
  { key: 'payout_mark_paid', label: 'Mark payout paid', desc: 'Record a payout as disbursed' },
];

const BOARD_PERM_KEYS = BOARD_PERMISSION_DEFS.map((d) => d.key);

const RESTRICTED_SCOPE_KEYS = ['view_members_crm'];

const BOARD_MEMBER_PERM_COLUMNS = `
  id, email, is_active,
  is_super_admin,
  board_perms,
  perm_full_access,
  perm_notes,
  perm_approve_payout,
  perm_approve_operations
`;

function allPermsTrue() {
  return Object.fromEntries(BOARD_PERM_KEYS.map((k) => [k, true]));
}

function allPermsFalse() {
  return Object.fromEntries(BOARD_PERM_KEYS.map((k) => [k, false]));
}

function defaultInvitePerms() {
  return {
    ...allPermsFalse(),
    board_notes: true,
    sync_paypal: true,
    messages: true,
  };
}

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
         board_perms = $2::jsonb,
         perm_full_access = TRUE,
         perm_notes = TRUE,
         perm_approve_payout = TRUE,
         perm_approve_operations = TRUE,
         write_approved = FALSE
     WHERE LOWER(email) = ANY($1::text[])`,
    [emails, JSON.stringify(allPermsTrue())]
  );
}

function parseBoardPermsJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') return raw;
  return null;
}

function legacyRowToPerms(row) {
  const notes = !!row.perm_notes;
  const full = !!row.perm_full_access;
  const ops = !!row.perm_approve_operations;
  const payout = !!row.perm_approve_payout;
  return {
    view_members_crm: false,
    board_notes: notes || full,
    sync_paypal: notes || full,
    edit_members: full,
    reset_pin: full,
    announce: full,
    waiting_list_invite: ops || full,
    waiting_list_remove: ops || full,
    applications_review: full,
    applications_approve: ops || full,
    mark_paid: ops || full,
    receipts: ops || full,
    pin_reset_approve: ops || full,
    beneficiary: ops || full,
    messages: ops || full,
    payout_manage: full,
    payout_approve: payout || full,
    payout_mark_paid: payout || full,
  };
}

function normalizePermsFromRow(row) {
  const parsed = parseBoardPermsJson(row?.board_perms);
  if (parsed && Object.keys(parsed).length) {
    const out = allPermsFalse();
    for (const key of BOARD_PERM_KEYS) {
      out[key] = parsed[key] === true;
    }
    return out;
  }
  return legacyRowToPerms(row || {});
}

function grantedPermKeys(access) {
  if (!access) return [];
  if (access.is_super_admin) return BOARD_PERM_KEYS.slice();
  return BOARD_PERM_KEYS.filter((k) => access.perms?.[k] === true);
}

function matchesPermTier(keys, tierKeys) {
  if (keys.length !== tierKeys.length) return false;
  const set = new Set(keys);
  return tierKeys.every((k) => set.has(k));
}

function isRestrictedMembersOnly(access) {
  if (!access || access.is_super_admin || adminHasBypass(access)) return false;
  return matchesPermTier(grantedPermKeys(access), RESTRICTED_SCOPE_KEYS);
}

function assertNotRestrictedMembersOnly(access, message) {
  if (isRestrictedMembersOnly(access)) {
    return message || 'Your access is limited to Members CRM only.';
  }
  return null;
}

function isPortalMembersCrmReadRoute(method, path) {
  if (method === 'GET' && (path === '/members' || path === '/member')) return true;
  if (method === 'GET' && (path === '/member/application' || path === '/member/journey')) return true;
  return false;
}

function hasPerm(access, key) {
  if (!access) return false;
  if (access.is_super_admin) return true;
  return access.perms?.[key] === true;
}

function deriveBoardAccess(row) {
  if (!row) return null;
  const superAdmin = !!row.is_super_admin;
  const perms = normalizePermsFromRow(row);
  return {
    is_super_admin: superAdmin,
    perms,
    canRead: true,
    canManageBoard: superAdmin,
    canWriteAll: superAdmin || hasPerm({ is_super_admin: false, perms }, 'edit_members'),
    canWriteNotes: superAdmin || hasPerm({ is_super_admin: false, perms }, 'board_notes'),
    canSyncPaypal: superAdmin || hasPerm({ is_super_admin: false, perms }, 'sync_paypal'),
    canApprovePayout: superAdmin
      || hasPerm({ is_super_admin: false, perms }, 'payout_approve')
      || hasPerm({ is_super_admin: false, perms }, 'payout_mark_paid'),
    canApproveOperations: superAdmin || BOARD_PERM_KEYS.some((k) => [
      'waiting_list_invite', 'waiting_list_remove', 'applications_approve',
      'mark_paid', 'receipts', 'pin_reset_approve', 'beneficiary', 'messages',
    ].includes(k) && perms[k]),
    email: row.email,
  };
}

function buildPermissionsPayload(row) {
  const access = deriveBoardAccess(row);
  if (!access) return {};
  return {
    is_super_admin: access.is_super_admin,
    perms: access.perms,
    can_manage_board: access.canManageBoard,
    can_write_all: access.canWriteAll,
    can_write_notes: access.canWriteNotes,
    can_sync_paypal: access.canSyncPaypal,
    can_approve_payout: access.canApprovePayout,
    can_approve_operations: access.canApproveOperations,
    // Legacy flat flags for older admin bundles (derived from perms)
    perm_notes: access.perms.board_notes,
    perm_full_access: access.perms.edit_members,
    perm_approve_operations: access.canApproveOperations,
    perm_approve_payout: access.perms.payout_approve || access.perms.payout_mark_paid,
  };
}

async function loadBoardMemberAccess(db, adminPayload) {
  if (!adminPayload) return null;
  if (adminHasBypass(adminPayload)) {
    return deriveBoardAccess({
      email: 'dev',
      is_super_admin: true,
      board_perms: allPermsTrue(),
      is_active: true,
    });
  }
  if (!adminPayload.adminId) {
    return deriveBoardAccess({
      is_active: true,
      board_perms: { board_notes: true },
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

function assertPerm(access, key, message) {
  if (hasPerm(access, key)) return null;
  return message || WRITE_DENIED_MSG;
}

function assertCanManageBoard(access) {
  if (access?.canManageBoard) return null;
  return 'Security is limited to super admins.';
}

function assertCanWriteAll(access) {
  return assertPerm(access, 'edit_members');
}

function assertCanApproveOperations(access) {
  if (access?.canApproveOperations) return null;
  return 'You do not have permission for this operational action.';
}

function assertCanApprovePayout(access) {
  if (hasPerm(access, 'payout_approve') || hasPerm(access, 'payout_mark_paid')) return null;
  return 'You do not have approval permission for payouts.';
}

function assertCanWriteNotes(access) {
  return assertPerm(access, 'board_notes', 'You do not have permission to add board notes.');
}

function assertCanSyncPaypal(access) {
  return assertPerm(access, 'sync_paypal', 'You do not have permission to sync PayPal invoices.');
}

function assertNotesOnlyUpdate(body, allowedKeys = ['notes']) {
  const keys = Object.keys(body || {}).filter((k) => body[k] !== undefined);
  if (!keys.length) return 'Nothing to save.';
  if (!keys.every((k) => allowedKeys.includes(k))) return WRITE_DENIED_MSG;
  return null;
}

function filterMemberUpdateForAccess(data, access) {
  if (!data) return data;
  if (hasPerm(access, 'edit_members')) return data;
  if (!hasPerm(access, 'board_notes')) {
    return { id: data.id };
  }
  const filtered = { id: data.id };
  if (data.notes !== undefined) filtered.notes = data.notes;
  return filtered;
}

function normalizePermissionBody(body) {
  const out = allPermsFalse();
  for (const key of BOARD_PERM_KEYS) {
    out[key] = body?.[key] === true;
  }
  return out;
}

module.exports = {
  WRITE_DENIED_MSG,
  BOARD_PERMISSION_DEFS,
  BOARD_PERM_KEYS,
  BOARD_MEMBER_PERM_COLUMNS,
  allPermsTrue,
  allPermsFalse,
  defaultInvitePerms,
  adminHasBypass,
  getSuperAdminEmails,
  syncSuperAdminFlags,
  normalizePermsFromRow,
  hasPerm,
  grantedPermKeys,
  matchesPermTier,
  isRestrictedMembersOnly,
  assertNotRestrictedMembersOnly,
  isPortalMembersCrmReadRoute,
  deriveBoardAccess,
  buildPermissionsPayload,
  loadBoardMemberAccess,
  writeDeniedError,
  assertPerm,
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

/**
 * Local smoke test: QA waiting-list invite eligibility + optional invite.
 * Usage:
 *   node scripts/test_qa_invite_local.js           # check only
 *   node scripts/test_qa_invite_local.js --invite  # send invite to QA row
 */
require('dotenv').config();

const BASE = process.env.LOCAL_DEV_URL || `http://localhost:${process.env.PORT || 8888}`;

async function fetchJson(path, opts = {}) {
  const url = `${BASE}/.netlify/functions/${path}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { _raw: text.slice(0, 500) };
  }
  return { status: res.status, body };
}

async function main() {
  const doInvite = process.argv.includes('--invite');

  console.log('\nHibret Edir — local QA invite test');
  console.log('Base URL:', BASE);
  console.log('Env: MEMBER_CAP=%s DEMO_QA_ENABLED=%s DEMO_QA_EMAIL=%s\n',
    process.env.MEMBER_CAP, process.env.DEMO_QA_ENABLED, process.env.DEMO_QA_EMAIL);

  const health = await fetchJson('apply/qa/dashboard');
  if (health.status !== 200) {
    console.error('✗ QA dashboard unreachable (%s). Is `npm run dev` running?', health.status);
    console.error('  Response:', health.body);
    process.exit(1);
  }
  const demo = health.body?.demo || {};
  console.log('QA dashboard demo:', demo);

  const wl = await fetchJson('apply/waiting-list');
  if (wl.status !== 200) {
    console.error('✗ waiting-list API failed (%s):', wl.status, wl.body);
    process.exit(1);
  }

  const { slots, demo_qa, waiting_list: rows, next_to_invite: next } = wl.body;
  console.log('\nSlots:', slots);
  console.log('demo_qa from API:', demo_qa);

  const qaEmail = (process.env.DEMO_QA_EMAIL || '').trim().toLowerCase();
  const qaRow = (rows || []).find((r) => String(r.email || '').toLowerCase() === qaEmail);
  if (!qaRow) {
    console.error('\n✗ No waiting-list row for', qaEmail);
    console.log('  Pending count:', (rows || []).filter((r) => r.status === 'Pending').length);
    process.exit(1);
  }

  console.log('\nQA row:', {
    id: qaRow.id,
    name: qaRow.full_name,
    status: qaRow.status,
    pending_rank: qaRow.pending_rank,
    eligible_for_invite: qaRow.eligible_for_invite,
  });
  console.log('next_to_invite:', next);

  if (!qaRow.eligible_for_invite) {
    console.error('\n✗ QA row is NOT eligible_for_invite — admin will show "Waiting for slot"');
    if (!demo_qa?.enabled) console.error('  → demo_qa.enabled is false on server (check .env + restart dev)');
    if (!demo_qa?.email_full) console.error('  → demo_qa.email_full missing');
    if ((slots?.invite_slots_remaining ?? 0) <= 0 && !demo_qa?.reserved_slot) {
      console.error('  → no invite slots remaining');
    }
    process.exit(1);
  }

  console.log('\n✓ QA row eligible — admin should show "Ready to Invite"');

  if (!doInvite) {
    console.log('\nRun with --invite to POST invite (sends email).');
    return;
  }

  if (qaRow.status === 'Invited to Apply') {
    console.log('\nAlready invited — skipping POST');
    return;
  }

  const inv = await fetchJson(`apply/waiting-list/${qaRow.id}/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  console.log('\nInvite POST status:', inv.status, inv.body);
  if (inv.status >= 400) process.exit(1);
  console.log('✓ Invitation sent');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

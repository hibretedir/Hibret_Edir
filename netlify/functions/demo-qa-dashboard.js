/**
 * Monitor Health — system checks + Meridian-aligned validation steps.
 */

const {
  isDemoQaEnabled,
  getDemoQaEmail,
  getDemoQaStatus,
  maskEmail,
  findDemoRecords,
} = require('./demo-qa-reset');

function getDemoQaPhone() {
  return String(process.env.DEMO_QA_PHONE || '').trim();
}

function getDemoQaName() {
  return String(process.env.DEMO_QA_NAME || 'System Test Member').trim();
}

function getRegistrationFee() {
  const raw = process.env.REGISTRATION_FEE;
  const n = raw != null && raw !== '' ? Number(raw) : 200;
  return Number.isFinite(n) && n > 0 ? n : 200;
}

const QA_PHASES = [
  {
    id: 'integrations',
    title: 'Notifications',
    phase: 0,
    color: '#60a5fa',
    steps: [
      {
        id: 'NTF-01',
        title: 'SendGrid test email',
        mode: 'action',
        action: 'test_notify',
        optional: true,
        requires: [],
        prerequisites: [
          { key: 'sendgrid', label: 'SendGrid configured (SENDGRID_API_KEY)' },
          { key: 'demo_email', label: 'DEMO_QA_EMAIL configured' },
        ],
        how_to_test: 'System Health → Dashboard: click Send test email (uses DEMO_QA_EMAIL). Locally: npm run test:notify then npm run test:notify -- --send with TEST_NOTIFY_EMAIL in .env.',
        pass_criteria: 'Inbox receives “Hibret Edir — QA test email” (check spam). ONB-02 invite email works in the full onboarding run.',
      },
    ],
  },
  {
    id: 'onboarding',
    title: 'Onboarding',
    phase: 1,
    color: '#10ffb0',
    steps: [
      {
        id: 'ONB-01',
        title: 'Waiting list signup',
        mode: 'guided',
        link: '/#apply',
        link_label: 'Public form',
        requires: [],
        prerequisites: [
          { key: 'demo_email', label: 'DEMO_QA_EMAIL configured' },
          { key: 'can_signup', label: 'No active waiting list row for test email (reset if needed)' },
          { key: 'database', label: 'Database reachable' },
        ],
        how_to_test: 'Open the public Join / Waiting List form. Submit using the test member name, DEMO_QA_EMAIL, DEMO_QA_PHONE, and a valid address inside the service area.',
        pass_criteria: 'Success message on submit; row appears in Admin → Approval → Waiting List as Pending.',
      },
      {
        id: 'ONB-02',
        title: 'Board sends invitation',
        mode: 'guided',
        link: '/admin/#applications',
        link_label: 'Waiting List',
        requires: ['ONB-01'],
        prerequisites: [
          { key: 'wl_queue', label: 'Test member on waiting list (Pending or Registered)' },
          { key: 'qa_slot', label: 'Reserved QA slot open (MEMBER_CAP 201 — demo email only)' },
          { key: 'sendgrid', label: 'SendGrid configured (invitation email)' },
        ],
        how_to_test: 'Admin → Approval → Waiting List tab. Find the test member (should show Ready to Invite). Click Send Invitation → and confirm.',
        pass_criteria: 'Status becomes Invited to Apply; applicant receives email with link to /application/ (SMS optional if Twilio ready).',
      },
      {
        id: 'ONB-03',
        title: 'Applicant submits application',
        mode: 'guided',
        link: '/application/',
        link_label: 'Application',
        requires: ['ONB-02'],
        prerequisites: [
          { key: 'wl_invited', label: 'Waiting list status is Invited to Apply' },
          { key: 'no_app_yet', label: 'No membership application submitted yet' },
        ],
        how_to_test: 'Open /application/. Verify with test email + phone. Complete all required fields and submit.',
        pass_criteria: 'Application appears in Admin → Approval → Applications; waiting list shows Application Submitted.',
      },
      {
        id: 'ONB-04',
        title: 'Board review checklist',
        mode: 'guided',
        link: '/admin/#applications',
        link_label: 'Applications',
        requires: ['ONB-03'],
        prerequisites: [
          { key: 'app_submitted', label: 'Application status Submitted or Under Review' },
        ],
        how_to_test: 'Open the application from the Applications tab. Check name match, fields complete, and ID uploaded.',
        pass_criteria: 'All three review checks marked; ready for Approve & Send Invoice.',
      },
      {
        id: 'ONB-05',
        title: 'Registration PayPal invoice',
        mode: 'guided',
        link: '/admin/#applications',
        link_label: 'Approve & invoice',
        requires: ['ONB-04'],
        prerequisites: [
          { key: 'app_submitted', label: 'Application reviewed and ready' },
          { key: 'paypal', label: 'PayPal API configured' },
          { key: 'sendgrid', label: 'SendGrid configured (invoice email)' },
        ],
        how_to_test: 'Click Approve & Send Invoice. PayPal creates and sends the registration invoice (REGISTRATION_FEE, e.g. $1 for QA).',
        pass_criteria: 'Application status Awaiting Payment; PayPal invoice email received.',
      },
      {
        id: 'ONB-06',
        title: 'Payment → active member',
        mode: 'guided',
        link: '/admin/#applications',
        link_label: 'Mark paid / sync',
        requires: ['ONB-05'],
        prerequisites: [
          { key: 'app_awaiting_payment', label: 'Application awaiting registration payment' },
          { key: 'paypal', label: 'PayPal configured, or use Mark Registration Paid for Zelle test' },
        ],
        how_to_test: 'Pay the PayPal invoice (real charge), then Sync PayPal — or use Mark Registration Paid for a manual test.',
        pass_criteria: 'Test member appears Active in Members CRM; waiting list Added as Member; audit log entry.',
      },
      {
        id: 'ONB-07',
        title: 'Digital member ID (portal PIN)',
        mode: 'guided',
        link: '/portal/',
        link_label: 'Member portal',
        requires: ['ONB-06'],
        prerequisites: [
          { key: 'member_active', label: 'Test member status Active' },
          { key: 'member_mobile', label: 'Mobile number on member record' },
        ],
        how_to_test: 'Open member portal. Sign in with test phone, create PIN, confirm invoices/profile load.',
        pass_criteria: 'Portal login works; member sees their record.',
      },
      {
        id: 'ONB-08',
        title: 'Reset demo cycle',
        mode: 'action',
        action: 'reset',
        requires: [],
        prerequisites: [
          { key: 'demo_enabled', label: 'DEMO_QA_ENABLED=true' },
        ],
        how_to_test: 'Click Reset demo cycle when finished (or after each full test run).',
        pass_criteria: 'Waiting list rejected (can sign up again); application removed; member set Inactive; invite slot free.',
      },
    ],
  },
  {
    id: 'memorial',
    title: 'When a member passes',
    phase: 2,
    color: '#ffd020',
    steps: [
      {
        id: 'EVT-07',
        title: 'Death notification to board',
        mode: 'planned',
        requires: [],
        prerequisites: [],
        how_to_test: 'Not automated yet — board receives call.',
        pass_criteria: 'Planned: auto-notify board when built (EVT-07).',
      },
      {
        id: 'EVT-05',
        title: 'Family submits service details',
        mode: 'partial',
        hint: 'scripts/set_event_announcement.js',
        requires: ['EVT-07'],
        prerequisites: [
          { key: 'active_event', label: 'Active event row in database' },
        ],
        how_to_test: 'Run set_event_announcement.js for an event number, or edit events.notes JSON manually.',
        pass_criteria: 'Prayer/burial details appear on public announcement.',
      },
      {
        id: 'EVT-04',
        title: 'Public memorial announcement',
        mode: 'guided',
        link: '/#announcement',
        link_label: 'Announcement',
        requires: ['EVT-05'],
        prerequisites: [
          { key: 'active_event', label: 'Latest Active event with deceased name' },
        ],
        how_to_test: 'Open public site → Announcement section. Confirm deceased name, dates, venues.',
        pass_criteria: 'Announcement renders from live events table.',
      },
      {
        id: 'EVT-06',
        title: 'PayPal invoices to all members',
        mode: 'planned',
        requires: ['EVT-04'],
        prerequisites: [],
        how_to_test: 'Not built yet — Admin New Event → bulk PayPal invoices.',
        pass_criteria: 'Planned (EVT-06).',
      },
      {
        id: 'EVT-01',
        title: 'Members pay — sync records',
        mode: 'guided',
        link: '/admin/#invoices',
        link_label: 'Sync PayPal',
        requires: ['EVT-06'],
        prerequisites: [
          { key: 'paypal', label: 'PayPal configured' },
        ],
        how_to_test: 'After an invoice exists, pay (or mark paid) then Sync PayPal on Invoices tab.',
        pass_criteria: 'Invoice status Paid in admin and member portal.',
      },
    ],
  },
  {
    id: 'payout',
    title: 'Payout benefit',
    phase: 3,
    color: '#ff5566',
    steps: [
      {
        id: 'OUT-01',
        title: 'Open payout case',
        mode: 'guided',
        link: '/admin/#payouts',
        link_label: 'Payout Fund',
        requires: [],
        prerequisites: [
          { key: 'database', label: 'Database reachable' },
        ],
        how_to_test: 'Payout Fund → Open Payout Case. Use a test deceased name (not a real member).',
        pass_criteria: 'Case appears in Collecting Docs with audit log entry.',
      },
      {
        id: 'OUT-02',
        title: 'Beneficiary documents',
        mode: 'guided',
        link: '/admin/#payouts',
        link_label: 'Payout Fund',
        requires: ['OUT-01'],
        prerequisites: [
          { key: 'payout_open', label: 'Open payout case exists (manual check)' },
        ],
        how_to_test: 'Open case → upload or stage document slots → update checklist.',
        pass_criteria: 'Documents saved; checklist reflects uploads.',
      },
      {
        id: 'OUT-03',
        title: 'Dual board approval',
        mode: 'guided',
        link: '/admin/#payouts',
        link_label: 'Payout Fund',
        requires: ['OUT-02'],
        prerequisites: [
          { key: 'payout_open', label: 'Required docs verified on case' },
        ],
        how_to_test: 'Two different board members approve per by-laws.',
        pass_criteria: 'Case status Approved.',
      },
      {
        id: 'OUT-04',
        title: 'Mark $15K paid out',
        mode: 'guided',
        link: '/admin/#payouts',
        link_label: 'Payout Fund',
        requires: ['OUT-03'],
        prerequisites: [
          { key: 'payout_approved', label: 'Case fully approved' },
        ],
        how_to_test: 'Mark paid out after wire/check sent.',
        pass_criteria: 'Case status Paid Out; activity logged.',
      },
    ],
  },
];

async function getMembershipSlots(db) {
  const memberCap = Number(process.env.MEMBER_CAP || 200);
  const res = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) = 'active')::int AS active_count,
       (SELECT COUNT(*)::int FROM waiting_list wl
        WHERE wl.status = ANY($1::text[])) AS in_pipeline
     FROM members`,
    [['Invited to Apply', 'Application Submitted']]
  );
  const row = res.rows[0] || {};
  const active_count = Number(row.active_count || 0);
  const in_pipeline = Number(row.in_pipeline || 0);
  const slots_available = Math.max(0, memberCap - active_count);
  const invite_slots_remaining = Math.max(0, slots_available - in_pipeline);
  return {
    active_count,
    member_cap: memberCap,
    in_pipeline,
    invite_slots_remaining,
    slots_available,
  };
}

function integrationHealth() {
  const paypal = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET);
  const sendgrid = !!process.env.SENDGRID_API_KEY;
  const twilio = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
  const database = !!process.env.DATABASE_URL;
  return {
    database: { ok: database, label: 'PostgreSQL (DATABASE_URL)' },
    paypal: { ok: paypal, label: 'PayPal API', env: process.env.PAYPAL_ENV || 'sandbox' },
    sendgrid: { ok: sendgrid, label: 'SendGrid email' },
    twilio: { ok: twilio, label: 'Twilio SMS', note: twilio ? null : 'Optional until A2P verified' },
    demo_qa: { ok: isDemoQaEnabled(), label: 'Demo QA mode (DEMO_QA_ENABLED)' },
  };
}

function derivePipelineStage(records, slots) {
  const activeWl = records.waitingList.find((r) => r.status !== 'Rejected') || null;
  const app = records.applications[0] || null;
  const activeMember = records.members.find((m) => String(m.status || '').toLowerCase() === 'active') || null;
  const inactiveMember = records.members.find((m) => String(m.status || '').toLowerCase() !== 'active') || null;

  if (activeMember) {
    return {
      stage: 'active_member',
      label: 'Active member',
      waiting_list: activeWl,
      application: app,
      member: activeMember,
    };
  }
  if (app) {
    const st = app.status || '';
    if (st === 'Awaiting Payment') {
      return { stage: 'awaiting_payment', label: 'Awaiting registration payment', waiting_list: activeWl, application: app, member: inactiveMember };
    }
    if (['Submitted', 'Under Review', 'Pending'].includes(st)) {
      return { stage: 'application_review', label: 'Application under review', waiting_list: activeWl, application: app, member: inactiveMember };
    }
    if (st === 'Approved' && app.member_id) {
      return { stage: 'approved', label: 'Approved', waiting_list: activeWl, application: app, member: inactiveMember };
    }
    return { stage: 'application', label: `Application: ${st}`, waiting_list: activeWl, application: app, member: inactiveMember };
  }
  if (activeWl) {
    const st = activeWl.status || '';
    if (st === 'Invited to Apply') {
      return { stage: 'invited', label: 'Invited to apply', waiting_list: activeWl, application: null, member: inactiveMember };
    }
    if (st === 'Application Submitted') {
      return { stage: 'app_submitted_wl', label: 'Application submitted (waiting list)', waiting_list: activeWl, application: null, member: inactiveMember };
    }
    if (st === 'Added as Member') {
      return { stage: 'added_wl', label: 'Waiting list: Added as Member', waiting_list: activeWl, application: null, member: inactiveMember };
    }
    return { stage: 'waiting', label: `Waiting list: ${st}`, waiting_list: activeWl, application: null, member: inactiveMember };
  }
  return {
    stage: 'ready_signup',
    label: 'Ready for waiting list signup',
    waiting_list: null,
    application: null,
    member: inactiveMember,
  };
}

function canSignup(records) {
  const email = getDemoQaEmail();
  if (!email) return { ok: false, reason: 'DEMO_QA_EMAIL not set' };
  const blocking = records.waitingList.find((r) => r.status !== 'Rejected');
  if (blocking) return { ok: false, reason: `Waiting list row #${blocking.id} (${blocking.status}) — reset first` };
  return { ok: true, reason: 'Same email can join the public waiting list' };
}

function evaluatePrerequisiteItem(key, ctx) {
  const { pipeline, signup, slots, integrations, demo, has_active_event } = ctx;
  const wl = pipeline.waiting_list;
  const app = pipeline.application;
  const member = pipeline.member;

  switch (key) {
    case 'demo_email':
      return !!getDemoQaEmail();
    case 'demo_enabled':
      return !!demo?.enabled;
    case 'database':
      return !!integrations.database?.ok;
    case 'can_signup':
      return signup.ok;
    case 'wl_queue':
      return !!(wl && ['Pending', 'Registered'].includes(wl.status));
    case 'wl_invited':
      return wl?.status === 'Invited to Apply';
    case 'qa_slot':
      return (slots?.invite_slots_remaining || 0) > 0 && isDemoQaEnabled() && !!getDemoQaEmail();
    case 'invite_slot':
      return (slots?.invite_slots_remaining || 0) > 0;
    case 'sendgrid':
      return !!integrations.sendgrid?.ok;
    case 'paypal':
      return !!integrations.paypal?.ok;
    case 'no_app_yet':
      return !app;
    case 'app_submitted':
      return !!(app && ['Submitted', 'Under Review', 'Pending', 'Awaiting Payment'].includes(app.status));
    case 'app_awaiting_payment':
      return app?.status === 'Awaiting Payment';
    case 'member_active':
      return pipeline.stage === 'active_member';
    case 'member_mobile':
      return !!(member?.mobile && String(member.mobile).trim());
    case 'active_event':
      return !!has_active_event;
    case 'payout_open':
    case 'payout_approved':
      return null;
    default:
      return null;
  }
}

function evaluateStepPrerequisites(step, ctx) {
  if (!step.prerequisites?.length) return { all_met: true, items: [] };
  const items = step.prerequisites.map((p) => {
    const ok = evaluatePrerequisiteItem(p.key, ctx);
    return {
      key: p.key,
      label: p.label,
      ok: ok === null ? null : !!ok,
      unknown: ok === null,
    };
  });
  const checked = items.filter((i) => !i.unknown);
  const all_met = checked.length > 0 && checked.every((i) => i.ok);
  return { all_met, items };
}

function findCurrentTestStep(phases) {
  for (const phase of phases) {
    for (const step of phase.steps) {
      if (step.mode === 'planned' || step.optional) continue;
      const st = step.check?.status;
      if (st === 'pass') continue;
      if (['ready', 'warn', 'fail', 'partial'].includes(st)) {
        return { phase_id: phase.id, step_id: step.id, title: step.title, status: st };
      }
    }
  }
  return null;
}

function evaluateStep(step, ctx) {
  if (step.mode === 'planned') {
    return { status: 'planned', message: 'Not built yet — see automation registry' };
  }
  if (step.mode === 'partial') {
    return { status: 'partial', message: step.hint || 'Manual script or partial workflow' };
  }
  const { pipeline, signup, slots, integrations } = ctx;
  if (step.id === 'ONB-08') {
    return {
      status: ctx.demo.enabled ? 'ready' : 'warn',
      message: ctx.demo.enabled ? 'Reset demo member, application, and waiting list' : 'Enable DEMO_QA_ENABLED',
    };
  }
  if (step.id === 'NTF-01') {
    if (!integrations.sendgrid?.ok) {
      return { status: 'fail', message: 'Set SENDGRID_API_KEY and SENDGRID_FROM_EMAIL, then redeploy' };
    }
    if (!getDemoQaEmail()) {
      return { status: 'warn', message: 'Set DEMO_QA_EMAIL for QA test sends' };
    }
    return {
      status: 'ready',
      message: `SendGrid OK — click Send test email (→ ${maskEmail(getDemoQaEmail())})`,
    };
  }

  const stage = pipeline.stage;

  switch (step.id) {
    case 'ONB-01':
      if (['waiting', 'invited', 'application_review', 'awaiting_payment', 'active_member', 'app_submitted_wl'].includes(stage)) {
        return { status: 'pass', message: 'On waiting list — step complete' };
      }
      if (signup.ok) return { status: 'ready', message: signup.reason };
      return { status: 'warn', message: signup.reason || 'Reset demo cycle first' };
    case 'ONB-02': {
      if (['invited', 'application_review', 'awaiting_payment', 'active_member', 'app_submitted_wl'].includes(stage)) {
        return { status: 'pass', message: 'Invitation step complete' };
      }
      if (stage === 'waiting' && slots.invite_slots_remaining > 0) {
        const { isDemoQaWaitingListRow } = require('./demo-qa-reset');
        if (isDemoQaWaitingListRow(pipeline.waiting_list)) {
          return { status: 'ready', message: 'Reserved QA slot open — send invitation to test member' };
        }
        return { status: 'ready', message: `${slots.invite_slots_remaining} invite slot(s) open — send invitation` };
      }
      if (stage === 'waiting') {
        return { status: 'fail', message: 'No invite slots — check cap / pipeline' };
      }
      return { status: 'warn', message: pipeline.label };
    }
    case 'ONB-03':
      if (['application_review', 'awaiting_payment', 'active_member'].includes(stage)) {
        return { status: 'pass', message: 'Application submitted' };
      }
      if (stage === 'invited') return { status: 'ready', message: 'Applicant should complete /application/' };
      return { status: 'warn', message: 'Send invitation first' };
    case 'ONB-04':
      if (['awaiting_payment', 'active_member'].includes(stage)) return { status: 'pass', message: 'Review complete' };
      if (stage === 'application_review') return { status: 'ready', message: 'Complete checklist in Applications' };
      return { status: 'warn', message: 'Application not in review yet' };
    case 'ONB-05':
      if (stage === 'awaiting_payment') {
        return {
          status: integrations.paypal.ok ? 'ready' : 'fail',
          message: integrations.paypal.ok
            ? `Invoice sent — registration fee $${ctx.registration_fee}`
            : 'PayPal not configured',
        };
      }
      if (stage === 'active_member') return { status: 'pass', message: 'Invoice step complete' };
      return { status: 'warn', message: 'Approve application first' };
    case 'ONB-06':
      if (stage === 'active_member') return { status: 'pass', message: 'Demo member is Active' };
      if (stage === 'awaiting_payment') {
        return { status: 'ready', message: 'Pay via PayPal or Mark Registration Paid' };
      }
      return { status: 'warn', message: 'Registration invoice not sent yet' };
    case 'ONB-07':
      if (stage === 'active_member' && pipeline.member?.mobile) {
        return { status: 'ready', message: 'Test portal login with test phone + PIN' };
      }
      if (stage === 'active_member') return { status: 'warn', message: 'Member active — set mobile for portal test' };
      return { status: 'warn', message: 'Complete membership activation first' };
    case 'EVT-04': {
      return ctx.has_active_event
        ? { status: 'ready', message: 'Active funeral event — check public announcement' }
        : { status: 'warn', message: 'No active event in database' };
    }
    case 'EVT-01':
      return integrations.paypal.ok
        ? { status: 'ready', message: 'Run Sync PayPal on Invoices tab' }
        : { status: 'fail', message: 'PayPal not configured' };
    case 'OUT-01':
    case 'OUT-02':
    case 'OUT-03':
    case 'OUT-04':
      return { status: 'ready', message: 'Use Payout Fund with a test deceased name' };
    default:
      return { status: 'warn', message: 'Manual verification' };
  }
}

async function buildMonitorHealthDashboard(db) {
  const integrations = integrationHealth();
  let dbOk = false;
  let slots = null;
  let records = { waitingList: [], applications: [], members: [], invoiceIds: [] };
  let hasActiveEvent = false;
  let dbError = null;

  if (integrations.database.ok) {
    try {
      await db.query('SELECT 1');
      dbOk = true;
      slots = await getMembershipSlots(db);
      const email = getDemoQaEmail();
      if (email) records = await findDemoRecords(db, email);
      const ev = await db.query(
        `SELECT COUNT(*)::int AS c FROM events
         WHERE deceased_name IS NOT NULL AND TRIM(deceased_name) <> '' AND status = 'Active'`
      );
      hasActiveEvent = Number(ev.rows[0]?.c || 0) > 0;
    } catch (err) {
      dbError = err.message || 'Database query failed';
    }
  }

  const demoEmail = getDemoQaEmail();
  const demoPhone = getDemoQaPhone();
  const demo = {
    ...getDemoQaStatus(),
    email: demoEmail ? maskEmail(demoEmail) : null,
    email_full: demoEmail || null,
    phone: demoPhone || null,
    phone_hint: demoPhone ? `***${demoPhone.slice(-4)}` : null,
    name: getDemoQaName(),
  };

  const signup = canSignup(records);
  const pipeline = derivePipelineStage(records, slots || { invite_slots_remaining: 0 });
  const registration_fee = getRegistrationFee();

  const ctx = {
    demo,
    pipeline,
    signup,
    slots: slots || {},
    integrations,
    registration_fee,
    has_active_event: hasActiveEvent,
  };

  const phases = QA_PHASES.map((phase) => ({
    ...phase,
    steps: phase.steps.map((step) => {
      const check = evaluateStep(step, ctx);
      const prerequisite_status = evaluateStepPrerequisites(step, ctx);
      return {
        ...step,
        check,
        prerequisite_status,
        can_test: step.mode === 'planned'
          ? false
          : step.mode === 'action' || prerequisite_status.all_met || !step.prerequisites?.length,
      };
    }),
  }));

  const current_step = findCurrentTestStep(phases);

  const healthItems = [
    { id: 'db', label: 'Database', status: dbOk ? 'pass' : 'fail', detail: dbOk ? 'Connected' : dbError || 'Not configured' },
    { id: 'paypal', label: 'PayPal', status: integrations.paypal.ok ? 'pass' : 'fail', detail: integrations.paypal.ok ? integrations.paypal.env : 'Missing credentials' },
    { id: 'sendgrid', label: 'SendGrid', status: integrations.sendgrid.ok ? 'pass' : 'warn', detail: integrations.sendgrid.ok ? 'Configured' : 'Email notifications disabled' },
    { id: 'twilio', label: 'Twilio SMS', status: integrations.twilio.ok ? 'pass' : 'warn', detail: integrations.twilio.ok ? 'Configured' : 'SMS optional / A2P pending' },
    { id: 'demo', label: 'Demo QA', status: integrations.demo_qa.ok ? 'pass' : 'warn', detail: integrations.demo_qa.ok ? demo.email || 'Enabled' : 'Set DEMO_QA_ENABLED=true' },
    { id: 'slots', label: 'Membership slots', status: slots && slots.invite_slots_remaining > 0 ? 'pass' : slots ? 'warn' : 'fail', detail: slots ? `${slots.active_count}/${slots.member_cap} active · ${slots.invite_slots_remaining} invite slot(s)` : '—' },
  ];

  const onboardingPhase = phases.find((p) => p.id === 'onboarding');
  const onbPass = onboardingPhase?.steps.filter((s) => s.check.status === 'pass').length || 0;
  const onbTotal = onboardingPhase?.steps.filter((s) => s.mode !== 'action').length || 0;

  return {
    ok: dbOk,
    generated_at: new Date().toISOString(),
    health: healthItems,
    demo,
    pipeline: {
      stage: pipeline.stage,
      label: pipeline.label,
      waiting_list: pipeline.waiting_list
        ? { id: pipeline.waiting_list.id, status: pipeline.waiting_list.status, full_name: pipeline.waiting_list.full_name }
        : null,
      application: pipeline.application
        ? { id: pipeline.application.id, status: pipeline.application.status }
        : null,
      member: pipeline.member
        ? { id: pipeline.member.id, status: pipeline.member.status, member_number: pipeline.member.member_number }
        : null,
    },
    slots,
    registration_fee,
    signup,
    phases,
    current_step,
    summary: {
      health_pass: healthItems.filter((h) => h.status === 'pass').length,
      health_total: healthItems.length,
      onboarding_progress: `${onbPass}/${onbTotal}`,
    },
    links: {
      showcase: '/docs/automation-showcase.html',
      playbook: '/docs/system-validation-playbook.md',
    },
  };
}

module.exports = {
  QA_PHASES,
  buildMonitorHealthDashboard,
  getDemoQaPhone,
  getDemoQaName,
  evaluatePrerequisiteItem,
};

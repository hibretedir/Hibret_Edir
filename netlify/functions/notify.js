/**
 * Email (SendGrid) + SMS (Twilio) notifications with DB logging.
 * Skips gracefully when credentials are not configured (local dev).
 */

const fetchFn = typeof fetch === 'function' ? fetch : require('node-fetch');

function normalizeDigits(phone) {
  if (!phone) return null;
  const d = String(phone).replace(/\D/g, '');
  if (d.length === 10) return d;
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return d.length >= 10 ? d.slice(-10) : null;
}

function toE164(phone) {
  const d = normalizeDigits(phone);
  return d ? `+1${d}` : null;
}

function boardEmails() {
  const raw = process.env.BOARD_NOTIFY_EMAIL || process.env.SENDGRID_TO_BOARD || 'hibretedirtext@gmail.com';
  return raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}

function boardPhones() {
  const raw = process.env.BOARD_NOTIFY_PHONE || process.env.BOARD_NOTIFY_SMS || '4245475594';
  return raw.split(/[,;]/).map((s) => toE164(s)).filter(Boolean);
}

function fromEmail() {
  return process.env.SENDGRID_FROM_EMAIL || process.env.SENDGRID_FROM || 'notifications@hibretedir.com';
}

function replyToEmail() {
  return process.env.SENDGRID_REPLY_TO || process.env.SENDGRID_REPLY || 'hibretedirtext@gmail.com';
}

function fromSms() {
  return process.env.TWILIO_FROM || process.env.TWILIO_PHONE || null;
}

/** Member-facing links (application, portal). Prefer PUBLIC_SITE_URL; avoid broken custom domains. */
function getPublicSiteUrl() {
  const raw = process.env.PUBLIC_SITE_URL
    || process.env.URL
    || (process.env.NODE_ENV === 'development' ? `http://localhost:${process.env.PORT || 8888}` : null)
    || 'https://hibret-edir.netlify.app';
  return String(raw).replace(/\/$/, '');
}

function getNotifyConfig() {
  const sendgridKey = process.env.SENDGRID_API_KEY;
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  const smsFrom = fromSms();
  return {
    email: {
      configured: Boolean(sendgridKey),
      from: fromEmail(),
      replyTo: replyToEmail(),
      boardRecipients: boardEmails(),
    },
    sms: {
      configured: Boolean(twilioSid && twilioToken && smsFrom),
      from: smsFrom,
      boardRecipients: boardPhones(),
    },
  };
}

async function sendEmail({ to, subject, text, html, disableTracking = true }) {
  const key = process.env.SENDGRID_API_KEY;
  if (!key) {
    console.warn('[notify] SENDGRID_API_KEY not set — email skipped:', subject, '→', to);
    return { ok: false, skipped: true, channel: 'Email' };
  }
  const body = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: fromEmail(), name: 'Hibret Edir' },
    reply_to: { email: replyToEmail(), name: 'Hibret Edir' },
    subject,
    content: [{ type: 'text/plain', value: text || subject }],
  };
  if (html) {
    body.content.push({ type: 'text/html', value: html });
  }
  if (disableTracking) {
    body.tracking_settings = {
      click_tracking: { enable: false },
      open_tracking: { enable: false },
    };
  }
  const res = await fetchFn('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error('[notify] SendGrid error', res.status, errText);
    return { ok: false, channel: 'Email', error: errText || String(res.status) };
  }
  return { ok: true, channel: 'Email' };
}

async function sendSms({ to, body }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = fromSms();
  const dest = toE164(to);
  if (!sid || !token || !from) {
    console.warn('[notify] Twilio not configured — SMS skipped:', body?.slice(0, 60));
    return { ok: false, skipped: true, channel: 'SMS' };
  }
  if (!dest) {
    return { ok: false, skipped: true, channel: 'SMS', error: 'invalid phone' };
  }
  const params = new URLSearchParams();
  params.set('To', dest);
  params.set('From', from);
  params.set('Body', body);
  const res = await fetchFn(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[notify] Twilio error', data);
    return { ok: false, channel: 'SMS', error: data.message || String(res.status) };
  }
  return { ok: true, channel: 'SMS', sid: data.sid };
}

async function logNotification(db, { memberId, type, message, status }) {
  if (!db) return;
  try {
    await db.query(
      `INSERT INTO notifications (member_id, type, message, status, sent_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [memberId || null, type, message, status || 'Sent']
    );
  } catch (err) {
    console.warn('[notify] could not log notification:', err.message);
  }
}

async function notifyMember({ db, memberId, email, phone, subject, text, html, smsText }) {
  const results = [];
  if (email) {
    const r = await sendEmail({ to: email, subject, text, html });
    results.push(r);
    await logNotification(db, {
      memberId,
      type: 'Email',
      message: `${subject} → ${email}`,
      status: r.ok ? 'Sent' : (r.skipped ? 'Skipped' : 'Failed'),
    });
  }
  const smsBody = smsText || text;
  if (phone && smsBody) {
    const r = await sendSms({ to: phone, body: smsBody });
    results.push(r);
    await logNotification(db, {
      memberId,
      type: 'SMS',
      message: smsBody.slice(0, 500),
      status: r.ok ? 'Sent' : (r.skipped ? 'Skipped' : 'Failed'),
    });
  }
  return results;
}

async function notifyBoard({ db, subject, text, smsText }) {
  const results = [];
  for (const email of boardEmails()) {
    const r = await sendEmail({ to: email, subject, text });
    results.push(r);
    await logNotification(db, {
      memberId: null,
      type: 'Email-Board',
      message: `${subject} → ${email}`,
      status: r.ok ? 'Sent' : (r.skipped ? 'Skipped' : 'Failed'),
    });
  }
  const smsBody = smsText || text;
  for (const phone of boardPhones()) {
    const r = await sendSms({ to: phone, body: smsBody });
    results.push(r);
    await logNotification(db, {
      memberId: null,
      type: 'SMS-Board',
      message: smsBody.slice(0, 500),
      status: r.ok ? 'Sent' : (r.skipped ? 'Skipped' : 'Failed'),
    });
  }
  return results;
}

function formatChanges(changes) {
  return Object.entries(changes)
    .map(([field, v]) => `- ${field}: ${v.from || '(empty)'} → ${v.to || '(empty)'}`)
    .join('\n');
}

async function notifyProfileUpdate(db, member, changes) {
  if (!changes || !Object.keys(changes).length) return;
  const name = member.full_name || `${member.first_name || ''} ${member.last_name || ''}`.trim();
  const detail = formatChanges(changes);
  const subject = `Hibret Edir — profile updated: ${name}`;
  const text = `Member ${name} (#${member.member_number || member.id}) updated their profile:\n\n${detail}\n\nIf this was not authorized, contact the board immediately.`;
  const sms = `Hibret Edir: Your profile was updated (${Object.keys(changes).join(', ')}). Call (424) 547-5594 if this wasn't you.`;

  await notifyMember({
    db,
    memberId: member.id,
    email: member.email,
    phone: member.mobile || member.home_phone,
    subject: 'Hibret Edir — your profile was updated',
    text: `Hello ${name},\n\nWe saved changes to your Hibret Edir member profile:\n\n${detail}\n\nIf you did not make this change, call (424) 547-5594 immediately.`,
    smsText: sms,
  });
  await notifyBoard({
    db,
    subject,
    text,
    smsText: `Hibret Edir board: ${name} updated profile (${Object.keys(changes).join(', ')}). Review in admin CRM.`,
  });
}

function memberDisplayName(member) {
  return member.full_name || `${member.first_name || ''} ${member.last_name || ''}`.trim() || 'Member';
}

function securityFooter() {
  return '\n\nIf you did not authorize this change, call (424) 547-5594 immediately.';
}

function securitySmsSuffix() {
  return ' Call (424) 547-5594 if this was not you.';
}

function formatBeneficiaryDetail(beneficiary) {
  return `Beneficiary: ${beneficiary.name}\nRelationship: ${beneficiary.relationship || '—'}\nPhone: ${beneficiary.phone || '—'}`;
}

async function notifyBeneficiaryUpdate(db, member, beneficiary, isNew) {
  const name = memberDisplayName(member);
  const action = isNew ? 'added' : 'updated';
  const detail = formatBeneficiaryDetail(beneficiary);
  await notifyMember({
    db,
    memberId: member.id,
    email: member.email,
    phone: member.mobile || member.home_phone,
    subject: `Hibret Edir — beneficiary ${action}`,
    text: `Hello ${name},\n\nYour death beneficiary on file was ${action}:\n\n${detail}\n\nKeep this information current so your family is protected.${securityFooter()}`,
    smsText: `Hibret Edir: Beneficiary ${action} on your account.${securitySmsSuffix()}`,
  });
  await notifyBoard({
    db,
    subject: `Hibret Edir — beneficiary ${action}: ${name}`,
    text: `Member ${name} (#${member.member_number || member.id}) ${action} beneficiary:\n\n${detail}`,
    smsText: `Hibret Edir: ${name} ${action} beneficiary ${beneficiary.name}.`,
  });
}

async function notifyBeneficiaryChangeRequested(db, member, beneficiary, isNew, previous) {
  const name = memberDisplayName(member);
  const action = isNew ? 'add a beneficiary' : 'update your beneficiary';
  const detail = formatBeneficiaryDetail(beneficiary);
  const prevBlock = previous?.name
    ? `\n\nPrevious beneficiary on file:\n${formatBeneficiaryDetail(previous)}`
    : '';
  await notifyMember({
    db,
    memberId: member.id,
    email: member.email,
    phone: member.mobile || member.home_phone,
    subject: 'Hibret Edir — beneficiary change submitted',
    text: `Hello ${name},\n\nWe received your request to ${action}. The board will review before it is saved:\n\n${detail}${prevBlock}\n\nYou will receive another email and text when the board approves or declines this request.${securityFooter()}`,
    smsText: `Hibret Edir: We received your beneficiary change request. Board review pending.${securitySmsSuffix()}`,
  });
}

async function notifyBeneficiaryChangeApproved(db, member, beneficiary, isNew, previous) {
  const name = memberDisplayName(member);
  const action = isNew ? 'added' : 'updated';
  const detail = formatBeneficiaryDetail(beneficiary);
  const prevBlock = previous?.name
    ? `\n\nReplaced:\n${formatBeneficiaryDetail(previous)}`
    : '';
  await notifyMember({
    db,
    memberId: member.id,
    email: member.email,
    phone: member.mobile || member.home_phone,
    subject: `Hibret Edir — beneficiary change approved`,
    text: `Hello ${name},\n\nThe board approved your beneficiary change. Your death beneficiary on file was ${action}:\n\n${detail}${prevBlock}\n\nSign in to the member portal to review your profile.${securityFooter()}`,
    smsText: `Hibret Edir: Your beneficiary change was approved.${securitySmsSuffix()}`,
  });
  await notifyBoard({
    db,
    subject: `Hibret Edir — beneficiary change approved: ${name}`,
    text: `Board approved beneficiary change for ${name} (#${member.member_number || member.id}):\n\n${detail}`,
    smsText: `Hibret Edir: Beneficiary change approved for ${name}.`,
  });
}

async function notifyBeneficiaryChangeRejected(db, member, beneficiary, notes) {
  const name = memberDisplayName(member);
  const detail = formatBeneficiaryDetail(beneficiary);
  const noteBlock = notes ? `\n\nBoard note: ${notes}` : '';
  await notifyMember({
    db,
    memberId: member.id,
    email: member.email,
    phone: member.mobile || member.home_phone,
    subject: 'Hibret Edir — beneficiary change not approved',
    text: `Hello ${name},\n\nThe board did not approve your recent beneficiary change request:\n\n${detail}${noteBlock}\n\nYour previous beneficiary information remains on file. Contact (424) 547-5594 if you have questions.${securityFooter()}`,
    smsText: `Hibret Edir: Your beneficiary change was not approved. Previous info unchanged.${securitySmsSuffix()}`,
  });
}

async function notifyWaitingListInvited(db, row) {
  const name = row.full_name || `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'Applicant';
  const applyUrl = `${getPublicSiteUrl()}/apply`;
  const text = [
    `Hello ${name},`,
    '',
    'Great news — the Hibret Edir board has invited you to complete the full membership application.',
    '',
    `Apply here: ${applyUrl}`,
    '',
    'Use the same email and phone from your waiting list sign-up to verify your spot.',
    '',
    'After you submit the application, the board will review your information and California ID.',
    'If approved, you will receive a PayPal invoice for the $200 registration fee. Membership activates when payment is received.',
    '',
    'Questions? Call (424) 547-5594.',
  ].join('\n');
  const html = [
    `<p>Hello ${name},</p>`,
    '<p>Great news — the Hibret Edir board has invited you to complete the full membership application.</p>',
    `<p><a href="${applyUrl}">Apply for membership</a></p>`,
    '<p>Use the same email and phone from your waiting list sign-up to verify your spot.</p>',
    '<p>After you submit the application, the board will review your information and California ID.',
    ' If approved, you will receive a PayPal invoice for the registration fee. Membership activates when payment is received.</p>',
    '<p>Questions? Call (424) 547-5594.</p>',
  ].join('\n');
  await notifyMember({
    db,
    memberId: null,
    email: row.email,
    phone: row.phone,
    subject: 'Hibret Edir — invited to apply for membership',
    text,
    html,
    smsText: `Hibret Edir: You're invited to apply. ${applyUrl} — verify with your waiting list email/phone.`,
  });
}

async function notifyApplicationSubmitted(db, app) {
  const name = app.member_full_name || 'Applicant';
  const adminUrl = process.env.ADMIN_SITE_URL || process.env.URL || '';
  const reviewHint = adminUrl ? `\n\nReview in admin: ${adminUrl.replace(/\/$/, '')}/admin/` : '\n\nReview in Admin → Applications.';
  await notifyMember({
    db,
    memberId: null,
    email: app.email,
    phone: app.cell_phone || app.home_phone,
    subject: 'Hibret Edir — application received',
    text: `Hello ${name},\n\nWe received your Hibret Edir membership application. The board will review:\n- Name match with waiting list\n- Full application details\n- California ID\n\nIf approved, you will receive a PayPal invoice for the $200 registration fee. Membership activates when payment is received.`,
    smsText: `Hibret Edir: Application received for ${name}. Board review in progress.`,
  });
  await notifyBoard({
    db,
    subject: `New membership application — ${name}`,
    text: `A new membership application was submitted.\n\nApplicant: ${name}\nEmail: ${app.email || '—'}\nPhone: ${app.cell_phone || app.home_phone || '—'}\nApplication #${app.id}${reviewHint}`,
    smsText: `Hibret Edir: New application from ${name}. Review in Admin → Applications.`,
  });
}

async function notifyRegistrationInvoiceSent(db, app, invoiceResult) {
  const name = app.member_full_name || 'Applicant';
  const amount = invoiceResult.amount || 200;
  const link = invoiceResult.paypal_link;
  const linkLine = link ? `\n\nPay your invoice: ${link}` : '';
  const paypalNote = invoiceResult.skipped
    ? '\n\nThe board will contact you with payment instructions.'
    : `\n\nA $${amount} PayPal invoice has been sent to your email.${linkLine}\n\nYour membership activates automatically when payment is received.`;

  await notifyMember({
    db,
    memberId: null,
    email: app.email || invoiceResult.recipient_email,
    phone: app.cell_phone || app.home_phone,
    subject: 'Hibret Edir — registration fee invoice',
    text: `Hello ${name},\n\nYour membership application was approved by the board.${paypalNote}`,
    smsText: `Hibret Edir: Application approved for ${name}. Check email for $${amount} registration invoice.`,
  });
  await notifyBoard({
    db,
    subject: `Registration invoice sent — ${name}`,
    text: `Board approved ${name}'s application and sent the $${amount} registration invoice.\n\nApplication #${app.id}${link ? `\nPayPal link: ${link}` : ''}\n\nMember will be added automatically when PayPal confirms payment.`,
    smsText: `Hibret Edir: Registration invoice sent to ${name}.`,
  });
}

async function notifyApplicationApproved(db, app, member) {
  const name = member.full_name || app.member_full_name;
  await notifyMember({
    db,
    memberId: member.id,
    email: member.email || app.email,
    phone: member.mobile || app.cell_phone,
    subject: 'Hibret Edir — membership approved',
    text: `Congratulations ${name}!\n\nYour membership application was approved. You are now member #${member.member_number} in Hibret Edir.\n\nSign in to the member portal with your phone number to view invoices and update your profile.`,
    smsText: `Hibret Edir: Welcome! Your membership was approved. Member #${member.member_number}. Portal: hibretedir.com/portal`,
  });
}

function escapeHtmlEmail(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Branded HTML + plain text for board replies to contact / portal messages. */
function buildBoardReplyEmail({ memberName, reply, isLoginHelp = false, showPortalLink = false, portalUrl = null }) {
  const name = String(memberName || 'Member').trim() || 'Member';
  const replyBody = String(reply || '').trim();
  const siteUrl = getPublicSiteUrl();
  const portalHref = portalUrl || `${siteUrl}/portal/`;

  let introPlain;
  let footerPlain;
  if (isLoginHelp) {
    introPlain = 'The Hibret Edir board replied to your member portal login help request:';
    footerPlain = 'If you still need help signing in, reply to this email or call (424) 547-5594.';
  } else if (showPortalLink) {
    introPlain = 'The board replied to your message:';
    footerPlain = `You can also view this in the Member Portal:\n${portalHref}`;
  } else {
    introPlain = 'The Hibret Edir board replied to your message:';
    footerPlain = 'If you have questions, reply to this email or call (424) 547-5594.';
  }

  const text = [
    `Hello ${name},`,
    '',
    introPlain,
    '',
    replyBody,
    '',
    footerPlain,
  ].join('\n');

  const introHtml = isLoginHelp
    ? 'The Hibret Edir board replied to your <strong>login help</strong> request:'
    : showPortalLink
      ? 'The board replied to your message:'
      : 'The Hibret Edir board replied to your message:';

  const footerHtml = isLoginHelp
    ? 'If you still need help signing in, reply to this email or call <a href="tel:4245475594" style="color:#078930;text-decoration:none;font-weight:600;">(424) 547-5594</a>.'
    : showPortalLink
      ? 'You can also read this thread anytime in the member portal.'
      : 'If you have questions, reply to this email or call <a href="tel:4245475594" style="color:#078930;text-decoration:none;font-weight:600;">(424) 547-5594</a>.';

  const portalButton = showPortalLink
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 0;">
        <tr><td style="border-radius:8px;background:#078930;">
          <a href="${escapeHtmlEmail(portalHref)}" style="display:inline-block;padding:12px 22px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">Open Member Portal</a>
        </td></tr>
      </table>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hibret Edir</title>
</head>
<body style="margin:0;padding:0;background:#eef2ee;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2ee;padding:28px 14px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #d8e3d8;box-shadow:0 8px 28px rgba(26,46,26,0.08);">
          <tr>
            <td style="background:linear-gradient(135deg,#065a22 0%,#078930 100%);padding:22px 26px;text-align:center;">
              <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#fcdd09;font-weight:700;">Hibret Edir Association</div>
              <div style="margin-top:6px;font-size:22px;line-height:1.25;font-weight:700;color:#ffffff;">Message from the Board</div>
            </td>
          </tr>
          <tr>
            <td style="padding:26px 26px 8px;font-size:15px;line-height:1.65;color:#1a2e1a;">
              <p style="margin:0 0 14px;">Hello <strong>${escapeHtmlEmail(name)}</strong>,</p>
              <p style="margin:0 0 18px;color:#4a554a;">${introHtml}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 26px 22px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6faf6;border:1px solid #cfe0cf;border-left:4px solid #078930;border-radius:0 10px 10px 0;">
                <tr>
                  <td style="padding:18px 20px;font-size:15px;line-height:1.7;color:#1a2e1a;white-space:pre-wrap;font-family:Georgia,'Times New Roman',serif;">${escapeHtmlEmail(replyBody)}</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 26px 26px;font-size:14px;line-height:1.65;color:#4a554a;">
              <p style="margin:0 0 16px;">${footerHtml}</p>
              ${portalButton}
            </td>
          </tr>
          <tr>
            <td style="background:#1a2e1a;padding:18px 24px;text-align:center;font-size:12px;line-height:1.6;color:#b8c4b8;">
              <div style="margin-bottom:6px;color:#eef4ee;font-weight:600;">Hibret Edir Association · Los Angeles</div>
              <a href="tel:4245475594" style="color:#fcdd09;text-decoration:none;">(424) 547-5594</a>
              &nbsp;·&nbsp;
              <a href="mailto:hibretedirtext@gmail.com" style="color:#fcdd09;text-decoration:none;">hibretedirtext@gmail.com</a>
              &nbsp;·&nbsp;
              <a href="${escapeHtmlEmail(siteUrl)}" style="color:#fcdd09;text-decoration:none;">hibretedir.com</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { text, html };
}

async function notifyApplicationRejected(db, app, notes) {
  const name = app.member_full_name || 'Applicant';
  await notifyMember({
    db,
    memberId: null,
    email: app.email,
    phone: app.cell_phone || app.home_phone,
    subject: 'Hibret Edir — application update',
    text: `Hello ${name},\n\nThank you for your membership application. After board review, we are unable to approve it at this time.\n\n${notes ? `Note: ${notes}\n\n` : ''}Questions? Call (424) 547-5594.`,
    smsText: `Hibret Edir: Your application was not approved at this time. Call (424) 547-5594 with questions.`,
  });
}

module.exports = {
  sendEmail,
  sendSms,
  getNotifyConfig,
  getPublicSiteUrl,
  buildBoardReplyEmail,
  logNotification,
  notifyMember,
  notifyBoard,
  notifyProfileUpdate,
  notifyBeneficiaryUpdate,
  notifyBeneficiaryChangeRequested,
  notifyBeneficiaryChangeApproved,
  notifyBeneficiaryChangeRejected,
  notifyWaitingListInvited,
  notifyApplicationSubmitted,
  notifyRegistrationInvoiceSent,
  notifyApplicationApproved,
  notifyApplicationRejected,
};

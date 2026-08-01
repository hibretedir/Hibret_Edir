/**
 * Render Profile membership card → PNG and email it (matches portal Profile).
 * Usage:
 *   node scripts/send_digital_id_email.js [--member 52] [--to a@x.com] [--cc a@x.com]
 *   node scripts/send_digital_id_email.js --all-board [--cc a@x.com]
 * Default CC (when --cc omitted): DIGITAL_ID_CC_EMAIL or BOARD_NOTIFY_EMAIL from env.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Pool } = require('pg');
const { sendEmail } = require('../netlify/functions/notify');

const PORTAL_URL = 'https://hibretedir.com/portal/';
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

function findBrowser() {
  for (const p of CHROME_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function joinYear(row) {
  const raw = row.joined_date || row.created_at;
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    const m = String(raw).match(/(\d{4})/);
    return m ? m[1] : '';
  }
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
  }).format(d);
}

function cardName(row) {
  const paypal = String(row.paypal_name || '').trim();
  if (paypal) return paypal;
  const fl = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  if (fl) return fl;
  return String(row.full_name || '').split('/')[0].trim() || 'Member';
}

function pathToFileUrl(filePath) {
  const resolved = path.resolve(filePath).replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(resolved)) {
    return `file:///${resolved}`;
  }
  return `file://${resolved}`;
}

function cropWhitePadding(pngPath) {
  // Use PowerShell/.NET so we don't add image deps.
  const ps = `
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Bitmap]::FromFile(${JSON.stringify(pngPath)})
$minX=$img.Width; $minY=$img.Height; $maxX=0; $maxY=0
for ($y=0; $y -lt $img.Height; $y++) {
  for ($x=0; $x -lt $img.Width; $x++) {
    $c=$img.GetPixel($x,$y)
    if ($c.A -gt 8 -and ($c.R -lt 245 -or $c.G -lt 245 -or $c.B -lt 245)) {
      if ($x -lt $minX) { $minX=$x }
      if ($y -lt $minY) { $minY=$y }
      if ($x -gt $maxX) { $maxX=$x }
      if ($y -gt $maxY) { $maxY=$y }
    }
  }
}
if ($maxX -le $minX -or $maxY -le $minY) { $img.Dispose(); exit 0 }
$pad=4
$minX=[Math]::Max(0,$minX-$pad); $minY=[Math]::Max(0,$minY-$pad)
$maxX=[Math]::Min($img.Width-1,$maxX+$pad); $maxY=[Math]::Min($img.Height-1,$maxY+$pad)
$rect = New-Object System.Drawing.Rectangle $minX,$minY,($maxX-$minX+1),($maxY-$minY+1)
$cropped = $img.Clone($rect, $img.PixelFormat)
$tmp = ${JSON.stringify(pngPath)} + '.crop.png'
$cropped.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
$cropped.Dispose(); $img.Dispose()
Move-Item -Force $tmp ${JSON.stringify(pngPath)}
`;
  const result = spawnSync('powershell', ['-NoProfile', '-Command', ps], {
    encoding: 'utf8',
    timeout: 120000,
  });
  if (result.status !== 0) {
    console.warn('Crop skipped:', result.stderr || result.stdout || result.status);
  }
}

function renderCardPng({ name, number, status, since, outPath }) {
  const browser = findBrowser();
  if (!browser) throw new Error('Chrome/Edge not found for card render.');

  const htmlPath = path.join(__dirname, 'membership-card-render.html');
  const logoPath = path.join(__dirname, '../public/logo.png');
  if (!fs.existsSync(logoPath)) throw new Error(`Missing logo: ${logoPath}`);

  const qs = new URLSearchParams({
    logo: pathToFileUrl(logoPath),
    name,
    number: String(number),
    status,
    since: since || '',
  });
  const pageUrl = `${pathToFileUrl(htmlPath)}?${qs.toString()}&_=${Date.now()}`;

  const outDir = path.dirname(outPath);
  fs.mkdirSync(outDir, { recursive: true });
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--default-background-color=00000000',
    '--force-device-scale-factor=2',
    '--window-size=540,300',
    `--screenshot=${outPath}`,
    '--virtual-time-budget=4000',
    pageUrl,
  ];
  const result = spawnSync(browser, args, { encoding: 'utf8', timeout: 60000 });
  if (result.status !== 0) {
    throw new Error(`Card render failed: ${result.stderr || result.stdout || result.status}`);
  }
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) {
    throw new Error('Card screenshot was not created.');
  }
  cropWhitePadding(outPath);
  return outPath;
}

function buildEmail({ name, number, cardCid }) {
  const text = [
    `Hello ${name},`,
    '',
    'How do you like your Digital Membership ID?',
    '',
    `Name: ${name}`,
    `Member #: ${number}`,
    '',
    `Open the Member Portal:`,
    PORTAL_URL,
    '',
    'Hibret Edir Association · Greater Los Angeles',
    '(424) 547-5594',
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your Hibret Edir Digital ID</title>
</head>
<body style="margin:0;padding:0;background:#eef2ee;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2ee;padding:28px 14px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #d8e3d8;">
          <tr>
            <td style="background:linear-gradient(135deg,#065a22 0%,#078930 100%);padding:20px 24px;text-align:center;">
              <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#fcdd09;font-weight:700;">Hibret Edir Association</div>
              <div style="margin-top:6px;font-size:20px;line-height:1.25;font-weight:700;color:#ffffff;">Your Digital Membership ID</div>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 22px 8px;font-size:15px;line-height:1.65;color:#1a2e1a;">
              <p style="margin:0 0 14px;">Hello <strong>${escapeHtml(name)}</strong>,</p>
              <p style="margin:0 0 18px;color:#4a554a;">How do you like your Digital Membership ID?</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 16px 22px;" align="center">
              <img src="cid:${cardCid}" alt="Hibret Edir digital membership card — ${escapeHtml(name)}, Member #${escapeHtml(number)}" width="520" style="display:block;width:100%;max-width:520px;height:auto;border:0;border-radius:14px;">
            </td>
          </tr>
          <tr>
            <td style="padding:0 22px 26px;" align="center">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr><td style="border-radius:8px;background:#078930;">
                  <a href="${escapeHtml(PORTAL_URL)}" style="display:inline-block;padding:12px 22px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">Open Member Portal</a>
                </td></tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background:#1a2e1a;padding:18px 24px;text-align:center;font-size:12px;line-height:1.6;color:#b8c4b8;">
              <div style="margin-bottom:6px;color:#eef4ee;font-weight:600;">Hibret Edir Association · Los Angeles</div>
              <a href="tel:4245475594" style="color:#fcdd09;text-decoration:none;">(424) 547-5594</a>
              &nbsp;·&nbsp;
              <a href="https://hibretedir.com" style="color:#fcdd09;text-decoration:none;">hibretedir.com</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return {
    subject: `Hibret Edir — your digital membership ID (#${number})`,
    text,
    html,
  };
}

async function loadBoardRecipients(client) {
  const result = await client.query(
    `SELECT bm.id AS board_id,
            bm.display_name,
            bm.email AS board_email,
            m.id,
            m.member_number,
            m.first_name,
            m.last_name,
            m.full_name,
            m.paypal_name,
            m.email AS member_email,
            m.status,
            m.joined_date,
            m.created_at
     FROM board_members bm
     INNER JOIN members m ON m.id = bm.member_id
     WHERE bm.is_active = TRUE
       AND LOWER(COALESCE(bm.role, '')) <> 'advisor'
       AND COALESCE(TRIM(bm.email), '') <> ''
     ORDER BY COALESCE(NULLIF(TRIM(bm.display_name), ''), bm.email)`
  );
  return result.rows;
}

async function sendOneCard(row, { toEmail, ccEmails = [] }) {
  const name = cardName(row);
  const number = row.member_number || row.id;
  const status = String(row.status || 'Active');
  const since = joinYear(row);

  const outPath = path.join(__dirname, '../data/tmp', `membership-card-${number}.png`);
  console.log(`Rendering #${number} ${name}…`);
  renderCardPng({ name, number, status, since, outPath });

  const cardCid = 'membership-card';
  const mail = buildEmail({ name, number, cardCid });
  const cardB64 = fs.readFileSync(outPath).toString('base64');
  const fileName = `hibret-edir-member-${number}.png`;

  const toNorm = String(toEmail).trim().toLowerCase();
  const cc = ccEmails
    .map((e) => String(e || '').trim())
    .filter(Boolean)
    .filter((e, i, arr) => arr.findIndex((x) => x.toLowerCase() === e.toLowerCase()) === i)
    .filter((e) => e.toLowerCase() !== toNorm);

  const mask = (e) => e.replace(/(.{2}).+(@.+)/, '$1***$2');
  console.log(`Sending #${number} → ${mask(toEmail)}${cc.length ? ` (cc ${cc.map(mask).join(', ')})` : ''}…`);

  const sent = await sendEmail({
    to: toEmail,
    cc: cc.length ? cc : null,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    attachments: [
      {
        content: cardB64,
        type: 'image/png',
        filename: fileName,
        disposition: 'inline',
        contentId: cardCid,
      },
      {
        content: cardB64,
        type: 'image/png',
        filename: fileName,
        disposition: 'attachment',
      },
    ],
  });
  console.log(JSON.stringify(sent));
  return sent;
}

async function main() {
  const args = process.argv.slice(2);
  const allBoard = args.includes('--all-board');
  const memberIdx = args.indexOf('--member');
  const memberNumber = memberIdx >= 0 ? Number(args[memberIdx + 1]) : 52;
  const toIdx = args.indexOf('--to');
  const toOverride = toIdx >= 0
    ? String(args[toIdx + 1] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    : null;
  const ccIdx = args.indexOf('--cc');
  const ccEmails = ccIdx >= 0
    ? String(args[ccIdx + 1] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    : String(process.env.DIGITAL_ID_CC_EMAIL || process.env.BOARD_NOTIFY_EMAIL || '')
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean);

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 15000,
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();
  try {
    if (allBoard) {
      const rows = await loadBoardRecipients(client);
      if (!rows.length) throw new Error('No active board members with linked CRM records found.');
      console.log(`Board blast: ${rows.length} recipients; CC ${ccEmails.join(', ') || '(none)'}`);
      let failed = 0;
      for (const row of rows) {
        const toEmail = row.board_email || row.member_email;
        if (!toEmail) {
          console.warn(`Skip ${row.display_name || row.paypal_name}: no email`);
          failed += 1;
          continue;
        }
        const sent = await sendOneCard(row, { toEmail, ccEmails });
        if (!sent.ok) failed += 1;
      }
      if (failed) process.exitCode = 1;
      console.log(`Done. failures=${failed}`);
      return;
    }

    const result = await client.query(
      `SELECT id, member_number, first_name, last_name, full_name, paypal_name, email, status, joined_date, created_at
       FROM members
       WHERE member_number = $1
       LIMIT 1`,
      [memberNumber]
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Member #${memberNumber} not found`);
    const toEmail = (toOverride && toOverride[0]) || row.email;
    if (!toEmail) throw new Error(`Member #${memberNumber} has no email on file`);

    // Optional extra TO addresses from --to a,b,c (first is primary; rest go as additional TO via cc-filtered send)
    const extraTo = (toOverride || []).slice(1);
    const sent = await sendOneCard(row, {
      toEmail,
      ccEmails: [...ccEmails, ...extraTo],
    });
    if (!sent.ok) process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

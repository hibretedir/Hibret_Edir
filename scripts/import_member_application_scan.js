/**
 * Import a scanned application PDF into members.application_scan for in-Admin preview.
 * Appends to files[] when a scan already exists (unless --replace).
 *
 * Example:
 *   node scripts/import_member_application_scan.js --member 232 --file "G:/My Drive/.../Yonas.pdf"
 *   node scripts/import_member_application_scan.js --member 233 --file "..." --replace
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { normalizeExistingFiles } = require('./lib/application-scan-sync');

function parseArgs(argv) {
  const out = { member: null, file: null, replace: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--member') out.member = argv[++i];
    else if (a.startsWith('--member=')) out.member = a.slice('--member='.length);
    else if (a === '--file') out.file = argv[++i];
    else if (a.startsWith('--file=')) out.file = a.slice('--file='.length);
    else if (a === '--replace') out.replace = true;
  }
  return out;
}

function mimeFromName(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

(async () => {
  const args = parseArgs(process.argv);
  const memberNum = Number(args.member);
  const filePath = args.file ? path.resolve(args.file) : '';
  if (!Number.isFinite(memberNum) || memberNum <= 0) {
    console.error('Usage: --member <member_number> --file <path-to-pdf> [--replace]');
    process.exit(1);
  }
  if (!filePath || !fs.existsSync(filePath)) {
    console.error('File not found:', filePath || '(missing --file)');
    process.exit(1);
  }

  const buf = fs.readFileSync(filePath);
  const maxBytes = 4.5 * 1024 * 1024;
  if (buf.length > maxBytes) {
    console.error(`File too large (${buf.length} bytes). Max ${maxBytes} bytes.`);
    process.exit(1);
  }

  const mime = mimeFromName(filePath);
  const incoming = {
    filename: path.basename(filePath),
    mime_type: mime,
    data: buf.toString('base64'),
    uploaded_at: new Date().toISOString(),
    source: 'local-import',
    byte_size: buf.length,
  };

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 20000,
    ssl: process.env.DATABASE_URL?.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query('ALTER TABLE members ADD COLUMN IF NOT EXISTS application_scan JSONB');
    const found = await client.query(
      `SELECT id, member_number, first_name, last_name, application_scan
       FROM members WHERE member_number = $1 LIMIT 1`,
      [memberNum]
    );
    if (!found.rows[0]) {
      console.error('No CRM member with member_number', memberNum);
      process.exit(1);
    }
    const m = found.rows[0];
    const existing = args.replace ? [] : normalizeExistingFiles(m.application_scan);
    const withoutSameName = existing.filter(
      (f) => String(f.filename || '').toLowerCase() !== incoming.filename.toLowerCase()
    );
    const files = [...withoutSameName, incoming];
    const scan = {
      files,
      uploaded_at: new Date().toISOString(),
      source: 'local-import',
      filename: files[0].filename,
      mime_type: files[0].mime_type,
      byte_size: files[0].byte_size,
    };
    await client.query(
      `UPDATE members SET application_scan = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(scan), m.id]
    );
    console.log(
      `Imported ${incoming.filename} (${incoming.byte_size} bytes) → member #${m.member_number} ${m.first_name || ''} ${m.last_name || ''} (${files.length} file(s) total)`
    );
  } finally {
    await client.end();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

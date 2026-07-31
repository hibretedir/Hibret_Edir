/**
 * Force-import all PDFs for one member folder into application_scan.files[].
 *   node scripts/reimport_member_scans.js --member 233
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const {
  DEFAULT_ROOT,
  listScanFolders,
  MAX_BYTES,
} = require('./lib/application-scan-sync');

function parseArgs(argv) {
  const out = { member: null, root: DEFAULT_ROOT };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--member') out.member = Number(argv[++i]);
    else if (a === '--root') out.root = argv[++i];
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv);
  if (!Number.isFinite(args.member) || args.member <= 0) {
    console.error('Usage: --member <member_number>');
    process.exit(1);
  }
  const listed = listScanFolders(args.root);
  if (listed.error) {
    console.error(listed.error);
    process.exit(1);
  }
  const item = listed.folders.find((f) => f.memberNumber === args.member);
  if (!item) {
    console.error('No scan folder found for member', args.member);
    process.exit(1);
  }
  const usable = item.files.filter((f) => f.byte_size <= MAX_BYTES);
  console.log(`Folder ${item.folder}: ${usable.length} usable file(s)`);
  usable.forEach((f) => console.log(`  - ${f.filename} (${f.byte_size} bytes)`));
  if (!usable.length) process.exit(1);

  const filesPayload = usable.map((f) => {
    const buf = fs.readFileSync(f.filePath);
    return {
      filename: f.filename,
      mime_type: f.mime_type,
      data: buf.toString('base64'),
      uploaded_at: new Date().toISOString(),
      source: 'force-reimport',
      byte_size: buf.length,
      source_mtime_ms: f.mtimeMs,
      source_path: f.filePath,
    };
  });
  const scan = {
    files: filesPayload,
    uploaded_at: new Date().toISOString(),
    source: 'force-reimport',
    filename: filesPayload[0].filename,
    mime_type: filesPayload[0].mime_type,
    byte_size: filesPayload[0].byte_size,
  };

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 30000,
    ssl: process.env.DATABASE_URL?.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const mem = await client.query(
      `SELECT id FROM members WHERE member_number = $1 LIMIT 1`,
      [args.member]
    );
    if (!mem.rows[0]) {
      console.error('Member not found');
      process.exit(1);
    }
    const json = JSON.stringify(scan);
    console.log(`Writing JSONB (~${Math.round(json.length / 1024)} KB)…`);
    await client.query(
      `UPDATE members SET application_scan = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [json, mem.rows[0].id]
    );
    const check = await client.query(
      `SELECT jsonb_array_length(application_scan->'files') AS n,
              (SELECT jsonb_agg(f->>'filename') FROM jsonb_array_elements(application_scan->'files') f) AS names
       FROM members WHERE id = $1`,
      [mem.rows[0].id]
    );
    console.log('Saved:', check.rows[0]);
  } finally {
    await client.end();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

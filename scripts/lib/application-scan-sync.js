/**
 * Shared sync: Drive member folders → members.application_scan (in-Admin PDF).
 * Supports multiple files per member (files[]).
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.join(
  'G:',
  'My Drive',
  'Social',
  'Hibret Edir',
  'Members Scanned Applications'
);

const MAX_BYTES = 4.5 * 1024 * 1024;

function mimeFromName(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return null;
}

function parseMemberNumber(folderName) {
  const m = String(folderName || '').trim().match(/^#\s*(\d+)\b/);
  return m ? Number(m[1]) : null;
}

function normalizeExistingFiles(applicationScan) {
  if (!applicationScan) return [];
  if (Array.isArray(applicationScan.files)) return applicationScan.files;
  if (applicationScan.data && applicationScan.mime_type) return [applicationScan];
  return [];
}

function filesSignature(files) {
  return files
    .map((f) => `${f.filename}|${f.byte_size}|${f.source_mtime_ms || ''}`)
    .sort()
    .join(';');
}

function listScanFolders(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return { error: `Root folder not found: ${rootDir}`, folders: [] };
  }
  const folders = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const memberNumber = parseMemberNumber(entry.name);
    if (!memberNumber) continue;
    const folderPath = path.join(rootDir, entry.name);
    let files = [];
    try {
      files = fs.readdirSync(folderPath, { withFileTypes: true })
        .filter((f) => f.isFile())
        .map((f) => path.join(folderPath, f.name))
        .filter((p) => mimeFromName(p))
        .map((filePath) => {
          const st = fs.statSync(filePath);
          return {
            filePath,
            filename: path.basename(filePath),
            mime_type: mimeFromName(filePath),
            byte_size: st.size,
            mtimeMs: st.mtimeMs,
          };
        })
        .sort((a, b) => a.filename.localeCompare(b.filename));
    } catch (err) {
      folders.push({ memberNumber, folder: entry.name, error: err.message, files: [] });
      continue;
    }
    if (!files.length) continue;
    folders.push({
      memberNumber,
      folder: entry.name,
      files,
    });
  }
  return {
    folders: folders.sort((a, b) => a.memberNumber - b.memberNumber),
  };
}

/**
 * @param {import('pg').Client} client
 * @param {{ root?: string, onlyEmpty?: boolean, dryRun?: boolean, log?: Function }} opts
 */
async function syncApplicationScans(client, opts = {}) {
  const root = opts.root || process.env.APPLICATION_SCANS_ROOT || DEFAULT_ROOT;
  const onlyEmpty = opts.onlyEmpty !== false;
  const dryRun = !!opts.dryRun;
  const log = opts.log || console.log;

  await client.query('ALTER TABLE members ADD COLUMN IF NOT EXISTS application_scan JSONB');

  const listed = listScanFolders(root);
  if (listed.error) {
    return {
      ok: false,
      error: listed.error,
      root,
      imported: 0,
      skipped: 0,
      missingMember: 0,
      tooBig: 0,
      errors: 1,
      found: 0,
    };
  }

  let imported = 0;
  let skipped = 0;
  let missingMember = 0;
  let tooBig = 0;
  let errors = 0;
  const importedMembers = [];

  for (const item of listed.folders) {
    if (item.error) {
      log(`[error] #${item.memberNumber} ${item.folder}: ${item.error}`);
      errors += 1;
      continue;
    }

    const oversized = item.files.filter((f) => f.byte_size > MAX_BYTES);
    const usable = item.files.filter((f) => f.byte_size <= MAX_BYTES);
    if (oversized.length) {
      tooBig += oversized.length;
      for (const f of oversized) log(`[too-big] #${item.memberNumber} ${f.filename}`);
    }
    if (!usable.length) continue;

    const mem = await client.query(
      `SELECT id, member_number, first_name, last_name, application_scan
       FROM members WHERE member_number = $1 LIMIT 1`,
      [item.memberNumber]
    );
    if (!mem.rows[0]) {
      missingMember += 1;
      continue;
    }
    const m = mem.rows[0];
    const existingFiles = normalizeExistingFiles(m.application_scan);
    const incomingSig = filesSignature(
      usable.map((f) => ({
        filename: f.filename,
        byte_size: f.byte_size,
        source_mtime_ms: f.mtimeMs,
      }))
    );
    const existingSig = filesSignature(
      existingFiles.map((f) => ({
        filename: f.filename,
        byte_size: f.byte_size,
        source_mtime_ms: f.source_mtime_ms,
      }))
    );

    if (existingSig === incomingSig) {
      skipped += 1;
      continue;
    }
    // onlyEmpty: skip anyone who already has at least one scan (do not grow/replace)
    if (onlyEmpty && existingFiles.length > 0) {
      skipped += 1;
      continue;
    }
    // DriveFS sometimes lists only one of N files briefly — never shrink an existing multi-file scan.
    if (!opts.allowShrink && existingFiles.length > usable.length) {
      log(
        `[skip-shrink] #${item.memberNumber}: keep ${existingFiles.length} file(s); disk currently lists ${usable.length}`
      );
      skipped += 1;
      continue;
    }

    if (dryRun) {
      log(`[dry-run] #${item.memberNumber} ← ${usable.length} file(s): ${usable.map((f) => f.filename).join(', ')}`);
      imported += 1;
      continue;
    }

    const filesPayload = usable.map((f) => {
      const buf = fs.readFileSync(f.filePath);
      return {
        filename: f.filename,
        mime_type: f.mime_type,
        data: buf.toString('base64'),
        uploaded_at: new Date().toISOString(),
        source: 'auto-sync',
        byte_size: buf.length,
        source_mtime_ms: f.mtimeMs,
        source_path: f.filePath,
      };
    });

    // Store files[] only — do not duplicate base64 at the root (keeps payload smaller).
    const scan = {
      files: filesPayload,
      uploaded_at: new Date().toISOString(),
      source: 'auto-sync',
      filename: filesPayload[0].filename,
      mime_type: filesPayload[0].mime_type,
      byte_size: filesPayload[0].byte_size,
    };

    await client.query(
      `UPDATE members SET application_scan = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(scan), m.id]
    );
    imported += 1;
    importedMembers.push(item.memberNumber);
    log(
      `[imported] #${item.memberNumber} ← ${filesPayload.length} file(s): ${filesPayload.map((f) => f.filename).join(', ')}`
    );
  }

  return {
    ok: true,
    root,
    found: listed.folders.length,
    imported,
    skipped,
    missingMember,
    tooBig,
    errors,
    importedMembers,
    dryRun,
  };
}

/** YYYY-MM-DD in America/Los_Angeles. */
function pacificDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function getDailySyncStampPath() {
  return path.join(__dirname, '..', '..', 'data', 'application-scan-sync-day.txt');
}

function readDailySyncStamp() {
  const stampPath = getDailySyncStampPath();
  try {
    if (!fs.existsSync(stampPath)) return null;
    return String(fs.readFileSync(stampPath, 'utf8') || '').trim() || null;
  } catch (_) {
    return null;
  }
}

function hasSyncedToday() {
  return readDailySyncStamp() === pacificDateKey();
}

function markSyncedToday() {
  const stampPath = getDailySyncStampPath();
  const dir = path.dirname(stampPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stampPath, `${pacificDateKey()}\n`, 'utf8');
}

module.exports = {
  DEFAULT_ROOT,
  MAX_BYTES,
  listScanFolders,
  listScanFiles: listScanFolders, // alias
  syncApplicationScans,
  mimeFromName,
  parseMemberNumber,
  normalizeExistingFiles,
  pacificDateKey,
  getDailySyncStampPath,
  readDailySyncStamp,
  hasSyncedToday,
  markSyncedToday,
};

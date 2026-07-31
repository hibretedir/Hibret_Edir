/**
 * Link CRM members.application_drive_url to Google Drive member folders.
 *
 * Parent folder (scanned applications):
 *   https://drive.google.com/drive/folders/1RC-veuhY2VqR_XdcgUz0u5hYIhc60Yev
 *
 * Usage:
 *   1) Export folder links (Apps Script below, or any Name + URL list)
 *   2) Dry-run:  node scripts/link_member_application_folders.js --map folders.tsv
 *   3) Apply:    node scripts/link_member_application_folders.js --map folders.tsv --apply
 *                node scripts/link_member_application_folders.js --map folders.tsv --apply --only-empty
 *
 * Map file formats (TSV or CSV):
 *   #52 Behailu Aklilu<TAB>https://drive.google.com/drive/folders/xxxx
 *   52<TAB>https://drive.google.com/drive/folders/xxxx
 *   #52,https://drive.google.com/drive/folders/xxxx
 *
 * Google Apps Script (run while the parent folder is open / paste folder ID):
 *   function exportMemberFolderLinks() {
 *     const PARENT_ID = '1RC-veuhY2VqR_XdcgUz0u5hYIhc60Yev';
 *     const folder = DriveApp.getFolderById(PARENT_ID);
 *     const it = folder.getFolders();
 *     const lines = [];
 *     while (it.hasNext()) {
 *       const f = it.next();
 *       lines.push(f.getName() + '\t' + f.getUrl());
 *     }
 *     lines.sort();
 *     console.log(lines.join('\n'));
 *     // Or: DriveApp.getRootFolder().createFile('member-folders.tsv', lines.join('\n'));
 *   }
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const PARENT_FOLDER_ID = process.env.GOOGLE_DRIVE_APPLICATIONS_FOLDER_ID
  || '1RC-veuhY2VqR_XdcgUz0u5hYIhc60Yev';
const PARENT_FOLDER_URL = `https://drive.google.com/drive/folders/${PARENT_FOLDER_ID}`;

function parseArgs(argv) {
  const args = {
    map: null,
    apply: false,
    onlyEmpty: false,
    printExpected: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--only-empty') args.onlyEmpty = true;
    else if (a === '--print-expected') args.printExpected = true;
    else if (a === '--map') args.map = argv[++i];
    else if (a.startsWith('--map=')) args.map = a.slice('--map='.length);
  }
  return args;
}

function folderUrlFromId(id) {
  return `https://drive.google.com/drive/folders/${id}`;
}

function normalizeDriveUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const idMatch = s.match(/\/(?:folders|file\/d)\/([a-zA-Z0-9_-]+)/);
  if (idMatch) {
    if (s.includes('/file/d/')) return `https://drive.google.com/file/d/${idMatch[1]}/view`;
    return folderUrlFromId(idMatch[1]);
  }
  if (/^https?:\/\//i.test(s)) return s;
  // bare folder id
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return folderUrlFromId(s);
  return '';
}

function parseMemberNumber(cell) {
  const s = String(cell || '').trim();
  const m = s.match(/^#?\s*(\d+)\b/);
  return m ? Number(m[1]) : null;
}

function loadMapFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Map file not found: ${abs}`);
  }
  const text = fs.readFileSync(abs, 'utf8');
  const links = new Map(); // member_number -> url
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      // allow "#52 Name\turl" — not a comment when it starts with #digit
      if (!/^#\s*\d+/.test(trimmed)) continue;
    }
    let left = '';
    let right = '';
    if (trimmed.includes('\t')) {
      const parts = trimmed.split('\t');
      left = parts[0];
      right = parts.slice(1).join('\t');
    } else if (trimmed.includes(',')) {
      const idx = trimmed.indexOf(',');
      left = trimmed.slice(0, idx);
      right = trimmed.slice(idx + 1);
    } else {
      const parts = trimmed.split(/\s{2,}/);
      if (parts.length >= 2) {
        left = parts[0];
        right = parts.slice(1).join(' ');
      }
    }
    const num = parseMemberNumber(left);
    const url = normalizeDriveUrl(right);
    if (!num || !url) continue;
    links.set(num, url);
  }
  return links;
}

function primaryFolderLabel(row) {
  const first = String(row.first_name || '').trim();
  const last = String(row.last_name || '').trim();
  if (first || last) return [first, last].filter(Boolean).join(' ');
  const primary = (
    row.paypal_name
    || String(row.full_name || '').split('/')[0]
    || 'Member'
  ).trim();
  return primary.replace(/\s+/g, ' ');
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`Parent applications folder: ${PARENT_FOLDER_URL}`);

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 15000,
    ssl: process.env.DATABASE_URL?.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const { rows: members } = await client.query(`
      SELECT id, member_number, first_name, last_name, paypal_name, full_name,
             application_drive_url, status
      FROM members
      WHERE member_number IS NOT NULL
      ORDER BY member_number ASC
    `);

    if (args.printExpected) {
      for (const m of members) {
        console.log(`#${m.member_number} ${primaryFolderLabel(m)}`);
      }
      console.log(`\nExpected folders: ${members.length}`);
      return;
    }

    if (!args.map) {
      console.log(`
Missing --map file.

Steps:
  1. Open ${PARENT_FOLDER_URL}
  2. Run the Apps Script in this file's header (export Name + URL)
  3. Save as folders.tsv
  4. node scripts/link_member_application_folders.js --map folders.tsv
  5. node scripts/link_member_application_folders.js --map folders.tsv --apply --only-empty

Or print expected folder names:
  node scripts/link_member_application_folders.js --print-expected
`);
      process.exitCode = 1;
      return;
    }

    const links = loadMapFile(args.map);
    console.log(`Loaded ${links.size} folder links from ${args.map}`);

    let matched = 0;
    let skippedHasLink = 0;
    let missingFolder = 0;
    let updated = 0;
    const unmatchedFolders = [...links.keys()].filter(
      (n) => !members.some((m) => Number(m.member_number) === n)
    );

    for (const m of members) {
      const num = Number(m.member_number);
      const url = links.get(num);
      if (!url) {
        missingFolder += 1;
        continue;
      }
      matched += 1;
      const existing = String(m.application_drive_url || '').trim();
      if (args.onlyEmpty && existing) {
        skippedHasLink += 1;
        continue;
      }
      if (existing === url) {
        skippedHasLink += 1;
        continue;
      }

      const label = `#${num} ${primaryFolderLabel(m)}`;
      if (!args.apply) {
        console.log(`[dry-run] ${label} → ${url}${existing ? ` (was: ${existing})` : ''}`);
        continue;
      }

      await client.query(
        `UPDATE members
         SET application_drive_url = $1, updated_at = NOW()
         WHERE id = $2`,
        [url, m.id]
      );
      updated += 1;
      console.log(`[updated] ${label}`);
    }

    console.log('\n---');
    console.log(`Members in CRM:     ${members.length}`);
    console.log(`Matched folders:    ${matched}`);
    console.log(`No folder in map:   ${missingFolder}`);
    console.log(`Unmatched folder #: ${unmatchedFolders.length}${unmatchedFolders.length ? ` (${unmatchedFolders.slice(0, 20).join(', ')})` : ''}`);
    console.log(`Skipped (same/filled): ${skippedHasLink}`);
    if (args.apply) console.log(`Updated:            ${updated}`);
    else console.log('Dry-run only — re-run with --apply to write CRM links.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

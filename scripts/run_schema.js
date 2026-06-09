/**
 * Apply db/schema.sql using DATABASE_URL from .env (no psql required).
 * Usage: npm run db:migrate
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const SCHEMA_PATH = path.join(ROOT, 'db', 'schema.sql');
const CONNECT_TIMEOUT_MS = 15000;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

loadEnvFile(ENV_PATH);

function normalizeDbUrl(url) {
  if (!url) return url;
  return url
    .trim()
    .replace(/^postgressql:\/\//i, 'postgresql://')
    .replace(/^postgres:\/\//i, 'postgresql://');
}

function needsSsl(url) {
  return /render\.com|amazonaws\.com|neon\.tech/i.test(url || '');
}

function loadPg() {
  const candidates = [
    path.join(ROOT, 'node_modules', 'pg'),
    path.join(process.env.TEMP || '', 'hibret-dev', 'node_modules', 'pg'),
    path.join(process.env.TEMP || '', 'hibret-migrate', 'node_modules', 'pg'),
  ];
  for (const dir of candidates) {
    try {
      return require(dir);
    } catch {
      /* try next */
    }
  }
  throw new Error('pg package not found. Run: npm install (or npm run dev once to install temp deps).');
}

async function main() {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) {
    console.error('DATABASE_URL is not set. Add it to .env in the repo root.');
    process.exit(1);
  }

  const connectionString = normalizeDbUrl(rawUrl);
  if (connectionString !== rawUrl.trim()) {
    console.warn('Fixed DATABASE_URL typo (use postgresql:// not postgressql:// in .env).');
  }

  let parsed;
  try {
    parsed = new URL(connectionString.replace(/^postgres:\/\//i, 'postgresql://'));
  } catch (e) {
    console.error('DATABASE_URL is not a valid URL. Copy the full External Database URL from Render.');
    process.exit(1);
  }

  if (!/\.render\.com$/i.test(parsed.hostname)) {
    console.error('DATABASE_URL hostname looks incomplete:', parsed.hostname);
    console.error('It should end with something like: .oregon-postgres.render.com');
    console.error('Render → hibret-edir → Connect → copy External Database URL (full line, one line in .env).');
    process.exit(1);
  }

  if (!fs.existsSync(SCHEMA_PATH)) {
    console.error('Missing file:', SCHEMA_PATH);
    process.exit(1);
  }

  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const { Client } = loadPg();

  const client = new Client({
    connectionString,
    ssl: needsSsl(connectionString) ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: CONNECT_TIMEOUT_MS,
  });

  console.log('Connecting to database…');
  await client.connect();
  console.log('Running db/schema.sql…');

  try {
    await client.query(sql);
    const tables = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    console.log('Migration complete. Tables:', tables.rows.map((r) => r.table_name).join(', '));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});

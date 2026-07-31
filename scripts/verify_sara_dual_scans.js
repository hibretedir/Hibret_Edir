/**
 * Verify Sara #233 dual-scan load path is fast + both files fetchable.
 *   node scripts/verify_sara_dual_scans.js
 */
require('dotenv').config();
const { Client } = require('pg');

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

async function timed(label, fn) {
  const t0 = Date.now();
  const value = await fn();
  return { label, ms: Date.now() - t0, value };
}

(async () => {
  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 20000,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const meta = await timed('meta', async () => {
    const r = await c.query(
      `SELECT
         CASE
           WHEN jsonb_typeof(application_scan->'files') = 'array' THEN (
             SELECT COALESCE(jsonb_agg(
               jsonb_build_object(
                 'filename', f->>'filename',
                 'mime_type', f->>'mime_type',
                 'has_data', (f ? 'data' AND length(COALESCE(f->>'data','')) > 0),
                 'data_len', length(COALESCE(f->>'data',''))
               ) ORDER BY ord
             ), '[]'::jsonb)
             FROM jsonb_array_elements(application_scan->'files') WITH ORDINALITY AS t(f, ord)
           )
           ELSE '[]'::jsonb
         END AS files_meta
       FROM members WHERE member_number = 233`
    );
    const raw = r.rows[0].files_meta;
    return Array.isArray(raw) ? raw : JSON.parse(raw);
  });

  assert(meta.value.length === 2, `expected 2 meta files, got ${meta.value.length}`);
  assert(meta.value[0].filename === 'Sara 1 pdf.pdf', 'file0 name');
  assert(meta.value[1].filename === 'Sara 2 pdf.pdf', 'file1 name');
  assert(meta.value.every((f) => f.has_data), 'has_data');

  const f0 = await timed('file[0]', async () => {
    const r = await c.query(
      `SELECT
         application_scan->'files'->($1::int)->>'filename' AS filename,
         application_scan->'files'->($1::int)->>'mime_type' AS mime_type,
         length(application_scan->'files'->($1::int)->>'data') AS data_len
       FROM members WHERE member_number = 233`,
      [0]
    );
    return r.rows[0];
  });
  const f1 = await timed('file[1]', async () => {
    const r = await c.query(
      `SELECT
         application_scan->'files'->($1::int)->>'filename' AS filename,
         application_scan->'files'->($1::int)->>'mime_type' AS mime_type,
         length(application_scan->'files'->($1::int)->>'data') AS data_len
       FROM members WHERE member_number = 233`,
      [1]
    );
    return r.rows[0];
  });

  assert(f0.value.filename === 'Sara 1 pdf.pdf', 'f0 name');
  assert(f1.value.filename === 'Sara 2 pdf.pdf', 'f1 name');
  assert(Number(f0.value.data_len) > 1000, 'f0 data');
  assert(Number(f1.value.data_len) > 1000, 'f1 data');
  assert(meta.ms < 15000, `meta too slow: ${meta.ms}ms`);
  assert(f0.ms < 20000, `file0 too slow: ${f0.ms}ms`);
  assert(f1.ms < 20000, `file1 too slow: ${f1.ms}ms`);

  console.log(JSON.stringify({
    ok: true,
    timings_ms: { meta: meta.ms, file0: f0.ms, file1: f1.ms },
    files: meta.value.map((f) => ({ filename: f.filename, data_len: f.data_len })),
  }, null, 2));

  await c.end();
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

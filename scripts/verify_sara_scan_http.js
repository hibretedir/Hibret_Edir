/**
 * HTTP verify: metadata + both binary PDFs for Sara via local portal.
 *   node scripts/verify_sara_scan_http.js
 */
require('dotenv').config();

const BASE = process.env.PUBLIC_SITE_URL || 'http://localhost:8888';
const MEMBER_ID = 663;

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

async function timed(label, fn) {
  const t0 = Date.now();
  const value = await fn();
  return { label, ms: Date.now() - t0, value };
}

(async () => {
  const meta = await timed('application-meta', async () => {
    const res = await fetch(
      `${BASE}/.netlify/functions/portal/member/application?memberId=${MEMBER_ID}`
    );
    const text = await res.text();
    assert(res.ok, `meta HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  });

  const apps = meta.value.scanned_applications || [];
  assert(apps.length === 2, `expected 2 scanned_applications, got ${apps.length}`);
  assert(!apps[0].preview, 'meta must not embed preview');
  assert(apps[0].filename === 'Sara 1 pdf.pdf', 'name0');
  assert(apps[1].filename === 'Sara 2 pdf.pdf', 'name1');

  const files = [];
  for (let i = 0; i < 2; i += 1) {
    files.push(await timed(`binary[${i}]`, async () => {
      const res = await fetch(
        `${BASE}/.netlify/functions/portal/member/application-scan?memberId=${MEMBER_ID}&index=${i}`
      );
      assert(res.ok, `file ${i} HTTP ${res.status}`);
      const ctype = res.headers.get('content-type') || '';
      assert(ctype.includes('pdf'), `file ${i} content-type ${ctype}`);
      const buf = Buffer.from(await res.arrayBuffer());
      assert(buf.length > 10000, `file ${i} too small ${buf.length}`);
      assert(buf.slice(0, 4).toString() === '%PDF', `file ${i} not PDF magic`);
      return { bytes: buf.length, ctype };
    }));
  }

  console.log(JSON.stringify({
    ok: true,
    base: BASE,
    timings_ms: {
      meta: meta.ms,
      file0: files[0].ms,
      file1: files[1].ms,
      total: meta.ms + files[0].ms + files[1].ms,
    },
    files: files.map((f) => f.value),
    names: apps.map((a) => a.filename),
  }, null, 2));

  assert(meta.ms < 15000, `meta slow ${meta.ms}`);
  assert(files[0].ms < 20000, `file0 slow ${files[0].ms}`);
  assert(files[1].ms < 20000, `file1 slow ${files[1].ms}`);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

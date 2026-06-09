const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;

const envPath = path.join(__dirname, '..', '.env');
const text = fs.readFileSync(envPath, 'utf8');
const line = text.split(/\r?\n/).find((l) => l.trim().startsWith('DATABASE_URL='));
if (!line) {
  console.error('No DATABASE_URL in .env');
  process.exit(1);
}
let val = line.slice(line.indexOf('=') + 1).trim();
if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
  val = val.slice(1, -1);
}
val = val.replace(/^postgressql:\/\//i, 'postgresql://');

let u;
try {
  u = new URL(val.replace(/^postgres:\/\//i, 'postgresql://'));
} catch (e) {
  console.error('URL parse failed:', e.message);
  process.exit(1);
}

console.log('Protocol:', u.protocol);
console.log('Hostname:', u.hostname);
console.log('Port:', u.port || '5432');
console.log('Database:', u.pathname.replace(/^\//, ''));
console.log('User:', u.username);
console.log('Password set:', u.password ? 'yes (' + u.password.length + ' chars)' : 'no');

const hostOk = /\.render\.com$/i.test(u.hostname) || /\.amazonaws\.com$/i.test(u.hostname);
if (!hostOk) {
  console.error('\nPROBLEM: Hostname does not look like a full Render URL.');
  console.error('Expected something like: dpg-xxxxx-a.oregon-postgres.render.com');
  console.error('You have:', u.hostname);
  console.error('\nFix: In Render → hibret-edir → Connect → copy External Database URL again.');
  console.error('Paste the ENTIRE line into .env (one line, no spaces).');
  process.exit(1);
}

dns.lookup(u.hostname)
  .then((r) => console.log('\nDNS OK:', u.hostname, '→', r.address))
  .catch((e) => {
    console.error('\nDNS FAILED for', u.hostname, '-', e.message);
    process.exit(1);
  });

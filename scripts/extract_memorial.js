const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'public/admin/invoices-snapshot.json'), 'utf8'));
const csv = fs.readFileSync(path.join(root, 'data/Download-1780537524021.csv'), 'utf8');

const map = new Map();

function add(num, name, year) {
  if (!num || !name) return;
  const key = num;
  const existing = map.get(key);
  if (!existing) map.set(key, { event: num, name: name.trim(), year: year || null });
  else if (year && !existing.year) existing.year = year;
}

for (const inv of snapshot.invoices || []) {
  const m = (inv.item || '').match(/^#\s*(\d+)\s+(.+)$/);
  if (!m) continue;
  const year = (inv.date || '').match(/\d{4}/)?.[0];
  add(Number(m[1]), m[2], year);
}

const re = /#\s*(\d+)\s+([^,"\r\n]+)/g;
let match;
while ((match = re.exec(csv)) !== null) {
  add(Number(match[1]), match[2], null);
}

console.log(JSON.stringify([...map.values()].sort((a, b) => b.event - a.event), null, 2));

const fs = require('fs');
const path = require('path');
const os = require('os');

/** Load project .env for local Netlify Dev when vars are not injected. */
function loadLocalEnv() {
  const candidates = [];
  const bootstrapPaths = [
    process.env.HIBRET_BOOTSTRAP_PATH,
    path.join(os.tmpdir(), 'hibret-dev', 'hibret-env-bootstrap.json'),
  ].filter(Boolean);

  for (const bootstrapPath of bootstrapPaths) {
    if (!fs.existsSync(bootstrapPath)) continue;
    try {
      const bootstrap = JSON.parse(fs.readFileSync(bootstrapPath, 'utf8'));
      if (bootstrap.envPath) candidates.push(bootstrap.envPath);
    } catch { /* ignore */ }
  }

  candidates.push(
    process.env.HIBRET_ENV_PATH,
    path.join(__dirname, '../../.env'),
    path.join(process.cwd(), '.env')
  );

  const envPath = candidates.filter(Boolean).find((p) => fs.existsSync(p));
  if (!envPath) return;

  const text = fs.readFileSync(envPath, 'utf8');
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
    if (key && process.env[key] == null) process.env[key] = value;
  }
}

function paypalApiBase() {
  const env = String(process.env.PAYPAL_ENV || 'live').toLowerCase();
  return env === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
}

module.exports = { loadLocalEnv, paypalApiBase };

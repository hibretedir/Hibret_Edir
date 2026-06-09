/**
 * Start Netlify Dev even when node_modules can't install on Google Drive.
 * Installs netlify-cli + function deps under %TEMP%/hibret-dev and sets NODE_PATH.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const PORT = process.env.PORT || '8888';

function loadEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return;
  const text = fs.readFileSync(ENV_PATH, 'utf8');
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
    value = value.replace(/^postgressql:\/\//i, 'postgresql://');
    if (key && process.env[key] == null) process.env[key] = value;
  }
}

loadEnvFile();
const TEMP_DIR = path.join(os.tmpdir(), 'hibret-dev');
const TEMP_NODE = path.join(TEMP_DIR, 'node_modules');
const TEMP_CLI = path.join(TEMP_NODE, '.bin', process.platform === 'win32' ? 'netlify.cmd' : 'netlify');

const FUNCTION_DEPS = ['netlify-cli@17', 'bcryptjs', 'pg', 'jsonwebtoken', 'dotenv'];

function pruneBrokenLocalDeps() {
  const nm = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(nm)) return;

  function walk(dir, depth = 0) {
    if (depth > 6) return;
    const pkgJson = path.join(dir, 'package.json');
    if (fs.existsSync(pkgJson)) {
      try {
        const raw = fs.readFileSync(pkgJson, 'utf8').trim();
        if (!raw) throw new Error('empty');
        JSON.parse(raw);
      } catch {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`Removed broken package: ${path.relative(ROOT, dir)}`);
        return;
      }
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isDirectory() && ent.name !== '.bin') {
        walk(path.join(dir, ent.name), depth + 1);
      }
    }
  }

  walk(nm);
}

function run(cmd, args, opts, cb) {
  const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  child.on('exit', (code) => cb(code ?? 1));
}

function ensureTempDeps(cb) {
  const bcryptPkg = path.join(TEMP_NODE, 'bcryptjs', 'package.json');
  if (fs.existsSync(TEMP_CLI) && fs.existsSync(bcryptPkg) && fs.readFileSync(bcryptPkg, 'utf8').trim()) {
    cb(0);
    return;
  }
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  console.log('Installing dev dependencies to temp folder (one-time)...');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(npm, ['install', ...FUNCTION_DEPS, '--no-save'], { cwd: TEMP_DIR }, cb);
}

function runNetlify() {
  const env = {
    ...process.env,
    NODE_PATH: TEMP_NODE,
    JWT_SECRET: process.env.JWT_SECRET || 'hibret-local-dev-secret',
  };
  const netlifyRun = path.join(TEMP_NODE, 'netlify-cli', 'bin', 'run.js');
  if (!fs.existsSync(netlifyRun)) {
    console.error('netlify-cli not found in temp deps. Re-run npm run dev.');
    process.exit(1);
  }
  console.log(`Starting Netlify Dev on http://localhost:${PORT} ...`);
  console.log(`  Portal: http://localhost:${PORT}/portal`);
  console.log(`  Admin:  http://localhost:${PORT}/admin`);
  console.log(`  Site:   http://localhost:${PORT}/`);
  const child = spawn(process.execPath, [netlifyRun, 'dev', '--port', PORT], {
    cwd: ROOT,
    stdio: 'inherit',
    env,
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

ensureTempDeps((code) => {
  if (code !== 0) {
    console.error('\nDev dependency install failed. Try: npm run dev:static');
    process.exit(1);
  }
  pruneBrokenLocalDeps();
  runNetlify();
});

/**
 * Start Netlify Dev on Google Drive repos.
 * - netlify-cli installs under %TEMP%/hibret-dev (local disk)
 * - function deps (pg, bcryptjs, etc.) install to temp, then copy to project node_modules
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const PORT = process.env.PORT || '8888';
const MARKER = path.join(ROOT, '.hibret-temp-node-modules');
const TEMP_DIR = path.join(os.tmpdir(), 'hibret-dev');
const TEMP_CLI_DIR = TEMP_DIR;
const TEMP_CLI_NODE = path.join(TEMP_CLI_DIR, 'node_modules');
const TEMP_FN_DIR = path.join(TEMP_DIR, 'function-deps');
const TEMP_FN_NODE = path.join(TEMP_FN_DIR, 'node_modules');
const TEMP_NETLIFY = path.join(TEMP_DIR, '.netlify-cache');
const TEMP_CLI = path.join(TEMP_CLI_NODE, '.bin', process.platform === 'win32' ? 'netlify.cmd' : 'netlify');
const CLI_OK = path.join(TEMP_DIR, '.cli-ok');
const FN_OK = path.join(TEMP_FN_DIR, '.fn-ok');
const RUNTIME_DEPS = ['pg', 'bcryptjs', 'jsonwebtoken', 'dotenv', 'node-fetch'];

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

function writeDevBootstrap() {
  const bootstrapPath = path.join(TEMP_DIR, 'hibret-env-bootstrap.json');
  try {
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    fs.writeFileSync(
      bootstrapPath,
      JSON.stringify({
        envPath: ENV_PATH,
        paypalConfigured: !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET),
      })
    );
  } catch (err) {
    console.warn('Could not write dev bootstrap file:', err.message);
  }
  return bootstrapPath;
}

function onGoogleDrive() {
  return /(?:google drive|my drive)/i.test(ROOT);
}

function pkgJsonOk(pkgPath) {
  try {
    const raw = fs.readFileSync(pkgPath, 'utf8').trim();
    return !!raw && !!JSON.parse(raw);
  } catch {
    return false;
  }
}

function nodeModulesHealthy(nm) {
  if (!fs.existsSync(nm)) return false;
  return RUNTIME_DEPS.every((name) => pkgJsonOk(path.join(nm, name, 'package.json')));
}

function localNodeModulesHealthy() {
  return nodeModulesHealthy(path.join(ROOT, 'node_modules'));
}

function needsTempNodeModules() {
  return onGoogleDrive() || !localNodeModulesHealthy();
}

function run(cmd, args, opts, cb) {
  const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  child.on('exit', (code) => cb(code ?? 1));
}

function npmInstall(cwd, cb) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(npm, ['install', '--no-fund', '--no-audit'], { cwd }, cb);
}

function writeCliPackageJson() {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(TEMP_CLI_DIR, 'package.json'),
    JSON.stringify({
      name: 'hibret-netlify-cli',
      private: true,
      devDependencies: { 'netlify-cli': '17.38.1' },
    }, null, 2)
  );
}

function writeFunctionPackageJson() {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (!fs.existsSync(TEMP_FN_DIR)) fs.mkdirSync(TEMP_FN_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(TEMP_FN_DIR, 'package.json'),
    JSON.stringify({
      name: 'hibret-function-deps',
      private: true,
      dependencies: { ...(rootPkg.dependencies || {}) },
    }, null, 2)
  );
}

function ensureCli(cb) {
  writeCliPackageJson();
  if (fs.existsSync(CLI_OK) && fs.existsSync(TEMP_CLI) && pkgJsonOk(path.join(TEMP_CLI_NODE, 'netlify-cli', 'package.json'))) {
    cb(0);
    return;
  }
  console.log('Installing Netlify CLI to local temp (one-time)...');
  npmInstall(TEMP_CLI_DIR, (code) => {
    if (code === 0) {
      try { fs.writeFileSync(CLI_OK, new Date().toISOString()); } catch { /* ignore */ }
    }
    cb(code);
  });
}

function ensureFunctionDeps(cb) {
  writeFunctionPackageJson();
  if (fs.existsSync(FN_OK) && nodeModulesHealthy(TEMP_FN_NODE)) {
    cb(0);
    return;
  }
  console.log('Installing function dependencies to local temp (one-time)...');
  npmInstall(TEMP_FN_DIR, (code) => {
    if (code === 0) {
      try { fs.writeFileSync(FN_OK, new Date().toISOString()); } catch { /* ignore */ }
    }
    cb(code);
  });
}

function removeDir(p, cb) {
  if (!fs.existsSync(p)) {
    cb(0);
    return;
  }
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    cb(0);
  } catch (err) {
    console.error('Could not remove folder:', p);
    console.error(err.message);
    cb(1);
  }
}

function copyFunctionDepsToProject(cb) {
  const rootNm = path.join(ROOT, 'node_modules');
  const fnStamp = fs.existsSync(FN_OK) ? fs.readFileSync(FN_OK, 'utf8').trim() : '';

  if (fnStamp && fs.existsSync(MARKER) && fs.readFileSync(MARKER, 'utf8').trim() === fnStamp && localNodeModulesHealthy()) {
    cb(0);
    return;
  }

  if (!nodeModulesHealthy(TEMP_FN_NODE)) {
    console.error('Function dependencies missing in temp. Re-run npm run dev.');
    cb(1);
    return;
  }

  console.log('Syncing function node_modules into project (Google Drive workaround)...');

  function doCopy() {
    try {
      fs.cpSync(TEMP_FN_NODE, rootNm, { recursive: true, dereference: true, force: true });
      fs.writeFileSync(MARKER, fnStamp || new Date().toISOString());
      console.log('  node_modules ready for Netlify functions.');
      cb(0);
    } catch (err) {
      console.error('Copy failed:', err.message);
      cb(1);
    }
  }

  if (fs.existsSync(rootNm)) {
    const trash = path.join(ROOT, `node_modules.trash-${Date.now()}`);
    try {
      fs.renameSync(rootNm, trash);
      console.log(`  Renamed old node_modules → ${path.basename(trash)} (delete later if you want)`);
      doCopy();
    } catch (err) {
      console.warn('  Could not rename old node_modules, trying delete...', err.message);
      removeDir(rootNm, (code) => {
        if (code !== 0) {
          console.error('\nClose other programs, delete the node_modules folder manually, then re-run npm run dev.');
          cb(1);
          return;
        }
        doCopy();
      });
    }
    return;
  }
  doCopy();
}

function prepareNodeModules(cb) {
  if (!needsTempNodeModules()) {
    cb(0);
    return;
  }
  if (onGoogleDrive()) {
    copyFunctionDepsToProject(cb);
    return;
  }
  if (localNodeModulesHealthy()) {
    cb(0);
    return;
  }
  copyFunctionDepsToProject(cb);
}

function netlifyJunctionTarget(linkPath) {
  try {
    const target = fs.readlinkSync(linkPath);
    return path.resolve(path.dirname(linkPath), target);
  } catch {
    return null;
  }
}

function prepareNetlifyCacheDir() {
  if (!onGoogleDrive()) return;
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  if (!fs.existsSync(TEMP_NETLIFY)) fs.mkdirSync(TEMP_NETLIFY, { recursive: true });

  const netlifyDir = path.join(ROOT, '.netlify');
  if (fs.existsSync(netlifyDir)) {
    const linked = netlifyJunctionTarget(netlifyDir);
    if (linked && path.resolve(linked) === path.resolve(TEMP_NETLIFY)) return;
    console.log('Resetting .netlify cache (Google Drive workaround)...');
    try {
      fs.rmSync(netlifyDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (err) {
      console.warn('Could not clear .netlify:', err.message);
      console.warn('Stop the dev server, delete the .netlify folder manually, then npm run dev again.');
      return;
    }
  }

  if (fs.existsSync(netlifyDir)) return;
  try {
    if (process.platform === 'win32') {
      execSync(`cmd /c mklink /J "${netlifyDir}" "${TEMP_NETLIFY}"`, { stdio: 'ignore' });
    } else {
      fs.symlinkSync(TEMP_NETLIFY, netlifyDir, 'dir');
    }
    console.log('  .netlify linked to local temp (keeps function bundling off Google Drive).');
  } catch (err) {
    console.warn('Could not link .netlify to temp:', err.message);
    console.warn('If the admin page hangs on Loading, move the repo to a local folder (e.g. C:\\Projects).');
  }
}

function runLocalDevServer() {
  console.log('Starting local dev server (Google Drive — Netlify functions bypass)...');
  startDailyApplicationScanSync();
  const localDev = path.join(__dirname, 'dev-local.js');
  const child = spawn(process.execPath, [localDev], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT,
      JWT_SECRET: process.env.JWT_SECRET || 'hibret-local-dev-secret',
    },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

/** One-shot: import Drive scans at most once per Pacific day (no 60s poller). */
function startDailyApplicationScanSync() {
  const daily = path.join(__dirname, 'sync_application_scans_daily.js');
  if (!fs.existsSync(daily)) return;
  try {
    const child = spawn(process.execPath, [daily], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env },
      detached: false,
    });
    child.on('error', (err) => {
      console.warn('[scan-sync:daily] failed to start:', err.message);
    });
  } catch (err) {
    console.warn('[scan-sync:daily] could not start:', err.message);
  }
}

function runNetlify(bootstrapPath) {
  if (onGoogleDrive()) {
    runLocalDevServer();
    return;
  }
  prepareNetlifyCacheDir();
  const env = {
    ...process.env,
    NODE_PATH: [TEMP_FN_NODE, TEMP_CLI_NODE].join(path.delimiter),
    JWT_SECRET: process.env.JWT_SECRET || 'hibret-local-dev-secret',
    HIBRET_ENV_PATH: ENV_PATH,
    HIBRET_BOOTSTRAP_PATH: bootstrapPath,
    ...(onGoogleDrive() ? {
      CHOKIDAR_USEPOLLING: '1',
      CHOKIDAR_INTERVAL: '1000',
      NETLIFY_USE_BLOBS: 'false',
    } : {}),
  };
  const netlifyRun = path.join(TEMP_CLI_NODE, 'netlify-cli', 'bin', 'run.js');
  if (!fs.existsSync(netlifyRun)) {
    console.error('netlify-cli not found. Re-run npm run dev.');
    process.exit(1);
  }
  console.log(`Starting Netlify Dev on http://localhost:${PORT} ...`);
  console.log(`  Portal: http://localhost:${PORT}/portal`);
  console.log(`  Admin:  http://localhost:${PORT}/admin`);
  console.log(`  Site:   http://localhost:${PORT}/`);
  if (onGoogleDrive()) {
    console.log('  Note: Google Drive repo — CLI runs from local temp, not Drive.');
  }
  const child = spawn(process.execPath, [netlifyRun, 'dev', '--port', PORT], {
    cwd: ROOT,
    stdio: 'inherit',
    env,
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

loadEnvFile();
const bootstrapPath = writeDevBootstrap();

ensureCli((cliCode) => {
  if (cliCode !== 0) {
    console.error('\nNetlify CLI install failed. Try: npm run dev:static');
    process.exit(1);
  }
  ensureFunctionDeps((fnCode) => {
    if (fnCode !== 0) {
      console.error('\nFunction dependency install failed.');
      process.exit(1);
    }
    prepareNodeModules((prepCode) => {
      if (prepCode !== 0) process.exit(1);
      runNetlify(bootstrapPath);
    });
  });
});

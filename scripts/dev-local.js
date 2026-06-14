/**
 * Local dev server for Google Drive repos where Netlify CLI function bundling hangs.
 * Serves public/ and runs netlify/functions/*.js handlers directly (no esbuild cache).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const FUNCTIONS = path.join(ROOT, 'netlify', 'functions');
const PORT = Number(process.env.PORT || 8888);
const ENV_PATH = path.join(ROOT, '.env');

const FN_NAMES = new Set(
  fs.readdirSync(FUNCTIONS)
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.slice(0, -3))
);

const SPA_ROUTES = [
  ['/admin', '/admin/index.html'],
  ['/portal', '/portal/index.html'],
  ['/application', '/application/index.html'],
  ['/apply', '/application/index.html'],
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

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

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const HANDLER_TIMEOUT_MS = 30000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label || 'Handler'} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

function buildEvent(req, pathname, searchParams, body) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  const query = {};
  for (const [k, v] of searchParams.entries()) query[k] = v;
  return {
    httpMethod: req.method || 'GET',
    path: pathname,
    rawUrl: pathname + (searchParams.toString() ? `?${searchParams}` : ''),
    headers,
    body: body || null,
    queryStringParameters: Object.keys(query).length ? query : null,
    isBase64Encoded: false,
  };
}

function sendLambdaResponse(res, result) {
  const status = result?.statusCode || 200;
  const headers = result?.headers || {};
  for (const [k, v] of Object.entries(headers)) {
    if (v != null) res.setHeader(k, v);
  }
  res.statusCode = status;
  res.end(result?.body ?? '');
}

const handlerCache = new Map();

function clearFunctionModuleCache() {
  const root = `${FUNCTIONS}${path.sep}`;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(root)) delete require.cache[key];
  }
}

function functionsBundleMtime() {
  let max = 0;
  for (const f of FN_NAMES) {
    const p = path.join(FUNCTIONS, `${f}.js`);
    max = Math.max(max, fs.statSync(p).mtimeMs);
  }
  return max;
}

function getHandler(name) {
  if (!FN_NAMES.has(name)) return null;
  const modPath = path.join(FUNCTIONS, `${name}.js`);
  const cacheKey = `${name}:${functionsBundleMtime()}`;
  if (handlerCache.has(cacheKey)) return handlerCache.get(cacheKey);
  clearFunctionModuleCache();
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const mod = require(modPath);
  const handler = mod.handler;
  if (typeof handler !== 'function') return null;
  handlerCache.set(cacheKey, handler);
  return handler;
}

function resolveStaticPath(pathname) {
  if (pathname === '/') return path.join(PUBLIC, 'index.html');

  for (const [prefix, target] of SPA_ROUTES) {
    if (pathname === prefix || pathname === `${prefix}/` || pathname.startsWith(`${prefix}/`)) {
      const rel = pathname.slice(prefix.length).replace(/^\//, '');
      if (!rel) return path.join(PUBLIC, target.replace(/^\//, ''));
      const candidate = path.join(PUBLIC, prefix.slice(1), rel);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      return path.join(PUBLIC, target.replace(/^\//, ''));
    }
  }

  const abs = path.normalize(path.join(PUBLIC, pathname.replace(/^\//, '')));
  if (!abs.startsWith(PUBLIC)) return null;
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    const index = path.join(abs, 'index.html');
    if (fs.existsSync(index)) return index;
  }
  if (fs.existsSync(`${abs}.html`)) return `${abs}.html`;
  return null;
}

function serveStatic(res, absPath) {
  if (!fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
    return;
  }
  const ext = path.extname(absPath).toLowerCase();
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  fs.createReadStream(absPath).pipe(res);
}

async function handleFunction(req, res, fnName, pathname, searchParams) {
  const handler = getHandler(fnName);
  if (!handler) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: `Unknown function: ${fnName}` }));
    return;
  }
  try {
    const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req);
    const event = buildEvent(req, pathname, searchParams, body);
    const result = await withTimeout(handler(event, {}), HANDLER_TIMEOUT_MS, fnName);
    sendLambdaResponse(res, result);
  } catch (err) {
    console.error(`[${fnName}]`, err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Function error' }));
  }
}

loadEnvFile();
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hibret-local-dev-secret';
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
if (!process.env.PUBLIC_SITE_URL) {
  process.env.PUBLIC_SITE_URL = `http://localhost:${PORT}`;
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || `localhost:${PORT}`;
  const url = new URL(req.url || '/', `http://${host}`);
  const pathname = decodeURIComponent(url.pathname);

  const fnMatch = pathname.match(/^\/\.netlify\/functions\/([^/]+)(\/.*)?$/);
  if (fnMatch) {
    await handleFunction(req, res, fnMatch[1], pathname, url.searchParams);
    return;
  }

  const staticPath = resolveStaticPath(pathname);
  if (staticPath) {
    serveStatic(res, staticPath);
    return;
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Not found');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — another dev server is still running.`);
    console.error(`  Windows: netstat -ano | findstr :${PORT}   then   taskkill /PID <pid> /F`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  const loaded = [...FN_NAMES].filter((n) => getHandler(n));
  console.log(`Local dev server on http://localhost:${PORT}`);
  console.log(`  Admin:  http://localhost:${PORT}/admin`);
  console.log(`  Portal: http://localhost:${PORT}/portal`);
  console.log(`  Loaded functions: ${loaded.join(', ')}`);
  console.log('  (Google Drive mode — Netlify CLI bypassed)');
  const qaOn = process.env.DEMO_QA_ENABLED === 'true';
  const cap = process.env.MEMBER_CAP || '200';
  if (qaOn) {
    console.log(`  QA mode: DEMO_QA_EMAIL=${process.env.DEMO_QA_EMAIL || '(unset)'} MEMBER_CAP=${cap}`);
  } else if (Number(cap) > 200) {
    console.warn('  Warning: MEMBER_CAP>200 but DEMO_QA_ENABLED is not true — QA invite bypass off');
  }
});

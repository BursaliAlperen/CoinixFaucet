'use strict';
// CoinixFaucet backend — Node.js 20+
// Secrets are read only from environment variables. Never expose BOT_TOKEN or PIARFLOW_API_KEY to the browser.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const PIARFLOW_API_KEY = process.env.PIARFLOW_API_KEY || '';
const APP_ORIGIN = (process.env.APP_ORIGIN || '').replace(/\/$/, '');
const FRONTEND_DIR = path.resolve(__dirname, '../Frontend');
const PF_BASE = 'https://piarflow.com/v1';
const rate = new Map();
const MAX_BODY = 16 * 1024;

function json(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > MAX_BODY) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch { reject(new Error('INVALID_JSON')); }
    });
    req.on('error', reject);
  });
}
function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN || typeof initData !== 'string' || !initData || initData.length > 8192) return null;
  let params;
  try { params = new URLSearchParams(initData); } catch { return null; }
  const receivedHash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  const userRaw = params.get('user');
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash) || !Number.isFinite(authDate) || !userRaw) return null;
  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 30 || now - authDate > 300) return null;
  params.delete('hash');
  params.delete('signature');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => key + '=' + value)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calculated = crypto.createHmac('sha256', secret).update(dataCheckString).digest();
  const received = Buffer.from(receivedHash, 'hex');
  if (received.length !== calculated.length || !crypto.timingSafeEqual(received, calculated)) return null;
  try {
    const user = JSON.parse(userRaw);
    return Number.isSafeInteger(user.id) && user.id > 0 ? user.id : null;
  } catch { return null; }
}
function isAllowedOrigin(req) {
  if (!APP_ORIGIN) return true; // configure APP_ORIGIN in Render for strict origin checks
  const origin = req.headers.origin;
  return !origin || origin === APP_ORIGIN;
}
function rateLimited(key) {
  const now = Date.now();
  const recent = (rate.get(key) || []).filter(t => now - t < 60_000);
  recent.push(now);
  rate.set(key, recent);
  return recent.length > 20;
}
async function piarflow(route, payload) {
  if (!PIARFLOW_API_KEY) throw new Error('SPONSOR_API_NOT_CONFIGURED');
  const response = await fetch(PF_BASE + route, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + PIARFLOW_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12_000)
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}
async function handleApi(req, res, url) {
  if (!isAllowedOrigin(req)) return json(res, 403, { status: 'error', message: 'Origin rejected' });
  if (req.method !== 'POST') return json(res, 405, { status: 'error', message: 'Method not allowed' });
  let body;
  try { body = await readBody(req); }
  catch (e) { return json(res, e.message === 'BODY_TOO_LARGE' ? 413 : 400, { status: 'error', message: 'Invalid request body' }); }
  const userId = verifyTelegramInitData(body.initData);
  if (!userId) return json(res, 401, { status: 'error', message: 'Telegram session invalid or expired' });
  if (rateLimited(String(userId))) return json(res, 429, { status: 'error', message: 'Rate limit exceeded' });

  try {
    if (url.pathname === '/api/sponsors') {
      const max = Math.min(10, Math.max(1, Number.parseInt(body.max_sponsors, 10) || 10));
      const result = await piarflow('/sponsors', { user_id: userId, chat_id: userId, max_sponsors: max });
      return json(res, result.status, result.data);
    }
    if (url.pathname === '/api/sponsors/check') {
      const links = Array.isArray(body.links)
        ? body.links.filter(v => typeof v === 'string' && /^https:\/\//i.test(v) && v.length <= 300).slice(0, 10)
        : [];
      if (!links.length) return json(res, 400, { status: 'error', message: 'Valid links are required' });
      const result = await piarflow('/sponsors/check', { user_id: userId, links });
      return json(res, result.status, result.data);
    }
    return json(res, 404, { status: 'error', message: 'Not found' });
  } catch (error) {
    console.error('[api]', error.message);
    const status = error.message === 'SPONSOR_API_NOT_CONFIGURED' ? 503 : 502;
    return json(res, status, { status: 'error', message: 'Upstream service unavailable' });
  }
}
function serveFrontend(req, res, url) {
  const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.resolve(FRONTEND_DIR, '.' + requested);
  if (!file.startsWith(FRONTEND_DIR + path.sep) && file !== path.join(FRONTEND_DIR, 'index.html')) {
    return json(res, 403, { error: 'Forbidden' });
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return json(res, 404, { error: 'Not found' });
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
    res.writeHead(200, {
      'content-type': types[path.extname(file)] || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'cache-control': path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=300'
    });
    fs.createReadStream(file).pipe(res);
  });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, service: 'coinixfaucet', sponsorConfigured: Boolean(PIARFLOW_API_KEY), telegramConfigured: Boolean(BOT_TOKEN) });
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  if (req.method === 'GET') return serveFrontend(req, res, url);
  return json(res, 405, { error: 'Method not allowed' });
});
server.listen(PORT, '0.0.0.0', () => console.log('CoinixFaucet backend listening on ' + PORT));

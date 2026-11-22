'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const admin = require('firebase-admin');

const PORT = Number(process.env.PORT || 3000);
const APP_ORIGIN = (process.env.APP_ORIGIN || '').replace(/\/$/, '');
const FRONTEND_DIR = path.resolve(__dirname, '../Frontend');
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const PIARFLOW_API_KEY = process.env.PIARFLOW_API_KEY || '';
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || '';
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT || '';
const MAX_BODY = 24 * 1024;
const rate = new Map();
let firebaseReady = false;
let rtdb = null;
let firestore = null;

function initFirebase() {
  if (firebaseReady) return true;
  if (!FIREBASE_SERVICE_ACCOUNT || !FIREBASE_DATABASE_URL) return false;
  try {
    const raw = FIREBASE_SERVICE_ACCOUNT.trim().startsWith('{')
      ? FIREBASE_SERVICE_ACCOUNT
      : Buffer.from(FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: FIREBASE_DATABASE_URL
    });
    rtdb = admin.database();
    firestore = admin.firestore();
    firebaseReady = true;
    return true;
  } catch (error) {
    console.error('[firebase-init]', error.message);
    return false;
  }
}
function send(res, status, data) {
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
      if (Buffer.byteLength(raw) > MAX_BODY) {
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
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  const userRaw = params.get('user');
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !Number.isFinite(authDate) || !userRaw) return null;
  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 30 || now - authDate > 300) return null;
  params.delete('hash');
  params.delete('signature');
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => key + '=' + value).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', secret).update(check).digest();
  const supplied = Buffer.from(hash, 'hex');
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  try {
    const user = JSON.parse(userRaw);
    if (!Number.isSafeInteger(user.id) || user.id <= 0) return null;
    return {
      id: String(user.id),
      name: String(user.first_name || 'User').slice(0, 80),
      username: String(user.username || '').slice(0, 64),
      photoUrl: typeof user.photo_url === 'string' ? user.photo_url.slice(0, 500) : ''
    };
  } catch { return null; }
}
function allowedOrigin(req) {
  if (!APP_ORIGIN) return !req.headers.origin;
  return !req.headers.origin || req.headers.origin === APP_ORIGIN;
}
function limited(key) {
  const now = Date.now();
  const recent = (rate.get(key) || []).filter(t => now - t < 60000);
  recent.push(now);
  rate.set(key, recent);
  if (rate.size > 5000) {
    for (const [k, v] of rate) if (!v.length || now - v[v.length - 1] > 120000) rate.delete(k);
  }
  return recent.length > 30;
}
function dayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.REWARD_TIMEZONE || 'Asia/Dhaka' }).format(new Date());
}
function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100000000) throw new Error('INVALID_AMOUNT');
  return Math.round(n * 10000) / 10000;
}
function randomId() { return crypto.randomBytes(16).toString('hex'); }
async function logTransaction(uid, type, amount, extra) {
  await firestore.collection('transactions').add({
    userId: uid, type, amount: Number(amount || 0),
    ...(extra || {}), timestamp: admin.firestore.FieldValue.serverTimestamp()
  });
}
async function getSettings() {
  const snap = await rtdb.ref('settings').once('value');
  return snap.val() || {};
}
async function bootstrap(user, referralCode) {
  const userRef = rtdb.ref('users/' + user.id);
  let created = false;
  const result = await userRef.transaction(current => {
    if (current) { created = false; return current; }
    created = true;
    return {
      uid: user.id, name: user.name, username: user.username, photoUrl: user.photoUrl,
      balance: 0, totalEarned: 0, totalWithdrawn: 0, referralEarned: 0, referralCount: 0,
      referredBy: referralCode && referralCode !== user.id ? String(referralCode).slice(0, 32) : null,
      todayAds: 0, lastAdDate: '', checkInStreak: 0, lastCheckIn: '',
      lastCardDate: '', spinCards: 0, completedTasks: {}, sponsorDone: {}, banned: false,
      createdAt: Date.now(), processedActions: {}
    };
  });
  if (!result.committed || !result.snapshot.exists()) throw new Error('USER_BOOTSTRAP_FAILED');
  if (created && referralCode && referralCode !== user.id) {
    const referralMarker = rtdb.ref('referralClaims/' + user.id);
    let claimedNow = false;
    const claim = await referralMarker.transaction(v => {
      if (v) { claimedNow = false; return v; }
      claimedNow = true;
      return { referrer: String(referralCode), at: Date.now() };
    });
    if (claim.committed && claimedNow && claim.snapshot.val() && claim.snapshot.val().referrer === String(referralCode)) {
      const settings = await getSettings();
      const bonus = money(settings.referralBonus == null ? 0.1 : settings.referralBonus);
      if (bonus > 0) {
        const ref = rtdb.ref('users/' + String(referralCode));
        const refResult = await ref.transaction(u => {
          if (!u || u.banned) return;
          u.referralCount = Number(u.referralCount || 0) + 1;
          u.referralEarned = money(Number(u.referralEarned || 0) + bonus);
          u.balance = money(Number(u.balance || 0) + bonus);
          u.totalEarned = money(Number(u.totalEarned || 0) + bonus);
          return u;
        });
        if (refResult.committed) await logTransaction(String(referralCode), 'referral', bonus, { referredUserId: user.id });
      }
    }
  }
  return result.snapshot.val();
}
async function applyEconomyAction(uid, body) {
  const action = String(body.action || '');
  const actionId = String(body.actionId || randomId()).slice(0, 80);
  const userRef = rtdb.ref('users/' + uid);
  const settings = await getSettings();
  const taskId = String(body.taskId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
  const taskSnapshot = action === 'task' && taskId ? await rtdb.ref('tasks/' + taskId).once('value') : null;
  const taskRecord = taskSnapshot && taskSnapshot.exists() ? taskSnapshot.val() : null;
  const methodKey = String(body.method || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  const methodSnapshot = action === 'withdraw' && methodKey ? await rtdb.ref('withdrawMethods/' + methodKey).once('value') : null;
  const methodRecord = methodSnapshot && methodSnapshot.exists() ? methodSnapshot.val() : null;
  let credited = 0;
  let logType = action;
  let extra = {};
  let failure = '';
  const tx = await userRef.transaction(user => {
    if (!user || user.banned) { failure = 'ACCOUNT_UNAVAILABLE'; return; }
    user.processedActions = user.processedActions || {};
    if (user.processedActions[actionId]) return user;
    const balance = Number(user.balance || 0);
    if (action === 'daily_card') {
      const today = dayKey();
      if (user.lastCardDate === today) { failure = 'ALREADY_CLAIMED'; return; }
      const count = Math.max(1, Math.min(10, parseInt(settings.dailyFreeCards || 1, 10)));
      user.spinCards = Number(user.spinCards || 0) + count;
      user.lastCardDate = today;
      extra = { cards: count };
    } else if (action === 'task') {
      const task = taskRecord;
      if (!taskId || !task || task.active === false) { failure = 'TASK_UNAVAILABLE'; return; }
      user.completedTasks = user.completedTasks || {};
      if (user.completedTasks[taskId]) { failure = 'ALREADY_COMPLETED'; return; }
      credited = money(task.reward || 0);
      user.completedTasks[taskId] = Date.now();
      user.balance = money(balance + credited);
      user.totalEarned = money(Number(user.totalEarned || 0) + credited);
      extra = { taskId, taskTitle: String(task.title || '').slice(0, 120) };
    } else if (action === 'checkin') {
      const today = dayKey();
      if (user.lastCheckIn === today) { failure = 'ALREADY_CLAIMED'; return; }
      const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: process.env.REWARD_TIMEZONE || 'Asia/Dhaka' });
      const streak = user.lastCheckIn === yesterday ? Math.min(7, Number(user.checkInStreak || 0) + 1) : 1;
      const rewards = Array.isArray(settings.checkinRewards) ? settings.checkinRewards : [0.01,0.02,0.03,0.05,0.08,0.12,0.2];
      credited = money(rewards[streak - 1] || 0.01);
      user.lastCheckIn = today;
      user.checkInStreak = streak;
      user.balance = money(balance + credited);
      user.totalEarned = money(Number(user.totalEarned || 0) + credited);
      extra = { day: streak };
    } else if (action === 'spin') {
      if (Number(user.spinCards || 0) < 1) { failure = 'NO_SPIN_CARDS'; return; }
      const rewards = Array.isArray(settings.spinRewards) ? settings.spinRewards : [0.01,0.05,0.02,0.1,0.01,0.5,0.03,1];
      if (!rewards.length) { failure = 'SPIN_NOT_CONFIGURED'; return; }
      const index = crypto.randomInt(0, rewards.length);
      credited = money(rewards[index]);
      user.spinCards = Number(user.spinCards || 0) - 1;
      user.balance = money(balance + credited);
      user.totalEarned = money(Number(user.totalEarned || 0) + credited);
      extra = { rewardIndex: index, cards: user.spinCards };
    } else if (action === 'buy_cards') {
      const count = Number(body.count);
      const priceKey = count === 1 ? 'spinCard1Price' : count === 5 ? 'spinCard5Price' : count === 10 ? 'spinCard10Price' : '';
      if (!priceKey) { failure = 'INVALID_CARD_PACK'; return; }
      const price = money(settings[priceKey] == null ? ({spinCard1Price:0.5,spinCard5Price:2,spinCard10Price:3.5})[priceKey] : settings[priceKey]);
      if (balance < price) { failure = 'INSUFFICIENT_BALANCE'; return; }
      user.balance = money(balance - price);
      user.spinCards = Number(user.spinCards || 0) + count;
      credited = -price;
      extra = { cards: count };
    } else if (action === 'withdraw') {
      const amount = money(body.amount);
      const account = String(body.account || '').trim().slice(0, 300);
      const method = methodRecord;
      if (!methodKey || !account || !method || method.active === false) { failure = 'INVALID_WITHDRAW_METHOD'; return; }
      if (amount < Number(method.minWithdraw || 5) || (Number(method.maxWithdraw || 0) > 0 && amount > Number(method.maxWithdraw)) || amount > balance) {
        failure = amount > balance ? 'INSUFFICIENT_BALANCE' : 'WITHDRAW_LIMIT';
        return;
      }
      user.balance = money(balance - amount);
      user.totalWithdrawn = money(Number(user.totalWithdrawn || 0) + amount);
      extra = { amount, method: methodKey, methodName: String(method.name || methodKey), account };
      credited = -amount;
    } else {
      failure = 'ACTION_NOT_ALLOWED';
      return;
    }
    user.processedActions[actionId] = Date.now();
    const keys = Object.keys(user.processedActions);
    if (keys.length > 100) for (const key of keys.slice(0, keys.length - 100)) delete user.processedActions[key];
    return user;
  });
  if (!tx.committed || failure) throw new Error(failure || 'ACTION_REJECTED');
  const updatedUser = tx.snapshot.val();
  if (action === 'withdraw') {
    try {
      await rtdb.ref('withdrawals').push({
        userId: uid, name: updatedUser.name || 'User', amount: extra.amount,
        method: extra.method, methodName: extra.methodName, account: extra.account,
        status: 'pending', requestedAt: Date.now()
      });
    } catch (error) {
      await userRef.transaction(user => {
        if (!user) return user;
        user.balance = money(Number(user.balance || 0) + extra.amount);
        user.totalWithdrawn = Math.max(0, Number(user.totalWithdrawn || 0) - extra.amount);
        return user;
      });
      throw new Error('WITHDRAW_SAVE_FAILED');
    }
  }
  if (action !== 'daily_card') {
    try { await logTransaction(uid, logType, credited, extra); }
    catch (error) { console.error('[transaction-log]', error.message); }
  }
  return { user: updatedUser, reward: action === 'spin' ? credited : undefined, extra };
}
async function callPiarflow(route, payload) {
  if (!PIARFLOW_API_KEY) throw new Error('SPONSOR_API_NOT_CONFIGURED');
  const response = await fetch('https://piarflow.com/v1' + route, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + PIARFLOW_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('SPONSOR_UPSTREAM_ERROR');
  return data;
}
async function handleApi(req, res, url) {
  if (!allowedOrigin(req)) return send(res, 403, { status: 'error', message: 'Origin rejected' });
  if (req.method !== 'POST') return send(res, 405, { status: 'error', message: 'Method not allowed' });
  let body;
  try { body = await readBody(req); }
  catch (error) { return send(res, error.message === 'BODY_TOO_LARGE' ? 413 : 400, { status: 'error', message: 'Invalid request body' }); }
  const user = verifyTelegramInitData(body.initData);
  if (!user) return send(res, 401, { status: 'error', message: 'Telegram session invalid or expired' });
  if (limited(user.id)) return send(res, 429, { status: 'error', message: 'Rate limit exceeded' });
  if (!initFirebase()) return send(res, 503, { status: 'error', message: 'Firebase Admin is not configured' });
  try {
    if (url.pathname === '/api/session') {
      const referralCode = String(body.referralCode || '').replace(/\D/g, '').slice(0, 20);
      const profile = await bootstrap(user, referralCode);
      if (profile.banned) return send(res, 403, { status: 'error', message: 'Account unavailable' });
      const customToken = await admin.auth().createCustomToken(user.id);
      return send(res, 200, { status: 'ok', user: profile, customToken });
    }
    if (url.pathname === '/api/economy') {
      const result = await applyEconomyAction(user.id, body);
      return send(res, 200, { status: 'ok', ...result });
    }
    if (url.pathname === '/api/sponsors') {
      const max = Math.min(10, Math.max(1, parseInt(body.max_sponsors, 10) || 10));
      const data = await callPiarflow('/sponsors', { user_id: Number(user.id), chat_id: Number(user.id), max_sponsors: max });
      return send(res, 200, data);
    }
    if (url.pathname === '/api/sponsors/check') {
      const links = Array.isArray(body.links) ? body.links.filter(v => typeof v === 'string' && /^https:\/\/\S+$/i.test(v) && v.length <= 300).slice(0, 10) : [];
      if (!links.length) return send(res, 400, { status: 'error', message: 'Valid links required' });
      const data = await callPiarflow('/sponsors/check', { user_id: Number(user.id), links });
      const matched = (data.sponsors || []).find(item => item.link === links[0]);
      if (matched && matched.status === 'subscribed') {
        const key = crypto.createHash('sha256').update(links[0]).digest('hex');
        const reward = money((await getSettings()).sponsorReward == null ? 0.0025 : (await getSettings()).sponsorReward);
        let credited = false;
        const tx = await rtdb.ref('users/' + user.id).transaction(profile => {
          if (!profile || profile.banned) return;
          profile.sponsorDone = profile.sponsorDone || {};
          if (profile.sponsorDone[key]) return profile;
          profile.sponsorDone[key] = Date.now();
          profile.balance = money(Number(profile.balance || 0) + reward);
          profile.totalEarned = money(Number(profile.totalEarned || 0) + reward);
          credited = true;
          return profile;
        });
        if (tx.committed && credited) await logTransaction(user.id, 'sponsor', reward, { sponsorHash: key });
        data.rewarded = Boolean(tx.committed && credited);
        data.reward = data.rewarded ? reward : 0;
      }
      return send(res, 200, data);
    }
    return send(res, 404, { status: 'error', message: 'Not found' });
  } catch (error) {
    const known = new Set(['ACCOUNT_UNAVAILABLE','ALREADY_CLAIMED','ALREADY_COMPLETED','NO_SPIN_CARDS','SPIN_NOT_CONFIGURED','INVALID_CARD_PACK','INSUFFICIENT_BALANCE','WITHDRAW_LIMIT','INVALID_WITHDRAW_METHOD','WITHDRAW_SAVE_FAILED','TASK_UNAVAILABLE','ACTION_NOT_ALLOWED','INVALID_AMOUNT']);
    const status = known.has(error.message) ? 400 : error.message === 'SPONSOR_API_NOT_CONFIGURED' ? 503 : 502;
    return send(res, status, { status: 'error', code: error.message, message: known.has(error.message) ? error.message : 'Request could not be completed' });
  }
}
function serveFrontend(req, res, url) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return send(res, 400, { error: 'Bad path' }); }
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(FRONTEND_DIR, '.' + requested);
  if (!file.startsWith(FRONTEND_DIR + path.sep)) return send(res, 403, { error: 'Forbidden' });
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) return send(res, 404, { error: 'Not found' });
    const types = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp' };
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
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, service: 'coinixfaucet', firebaseAdminConfigured: initFirebase(), telegramConfigured: Boolean(BOT_TOKEN), sponsorConfigured: Boolean(PIARFLOW_API_KEY) });
  }
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  if (req.method === 'GET' || req.method === 'HEAD') return serveFrontend(req, res, url);
  return send(res, 405, { error: 'Method not allowed' });
});
server.listen(PORT, '0.0.0.0', () => console.log('CoinixFaucet listening on ' + PORT));

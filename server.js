const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ==================== KEEP ALIVE ====================
const PORT = process.env.PORT || 3000;
const API_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(() => {
  http.get(`${API_URL}/api/ping`, () => {});
}, 5 * 60 * 1000);

// ==================== FIREBASE ====================
let admin, db, firebaseOk = false;
try {
  const sa = require('./serviceAccountKey.json');
  admin = require('firebase-admin');
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  db = admin.firestore();
  firebaseOk = true;
  console.log('[Firebase] Connected');
} catch(e) {
  console.log('[Firebase] Not configured, using JSON DB fallback');
}

// ==================== JSON DB ====================
const DBF = path.join(__dirname, 'db.json');
function readDB() {
  if (!fs.existsSync(DBF)) {
    const d = { users: {}, withdrawals: [], tasks: [], referrals: [], offerwall_logs: [], settings: { total_claims: 0, total_withdrawn: 0, total_offerwall: 0 } };
    fs.writeFileSync(DBF, JSON.stringify(d, null, 2));
    return d;
  }
  return JSON.parse(fs.readFileSync(DBF, 'utf8'));
}
function writeDB(data) { fs.writeFileSync(DBF, JSON.stringify(data, null, 2)); }

// ==================== CONFIG ====================
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const OFFERWALL_SECRET = process.env.OFFERWALL_SECRET || 'YOUR_OFFERWALL_SECRET_HERE';
const ADMIN_ID = process.env.ADMIN_ID || '';
const COOLDOWN = 10;
const MIN_WD = 500;
const REF_PCT = 10;
const CNX_RATE = 0.001;

// ==================== UTILS ====================
function genRef(id) {
  return 'CNX' + crypto.createHash('md5').update(id + Date.now() + Math.random()).digest('hex').substring(0, 8).toUpperCase();
}

function checkHash(initData) {
  if (!initData) return false;
  const p = new URLSearchParams(initData);
  const h = p.get('hash');
  if (!h) return false;
  p.delete('hash');
  const arr = [...p.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const s = arr.map(([k, v]) => `${k}=${v}`).join('\n');
  const sk = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const ch = crypto.createHmac('sha256', sk).update(s).digest('hex');
  return ch === h;
}

function getUser(initData) {
  const p = new URLSearchParams(initData);
  const u = p.get('user');
  if (!u) return null;
  try { return JSON.parse(u); } catch { return null; }
}

function getIP(req) {
  return req.headers['x-forwarded-for'] || req.socket.remoteAddress || '0.0.0.0';
}

function ok(res, data) { res.json({ success: true, ...data }); }
function err(res, msg, code) { res.status(code || 400).json({ success: false, error: msg }); }

function isAdmin(uid) {
  return ADMIN_ID && String(uid) === String(ADMIN_ID);
}

// ==================== DB HELPERS ====================
const DB = {
  async getUser(id) {
    if (firebaseOk) { const d = await db.collection('users').doc(id).get(); return d.exists ? { id: d.id, ...d.data() } : null; }
    return readDB().users[id] || null;
  },
  async setUser(id, data) {
    if (firebaseOk) { await db.collection('users').doc(id).set(data, { merge: true }); }
    else { const d = readDB(); d.users[id] = { ...d.users[id], ...data }; writeDB(d); }
  },
  async addWD(data) {
    if (firebaseOk) { await db.collection('withdrawals').add(data); }
    else { const d = readDB(); d.withdrawals.push(data); writeDB(d); }
  },
  async getWDs(uid) {
    if (firebaseOk) { const s = await db.collection('withdrawals').where('telegram_id', '==', uid).orderBy('created_at', 'desc').get(); return s.docs.map(d => d.data()); }
    return readDB().withdrawals.filter(w => w.telegram_id === uid).sort((a, b) => b.created_at - a.created_at);
  },
  async getAllWDs() {
    if (firebaseOk) { const s = await db.collection('withdrawals').orderBy('created_at', 'desc').get(); return s.docs.map(d => d.data()); }
    return readDB().withdrawals.sort((a, b) => b.created_at - a.created_at);
  },
  async updateWD(wid, status) {
    if (firebaseOk) {
      const s = await db.collection('withdrawals').where('id', '==', wid).get();
      if (!s.empty) { await s.docs[0].ref.update({ status, processed_at: Math.floor(Date.now() / 1000) }); return true; }
      return false;
    }
    const d = readDB();
    const w = d.withdrawals.find(x => x.id === wid);
    if (w) { w.status = status; w.processed_at = Math.floor(Date.now() / 1000); writeDB(d); return true; }
    return false;
  },
  async addTask(data) {
    if (firebaseOk) { await db.collection('tasks').add(data); }
    else { const d = readDB(); d.tasks.push(data); writeDB(d); }
  },
  async todayTasks(uid, tid) {
    if (firebaseOk) { const t = new Date(); t.setHours(0, 0, 0, 0); const s = await db.collection('tasks').where('telegram_id', '==', uid).where('task_id', '==', tid).where('created_at', '>=', Math.floor(t.getTime() / 1000)).get(); return s.docs.map(d => d.data()); }
    const today = new Date().toISOString().split('T')[0];
    return readDB().tasks.filter(t => t.telegram_id === uid && t.task_id === tid && new Date(t.created_at * 1000).toISOString().split('T')[0] === today);
  },
  async getRefs(uid) {
    if (firebaseOk) { const s = await db.collection('referrals').where('referrer_id', '==', uid).get(); return s.docs.map(d => d.data()); }
    return readDB().referrals.filter(r => r.referrer_id === uid);
  },
  async addRef(data) {
    if (firebaseOk) { await db.collection('referrals').add(data); }
    else { const d = readDB(); d.referrals.push(data); writeDB(d); }
  },
  async getLB() {
    if (firebaseOk) { const s = await db.collection('users').orderBy('total_earned', 'desc').limit(20).get(); return s.docs.map(d => ({ id: d.id, ...d.data() })); }
    return Object.values(readDB().users).sort((a, b) => (b.total_earned || 0) - (a.total_earned || 0)).slice(0, 20);
  },
  async getStats() {
    if (firebaseOk) { const us = await db.collection('users').get(); const sd = await db.collection('settings').doc('global').get(); const s = sd.exists ? sd.data() : {}; return { total_users: us.size, total_claims: s.total_claims || 0, total_withdrawn: s.total_withdrawn || 0 }; }
    const d = readDB(); return { total_users: Object.keys(d.users).length, total_claims: d.settings?.total_claims || 0, total_withdrawn: d.settings?.total_withdrawn || 0 };
  },
  async incStat(f, a) {
    if (firebaseOk) { await db.collection('settings').doc('global').set({ [f]: admin.firestore.FieldValue.increment(a) }, { merge: true }); }
    else { const d = readDB(); if (!d.settings) d.settings = {}; d.settings[f] = (d.settings[f] || 0) + a; writeDB(d); }
  },
  async logOfferwall(data) {
    if (firebaseOk) { await db.collection('offerwall_logs').add(data); }
    else { const d = readDB(); d.offerwall_logs.push(data); writeDB(d); }
  },
  async getAllUsers() {
    if (firebaseOk) { const s = await db.collection('users').get(); return s.docs.map(d => ({ id: d.id, ...d.data() })); }
    return Object.values(readDB().users);
  }
};

// ==================== PING ====================
app.get('/api/ping', (req, res) => res.send('pong'));

// ==================== AUTH ====================
app.post('/api/auth', async (req, res) => {
  const { initData, ref } = req.body;
  if (!initData) return err(res, 'Missing initData', 401);
  if (BOT_TOKEN !== 'YOUR_BOT_TOKEN_HERE' && !checkHash(initData)) return err(res, 'Invalid initData', 403);

  const tg = getUser(initData);
  if (!tg) return err(res, 'Invalid user', 400);

  const uid = String(tg.id);
  let user = await DB.getUser(uid);

  if (!user) {
    const rc = genRef(uid);
    user = {
      telegram_id: uid, username: tg.username || '', first_name: tg.first_name || '', last_name: tg.last_name || '',
      photo_url: tg.photo_url || '', balance: 0, last_claim: 0, referral_code: rc, referred_by: '',
      created_at: Math.floor(Date.now() / 1000), total_earned: 0, total_withdrawn: 0, ip: getIP(req)
    };
    if (ref) {
      const all = firebaseOk ? (await db.collection('users').where('referral_code', '==', ref).get()).docs.map(d => ({ id: d.id, ...d.data() })) : Object.values(readDB().users).filter(u => u.referral_code === ref);
      const refUser = all.find(u => u.telegram_id !== uid);
      if (refUser) {
        user.referred_by = refUser.telegram_id;
        await DB.addRef({ id: 'ref_' + Date.now(), referrer_id: refUser.telegram_id, referred_id: uid, bonus_earned: 0, created_at: Math.floor(Date.now() / 1000) });
      }
    }
    await DB.setUser(uid, user);
  } else {
    await DB.setUser(uid, { photo_url: tg.photo_url || user.photo_url, username: tg.username || user.username, first_name: tg.first_name || user.first_name });
    user = await DB.getUser(uid);
  }

  const { ip, ...safe } = user;
  ok(res, { user: safe, referral_link: `https://t.me/YOUR_BOT_USERNAME?start=${safe.referral_code}`, is_admin: isAdmin(uid) });
});

app.get('/api/user', async (req, res) => {
  const initData = req.headers['x-telegram-initdata'] || req.query.initData;
  if (!initData) return err(res, 'Missing initData', 401);
  const tg = getUser(initData);
  if (!tg) return err(res, 'Invalid user', 400);
  const uid = String(tg.id);
  const user = await DB.getUser(uid);
  if (!user) return err(res, 'User not found', 404);
  const refs = await DB.getRefs(uid);
  const re = refs.reduce((s, r) => s + (r.bonus_earned || 0), 0);
  const { ip, ...safe } = user;
  ok(res, { user: safe, referrals_count: refs.length, referral_earnings: re, referral_link: `https://t.me/YOUR_BOT_USERNAME?start=${safe.referral_code}`, is_admin: isAdmin(uid) });
});

// ==================== FAUCET CLAIM ====================
app.post('/api/claim', async (req, res) => {
  const initData = req.headers['x-telegram-initdata'] || req.body.initData;
  if (!initData) return err(res, 'Missing initData', 401);
  const tg = getUser(initData);
  if (!tg) return err(res, 'Invalid user', 400);
  const uid = String(tg.id);
  const user = await DB.getUser(uid);
  if (!user) return err(res, 'User not found', 404);

  const now = Math.floor(Date.now() / 1000);
  if (now - user.last_claim < COOLDOWN) {
    const wait = COOLDOWN - (now - user.last_claim);
    return err(res, 'Cooldown active', 429);
  }

  const reward = Math.floor(Math.random() * 10) + 1;
  const nb = (user.balance || 0) + reward;
  const ne = (user.total_earned || 0) + reward;
  await DB.setUser(uid, { balance: nb, total_earned: ne, last_claim: now });
  await DB.incStat('total_claims', 1);

  if (user.referred_by) {
    const ref = await DB.getUser(user.referred_by);
    if (ref) {
      const bonus = Math.round(reward * (REF_PCT / 100) * 100) / 100;
      await DB.setUser(user.referred_by, { balance: (ref.balance || 0) + bonus, total_earned: (ref.total_earned || 0) + bonus });
    }
  }

  ok(res, { reward, balance: nb, next_claim: now + COOLDOWN });
});

// ==================== WITHDRAW ====================
app.post('/api/withdraw', async (req, res) => {
  const initData = req.headers['x-telegram-initdata'] || req.body.initData;
  if (!initData) return err(res, 'Missing initData', 401);
  const { amount, address, method } = req.body;
  if (!amount || amount < MIN_WD) return err(res, `Minimum ${MIN_WD} CNX`, 400);
  if (!address) return err(res, 'Address required', 400);
  const tg = getUser(initData);
  if (!tg) return err(res, 'Invalid user', 400);
  const uid = String(tg.id);
  const user = await DB.getUser(uid);
  if (!user) return err(res, 'User not found', 404);
  if ((user.balance || 0) < amount) return err(res, 'Insufficient balance', 400);

  const wid = 'wd_' + Date.now();
  await DB.addWD({ id: wid, telegram_id: uid, amount, address, method: method || 'faucetpay', status: 'pending', created_at: Math.floor(Date.now() / 1000), processed_at: 0, ip: getIP(req) });
  await DB.setUser(uid, { balance: (user.balance || 0) - amount, total_withdrawn: (user.total_withdrawn || 0) + amount });
  await DB.incStat('total_withdrawn', amount);
  const u2 = await DB.getUser(uid);
  ok(res, { withdrawal_id: wid, status: 'pending', balance: u2.balance, message: 'Withdrawal request submitted. Admin will review soon.' });
});

app.get('/api/withdrawals', async (req, res) => {
  const initData = req.headers['x-telegram-initdata'] || req.query.initData;
  if (!initData) return err(res, 'Missing initData', 401);
  const tg = getUser(initData);
  if (!tg) return err(res, 'Invalid user', 400);
  const wds = await DB.getWDs(String(tg.id));
  ok(res, { withdrawals: wds.map(w => { const { ip, ...s } = w; return s; }) });
});

// ==================== TASKS ====================
app.get('/api/tasks', (req, res) => {
  ok(res, { tasks: [
    { id: 'ptc_1', type: 'ptc', title: 'Visit Crypto News', reward: 5, url: '#', icon: 'LINK' },
    { id: 'ptc_2', type: 'ptc', title: 'Visit Trading Site', reward: 8, url: '#', icon: 'LINK' },
    { id: 'ptc_3', type: 'ptc', title: 'Visit Exchange', reward: 10, url: '#', icon: 'LINK' },
    { id: 'short_1', type: 'shortlink', title: 'Shortlink #1', reward: 15, url: '#', icon: 'BOLT' },
    { id: 'short_2', type: 'shortlink', title: 'Shortlink #2', reward: 20, url: '#', icon: 'BOLT' },
    { id: 'offer_1', type: 'offerwall', title: 'Complete Survey', reward: 100, url: '#', icon: 'DOC' },
    { id: 'offer_2', type: 'offerwall', title: 'Install App', reward: 500, url: '#', icon: 'MOB' },
    { id: 'offer_3', type: 'offerwall', title: 'Watch Video', reward: 50, url: '#', icon: 'PLAY' },
  ]});
});

app.post('/api/task-complete', async (req, res) => {
  const initData = req.headers['x-telegram-initdata'] || req.body.initData;
  if (!initData) return err(res, 'Missing initData', 401);
  const { task_id, reward } = req.body;
  if (!task_id || !reward) return err(res, 'Invalid task', 400);
  const tg = getUser(initData);
  if (!tg) return err(res, 'Invalid user', 400);
  const uid = String(tg.id);
  const user = await DB.getUser(uid);
  if (!user) return err(res, 'User not found', 404);
  const tt = await DB.todayTasks(uid, task_id);
  if (tt.length > 0) return err(res, 'Already completed today', 400);

  await DB.addTask({ id: 'task_' + Date.now(), telegram_id: uid, task_id, reward, status: 'completed', created_at: Math.floor(Date.now() / 1000) });
  const nb = (user.balance || 0) + reward;
  const ne = (user.total_earned || 0) + reward;
  await DB.setUser(uid, { balance: nb, total_earned: ne });

  if (user.referred_by) {
    const ref = await DB.getUser(user.referred_by);
    if (ref) {
      const bonus = Math.round(reward * (REF_PCT / 100) * 100) / 100;
      await DB.setUser(user.referred_by, { balance: (ref.balance || 0) + bonus, total_earned: (ref.total_earned || 0) + bonus });
    }
  }
  ok(res, { reward, balance: nb });
});

// ==================== SWAP ====================
app.get('/api/swap-rate', (req, res) => {
  ok(res, { cnx_to_usdt: CNX_RATE, usdt_to_cnx: Math.round(1 / CNX_RATE * 100) / 100, rate_display: `1 CNX = ${CNX_RATE} USDT` });
});

app.post('/api/swap', async (req, res) => {
  const initData = req.headers['x-telegram-initdata'] || req.body.initData;
  if (!initData) return err(res, 'Missing initData', 401);
  const { amount, direction } = req.body;
  if (!amount || amount <= 0) return err(res, 'Invalid amount', 400);
  const tg = getUser(initData);
  if (!tg) return err(res, 'Invalid user', 400);
  const uid = String(tg.id);
  const user = await DB.getUser(uid);
  if (!user) return err(res, 'User not found', 404);

  if (direction === 'cnx_to_usdt') {
    if ((user.balance || 0) < amount) return err(res, 'Insufficient CNX', 400);
    const rec = Math.round(amount * CNX_RATE * 1000000) / 1000000;
    const nb = (user.balance || 0) - amount;
    await DB.setUser(uid, { balance: nb });
    ok(res, { sent: amount, received: rec, direction, balance: nb });
  } else {
    const rec = Math.round(amount / CNX_RATE * 100) / 100;
    const nb = (user.balance || 0) + rec;
    await DB.setUser(uid, { balance: nb });
    ok(res, { sent: amount, received: rec, direction, balance: nb });
  }
});

// ==================== POSTBACK (AOYCO COMPATIBLE) ====================
// AoyCo sends: ?sub_id={sub_id}&amount={amount}&payout={payout}&status={status}&signature={signature}&transaction_id={transaction_id}
// Also supports: user_id, reward, value, token
app.all('/api/postback', async (req, res) => {
  // Support both GET query and POST body
  const data = { ...req.query, ...req.body };

  // AoyCo parameter mapping
  const uid = data.sub_id || data.user_id || data.external_identifier || data.player_id || '';
  const amount = parseFloat(data.amount || data.reward || data.payout || data.value || data.currency_amount || 0);
  const payout_usd = parseFloat(data.payout_usd || data.payout || 0);
  const status = data.status || data.callback_type || 'completed';
  const signature = data.signature || data.sig || '';
  const transaction_id = data.transaction_id || data.transId || data.token || data.tid || 'tx_' + Date.now();
  const offer_id = data.offer_id || data.adslot_id || 'unknown';
  const is_chargeback = data.is_chargeback === '1' || data.is_chargeback === 1 || status === 'chargeback' || status === 'reversed';

  console.log('[POSTBACK] Received:', { uid, amount, payout_usd, status, transaction_id, signature: signature ? '***' : 'none' });

  if (!uid || !amount || amount <= 0) {
    console.log('[POSTBACK] REJECTED: Missing uid or amount');
    return res.status(400).send('INVALID_PARAMS');
  }

  // Verify signature if secret is configured
  if (OFFERWALL_SECRET !== 'YOUR_OFFERWALL_SECRET_HERE') {
    let checkSig = '';

    // Try AoyCo format: md5(sub_id + amount + secret)
    checkSig = crypto.createHash('md5').update(String(uid) + String(amount) + OFFERWALL_SECRET).digest('hex');

    if (checkSig !== signature) {
      // Try alternate format: md5(secret + sub_id + amount)
      checkSig = crypto.createHash('md5').update(OFFERWALL_SECRET + String(uid) + String(amount)).digest('hex');

      if (checkSig !== signature) {
        // Try PubScale format: md5(secret.user_id.int(value).token)
        const token = data.token || '';
        const intAmount = Math.floor(amount);
        checkSig = crypto.createHash('md5').update(`${OFFERWALL_SECRET}.${uid}.${intAmount}.${token}`).digest('hex');

        if (checkSig !== signature) {
          console.log('[POSTBACK] REJECTED: Invalid signature');
          return res.status(403).send('INVALID_SIGNATURE');
        }
      }
    }
  }

  // Check for duplicate transaction
  const existingLogs = firebaseOk 
    ? (await db.collection('offerwall_logs').where('transaction_id', '==', transaction_id).get()).docs.map(d => d.data())
    : readDB().offerwall_logs.filter(l => l.transaction_id === transaction_id);

  if (existingLogs.length > 0) {
    console.log('[POSTBACK] DUPLICATE transaction_id:', transaction_id);
    return res.send('OK_DUPLICATE');
  }

  // Handle chargebacks
  if (is_chargeback) {
    console.log('[POSTBACK] CHARGEBACK for:', uid, 'amount:', amount);
    const user = await DB.getUser(uid);
    if (!user) return res.status(404).send('USER_NOT_FOUND');

    const deduction = Math.min(amount, user.balance || 0);
    const nb = (user.balance || 0) - deduction;
    await DB.setUser(uid, { balance: nb });
    await DB.logOfferwall({ uid, amount: -deduction, payout_usd, status: 'chargeback', transaction_id, offer_id, source: 'offerwall', created_at: Math.floor(Date.now() / 1000), ip: getIP(req) });
    return res.send('OK_CHARGEBACK');
  }

  // Only process completed conversions
  if (status !== 'completed' && status !== '1' && status !== 'approved' && status !== 'conversion') {
    console.log('[POSTBACK] SKIPPED: status not completed:', status);
    return res.send('OK_NOT_COMPLETED');
  }

  // Log the postback
  await DB.logOfferwall({
    uid, amount, payout_usd, status, transaction_id, offer_id,
    source: 'offerwall', created_at: Math.floor(Date.now() / 1000), ip: getIP(req)
  });

  // Add reward to user
  const user = await DB.getUser(uid);
  if (!user) {
    console.log('[POSTBACK] USER_NOT_FOUND:', uid);
    return res.status(404).send('USER_NOT_FOUND');
  }

  const cnxReward = Math.round(amount); // Convert to CNX
  const nb = (user.balance || 0) + cnxReward;
  const ne = (user.total_earned || 0) + cnxReward;
  await DB.setUser(uid, { balance: nb, total_earned: ne });
  await DB.incStat('total_offerwall', cnxReward);

  // Referral bonus
  if (user.referred_by) {
    const ref = await DB.getUser(user.referred_by);
    if (ref) {
      const bonus = Math.round(cnxReward * (REF_PCT / 100) * 100) / 100;
      await DB.setUser(user.referred_by, { balance: (ref.balance || 0) + bonus, total_earned: (ref.total_earned || 0) + bonus });
    }
  }

  console.log('[POSTBACK] SUCCESS:', uid, '+', cnxReward, 'CNX');
  res.send('OK');
});

// ==================== LEADERBOARD & STATS ====================
app.get('/api/leaderboard', async (req, res) => {
  const lb = await DB.getLB();
  ok(res, { leaderboard: lb.map(u => ({ username: u.username || u.first_name || 'User', total_earned: u.total_earned || 0, balance: u.balance || 0 })) });
});

app.get('/api/stats', async (req, res) => {
  const s = await DB.getStats();
  ok(res, { ...s, claim_cooldown: COOLDOWN, min_withdraw: MIN_WD });
});

// ==================== ADMIN PANEL ====================
app.get('/api/admin/withdrawals', async (req, res) => {
  const initData = req.headers['x-telegram-initdata'] || req.query.initData;
  if (!initData) return err(res, 'Missing initData', 401);
  const tg = getUser(initData);
  if (!tg) return err(res, 'Invalid user', 400);
  if (!isAdmin(tg.id)) return err(res, 'Forbidden', 403);

  const wds = await DB.getAllWDs();
  ok(res, { withdrawals: wds.map(w => { const { ip, ...s } = w; return s; }) });
});

app.post('/api/admin/withdrawal/:id', async (req, res) => {
  const initData = req.headers['x-telegram-initdata'] || req.body.initData;
  if (!initData) return err(res, 'Missing initData', 401);
  const tg = getUser(initData);
  if (!tg) return err(res, 'Invalid user', 400);
  if (!isAdmin(tg.id)) return err(res, 'Forbidden', 403);

  const { status } = req.body;
  if (!status || !['approved', 'rejected'].includes(status)) return err(res, 'Invalid status', 400);

  const ok2 = await DB.updateWD(req.params.id, status);
  if (!ok2) return err(res, 'Withdrawal not found', 404);
  ok(res, { message: `Withdrawal ${status}` });
});

app.get('/api/admin/users', async (req, res) => {
  const initData = req.headers['x-telegram-initdata'] || req.query.initData;
  if (!initData) return err(res, 'Missing initData', 401);
  const tg = getUser(initData);
  if (!tg) return err(res, 'Invalid user', 400);
  if (!isAdmin(tg.id)) return err(res, 'Forbidden', 403);

  const users = await DB.getAllUsers();
  ok(res, { users: users.map(u => { const { ip, ...s } = u; return s; }) });
});

app.get('/api/admin/stats', async (req, res) => {
  const initData = req.headers['x-telegram-initdata'] || req.query.initData;
  if (!initData) return err(res, 'Missing initData', 401);
  const tg = getUser(initData);
  if (!tg) return err(res, 'Invalid user', 400);
  if (!isAdmin(tg.id)) return err(res, 'Forbidden', 403);

  const stats = await DB.getStats();
  const wds = await DB.getAllWDs();
  const pending = wds.filter(w => w.status === 'pending').length;
  ok(res, { ...stats, total_withdrawals: wds.length, pending_withdrawals: pending });
});

// ==================== START ====================
app.listen(PORT, () => {
  console.log(`\n🚀 CoinixFaucet on port ${PORT}`);
  console.log(`🔥 Firebase: ${firebaseOk ? 'ON' : 'OFF (JSON fallback)'}`);
  console.log(`📡 Postback: ${API_URL}/api/postback`);
  console.log(`👑 Admin: ${ADMIN_ID ? 'SET (' + ADMIN_ID + ')' : 'NOT SET'}`);
  console.log(`⚠️  Set BOT_TOKEN, OFFERWALL_SECRET, ADMIN_ID env vars\n`);
});

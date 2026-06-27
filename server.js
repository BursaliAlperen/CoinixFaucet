require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const admin = require('firebase-admin');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME || 'your_bot';

// ========================
// Firebase Admin Setup
// ========================
const serviceAccountPath = path.resolve('./serviceAccountKey.json');
let serviceAccount;
try {
  serviceAccount = require(serviceAccountPath);
} catch (e) {
  console.error('FATAL: serviceAccountKey.json not found. Please upload the Firebase service account JSON to the project root.');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ========================
// Middleware
// ========================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ========================
// Utilities
// ========================
const now = () => admin.firestore.Timestamp.now();
const serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp();
const increment = (n) => admin.firestore.FieldValue.increment(n);

async function logAction(action, userId, details = {}) {
  try {
    await db.collection('logs').add({
      action,
      user_id: userId || null,
      details,
      ip: details.ip || null,
      timestamp: serverTimestamp()
    });
  } catch (e) {
    console.error('Log error:', e.message);
  }
}

function validateTelegramInitData(initData) {
  if (!initData || !BOT_TOKEN) return false;
  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    if (!hash) return false;
    urlParams.delete('hash');
    urlParams.sort();
    const dataCheckString = Array.from(urlParams.entries()).map(([k, v]) => `${k}=${v}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const checkHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    return hash === checkHash;
  } catch (e) {
    return false;
  }
}

function adminAuth(req, res, next) {
  const key = req.query.admin_key || req.headers['x-admin-key'];
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ========================
// 1. Health Check
// ========================
app.get('/ping', (req, res) => res.status(200).send('OK'));

// ========================
// 2. Auth
// ========================
app.post('/api/auth', async (req, res) => {
  const { initData, ref } = req.body;
  if (!initData) return res.status(400).json({ error: 'Missing initData' });

  const isValid = validateTelegramInitData(initData);
  if (!isValid) return res.status(403).json({ error: 'Invalid Telegram data' });

  let user;
  try {
    const urlParams = new URLSearchParams(initData);
    user = JSON.parse(urlParams.get('user'));
  } catch (e) {
    return res.status(400).json({ error: 'Bad user data' });
  }

  if (!user || !user.id) return res.status(400).json({ error: 'No user data' });

  const userId = String(user.id);
  const userRef = db.collection('users').doc(userId);

  try {
    const doc = await userRef.get();
    if (!doc.exists) {
      const newUser = {
        telegram_id: userId,
        username: user.username || null,
        first_name: user.first_name || null,
        last_name: user.last_name || null,
        photo_url: user.photo_url || null,
        balance: 0,
        doge_balance: 0,
        total_earned: 0,
        total_doge_earned: 0,
        total_claims: 0,
        total_withdrawals: 0,
        referrals: 0,
        referral_earnings: 0,
        referred_by: ref || null,
        banned: false,
        last_claim: null,
        created_at: serverTimestamp()
      };
      await userRef.set(newUser);

      if (ref && ref !== userId) {
        const refRef = db.collection('users').doc(String(ref));
        const refDoc = await refRef.get();
        if (refDoc.exists && !refDoc.data().banned) {
          await refRef.update({
            referrals: increment(1),
            balance: increment(50),
            referral_earnings: increment(50)
          });
          await db.collection('referrals').add({
            referrer_id: String(ref),
            referred_id: userId,
            bonus: 50,
            timestamp: serverTimestamp()
          });
          await logAction('referral_bonus', String(ref), { referred_id: userId, bonus: 50 });
        }
      }
      await logAction('user_register', userId, { username: user.username, ref });
    } else {
      const updates = {};
      if (user.photo_url) updates.photo_url = user.photo_url;
      if (user.username) updates.username = user.username;
      if (Object.keys(updates).length) await userRef.update(updates);
    }
    res.json({ success: true, user_id: userId, username: user.username });
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).json({ error: 'Auth failed' });
  }
});

// ========================
// 3. Balance
// ========================
app.get('/api/balance/:userId', async (req, res) => {
  try {
    const doc = await db.collection('users').doc(String(req.params.userId)).get();
    if (!doc.exists) {
      return res.json({ balance: 0, doge_balance: 0, total_earned: 0, total_doge_earned: 0, total_claims: 0, total_withdrawals: 0, referrals: 0, referral_earnings: 0, last_claim: null });
    }
    const d = doc.data();
    res.json({
      balance: d.balance || 0,
      doge_balance: d.doge_balance || 0,
      total_earned: d.total_earned || 0,
      total_doge_earned: d.total_doge_earned || 0,
      total_claims: d.total_claims || 0,
      total_withdrawals: d.total_withdrawals || 0,
      referrals: d.referrals || 0,
      referral_earnings: d.referral_earnings || 0,
      last_claim: d.last_claim ? d.last_claim.toMillis() : null
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ========================
// 4. Faucet Claim
// ========================
app.post('/api/claim', async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });

  const userRef = db.collection('users').doc(String(user_id));

  try {
    const result = await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error('NO_USER');
      const data = doc.data();
      if (data.banned) throw new Error('BANNED');

      const settingsDoc = await db.collection('settings').doc('faucet').get();
      const settings = settingsDoc.exists ? settingsDoc.data() : {};
      const cooldownMs = (settings.cooldown_seconds || 10) * 1000;
      const minReward = settings.min_reward || 1;
      const maxReward = settings.max_reward || 10;
      const paused = settings.paused || false;

      if (paused) throw new Error('PAUSED');

      if (data.last_claim) {
        const elapsed = now().toMillis() - data.last_claim.toMillis();
        if (elapsed < cooldownMs) throw new Error('COOLDOWN');
      }

      const reward = Math.floor(Math.random() * (maxReward - minReward + 1)) + minReward;
      t.update(userRef, {
        balance: increment(reward),
        total_earned: increment(reward),
        total_claims: increment(1),
        last_claim: now()
      });
      return { reward, newBalance: (data.balance || 0) + reward };
    });

    await logAction('claim', user_id, { reward: result.reward, ip: req.ip });
    res.json({ success: true, reward: result.reward, balance: result.newBalance });
  } catch (err) {
    if (err.message === 'COOLDOWN') return res.status(429).json({ error: 'Cooldown active' });
    if (err.message === 'NO_USER') return res.status(404).json({ error: 'User not found' });
    if (err.message === 'BANNED') return res.status(403).json({ error: 'Account banned' });
    if (err.message === 'PAUSED') return res.status(503).json({ error: 'Faucet paused' });
    console.error('Claim error:', err);
    res.status(500).json({ error: 'Claim failed' });
  }
});

// ========================
// 5. Withdraw
// ========================
app.post('/api/withdraw', async (req, res) => {
  const { user_id, amount, address } = req.body;
  if (!user_id || !amount || !address) return res.status(400).json({ error: 'Missing parameters' });

  const amt = Number(amount);
  if (isNaN(amt) || amt < 1) return res.status(400).json({ error: 'Invalid amount' });

  const userRef = db.collection('users').doc(String(user_id));
  const withdrawRef = db.collection('withdrawals').doc();

  try {
    await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error('NO_USER');
      const data = doc.data();
      if (data.banned) throw new Error('BANNED');
      if ((data.balance || 0) < amt) throw new Error('NO_FUNDS');

      t.update(userRef, { balance: increment(-amt), total_withdrawals: increment(1) });
      t.set(withdrawRef, {
        user_id: String(user_id),
        amount: amt,
        address: String(address),
        status: 'pending',
        timestamp: serverTimestamp()
      });
    });

    await logAction('withdraw_request', user_id, { amount: amt, address, ip: req.ip });
    res.json({ success: true, message: 'Withdrawal request submitted for approval' });
  } catch (err) {
    if (err.message === 'NO_FUNDS') return res.status(400).json({ error: 'Insufficient balance' });
    if (err.message === 'NO_USER') return res.status(404).json({ error: 'User not found' });
    if (err.message === 'BANNED') return res.status(403).json({ error: 'Account banned' });
    res.status(500).json({ error: 'Withdraw request failed' });
  }
});

// ========================
// 6. Swap
// ========================
app.post('/api/swap', async (req, res) => {
  const { user_id, from_amount, from_token } = req.body;
  if (!user_id || !from_amount || !from_token) return res.status(400).json({ error: 'Missing parameters' });

  const amt = Number(from_amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!['CNX', 'DOGE'].includes(from_token)) return res.status(400).json({ error: 'Invalid token' });

  const rate = from_token === 'CNX' ? 0.1 : 10;
  const toToken = from_token === 'CNX' ? 'DOGE' : 'CNX';
  const toAmount = parseFloat((amt * rate).toFixed(4));

  const userRef = db.collection('users').doc(String(user_id));
  const swapRef = db.collection('swaps').doc();

  try {
    await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error('NO_USER');
      const data = doc.data();
      if (data.banned) throw new Error('BANNED');
      const field = from_token === 'CNX' ? 'balance' : 'doge_balance';
      if ((data[field] || 0) < amt) throw new Error('NO_FUNDS');

      const updates = {};
      updates[field] = increment(-amt);
      const toField = toToken === 'CNX' ? 'balance' : 'doge_balance';
      updates[toField] = increment(toAmount);
      if (toToken === 'DOGE') updates.total_doge_earned = increment(toAmount);
      t.update(userRef, updates);

      t.set(swapRef, {
        user_id: String(user_id),
        from_token,
        from_amount: amt,
        to_token: toToken,
        to_amount: toAmount,
        rate,
        timestamp: serverTimestamp()
      });
    });

    await logAction('swap', user_id, { from: from_token, amount: amt, to: toToken, received: toAmount });
    res.json({ success: true, from: from_token, to: toToken, received: toAmount, rate });
  } catch (err) {
    if (err.message === 'NO_FUNDS') return res.status(400).json({ error: 'Insufficient ' + from_token + ' balance' });
    if (err.message === 'NO_USER') return res.status(404).json({ error: 'User not found' });
    if (err.message === 'BANNED') return res.status(403).json({ error: 'Account banned' });
    res.status(500).json({ error: 'Swap failed' });
  }
});

app.get('/api/swap/rate', (req, res) => {
  res.json({ cnx_to_doge: 0.1, doge_to_cnx: 10 });
});

// ========================
// 7. Referral
// ========================
app.get('/api/referral/:userId', async (req, res) => {
  try {
    const doc = await db.collection('users').doc(String(req.params.userId)).get();
    if (!doc.exists) return res.json({ referrals: 0, earnings: 0, link: '' });
    const d = doc.data();
    res.json({
      referrals: d.referrals || 0,
      earnings: d.referral_earnings || 0,
      link: 'https://t.me/' + BOT_USERNAME + '?start=ref' + req.params.userId
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.get('/api/referrals/:userId', async (req, res) => {
  try {
    const snap = await db.collection('referrals')
      .where('referrer_id', '==', String(req.params.userId))
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();
    const refs = [];
    snap.forEach(doc => {
      const d = doc.data();
      refs.push({ referred_id: d.referred_id, bonus: d.bonus, timestamp: d.timestamp ? d.timestamp.toMillis() : null });
    });
    res.json(refs);
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// ========================
// 8. History
// ========================
app.get('/api/history/:userId', async (req, res) => {
  try {
    const uid = String(req.params.userId);
    const history = [];

    const [claimsSnap, wdSnap, swapSnap] = await Promise.all([
      db.collection('logs').where('user_id', '==', uid).where('action', '==', 'claim').orderBy('timestamp', 'desc').limit(50).get(),
      db.collection('withdrawals').where('user_id', '==', uid).orderBy('timestamp', 'desc').limit(50).get(),
      db.collection('swaps').where('user_id', '==', uid).orderBy('timestamp', 'desc').limit(50).get()
    ]);

    claimsSnap.forEach(doc => {
      const d = doc.data();
      history.push({ type: 'claim', amount: d.details?.reward || 0, token: 'CNX', timestamp: d.timestamp ? d.timestamp.toMillis() : null, status: 'completed' });
    });
    wdSnap.forEach(doc => {
      const d = doc.data();
      history.push({ type: 'withdraw', amount: d.amount, token: 'CNX', address: d.address, timestamp: d.timestamp ? d.timestamp.toMillis() : null, status: d.status });
    });
    swapSnap.forEach(doc => {
      const d = doc.data();
      history.push({ type: 'swap', from_token: d.from_token, from_amount: d.from_amount, to_token: d.to_token, to_amount: d.to_amount, timestamp: d.timestamp ? d.timestamp.toMillis() : null, status: 'completed' });
    });

    history.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    res.json(history.slice(0, 50));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// ========================
// 9. Postback (Offerwall)
// ========================
app.post('/api/postback', async (req, res) => {
  const { user_id, reward, signature } = req.body;
  if (!user_id || reward === undefined || !signature) return res.status(400).json({ error: 'Missing parameters' });

  const payload = String(user_id) + ':' + String(reward);
  const expected = crypto.createHmac('sha256', BOT_TOKEN).update(payload).digest('hex');
  if (signature !== expected) {
    await logAction('postback_rejected', user_id, { reason: 'invalid_signature', ip: req.ip });
    return res.status(403).json({ error: 'Invalid signature' });
  }

  try {
    const userRef = db.collection('users').doc(String(user_id));
    await userRef.set({
      balance: increment(Number(reward)),
      total_earned: increment(Number(reward))
    }, { merge: true });
    await logAction('postback', user_id, { reward: Number(reward), ip: req.ip });
    res.json({ success: true, message: 'Reward credited' });
  } catch (err) {
    res.status(500).json({ error: 'Postback processing failed' });
  }
});

// ========================
// 10. Stats
// ========================
app.get('/api/stats', async (req, res) => {
  try {
    const usersSnap = await db.collection('users').get();
    let totalUsers = 0, totalBalance = 0, totalDoge = 0, totalClaims = 0, totalWithdrawn = 0, activeToday = 0;
    const dayAgo = Date.now() - 86400000;

    usersSnap.forEach(doc => {
      const d = doc.data();
      totalUsers++;
      totalBalance += d.balance || 0;
      totalDoge += d.doge_balance || 0;
      totalClaims += d.total_claims || 0;
      if (d.last_claim && d.last_claim.toMillis() > dayAgo) activeToday++;
    });

    const withdrawSnap = await db.collection('withdrawals').where('status', '==', 'approved').get();
    withdrawSnap.forEach(doc => totalWithdrawn += doc.data().amount || 0);

    const pendingSnap = await db.collection('withdrawals').where('status', '==', 'pending').get();

    res.json({ totalUsers, totalBalance, totalDoge, totalClaims, activeToday, totalWithdrawn, pendingWithdrawals: pendingSnap.size });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.get('/api/stats/user/:userId', async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(String(req.params.userId)).get();
    if (!userDoc.exists) return res.json({ balance: 0, claims: 0, earned: 0, withdrawn: 0, referrals: 0 });
    const d = userDoc.data();
    const wdSnap = await db.collection('withdrawals').where('user_id', '==', String(req.params.userId)).where('status', '==', 'approved').get();
    let withdrawn = 0;
    wdSnap.forEach(doc => withdrawn += doc.data().amount || 0);
    res.json({ balance: d.balance || 0, claims: d.total_claims || 0, earned: d.total_earned || 0, withdrawn, referrals: d.referrals || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// ========================
// 11. Offerwall Verification
// ========================
app.get('/offerwall-verification-XMLbUdRaXY8jOv7YXykOYi47Oh65ZPKM.txt', (req, res) => {
  res.set('Content-Type', 'text/plain').set('Cache-Control', 'no-cache, no-store, must-revalidate').send('XMLbUdRaXY8jOv7YXykOYi47Oh65ZPKM');
});
app.get('/verification.txt', (req, res) => {
  res.set('Content-Type', 'text/plain').send('XMLbUdRaXY8jOv7YXykOYi47Oh65ZPKM');
});

// ========================
// 12. Admin API
// ========================
app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('users').get();
    const users = [];
    snapshot.forEach(doc => {
      const d = doc.data();
      users.push({
        id: doc.id,
        username: d.username || null,
        first_name: d.first_name || null,
        balance: d.balance || 0,
        doge_balance: d.doge_balance || 0,
        total_earned: d.total_earned || 0,
        total_claims: d.total_claims || 0,
        referrals: d.referrals || 0,
        referral_earnings: d.referral_earnings || 0,
        banned: d.banned || false,
        last_claim: d.last_claim ? d.last_claim.toMillis() : null,
        created_at: d.created_at ? d.created_at.toMillis() : null
      });
    });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.get('/api/admin/withdrawals', adminAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('withdrawals').orderBy('timestamp', 'desc').get();
    const items = [];
    snapshot.forEach(doc => {
      const d = doc.data();
      items.push({ id: doc.id, user_id: d.user_id, amount: d.amount, address: d.address, status: d.status, timestamp: d.timestamp ? d.timestamp.toMillis() : null });
    });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }
});

app.post('/api/admin/approve-withdrawal', adminAuth, async (req, res) => {
  const { id, status } = req.body;
  if (!id || !['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Bad request' });

  try {
    const ref = db.collection('withdrawals').doc(id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    const data = doc.data();
    if (data.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    if (status === 'rejected') {
      const userRef = db.collection('users').doc(data.user_id);
      await userRef.update({ balance: increment(data.amount), total_withdrawals: increment(-1) });
    }
    await ref.update({ status });
    await logAction('withdraw_' + status, data.user_id, { withdrawal_id: id, amount: data.amount });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update' });
  }
});

app.post('/api/admin/add-balance', adminAuth, async (req, res) => {
  const { user_id, amount } = req.body;
  if (!user_id || amount === undefined) return res.status(400).json({ error: 'Missing parameters' });
  try {
    const userRef = db.collection('users').doc(String(user_id));
    await userRef.set({ balance: increment(Number(amount)) }, { merge: true });
    await logAction('admin_balance_adjust', user_id, { amount: Number(amount) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.post('/api/admin/ban-user', adminAuth, async (req, res) => {
  const { user_id, banned } = req.body;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });
  try {
    await db.collection('users').doc(String(user_id)).update({ banned: !!banned });
    await logAction('admin_ban', user_id, { banned: !!banned });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.post('/api/admin/delete-user', adminAuth, async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });
  try {
    await db.collection('users').doc(String(user_id)).delete();
    await logAction('admin_delete_user', user_id, {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.get('/api/admin/logs', adminAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('logs').orderBy('timestamp', 'desc').limit(200).get();
    const logs = [];
    snapshot.forEach(doc => {
      const d = doc.data();
      logs.push({ id: doc.id, action: d.action, user_id: d.user_id, details: d.details, timestamp: d.timestamp ? d.timestamp.toMillis() : null });
    });
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

app.get('/api/admin/settings', adminAuth, async (req, res) => {
  try {
    const doc = await db.collection('settings').doc('faucet').get();
    res.json(doc.exists ? doc.data() : { cooldown_seconds: 10, min_reward: 1, max_reward: 10, min_withdraw: 1, paused: false });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.post('/api/admin/settings', adminAuth, async (req, res) => {
  const { cooldown_seconds, min_reward, max_reward, min_withdraw, paused } = req.body;
  try {
    await db.collection('settings').doc('faucet').set({
      cooldown_seconds: Number(cooldown_seconds) || 10,
      min_reward: Number(min_reward) || 1,
      max_reward: Number(max_reward) || 10,
      min_withdraw: Number(min_withdraw) || 1,
      paused: !!paused
    }, { merge: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.post('/api/admin/broadcast', adminAuth, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Missing message' });
  try {
    await db.collection('broadcasts').add({
      message: String(message),
      timestamp: serverTimestamp(),
      sent: false
    });
    res.json({ success: true, message: 'Broadcast queued' });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// ========================
// 13. Admin Panel Page
// ========================
app.get('/admin', (req, res) => {
  const key = req.query.admin_key;
  if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(403).send('Forbidden');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ========================
// 14. Page Routes
// ========================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/faucet', (req, res) => res.sendFile(path.join(__dirname, 'public', 'faucet.html')));
app.get('/ptc', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ptc.html')));
app.get('/withdraw', (req, res) => res.sendFile(path.join(__dirname, 'public', 'withdraw.html')));
app.get('/swap', (req, res) => res.sendFile(path.join(__dirname, 'public', 'swap.html')));
app.get('/history', (req, res) => res.sendFile(path.join(__dirname, 'public', 'history.html')));

// ========================
// 15. Error Handling
// ========================
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log('COINIXFAUCET v2.0 running on port ' + PORT);
});

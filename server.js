require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const admin = require('firebase-admin');
const crypto = require('crypto');
const https = require('https');

// Handle unhandled promise rejections (prevents Render crash)
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME || 'your_bot';
const FAUCET_API_KEY = process.env.FAUCET_API_KEY;
const AOYCO_API_KEY = process.env.AOYCO_API_KEY || 'XMLbUdRaXY8jOv7YXykOYi47Oh65ZPKM';
const AOYCO_SECRET_KEY = process.env.AOYCO_SECRET_KEY || '8rqHlIJ0pkYdrlQgQc0t07Mh9fjRjM2XW5CmhUtG';

// ========================
// Keep-Alive Mechanism
// ========================
setInterval(() => {
  https.get('https://coinixfaucet.onrender.com/ping', (res) => {
    console.log(`Keep-alive ping: ${res.statusCode}`);
  }).on('error', (err) => {
    console.log('Keep-alive ping error:', err.message);
  });
}, 600000); // Every 10 minutes

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
// 1. Health Check & Keep-Alive
// ========================
app.get('/ping', (req, res) => {
  console.log('Keep-alive ping received at', new Date().toISOString());
  res.status(200).send('OK');
});

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
            balance: increment(50), // 30% bonus in CNX
            referral_earnings: increment(50)
          });
          await db.collection('referrals').add({
            referrer_id: String(ref),
            referred_id: userId,
            bonus: 50,
            currency: 'CNX',
            timestamp: serverTimestamp()
          });
          await logAction('referral_bonus', String(ref), { referred_id: userId, bonus: 50, currency: 'CNX' });
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

      const lastClaimTime = data.last_claim ? data.last_claim.toMillis() : 0;
      const now = Date.now();
      if (now - lastClaimTime < cooldownMs) throw new Error('COOLDOWN');

      const reward = Math.random() * (maxReward - minReward) + minReward;
      t.update(userRef, {
        balance: increment(reward),
        total_earned: increment(reward),
        total_claims: increment(1),
        last_claim: admin.firestore.Timestamp.now()
      });

      await logAction('claim', user_id, { reward, timestamp: now });
      return { success: true, reward };
    });
    res.json(result);
  } catch (err) {
    if (err.message === 'COOLDOWN') {
      res.status(429).json({ error: 'Cooldown active', message: 'Come back later' });
    } else if (err.message === 'BANNED') {
      res.status(403).json({ error: 'Banned' });
    } else if (err.message === 'NO_USER') {
      res.status(404).json({ error: 'User not found' });
    } else {
      console.error('Claim error:', err);
      res.status(500).json({ error: 'Claim failed' });
    }
  }
});

// ========================
// 5. Withdrawal
// ========================
app.post('/api/withdraw', async (req, res) => {
  const { user_id, amount, address, currency } = req.body;
  
  if (!user_id || !amount || !address) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  // Only FaucetPay and DOGE withdrawals allowed
  if (currency !== 'faucetpay' && currency !== 'doge') {
    return res.status(400).json({ error: 'Invalid currency' });
  }

  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount < 0.10) {
    return res.status(400).json({ error: 'Minimum withdrawal is 0.10' });
  }

  const userRef = db.collection('users').doc(String(user_id));

  try {
    const result = await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error('NO_USER');
      
      const data = doc.data();
      const balanceField = currency === 'doge' ? 'doge_balance' : 'balance';
      const currentBalance = data[balanceField] || 0;

      if (currentBalance < numAmount) throw new Error('INSUFFICIENT');

      const withdrawalRef = db.collection('withdrawals').doc();
      t.set(withdrawalRef, {
        user_id: String(user_id),
        username: data.username || 'Unknown',
        amount: numAmount,
        address,
        currency,
        status: 'pending',
        timestamp: admin.firestore.Timestamp.now()
      });

      t.update(userRef, {
        [balanceField]: increment(-numAmount),
        total_withdrawals: increment(1)
      });

      await logAction('withdrawal_request', user_id, { amount: numAmount, currency, address });

      return { success: true, withdrawal_id: withdrawalRef.id };
    });
    res.json(result);
  } catch (err) {
    if (err.message === 'INSUFFICIENT') {
      res.status(400).json({ error: 'Insufficient balance' });
    } else if (err.message === 'NO_USER') {
      res.status(404).json({ error: 'User not found' });
    } else {
      console.error('Withdrawal error:', err);
      res.status(500).json({ error: 'Withdrawal failed' });
    }
  }
});

// ========================
// 6. Withdrawal History
// ========================
app.get('/api/withdrawals/:userId', async (req, res) => {
  try {
    const snapshot = await db.collection('withdrawals')
      .where('user_id', '==', String(req.params.userId))
      .orderBy('timestamp', 'desc')
      .get();
    
    const withdrawals = [];
    snapshot.forEach(doc => {
      const d = doc.data();
      withdrawals.push({
        id: doc.id,
        amount: d.amount,
        address: d.address,
        currency: d.currency,
        status: d.status,
        timestamp: d.timestamp ? d.timestamp.toMillis() : null
      });
    });
    res.json(withdrawals);
  } catch (err) {
    console.error('Withdrawal history error:', err);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// ========================
// 7. Swap
// ========================
app.post('/api/swap', async (req, res) => {
  const { user_id, from_currency, to_currency, amount } = req.body;

  if (!user_id || !from_currency || !to_currency || !amount) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  // Only swap between CNX and DOGE
  if ((from_currency !== 'cnx' && from_currency !== 'doge') ||
      (to_currency !== 'cnx' && to_currency !== 'doge')) {
    return res.status(400).json({ error: 'Invalid currency pair' });
  }

  if (from_currency === to_currency) {
    return res.status(400).json({ error: 'Cannot swap same currency' });
  }

  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const userRef = db.collection('users').doc(String(user_id));

  try {
    const result = await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error('NO_USER');
      
      const data = doc.data();
      const fromField = from_currency === 'doge' ? 'doge_balance' : 'balance';
      const toField = to_currency === 'doge' ? 'doge_balance' : 'balance';
      const fromBalance = data[fromField] || 0;

      if (fromBalance < numAmount) throw new Error('INSUFFICIENT');

      // 1:1 conversion rate
      const swapAmount = numAmount;
      t.update(userRef, {
        [fromField]: increment(-numAmount),
        [toField]: increment(swapAmount)
      });

      await logAction('swap', user_id, { from: from_currency, to: to_currency, amount: numAmount });

      return { success: true, swapped_amount: swapAmount };
    });
    res.json(result);
  } catch (err) {
    if (err.message === 'INSUFFICIENT') {
      res.status(400).json({ error: 'Insufficient balance' });
    } else if (err.message === 'NO_USER') {
      res.status(404).json({ error: 'User not found' });
    } else {
      console.error('Swap error:', err);
      res.status(500).json({ error: 'Swap failed' });
    }
  }
});

// ========================
// 8. Stats
// ========================
app.get('/api/stats', adminAuth, async (req, res) => {
  try {
    const usersSnap = await db.collection('users').get();
    const totalUsers = usersSnap.size;

    let totalBalance = 0, totalDoge = 0;
    usersSnap.forEach(doc => {
      const d = doc.data();
      totalBalance += d.balance || 0;
      totalDoge += d.doge_balance || 0;
    });

    const claimsSnap = await db.collection('logs').where('action', '==', 'claim').get();
    const totalClaims = claimsSnap.size;

    const now = Date.now();
    const todayStart = new Date(now).setHours(0, 0, 0, 0);
    const claimsTodaySnap = await db.collection('logs')
      .where('action', '==', 'claim')
      .where('timestamp', '>=', admin.firestore.Timestamp.fromMillis(todayStart))
      .get();
    const activeToday = new Set();
    claimsTodaySnap.forEach(doc => {
      const d = doc.data();
      if (d.user_id) activeToday.add(d.user_id);
    });

    const withdrawSnap = await db.collection('withdrawals').get();
    let totalWithdrawn = 0;
    withdrawSnap.forEach(doc => totalWithdrawn += doc.data().amount || 0);

    const pendingSnap = await db.collection('withdrawals').where('status', '==', 'pending').get();

    res.json({ totalUsers, totalBalance, totalDoge, totalClaims, activeToday: activeToday.size, totalWithdrawn, pendingWithdrawals: pendingSnap.size });
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
// 9. Offerwall Verification
// ========================
app.get('/offerwall-verification-XMLbUdRaXY8jOv7YXykOYi47Oh65ZPKM.txt', (req, res) => {
  res.set('Content-Type', 'text/plain').set('Cache-Control', 'no-cache, no-store, must-revalidate').send('XMLbUdRaXY8jOv7YXykOYi47Oh65ZPKM');
});
app.get('/verification.txt', (req, res) => {
  res.set('Content-Type', 'text/plain').send('XMLbUdRaXY8jOv7YXykOYi47Oh65ZPKM');
});

// ========================
// 10. Admin API
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
      items.push({ 
        id: doc.id, 
        user_id: d.user_id, 
        username: d.username || 'Unknown',
        amount: d.amount, 
        address: d.address, 
        currency: d.currency,
        status: d.status, 
        timestamp: d.timestamp ? d.timestamp.toMillis() : null 
      });
    });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }
});

app.post('/api/admin/approve-withdrawal', adminAuth, async (req, res) => {
  const { id, status } = req.body;
  if (!id || !['approved', 'rejected', 'paid', 'canceled'].includes(status)) return res.status(400).json({ error: 'Bad request' });

  try {
    const ref = db.collection('withdrawals').doc(id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    const data = doc.data();
    if (data.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    if (status === 'rejected' || status === 'canceled') {
      const userRef = db.collection('users').doc(data.user_id);
      const balanceField = data.currency === 'doge' ? 'doge_balance' : 'balance';
      await userRef.update({ [balanceField]: increment(data.amount), total_withdrawals: increment(-1) });
    }
    await ref.update({ status, updated_at: admin.firestore.Timestamp.now() });
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
    res.json(doc.exists ? doc.data() : { cooldown_seconds: 10, min_reward: 1, max_reward: 10, min_withdraw: 0.10, paused: false });
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
      min_withdraw: Number(min_withdraw) || 0.10,
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
// 11. Admin Panel Page
// ========================
app.get('/admin', (req, res) => {
  const key = req.query.admin_key;
  if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(403).send('Forbidden');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ========================
// 12. Page Routes
// ========================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/faucet', (req, res) => res.sendFile(path.join(__dirname, 'public', 'faucet.html')));
app.get('/ptc', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ptc.html')));
app.get('/withdraw', (req, res) => res.sendFile(path.join(__dirname, 'public', 'withdraw.html')));
app.get('/swap', (req, res) => res.sendFile(path.join(__dirname, 'public', 'swap.html')));
app.get('/history', (req, res) => res.sendFile(path.join(__dirname, 'public', 'history.html')));

// ========================
// 13. Error Handling
// ========================
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log('COINIX FAUCET v2.1 running on port ' + PORT);
  console.log('Keep-alive enabled');
});

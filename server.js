require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const path = require('path');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

// ========================
// Firebase Admin Setup
// ========================
const serviceAccountPath = process.env.SERVICE_ACCOUNT || './serviceAccountKey.json';
const serviceAccount = require(path.resolve(serviceAccountPath));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID
});
const db = admin.firestore();

// ========================
// Middleware
// ========================
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files from public/
app.use(express.static(path.join(__dirname, 'public')));

// ========================
// Logger
// ========================
async function logAction(action, userId, details = {}) {
  try {
    await db.collection('logs').add({
      action,
      user_id: userId || null,
      details,
      ip: details.ip || null,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    console.error('Log error:', e.message);
  }
}

// ========================
// 1. Keep Alive
// ========================
app.get('/ping', (req, res) => res.status(200).send('OK'));

// ========================
// 2. Telegram WebApp Auth (validate initData)
// ========================
function validateTelegramInitData(initData) {
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');

  const dataCheckString = Array.from(urlParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData')
    .update(process.env.BOT_TOKEN)
    .digest();

  const checkHash = crypto.createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  return hash === checkHash;
}

// ========================
// 3. User Registration / Login (Telegram auto-login)
// ========================
app.post('/api/auth', async (req, res) => {
  const { initData, ref } = req.body;

  // Validate Telegram initData
  let user = null;
  if (initData && process.env.BOT_TOKEN) {
    try {
      const isValid = validateTelegramInitData(initData);
      if (!isValid) return res.status(403).json({ error: 'Invalid Telegram data' });

      const urlParams = new URLSearchParams(initData);
      const userData = JSON.parse(urlParams.get('user'));
      user = userData;
    } catch (e) {
      console.error('Auth parse error:', e);
    }
  }

  if (!user) return res.status(400).json({ error: 'No user data' });

  const userId = String(user.id);
  const userRef = db.collection('users').doc(userId);

  try {
    const doc = await userRef.get();
    if (!doc.exists) {
      // New user - create with referral tracking
      const newUser = {
        telegram_id: userId,
        username: user.username || null,
        first_name: user.first_name || null,
        last_name: user.last_name || null,
        photo_url: user.photo_url || null,
        balance: 0,
        doge_balance: 0,
        total_earned: 0,
        total_claims: 0,
        referrals: 0,
        referral_earnings: 0,
        referred_by: ref || null,
        last_claim: null,
        created_at: admin.firestore.FieldValue.serverTimestamp()
      };
      await userRef.set(newUser);

      // Credit referrer if exists
      if (ref && ref !== userId) {
        const refRef = db.collection('users').doc(String(ref));
        const refDoc = await refRef.get();
        if (refDoc.exists) {
          await refRef.update({
            referrals: admin.firestore.FieldValue.increment(1),
            balance: admin.firestore.FieldValue.increment(50), // 50 CNX referral bonus
            referral_earnings: admin.firestore.FieldValue.increment(50)
          });
          await db.collection('referrals').add({
            referrer_id: String(ref),
            referred_id: userId,
            bonus: 50,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          });
          await logAction('referral_bonus', String(ref), { referred_id: userId, bonus: 50 });
        }
      }

      await logAction('user_register', userId, { username: user.username, ref });
    } else {
      // Update existing user photo if changed
      const updates = {};
      if (user.photo_url) updates.photo_url = user.photo_url;
      if (user.username) updates.username = user.username;
      if (Object.keys(updates).length > 0) {
        await userRef.update(updates);
      }
    }

    res.json({ success: true, user_id: userId, username: user.username });
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).json({ error: 'Auth failed' });
  }
});

// ========================
// 4. Balance API
// ========================
app.get('/api/balance/:userId', async (req, res) => {
  try {
    const doc = await db.collection('users').doc(String(req.params.userId)).get();
    if (!doc.exists) {
      return res.json({ balance: 0, doge_balance: 0, total_earned: 0, total_claims: 0, referrals: 0, referral_earnings: 0, last_claim: null });
    }
    const data = doc.data();
    res.json({
      balance: data.balance || 0,
      doge_balance: data.doge_balance || 0,
      total_earned: data.total_earned || 0,
      total_claims: data.total_claims || 0,
      referrals: data.referrals || 0,
      referral_earnings: data.referral_earnings || 0,
      last_claim: data.last_claim ? data.last_claim.toMillis() : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ========================
// 5. Faucet Claim
// ========================
app.post('/api/claim', async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });

  const userRef = db.collection('users').doc(String(user_id));

  try {
    const result = await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      const now = admin.firestore.Timestamp.now();
      const data = doc.exists ? doc.data() : { balance: 0, total_earned: 0, total_claims: 0, last_claim: null };

      if (data.last_claim) {
        const elapsed = now.toMillis() - data.last_claim.toMillis();
        if (elapsed < 10000) {
          throw new Error('COOLDOWN');
        }
      }

      const reward = Math.floor(Math.random() * 10) + 1;
      const newBalance = (data.balance || 0) + reward;
      const newTotalEarned = (data.total_earned || 0) + reward;
      const newTotalClaims = (data.total_claims || 0) + 1;

      t.update(userRef, {
        balance: newBalance,
        total_earned: newTotalEarned,
        total_claims: newTotalClaims,
        last_claim: now
      });
      return { reward, newBalance, newTotalEarned, newTotalClaims };
    });

    await logAction('claim', user_id, { reward: result.reward, ip: req.ip });
    res.json({ success: true, reward: result.reward, balance: result.newBalance, total_earned: result.newTotalEarned, total_claims: result.newTotalClaims });
  } catch (err) {
    if (err.message === 'COOLDOWN') {
      return res.status(429).json({ error: 'Cooldown active. Wait 10 seconds.' });
    }
    console.error('Claim error:', err);
    res.status(500).json({ error: 'Claim failed' });
  }
});

// ========================
// 6. Postback (Offerwall)
// ========================
app.post('/api/postback', async (req, res) => {
  const { user_id, reward, signature } = req.body;
  if (!user_id || reward === undefined || !signature) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const payload = String(user_id) + ':' + String(reward);
  const expected = crypto
    .createHmac('sha256', process.env.BOT_TOKEN)
    .update(payload)
    .digest('hex');

  if (signature !== expected) {
    await logAction('postback_rejected', user_id, { reason: 'invalid_signature', ip: req.ip });
    return res.status(403).json({ error: 'Invalid signature' });
  }

  try {
    const userRef = db.collection('users').doc(String(user_id));
    await userRef.set({
      balance: admin.firestore.FieldValue.increment(Number(reward)),
      total_earned: admin.firestore.FieldValue.increment(Number(reward))
    }, { merge: true });

    await logAction('postback', user_id, { reward: Number(reward), ip: req.ip });
    res.json({ success: true, message: 'Reward credited' });
  } catch (err) {
    console.error('Postback error:', err);
    res.status(500).json({ error: 'Postback processing failed' });
  }
});

// ========================
// 7. Withdraw Request
// ========================
app.post('/api/withdraw', async (req, res) => {
  const { user_id, amount, address } = req.body;
  if (!user_id || !amount || !address) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const userRef = db.collection('users').doc(String(user_id));
  const withdrawRef = db.collection('withdrawals').doc();

  try {
    await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error('NO_USER');
      const data = doc.data();
      if ((data.balance || 0) < amt) throw new Error('NO_FUNDS');

      t.update(userRef, { balance: admin.firestore.FieldValue.increment(-amt) });
      t.set(withdrawRef, {
        user_id: String(user_id),
        amount: amt,
        address: String(address),
        status: 'pending',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    await logAction('withdraw_request', user_id, { amount: amt, address, ip: req.ip });
    res.json({ success: true, message: 'Withdrawal request submitted for approval' });
  } catch (err) {
    if (err.message === 'NO_FUNDS') return res.status(400).json({ error: 'Insufficient balance' });
    if (err.message === 'NO_USER') return res.status(404).json({ error: 'User not found' });
    console.error('Withdraw error:', err);
    res.status(500).json({ error: 'Withdraw request failed' });
  }
});

// ========================
// 8. Swap System
// ========================
app.post('/api/swap', async (req, res) => {
  const { user_id, from_amount, from_token } = req.body;
  if (!user_id || !from_amount || !from_token) {
    return res.status(400).json({ error: 'Missing parameters' });
  }
  const amt = Number(from_amount);
  if (isNaN(amt) || amt <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }
  if (!['CNX', 'DOGE'].includes(from_token)) {
    return res.status(400).json({ error: 'Invalid token' });
  }

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
      const field = from_token === 'CNX' ? 'balance' : 'doge_balance';
      if ((data[field] || 0) < amt) throw new Error('NO_FUNDS');

      const updates = {};
      updates[field] = admin.firestore.FieldValue.increment(-amt);
      const toField = toToken === 'CNX' ? 'balance' : 'doge_balance';
      updates[toField] = admin.firestore.FieldValue.increment(toAmount);
      t.update(userRef, updates);

      t.set(swapRef, {
        user_id: String(user_id),
        from_token: from_token,
        from_amount: amt,
        to_token: toToken,
        to_amount: toAmount,
        rate: rate,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    await logAction('swap', user_id, { from: from_token, amount: amt, to: toToken, received: toAmount });
    res.json({ success: true, from: from_token, to: toToken, received: toAmount, rate });
  } catch (err) {
    if (err.message === 'NO_FUNDS') return res.status(400).json({ error: 'Insufficient ' + from_token + ' balance' });
    if (err.message === 'NO_USER') return res.status(404).json({ error: 'User not found' });
    console.error('Swap error:', err);
    res.status(500).json({ error: 'Swap failed' });
  }
});

app.get('/api/swap/rate', (req, res) => {
  res.json({ cnx_to_doge: 0.1, doge_to_cnx: 10 });
});

// ========================
// 9. Referral System
// ========================
app.get('/api/referral/:userId', async (req, res) => {
  try {
    const doc = await db.collection('users').doc(String(req.params.userId)).get();
    if (!doc.exists) return res.json({ referrals: 0, earnings: 0, link: '' });
    const data = doc.data();
    res.json({
      referrals: data.referrals || 0,
      earnings: data.referral_earnings || 0,
      link: 'https://t.me/' + (process.env.BOT_USERNAME || 'your_bot') + '?start=ref' + req.params.userId
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
      refs.push({
        referred_id: d.referred_id,
        bonus: d.bonus,
        timestamp: d.timestamp ? d.timestamp.toMillis() : null
      });
    });
    res.json(refs);
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// ========================
// 10. History API
// ========================
app.get('/api/history/:userId', async (req, res) => {
  try {
    const uid = String(req.params.userId);
    const history = [];

    const claimsSnap = await db.collection('logs')
      .where('user_id', '==', uid)
      .where('action', '==', 'claim')
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();
    claimsSnap.forEach(doc => {
      const d = doc.data();
      history.push({
        type: 'claim',
        amount: d.details?.reward || 0,
        token: 'CNX',
        timestamp: d.timestamp ? d.timestamp.toMillis() : null,
        status: 'completed'
      });
    });

    const wdSnap = await db.collection('withdrawals')
      .where('user_id', '==', uid)
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();
    wdSnap.forEach(doc => {
      const d = doc.data();
      history.push({
        type: 'withdraw',
        amount: d.amount,
        token: 'CNX',
        address: d.address,
        timestamp: d.timestamp ? d.timestamp.toMillis() : null,
        status: d.status
      });
    });

    const swapSnap = await db.collection('swaps')
      .where('user_id', '==', uid)
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();
    swapSnap.forEach(doc => {
      const d = doc.data();
      history.push({
        type: 'swap',
        from_token: d.from_token,
        from_amount: d.from_amount,
        to_token: d.to_token,
        to_amount: d.to_amount,
        timestamp: d.timestamp ? d.timestamp.toMillis() : null,
        status: 'completed'
      });
    });

    history.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    res.json(history.slice(0, 50));
  } catch (err) {
    console.error('History error:', err);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// ========================
// 11. Stats API
// ========================
app.get('/api/stats', async (req, res) => {
  try {
    const usersSnap = await db.collection('users').get();
    let totalUsers = 0;
    let totalBalance = 0;
    let totalClaims = 0;
    let activeToday = 0;
    const now = Date.now();
    const dayAgo = now - 86400000;

    usersSnap.forEach(doc => {
      const d = doc.data();
      totalUsers++;
      totalBalance += d.balance || 0;
      if (d.last_claim) {
        totalClaims += d.total_claims || 0;
        if (d.last_claim.toMillis() > dayAgo) activeToday++;
      }
    });

    const withdrawSnap = await db.collection('withdrawals').get();
    let totalWithdrawn = 0;
    let pendingWithdrawals = 0;
    withdrawSnap.forEach(doc => {
      const d = doc.data();
      if (d.status === 'approved') totalWithdrawn += d.amount || 0;
      if (d.status === 'pending') pendingWithdrawals++;
    });

    res.json({
      totalUsers,
      totalBalance,
      totalClaims,
      activeToday,
      totalWithdrawn,
      pendingWithdrawals
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.get('/api/stats/user/:userId', async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(String(req.params.userId)).get();
    if (!userDoc.exists) return res.json({ balance: 0, claims: 0, earned: 0, withdrawn: 0, referrals: 0 });

    const userData = userDoc.data();
    const balance = userData.balance || 0;
    const claims = userData.total_claims || 0;
    const earned = userData.total_earned || 0;
    const referrals = userData.referrals || 0;

    const wdSnap = await db.collection('withdrawals')
      .where('user_id', '==', String(req.params.userId))
      .where('status', '==', 'approved')
      .get();
    let withdrawn = 0;
    wdSnap.forEach(doc => withdrawn += doc.data().amount || 0);

    res.json({ balance, claims, earned, withdrawn, referrals });
  } catch (err) {
    console.error('User stats error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// ========================
// 12. AoyCo Offerwall Verification
// ========================
app.get('/offerwall-verification-XMLbUdRaXY8jOv7YXykOYi47Oh65ZPKM.txt', (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send('XMLbUdRaXY8jOv7YXykOYi47Oh65ZPKM');
});

app.get('/verification.txt', (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send('XMLbUdRaXY8jOv7YXykOYi47Oh65ZPKM');
});

// ========================
// 13. Admin Middleware
// ========================
function adminAuth(req, res, next) {
  const key = req.query.admin_key || req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_ID) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ========================
// 14. Admin API Routes
// ========================
app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('users').get();
    const users = [];
    snapshot.forEach(doc => {
      const d = doc.data();
      users.push({
        id: doc.id,
        balance: d.balance || 0,
        total_earned: d.total_earned || 0,
        total_claims: d.total_claims || 0,
        referrals: d.referrals || 0,
        last_claim: d.last_claim ? d.last_claim.toMillis() : null
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
        amount: d.amount,
        address: d.address,
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
  if (!id || !['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Bad request' });
  }

  try {
    const ref = db.collection('withdrawals').doc(id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });

    const data = doc.data();
    if (data.status !== 'pending') {
      return res.status(400).json({ error: 'Already processed' });
    }

    if (status === 'rejected') {
      const userRef = db.collection('users').doc(data.user_id);
      await userRef.update({ balance: admin.firestore.FieldValue.increment(data.amount) });
    }

    await ref.update({ status });
    await logAction('withdraw_' + status, data.user_id, { withdrawal_id: id, amount: data.amount });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update' });
  }
});

app.post('/api/admin/add-balance', adminAuth, async (req, res) => {
  const { user_id, amount } = req.body;
  if (!user_id || amount === undefined) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  try {
    const userRef = db.collection('users').doc(String(user_id));
    await userRef.set({
      balance: admin.firestore.FieldValue.increment(Number(amount))
    }, { merge: true });

    await logAction('admin_balance_adjust', user_id, { amount: Number(amount) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.get('/api/admin/logs', adminAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('logs').orderBy('timestamp', 'desc').limit(100).get();
    const logs = [];
    snapshot.forEach(doc => {
      const d = doc.data();
      logs.push({
        id: doc.id,
        action: d.action,
        user_id: d.user_id,
        details: d.details,
        timestamp: d.timestamp ? d.timestamp.toMillis() : null
      });
    });
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// ========================
// 15. Admin Panel Page
// ========================
app.get('/admin', (req, res) => {
  const key = req.query.admin_key;
  if (key !== process.env.ADMIN_ID) {
    return res.status(403).send('<h1>403 Forbidden</h1>');
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>COINIX Admin</title>
<style>
body{font-family:monospace,monospace;background:#f5f5f5;padding:20px;margin:0;color:#333;}
h1{font-size:20px;border-bottom:2px solid #333;padding-bottom:8px;}
h2{font-size:16px;margin-top:24px;margin-bottom:8px;}
table{width:100%;border-collapse:collapse;background:#fff;margin-bottom:16px;font-size:13px;}
th,td{border:1px solid #ccc;padding:6px;text-align:left;}
th{background:#e0e0e0;}
input{padding:6px;border:1px solid #999;font-family:monospace;}
button{padding:6px 10px;background:#333;color:#fff;border:none;cursor:pointer;font-family:monospace;}
button:hover{background:#555;}
.actions button{margin-right:4px;font-size:12px;}
</style>
</head>
<body>
<h1>COINIXFAUCET ADMIN (CNX)</h1>

<h2>Users</h2>
<table id="tblUsers">
<thead><tr><th>ID</th><th>Balance</th><th>Earned</th><th>Claims</th><th>Referrals</th><th>Last Claim</th></tr></thead>
<tbody></tbody>
</table>

<h2>Pending Withdrawals</h2>
<table id="tblWithdrawals">
<thead><tr><th>ID</th><th>User</th><th>Amount</th><th>Address</th><th>Status</th><th>Action</th></tr></thead>
<tbody></tbody>
</table>

<h2>Adjust Balance</h2>
<p>User ID: <input type="text" id="adjUser" placeholder="telegram_id"></p>
<p>Amount (+/-): <input type="number" id="adjAmt" placeholder="e.g. 50 or -20"></p>
<p><button onclick="adjust()">Update Balance</button></p>

<h2>Recent Logs</h2>
<table id="tblLogs">
<thead><tr><th>Action</th><th>User</th><th>Details</th><th>Time</th></tr></thead>
<tbody></tbody>
</table>

<script>
var ADMIN_KEY=new URLSearchParams(location.search).get('admin_key');
var hdr={'x-admin-key':ADMIN_KEY};

function fmtTime(ts){ if(!ts)return '-'; return new Date(ts).toLocaleString(); }

function loadUsers(){
  fetch('/api/admin/users',{headers:hdr}).then(r=>r.json()).then(data=>{
    var rows=data.map(u=>'<tr><td>'+u.id+'</td><td>'+u.balance+'</td><td>'+(u.total_earned||0)+'</td><td>'+(u.total_claims||0)+'</td><td>'+(u.referrals||0)+'</td><td>'+fmtTime(u.last_claim)+'</td></tr>').join('');
    document.querySelector('#tblUsers tbody').innerHTML=rows;
  });
}

function loadWithdrawals(){
  fetch('/api/admin/withdrawals',{headers:hdr}).then(r=>r.json()).then(data=>{
    var rows=data.map(w=>'<tr><td>'+w.id+'</td><td>'+w.user_id+'</td><td>'+w.amount+'</td><td>'+w.address+'</td><td>'+w.status+'</td><td class="actions">'+
      (w.status==='pending'?'<button onclick="act(&#39;'+w.id+'&#39;, &#39;approved&#39;)">Approve</button> <button onclick="act(&#39;'+w.id+'&#39;, &#39;rejected&#39;)">Reject</button>':'-')+
      '</td></tr>').join('');
    document.querySelector('#tblWithdrawals tbody').innerHTML=rows;
  });
}

function act(id,status){
  fetch('/api/admin/approve-withdrawal',{method:'POST',headers:{'Content-Type':'application/json',...hdr},body:JSON.stringify({id,status})})
    .then(()=>loadWithdrawals());
}

function adjust(){
  var user=document.getElementById('adjUser').value;
  var amt=document.getElementById('adjAmt').value;
  fetch('/api/admin/add-balance',{method:'POST',headers:{'Content-Type':'application/json',...hdr},body:JSON.stringify({user_id:user,amount:Number(amt)})})
    .then(()=>{ loadUsers(); document.getElementById('adjUser').value=''; document.getElementById('adjAmt').value=''; });
}

function loadLogs(){
  fetch('/api/admin/logs',{headers:hdr}).then(r=>r.json()).then(data=>{
    var rows=data.map(l=>'<tr><td>'+l.action+'</td><td>'+(l.user_id||'-')+'</td><td>'+JSON.stringify(l.details)+'</td><td>'+fmtTime(l.timestamp)+'</td></tr>').join('');
    document.querySelector('#tblLogs tbody').innerHTML=rows;
  });
}

loadUsers(); loadWithdrawals(); loadLogs();
</script>
</body>
</html>`);
});

// ========================
// 16. Serve HTML Pages from public/
// ========================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/faucet', (req, res) => res.sendFile(path.join(__dirname, 'public', 'faucet.html')));
app.get('/ptc', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ptc.html')));
app.get('/withdraw', (req, res) => res.sendFile(path.join(__dirname, 'public', 'withdraw.html')));
app.get('/swap', (req, res) => res.sendFile(path.join(__dirname, 'public', 'swap.html')));
app.get('/history', (req, res) => res.sendFile(path.join(__dirname, 'public', 'history.html')));

// ========================
// 17. Debug: List files
// ========================
app.get('/debug/files', (req, res) => {
  const fs = require('fs');
  try {
    const files = fs.readdirSync(path.join(__dirname, 'public'));
    res.json({
      public_dir: path.join(__dirname, 'public'),
      files: files,
      message: 'These files should be in public/ directory'
    });
  } catch (e) {
    res.status(500).json({ error: e.message, message: 'public/ directory not found!' });
  }
});

app.listen(PORT, () => {
  console.log('COINIXFAUCET server running on port ' + PORT);
  console.log('Serving files from: ' + path.join(__dirname, 'public'));
});

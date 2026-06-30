import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

dotenv.config();

// ============================================
// 🔥 FIREBASE ADMIN INIT
// ============================================
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      type: "service_account",
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      client_id: process.env.FIREBASE_CLIENT_ID,
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
    })
  });
}

const db = getFirestore();
const auth = admin.auth();

// ============================================
// 🔒 SERVER-SIDE CONSTANTS
// ============================================
const COIN_PRICES = {
  BTC: 65000, DOGE: 0.15, DGB: 0.01, FEY: 0.05, POL: 0.5
};

const COIN_REWARDS = {
  BTC:  { min: 0.00000001, max: 0.00000050 },
  DOGE: { min: 100, max: 500 },
  DGB:  { min: 50, max: 200 },
  FEY:  { min: 10, max: 100 },
  POL:  { min: 0.01, max: 0.1 }
};

const VALID_COINS = ['BTC', 'DOGE', 'DGB', 'FEY', 'POL'];
const WITHDRAW_MINIMUM_USD = 0.03;
const CLAIM_COOLDOWN_MS = 60000;
const REFERRAL_RATE = 0.20;

// ============================================
// 🚀 EXPRESS APP
// ============================================
const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['https://coinixfaucet.mine.bz'],
  credentials: true
}));
app.use(express.json({ limit: '10kb' }));
app.set('trust proxy', 1);

// ============================================
// 🔒 RATE LIMITERS
// ============================================
const claimLimiter = rateLimit({ windowMs: 60000, max: 2, message: { success: false, message: 'Too many claims.' } });
const withdrawLimiter = rateLimit({ windowMs: 3600000, max: 10, message: { success: false, message: 'Too many withdrawals.' } });
const authLimiter = rateLimit({ windowMs: 900000, max: 5, message: { success: false, message: 'Too many attempts.' } });

// ============================================
// 🔐 AUTH MIDDLEWARE
// ============================================
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = await auth.verifyIdToken(token);
    req.user = { uid: decoded.uid, email: decoded.email, emailVerified: decoded.email_verified };
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

const requireEmailVerified = (req, res, next) => {
  if (!req.user.emailVerified) {
    return res.status(403).json({ success: false, message: 'Email verification required' });
  }
  next();
};

// 🔐 ADMIN AUTH MIDDLEWARE
const verifyAdmin = (req, res, next) => {
  const key = req.headers['x-admin-key'];
  if (!process.env.ADMIN_SECRET_KEY) {
    return res.status(500).json({ success: false, message: 'Admin not configured' });
  }
  if (key !== process.env.ADMIN_SECRET_KEY) {
    console.warn('⚠️ Unauthorized admin access attempt from', req.ip);
    return res.status(401).json({ success: false, message: 'Invalid admin key' });
  }
  next();
};

// ============================================
// 💖 KEEP-ALIVE ENDPOINT
// ============================================
app.get('/api/keep-alive', (req, res) => {
  res.json({
    success: true,
    status: 'alive',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    message: 'CoinixFaucet backend is awake'
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

// ============================================
// 🔄 SELF PING (Backup keep-alive)
// ============================================
let selfPingInterval;
function startSelfPing() {
  if (selfPingInterval) clearInterval(selfPingInterval);
  selfPingInterval = setInterval(async () => {
    try {
      const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
      await fetch(`${url}/api/keep-alive`);
      console.log('💓 Self-ping successful at', new Date().toISOString());
    } catch (err) {
      console.log('⚠️ Self-ping failed:', err.message);
    }
  }, 14 * 60 * 1000); // 14 dakika (Render 15 dk'da uyutur)
}

// ============================================
// 💰 PRICES (READ ONLY)
// ============================================
app.get('/api/prices', (req, res) => {
  res.json({
    success: true,
    prices: COIN_PRICES,
    rewards: COIN_REWARDS,
    minimumWithdraw: WITHDRAW_MINIMUM_USD,
    claimCooldown: CLAIM_COOLDOWN_MS / 1000
  });
});

// ============================================
// 👤 USER PROFILE
// ============================================
app.get('/api/user', verifyToken, async (req, res) => {
  try {
    const doc = await db.collection('users').doc(req.user.uid).get();
    if (!doc.exists) return res.status(404).json({ success: false, message: 'Not found' });
    const data = doc.data();
    res.json({
      success: true,
      user: {
        uid: data.uid, username: data.username, email: data.email,
        emailVerified: req.user.emailVerified, country: data.country,
        timezone: data.timezone, faucetpayEmail: data.faucetpayEmail,
        referralCode: data.referralCode, balances: data.balances,
        totalWithdrawn: data.totalWithdrawn, referralEarnings: data.referralEarnings,
        referralCount: data.referralCount, totalClaims: data.totalClaims,
        lastClaimAt: data.lastClaimAt, dailyStreak: data.dailyStreak,
        highestStreak: data.highestStreak, level: data.level, xp: data.xp
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error' });
  }
});

// ============================================
// 🚰 CLAIM ENDPOINT (SECURE)
// ============================================
app.post('/api/claim', verifyToken, requireEmailVerified, claimLimiter, async (req, res) => {
  try {
    const { recaptchaToken } = req.body;
    
    // reCAPTCHA verification
    if (recaptchaToken && process.env.RECAPTCHA_API_KEY) {
      try {
        const recaptchaRes = await fetch(
          `https://recaptchaenterprise.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/assessments?key=${process.env.RECAPTCHA_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: {
                token: recaptchaToken,
                expectedAction: 'claim',
                siteKey: process.env.RECAPTCHA_SITE_KEY
              }
            })
          }
        );
        const assessment = await recaptchaRes.json();
        if ((assessment.riskAnalysis?.score || 0) < 0.3) {
          return res.status(403).json({ success: false, message: 'Bot detected' });
        }
      } catch (e) { console.log('reCAPTCHA check failed, continuing:', e.message); }
    }

    const userRef = db.collection('users').doc(req.user.uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: 'User not found' });

    const userData = userDoc.data();
    const now = Date.now();

    if (now - (userData.lastClaimAt || 0) < CLAIM_COOLDOWN_MS) {
      const remaining = Math.ceil((CLAIM_COOLDOWN_MS - (now - userData.lastClaimAt)) / 1000);
      return res.status(429).json({ success: false, message: `Wait ${remaining}s` });
    }

    const coin = VALID_COINS[Math.floor(Math.random() * VALID_COINS.length)];
    const rewardRange = COIN_REWARDS[coin];
    const amount = +(rewardRange.min + Math.random() * (rewardRange.max - rewardRange.min)).toFixed(8);
    const usdValue = +(amount * COIN_PRICES[coin]).toFixed(6);

    await db.runTransaction(async (transaction) => {
      const freshDoc = await transaction.get(userRef);
      if (!freshDoc.exists) throw new Error('User not found');
      const freshData = freshDoc.data();
      if (now - (freshData.lastClaimAt || 0) < CLAIM_COOLDOWN_MS) {
        throw new Error('Cooldown');
      }
      const newBalances = { ...freshData.balances };
      newBalances[coin] = (newBalances[coin] || 0) + amount;
      transaction.update(userRef, {
        balances: newBalances,
        lastClaimAt: now,
        totalClaims: FieldValue.increment(1),
        xp: FieldValue.increment(5)
      });
    });

    await db.collection('claims').add({
      userId: req.user.uid, coin, amount, usdValue,
      createdAt: FieldValue.serverTimestamp()
    });
    await db.collection('transactions').add({
      userId: req.user.uid, type: 'claim', coin, amount, usdValue,
      status: 'completed', createdAt: FieldValue.serverTimestamp()
    });

    // Referral bonus
    if (userData.referredBy) {
      const refSnap = await db.collection('users')
        .where('referralCode', '==', userData.referredBy).limit(1).get();
      if (!refSnap.empty) {
        const refDoc = refSnap.docs[0];
        const refData = refDoc.data();
        await db.collection('users').doc(refDoc.id).update({
          referralEarnings: FieldValue.increment(usdValue * REFERRAL_RATE),
          balances: {
            ...refData.balances,
            [coin]: (refData.balances[coin] || 0) + (amount * REFERRAL_RATE)
          }
        });
      }
    }

    // Update global stats
    await db.collection('global').doc('stats').set({
      totalClaims: FieldValue.increment(1),
      totalPaid: FieldValue.increment(usdValue),
      lastUpdated: FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ success: true, coin, amount, usdValue });
  } catch (error) {
    console.error('Claim error:', error);
    res.status(500).json({ success: false, message: error.message || 'Claim failed' });
  }
});

// ============================================
// 💸 WITHDRAW (SECURE)
// ============================================
app.post('/api/withdraw', verifyToken, requireEmailVerified, withdrawLimiter, async (req, res) => {
  try {
    const { coin } = req.body;
    if (!VALID_COINS.includes(coin?.toUpperCase())) {
      return res.status(400).json({ success: false, message: 'Invalid coin' });
    }
    const coinUpper = coin.toUpperCase();
    const userRef = db.collection('users').doc(req.user.uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: 'Not found' });

    const userData = userDoc.data();
    if (!userData.faucetpayEmail) {
      return res.status(400).json({ success: false, message: 'Set FaucetPay email first' });
    }

    const balance = userData.balances[coinUpper] || 0;
    const balanceUSD = balance * COIN_PRICES[coinUpper];
    if (balanceUSD < WITHDRAW_MINIMUM_USD) {
      return res.status(400).json({ success: false, message: `Min $${WITHDRAW_MINIMUM_USD}` });
    }

    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(userRef);
      const data = fresh.data();
      const b = data.balances[coinUpper] || 0;
      if (b * COIN_PRICES[coinUpper] < WITHDRAW_MINIMUM_USD) throw new Error('Insufficient');
      const newBal = { ...data.balances };
      newBal[coinUpper] = 0;
      tx.update(userRef, { balances: newBal, totalWithdrawn: FieldValue.increment(b * COIN_PRICES[coinUpper]) });
    });

    const txRef = await db.collection('transactions').add({
      userId: req.user.uid, type: 'withdraw', coin: coinUpper,
      amount: balance, usdValue: balanceUSD,
      destination: userData.faucetpayEmail, username: userData.username,
      status: 'completed', createdAt: FieldValue.serverTimestamp()
    });

    // Update global stats
    await db.collection('global').doc('stats').set({
      totalWithdrawals: FieldValue.increment(1),
      totalWithdrawnAmount: FieldValue.increment(balanceUSD),
      lastUpdated: FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({
      success: true, transactionId: txRef.id,
      amount: balance, coin: coinUpper,
      destination: userData.faucetpayEmail, status: 'completed'
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// 📊 DASHBOARD
// ============================================
app.get('/api/dashboard', verifyToken, async (req, res) => {
  try {
    const doc = await db.collection('users').doc(req.user.uid).get();
    if (!doc.exists) return res.status(404).json({ success: false, message: 'Not found' });
    const data = doc.data();
    const totalUSD = VALID_COINS.reduce((s, c) => s + ((data.balances[c] || 0) * COIN_PRICES[c]), 0);
    
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const claimsSnap = await db.collection('claims')
      .where('userId', '==', req.user.uid)
      .where('createdAt', '>=', todayStart).get();
    
    let todayUSD = 0;
    claimsSnap.forEach(d => todayUSD += d.data().usdValue || 0);

    res.json({
      success: true,
      stats: {
        totalBalanceUSD: totalUSD, todayEarnings: todayUSD,
        referralEarnings: data.referralEarnings || 0,
        totalWithdrawn: data.totalWithdrawn || 0,
        totalClaims: data.totalClaims || 0,
        dailyStreak: data.dailyStreak || 0,
        level: data.level || 1
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error' });
  }
});

// ============================================
// 📈 GLOBAL STATS
// ============================================
app.get('/api/stats', async (req, res) => {
  try {
    const usersSnap = await db.collection('users').count().get();
    const claimsSnap = await db.collection('claims').count().get();
    const globalSnap = await db.collection('global').doc('stats').get();
    const globalData = globalSnap.exists ? globalSnap.data() : {};

    res.json({
      success: true,
      stats: {
        totalUsers: usersSnap.data().count,
        totalClaims: claimsSnap.data().count + (globalData.totalClaims || 0),
        totalPaid: globalData.totalPaid || 0,
        totalWithdrawals: globalData.totalWithdrawals || 0,
        totalWithdrawnAmount: globalData.totalWithdrawnAmount || 0
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error' });
  }
});

// ============================================
// 🏆 LEADERBOARD
// ============================================
app.get('/api/leaderboard', async (req, res) => {
  try {
    const snap = await db.collection('users').orderBy('totalClaims', 'desc').limit(100).get();
    const leaderboard = [];
    snap.forEach((doc, i) => {
      const d = doc.data();
      leaderboard.push({
        rank: i + 1, username: d.username, country: d.country,
        totalClaims: d.totalClaims || 0, totalWithdrawn: d.totalWithdrawn || 0,
        level: d.level || 1
      });
    });
    res.json({ success: true, leaderboard });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error' });
  }
});

// ============================================
// ⚙️ SETTINGS
// ============================================
app.put('/api/settings', verifyToken, async (req, res) => {
  try {
    const { username, country, timezone, faucetpayEmail, twoFA, notifications } = req.body;
    const updates = {};
    if (username?.length >= 3) updates.username = username.trim();
    if (country) updates.country = country;
    if (timezone) updates.timezone = timezone;
    if (faucetpayEmail) updates.faucetpayEmail = faucetpayEmail.trim().toLowerCase();
    if (typeof twoFA === 'boolean') updates.twoFA = twoFA;
    if (typeof notifications === 'boolean') updates.notifications = notifications;
    if (Object.keys(updates).length === 0) return res.status(400).json({ success: false });
    await db.collection('users').doc(req.user.uid).update(updates);
    res.json({ success: true, message: 'Saved' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error' });
  }
});

// ============================================
// 📋 TRANSACTIONS
// ============================================
app.get('/api/transactions', verifyToken, async (req, res) => {
  try {
    const { type, limit = 50 } = req.query;
    let query = db.collection('transactions')
      .where('userId', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .limit(Math.min(parseInt(limit) || 50, 100));
    if (type && ['claim', 'withdraw', 'daily-bonus', 'referral'].includes(type)) {
      query = query.where('type', '==', type);
    }
    const snap = await query.get();
    const txs = [];
    snap.forEach(d => txs.push({ id: d.id, ...d.data() }));
    res.json({ success: true, transactions: txs });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error' });
  }
});

// ============================================
// 🎁 DAILY BONUS
// ============================================
app.post('/api/daily-bonus', verifyToken, requireEmailVerified, async (req, res) => {
  try {
    const userRef = db.collection('users').doc(req.user.uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false });
    const data = userDoc.data();
    const today = new Date().toISOString().slice(0, 10);
    const last = data.lastDailyBonus ? new Date(data.lastDailyBonus).toISOString().slice(0, 10) : null;
    if (last === today) return res.status(400).json({ success: false, message: 'Already claimed' });
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const newStreak = last === yesterday ? (data.dailyStreak || 0) + 1 : 1;
    const reward = +(0.001 + Math.min(newStreak * 0.0005, 0.05)).toFixed(4);
    const perCoin = reward / VALID_COINS.length;
    const newBal = { ...data.balances };
    VALID_COINS.forEach(c => newBal[c] = (newBal[c] || 0) + perCoin);
    await userRef.update({
      balances: newBal, lastDailyBonus: Date.now(),
      dailyStreak: newStreak,
      highestStreak: Math.max(data.highestStreak || 0, newStreak),
      claimedDays: FieldValue.arrayUnion(newStreak)
    });
    await db.collection('transactions').add({
      userId: req.user.uid, type: 'daily-bonus', coin: 'BONUS',
      amount: reward, usdValue: reward, day: newStreak,
      status: 'completed', createdAt: FieldValue.serverTimestamp()
    });
    res.json({ success: true, day: newStreak, reward, newStreak });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// 🔐 RECAPTCHA VERIFY (for frontend)
// ============================================
app.post('/api/verify-recaptcha', async (req, res) => {
  try {
    const { token, action } = req.body;
    if (!token) return res.status(400).json({ success: false, message: 'Token required' });
    
    const response = await fetch(
      `https://recaptchaenterprise.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/assessments?key=${process.env.RECAPTCHA_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: { token, expectedAction: action || 'auth', siteKey: process.env.RECAPTCHA_SITE_KEY }
        })
      }
    );
    const assessment = await response.json();
    const score = assessment.riskAnalysis?.score || 0;
    if (score >= 0.3) {
      res.json({ success: true, score });
    } else {
      res.status(400).json({ success: false, score, message: 'Bot detected' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error' });
  }
});

// ============================================
// 🔐🔐🔐 ADMIN PANEL ENDPOINTS 🔐🔐🔐
// ============================================

// Admin auth check
app.post('/api/admin/verify', verifyAdmin, (req, res) => {
  res.json({ success: true, message: 'Admin authenticated' });
});

// Admin dashboard stats
app.get('/api/admin/stats', verifyAdmin, async (req, res) => {
  try {
    const usersSnap = await db.collection('users').count().get();
    const claimsSnap = await db.collection('claims').count().get();
    const txSnap = await db.collection('transactions').count().get();
    const globalSnap = await db.collection('global').doc('stats').get();
    const globalData = globalSnap.exists ? globalSnap.data() : {};

    res.json({
      success: true,
      stats: {
        totalUsers: usersSnap.data().count,
        totalClaims: claimsSnap.data().count + (globalData.totalClaims || 0),
        totalTransactions: txSnap.data().count,
        totalPaid: globalData.totalPaid || 0,
        totalWithdrawals: globalData.totalWithdrawals || 0,
        totalWithdrawnAmount: globalData.totalWithdrawnAmount || 0,
        referralRewards: globalData.referralRewards || 0
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Add fake withdrawal (landing page'de görünür)
app.post('/api/admin/add-withdrawal', verifyAdmin, async (req, res) => {
  try {
    const { username, coin, amount, usdValue } = req.body;
    
    if (!username || !coin || !VALID_COINS.includes(coin.toUpperCase())) {
      return res.status(400).json({ success: false, message: 'Invalid data' });
    }

    const finalAmount = parseFloat(amount) || (Math.random() * 100 + 10).toFixed(4);
    const finalUSD = parseFloat(usdValue) || (finalAmount * COIN_PRICES[coin.toUpperCase()]).toFixed(4);

    await db.collection('transactions').add({
      userId: 'fake-' + Date.now(),
      type: 'withdraw',
      coin: coin.toUpperCase(),
      amount: parseFloat(finalAmount),
      usdValue: parseFloat(finalUSD),
      destination: 'faucetpay@user.com',
      username: username,
      isFake: true,
      status: 'completed',
      createdAt: FieldValue.serverTimestamp()
    });

    // Update global stats
    await db.collection('global').doc('stats').set({
      totalWithdrawals: FieldValue.increment(1),
      totalWithdrawnAmount: FieldValue.increment(parseFloat(finalUSD)),
      lastUpdated: FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({
      success: true,
      message: `Fake withdrawal added: ${finalAmount} ${coin.toUpperCase()} for ${username}`
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Add bulk fake withdrawals (toplu ekleme)
app.post('/api/admin/add-bulk-withdrawals', verifyAdmin, async (req, res) => {
  try {
    const { count = 10 } = req.body;
    const fakeNames = [
      'CryptoKing', 'SatoshiFan', 'MoonBoy', 'DiamondH', 'Whale99',
      'LuckyDraw', 'HodlMaster', 'YieldFarm', 'BlockRunner', 'CoinHunter',
      'BTCLover', 'DogeMaster', 'ShibaArmy', 'PolygonPro', 'DigiByteHero',
      'FeyTrader', 'CryptoNinja', 'BlockWolf', 'ChainSurfer', 'AltKing'
    ];

    const batch = db.batch();
    let added = 0;
    let totalUSD = 0;

    for (let i = 0; i < Math.min(count, 50); i++) {
      const coin = VALID_COINS[Math.floor(Math.random() * VALID_COINS.length)];
      const amount = +(Math.random() * 200 + 10).toFixed(4);
      const usd = +(amount * COIN_PRICES[coin]).toFixed(4);
      const username = fakeNames[Math.floor(Math.random() * fakeNames.length)] + Math.floor(Math.random() * 9999);

      const ref = db.collection('transactions').doc();
      batch.set(ref, {
        userId: 'fake-' + Date.now() + '-' + i,
        type: 'withdraw',
        coin, amount, usdValue: usd,
        destination: 'faucetpay@user.com',
        username, isFake: true,
        status: 'completed',
        createdAt: FieldValue.serverTimestamp()
      });
      added++;
      totalUSD += usd;
    }

    await batch.commit();

    await db.collection('global').doc('stats').set({
      totalWithdrawals: FieldValue.increment(added),
      totalWithdrawnAmount: FieldValue.increment(totalUSD),
      lastUpdated: FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({
      success: true,
      message: `Added ${added} fake withdrawals, total $${totalUSD.toFixed(2)}`
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Boost global stats (sayıları artır)
app.post('/api/admin/boost-stats', verifyAdmin, async (req, res) => {
  try {
    const {
      addClaims = 0,
      addPaid = 0,
      addWithdrawals = 0,
      addWithdrawnAmount = 0,
      addReferralRewards = 0
    } = req.body;

    const updates = { lastUpdated: FieldValue.serverTimestamp() };
    
    if (addClaims > 0) updates.totalClaims = FieldValue.increment(addClaims);
    if (addPaid > 0) updates.totalPaid = FieldValue.increment(addPaid);
    if (addWithdrawals > 0) updates.totalWithdrawals = FieldValue.increment(addWithdrawals);
    if (addWithdrawnAmount > 0) updates.totalWithdrawnAmount = FieldValue.increment(addWithdrawnAmount);
    if (addReferralRewards > 0) updates.referralRewards = FieldValue.increment(addReferralRewards);

    await db.collection('global').doc('stats').set(updates, { merge: true });

    res.json({
      success: true,
      message: `Stats boosted: +${addClaims} claims, +$${addPaid} paid, +${addWithdrawals} withdrawals`
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get all users (admin only)
app.get('/api/admin/users', verifyAdmin, async (req, res) => {
  try {
    const snap = await db.collection('users').orderBy('createdAt', 'desc').limit(100).get();
    const users = [];
    snap.forEach(d => {
      const data = d.data();
      users.push({
        id: d.id,
        username: data.username,
        email: data.email,
        totalClaims: data.totalClaims || 0,
        totalWithdrawn: data.totalWithdrawn || 0,
        referralCount: data.referralCount || 0,
        createdAt: data.createdAt?.toDate?.()?.toISOString() || null
      });
    });
    res.json({ success: true, users, count: users.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete a transaction (admin)
app.delete('/api/admin/transaction/:id', verifyAdmin, async (req, res) => {
  try {
    await db.collection('transactions').doc(req.params.id).delete();
    res.json({ success: true, message: 'Transaction deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get recent transactions (admin - all users)
app.get('/api/admin/transactions', verifyAdmin, async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const snap = await db.collection('transactions')
      .orderBy('createdAt', 'desc')
      .limit(Math.min(parseInt(limit) || 50, 200))
      .get();
    const txs = [];
    snap.forEach(d => txs.push({ id: d.id, ...d.data() }));
    res.json({ success: true, transactions: txs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// 🌐 LIVE WITHDRAWS (Public, Landing Page için)
// ============================================
app.get('/api/live-withdraws', async (req, res) => {
  try {
    const snap = await db.collection('transactions')
      .where('type', '==', 'withdraw')
      .where('status', '==', 'completed')
      .orderBy('createdAt', 'desc')
      .limit(30)
      .get();
    
    const withdrawals = [];
    snap.forEach(d => {
      const data = d.data();
      withdrawals.push({
        id: d.id,
        username: data.username || ('User' + (data.userId || '').slice(0, 6)),
        coin: data.coin,
        amount: data.amount,
        usdValue: data.usdValue,
        createdAt: data.createdAt?.toDate?.()?.toISOString() || new Date().toISOString(),
        status: 'completed'
      });
    });

    res.json({ success: true, withdrawals });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// 🎯 404 + ERROR HANDLER
// ============================================
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ success: false, message: 'Internal error' });
});

// ============================================
// 🚀 START
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 CoinixFaucet Backend running on port ${PORT}`);
  console.log(`🔐 Firebase: ${process.env.FIREBASE_PROJECT_ID}`);
  console.log(`🛡️ Admin Panel: ${process.env.ADMIN_SECRET_KEY ? 'ENABLED' : 'DISABLED'}`);
  console.log(`💖 Keep-alive: Active (self-ping every 14min)`);
  startSelfPing();
});

export default app;

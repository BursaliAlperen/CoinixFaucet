import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

dotenv.config();

// ============================================================
// 🔒 FIREBASE ADMIN INIT
// ============================================================
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

// ============================================================
// 🔒 SERVER-SIDE CONSTANTS (CLIENT DEĞİŞTİREMEZ)
// ============================================================
const COIN_PRICES = {
  BTC: 65000,
  DOGE: 0.15,
  DGB: 0.01,
  FEY: 0.05,
  POL: 0.5
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

// ============================================================
// 🚀 EXPRESS APP
// ============================================================
const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['https://coinixfaucet.mine.bz', 'http://localhost:5173'],
  credentials: true
}));
app.use(express.json({ limit: '10kb' }));

// Trust proxy (Render behind load balancer)
app.set('trust proxy', 1);

// ============================================================
// 🔒 RATE LIMITERS
// ============================================================
const claimLimiter = rateLimit({
  windowMs: 60000,
  max: 2,
  message: { success: false, message: 'Too many claims. Wait 60 seconds.' },
  standardHeaders: true,
  legacyHeaders: false
});

const withdrawLimiter = rateLimit({
  windowMs: 3600000,
  max: 10,
  message: { success: false, message: 'Too many withdrawal requests.' },
  standardHeaders: true,
  legacyHeaders: false
});

const authLimiter = rateLimit({
  windowMs: 900000,
  max: 5,
  message: { success: false, message: 'Too many attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// ============================================================
// 🔒 AUTH MIDDLEWARE (JWT Verification)
// ============================================================
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decodedToken = await auth.verifyIdToken(token);
    
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      emailVerified: decodedToken.email_verified
    };

    next();
  } catch (error) {
    console.error('Auth error:', error.message);
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

const requireEmailVerified = (req, res, next) => {
  if (!req.user.emailVerified) {
    return res.status(403).json({ 
      success: false, 
      message: 'Please verify your email first' 
    });
  }
  next();
};

// ============================================================
// 🔒 INPUT VALIDATION HELPERS
// ============================================================
function validateCoin(coin) {
  return VALID_COINS.includes(coin?.toUpperCase());
}

function validateAmount(amount) {
  return typeof amount === 'number' && amount > 0 && amount < 1000000;
}

function sanitizeString(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>\"'&]/g, '').trim().slice(0, 100);
}

// ============================================================
// 📊 HEALTH CHECK
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// ============================================================
// 💰 COIN PRICES (READ ONLY - Client değiştiremez)
// ============================================================
app.get('/api/prices', (req, res) => {
  res.json({
    success: true,
    prices: COIN_PRICES,
    rewards: COIN_REWARDS,
    minimumWithdraw: WITHDRAW_MINIMUM_USD,
    claimCooldown: CLAIM_COOLDOWN_MS / 1000
  });
});

// ============================================================
// 👤 USER PROFILE
// ============================================================
app.get('/api/user', verifyToken, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const data = userDoc.data();
    
    // Sadece gerekli alanları gönder (security)
    res.json({
      success: true,
      user: {
        uid: data.uid,
        username: data.username,
        email: data.email,
        emailVerified: req.user.emailVerified,
        country: data.country,
        timezone: data.timezone,
        faucetpayEmail: data.faucetpayEmail,
        referralCode: data.referralCode,
        balances: data.balances,
        totalWithdrawn: data.totalWithdrawn,
        referralEarnings: data.referralEarnings,
        referralCount: data.referralCount,
        totalClaims: data.totalClaims,
        lastClaimAt: data.lastClaimAt,
        dailyStreak: data.dailyStreak,
        highestStreak: data.highestStreak,
        level: data.level,
        xp: data.xp
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ============================================================
// 🚰 CLAIM ENDPOINT (SECURE - Server-side fiyat/ödül)
// ============================================================
app.post('/api/claim', verifyToken, requireEmailVerified, claimLimiter, async (req, res) => {
  try {
    const { recaptchaToken } = req.body;
    
    // 🔒 reCAPTCHA doğrulama (opsiyonel ama önerilir)
    if (recaptchaToken && process.env.RECAPTCHA_SECRET_KEY) {
      const recaptchaRes = await fetch(
        `https://recaptchaenterprise.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/assessments?key=${process.env.RECAPTCHA_SECRET_KEY}`,
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
      if ((assessment.riskAnalysis?.score || 0) < 0.5) {
        return res.status(403).json({ success: false, message: 'Bot detected' });
      }
    }

    const userRef = db.collection('users').doc(req.user.uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const userData = userDoc.data();
    const now = Date.now();

    // 🔒 Cooldown kontrolü (server-side)
    if (now - (userData.lastClaimAt || 0) < CLAIM_COOLDOWN_MS) {
      const remaining = Math.ceil((CLAIM_COOLDOWN_MS - (now - userData.lastClaimAt)) / 1000);
      return res.status(429).json({ 
        success: false, 
        message: `Please wait ${remaining} seconds` 
      });
    }

    // 🔒 Rastgele coin seçimi (server-side, client değiştiremez)
    const coin = VALID_COINS[Math.floor(Math.random() * VALID_COINS.length)];
    const rewardRange = COIN_REWARDS[coin];
    
    // 🔒 Ödül hesaplama (server-side, client değiştiremez)
    const amount = +(rewardRange.min + Math.random() * (rewardRange.max - rewardRange.min)).toFixed(8);
    const usdValue = +(amount * COIN_PRICES[coin]).toFixed(6);

    // 🔒 Transaction ile balance güncelleme (race condition önleme)
    await db.runTransaction(async (transaction) => {
      const freshDoc = await transaction.get(userRef);
      if (!freshDoc.exists) throw new Error('User not found');
      
      const freshData = freshDoc.data();
      
      // Double cooldown check
      if (now - (freshData.lastClaimAt || 0) < CLAIM_COOLDOWN_MS) {
        throw new Error('Cooldown not passed');
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

    // Claim kaydet
    await db.collection('claims').add({
      userId: req.user.uid,
      coin,
      amount,
      usdValue,
      createdAt: FieldValue.serverTimestamp()
    });

    // Transaction kaydet
    await db.collection('transactions').add({
      userId: req.user.uid,
      type: 'claim',
      coin,
      amount,
      usdValue,
      status: 'completed',
      createdAt: FieldValue.serverTimestamp()
    });

    // Referral ödülü (eğer varsa)
    if (userData.referredBy) {
      const referrerSnap = await db.collection('users')
        .where('referralCode', '==', userData.referredBy)
        .limit(1)
        .get();
      
      if (!referrerSnap.empty) {
        const referrerDoc = referrerSnap.docs[0];
        const referrerRef = db.collection('users').doc(referrerDoc.id);
        const referralReward = usdValue * REFERRAL_RATE;
        
        await referrerRef.update({
          referralEarnings: FieldValue.increment(referralReward),
          balances: {
            ...referrerDoc.data().balances,
            [coin]: (referrerDoc.data().balances[coin] || 0) + (amount * REFERRAL_RATE)
          }
        });
      }
    }

    res.json({
      success: true,
      coin,
      amount,
      usdValue,
      newBalance: userData.balances[coin] + amount
    });

  } catch (error) {
    console.error('Claim error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Claim failed' 
    });
  }
});

// ============================================================
// 💸 WITHDRAW ENDPOINT (SECURE - Server-side kontrol)
// ============================================================
app.post('/api/withdraw', verifyToken, requireEmailVerified, withdrawLimiter, async (req, res) => {
  try {
    const { coin } = req.body;
    
    // 🔒 Coin validation
    if (!validateCoin(coin)) {
      return res.status(400).json({ success: false, message: 'Invalid coin' });
    }
    
    const coinUpper = coin.toUpperCase();

    const userRef = db.collection('users').doc(req.user.uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const userData = userDoc.data();

    // 🔒 FaucetPay email kontrolü
    if (!userData.faucetpayEmail || userData.faucetpayEmail.trim() === '') {
      return res.status(400).json({ 
        success: false, 
        message: 'Please set your FaucetPay email in settings first' 
      });
    }

    const balance = userData.balances[coinUpper] || 0;
    const balanceUSD = balance * COIN_PRICES[coinUpper];

    // 🔒 Minimum withdrawal kontrolü (server-side)
    if (balanceUSD < WITHDRAW_MINIMUM_USD) {
      return res.status(400).json({ 
        success: false, 
        message: `Minimum withdrawal is $${WITHDRAW_MINIMUM_USD}. Your balance: $${balanceUSD.toFixed(4)}` 
      });
    }

    //  Transaction ile balance sıfırla
    await db.runTransaction(async (transaction) => {
      const freshDoc = await transaction.get(userRef);
      if (!freshDoc.exists) throw new Error('User not found');
      
      const freshData = freshDoc.data();
      const freshBalance = freshData.balances[coinUpper] || 0;
      const freshBalanceUSD = freshBalance * COIN_PRICES[coinUpper];
      
      if (freshBalanceUSD < WITHDRAW_MINIMUM_USD) {
        throw new Error('Insufficient balance');
      }

      const newBalances = { ...freshData.balances };
      newBalances[coinUpper] = 0;

      transaction.update(userRef, {
        balances: newBalances,
        totalWithdrawn: FieldValue.increment(freshBalanceUSD)
      });
    });

    // Withdrawal transaction kaydet
    const txRef = await db.collection('transactions').add({
      userId: req.user.uid,
      type: 'withdraw',
      coin: coinUpper,
      amount: balance,
      usdValue: balanceUSD,
      destination: userData.faucetpayEmail,
      status: 'pending',
      createdAt: FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      message: 'Withdrawal submitted successfully',
      transactionId: txRef.id,
      amount: balance,
      coin: coinUpper,
      destination: userData.faucetpayEmail,
      status: 'pending'
    });

  } catch (error) {
    console.error('Withdraw error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Withdrawal failed' 
    });
  }
});

// ============================================================
//  DASHBOARD STATS
// ============================================================
app.get('/api/dashboard', verifyToken, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const userData = userDoc.data();
    const totalUSD = VALID_COINS.reduce((sum, coin) => {
      return sum + ((userData.balances[coin] || 0) * COIN_PRICES[coin]);
    }, 0);

    // Today's claims
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const todayClaimsSnap = await db.collection('claims')
      .where('userId', '==', req.user.uid)
      .where('createdAt', '>=', todayStart)
      .get();
    
    let todayUSD = 0;
    todayClaimsSnap.forEach(doc => {
      todayUSD += doc.data().usdValue || 0;
    });

    res.json({
      success: true,
      stats: {
        totalBalanceUSD: totalUSD,
        todayEarnings: todayUSD,
        referralEarnings: userData.referralEarnings || 0,
        totalWithdrawn: userData.totalWithdrawn || 0,
        totalClaims: userData.totalClaims || 0,
        dailyStreak: userData.dailyStreak || 0,
        level: userData.level || 1
      }
    });

  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ success: false, message: 'Internal error' });
  }
});

// ============================================================
// 📈 GLOBAL STATS (Landing page için)
// ============================================================
app.get('/api/stats', async (req, res) => {
  try {
    const usersSnap = await db.collection('users').count().get();
    const claimsSnap = await db.collection('claims').count().get();
    const txSnap = await db.collection('transactions')
      .where('type', '==', 'withdraw')
      .count()
      .get();

    res.json({
      success: true,
      stats: {
        totalUsers: usersSnap.data().count,
        totalClaims: claimsSnap.data().count,
        totalWithdrawals: txSnap.data().count
      }
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ success: false, message: 'Internal error' });
  }
});

// ============================================================
// 🏆 LEADERBOARD
// ============================================================
app.get('/api/leaderboard', async (req, res) => {
  try {
    const usersSnap = await db.collection('users')
      .orderBy('totalClaims', 'desc')
      .limit(100)
      .get();

    const leaderboard = [];
    usersSnap.forEach((doc, index) => {
      const data = doc.data();
      leaderboard.push({
        rank: index + 1,
        username: data.username,
        country: data.country,
        totalClaims: data.totalClaims || 0,
        totalWithdrawn: data.totalWithdrawn || 0,
        level: data.level || 1
      });
    });

    res.json({ success: true, leaderboard });
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ success: false, message: 'Internal error' });
  }
});

// ============================================================
//  SETTINGS UPDATE
// ============================================================
app.put('/api/settings', verifyToken, async (req, res) => {
  try {
    const { username, country, timezone, faucetpayEmail, twoFA, notifications } = req.body;
    
    const updates = {};
    
    if (username && typeof username === 'string' && username.length >= 3) {
      updates.username = sanitizeString(username);
    }
    if (country) updates.country = sanitizeString(country);
    if (timezone) updates.timezone = sanitizeString(timezone);
    if (faucetpayEmail && typeof faucetpayEmail === 'string') {
      updates.faucetpayEmail = faucetpayEmail.trim().toLowerCase();
    }
    if (typeof twoFA === 'boolean') updates.twoFA = twoFA;
    if (typeof notifications === 'boolean') updates.notifications = notifications;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: 'No valid fields to update' });
    }

    await db.collection('users').doc(req.user.uid).update(updates);

    res.json({ success: true, message: 'Settings updated', updates });
  } catch (error) {
    console.error('Settings error:', error);
    res.status(500).json({ success: false, message: 'Internal error' });
  }
});

// ============================================================
// 📋 TRANSACTIONS
// ============================================================
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
    const transactions = [];
    
    snap.forEach(doc => {
      transactions.push({
        id: doc.id,
        ...doc.data()
      });
    });

    res.json({ success: true, transactions });
  } catch (error) {
    console.error('Transactions error:', error);
    res.status(500).json({ success: false, message: 'Internal error' });
  }
});

// ============================================================
// 🎁 DAILY BONUS
// ============================================================
app.post('/api/daily-bonus', verifyToken, requireEmailVerified, async (req, res) => {
  try {
    const userRef = db.collection('users').doc(req.user.uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const userData = userDoc.data();
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const lastBonus = userData.lastDailyBonus 
      ? new Date(userData.lastDailyBonus).toISOString().slice(0, 10) 
      : null;

    // Already claimed today
    if (lastBonus === today) {
      return res.status(400).json({ success: false, message: 'Already claimed today' });
    }

    // Calculate streak
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const newStreak = lastBonus === yesterday 
      ? (userData.dailyStreak || 0) + 1 
      : 1;

    // Reward calculation (server-side)
    const baseReward = 0.001;
    const streakBonus = Math.min(newStreak * 0.0005, 0.05);
    const totalReward = +(baseReward + streakBonus).toFixed(4);

    // Distribute across coins
    const rewardPerCoin = totalReward / VALID_COINS.length;
    const newBalances = { ...userData.balances };
    VALID_COINS.forEach(coin => {
      newBalances[coin] = (newBalances[coin] || 0) + rewardPerCoin;
    });

    await userRef.update({
      balances: newBalances,
      lastDailyBonus: now,
      dailyStreak: newStreak,
      highestStreak: Math.max(userData.highestStreak || 0, newStreak),
      claimedDays: FieldValue.arrayUnion(newStreak)
    });

    await db.collection('transactions').add({
      userId: req.user.uid,
      type: 'daily-bonus',
      coin: 'BONUS',
      amount: totalReward,
      usdValue: totalReward,
      day: newStreak,
      status: 'completed',
      createdAt: FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      day: newStreak,
      reward: totalReward,
      newStreak,
      highestStreak: Math.max(userData.highestStreak || 0, newStreak)
    });

  } catch (error) {
    console.error('Daily bonus error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
//  404 HANDLER
// ============================================================
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint not found' });
});

// ============================================================
// 🔥 ERROR HANDLER
// ============================================================
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    success: false, 
    message: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : err.message 
  });
});

// ============================================================
//  START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(` CoinixFaucet Backend running on port ${PORT}`);
  console.log(` Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔐 Firebase Project: ${process.env.FIREBASE_PROJECT_ID}`);
  console.log(`✅ Security: Helmet + Rate Limit + JWT + Server-side prices`);
});

export default app;

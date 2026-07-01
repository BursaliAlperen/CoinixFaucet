import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import crypto from 'crypto';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🚀 Starting CoinixFaucet Backend...');

// Firebase Admin Init
if (!admin.apps.length) {
  try {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!serviceAccountJson) {
      console.error('❌ FIREBASE_SERVICE_ACCOUNT not set!');
      process.exit(1);
    }
    const serviceAccount = JSON.parse(serviceAccountJson);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase Admin initialized');
  } catch (error) {
    console.error('❌ Firebase Admin init failed:', error.message);
    process.exit(1);
  }
}

const db = getFirestore();
const auth = admin.auth();

// Constants
const COIN_PRICES = {
  CNX: 0.01,
  PEPE: 0.000008,
  DOGE: 0.15,
  DGB: 0.01,
  FEY: 0.05,
  POL: 0.5
};

const COIN_REWARDS = {
  CNX: { min: 1, max: 10 },
  PEPE: { min: 10000, max: 100000 },
  DOGE: { min: 100, max: 500 },
  DGB: { min: 50, max: 200 },
  FEY: { min: 10, max: 100 },
  POL: { min: 0.01, max: 0.1 }
};

const VALID_COINS = ['PEPE', 'DOGE', 'DGB', 'FEY', 'POL'];
const ALL_COINS = ['CNX', 'PEPE', 'DOGE', 'DGB', 'FEY', 'POL'];
const WITHDRAW_MINIMUM_USD = 0.03;
const CLAIM_COOLDOWN_MS = 60000;
const REFERRAL_RATE = 0.20;
const CNX_RATE = 0.01;

// Express App
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

// Static Files
const possiblePaths = [
  __dirname,
  join(__dirname, '..'),
  join(__dirname, 'frontend'),
  join(__dirname, '../frontend'),
  process.cwd(),
  join(process.cwd(), 'frontend')
];

let frontendPath = null;
for (const p of possiblePaths) {
  if (fs.existsSync(join(p, 'index.html'))) {
    frontendPath = p;
    break;
  }
}

if (!frontendPath) {
  console.error('❌ index.html not found');
  process.exit(1);
}

console.log('📁 Serving frontend from:', frontendPath);
app.use(express.static(frontendPath));

// Sitemap
app.get('/sitemap.xml', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const siteUrl = process.env.SITE_URL || 'https://coinixfaucet.mine.bz';
  
  res.header('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${siteUrl}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${siteUrl}/#/about</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>${siteUrl}/#/faq</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>${siteUrl}/#/terms</loc>
    <lastmod>${today}</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>${siteUrl}/#/privacy</loc>
    <lastmod>${today}</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
</urlset>`);
});

// Robots.txt
app.get('/robots.txt', (req, res) => {
  const siteUrl = process.env.SITE_URL || 'https://coinixfaucet.mine.bz';
  res.header('Content-Type', 'text/plain');
  res.send(`User-agent: *
Allow: /
Disallow: /admin
Disallow: /api/

Sitemap: ${siteUrl}/sitemap.xml`);
});

// Admin route
app.get('/admin', (req, res) => {
  const adminPath = join(frontendPath, 'admin.html');
  if (fs.existsSync(adminPath)) {
    res.sendFile(adminPath);
  } else {
    res.status(404).send('Admin page not found');
  }
});

// Rate Limiters
const claimLimiter = rateLimit({
  windowMs: 60000,
  max: 2,
  message: { success: false, message: 'Too many claims' }
});

const withdrawLimiter = rateLimit({
  windowMs: 3600000,
  max: 10,
  message: { success: false, message: 'Too many withdrawals' }
});

// Auth Middleware
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
    res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

const requireEmailVerified = (req, res, next) => {
  if (!req.user.emailVerified) {
    return res.status(403).json({ success: false, message: 'Email verification required' });
  }
  next();
};

const verifyAdmin = (req, res, next) => {
  const key = req.headers['x-admin-key'];
  if (!process.env.ADMIN_SECRET_KEY) {
    return res.status(500).json({ success: false, message: 'Admin not configured' });
  }
  if (key !== process.env.ADMIN_SECRET_KEY) {
    return res.status(401).json({ success: false, message: 'Invalid admin key' });
  }
  next();
};

// Health Check
app.get('/api/keep-alive', (req, res) => {
  res.json({ success: true, status: 'alive', timestamp: new Date().toISOString() });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '2.0.0' });
});

// Prices
app.get('/api/prices', (req, res) => {
  res.json({
    success: true,
    prices: COIN_PRICES,
    rewards: COIN_REWARDS,
    minimumWithdraw: WITHDRAW_MINIMUM_USD,
    claimCooldown: CLAIM_COOLDOWN_MS / 1000,
    coins: VALID_COINS,
    allCoins: ALL_COINS,
    cnxRate: CNX_RATE
  });
});

// User Profile
app.get('/api/user', verifyToken, async (req, res) => {
  try {
    const doc = await db.collection('users').doc(req.user.uid).get();
    if (!doc.exists) return res.status(404).json({ success: false, message: 'Not found' });
    const data = doc.data();
    const cnxUSD = (data.cnx || 0) * CNX_RATE;
    const coinsUSD = VALID_COINS.reduce((sum, coin) =>
      sum + ((data.balances?.[coin] || 0) * COIN_PRICES[coin]), 0
    );
    const totalUSD = cnxUSD + coinsUSD;

    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
    const isAdmin = adminEmails.includes(req.user.email.toLowerCase());

    res.json({
      success: true,
      user: {
        uid: data.uid,
        username: data.username,
        email: data.email,
        emailVerified: req.user.emailVerified,
        isAdmin: isAdmin || data.isAdmin || false,
        country: data.country,
        timezone: data.timezone,
        faucetpayEmail: data.faucetpayEmail,
        referralCode: data.referralCode,
        referredBy: data.referredBy,
        balances: data.balances || {},
        cnx: data.cnx || 0,
        cnxUSD,
        coinsUSD,
        totalUSD,
        totalWithdrawn: data.totalWithdrawn || 0,
        referralEarnings: data.referralEarnings || 0,
        referralCount: data.referralCount || 0,
        totalClaims: data.totalClaims || 0,
        lastClaimAt: data.lastClaimAt || 0,
        dailyStreak: data.dailyStreak || 0,
        highestStreak: data.highestStreak || 0,
        level: data.level || 1,
        xp: data.xp || 0,
        usedPromoCodes: data.usedPromoCodes || []
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ success: false, message: 'Internal error' });
  }
});

// Claim
app.post('/api/claim', verifyToken, requireEmailVerified, claimLimiter, async (req, res) => {
  try {
    const { recaptchaToken } = req.body;

    if (recaptchaToken && process.env.RECAPTCHA_SECRET_KEY) {
      try {
        const recaptchaRes = await fetch(
          `https://www.google.com/recaptcha/api/siteverify`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `secret=${process.env.RECAPTCHA_SECRET_KEY}&response=${recaptchaToken}`
          }
        );
        const recaptchaData = await recaptchaRes.json();
        if (!recaptchaData.success || recaptchaData.score < 0.5) {
          return res.status(403).json({ success: false, message: 'Bot detected' });
        }
      } catch (e) {
        console.log('reCAPTCHA error (continuing):', e.message);
      }
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

    const rewardRange = COIN_REWARDS.CNX;
    const cnxAmount = Math.floor(rewardRange.min + Math.random() * (rewardRange.max - rewardRange.min + 1));
    const usdValue = +(cnxAmount * CNX_RATE).toFixed(4);

    await db.runTransaction(async (transaction) => {
      const freshDoc = await transaction.get(userRef);
      if (!freshDoc.exists) throw new Error('User not found');
      const freshData = freshDoc.data();
      if (now - (freshData.lastClaimAt || 0) < CLAIM_COOLDOWN_MS) throw new Error('Cooldown');

      transaction.update(userRef, {
        cnx: FieldValue.increment(cnxAmount),
        lastClaimAt: now,
        totalClaims: FieldValue.increment(1),
        xp: FieldValue.increment(5)
      });
    });

    await db.collection('claims').add({
      userId: req.user.uid,
      coin: 'CNX',
      amount: cnxAmount,
      usdValue,
      createdAt: FieldValue.serverTimestamp()
    });

    await db.collection('transactions').add({
      userId: req.user.uid,
      type: 'claim',
      coin: 'CNX',
      amount: cnxAmount,
      usdValue,
      status: 'completed',
      createdAt: FieldValue.serverTimestamp()
    });

    if (userData.referredBy) {
      const refSnap = await db.collection('users').where('referralCode', '==', userData.referredBy).limit(1).get();
      if (!refSnap.empty) {
        const refDoc = refSnap.docs[0];
        const refBonus = Math.floor(cnxAmount * REFERRAL_RATE);
        await db.collection('users').doc(refDoc.id).update({
          cnx: FieldValue.increment(refBonus),
          referralEarnings: FieldValue.increment(refBonus * CNX_RATE)
        });
      }
    }

    await db.collection('global').doc('stats').set({
      totalClaims: FieldValue.increment(1),
      totalPaid: FieldValue.increment(usdValue),
      lastUpdated: FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ success: true, coin: 'CNX', amount: cnxAmount, usdValue });
  } catch (error) {
    console.error('Claim error:', error);
    res.status(500).json({ success: false, message: error.message || 'Claim failed' });
  }
});

// Withdraw
app.post('/api/withdraw', verifyToken, requireEmailVerified, withdrawLimiter, async (req, res) => {
  try {
    const { coin } = req.body;
    if (!VALID_COINS.includes(coin?.toUpperCase())) {
      return res.status(400).json({ success: false, message: 'Invalid coin' });
    }
    const coinUpper = coin.toUpperCase();

    const userRef = db.collection('users').doc(req.user.uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: 'User not found' });

    const userData = userDoc.data();
    if (!userData.faucetpayEmail) {
      return res.status(400).json({ success: false, message: 'Set FaucetPay email first' });
    }

    const balance = userData.balances?.[coinUpper] || 0;
    const balanceUSD = balance * COIN_PRICES[coinUpper];

    if (balanceUSD < WITHDRAW_MINIMUM_USD) {
      return res.status(400).json({
        success: false,
        message: `Min $${WITHDRAW_MINIMUM_USD}. Balance: $${balanceUSD.toFixed(4)}`
      });
    }

    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(userRef);
      const data = fresh.data();
      const b = data.balances?.[coinUpper] || 0;
      if (b * COIN_PRICES[coinUpper] < WITHDRAW_MINIMUM_USD) throw new Error('Insufficient');
      const newBal = { ...data.balances };
      newBal[coinUpper] = 0;
      tx.update(userRef, {
        balances: newBal,
        totalWithdrawn: FieldValue.increment(b * COIN_PRICES[coinUpper])
      });
    });

    const txRef = await db.collection('transactions').add({
      userId: req.user.uid,
      type: 'withdraw',
      coin: coinUpper,
      amount: balance,
      usdValue: balanceUSD,
      destination: userData.faucetpayEmail,
      username: userData.username,
      status: 'pending',
      createdAt: FieldValue.serverTimestamp()
    });

    await db.collection('global').doc('stats').set({
      totalWithdrawals: FieldValue.increment(1),
      totalWithdrawnAmount: FieldValue.increment(balanceUSD),
      lastUpdated: FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({
      success: true,
      transactionId: txRef.id,
      amount: balance,
      coin: coinUpper,
      destination: userData.faucetpayEmail,
      status: 'pending'
    });
  } catch (error) {
    console.error('Withdraw error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Dashboard
app.get('/api/dashboard', verifyToken, async (req, res) => {
  try {
    const doc = await db.collection('users').doc(req.user.uid).get();
    if (!doc.exists) return res.status(404).json({ success: false, message: 'Not found' });
    const data = doc.data();
    const cnxUSD = (data.cnx || 0) * CNX_RATE;
    const coinsUSD = VALID_COINS.reduce((sum, coin) =>
      sum + ((data.balances?.[coin] || 0) * COIN_PRICES[coin]), 0
    );
    const totalUSD = cnxUSD + coinsUSD;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const claimsSnap = await db.collection('claims')
      .where('userId', '==', req.user.uid)
      .where('createdAt', '>=', todayStart).get();

    let todayUSD = 0;
    claimsSnap.forEach(d => todayUSD += d.data().usdValue || 0);

    res.json({
      success: true,
      stats: {
        totalBalanceUSD: totalUSD,
        cnxBalance: data.cnx || 0,
        cnxUSD,
        coinsUSD,
        todayEarnings: todayUSD,
        referralEarnings: data.referralEarnings || 0,
        totalWithdrawn: data.totalWithdrawn || 0,
        totalClaims: data.totalClaims || 0,
        dailyStreak: data.dailyStreak || 0,
        level: data.level || 1
      }
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ success: false, message: 'Error' });
  }
});

// Stats
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

// Leaderboard
app.get('/api/leaderboard', async (req, res) => {
  try {
    const snap = await db.collection('users').orderBy('totalClaims', 'desc').limit(100).get();
    const leaderboard = [];
    snap.forEach((doc, i) => {
      const d = doc.data();
      leaderboard.push({
        rank: i + 1,
        username: d.username,
        country: d.country,
        totalClaims: d.totalClaims || 0,
        totalWithdrawn: d.totalWithdrawn || 0,
        level: d.level || 1
      });
    });
    res.json({ success: true, leaderboard });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error' });
  }
});

// Settings
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

// Transactions
app.get('/api/transactions', verifyToken, async (req, res) => {
  try {
    const { type, limit = 50 } = req.query;
    let query = db.collection('transactions')
      .where('userId', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .limit(Math.min(parseInt(limit) || 50, 100));
    if (type && ['claim', 'withdraw', 'daily-bonus', 'referral', 'swap', 'offerwall', 'promo', 'ptc'].includes(type)) {
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

// Daily Bonus
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

    const baseBonus = 10;
    const streakBonus = Math.min(newStreak * 2, 40);
    const cnxBonus = baseBonus + streakBonus;
    const usdValue = +(cnxBonus * CNX_RATE).toFixed(4);

    await userRef.update({
      cnx: FieldValue.increment(cnxBonus),
      lastDailyBonus: Date.now(),
      dailyStreak: newStreak,
      highestStreak: Math.max(data.highestStreak || 0, newStreak),
      claimedDays: FieldValue.arrayUnion(newStreak)
    });

    await db.collection('transactions').add({
      userId: req.user.uid,
      type: 'daily-bonus',
      coin: 'CNX',
      amount: cnxBonus,
      usdValue,
      day: newStreak,
      status: 'completed',
      createdAt: FieldValue.serverTimestamp()
    });

    res.json({ success: true, day: newStreak, amount: cnxBonus, usdValue, newStreak });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Forgot Password
app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email required' });

    await auth.generatePasswordResetLink(email, {
      url: `${process.env.SITE_URL || 'https://coinixfaucet.mine.bz'}/`
    });

    res.json({ success: true, message: 'Password reset email sent' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ success: false, message: 'Failed to send reset email' });
  }
});

// Resend Verification
app.post('/api/resend-verification', verifyToken, async (req, res) => {
  try {
    const user = await auth.getUser(req.user.uid);
    if (user.emailVerified) {
      return res.json({ success: true, message: 'Already verified' });
    }

    await auth.generateEmailVerificationLink(user.email, {
      url: `${process.env.SITE_URL || 'https://coinixfaucet.mine.bz'}/`
    });

    res.json({ success: true, message: 'Verification email sent' });
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({ success: false, message: 'Failed to resend verification' });
  }
});

// Offerwall Postback
app.post('/api/offerwall/postback', async (req, res) => {
  try {
    const { subId, transId, reward, status, signature, payout, offer_name, userIp } = req.body;
    const secret = process.env.OFFERWALL_SECRET_KEY;

    if (!secret) {
      console.error('OFFERWALL_SECRET_KEY not set');
      return res.status(500).json({ error: 'Server not configured' });
    }

    const expectedSig = crypto.createHash('md5')
      .update(`${subId}${transId}${reward}${secret}`)
      .digest('hex');

    if (expectedSig !== signature) {
      console.error('Invalid signature');
      return res.status(403).json({ error: 'Invalid signature' });
    }

    const userSnap = await db.collection('users')
      .where('referralCode', '==', subId)
      .limit(1)
      .get();

    if (userSnap.empty) {
      console.error('User not found for subId:', subId);
      return res.status(404).json({ error: 'User not found' });
    }

    const userDoc = userSnap.docs[0];
    const userRef = db.collection('users').doc(userDoc.id);
    const rewardAmount = parseFloat(reward);

    if (status === '1') {
      await userRef.update({
        cnx: FieldValue.increment(Math.floor(rewardAmount * 100)),
        totalClaims: FieldValue.increment(1)
      });

      await db.collection('transactions').add({
        userId: userDoc.id,
        type: 'offerwall',
        amount: rewardAmount,
        offerName: offer_name,
        transactionId: transId,
        status: 'completed',
        createdAt: FieldValue.serverTimestamp()
      });

      console.log(`✅ Offerwall reward: ${rewardAmount} to ${subId}`);
    } else if (status === '2') {
      await userRef.update({
        cnx: FieldValue.increment(-Math.floor(rewardAmount * 100))
      });

      await db.collection('transactions').add({
        userId: userDoc.id,
        type: 'offerwall_chargeback',
        amount: -rewardAmount,
        offerName: offer_name,
        transactionId: transId,
        status: 'chargeback',
        createdAt: FieldValue.serverTimestamp()
      });

      console.log(`⚠️ Offerwall chargeback: ${rewardAmount} from ${subId}`);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Offerwall postback error:', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Promo Code Create (Admin)
app.post('/api/admin/promo/create', verifyAdmin, async (req, res) => {
  try {
    const { code, reward, maxUses, expiresAt } = req.body;
    
    if (!code || !reward) {
      return res.status(400).json({ success: false, message: 'Code and reward required' });
    }
    
    const promoRef = await db.collection('promo_codes').add({
      code: code.toUpperCase(),
      reward: parseFloat(reward),
      maxUses: parseInt(maxUses) || null,
      currentUses: 0,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      isActive: true,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: 'admin'
    });
    
    res.json({ 
      success: true, 
      message: 'Promo code created',
      promoId: promoRef.id 
    });
  } catch (error) {
    console.error('Create promo error:', error);
    res.status(500).json({ success: false, message: 'Error creating promo' });
  }
});

// Promo Code List (Admin)
app.get('/api/admin/promo/list', verifyAdmin, async (req, res) => {
  try {
    const snap = await db.collection('promo_codes')
      .orderBy('createdAt', 'desc')
      .get();
    
    const promos = [];
    snap.forEach(doc => {
      promos.push({ id: doc.id, ...doc.data() });
    });
    
    res.json({ success: true, promos });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error' });
  }
});

// Promo Code Delete (Admin)
app.delete('/api/admin/promo/:id', verifyAdmin, async (req, res) => {
  try {
    await db.collection('promo_codes').doc(req.params.id).delete();
    res.json({ success: true, message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error' });
  }
});

// Promo Code Redeem (User)
app.post('/api/promo/redeem', verifyToken, async (req, res) => {
  try {
    const { code } = req.body;
    const userId = req.user.uid;
    
    if (!code) {
      return res.status(400).json({ success: false, message: 'Code required' });
    }
    
    const promoSnap = await db.collection('promo_codes')
      .where('code', '==', code.toUpperCase())
      .where('isActive', '==', true)
      .limit(1)
      .get();
    
    if (promoSnap.empty) {
      return res.status(404).json({ success: false, message: 'Invalid code' });
    }
    
    const promoDoc = promoSnap.docs[0];
    const promoData = promoDoc.data();
    const promoId = promoDoc.id;
    
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();
    
    if (userData.usedPromoCodes?.includes(promoId)) {
      return res.status(400).json({ success: false, message: 'Already used' });
    }
    
    if (promoData.expiresAt && new Date(promoData.expiresAt.toDate()) < new Date()) {
      return res.status(400).json({ success: false, message: 'Code expired' });
    }
    
    if (promoData.maxUses && promoData.currentUses >= promoData.maxUses) {
      return res.status(400).json({ success: false, message: 'Code max uses reached' });
    }
    
    const rewardAmount = Math.floor(promoData.reward * 100);
    
    await db.runTransaction(async (transaction) => {
      transaction.update(db.collection('users').doc(userId), {
        cnx: FieldValue.increment(rewardAmount),
        usedPromoCodes: FieldValue.arrayUnion(promoId)
      });
      
      transaction.update(db.collection('promo_codes').doc(promoId), {
        currentUses: FieldValue.increment(1)
      });
    });
    
    await db.collection('transactions').add({
      userId,
      type: 'promo',
      coin: 'CNX',
      amount: rewardAmount,
      usdValue: +(rewardAmount * CNX_RATE).toFixed(4),
      promoCode: code.toUpperCase(),
      status: 'completed',
      createdAt: FieldValue.serverTimestamp()
    });
    
    console.log(`✅ Promo redeemed: ${code} by ${userId}`);
    
    res.json({ 
      success: true, 
      message: `Redeemed ${rewardAmount} CNX!`,
      reward: rewardAmount
    });
  } catch (error) {
    console.error('Promo redeem error:', error);
    res.status(500).json({ success: false, message: 'Error redeeming code' });
  }
});

// Live Withdraws
app.get('/api/live-withdraws', async (req, res) => {
  try {
    const snap = await db.collection('transactions')
      .where('type', '==', 'withdraw')
      .where('status', '==', 'completed')
      .orderBy('createdAt', 'desc')
      .limit(50).get();

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

// 404 Handler
app.get('*', (req, res) => {
  const indexPath = join(frontendPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Frontend not found');
  }
});

// Error Handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ success: false, message: 'Internal error' });
});

// Self Ping
function startSelfPing() {
  setInterval(async () => {
    try {
      const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
      await fetch(`${url}/api/keep-alive`);
    } catch (err) {
      console.log('⚠️ Self-ping failed:', err.message);
    }
  }, 14 * 60 * 1000);
}

// Start Server
app.listen(PORT, () => {
  console.log('========================================');
  console.log(`🚀 CoinixFaucet v2.0 running on port ${PORT}`);
  console.log(`📁 Serving frontend from ${frontendPath}`);
  console.log(`🗺️ Sitemap: https://coinixfaucet.mine.bz/sitemap.xml`);
  console.log(`🤖 Robots: https://coinixfaucet.mine.bz/robots.txt`);
  console.log(`🔐 Admin: https://coinixfaucet.mine.bz/admin`);
  console.log('========================================');
  startSelfPing();
});

export default app;

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

console.log('🚀 Starting CoinixFaucet Backend v2.1...');

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
const SWAP_FEE = 0.02; // %2

// Express App
const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['https://coinixfaucet.mine.bz', 'http://localhost:3000'],
  credentials: true
}));

app.use(express.json({ limit: '10kb' }));
app.set('trust proxy', 1);

// Static Files
const possiblePaths = [
  join(__dirname, '../frontend'),
  join(__dirname, 'frontend'),
  __dirname,
  process.cwd()
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

// ============================================
// 🗺️ SITEMAP.XML
// ============================================

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

app.get('/robots.txt', (req, res) => {
  const siteUrl = process.env.SITE_URL || 'https://coinixfaucet.mine.bz';
  res.header('Content-Type', 'text/plain');
  res.send(`User-agent: *
Allow: /
Disallow: /admin
Disallow: /api/

Sitemap: ${siteUrl}/sitemap.xml`);
});

app.get('/admin', (req, res) => {
  const adminPath = join(frontendPath, 'admin.html');
  if (fs.existsSync(adminPath)) {
    res.sendFile(adminPath);
  } else {
    res.status(404).send('Admin page not found');
  }
});

// ============================================
// 🔒 RATE LIMITERS
// ============================================

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
    req.user = { 
      uid: decoded.uid, 
      email: decoded.email, 
      emailVerified: decoded.email_verified 
    };
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

// ============================================
// 💖 HEALTH CHECK
// ============================================

app.get('/api/keep-alive', (req, res) => {
  res.json({ success: true, status: 'alive', timestamp: new Date().toISOString() });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '2.1.0' });
});

// ============================================
// 💰 PRICES
// ============================================

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

// ============================================
// 👤 USER PROFILE
// ============================================

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

// ============================================
// 🚰 CLAIM
// ============================================

app.post('/api/claim', verifyToken, requireEmailVerified, claimLimiter, async (req, res) => {
  try {
    const { recaptchaToken } = req.body;

    if (recaptchaToken && process.env.RECAPTCHA_SECRET_KEY) {
      try {
        const recaptchaRes = await fetch(
          'https://www.google.com/recaptcha/api/siteverify',
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

// ============================================
// 💸 WITHDRAW
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

// ============================================
// 💱 SWAP (COINGECKO API)
// ============================================

async function getCoinGeckoPrices() {
  try {
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=pepe,dogecoin,digibyte,polygon-ecosystem-token&vs_currencies=usd'
    );
    const data = await response.json();
    
    return {
      PEPE: data.pepe?.usd || 0.000008,
      DOGE: data.dogecoin?.usd || 0.15,
      DGB: data.digibyte?.usd || 0.01,
      POL: data['polygon-ecosystem-token']?.usd || 0.5,
      CNX: 0.01
    };
  } catch (error) {
    console.error('CoinGecko API error:', error);
    return {
      PEPE: 0.000008,
      DOGE: 0.15,
      DGB: 0.01,
      POL: 0.5,
      CNX: 0.01
    };
  }
}

app.get('/api/swap/rates', async (req, res) => {
  try {
    const prices = await getCoinGeckoPrices();
    
    res.json({
      success: true,
      rates: {
        CNX: { usd: prices.CNX, symbol: 'CNX' },
        PEPE: { usd: prices.PEPE, symbol: 'PEPE' },
        DOGE: { usd: prices.DOGE, symbol: 'DOGE' },
        DGB: { usd: prices.DGB, symbol: 'DGB' },
        POL: { usd: prices.POL, symbol: 'POL' }
      },
      minSwap: 0.03
    });
  } catch (error) {
    console.error('Swap rates error:', error);
    res.status(500).json({ success: false, message: 'Error fetching rates' });
  }
});

app.post('/api/swap', verifyToken, requireEmailVerified, async (req, res) => {
  try {
    const { fromCoin, toCoin, amount } = req.body;
    
    if (!fromCoin || !toCoin || !amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid parameters' });
    }
    
    if (fromCoin === toCoin) {
      return res.status(400).json({ success: false, message: 'Cannot swap same coin' });
    }
    
    const prices = await getCoinGeckoPrices();
    const fromPrice = prices[fromCoin];
    const toPrice = prices[toCoin];
    
    if (!fromPrice || !toPrice) {
      return res.status(400).json({ success: false, message: 'Invalid coins' });
    }
    
    const userRef = db.collection('users').doc(req.user.uid);
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    const userData = userDoc.data();
    
    let userBalance = 0;
    if (fromCoin === 'CNX') {
      userBalance = userData.cnx || 0;
    } else {
      userBalance = userData.balances?.[fromCoin] || 0;
    }
    
    if (userBalance < amount) {
      return res.status(400).json({ 
        success: false, 
        message: `Insufficient ${fromCoin} balance` 
      });
    }
    
    const fromUSD = amount * fromPrice;
    
    if (fromUSD < 0.03) {
      return res.status(400).json({ 
        success: false, 
        message: `Minimum swap is $0.03 USD` 
      });
    }
    
    const toAmount = fromUSD / toPrice;
    const fee = toAmount * SWAP_FEE;
    const finalAmount = toAmount - fee;
    
    await db.runTransaction(async (transaction) => {
      const freshDoc = await transaction.get(userRef);
      const freshData = freshDoc.data();
      
      if (fromCoin === 'CNX') {
        transaction.update(userRef, {
          cnx: FieldValue.increment(-amount)
        });
      } else {
        const newBalances = { ...freshData.balances };
        newBalances[fromCoin] = (newBalances[fromCoin] || 0) - amount;
        transaction.update(userRef, {
          balances: newBalances
        });
      }
      
      if (toCoin === 'CNX') {
        transaction.update(userRef, {
          cnx: FieldValue.increment(finalAmount)
        });
      } else {
        const newBalances = { ...freshData.balances };
        newBalances[toCoin] = (newBalances[toCoin] || 0) + finalAmount;
        transaction.update(userRef, {
          balances: newBalances
        });
      }
    });
    
    await db.collection('transactions').add({
      userId: req.user.uid,
      type: 'swap',
      fromCoin,
      toCoin,
      fromAmount: amount,
      toAmount: finalAmount,
      fee,
      usdValue: fromUSD,
      rate: fromPrice / toPrice,
      status: 'completed',
      createdAt: FieldValue.serverTimestamp()
    });
    
    console.log(`💱 Swap: ${amount} ${fromCoin} -> ${finalAmount} ${toCoin}`);
    
    res.json({
      success: true,
      fromCoin,
      toCoin,
      fromAmount: amount,
      toAmount: finalAmount,
      fee,
      rate: fromPrice / toPrice,
      usdValue: fromUSD
    });
    
  } catch (error) {
    console.error('Swap error:', error);
    res.status(500).json({ success: false, message: 'Swap failed' });
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
    const cnxUSD = (data.cnx || 0) * CNX_RATE;
    const coinsUSD = VALID_COINS.reduce((sum, coin) =>
      sum + ((data.balances?.[coin] || 0) * COIN_PRICES[coin]), 0
    );
    const totalUSD = cnxUSD + coinsUSD;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const claimsSnap = await db.collection('claims')
      .where('userId', '==', req.user.uid)
      .where('createdAt', '>=', todayStart)
      .get();

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

// ============================================
// ⚙️ SETTINGS
// ============================================

app.put('/api/settings', verifyToken, async (req, res) => {
  try {
    const { username, country, timezone, faucetpayEmail } = req.body;
    const updates = {};
    if (username?.length >= 3) updates.username = username.trim();
    if (country) updates.country = country;
    if (timezone) updates.timezone = timezone;
    if (faucetpayEmail) updates.faucetpayEmail = faucetpayEmail.trim().toLowerCase();
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

    const baseBonus = 10;
    const streakBonus = Math.min(newStreak * 2, 40);
    const cnxBonus = baseBonus + streakBonus;
    const usdValue = +(cnxBonus * CNX_RATE).toFixed(4);

    await userRef.update({
      cnx: FieldValue.increment(cnxBonus),
      lastDailyBonus: Date.now(),
      dailyStreak: newStreak,
      highestStreak: Math.max(data.highestStreak || 0, newStreak)
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

// ============================================
// 🔐 FORGOT PASSWORD
// ============================================

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

// ============================================
// 🔐 RESEND VERIFICATION
// ============================================

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

// ============================================
// 🎯 OFFERWALL POSTBACK
// ============================================

app.post('/api/offerwall/postback', async (req, res) => {
  try {
    const { subId, transId, reward, status, signature, offer_name } = req.body;
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

// ============================================
// 🎁 PROMO CODES
// ============================================

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
      return res.status(400).json({ success: false, message: 'Max uses reached' });
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

// ============================================
// 📺 PTC ADS
// ============================================

const PTC_ADS = [
  { id: 'ptc1', title: 'CryptoNews', url: 'https://example.com', reward: 5, duration: 30 },
  { id: 'ptc2', title: 'FaucetPay', url: 'https://example.com', reward: 3, duration: 20 },
  { id: 'ptc3', title: 'Bitcoin Guide', url: 'https://example.com', reward: 8, duration: 45 }
];

app.get('/api/ptc/available', verifyToken, async (req, res) => {
  try {
    res.json({ success: true, ads: PTC_ADS });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error' });
  }
});

app.post('/api/ptc/view', verifyToken, async (req, res) => {
  try {
    const { adId } = req.body;
    const ad = PTC_ADS.find(a => a.id === adId);
    
    if (!ad) {
      return res.status(404).json({ success: false, message: 'Ad not found' });
    }
    
    res.json({ success: true, url: ad.url, duration: ad.duration, reward: ad.reward });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error' });
  }
});

app.post('/api/ptc/complete', verifyToken, async (req, res) => {
  try {
    const { adId } = req.body;
    const ad = PTC_ADS.find(a => a.id === adId);
    
    if (!ad) {
      return res.status(404).json({ success: false, message: 'Ad not found' });
    }

    await db.collection('users').doc(req.user.uid).update({
      cnx: FieldValue.increment(ad.reward)
    });

    await db.collection('transactions').add({
      userId: req.user.uid,
      type: 'ptc',
      coin: 'CNX',
      amount: ad.reward,
      usdValue: +(ad.reward * CNX_RATE).toFixed(4),
      status: 'completed',
      createdAt: FieldValue.serverTimestamp()
    });

    res.json({ success: true, reward: ad.reward });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error' });
  }
});

// ============================================
// 💎 LIVE WITHDRAWS
// ============================================

app.get('/api/live-withdraws', async (req, res) => {
  try {
    const snap = await db.collection('transactions')
      .where('type', '==', 'withdraw')
      .where('status', '==', 'completed')
      .orderBy('createdAt', 'desc')
      .limit(50)
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
// 🔐 ADMIN ENDPOINTS
// ============================================

app.post('/api/admin/maintenance', verifyAdmin, async (req, res) => {
  try {
    const { enabled, duration } = req.body;
    
    await db.collection('global').doc('settings').set({
      maintenanceMode: enabled,
      maintenanceUntil: enabled && duration 
        ? new Date(Date.now() + duration * 60000) 
        : null,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    
    res.json({ 
      success: true, 
      message: enabled ? 'Maintenance mode enabled' : 'Maintenance mode disabled' 
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error' });
  }
});

app.get('/api/maintenance', async (req, res) => {
  try {
    const doc = await db.collection('global').doc('settings').get();
    const data = doc.exists ? doc.data() : {};
    
    const now = new Date();
    const isExpired = data.maintenanceUntil && new Date(data.maintenanceUntil) < now;
    
    if (isExpired) {
      await db.collection('global').doc('settings').update({
        maintenanceMode: false,
        maintenanceUntil: null
      });
      res.json({ enabled: false });
    } else {
      res.json({ 
        enabled: data.maintenanceMode || false,
        until: data.maintenanceUntil 
      });
    }
  } catch (error) {
    res.json({ enabled: false });
  }
});

app.post('/api/admin/verify', verifyAdmin, (req, res) => {
  res.json({ success: true, message: 'Admin authenticated' });
});

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
        totalWithdrawnAmount: globalData.totalWithdrawnAmount || 0
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/admin/users', verifyAdmin, async (req, res) => {
  try {
    const snap = await db.collection('users').orderBy('createdAt', 'desc').limit(100).get();
    const users = [];
    snap.forEach(doc => {
      const d = doc.data();
      const cnxUSD = (d.cnx || 0) * CNX_RATE;
      const coinsUSD = VALID_COINS.reduce((sum, coin) =>
        sum + ((d.balances?.[coin] || 0) * COIN_PRICES[coin]), 0
      );
      users.push({
        uid: d.uid,
        username: d.username,
        email: d.email,
        totalUSD: cnxUSD + coinsUSD,
        totalClaims: d.totalClaims || 0,
        createdAt: d.createdAt
      });
    });
    res.json({ success: true, users });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error' });
  }
});

app.get('/api/admin/withdrawals', verifyAdmin, async (req, res) => {
  try {
    const snap = await db.collection('transactions')
      .where('type', '==', 'withdraw')
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();
    
    const withdrawals = [];
    snap.forEach(doc => {
      const d = doc.data();
      withdrawals.push({
        id: doc.id,
        username: d.username || 'Unknown',
        coin: d.coin,
        amount: d.amount,
        usdValue: d.usdValue,
        destination: d.destination,
        status: d.status,
        createdAt: d.createdAt
      });
    });
    
    res.json({ success: true, withdrawals });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error' });
  }
});

app.get('/api/admin/transactions', verifyAdmin, async (req, res) => {
  try {
    const { limit = 100 } = req.query;
    const snap = await db.collection('transactions')
      .orderBy('createdAt', 'desc')
      .limit(parseInt(limit))
      .get();
    
    const txs = [];
    snap.forEach(doc => {
      const d = doc.data();
      txs.push({
        id: doc.id,
        userId: d.userId,
        username: d.username || 'Unknown',
        type: d.type,
        coin: d.coin,
        amount: d.amount,
        status: d.status,
        createdAt: d.createdAt
      });
    });
    
    res.json({ success: true, transactions: txs });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error' });
  }
});

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
    res.status(500).json({ success: false, message: 'Error creating promo' });
  }
});

app.get('/api/admin/promo/list', verifyAdmin, async (req, res) => {
  try {
    const snap = await db.collection('promo_codes').orderBy('createdAt', 'desc').get();
    const promos = [];
    snap.forEach(doc => {
      promos.push({ id: doc.id, ...doc.data() });
    });
    res.json({ success: true, promos });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error' });
  }
});

app.delete('/api/admin/promo/:id', verifyAdmin, async (req, res) => {
  try {
    await db.collection('promo_codes').doc(req.params.id).delete();
    res.json({ success: true, message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error' });
  }
});

// ============================================
// 🌐 SPA FALLBACK
// ============================================

app.get('*', (req, res) => {
  const indexPath = join(frontendPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Frontend not found');
  }
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ success: false, message: 'Internal error' });
});

// ============================================
// 🚀 START SERVER
// ============================================

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

app.listen(PORT, () => {
  console.log('========================================');
  console.log(`🚀 CoinixFaucet v2.1 running on port ${PORT}`);
  console.log(`📁 Frontend: ${frontendPath}`);
  console.log(`🌍 URL: ${process.env.SITE_URL || `http://localhost:${PORT}`}`);
  console.log('========================================');
  startSelfPing();
});

export default app;

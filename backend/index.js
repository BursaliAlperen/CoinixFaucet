import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { UAParser } from 'ua-parser-js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================
// 🔥 FIREBASE ADMIN INIT (Secret File)
// ============================================
if (!admin.apps.length) {
  try {
    const serviceAccountPath = process.env.RENDER
      ? '/opt/render/project/src/firebaseserviceaccount.json'
      : join(__dirname, 'firebaseserviceaccount.json');

    const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));

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

// ============================================
// 🔒 CONSTANTS (CNX = $0.01)
// ============================================
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
  DGB:  { min: 50, max: 200 },
  FEY:  { min: 10, max: 100 },
  POL:  { min: 0.01, max: 0.1 }
};

const VALID_COINS = ['PEPE', 'DOGE', 'DGB', 'FEY', 'POL'];
const WITHDRAW_MINIMUM_USD = 0.03;
const CLAIM_COOLDOWN_MS = 60000;
const REFERRAL_RATE = 0.20;
const CNX_RATE = 0.01;

// ============================================
// 🛡️ VPN/PROXY DETECTION (ipwho.is)
// ============================================
const vpnCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;

async function checkVPNProxy(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1') return { isVPN: false, reason: 'localhost' };

  const cached = vpnCache.get(ip);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.result;

  try {
    const response = await fetch(`https://ipwho.is/${ip}`, {
      headers: { 'User-Agent': 'CoinixFaucet/2.0' },
      signal: AbortSignal.timeout(5000)
    });

    const data = await response.json();
    if (!data.success) return { isVPN: false, reason: 'lookup_failed' };

    const security = data.security || {};
    const isVPN = security.vpn || security.proxy || security.tor || security.hosting || security.relay;

    const result = {
      isVPN,
      isProxy: security.proxy,
      isTor: security.tor,
      isHosting: security.hosting,
      isRelay: security.relay,
      country: data.country,
      isp: data.connection?.isp,
      reason: security.tor ? 'Tor' : security.vpn ? 'VPN' : security.proxy ? 'Proxy' : security.hosting ? 'Hosting' : security.relay ? 'Relay' : 'clean'
    };

    vpnCache.set(ip, { result, timestamp: Date.now() });
    if (vpnCache.size > 10000) {
      const oldest = [...vpnCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
      vpnCache.delete(oldest[0]);
    }

    if (isVPN) {
      console.warn(`🚫 VPN/Proxy: ${ip} | ${result.reason} | ${result.isp || 'unknown'} | ${result.country || 'unknown'}`);
      
      // Block IP in database
      try {
        await db.collection('blocked_ips').doc(ip.replace(/\./g, '_')).set({
          ip,
          reason: result.reason,
          isp: result.isp,
          country: result.country,
          blockedAt: FieldValue.serverTimestamp(),
          expiresAt: new Date(Date.now() + 3600000)
        });
      } catch (e) { console.error('Block IP error:', e.message); }
    }

    return result;
  } catch (error) {
    console.error('VPN check error:', error.message);
    return { isVPN: false, reason: 'error', error: error.message };
  }
}

// VPN Middleware
const vpnMiddleware = async (req, res, next) => {
  const exemptPaths = ['/api/health', '/api/keep-alive', '/api/admin', '/api/check-vpn', '/api/offerwall'];
  if (exemptPaths.some(p => req.path.startsWith(p))) return next();

  const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
                   req.headers['x-real-ip'] ||
                   req.headers['cf-connecting-ip'] ||
                   req.ip;

  if (!clientIP) return next();

  const vpnResult = await checkVPNProxy(clientIP);

  if (vpnResult.isVPN) {
    return res.status(403).json({
      success: false,
      blocked: true,
      reason: vpnResult.reason,
      message: 'VPN/Proxy/Tor/Hosting not allowed. Use residential connection.'
    });
  }

  req.clientIP = clientIP;
  req.vpnCheck = vpnResult;
  next();
};

// ============================================
// 🚀 EXPRESS APP
// ============================================
const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ 
  contentSecurityPolicy: false, 
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'same-origin' }
}));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['https://coinixfaucet.mine.bz'],
  credentials: true
}));
app.use(express.json({ limit: '10kb' }));
app.set('trust proxy', 1);
app.use(vpnMiddleware);

// ============================================
// 🔒 RATE LIMITERS
// ============================================
const claimLimiter = rateLimit({ 
  windowMs: 60000, 
  max: 2, 
  message: { success: false, message: 'Too many claims. Wait 60 seconds.' } 
});

const withdrawLimiter = rateLimit({ 
  windowMs: 3600000, 
  max: 10, 
  message: { success: false, message: 'Too many withdrawals.' } 
});

const authLimiter = rateLimit({
  windowMs: 900000,
  max: 5,
  message: { success: false, message: 'Too many attempts. Try again later.' }
});

// ============================================
// 🔐 AUTH MIDDLEWARE
// ============================================
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
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
    console.error('Auth error:', error.message);
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
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
    console.warn('⚠️ Unauthorized admin access from', req.clientIP || req.ip);
    return res.status(401).json({ success: false, message: 'Invalid admin key' });
  }
  next();
};

// ============================================
// 💖 HEALTH + KEEP-ALIVE
// ============================================
app.get('/api/keep-alive', (req, res) => {
  res.json({ 
    success: true, 
    status: 'alive', 
    timestamp: new Date().toISOString(), 
    uptime: process.uptime() 
  });
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(), 
    version: '2.0.0' 
  });
});

// ============================================
// 🛡️ VPN CHECK
// ============================================
app.get('/api/check-vpn', async (req, res) => {
  try {
    const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                     req.headers['x-real-ip'] || 
                     req.ip;
    
    if (!clientIP || clientIP === '127.0.0.1') {
      return res.json({ success: true, isVPN: false, reason: 'localhost' });
    }

    const result = await checkVPNProxy(clientIP);
    res.json({ 
      success: true, 
      isVPN: result.isVPN, 
      reason: result.reason, 
      country: result.country, 
      isp: result.isp 
    });
  } catch (error) {
    res.json({ success: true, isVPN: false, reason: 'error' });
  }
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
    cnxRate: CNX_RATE
  });
});

// ============================================
// 👤 USER PROFILE
// ============================================
app.get('/api/user', verifyToken, async (req, res) => {
  try {
    const doc = await db.collection('users').doc(req.user.uid).get();
    if (!doc.exists) return res.status(404).json({ success: false, message: 'User not found' });
    
    const data = doc.data();
    const cnxUSD = (data.cnx || 0) * CNX_RATE;
    const coinsUSD = VALID_COINS.reduce((sum, coin) => 
      sum + ((data.balances[coin] || 0) * COIN_PRICES[coin]), 0
    );
    const totalUSD = cnxUSD + coinsUSD;

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
        referredBy: data.referredBy,
        balances: data.balances,
        cnx: data.cnx || 0,
        cnxUSD,
        coinsUSD,
        totalUSD,
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
    res.status(500).json({ success: false, message: 'Internal error' });
  }
});

// ============================================
// 🚰 CLAIM (CNX ONLY)
// ============================================
app.post('/api/claim', verifyToken, requireEmailVerified, claimLimiter, async (req, res) => {
  try {
    const { recaptchaToken } = req.body;

    // reCAPTCHA Enterprise verification
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
          console.warn('reCAPTCHA failed:', recaptchaData);
          return res.status(403).json({ success: false, message: 'Bot detected' });
        }
      } catch (e) { 
        console.log('reCAPTCHA verification skipped:', e.message); 
      }
    }

    const userRef = db.collection('users').doc(req.user.uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: 'User not found' });

    const userData = userDoc.data();
    const now = Date.now();

    if (now - (userData.lastClaimAt || 0) < CLAIM_COOLDOWN_MS) {
      const remaining = Math.ceil((CLAIM_COOLDOWN_MS - (now - userData.lastClaimAt)) / 1000);
      return res.status(429).json({ success: false, message: `Wait ${remaining} seconds` });
    }

    // Random CNX amount (1-10)
    const rewardRange = COIN_REWARDS.CNX;
    const cnxAmount = Math.floor(rewardRange.min + Math.random() * (rewardRange.max - rewardRange.min + 1));
    const usdValue = +(cnxAmount * CNX_RATE).toFixed(4);

    await db.runTransaction(async (transaction) => {
      const freshDoc = await transaction.get(userRef);
      if (!freshDoc.exists) throw new Error('User not found');
      const freshData = freshDoc.data();
      
      if (now - (freshData.lastClaimAt || 0) < CLAIM_COOLDOWN_MS) {
        throw new Error('Cooldown not passed');
      }
      
      transaction.update(userRef, {
        cnx: FieldValue.increment(cnxAmount),
        lastClaimAt: now,
        totalClaims: FieldValue.increment(1),
        xp: FieldValue.increment(5)
      });
    });

    // Record claim
    await db.collection('claims').add({
      userId: req.user.uid, 
      coin: 'CNX', 
      amount: cnxAmount, 
      usdValue,
      createdAt: FieldValue.serverTimestamp()
    });

    // Record transaction
    await db.collection('transactions').add({
      userId: req.user.uid, 
      type: 'claim', 
      coin: 'CNX', 
      amount: cnxAmount, 
      usdValue,
      status: 'completed', 
      createdAt: FieldValue.serverTimestamp()
    });

    // Referral bonus (20%)
    if (userData.referredBy) {
      const refSnap = await db.collection('users')
        .where('referralCode', '==', userData.referredBy)
        .limit(1).get();
      
      if (!refSnap.empty) {
        const refDoc = refSnap.docs[0];
        const refData = refDoc.data();
        const refBonus = Math.floor(cnxAmount * REFERRAL_RATE);
        
        await db.collection('users').doc(refDoc.id).update({
          cnx: FieldValue.increment(refBonus),
          referralEarnings: FieldValue.increment(refBonus * CNX_RATE)
        });
      }
    }

    // Update global stats
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
// 💱 SWAP (CNX → COINS)
// ============================================
app.post('/api/swap', verifyToken, requireEmailVerified, async (req, res) => {
  try {
    const { fromCoin, toCoin, amount } = req.body;
    
    if (fromCoin !== 'CNX') {
      return res.status(400).json({ success: false, message: 'Can only swap from CNX' });
    }
    if (!VALID_COINS.includes(toCoin)) {
      return res.status(400).json({ success: false, message: 'Invalid target coin' });
    }
    if (amount <= 0 || !Number.isFinite(amount)) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }

    const userRef = db.collection('users').doc(req.user.uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: 'User not found' });

    const userData = userDoc.data();
    const cnxBalance = userData.cnx || 0;
    
    if (cnxBalance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient CNX balance' });
    }

    // Calculate: CNX → USD → Target Coin
    const usdValue = amount * CNX_RATE;
    const targetAmount = +(usdValue / COIN_PRICES[toCoin]).toFixed(8);

    await db.runTransaction(async (transaction) => {
      const freshDoc = await transaction.get(userRef);
      if (!freshDoc.exists) throw new Error('User not found');
      const freshData = freshDoc.data();
      
      if ((freshData.cnx || 0) < amount) {
        throw new Error('Insufficient CNX balance');
      }
      
      const newBalances = { ...freshData.balances };
      newBalances[toCoin] = (newBalances[toCoin] || 0) + targetAmount;
      
      transaction.update(userRef, {
        cnx: FieldValue.increment(-amount),
        balances: newBalances
      });
    });

    // Record transaction
    await db.collection('transactions').add({
      userId: req.user.uid, 
      type: 'swap',
      fromCoin: 'CNX', 
      fromAmount: amount,
      toCoin, 
      toAmount: targetAmount,
      usdValue,
      status: 'completed',
      createdAt: FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      fromCoin: 'CNX',
      fromAmount: amount,
      toCoin,
      toAmount: targetAmount,
      usdValue
    });
  } catch (error) {
    console.error('Swap error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// 💸 WITHDRAW (5 COINS)
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
      return res.status(400).json({ success: false, message: 'Please set your FaucetPay email in settings first' });
    }

    const balance = userData.balances[coinUpper] || 0;
    const balanceUSD = balance * COIN_PRICES[coinUpper];
    
    if (balanceUSD < WITHDRAW_MINIMUM_USD) {
      return res.status(400).json({ 
        success: false, 
        message: `Minimum withdrawal is $${WITHDRAW_MINIMUM_USD}. Your balance: $${balanceUSD.toFixed(4)}` 
      });
    }

    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(userRef);
      const data = fresh.data();
      const b = data.balances[coinUpper] || 0;
      
      if (b * COIN_PRICES[coinUpper] < WITHDRAW_MINIMUM_USD) {
        throw new Error('Insufficient balance');
      }
      
      const newBal = { ...data.balances };
      newBal[coinUpper] = 0;
      
      tx.update(userRef, { 
        balances: newBal, 
        totalWithdrawn: FieldValue.increment(b * COIN_PRICES[coinUpper]) 
      });
    });

    // Record withdrawal
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

    // Update global stats
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
      status: 'pending',
      message: 'Withdrawal submitted. Funds will arrive in your FaucetPay account shortly.'
    });
  } catch (error) {
    console.error('Withdraw error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// 🎁 OFFERWALL.ME WEBHOOK
// ============================================
app.post('/api/offerwall', async (req, res) => {
  try {
    const { user_id, amount, offer_id, status, tx_id, secret } = req.body;
    
    // Verify secret key
    if (secret !== process.env.OFFERWALL_SECRET_KEY) {
      console.warn('⚠️ Invalid Offerwall secret key attempt');
      return res.status(401).json({ success: false, message: 'Invalid secret' });
    }
    
    if (status !== 'completed') {
      return res.status(400).json({ success: false, message: 'Offer not completed' });
    }
    
    // Find user by offerwall user ID
    const userSnap = await db.collection('users')
      .where('offerwallId', '==', user_id)
      .limit(1).get();
    
    if (userSnap.empty) {
      console.warn('Offerwall user not found:', user_id);
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    const userDoc = userSnap.docs[0];
    const userData = userDoc.data();
    
    // Add CNX (1 CNX = $0.01, so amount * 100 = CNX)
    const cnxAmount = Math.floor(amount * 100);
    
    await db.collection('users').doc(userDoc.id).update({
      cnx: FieldValue.increment(cnxAmount)
    });
    
    await db.collection('transactions').add({
      userId: userDoc.id,
      type: 'offerwall',
      coin: 'CNX',
      amount: cnxAmount,
      usdValue: amount,
      offerId: offer_id,
      txId: tx_id,
      status: 'completed',
      createdAt: FieldValue.serverTimestamp()
    });
    
    console.log(`✅ Offerwall: Added ${cnxAmount} CNX to ${userData.username} for offer ${offer_id}`);
    
    res.json({ success: true, message: `Added ${cnxAmount} CNX` });
  } catch (error) {
    console.error('Offerwall error:', error);
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
    const cnxUSD = (data.cnx || 0) * CNX_RATE;
    const coinsUSD = VALID_COINS.reduce((sum, coin) => 
      sum + ((data.balances[coin] || 0) * COIN_PRICES[coin]), 0
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
    console.error('Stats error:', error);
    res.status(500).json({ success: false, message: 'Error' });
  }
});

// ============================================
// 🏆 LEADERBOARD
// ============================================
app.get('/api/leaderboard', async (req, res) => {
  try {
    const snap = await db.collection('users')
      .orderBy('totalClaims', 'desc')
      .limit(100).get();
    
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
    console.error('Leaderboard error:', error);
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
    
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: 'No valid fields to update' });
    }
    
    await db.collection('users').doc(req.user.uid).update(updates);
    res.json({ success: true, message: 'Settings saved successfully' });
  } catch (error) {
    console.error('Settings error:', error);
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
    
    if (type && ['claim', 'withdraw', 'daily-bonus', 'referral', 'swap', 'offerwall'].includes(type)) {
      query = query.where('type', '==', type);
    }
    
    const snap = await query.get();
    const txs = [];
    snap.forEach(d => txs.push({ id: d.id, ...d.data() }));
    
    res.json({ success: true, transactions: txs });
  } catch (error) {
    console.error('Transactions error:', error);
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
    
    if (last === today) {
      return res.status(400).json({ success: false, message: 'Already claimed today' });
    }
    
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const newStreak = last === yesterday ? (data.dailyStreak || 0) + 1 : 1;
    
    // Daily bonus: 10-50 CNX based on streak
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
    console.error('Daily bonus error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// 🔐 RECAPTCHA VERIFY
// ============================================
app.post('/api/verify-recaptcha', async (req, res) => {
  try {
    const { token, action } = req.body;
    if (!token) return res.status(400).json({ success: false, message: 'Token required' });

    const response = await fetch(
      `https://www.google.com/recaptcha/api/siteverify`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `secret=${process.env.RECAPTCHA_SECRET_KEY}&response=${token}`
      }
    );
    
    const assessment = await response.json();
    const score = assessment.score || 0;
    
    if (score >= 0.5) {
      res.json({ success: true, score });
    } else {
      res.status(400).json({ success: false, score, message: 'Bot detected' });
    }
  } catch (error) {
    console.error('reCAPTCHA error:', error);
    res.status(500).json({ success: false, message: 'Error' });
  }
});

// ============================================
// 🌐 LIVE WITHDRAWS (Public)
// ============================================
app.get('/api/live-withdraws', async (req, res) => {
  try {
    const snap = await db.collection('transactions')
      .where('type', '==', 'withdraw')
      .where('status', '==', 'completed')
      .orderBy('createdAt', 'desc')
      .limit(30).get();

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
    console.error('Live withdraws error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// 🔐 ADMIN ENDPOINTS
// ============================================
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
        totalWithdrawnAmount: globalData.totalWithdrawnAmount || 0,
        referralRewards: globalData.referralRewards || 0
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

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

    await db.collection('global').doc('stats').set({
      totalWithdrawals: FieldValue.increment(1),
      totalWithdrawnAmount: FieldValue.increment(parseFloat(finalUSD)),
      lastUpdated: FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ success: true, message: `Added: ${finalAmount} ${coin.toUpperCase()} for ${username}` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/admin/boost-stats', verifyAdmin, async (req, res) => {
  try {
    const { addClaims = 0, addPaid = 0, addWithdrawals = 0, addWithdrawnAmount = 0 } = req.body;
    const updates = { lastUpdated: FieldValue.serverTimestamp() };
    if (addClaims > 0) updates.totalClaims = FieldValue.increment(addClaims);
    if (addPaid > 0) updates.totalPaid = FieldValue.increment(addPaid);
    if (addWithdrawals > 0) updates.totalWithdrawals = FieldValue.increment(addWithdrawals);
    if (addWithdrawnAmount > 0) updates.totalWithdrawnAmount = FieldValue.increment(addWithdrawnAmount);

    await db.collection('global').doc('stats').set(updates, { merge: true });
    res.json({ success: true, message: `Boosted: +${addClaims} claims, +$${addPaid} paid, +${addWithdrawals} withdrawals` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// 🚫 404 + ERROR
// ============================================
app.use((req, res) => res.status(404).json({ success: false, message: 'Not found' }));
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ success: false, message: 'Internal error' });
});

// ============================================
// 💖 SELF-PING (Keep-Alive)
// ============================================
function startSelfPing() {
  setInterval(async () => {
    try {
      const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
      await fetch(`${url}/api/keep-alive`);
      console.log('💓 Self-ping at', new Date().toISOString());
    } catch (err) {
      console.log('⚠️ Self-ping failed:', err.message);
    }
  }, 14 * 60 * 1000); // Every 14 minutes
}

// ============================================
// 🚀 START
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 CoinixFaucet v2.0 running on port ${PORT}`);
  console.log(`🔐 Firebase: coinixfaucet`);
  console.log(`💰 CNX Faucet: 1 CNX = $0.01`);
  console.log(`💱 Swap: CNX → 5 Coins`);
  console.log(`🎁 Offerwall.me Ready`);
  console.log(`🛡️ VPN Protection: ENABLED (ipwho.is)`);
  console.log(`🔐 reCAPTCHA: ${process.env.RECAPTCHA_SECRET_KEY ? 'ENABLED' : 'DISABLED'}`);
  console.log(`💖 Keep-alive: Active (self-ping every 14min)`);
  startSelfPing();
});

export default app;

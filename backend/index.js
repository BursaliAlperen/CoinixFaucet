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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================
// 🔥 FIREBASE ADMIN INIT (ENV üzerinden)
// ============================================
if (!admin.apps.length) {
  try {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!serviceAccountJson) {
      console.error('❌ FIREBASE_SERVICE_ACCOUNT environment variable is not set!');
      process.exit(1);
    }
    const serviceAccount = JSON.parse(serviceAccountJson);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase Admin initialized (via env)');
  } catch (error) {
    console.error('❌ Firebase Admin init failed:', error.message);
    process.exit(1);
  }
}

const db = getFirestore();
const auth = admin.auth();

// ============================================
// 🔒 CONSTANTS
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

// ============================================
// 🛡️ VPN/PROXY DETECTION
// ============================================
const vpnCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;

async function checkVPNProxy(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') {
    return { isVPN: false, reason: 'localhost' };
  }

  const cached = vpnCache.get(ip);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.result;
  }

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
      console.warn(`🚫 VPN/Proxy tespit edildi: ${ip} | ${result.reason}`);
      try {
        await db.collection('blocked_ips').doc(ip.replace(/\./g, '_')).set({
          ip,
          reason: result.reason,
          isp: result.isp,
          country: result.country,
          blockedAt: FieldValue.serverTimestamp(),
          expiresAt: new Date(Date.now() + 3600000)
        }, { merge: true });
      } catch (e) { console.error('Block IP error:', e.message); }
    }

    return result;
  } catch (error) {
    console.error('VPN check error:', error.message);
    return { isVPN: false, reason: 'error' };
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
      message: 'VPN/Proxy/Tor/Hosting kullanımı yasaktır'
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
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['https://coinixfaucet.mine.bz'],
  credentials: true
}));

app.use(express.json({ limit: '10kb' }));
app.set('trust proxy', 1);
app.use(vpnMiddleware);

// ============================================
// 📁 STATIC DOSYALAR (FRONTEND) - DÜZELTİLDİ
// ============================================
// Artık 'frontend' klasörü aramıyor, doğrudan proje kökünü kullanıyor
const frontendPath = __dirname;
console.log(`📁 Frontend path: ${frontendPath}`);

// frontend klasörünün varlığını kontrol et (artık kök)
if (!fs.existsSync(frontendPath)) {
  console.error(`❌ Frontend klasörü bulunamadı: ${frontendPath}`);
  process.exit(1);
}

// Statik dosyaları sun
app.use(express.static(frontendPath));

// Admin paneli için özel rota
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

// ============================================
// 💖 HEALTH + KEEP-ALIVE
// ============================================
app.get('/api/keep-alive', (req, res) => {
  res.json({ success: true, status: 'alive', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '2.0.0' });
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
    res.json({ success: true, isVPN: result.isVPN, reason: result.reason, country: result.country, isp: result.isp });
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
// 🚰 CLAIM (CNX ONLY)
// ============================================
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
        console.log('reCAPTCHA hatası:', e.message);
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
        const refData = refDoc.data();
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
// 💱 SWAP (CNX → COINS)
// ============================================
app.post('/api/swap', verifyToken, requireEmailVerified, async (req, res) => {
  try {
    const { fromCoin, toCoin, amount } = req.body;

    if (fromCoin !== 'CNX') return res.status(400).json({ success: false, message: 'Can only swap from CNX' });
    if (!VALID_COINS.includes(toCoin)) return res.status(400).json({ success: false, message: 'Invalid target coin' });
    if (amount <= 0 || !Number.isFinite(amount)) return res.status(400).json({ success: false, message: 'Invalid amount' });

    const userRef = db.collection('users').doc(req.user.uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: 'User not found' });

    const userData = userDoc.data();
    const cnxBalance = userData.cnx || 0;

    if (cnxBalance < amount) return res.status(400).json({ success: false, message: 'Insufficient CNX balance' });

    const usdValue = amount * CNX_RATE;
    const targetAmount = +(usdValue / COIN_PRICES[toCoin]).toFixed(8);

    await db.runTransaction(async (transaction) => {
      const freshDoc = await transaction.get(userRef);
      if (!freshDoc.exists) throw new Error('User not found');
      const freshData = freshDoc.data();

      if ((freshData.cnx || 0) < amount) throw new Error('Insufficient CNX');

      const newBalances = { ...freshData.balances };
      newBalances[toCoin] = (newBalances[toCoin] || 0) + targetAmount;

      transaction.update(userRef, {
        cnx: FieldValue.increment(-amount),
        balances: newBalances
      });
    });

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
// 🎟️ PROMO CODE SYSTEM
// ============================================

// Create promo code (admin)
app.post('/api/admin/promo/create', verifyAdmin, async (req, res) => {
  try {
    const { code, coin, amount, maxUses, expiresAt } = req.body;

    if (!code || !coin || !amount) {
      return res.status(400).json({ success: false, message: 'Code, coin and amount required' });
    }

    if (!ALL_COINS.includes(coin.toUpperCase())) {
      return res.status(400).json({ success: false, message: 'Invalid coin' });
    }

    const promoDoc = {
      code: code.toUpperCase(),
      coin: coin.toUpperCase(),
      amount: parseFloat(amount),
      maxUses: parseInt(maxUses) || null,
      currentUses: 0,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      isActive: true,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: 'admin'
    };

    await db.collection('promo_codes').doc(code.toUpperCase()).set(promoDoc);

    res.json({ success: true, message: `Promo code ${code.toUpperCase()} created`, promo: promoDoc });
  } catch (error) {
    console.error('Create promo error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Redeem promo code (user)
app.post('/api/promo/redeem', verifyToken, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: 'Code required' });

    const promoDoc = await db.collection('promo_codes').doc(code.toUpperCase()).get();
    if (!promoDoc.exists) {
      return res.status(404).json({ success: false, message: 'Invalid promo code' });
    }

    const promoData = promoDoc.data();

    if (!promoData.isActive) {
      return res.status(400).json({ success: false, message: 'Promo code is inactive' });
    }

    if (promoData.expiresAt && new Date() > promoData.expiresAt.toDate()) {
      return res.status(400).json({ success: false, message: 'Promo code expired' });
    }

    if (promoData.maxUses && promoData.currentUses >= promoData.maxUses) {
      return res.status(400).json({ success: false, message: 'Promo code max uses reached' });
    }

    const userRef = db.collection('users').doc(req.user.uid);
    const userSnap = await userRef.get();
    const userData = userSnap.data();

    if (userData.usedPromoCodes && userData.usedPromoCodes.includes(code.toUpperCase())) {
      return res.status(400).json({ success: false, message: 'You already used this promo code' });
    }

    // Add reward
    let usdValue = 0;
    if (promoData.coin === 'CNX') {
      await userRef.update({
        cnx: FieldValue.increment(promoData.amount),
        usedPromoCodes: FieldValue.arrayUnion(code.toUpperCase())
      });
      usdValue = promoData.amount * CNX_RATE;
    } else {
      const balances = { ...(userData.balances || {}) };
      balances[promoData.coin] = (balances[promoData.coin] || 0) + promoData.amount;
      await userRef.update({
        balances,
        usedPromoCodes: FieldValue.arrayUnion(code.toUpperCase())
      });
      usdValue = promoData.amount * COIN_PRICES[promoData.coin];
    }

    await promoDoc.ref.update({
      currentUses: FieldValue.increment(1)
    });

    await db.collection('transactions').add({
      userId: req.user.uid,
      type: 'promo',
      coin: promoData.coin,
      amount: promoData.amount,
      promoCode: code.toUpperCase(),
      usdValue,
      status: 'completed',
      createdAt: FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      message: `Redeemed ${promoData.amount} ${promoData.coin}!`,
      coin: promoData.coin,
      amount: promoData.amount,
      usdValue
    });
  } catch (error) {
    console.error('Redeem promo error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// List promo codes (admin)
app.get('/api/admin/promo/list', verifyAdmin, async (req, res) => {
  try {
    const snap = await db.collection('promo_codes').orderBy('createdAt', 'desc').get();
    const codes = [];
    snap.forEach(d => codes.push({ id: d.id, ...d.data() }));
    res.json({ success: true, codes });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete promo code (admin)
app.delete('/api/admin/promo/:code', verifyAdmin, async (req, res) => {
  try {
    await db.collection('promo_codes').doc(req.params.code.toUpperCase()).delete();
    res.json({ success: true, message: 'Promo code deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Toggle promo code (admin)
app.post('/api/admin/promo/:code/toggle', verifyAdmin, async (req, res) => {
  try {
    const promoDoc = await db.collection('promo_codes').doc(req.params.code.toUpperCase()).get();
    if (!promoDoc.exists) return res.status(404).json({ success: false, message: 'Not found' });

    const current = promoDoc.data().isActive;
    await promoDoc.ref.update({ isActive: !current });

    res.json({ success: true, message: `Promo code ${!current ? 'activated' : 'deactivated'}` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// 🎁 OFFERWALL.ME WEBHOOK
// ============================================
app.post('/api/offerwall', async (req, res) => {
  try {
    const { user_id, amount, offer_id, status, tx_id, secret } = req.body;

    if (secret !== process.env.OFFERWALL_SECRET_KEY) {
      console.warn('⚠️ Offerwall: Geçersiz secret');
      return res.status(401).json({ success: false, message: 'Invalid secret' });
    }

    if (status !== 'completed') {
      console.log(`ℹ️ Offerwall: Status "${status}" — tamamlanmadı, işlem yapılmadı.`);
      return res.status(200).json({ success: true, message: 'Status not completed, ignored' });
    }

    const userSnap = await db.collection('users')
      .where('offerwallId', '==', user_id)
      .limit(1)
      .get();

    if (userSnap.empty) {
      console.warn(`⚠️ Offerwall: Kullanıcı bulunamadı: ${user_id}`);
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const userDoc = userSnap.docs[0];
    const userId = userDoc.id;

    const cnxAmount = Math.floor(parseFloat(amount) * 100);

    if (cnxAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }

    await db.collection('users').doc(userId).update({
      cnx: FieldValue.increment(cnxAmount)
    });

    await db.collection('transactions').add({
      userId: userId,
      type: 'offerwall',
      coin: 'CNX',
      amount: cnxAmount,
      usdValue: parseFloat(amount),
      offerId: offer_id,
      txId: tx_id,
      status: 'completed',
      createdAt: FieldValue.serverTimestamp()
    });

    console.log(`✅ Offerwall: ${cnxAmount} CNX eklendi. Kullanıcı: ${userId}, Offer: ${offer_id}`);

    res.json({ success: true, message: `Added ${cnxAmount} CNX` });
  } catch (error) {
    console.error('Offerwall error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/offerwall/set-id', verifyToken, async (req, res) => {
  try {
    const { offerwallId } = req.body;
    if (!offerwallId) {
      return res.status(400).json({ success: false, message: 'offerwallId required' });
    }

    await db.collection('users').doc(req.user.uid).update({
      offerwallId: offerwallId
    });

    res.json({ success: true, message: 'Offerwall ID saved' });
  } catch (error) {
    console.error('Set offerwall ID error:', error);
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
    if (type && ['claim', 'withdraw', 'daily-bonus', 'referral', 'swap', 'offerwall', 'promo'].includes(type)) {
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
    res.status(500).json({ success: false, message: 'Error' });
  }
});

// ============================================
// 🌐 LIVE WITHDRAWS
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
    res.json({ success: true, message: `Boosted` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

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
        cnx: data.cnx || 0,
        balances: data.balances || {},
        totalClaims: data.totalClaims || 0,
        totalWithdrawn: data.totalWithdrawn || 0,
        referralCount: data.referralCount || 0
      });
    });
    res.json({ success: true, users, count: users.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// 🚫 404 + ERROR
// ============================================
// API olmayan tüm istekler için index.html (SPA desteği)
app.get('*', (req, res) => {
  const indexPath = join(frontendPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Frontend not found. Please check deployment.');
  }
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ success: false, message: 'Internal error' });
});

// ============================================
// 💖 SELF-PING
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
  }, 14 * 60 * 1000);
}

// ============================================
// 🚀 START
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 CoinixFaucet v2.0 running on port ${PORT}`);
  console.log(`💰 CNX Faucet: 1 CNX = $0.01`);
  console.log(`🎟️ Promo Codes: ENABLED`);
  console.log(`🛡️ VPN Protection: ENABLED`);
  console.log(`💖 Keep-alive: Active`);
  console.log(`📁 Serving frontend from ${frontendPath}`);
  startSelfPing();
});

export default app;

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const compression = require('compression');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const admin = require('firebase-admin');

// ============================================
// FIREBASE INIT - Keep serviceAccountKey.json as fallback
// ============================================
let serviceAccount = null;
let firebaseInitialized = false;
let db = null;
let serverTimestamp = () => new Date();
let increment = (n) => n;
let FieldValue = null;
let Timestamp = null;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    console.log('Firebase: Using FIREBASE_SERVICE_ACCOUNT_JSON env var');
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
    serviceAccount = JSON.parse(decoded);
    console.log('Firebase: Using FIREBASE_SERVICE_ACCOUNT_BASE64 env var');
  } else {
    try {
      serviceAccount = require('./serviceAccountKey.json');
      console.log('Firebase: Using serviceAccountKey.json (local dev)');
    } catch (e) {
      console.error('Firebase: No credentials found. Set FIREBASE_SERVICE_ACCOUNT_JSON env var or add serviceAccountKey.json');
    }
  }

  if (serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    FieldValue = admin.firestore.FieldValue;
    Timestamp = admin.firestore.Timestamp;
    serverTimestamp = () => FieldValue.serverTimestamp();
    increment = (n) => FieldValue.increment(n);
    firebaseInitialized = true;
    console.log('Firebase initialized successfully');
  } else {
    console.warn('Firebase: Running WITHOUT database (dummy mode)');
  }
} catch (e) {
  console.error('Firebase init error:', e.message);
  firebaseInitialized = false;
  db = null;
}

// ============================================
// LOGGER
// ============================================
const logger = {
  info: (msg, meta = {}) => console.log(`[INFO] ${msg}`, meta),
  error: (msg, meta = {}) => console.error(`[ERROR] ${msg}`, meta),
  debug: (msg, meta = {}) => console.log(`[DEBUG] ${msg}`, meta),
  warn: (msg, meta = {}) => console.warn(`[WARN] ${msg}`, meta)
};

// ============================================
// CONFIG
// ============================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME || 'your_bot';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const ADMIN_SECRET = process.env.ADMIN_ID;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '';
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY;
const OFFERWALL_API_KEY = process.env.OFFERWALL_APP_ID;
const OFFERWALL_SECRET_KEY = process.env.OFFERWALL_SECRET_KEY;
const OFFERWALL_API_TOKEN = process.env.OFFERWALL_API_TOKEN || '';
const APP_URL = process.env.APP_URL || 'https://coinix-faucet.vercel.app';
const PORT = process.env.PORT || 3000;

// ============================================
// FAUCET CONFIG
// ============================================
const FAUCET_COOLDOWN = 180000; // 3 minutes
const FAUCET_REWARD = 1.0; // 1 CNX

// ============================================
// BONUS CONFIG
// ============================================
const BONUS_PERCENT = 20;
const BONUS_TYPES = ['ptc', 'shortlink', 'shortlinks', 'game', 'games', 'visit', 'visits'];

// ============================================
// SECURITY (Helmet) - CSP Updated
// ============================================
function setupSecurity(app) {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'", "https://offerwall.me", "https://*.offerwall.me"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://offerwall.me", "https://*.offerwall.me", "https://telegram.org", "https://translate.googleapis.com", "https://translate.google.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://translate.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:", "https:", "blob:"],
        connectSrc: ["'self'", "https://*.googleapis.com", "https://*.firebaseio.com", "https://api.coingecko.com", "https://offerwall.me", "https://*.offerwall.me"],
        frameSrc: ["'self'", "https://offerwall.me", "https://*.offerwall.me", "https://translate.google.com"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: []
      }
    },
    crossOriginEmbedderPolicy: false,
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
  }));
}

// ============================================
// RATE LIMITERS
// ============================================
const generalLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: { error: 'Too many requests' }, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 10, message: { error: 'Too many auth attempts' }, standardHeaders: true, legacyHeaders: false });
const claimLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Too many claims' }, standardHeaders: true, legacyHeaders: false });
const withdrawLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'Too many withdrawals' }, standardHeaders: true, legacyHeaders: false });

// ============================================
// AUTH MIDDLEWARE
// ============================================
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
  } catch (e) { return false; }
}

function jwtAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) { return res.status(403).json({ error: 'Invalid token' }); }
}

function adminAuth(req, res, next) {
  const key = req.query.admin_key || req.headers['x-admin-key'];
  if (!ADMIN_SECRET || key !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  next();
}

function verifyAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (String(req.user.userId) !== String(ADMIN_TELEGRAM_ID)) {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

// ============================================
// UTILS
// ============================================
async function logAction(action, userId, details = {}) {
  if (!db) return;
  try {
    await db.collection('logs').add({
      action, user_id: userId || null, details,
      ip: details.ip || req?.headers?.['x-forwarded-for'] || null,
      timestamp: serverTimestamp()
    });
  } catch (e) { logger.error('Log error', { error: e.message }); }
}

function getClientIP(req) {
  return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '0.0.0.0').split(',')[0].trim();
}

// ============================================
// DOGE PRICE CACHE (CoinGecko)
// ============================================
let dogePriceCache = { price: 0, change: 0, lastUpdate: 0 };

async function fetchDogePrice() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=dogecoin&vs_currencies=usd&include_24hr_change=true', { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) {
      logger.warn('Doge price HTTP error', { status: response.status });
      return dogePriceCache;
    }
    const data = await response.json();
    if (data?.dogecoin?.usd != null) {
      dogePriceCache = {
        price: data.dogecoin.usd,
        change: typeof data.dogecoin.usd_24h_change === 'number' ? data.dogecoin.usd_24h_change : 0,
        lastUpdate: Date.now()
      };
    }
    return dogePriceCache;
  } catch (err) {
    logger.error('Doge price fetch error', { error: err.message });
    return dogePriceCache;
  }
}

setInterval(fetchDogePrice, 120000);
fetchDogePrice();

// ============================================
// OFFERWALL.ME INTEGRATION
// ============================================

async function getOfferwallUrl(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const userId = String(req.user.userId);
    const url = `https://offerwall.me/offerwall/${OFFERWALL_API_KEY}/${userId}`;
    logger.info('Offerwall URL generated', { userId });
    res.json({ success: true, url, user_id: userId });
  } catch (err) {
    logger.error('Offerwall URL error', { error: err.message });
    res.status(500).json({ error: 'Failed to generate offerwall URL' });
  }
}

async function getPTCAds(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const userId = String(req.user.userId);
    const userIp = getClientIP(req);
    const country = req.headers['cf-ipcountry'] || 'US';

    if (!OFFERWALL_API_TOKEN) {
      return res.json({ success: true, ads: [], total: 0, message: 'API token not configured' });
    }

    const apiUrl = `https://offerwall.me/api.php?api=${OFFERWALL_API_KEY}&id=${userId}&ip=${userIp}&token=${OFFERWALL_API_TOKEN}&country=${country}`;
    logger.debug('Fetching PTC ads', { userId });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      logger.error('PTC API HTTP error', { status: response.status });
      return res.status(502).json({ error: 'Offerwall API error', status: response.status });
    }

    const data = await response.json();
    if (data.status !== 200) {
      return res.json({ success: false, error: data.message || 'API error', ads: [] });
    }

    const ads = (data.data || []).map(ad => ({
      id: ad.id || ad.campaign_id || String(Math.random()),
      title: ad.title || 'Untitled Ad',
      description: ad.description || '',
      reward: Number(ad.reward) || 0,
      duration: ad.duration || ad.time || 30,
      url: ad.url || '',
      type: ad.type || 1,
      max: ad.max || 0,
      thumbnail: ad.thumbnail || ''
    }));

    await logAction('ptc_ads_loaded', userId, { count: ads.length });
    res.json({ success: true, ads, total: ads.length });
  } catch (err) {
    logger.error('Get PTC Ads error', { error: err.message });
    res.status(500).json({ error: 'Failed to load PTC ads', details: err.message });
  }
}

async function getShortlinks(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const userId = String(req.user.userId);
    const userIp = getClientIP(req);
    const country = req.headers['cf-ipcountry'] || 'US';

    if (!OFFERWALL_API_TOKEN) {
      return res.json({ success: true, shortlinks: [], total: 0, message: 'API token not configured' });
    }

    const apiUrl = `https://offerwall.me/slapi.php?api=${OFFERWALL_API_KEY}&id=${userId}&ip=${userIp}&token=${OFFERWALL_API_TOKEN}&country=${country}`;
    logger.debug('Fetching shortlinks', { userId });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      logger.error('Shortlink API HTTP error', { status: response.status });
      return res.status(502).json({ error: 'Offerwall API error', status: response.status });
    }

    const data = await response.json();
    if (data.status !== 200) {
      return res.json({ success: false, error: data.message || 'API error', shortlinks: [] });
    }

    const shortlinks = (data.data || []).map(link => ({
      id: link.id || link.campaign_id || String(Math.random()),
      name: link.name || link.title || 'Untitled Link',
      reward: Number(link.reward) || 0,
      url: link.url || '',
      remaining_views: link.remaining_views || 0,
      daily_limit: link.daily_limit || 0
    }));

    await logAction('shortlinks_loaded', userId, { count: shortlinks.length });
    res.json({ success: true, shortlinks, total: shortlinks.length });
  } catch (err) {
    logger.error('Get Shortlinks error', { error: err.message });
    res.status(500).json({ error: 'Failed to load shortlinks', details: err.message });
  }
}

async function getGames(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const userId = String(req.user.userId);
    const url = `https://offerwall.me/offerwall/${OFFERWALL_API_KEY}/${userId}`;
    logger.info('Games offerwall URL generated', { userId });
    res.json({ success: true, url, message: 'Games are available through the offerwall iframe' });
  } catch (err) {
    logger.error('Get Games error', { error: err.message });
    res.status(500).json({ error: 'Failed to load games' });
  }
}

// ============================================
// POSTBACK - SECURE & WITH BONUS
// ============================================
const OFFERWALL_IPS = ['95.216.65.163', '2a01:4f9:2b:1dc::2'];

function isOfferwallIP(ip) {
  if (!ip) return false;
  const normalized = ip.toLowerCase();
  return OFFERWALL_IPS.some(allowed => normalized === allowed.toLowerCase());
}

async function postback(req, res) {
  try {
    const clientIp = getClientIP(req);
    logger.info('Postback received', { ip: clientIp, body: req.body });

    if (!isOfferwallIP(clientIp)) {
      logger.warn('Postback from unauthorized IP', { ip: clientIp });
      return res.status(403).send('ERROR: Invalid source');
    }

    const {
      subId, transId, reward, signature,
      status = '1', offer_name, offer_type,
      reward_name, reward_value, payout,
      userIp, country, debug = '0'
    } = req.body;

    if (!subId || !transId || !reward || !signature) {
      logger.warn('Postback missing params', { subId, transId, reward, hasSig: !!signature });
      return res.status(400).send('ERROR: Missing params');
    }

    const expectedSig = crypto.createHash('md5')
      .update(`${subId}${transId}${reward}${OFFERWALL_SECRET_KEY}`)
      .digest('hex');

    if (signature !== expectedSig) {
      logger.warn('Postback invalid signature', { transId, received: signature, expected: expectedSig });
      return res.status(403).send('ERROR: Signature does not match');
    }

    logger.info('Postback signature validated', { transId, subId });

    const userRef = db.collection('users').doc(subId);
    const doc = await userRef.get();
    if (!doc.exists) {
      logger.warn('Postback user not found', { subId });
      return res.status(404).send('ERROR: User not found');
    }
    if (doc.data().banned) {
      logger.warn('Postback user banned', { subId });
      return res.status(403).send('ERROR: User banned');
    }

    // Duplicate protection
    const existingTx = await db.collection('offerwall_completions')
      .where('trans_id', '==', transId)
      .limit(1)
      .get();

    if (!existingTx.empty) {
      logger.info('Postback duplicate transaction', { transId });
      return res.status(200).send('ok');
    }

    const baseAmt = Number(reward);
    if (isNaN(baseAmt) || baseAmt <= 0) {
      logger.warn('Postback invalid reward', { reward });
      return res.status(400).send('ERROR: Invalid reward');
    }

    // Determine task type
    const taskType = String(offer_type || 'offer').toLowerCase();
    const isBonusEligible = BONUS_TYPES.some(t => taskType.includes(t));
    const bonusAmt = isBonusEligible ? Math.round(baseAmt * BONUS_PERCENT) / 100 : 0;
    const totalAmt = Math.round((baseAmt + bonusAmt) * 100) / 100;

    const numericStatus = parseInt(status) || 1;

    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error('User not found');
      const userData = userDoc.data();
      const currentBalance = userData.balance || 0;

      if (numericStatus === 1) {
        t.update(userRef, {
          balance: increment(totalAmt),
          total_earned: increment(totalAmt),
          total_offerwall_earned: increment(totalAmt)
        });
        logger.info('Postback reward added', { subId, transId, base: baseAmt, bonus: bonusAmt, total: totalAmt });
      } else if (numericStatus === 2) {
        const deductAmt = Math.min(baseAmt, currentBalance);
        if (deductAmt > 0) {
          t.update(userRef, {
            balance: increment(-deductAmt),
            total_earned: increment(-deductAmt),
            total_offerwall_earned: increment(-deductAmt)
          });
          logger.info('Postback chargeback', { subId, transId, deductAmt });
        }
      }

      t.set(db.collection('offerwall_completions').doc(transId), {
        user_id: subId,
        trans_id: transId,
        task_type: taskType,
        offer_name: offer_name || 'Unknown',
        reward_name: reward_name || 'CNX',
        reward_value: Number(reward_value) || baseAmt,
        base_amount: baseAmt,
        bonus_amount: bonusAmt,
        amount: totalAmt,
        payout_usd: Number(payout) || 0,
        currency: 'CNX',
        status: numericStatus === 1 ? 'completed' : 'chargeback',
        user_ip: userIp || clientIp,
        country: country || 'unknown',
        debug: debug === '1',
        timestamp: serverTimestamp()
      });
    });

    // Give referral bonus on BASE amount (not including the 20% bonus)
    if (numericStatus === 1) {
      await giveReferralBonus(subId, baseAmt, taskType);
    }

    await logAction('offerwall_completed', subId, { transId, baseAmount: baseAmt, bonus: bonusAmt, totalAmount: totalAmt, status });
    logger.info('Postback success', { subId, transId, totalAmt, status });
    res.status(200).send('ok');
  } catch (err) {
    logger.error('Postback error', { error: err.message, stack: err.stack });
    res.status(500).send('ERROR: Server error');
  }
}

// ============================================
// AUTH CONTROLLERS
// ============================================
async function auth(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  const { initData, ref } = req.body;
  if (!initData) return res.status(400).json({ error: 'Missing initData' });
  if (!validateTelegramInitData(initData)) return res.status(403).json({ error: 'Invalid Telegram data signature' });

  let user;
  try {
    const urlParams = new URLSearchParams(initData);
    user = JSON.parse(urlParams.get('user'));
  } catch (e) { return res.status(400).json({ error: 'Bad user data' }); }
  if (!user || !user.id) return res.status(400).json({ error: 'No user data' });

  const userId = String(user.id);
  const userRef = db.collection('users').doc(userId);

  try {
    const doc = await userRef.get();
    const isNew = !doc.exists;

    if (isNew) {
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
        total_offerwall_earned: 0,
        total_claims: 0,
        total_withdrawals: 0,
        referrals: 0,
        referral_earnings: 0,
        referral_balance: 0,
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
          const REFERRAL_SIGNUP_BONUS = 50;
          await refRef.update({
            referrals: increment(1),
            referral_balance: increment(REFERRAL_SIGNUP_BONUS),
            referral_earnings: increment(REFERRAL_SIGNUP_BONUS)
          });
          await db.collection('referrals').add({
            referrer_id: String(ref),
            referred_id: userId,
            bonus: REFERRAL_SIGNUP_BONUS,
            currency: 'CNX',
            type: 'signup',
            timestamp: serverTimestamp()
          });
          await logAction('referral_bonus', String(ref), { referred_id: userId, bonus: REFERRAL_SIGNUP_BONUS, type: 'signup' });
        }
      }
      await logAction('user_register', userId, { username: user.username, ref });
    } else {
      if (doc.data().banned) return res.status(403).json({ error: 'User banned' });
      const updates = {};
      if (user.photo_url) updates.photo_url = user.photo_url;
      if (user.username) updates.username = user.username;
      if (Object.keys(updates).length) await userRef.update(updates);
    }

    const token = jwt.sign({ userId, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, user_id: userId, username: user.username, token, isNew });
  } catch (err) {
    logger.error('Auth error', { error: err.message });
    res.status(500).json({ error: 'Auth failed' });
  }
}

async function getMe(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const doc = await db.collection('users').doc(String(req.user.userId)).get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });
    const d = doc.data();
    res.json({
      telegram_id: d.telegram_id,
      username: d.username,
      first_name: d.first_name,
      photo_url: d.photo_url,
      balance: d.balance || 0,
      doge_balance: d.doge_balance || 0,
      total_earned: d.total_earned || 0,
      total_claims: d.total_claims || 0,
      total_withdrawals: d.total_withdrawals || 0,
      referrals: d.referrals || 0,
      referral_earnings: d.referral_earnings || 0,
      referral_balance: d.referral_balance || 0,
      total_offerwall_earned: d.total_offerwall_earned || 0,
      last_claim: d.last_claim ? d.last_claim.toMillis() : null,
      banned: d.banned || false
    });
  } catch (err) {
    logger.error('GetMe error', { error: err.message });
    res.status(500).json({ error: 'Server error' });
  }
}

async function getBalance(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const doc = await db.collection('users').doc(String(req.user.userId)).get();
    if (!doc.exists) return res.json({ balance: 0, doge_balance: 0, referral_balance: 0 });
    const d = doc.data();
    res.json({
      balance: d.balance || 0,
      doge_balance: d.doge_balance || 0,
      referral_balance: d.referral_balance || 0,
      total_earned: d.total_earned || 0,
      total_claims: d.total_claims || 0,
      total_withdrawals: d.total_withdrawals || 0,
      referrals: d.referrals || 0,
      referral_earnings: d.referral_earnings || 0,
      total_offerwall_earned: d.total_offerwall_earned || 0,
      last_claim: d.last_claim ? d.last_claim.toMillis() : null
    });
  } catch (err) {
    logger.error('Balance error', { error: err.message });
    res.status(500).json({ error: 'Server error' });
  }
}

async function getReferral(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const userId = String(req.user.userId);
    const doc = await db.collection('users').doc(userId).get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });
    const d = doc.data();
    const link = `https://t.me/${BOT_USERNAME}?startapp=ref_${userId}`;
    res.json({
      link,
      referrals: d.referrals || 0,
      earnings: d.referral_earnings || 0,
      referral_balance: d.referral_balance || 0
    });
  } catch (err) {
    logger.error('Referral error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

// ============================================
// REFERRAL BONUS SYSTEM
// ============================================
async function giveReferralBonus(userId, amount, type) {
  if (!db || amount <= 0) return;
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return;
    const userData = userDoc.data();
    if (!userData.referred_by) return;

    const referrerId = userData.referred_by;
    const bonusPercent = 20; // Fixed 20% referral commission
    const bonusAmount = Math.round(amount * (bonusPercent / 100) * 100) / 100;
    if (bonusAmount <= 0) return;

    const referrerRef = db.collection('users').doc(referrerId);
    await db.runTransaction(async (t) => {
      const refDoc = await t.get(referrerRef);
      if (!refDoc.exists) return;
      t.update(referrerRef, {
        referral_balance: increment(bonusAmount),
        referral_earnings: increment(bonusAmount),
        [`referral_bonus_${type}`]: increment(bonusAmount)
      });
    });

    await db.collection('referralBonuses').add({
      referrer: referrerId,
      referred: userId,
      amount: bonusAmount,
      originalAmount: amount,
      type: type || 'unknown',
      timestamp: serverTimestamp()
    });

    logger.info('Referral bonus given', { referrer: referrerId, referred: userId, amount: bonusAmount, type });
  } catch (e) {
    logger.error('Referral bonus error', { error: e.message });
  }
}

async function collectReferralBonus(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  const userId = String(req.user.userId);
  const userRef = db.collection('users').doc(userId);
  try {
    let collected = 0;
    await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error('User not found');
      const d = doc.data();
      const rb = d.referral_balance || 0;
      if (rb <= 0) throw new Error('No referral balance to collect');
      collected = rb;
      t.update(userRef, {
        balance: increment(rb),
        referral_balance: increment(-rb)
      });
    });
    await logAction('referral_collected', userId, { amount: collected });
    res.json({ success: true, amount: collected, message: `${collected} CNX transferred to your balance` });
  } catch (err) {
    logger.error('Collect referral error', { error: err.message });
    res.status(400).json({ error: err.message || 'Failed to collect referral bonus' });
  }
}

// ============================================
// FAUCET CONTROLLER (Transaction Safe)
// ============================================
async function claim(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  const userId = String(req.user.userId);
  const { captchaAnswer } = req.body;

  if (!captchaAnswer) {
    return res.status(400).json({ error: 'Captcha answer required', captchaRequired: true });
  }
  const captchaResult = verifyCaptcha(userId, captchaAnswer);
  if (!captchaResult.valid) {
    return res.status(403).json({ error: captchaResult.error, captchaRequired: true });
  }

  const userRef = db.collection('users').doc(userId);
  try {
    const now = Date.now();
    let newBalance = 0;
    let newClaims = 0;

    await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error('User not found');
      const d = doc.data();
      if (d.banned) throw new Error('User banned');
      const lastClaim = d.last_claim ? d.last_claim.toMillis() : 0;
      if (now - lastClaim < FAUCET_COOLDOWN) {
        throw new Error(`Cooldown active|${FAUCET_COOLDOWN - (now - lastClaim)}`);
      }
      newBalance = (d.balance || 0) + FAUCET_REWARD;
      newClaims = (d.total_claims || 0) + 1;
      t.update(userRef, {
        balance: increment(FAUCET_REWARD),
        total_earned: increment(FAUCET_REWARD),
        total_claims: increment(1),
        last_claim: serverTimestamp()
      });
    });

    // Referral bonus for faucet claim
    await giveReferralBonus(userId, FAUCET_REWARD, 'faucet');
    await logAction('faucet_claim', userId, { amount: FAUCET_REWARD });

    res.json({ success: true, amount: FAUCET_REWARD, balance: newBalance });
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('Cooldown active')) {
      const wait = parseInt(msg.split('|')[1]) || FAUCET_COOLDOWN;
      return res.status(429).json({ error: 'Cooldown active', wait });
    }
    if (msg.includes('User banned')) return res.status(403).json({ error: 'User banned' });
    if (msg.includes('User not found')) return res.status(404).json({ error: 'User not found' });
    logger.error('Claim error', { error: err.message, userId });
    res.status(500).json({ error: 'Claim failed' });
  }
}

// ============================================
// SWAP CONTROLLER (Transaction Safe)
// ============================================
async function swap(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  const userId = String(req.user.userId);
  const { amount, direction } = req.body;
  const amt = Number(amount);
  if (!amt || amt <= 0 || isNaN(amt)) return res.status(400).json({ error: 'Invalid amount' });
  if (!direction || !['cnx-to-doge', 'doge-to-cnx'].includes(direction)) return res.status(400).json({ error: 'Invalid direction' });

  const userRef = db.collection('users').doc(userId);
  try {
    await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error('User not found');
      const d = doc.data();
      if (d.banned) throw new Error('User banned');
      if (direction === 'cnx-to-doge') {
        if ((d.balance || 0) < amt) throw new Error('Insufficient CNX');
        t.update(userRef, { balance: increment(-amt), doge_balance: increment(amt) });
      } else {
        if ((d.doge_balance || 0) < amt) throw new Error('Insufficient DOGE');
        t.update(userRef, { doge_balance: increment(-amt), balance: increment(amt) });
      }
    });
    await db.collection('swaps').add({ user_id: userId, amount: amt, direction, timestamp: serverTimestamp() });
    res.json({ success: true, message: 'Swap completed' });
  } catch (err) {
    if (err.message === 'User not found') return res.status(404).json({ error: 'User not found' });
    if (err.message === 'User banned') return res.status(403).json({ error: 'User banned' });
    if (err.message?.includes('Insufficient')) return res.status(400).json({ error: err.message });
    logger.error('Swap error', { error: err.message, userId });
    res.status(500).json({ error: 'Swap failed' });
  }
}

// ============================================
// WITHDRAW CONTROLLERS (Transaction Safe)
// ============================================
async function withdraw(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  const userId = String(req.user.userId);
  const { faucetpay_email, amount } = req.body;
  const amt = Number(amount);
  if (!amt || amt <= 0 || isNaN(amt)) return res.status(400).json({ error: 'Invalid amount' });
  if (!faucetpay_email || !faucetpay_email.includes('@')) return res.status(400).json({ error: 'Invalid email' });

  const userRef = db.collection('users').doc(userId);
  try {
    await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error('User not found');
      const d = doc.data();
      if (d.banned) throw new Error('User banned');
      if ((d.doge_balance || 0) < amt) throw new Error('Insufficient DOGE');
      if (amt < 0.1) throw new Error('Minimum 0.10 DOGE');
      t.update(userRef, { doge_balance: increment(-amt), total_withdrawals: increment(1) });
    });
    await db.collection('withdrawals').add({
      user_id: userId, faucetpay_email, amount: amt, status: 'pending', timestamp: serverTimestamp()
    });
    res.json({ success: true, message: 'Withdrawal submitted' });
  } catch (err) {
    if (err.message === 'User not found') return res.status(404).json({ error: 'User not found' });
    if (err.message === 'User banned') return res.status(403).json({ error: 'User banned' });
    if (err.message?.includes('Insufficient') || err.message?.includes('Minimum')) return res.status(400).json({ error: err.message });
    logger.error('Withdraw error', { error: err.message, userId });
    res.status(500).json({ error: 'Withdrawal failed' });
  }
}

async function getWithdrawHistory(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const userId = String(req.user.userId);
    const snapshot = await db.collection('withdrawals').where('user_id', '==', userId).orderBy('timestamp', 'desc').limit(50).get();
    res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() })));
  } catch (err) {
    logger.error('Withdraw history error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function getRecentWithdrawals(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const snapshot = await db.collection('withdrawals').orderBy('timestamp', 'desc').limit(25).get();
    res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() })));
  } catch (err) {
    logger.error('Recent withdrawals error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function getWithdrawStats(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTs = Timestamp?.fromDate(today) || today;
    const snapshot = await db.collection('withdrawals').where('timestamp', '>=', todayTs).get();
    const total = snapshot.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
    const allSnap = await db.collection('withdrawals').get();
    const allTime = allSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
    res.json({ today: total, allTime });
  } catch (err) {
    logger.error('Withdraw stats error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

// ============================================
// DOGE PRICE ENDPOINT
// ============================================
async function getDogePrice(req, res) {
  try {
    if (Date.now() - dogePriceCache.lastUpdate > 60000) {
      await fetchDogePrice();
    }
    res.json({
      price: dogePriceCache.price,
      change_24h: dogePriceCache.change,
      lastUpdate: dogePriceCache.lastUpdate
    });
  } catch (err) {
    logger.error('Doge price endpoint error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch price' });
  }
}

// ============================================
// OFFERWALL STATS
// ============================================
async function getOfferwallStats(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const userId = String(req.user.userId);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTs = Timestamp?.fromDate(today) || today;

    const todaySnap = await db.collection('offerwall_completions')
      .where('user_id', '==', userId)
      .where('status', '==', 'completed')
      .where('timestamp', '>=', todayTs)
      .get();
    const allSnap = await db.collection('offerwall_completions')
      .where('user_id', '==', userId)
      .where('status', '==', 'completed')
      .get();

    const ptcCount = allSnap.docs.filter(d => String(d.data().task_type).includes('ptc')).length;
    const shortlinkCount = allSnap.docs.filter(d => String(d.data().task_type).includes('shortlink')).length;
    const gameCount = allSnap.docs.filter(d => String(d.data().task_type).includes('game')).length;
    const todayEarnings = todaySnap.docs.reduce((sum, d) => sum + (d.data().amount || 0), 0);
    const totalEarnings = allSnap.docs.reduce((sum, d) => sum + (d.data().amount || 0), 0);

    res.json({
      success: true,
      today: { count: todaySnap.size, earnings: todayEarnings },
      total: {
        count: allSnap.size, earnings: totalEarnings,
        ptc: ptcCount, shortlinks: shortlinkCount, games: gameCount
      }
    });
  } catch (err) {
    logger.error('Get offerwall stats error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

// ============================================
// STATS CONTROLLERS
// ============================================
async function getGlobalStats(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const usersSnap = await db.collection('users').get();
    const totalUsers = usersSnap.size;
    const activeToday = usersSnap.docs.filter(d => {
      const lc = d.data().last_claim;
      return lc && (Date.now() - lc.toMillis() < 86400000);
    }).length;
    const wdSnap = await db.collection('withdrawals').get();
    const totalPaid = wdSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
    res.json({ totalUsers, activeToday, totalPaid });
  } catch (err) {
    logger.error('Global stats error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function getUserStats(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const userId = String(req.params.userId);
    if (req.user.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
    const doc = await db.collection('users').doc(userId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    const d = doc.data();
    res.json({
      balance: d.balance || 0,
      doge_balance: d.doge_balance || 0,
      referral_balance: d.referral_balance || 0,
      total_earned: d.total_earned || 0,
      total_claims: d.total_claims || 0,
      total_withdrawals: d.total_withdrawals || 0,
      referrals: d.referrals || 0
    });
  } catch (err) {
    logger.error('User stats error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

// ============================================
// ADMIN CONTROLLERS
// ============================================
async function getUsers(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const snap = await db.collection('users').orderBy('created_at', 'desc').limit(100).get();
    res.json(snap.docs.map(d => ({
      id: d.id, ...d.data(),
      created_at: d.data().created_at?.toMillis()
    })));
  } catch (err) {
    logger.error('Admin users error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function getAdminWithdrawals(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const snap = await db.collection('withdrawals').orderBy('timestamp', 'desc').limit(100).get();
    res.json(snap.docs.map(d => ({
      id: d.id, ...d.data(),
      timestamp: d.data().timestamp?.toMillis()
    })));
  } catch (err) {
    logger.error('Admin withdrawals error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function approveWithdrawal(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    await db.collection('withdrawals').doc(req.body.id).update({
      status: 'approved', approved_at: serverTimestamp()
    });
    res.json({ success: true });
  } catch (err) {
    logger.error('Approve error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function addBalance(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const { userId, amount, currency } = req.body;
    const field = currency === 'doge' ? 'doge_balance' : 'balance';
    await db.collection('users').doc(String(userId)).update({
      [field]: increment(Number(amount))
    });
    res.json({ success: true });
  } catch (err) {
    logger.error('Add balance error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function banUser(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    await db.collection('users').doc(String(req.body.userId)).update({ banned: true });
    res.json({ success: true });
  } catch (err) {
    logger.error('Ban error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function unbanUser(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    await db.collection('users').doc(String(req.body.userId)).update({ banned: false });
    res.json({ success: true });
  } catch (err) {
    logger.error('Unban error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function deleteUser(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    await db.collection('users').doc(String(req.body.userId)).delete();
    res.json({ success: true });
  } catch (err) {
    logger.error('Delete error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function getLogs(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const snap = await db.collection('logs').orderBy('timestamp', 'desc').limit(100).get();
    res.json(snap.docs.map(d => ({
      id: d.id, ...d.data(),
      timestamp: d.data().timestamp?.toMillis()
    })));
  } catch (err) {
    logger.error('Logs error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function getSettings(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const doc = await db.collection('settings').doc('global').get();
    res.json(doc.exists ? doc.data() : {});
  } catch (err) {
    logger.error('Settings get error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function updateSettings(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    await db.collection('settings').doc('global').set(req.body, { merge: true });
    res.json({ success: true });
  } catch (err) {
    logger.error('Settings update error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function broadcast(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    await db.collection('broadcasts').add({
      message: req.body.message, timestamp: serverTimestamp()
    });
    res.json({ success: true });
  } catch (err) {
    logger.error('Broadcast error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function getAdminStats(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const usersSnap = await db.collection('users').get();
    const wdSnap = await db.collection('withdrawals').get();
    const offerSnap = await db.collection('offerwall_completions').get();
    const claimsSnap = await db.collection('logs').where('action', '==', 'faucet_claim').get();

    const totalUsers = usersSnap.size;
    const totalWithdrawals = wdSnap.size;
    const totalPaid = wdSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
    const totalOfferwall = offerSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
    const totalClaims = claimsSnap.size;
    const bannedUsers = usersSnap.docs.filter(d => d.data().banned).length;

    res.json({
      totalUsers, totalWithdrawals, totalPaid, totalOfferwall, totalClaims, bannedUsers
    });
  } catch (err) {
    logger.error('Admin stats error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

// ============================================
// CAPTCHA SYSTEM - Server-side verification
// ============================================
const activeCaptchas = new Map();
const MAX_CAPTCHAS = 5000;

function generateMathCaptcha(userId) {
  // Cleanup if too many
  if (activeCaptchas.size > MAX_CAPTCHAS) {
    const firstKey = activeCaptchas.keys().next().value;
    activeCaptchas.delete(firstKey);
  }
  const n1 = Math.floor(Math.random() * 10) + 1;
  const n2 = Math.floor(Math.random() * 10) + 1;
  const answer = n1 + n2;
  activeCaptchas.set(userId, { answer, expiresAt: Date.now() + 5 * 60 * 1000 });
  return { n1, n2, question: `${n1} + ${n2} = ?` };
}

function verifyCaptcha(userId, userAnswer) {
  const captcha = activeCaptchas.get(userId);
  if (!captcha) return { valid: false, error: 'No active captcha. Refresh the page.' };
  if (Date.now() > captcha.expiresAt) {
    activeCaptchas.delete(userId);
    return { valid: false, error: 'Captcha expired. Get a new one.' };
  }
  if (parseInt(userAnswer) !== captcha.answer) {
    activeCaptchas.delete(userId);
    return { valid: false, error: 'Wrong answer. Try a new captcha.' };
  }
  activeCaptchas.delete(userId);
  return { valid: true };
}

function cleanupExpiredCaptchas() {
  const now = Date.now();
  for (const [userId, captcha] of activeCaptchas) {
    if (now > captcha.expiresAt) activeCaptchas.delete(userId);
  }
}
setInterval(cleanupExpiredCaptchas, 60000);

async function getCaptcha(req, res) {
  try {
    const userId = String(req.user.userId);
    const captcha = generateMathCaptcha(userId);
    res.json({ success: true, question: captcha.question, n1: captcha.n1, n2: captcha.n2 });
  } catch (err) {
    logger.error('Captcha generation error', { error: err.message });
    res.status(500).json({ error: 'Failed to generate captcha' });
  }
}

async function verifyCaptchaEndpoint(req, res) {
  try {
    const userId = String(req.user.userId);
    const { answer } = req.body;
    if (!answer) return res.status(400).json({ valid: false, error: 'Answer required' });
    const result = verifyCaptcha(userId, answer);
    res.json(result);
  } catch (err) {
    logger.error('Captcha verification error', { error: err.message });
    res.status(500).json({ error: 'Verification failed' });
  }
}

// ============================================
// PROMO CODE SYSTEM (Fixed to use balance, not balance_cnx)
// ============================================
async function createPromo(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const { code, reward, maxUses, expiresAt } = req.body;
    if (!code || !reward || reward <= 0) return res.status(400).json({ error: 'Code and reward required' });
    const promoRef = db.collection('promoCodes').doc(code.toUpperCase());
    if ((await promoRef.get()).exists) return res.status(400).json({ error: 'Code already exists' });
    await promoRef.set({
      code: code.toUpperCase(),
      reward: parseFloat(reward),
      maxUses: parseInt(maxUses) || 100,
      usedCount: 0,
      usedBy: [],
      createdAt: serverTimestamp(),
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      createdBy: req.user.userId
    });
    res.json({ success: true, code: code.toUpperCase(), reward });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function getPromos(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const snap = await db.collection('promoCodes').orderBy('createdAt', 'desc').get();
    res.json({ promos: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function deletePromo(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    await db.collection('promoCodes').doc(req.params.code.toUpperCase()).delete();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function redeemPromo(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code required' });
    const userId = String(req.user.userId);
    const promoRef = db.collection('promoCodes').doc(code.toUpperCase());
    const promoDoc = await promoRef.get();
    if (!promoDoc.exists) return res.status(400).json({ error: 'Invalid code' });
    const promo = promoDoc.data();
    if (promo.expiresAt && promo.expiresAt.toDate() < new Date()) return res.status(400).json({ error: 'Expired' });
    if (promo.usedCount >= promo.maxUses) return res.status(400).json({ error: 'Fully used' });
    if (promo.usedBy && promo.usedBy.includes(userId)) return res.status(400).json({ error: 'Already used' });

    const userRef = db.collection('users').doc(userId);
    await db.runTransaction(async (t) => {
      const u = (await t.get(userRef)).data();
      t.update(userRef, {
        balance: (u.balance || 0) + promo.reward,
        total_promo_earned: (u.total_promo_earned || 0) + promo.reward
      });
      t.update(promoRef, {
        usedCount: (promo.usedCount || 0) + 1,
        usedBy: [...(promo.usedBy || []), userId]
      });
    });
    res.json({ success: true, reward: promo.reward, code: promo.code });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function getPromoEarnings(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const u = (await db.collection('users').doc(String(req.user.userId)).get()).data();
    res.json({ totalPromoEarned: u.total_promo_earned || 0, balance: u.balance || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ============================================
// STATS ENDPOINTS
// ============================================
async function getStats(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const userId = String(req.user.userId);
    const u = (await db.collection('users').doc(userId).get()).data();
    const today = new Date().toISOString().split('T')[0];
    const month = new Date().toISOString().slice(0, 7);
    const daily = {
      faucet: u['daily_' + today + '_faucet'] || 0,
      offerwall: u['daily_' + today + '_offerwall'] || 0,
      referral: u['daily_' + today + '_referral'] || 0,
      total: 0
    };
    daily.total = daily.faucet + daily.offerwall + daily.referral;
    const monthly = {
      faucet: u['monthly_' + month + '_faucet'] || 0,
      offerwall: u['monthly_' + month + '_offerwall'] || 0,
      referral: u['monthly_' + month + '_referral'] || 0,
      total: 0
    };
    monthly.total = monthly.faucet + monthly.offerwall + monthly.referral;
    const lifetime = {
      faucet: u.total_faucet_claimed || 0,
      offerwall: u.total_offerwall_earned || 0,
      referral: u.total_referral_earned || 0,
      total: 0
    };
    lifetime.total = lifetime.faucet + lifetime.offerwall + lifetime.referral;
    res.json({ daily, monthly, lifetime });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ============================================
// REFERRAL STATS
// ============================================
async function getReferralStats(req, res) {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const userId = String(req.user.userId);
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const userData = userDoc.data();
    const totalEarned = userData.total_referral_earned || 0;
    const faucetBonus = userData.referral_bonus_faucet || 0;
    const ptcBonus = userData.referral_bonus_ptc || 0;
    const shortlinkBonus = userData.referral_bonus_shortlink || 0;
    const offerwallBonus = userData.referral_bonus_offerwall || 0;
    const gameBonus = userData.referral_bonus_game || 0;
    const referralCount = userData.referrals || 0;

    const referralsSnap = await db.collection('referrals').where('referrer_id', '==', userId).orderBy('timestamp', 'desc').limit(50).get();
    const referrals = referralsSnap.docs.map(d => ({
      ...d.data(),
      timestamp: d.data().timestamp?.toMillis()
    }));

    res.json({
      totalEarned,
      referral_balance: userData.referral_balance || 0,
      breakdown: {
        faucet: faucetBonus,
        ptc: ptcBonus,
        shortlink: shortlinkBonus,
        offerwall: offerwallBonus,
        game: gameBonus
      },
      referralCount,
      referrals
    });
  } catch (e) {
    logger.error('Referral stats error', { error: e.message });
    res.status(500).json({ error: 'Failed to get referral stats' });
  }
}

// ============================================
// EXPRESS APP
// ============================================
const app = express();

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled Rejection', { error: err.message, stack: err.stack });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
});

setupSecurity(app);
app.use(cors({ origin: true, credentials: true }));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

if (process.env.NODE_ENV !== 'production') {
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    maxAge: '1d',
    setHeaders: (res, path) => {
      if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }));
}

// ============================================
// ROUTES
// ============================================
app.get('/ping', (req, res) => res.status(200).send('OK'));
app.post('/api/auth', authLimiter, auth);
app.use('/api', generalLimiter);

// Captcha
app.get('/api/captcha', jwtAuth, getCaptcha);
app.post('/api/captcha/verify', jwtAuth, verifyCaptchaEndpoint);

// User
app.get('/api/me', jwtAuth, getMe);
app.get('/api/balance', jwtAuth, getBalance);
app.post('/api/claim', claimLimiter, jwtAuth, claim);
app.post('/api/swap', jwtAuth, swap);
app.post('/api/withdraw', withdrawLimiter, jwtAuth, withdraw);
app.get('/api/withdrawals', jwtAuth, getWithdrawHistory);
app.get('/api/withdrawals/recent', getRecentWithdrawals);
app.get('/api/withdrawals/stats', jwtAuth, getWithdrawStats);
app.get('/api/referral', jwtAuth, getReferral);
app.post('/api/referral/collect', jwtAuth, collectReferralBonus);
app.get('/api/referral/stats', jwtAuth, getReferralStats);

// Price
app.get('/api/doge-price', getDogePrice);

// Offerwall.me
app.get('/api/offerwall/offerwall', jwtAuth, getOfferwallUrl);
app.get('/api/offerwall/ptc', jwtAuth, getPTCAds);
app.get('/api/offerwall/shortlinks', jwtAuth, getShortlinks);
app.get('/api/offerwall/games', jwtAuth, getGames);
app.get('/api/offerwall/stats', jwtAuth, getOfferwallStats);

// Postback
app.post('/api/postback', postback);
app.post('/api/offerwall-postback', postback);

// Stats
app.get('/api/stats', jwtAuth, getStats);
app.get('/api/stats/global', getGlobalStats);
app.get('/api/stats/user/:userId', jwtAuth, getUserStats);

// Promo
app.post('/api/admin/promo', jwtAuth, verifyAdmin, createPromo);
app.get('/api/admin/promos', jwtAuth, verifyAdmin, getPromos);
app.delete('/api/admin/promo/:code', jwtAuth, verifyAdmin, deletePromo);
app.post('/api/promo/redeem', jwtAuth, redeemPromo);
app.get('/api/promo/earnings', jwtAuth, getPromoEarnings);

// Admin
app.get('/api/admin/users', adminAuth, getUsers);
app.get('/api/admin/withdrawals', adminAuth, getAdminWithdrawals);
app.post('/api/admin/approve-withdrawal', adminAuth, approveWithdrawal);
app.post('/api/admin/add-balance', adminAuth, addBalance);
app.post('/api/admin/ban-user', adminAuth, banUser);
app.post('/api/admin/unban-user', adminAuth, unbanUser);
app.post('/api/admin/delete-user', adminAuth, deleteUser);
app.get('/api/admin/logs', adminAuth, getLogs);
app.get('/api/admin/settings', adminAuth, getSettings);
app.post('/api/admin/settings', adminAuth, updateSettings);
app.post('/api/admin/broadcast', adminAuth, broadcast);
app.get('/api/admin/stats', adminAuth, getAdminStats);

// SPA Fallback
app.get('/api/*', (req, res, next) => { next(); });
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Express error', { error: err.message, path: req.path, method: req.method });
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

module.exports = app;

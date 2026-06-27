require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const compression = require('compression');
const https = require('https');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const admin = require('firebase-admin');

// ============================================
// FIREBASE
// ============================================
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp();
const increment = (n) => admin.firestore.FieldValue.increment(n);

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
const JWT_SECRET = process.env.JWT_SECRET || 'b}$8h7w)BKeC7jwQ+bhVB%ZElD)*jK@=$4W%9S,s4%a7Njv.YeG$pTfzh:2?1D4j';
const ADMIN_SECRET = process.env.ADMIN_ID;
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY;
const OFFERWALL_APP_ID = process.env.OFFERWALL_APP_ID;
const OFFERWALL_SECRET = process.env.OFFERWALL_SECRET_KEY;
const APP_URL = process.env.APP_URL || 'https://yourdomain.com';
const PORT = process.env.PORT || 3000;

// ============================================
// SECURITY (Helmet) - TYPO FIXED
// ============================================
function setupSecurity(app) {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'", "https://offerwall.me", "https://*.offerwall.me", "https://telegram.org"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://offerwall.me", "https://telegram.org", "https://translate.googleapis.com", "https://translate.google.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://translate.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:", "https:", "blob:", "https://www.gstatic.com"],
        connectSrc: ["'self'", "https://*.googleapis.com", "https://*.firebaseio.com"],
        frameSrc: ["'self'", "https://offerwall.me", "https://*.offerwall.me", "https://translate.google.com"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
  }));
}

// ============================================
// RATE LIMITERS (Mevcut — dokunulmadı)
// ============================================
const generalLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true, legacyHeaders: false,
});
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 10,
  message: { error: 'Too many auth attempts, please try again later.' },
  standardHeaders: true, legacyHeaders: false,
});
const claimLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  message: { error: 'Too many claims, please slow down.' },
  standardHeaders: true, legacyHeaders: false,
});
const withdrawLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10,
  message: { error: 'Too many withdrawal requests.' },
  standardHeaders: true, legacyHeaders: false,
});

// ============================================
// AUTH MIDDLEWARE (Mevcut — dokunulmadı)
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

// ============================================
// UTILS (Mevcut)
// ============================================
async function logAction(action, userId, details = {}) {
  try {
    await db.collection('logs').add({
      action, user_id: userId || null, details,
      ip: details.ip || null, timestamp: serverTimestamp()
    });
  } catch (e) { logger.error('Log error', { error: e.message }); }
}

// ============================================
// CONTROLLERS - AUTH (MEVCUT — DOKUNULMADI)
// ============================================
async function auth(req, res) {
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
    if (!doc.exists) {
      const newUser = {
        telegram_id: userId, username: user.username || null,
        first_name: user.first_name || null, last_name: user.last_name || null,
        photo_url: user.photo_url || null, balance: 0, doge_balance: 0,
        total_earned: 0, total_doge_earned: 0, total_ptc_earnings: 0,
        total_claims: 0, total_withdrawals: 0, referrals: 0,
        referral_earnings: 0, referred_by: ref || null, banned: false,
        last_claim: null, created_at: serverTimestamp()
      };
      await userRef.set(newUser);
      if (ref && ref !== userId) {
        const refRef = db.collection('users').doc(String(ref));
        const refDoc = await refRef.get();
        if (refDoc.exists && !refDoc.data().banned) {
          await refRef.update({ referrals: increment(1), balance: increment(50), referral_earnings: increment(50) });
          await db.collection('referrals').add({ referrer_id: String(ref), referred_id: userId, bonus: 50, currency: 'CNX', timestamp: serverTimestamp() });
          await logAction('referral_bonus', String(ref), { referred_id: userId, bonus: 50, currency: 'CNX' });
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
    res.json({ success: true, user_id: userId, username: user.username, token });
  } catch (err) {
    logger.error('Auth error', { error: err.message });
    res.status(500).json({ error: 'Auth failed' });
  }
}

async function getMe(req, res) {
  try {
    const doc = await db.collection('users').doc(String(req.user.userId)).get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });
    const d = doc.data();
    res.json({
      telegram_id: d.telegram_id, username: d.username, first_name: d.first_name,
      photo_url: d.photo_url, balance: d.balance || 0, doge_balance: d.doge_balance || 0,
      total_earned: d.total_earned || 0, total_claims: d.total_claims || 0,
      total_withdrawals: d.total_withdrawals || 0, referrals: d.referrals || 0,
      referral_earnings: d.referral_earnings || 0,
      total_ptc_earnings: d.total_ptc_earnings || 0,
      last_claim: d.last_claim ? d.last_claim.toMillis() : null, banned: d.banned || false
    });
  } catch (err) { logger.error('GetMe error', { error: err.message }); res.status(500).json({ error: 'Server error' }); }
}

async function getBalance(req, res) {
  try {
    const doc = await db.collection('users').doc(String(req.user.userId)).get();
    if (!doc.exists) return res.json({ balance: 0, doge_balance: 0, total_earned: 0, total_doge_earned: 0, total_claims: 0, total_withdrawals: 0, referrals: 0, referral_earnings: 0, total_ptc_earnings: 0, last_claim: null });
    const d = doc.data();
    res.json({
      balance: d.balance || 0, doge_balance: d.doge_balance || 0,
      total_earned: d.total_earned || 0, total_doge_earned: d.total_doge_earned || 0,
      total_claims: d.total_claims || 0, total_withdrawals: d.total_withdrawals || 0,
      referrals: d.referrals || 0, referral_earnings: d.referral_earnings || 0,
      total_ptc_earnings: d.total_ptc_earnings || 0,
      last_claim: d.last_claim ? d.last_claim.toMillis() : null
    });
  } catch (err) { logger.error('Balance error', { error: err.message }); res.status(500).json({ error: 'Server error' }); }
}

async function getReferral(req, res) {
  try {
    const userId = String(req.user.userId);
    const doc = await db.collection('users').doc(userId).get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });
    const d = doc.data();
    const link = `https://t.me/${BOT_USERNAME}?startapp=ref_${userId}`;
    res.json({ link, referrals: d.referrals || 0, earnings: d.referral_earnings || 0 });
  } catch (err) { logger.error('Referral error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

// ============================================
// CONTROLLERS - FAUCET (MEVCUT — DOKUNULMADI)
// ============================================
async function claim(req, res) {
  const userId = String(req.user.userId);
  const userRef = db.collection('users').doc(userId);
  try {
    const doc = await userRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });
    const d = doc.data();
    if (d.banned) return res.status(403).json({ error: 'User banned' });
    const now = Date.now();
    const lastClaim = d.last_claim ? d.last_claim.toMillis() : 0;
    const cooldown = 10000;
    if (now - lastClaim < cooldown) return res.status(429).json({ error: 'Cooldown active', wait: cooldown - (now - lastClaim) });
    const amount = 0.5;
    await userRef.update({ balance: increment(amount), total_earned: increment(amount), total_claims: increment(1), last_claim: serverTimestamp() });
    res.json({ success: true, amount, balance: (d.balance || 0) + amount });
  } catch (err) { logger.error('Claim error', { error: err.message, userId }); res.status(500).json({ error: 'Claim failed' }); }
}

// ============================================
// CONTROLLERS - SWAP (MEVCUT — DOKUNULMADI)
// ============================================
async function swap(req, res) {
  const userId = String(req.user.userId);
  const { amount, direction } = req.body;
  const amt = Number(amount);
  if (!amt || amt <= 0 || isNaN(amt)) return res.status(400).json({ error: 'Invalid amount' });
  if (!direction || !['cnx-to-doge', 'doge-to-cnx'].includes(direction)) return res.status(400).json({ error: 'Invalid direction' });
  const userRef = db.collection('users').doc(userId);
  try {
    const doc = await userRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });
    const d = doc.data();
    if (d.banned) return res.status(403).json({ error: 'User banned' });
    if (direction === 'cnx-to-doge') {
      if ((d.balance || 0) < amt) return res.status(400).json({ error: 'Insufficient CNX' });
      await userRef.update({ balance: increment(-amt), doge_balance: increment(amt) });
    } else {
      if ((d.doge_balance || 0) < amt) return res.status(400).json({ error: 'Insufficient DOGE' });
      await userRef.update({ doge_balance: increment(-amt), balance: increment(amt) });
    }
    await db.collection('swaps').add({ user_id: userId, amount: amt, direction, timestamp: serverTimestamp() });
    res.json({ success: true, message: 'Swap completed' });
  } catch (err) { logger.error('Swap error', { error: err.message, userId }); res.status(500).json({ error: 'Swap failed' }); }
}

// ============================================
// CONTROLLERS - WITHDRAW (MEVCUT — DOKUNULMADI)
// ============================================
async function withdraw(req, res) {
  const userId = String(req.user.userId);
  const { faucetpay_email, amount } = req.body;
  const amt = Number(amount);
  if (!amt || amt <= 0 || isNaN(amt)) return res.status(400).json({ error: 'Invalid amount' });
  if (!faucetpay_email || !faucetpay_email.includes('@')) return res.status(400).json({ error: 'Invalid email' });
  const userRef = db.collection('users').doc(userId);
  try {
    const doc = await userRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });
    const d = doc.data();
    if (d.banned) return res.status(403).json({ error: 'User banned' });
    if ((d.doge_balance || 0) < amt) return res.status(400).json({ error: 'Insufficient DOGE' });
    if (amt < 0.1) return res.status(400).json({ error: 'Minimum 0.10 DOGE' });
    await userRef.update({ doge_balance: increment(-amt), total_withdrawals: increment(1) });
    await db.collection('withdrawals').add({ user_id: userId, faucetpay_email, amount: amt, status: 'pending', timestamp: serverTimestamp() });
    res.json({ success: true, message: 'Withdrawal submitted' });
  } catch (err) { logger.error('Withdraw error', { error: err.message, userId }); res.status(500).json({ error: 'Withdrawal failed' }); }
}

async function getWithdrawHistory(req, res) {
  try {
    const userId = String(req.user.userId);
    const snapshot = await db.collection('withdrawals').where('user_id', '==', userId).orderBy('timestamp', 'desc').limit(50).get();
    res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() })));
  } catch (err) { logger.error('Withdraw history error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function getRecentWithdrawals(req, res) {
  try {
    const snapshot = await db.collection('withdrawals').orderBy('timestamp', 'desc').limit(25).get();
    res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() })));
  } catch (err) { logger.error('Recent withdrawals error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function getWithdrawStats(req, res) {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const snapshot = await db.collection('withdrawals').where('timestamp', '>=', admin.firestore.Timestamp.fromDate(today)).get();
    const total = snapshot.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
    const allSnap = await db.collection('withdrawals').get();
    const allTime = allSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
    res.json({ today: total, allTime });
  } catch (err) { logger.error('Withdraw stats error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

// ============================================
// CONTROLLERS - OFFERWALL (UPGRADED — Offerwall.me Official)
// ============================================
async function getOfferwallUrl(req, res) {
  const userId = String(req.user.userId);
  const subId = Buffer.from(userId).toString('base64');
  const url = `https://offerwall.me/offerwall/${OFFERWALL_APP_ID}?subid=${subId}`;
  res.json({ url, user_id: userId, app_id: OFFERWALL_APP_ID });
}

// Kullanıcının offerwall istatistikleri
async function getOfferwallStats(req, res) {
  try {
    const userId = String(req.user.userId);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    
    // Bugünkü kazanç
    const todaySnap = await db.collection('offerwall_completions')
      .where('user_id', '==', userId)
      .where('status', '==', 'completed')
      .where('timestamp', '>=', admin.firestore.Timestamp.fromDate(today))
      .get();
    const todayEarnings = todaySnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
    const todayCount = todaySnap.size;
    
    // Toplam
    const allSnap = await db.collection('offerwall_completions')
      .where('user_id', '==', userId)
      .where('status', '==', 'completed')
      .get();
    const totalEarnings = allSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
    const totalCount = allSnap.size;
    
    // Chargeback sayısı
    const chargebackSnap = await db.collection('offerwall_completions')
      .where('user_id', '==', userId)
      .where('status', '==', 'chargeback')
      .get();
    
    const successRate = totalCount + chargebackSnap.size > 0
      ? Math.round((totalCount / (totalCount + chargebackSnap.size)) * 100)
      : 100;
    
    res.json({
      today_earnings: todayEarnings,
      today_count: todayCount,
      total_earnings: totalEarnings,
      total_count: totalCount,
      chargeback_count: chargebackSnap.size,
      success_rate: successRate
    });
  } catch (err) {
    logger.error('Offerwall stats error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

// ============================================
// 🚀 UPGRADED POSTBACK — Offerwall.me Official S2S
// ============================================
async function postback(req, res) {
  try {
    // Query string veya body'den parametreleri al (Offerwall GET veya POST gönderebilir)
    const params = { ...req.query, ...req.body };
    const {
      subid, subId,
      transid, transId,
      reward,
      signature,
      status,
      offer_name, offerName,
      offer_type, offerType,
      reward_name, rewardName,
      reward_value, rewardValue,
      payout,
      userIp, user_ip, ip,
      country,
      currency,
      debug
    } = params;
    
    // Normalize
    const finalSubId = subid || subId;
    const finalTransId = transid || transId;
    const finalReward = reward;
    const finalOfferName = offer_name || offerName || 'Unknown';
    const finalOfferType = offer_type || offerType || 'unknown';
    const finalRewardName = reward_name || rewardName || finalOfferName;
    const finalRewardValue = reward_value || rewardValue || finalReward;
    const finalPayout = payout || 0;
    const finalUserIp = userIp || user_ip || ip || req.ip || 'unknown';
    const finalCountry = country || 'unknown';
    const finalCurrency = currency || 'CNX';
    const finalStatus = status || '1';
    const finalDebug = debug || false;
    
    // Debug modunda log
    if (finalDebug) {
      logger.debug('Offerwall debug postback', { params });
    }
    
    // Zorunlu parametreler kontrolü
    if (!finalSubId || !finalTransId || finalReward === undefined || !signature) {
      logger.warn('Offerwall postback missing params', { params });
      return res.status(400).send('missing params');
    }
    
    // ✅ OFFICIAL SIGNATURE VALIDATION
    // MD5(subId + transId + reward + SECRET_KEY)
    const expected = crypto.createHash('md5')
      .update(`${finalSubId}${finalTransId}${finalReward}${OFFERWALL_SECRET}`)
      .digest('hex');
    
    if (signature !== expected) {
      logger.warn('Offerwall invalid signature', {
        subId: finalSubId, transId: finalTransId,
        received: signature, expected
      });
      await logAction('offerwall_invalid_signature', null, {
        subId: finalSubId, transId: finalTransId,
        received_sig: signature, expected_sig: expected,
        ip: finalUserIp
      });
      return res.status(403).send('invalid signature');
    }
    
    // User ID decode (base64)
    let userId;
    try {
      userId = Buffer.from(finalSubId, 'base64').toString('ascii');
      if (!userId) throw new Error('empty');
    } catch (e) {
      logger.warn('Offerwall invalid subid', { subId: finalSubId });
      return res.status(400).send('invalid subid');
    }
    
    // User kontrolü
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      logger.warn('Offerwall user not found', { userId });
      return res.status(404).send('user not found');
    }
    if (userDoc.data().banned) {
      logger.warn('Offerwall banned user', { userId });
      return res.status(403).send('banned');
    }
    
    // ✅ DUPLICATE PROTECTION — transId ile kontrol
    const transRef = db.collection('offerwall_completions').doc(finalTransId);
    const transDoc = await transRef.get();
    
    if (transDoc.exists) {
      // Zaten işlenmiş — Offerwall'a OK dön (retry yapmasın)
      logger.info('Offerwall duplicate transaction', { transId: finalTransId });
      return res.status(200).send('OK');
    }
    
    const amt = Number(finalReward);
    if (isNaN(amt)) {
      logger.warn('Offerwall invalid reward', { reward: finalReward });
      return res.status(400).send('invalid reward');
    }
    
    // ✅ ATOMIC TRANSACTION — status handling
    try {
      await db.runTransaction(async (t) => {
        const freshUserDoc = await t.get(userRef);
        if (!freshUserDoc.exists) throw new Error('User not found');
        
        const userData = freshUserDoc.data();
        const currentBalance = userData.balance || 0;
        const currentPtc = userData.total_ptc_earnings || 0;
        const currentTotal = userData.total_earned || 0;
        
        let statusStr = 'completed';
        
        if (finalStatus === '1' || finalStatus === 1 || finalStatus === 'credit' || !finalStatus) {
          // ✅ CREDIT
          if (amt <= 0) throw new Error('Invalid reward amount');
          
          t.update(userRef, {
            balance: increment(amt),
            total_earned: increment(amt),
            total_ptc_earnings: increment(amt)
          });
          
          statusStr = 'completed';
          logger.info('Offerwall credit', { userId, transId: finalTransId, amt, offer: finalOfferName });
          
        } else if (finalStatus === '2' || finalStatus === 2 || finalStatus === 'chargeback' || finalStatus === 'debit') {
          // ✅ CHARGEBACK
          const deductAmt = Math.abs(amt);
          
          // Negatif bakiyeye izin verme
          const actualDeduct = Math.min(deductAmt, currentBalance);
          
          if (actualDeduct > 0) {
            t.update(userRef, {
              balance: increment(-actualDeduct),
              total_earned: increment(-actualDeduct),
              total_ptc_earnings: increment(-actualDeduct)
            });
          }
          
          statusStr = 'chargeback';
          logger.warn('Offerwall chargeback', { userId, transId: finalTransId, amt: actualDeduct, offer: finalOfferName });
          
        } else {
          // Diğer status'lar için log
          statusStr = 'unknown_' + finalStatus;
          logger.warn('Offerwall unknown status', { status: finalStatus, transId: finalTransId });
        }
        
        // ✅ TRANSACTION KAYDI (transId ile — unique key)
        t.set(transRef, {
          user_id: userId,
          trans_id: finalTransId,
          amount: amt,
          offer_name: String(finalOfferName).substring(0, 200),
          offer_type: String(finalOfferType).substring(0, 50),
          reward_name: String(finalRewardName).substring(0, 200),
          reward_value: Number(finalRewardValue) || amt,
          payout_usd: Number(finalPayout) || 0,
          currency: finalCurrency,
          country: String(finalCountry).substring(0, 10),
          user_ip: String(finalUserIp).substring(0, 45),
          status: statusStr,
          source: 'offerwall.me',
          debug: finalDebug ? true : false,
          signature_verified: true,
          timestamp: serverTimestamp()
        });
      });
      
      // Log action
      await logAction('offerwall_transaction', userId, {
        trans_id: finalTransId,
        amount: amt,
        offer_name: finalOfferName,
        status: finalStatus,
        country: finalCountry
      });
      
      return res.status(200).send('OK');
      
    } catch (txErr) {
      logger.error('Offerwall transaction error', { error: txErr.message, transId: finalTransId });
      return res.status(500).send('transaction error');
    }
    
  } catch (err) {
    logger.error('Offerwall postback error', { error: err.message, stack: err.stack });
    return res.status(500).send('error');
  }
}

// Legacy custom postback (mevcut — dokunulmadı)
async function offerwallPostback(req, res) {
  try {
    const { user_id, amount, signature } = req.body;
    if (!user_id || !amount || !signature) return res.status(400).send('missing');
    const expected = crypto.createHash('md5').update(`${user_id}.${amount}.${ADMIN_SECRET_KEY}`).digest('hex');
    if (signature !== expected) return res.status(403).send('invalid');
    const userRef = db.collection('users').doc(String(user_id));
    const doc = await userRef.get();
    if (!doc.exists) return res.status(404).send('not found');
    if (doc.data().banned) return res.status(403).send('banned');
    const amt = Number(amount);
    await userRef.update({ balance: increment(amt), total_earned: increment(amt), total_ptc_earnings: increment(amt) });
    res.send('ok');
  } catch (err) { logger.error('Custom postback error', { error: err.message }); res.status(500).send('error'); }
}

// Legacy PTC/Shortlinks endpoints (mevcut — dokunulmadı)
async function getPTCAds(req, res) { res.json({ message: 'PTC ads loaded', userId: req.user.userId }); }
async function getShortlinks(req, res) { res.json({ message: 'Shortlinks loaded', userId: req.user.userId }); }

// ============================================
// CONTROLLERS - STATS (Mevcut — dokunulmadı)
// ============================================
async function getGlobalStats(req, res) {
  try {
    const usersSnap = await db.collection('users').get();
    const totalUsers = usersSnap.size;
    const activeToday = usersSnap.docs.filter(d => { const lc = d.data().last_claim; return lc && (Date.now() - lc.toMillis() < 86400000); }).length;
    const wdSnap = await db.collection('withdrawals').get();
    const totalPaid = wdSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
    res.json({ totalUsers, activeToday, totalPaid });
  } catch (err) { logger.error('Global stats error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function getUserStats(req, res) {
  try {
    const userId = String(req.params.userId);
    if (req.user.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
    const doc = await db.collection('users').doc(userId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    const d = doc.data();
    res.json({ balance: d.balance || 0, doge_balance: d.doge_balance || 0, total_earned: d.total_earned || 0, total_claims: d.total_claims || 0, total_withdrawals: d.total_withdrawals || 0, referrals: d.referrals || 0 });
  } catch (err) { logger.error('User stats error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function getUserCharts(req, res) {
  try {
    const userId = String(req.params.userId);
    if (req.user.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
    const snap = await db.collection('withdrawals').where('user_id', '==', userId).orderBy('timestamp', 'desc').limit(30).get();
    res.json(snap.docs.map(d => ({ amount: d.data().amount || 0, date: d.data().timestamp?.toDate().toISOString().split('T')[0] })));
  } catch (err) { logger.error('User charts error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function getAdminCharts(req, res) {
  try {
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 86400000);
    const snap = await db.collection('withdrawals').where('timestamp', '>=', admin.firestore.Timestamp.fromDate(since)).get();
    const daily = {};
    snap.docs.forEach(d => { const date = d.data().timestamp?.toDate().toISOString().split('T')[0]; if (date) daily[date] = (daily[date] || 0) + (d.data().amount || 0); });
    res.json(daily);
  } catch (err) { logger.error('Admin charts error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

// ============================================
// CONTROLLERS - ADMIN (Mevcut)
// ============================================
async function getUsers(req, res) {
  try {
    const snap = await db.collection('users').orderBy('created_at', 'desc').limit(100).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data(), created_at: d.data().created_at?.toMillis() })));
  } catch (err) { logger.error('Admin users error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function getAdminWithdrawals(req, res) {
  try {
    const snap = await db.collection('withdrawals').orderBy('timestamp', 'desc').limit(100).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() })));
  } catch (err) { logger.error('Admin withdrawals error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function approveWithdrawal(req, res) {
  try { await db.collection('withdrawals').doc(req.body.id).update({ status: 'approved', approved_at: serverTimestamp() }); res.json({ success: true }); }
  catch (err) { logger.error('Approve error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function addBalance(req, res) {
  try {
    const { userId, amount, currency } = req.body;
    const field = currency === 'doge' ? 'doge_balance' : 'balance';
    await db.collection('users').doc(String(userId)).update({ [field]: increment(Number(amount)) });
    res.json({ success: true });
  } catch (err) { logger.error('Add balance error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function banUser(req, res) {
  try { await db.collection('users').doc(String(req.body.userId)).update({ banned: true }); res.json({ success: true }); }
  catch (err) { logger.error('Ban error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function deleteUser(req, res) {
  try { await db.collection('users').doc(String(req.body.userId)).delete(); res.json({ success: true }); }
  catch (err) { logger.error('Delete error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function getLogs(req, res) {
  try {
    const snap = await db.collection('logs').orderBy('timestamp', 'desc').limit(100).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() })));
  } catch (err) { logger.error('Logs error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function getSettings(req, res) {
  try { const doc = await db.collection('settings').doc('global').get(); res.json(doc.exists ? doc.data() : {}); }
  catch (err) { logger.error('Settings get error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function updateSettings(req, res) {
  try { await db.collection('settings').doc('global').set(req.body, { merge: true }); res.json({ success: true }); }
  catch (err) { logger.error('Settings update error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function broadcast(req, res) {
  try { await db.collection('broadcasts').add({ message: req.body.message, timestamp: serverTimestamp() }); res.json({ success: true }); }
  catch (err) { logger.error('Broadcast error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

// ============================================
// 🚀 YENİ — ADMIN OFFERWALL ENDPOINTS
// ============================================
async function adminGetOfferwallTransactions(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const status = req.query.status; // completed, chargeback, all
    const search = req.query.search;
    
    let query = db.collection('offerwall_completions').orderBy('timestamp', 'desc').limit(limit);
    
    if (status && status !== 'all') {
      query = db.collection('offerwall_completions').where('status', '==', status).orderBy('timestamp', 'desc').limit(limit);
    }
    
    const snap = await query.get();
    let transactions = snap.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() }));
    
    // Client-side search (Firestore composite index gerekmesin)
    if (search) {
      const q = search.toLowerCase();
      transactions = transactions.filter(t =>
        (t.user_id && t.user_id.toLowerCase().includes(q)) ||
        (t.offer_name && t.offer_name.toLowerCase().includes(q)) ||
        (t.trans_id && t.trans_id.toLowerCase().includes(q)) ||
        (t.country && t.country.toLowerCase().includes(q))
      );
    }
    
    res.json(transactions);
  } catch (err) {
    logger.error('Admin offerwall list error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function adminGetOfferwallStats(req, res) {
  try {
    // Tüm transactions
    const allSnap = await db.collection('offerwall_completions').get();
    
    let totalRewards = 0;
    let totalPayout = 0;
    let completedCount = 0;
    let chargebackCount = 0;
    let pendingCount = 0;
    const offerMap = {};
    const countryMap = {};
    
    allSnap.docs.forEach(doc => {
      const d = doc.data();
      const status = d.status || 'completed';
      const amt = d.amount || 0;
      
      if (status === 'completed') {
        completedCount++;
        totalRewards += amt;
        totalPayout += (d.payout_usd || 0);
        
        // Top offers
        const offerName = d.offer_name || 'Unknown';
        offerMap[offerName] = (offerMap[offerName] || 0) + 1;
        
        // Top countries
        const country = d.country || 'Unknown';
        countryMap[country] = (countryMap[country] || 0) + 1;
      } else if (status === 'chargeback') {
        chargebackCount++;
      } else {
        pendingCount++;
      }
    });
    
    // Top 10 offers
    const topOffers = Object.entries(offerMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));
    
    // Top 10 countries
    const topCountries = Object.entries(countryMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));
    
    // Bugünkü kazanç
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todaySnap = await db.collection('offerwall_completions')
      .where('status', '==', 'completed')
      .where('timestamp', '>=', admin.firestore.Timestamp.fromDate(today))
      .get();
    const todayRewards = todaySnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
    const todayCount = todaySnap.size;
    
    res.json({
      total_transactions: allSnap.size,
      completed_count: completedCount,
      chargeback_count: chargebackCount,
      pending_count: pendingCount,
      total_rewards: totalRewards,
      total_payout_usd: totalPayout,
      today_rewards: todayRewards,
      today_count: todayCount,
      success_rate: allSnap.size > 0 ? Math.round((completedCount / allSnap.size) * 100) : 0,
      top_offers: topOffers,
      top_countries: topCountries
    });
  } catch (err) {
    logger.error('Admin offerwall stats error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function adminGetOfferwallDetail(req, res) {
  try {
    const transId = req.params.transId;
    const doc = await db.collection('offerwall_completions').doc(transId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    res.json({ id: doc.id, ...doc.data(), timestamp: doc.data().timestamp?.toMillis() });
  } catch (err) {
    logger.error('Admin offerwall detail error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

// ============================================
// EXPRESS APP
// ============================================
const app = express();
process.on('unhandledRejection', (err) => { logger.error('Unhandled Rejection', { error: err.message, stack: err.stack }); });
process.on('uncaughtException', (err) => { logger.error('Uncaught Exception', { error: err.message, stack: err.stack }); });

// Keep-alive
setInterval(() => {
  https.get(`${APP_URL}/ping`, (res) => { logger.debug('Keep-alive ping', { status: res.statusCode }); }).on('error', (err) => { logger.error('Keep-alive ping error', { error: err.message }); });
}, 600000);

setupSecurity(app);
app.use(cors({ origin: true, credentials: true }));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  setHeaders: (res, path) => { if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); }
}));

// ============================================
// ROUTES
// ============================================
app.get('/ping', (req, res) => res.status(200).send('OK'));

// Legacy postback URL (Offerwall.me bazen farklı URL isteyebilir)
app.post('/bitswall-postback.php', postback);
app.get('/bitswall-postback.php', postback);

// Auth
app.post('/api/auth', authLimiter, auth);
app.use('/api', generalLimiter);

// User endpoints (MEVCUT)
app.get('/api/me', jwtAuth, getMe);
app.get('/api/balance', jwtAuth, getBalance);
app.post('/api/claim', claimLimiter, jwtAuth, claim);
app.post('/api/withdraw', withdrawLimiter, jwtAuth, withdraw);
app.get('/api/withdrawals', jwtAuth, getWithdrawHistory);
app.get('/api/withdrawals/recent', getRecentWithdrawals);
app.get('/api/withdrawals/stats', jwtAuth, getWithdrawStats);
app.post('/api/swap', jwtAuth, swap);
app.get('/api/referral', jwtAuth, getReferral);

// Offerwall endpoints (UPGRADED)
app.get('/api/offerwall/offerwall', jwtAuth, getOfferwallUrl);
app.get('/api/offerwall/stats', jwtAuth, getOfferwallStats);
app.get('/api/offerwall/ptc', jwtAuth, getPTCAds);
app.get('/api/offerwall/shortlinks', jwtAuth, getShortlinks);

// 🚀 OFFICIAL OFFERWALL.ME S2S POSTBACK
app.post('/api/postback', postback);
app.get('/api/postback', postback);
app.post('/api/offerwall-postback', offerwallPostback);

// Stats
app.get('/api/stats', adminAuth, getGlobalStats);
app.get('/api/stats/user/:userId', jwtAuth, getUserStats);
app.get('/api/stats/user/:userId/charts', jwtAuth, getUserCharts);
app.get('/api/admin/charts', adminAuth, getAdminCharts);

// Admin (MEVCUT)
app.get('/api/admin/users', adminAuth, getUsers);
app.get('/api/admin/withdrawals', adminAuth, getAdminWithdrawals);
app.post('/api/admin/approve-withdrawal', adminAuth, approveWithdrawal);
app.post('/api/admin/add-balance', adminAuth, addBalance);
app.post('/api/admin/ban-user', adminAuth, banUser);
app.post('/api/admin/delete-user', adminAuth, deleteUser);
app.get('/api/admin/logs', adminAuth, getLogs);
app.get('/api/admin/settings', adminAuth, getSettings);
app.post('/api/admin/settings', adminAuth, updateSettings);
app.post('/api/admin/broadcast', adminAuth, broadcast);

// 🚀 YENİ — Admin Offerwall endpoints
app.get('/api/admin/offerwall', adminAuth, adminGetOfferwallTransactions);
app.get('/api/admin/offerwall/stats', adminAuth, adminGetOfferwallStats);
app.get('/api/admin/offerwall/:transId', adminAuth, adminGetOfferwallDetail);

// SPA Fallback
const spaPages = ['/', '/dashboard', '/faucet', '/ptc', '/withdraw', '/swap', '/history', '/admin', '/offerwall'];
spaPages.forEach(route => {
  app.get(route, (req, res) => {
    if (route === '/admin') {
      const key = req.query.admin_key;
      if (!ADMIN_SECRET || key !== ADMIN_SECRET) return res.status(403).send('Forbidden');
    }
    const file = route === '/' ? 'index.html' : route.replace('/', '') + '.html';
    res.sendFile(path.join(__dirname, 'public', file));
  });
});
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, path: req.path, method: req.method });
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  logger.info('COINIX FAUCET v3.0.0 running', { port: PORT, env: process.env.NODE_ENV || 'development', url: APP_URL });
});

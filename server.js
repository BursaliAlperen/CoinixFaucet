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
// FIREBASE - Uses serviceAccountKey.json
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
// SECURITY MIDDLEWARE
// ============================================
function setupSecurity(app) {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'", "https://offerwall.me", "https://*.offerwall.me"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdn.gtranslate.net", "https://offerwall.me", "https://telegram.org", "https://translate.google.com", "https://*.googleapis.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.gtranslate.net"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdn.gtranslate.net"],
        imgSrc: ["'self'", "data:", "https:", "blob:"],
        connectSrc: ["'self'", "https://*.googleapis.com", "https://*.firebaseio.com", "https://cdn.gtranslate.net", "https://translate.google.com"],
        frameSrc: ["'self'", "https://offerwall.me", "https://*.offerwall.me"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
  }));
}

// ============================================
// RATE LIMITERS
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
const messageLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5,
  message: { error: 'Too many messages, please slow down.' },
  standardHeaders: true, legacyHeaders: false,
});

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

// ============================================
// UTILS
// ============================================
function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[<>\"'&]/g, c => ({'<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;'}[c]));
}

async function logAction(action, userId, details = {}) {
  try {
    await db.collection('logs').add({
      action, user_id: userId || null, details,
      ip: details.ip || null, timestamp: serverTimestamp()
    });
  } catch (e) { logger.error('Log error', { error: e.message }); }
}

async function createNotification(userId, type, title, message, data = {}) {
  try {
    await db.collection('notifications').add({
      user_id: String(userId), type, title, message, data,
      read: false, timestamp: serverTimestamp()
    });
  } catch (e) { logger.error('Notification error', { error: e.message }); }
}

// ============================================
// AUTH CONTROLLERS
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
          await createNotification(ref, 'referral', 'New Referral!', `You earned +50 CNX from ${user.username || 'a friend'}`);
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
      referral_earnings: d.referral_earnings || 0, total_ptc_earnings: d.total_ptc_earnings || 0,
      last_claim: d.last_claim ? d.last_claim.toMillis() : null, banned: d.banned || false
    });
  } catch (err) { logger.error('GetMe error', { error: err.message }); res.status(500).json({ error: 'Server error' }); }
}

async function getBalance(req, res) {
  try {
    const doc = await db.collection('users').doc(String(req.user.userId)).get();
    if (!doc.exists) return res.json({ balance: 0, doge_balance: 0, total_earned: 0, total_doge_earned: 0, total_claims: 0, total_withdrawals: 0, referrals: 0, referral_earnings: 0, last_claim: null });
    const d = doc.data();
    res.json({ balance: d.balance || 0, doge_balance: d.doge_balance || 0, total_earned: d.total_earned || 0, total_doge_earned: d.total_doge_earned || 0, total_claims: d.total_claims || 0, total_withdrawals: d.total_withdrawals || 0, referrals: d.referrals || 0, referral_earnings: d.referral_earnings || 0, last_claim: d.last_claim ? d.last_claim.toMillis() : null });
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
// FAUCET CONTROLLER
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
    await db.collection('transactions').add({
      user_id: userId, type: 'faucet', amount, currency: 'CNX',
      status: 'completed', timestamp: serverTimestamp()
    });
    res.json({ success: true, amount, balance: (d.balance || 0) + amount });
  } catch (err) { logger.error('Claim error', { error: err.message, userId }); res.status(500).json({ error: 'Claim failed' }); }
}

// ============================================
// SWAP CONTROLLER
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
    await db.collection('transactions').add({
      user_id: userId, type: 'swap', amount: amt,
      currency: direction === 'cnx-to-doge' ? 'CNX→DOGE' : 'DOGE→CNX',
      status: 'completed', timestamp: serverTimestamp()
    });
    await db.collection('swaps').add({ user_id: userId, amount: amt, direction, timestamp: serverTimestamp() });
    res.json({ success: true, message: 'Swap completed' });
  } catch (err) { logger.error('Swap error', { error: err.message, userId }); res.status(500).json({ error: 'Swap failed' }); }
}

// ============================================
// WITHDRAW CONTROLLERS
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
    await db.collection('transactions').add({
      user_id: userId, type: 'withdraw', amount: amt, currency: 'DOGE',
      status: 'pending', details: { email: faucetpay_email }, timestamp: serverTimestamp()
    });
    await createNotification('admin', 'withdraw', 'New Withdrawal Request', `${d.username || userId} requested ${amt} DOGE to ${faucetpay_email}`);
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
// OFFERWALL CONTROLLERS
// ============================================
async function getOfferwallUrl(req, res) {
  const userId = String(req.user.userId);
  const subId = Buffer.from(userId).toString('base64');
  const url = `https://offerwall.me/offerwall/${OFFERWALL_APP_ID}?subid=${subId}`;
  res.json({ url });
}

async function getPTCAds(req, res) {
  res.json({ message: 'PTC ads loaded', userId: req.user.userId });
}

async function getShortlinks(req, res) {
  res.json({ message: 'Shortlinks loaded', userId: req.user.userId });
}

// Offerwall.me Postback - Production Ready
async function postback(req, res) {
  try {
    const { subid, transid, reward, reward_name, reward_value, payout, offer_name, offer_type, status, country, userIp, signature, debug } = req.body;
    
    if (!subid || !transid || !reward || !signature) {
      logger.warn('Offerwall postback missing params', { body: req.body });
      return res.status(400).send('missing params');
    }
    
    // Validate signature: MD5(subId + transId + reward + SECRET_KEY)
    const expected = crypto.createHash('md5').update(`${subid}${transid}${reward}${OFFERWALL_SECRET}`).digest('hex');
    if (signature !== expected) {
      logger.warn('Offerwall postback invalid signature', { transid, signature, expected });
      return res.status(403).send('invalid signature');
    }
    
    const userId = Buffer.from(subid, 'base64').toString('ascii');
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    
    if (!doc.exists) {
      logger.warn('Offerwall postback user not found', { userId, transid });
      return res.status(404).send('user not found');
    }
    
    if (doc.data().banned) {
      logger.warn('Offerwall postback banned user', { userId, transid });
      return res.status(403).send('banned');
    }
    
    // Check for duplicate transaction
    const existingTx = await db.collection('offerwall_completions')
      .where('trans_id', '==', transid)
      .limit(1)
      .get();
    
    if (!existingTx.empty) {
      logger.warn('Offerwall postback duplicate transaction', { transid, userId });
      return res.status(200).send('ok'); // Already processed
    }
    
    const amt = Number(reward);
    const statusNum = Number(status);
    
    // Use transaction for atomic update
    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      const userData = userDoc.data();
      
      if (statusNum === 1) {
        // Reward the user
        t.update(userRef, {
          balance: increment(amt),
          total_earned: increment(amt),
          total_ptc_earnings: increment(amt)
        });
      } else if (statusNum === 2) {
        // Chargeback - deduct from user
        const currentBal = userData.balance || 0;
        const deductAmt = Math.min(amt, currentBal);
        if (deductAmt > 0) {
          t.update(userRef, {
            balance: increment(-deductAmt),
            total_earned: increment(-deductAmt),
            total_ptc_earnings: increment(-deductAmt)
          });
        }
      }
      
      // Log transaction
      t.set(db.collection('offerwall_completions').doc(), {
        user_id: userId,
        trans_id: transid,
        amount: amt,
        reward_name: reward_name || null,
        reward_value: reward_value || null,
        payout: payout || null,
        offer_name: offer_name || null,
        offer_type: offer_type || null,
        status: statusNum,
        country: country || null,
        ip: userIp || req.ip,
        source: 'offerwall_native',
        timestamp: serverTimestamp()
      });
      
      // Log to general transactions
      t.set(db.collection('transactions').doc(), {
        user_id: userId,
        type: 'offerwall',
        amount: statusNum === 1 ? amt : -amt,
        currency: 'CNX',
        status: statusNum === 1 ? 'completed' : 'chargeback',
        details: { trans_id: transid, offer_name: offer_name || null },
        timestamp: serverTimestamp()
      });
    });
    
    // Notify user
    if (statusNum === 1) {
      await createNotification(userId, 'offerwall', 'Offer Completed!', `You earned +${amt} CNX from ${offer_name || 'an offer'}`);
    } else if (statusNum === 2) {
      await createNotification(userId, 'chargeback', 'Chargeback', `${amt} CNX was deducted for ${offer_name || 'an offer'}`);
    }
    
    await logAction('offerwall_postback', userId, { transid, amount: amt, status: statusNum, offer_name });
    
    if (debug) {
      logger.info('Offerwall postback debug', { subid, transid, reward, status, country, userIp });
    }
    
    res.status(200).send('ok');
  } catch (err) {
    logger.error('Offerwall postback error', { error: err.message });
    res.status(500).send('error');
  }
}

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

// ============================================
// NOTIFICATION CONTROLLERS
// ============================================
async function getNotifications(req, res) {
  try {
    const userId = String(req.user.userId);
    const snapshot = await db.collection('notifications')
      .where('user_id', '==', userId)
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();
    const notifs = snapshot.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() }));
    const unread = notifs.filter(n => !n.read).length;
    res.json({ notifications: notifs, unread });
  } catch (err) { logger.error('Get notifications error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function markNotificationsRead(req, res) {
  try {
    const userId = String(req.user.userId);
    const snapshot = await db.collection('notifications')
      .where('user_id', '==', userId)
      .where('read', '==', false)
      .get();
    const batch = db.batch();
    snapshot.docs.forEach(doc => {
      batch.update(doc.ref, { read: true });
    });
    await batch.commit();
    res.json({ success: true });
  } catch (err) { logger.error('Mark read error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function getAdminNotifications(req, res) {
  try {
    const snapshot = await db.collection('notifications')
      .where('user_id', '==', 'admin')
      .orderBy('timestamp', 'desc')
      .limit(100)
      .get();
    const notifs = snapshot.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() }));
    const unread = notifs.filter(n => !n.read).length;
    res.json({ notifications: notifs, unread });
  } catch (err) { logger.error('Admin notifications error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

// ============================================
// CONTACT / MESSAGE TO ADMIN
// ============================================
async function sendMessageToAdmin(req, res) {
  const userId = String(req.user.userId);
  const { message, subject } = req.body;
  
  if (!message || typeof message !== 'string' || message.trim().length < 5) {
    return res.status(400).json({ error: 'Message must be at least 5 characters' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'Message too long (max 2000 chars)' });
  }
  
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();
    
    await db.collection('messages').add({
      user_id: userId,
      username: userData.username || userData.first_name || 'Unknown',
      photo_url: userData.photo_url || null,
      subject: subject ? sanitize(subject.substring(0, 100)) : 'General',
      message: sanitize(message),
      status: 'new',
      read: false,
      timestamp: serverTimestamp()
    });
    
    await createNotification('admin', 'message', 'New User Message', `${userData.username || userId} sent a message: ${message.substring(0, 50)}...`);
    await logAction('user_message', userId, { subject, message: message.substring(0, 100) });
    
    res.json({ success: true, message: 'Message sent to admin' });
  } catch (err) {
    logger.error('Send message error', { error: err.message });
    res.status(500).json({ error: 'Failed to send message' });
  }
}

async function getUserMessages(req, res) {
  try {
    const userId = String(req.user.userId);
    const snapshot = await db.collection('messages')
      .where('user_id', '==', userId)
      .orderBy('timestamp', 'desc')
      .limit(20)
      .get();
    res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() })));
  } catch (err) { logger.error('Get user messages error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function getAdminMessages(req, res) {
  try {
    const snapshot = await db.collection('messages')
      .orderBy('timestamp', 'desc')
      .limit(100)
      .get();
    res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() })));
  } catch (err) { logger.error('Get admin messages error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function replyMessage(req, res) {
  const { messageId, reply } = req.body;
  if (!messageId || !reply) return res.status(400).json({ error: 'Missing fields' });
  
  try {
    const msgRef = db.collection('messages').doc(messageId);
    const msgDoc = await msgRef.get();
    if (!msgDoc.exists) return res.status(404).json({ error: 'Message not found' });
    
    const msgData = msgDoc.data();
    
    await msgRef.update({
      status: 'replied',
      reply: sanitize(reply),
      replied_at: serverTimestamp()
    });
    
    await createNotification(msgData.user_id, 'admin_reply', 'Admin Reply', `Admin replied to your message: ${reply.substring(0, 50)}...`);
    
    res.json({ success: true });
  } catch (err) {
    logger.error('Reply message error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

// ============================================
// HISTORY CONTROLLER
// ============================================
async function getHistory(req, res) {
  try {
    const userId = String(req.user.userId);
    const type = req.query.type || 'all';
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;
    
    let query = db.collection('transactions')
      .where('user_id', '==', userId)
      .orderBy('timestamp', 'desc');
    
    if (type !== 'all') {
      query = query.where('type', '==', type);
    }
    
    const snapshot = await query.limit(limit).get();
    const items = snapshot.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() }));
    
    res.json({ items, hasMore: items.length === limit });
  } catch (err) {
    logger.error('Get history error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

// ============================================
// REFERRAL DETAILS CONTROLLER
// ============================================
async function getReferralDetails(req, res) {
  try {
    const userId = String(req.user.userId);
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const userData = userDoc.data();
    
    // Get referrals list
    const refSnap = await db.collection('referrals')
      .where('referrer_id', '==', userId)
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();
    
    const referrals = [];
    for (const doc of refSnap.docs) {
      const data = doc.data();
      const refUserDoc = await db.collection('users').doc(data.referred_id).get();
      const refUser = refUserDoc.exists ? refUserDoc.data() : null;
      referrals.push({
        id: doc.id,
        user_id: data.referred_id,
        username: refUser?.username || refUser?.first_name || 'Unknown',
        photo_url: refUser?.photo_url || null,
        bonus: data.bonus,
        joined_at: data.timestamp?.toMillis(),
        active: refUser?.last_claim && (Date.now() - refUser.last_claim.toMillis() < 7 * 86400000)
      });
    }
    
    // Today's earnings
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todaySnap = await db.collection('referrals')
      .where('referrer_id', '==', userId)
      .where('timestamp', '>=', admin.firestore.Timestamp.fromDate(today))
      .get();
    const todayEarnings = todaySnap.docs.reduce((s, d) => s + (d.data().bonus || 0), 0);
    
    // Get top referrers (global)
    const allUsersSnap = await db.collection('users')
      .where('referrals', '>', 0)
      .orderBy('referrals', 'desc')
      .limit(10)
      .get();
    const topReferrers = allUsersSnap.docs.map(d => ({
      user_id: d.id,
      username: d.data().username || d.data().first_name || 'Unknown',
      referrals: d.data().referrals || 0,
      earnings: d.data().referral_earnings || 0
    }));
    
    res.json({
      link: `https://t.me/${BOT_USERNAME}?startapp=ref_${userId}`,
      total_referrals: userData.referrals || 0,
      active_referrals: referrals.filter(r => r.active).length,
      total_earnings: userData.referral_earnings || 0,
      today_earnings: todayEarnings,
      commission: 50,
      referrals,
      top_referrers
    });
  } catch (err) {
    logger.error('Referral details error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

// ============================================
// LEADERBOARD CONTROLLER
// ============================================
async function getLeaderboard(req, res) {
  try {
    const period = req.query.period || 'all'; // all, month, week
    let since = null;
    if (period === 'month') {
      since = new Date(); since.setMonth(since.getMonth() - 1);
    } else if (period === 'week') {
      since = new Date(); since.setDate(since.getDate() - 7);
    }
    
    const snap = await db.collection('users')
      .where('total_earned', '>', 0)
      .orderBy('total_earned', 'desc')
      .limit(100)
      .get();
    
    const leaderboard = snap.docs.map((d, i) => ({
      rank: i + 1,
      user_id: d.id,
      username: d.data().username || d.data().first_name || 'Anonymous',
      photo_url: d.data().photo_url || null,
      earnings: d.data().total_earned || 0,
      claims: d.data().total_claims || 0,
      referrals: d.data().referrals || 0
    }));
    
    res.json({ period, leaderboard });
  } catch (err) {
    logger.error('Leaderboard error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

// ============================================
// STATS CONTROLLERS
// ============================================
async function getGlobalStats(req, res) {
  try {
    const usersSnap = await db.collection('users').get();
    const totalUsers = usersSnap.size;
    const activeToday = usersSnap.docs.filter(d => { const lc = d.data().last_claim; return lc && (Date.now() - lc.toMillis() < 86400000); }).length;
    const wdSnap = await db.collection('withdrawals').get();
    const totalPaid = wdSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
    const totalCnx = usersSnap.docs.reduce((s, d) => s + (d.data().balance || 0), 0);
    const totalDoge = usersSnap.docs.reduce((s, d) => s + (d.data().doge_balance || 0), 0);
    const totalClaims = usersSnap.docs.reduce((s, d) => s + (d.data().total_claims || 0), 0);
    const totalPtc = usersSnap.docs.reduce((s, d) => s + (d.data().total_ptc_earnings || 0), 0);
    const pendingWd = wdSnap.docs.filter(d => d.data().status === 'pending').length;
    
    res.json({ totalUsers, activeToday, totalPaid, totalCnx, totalDoge, totalClaims, totalPtc, pendingWd });
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
    const snap = await db.collection('transactions').where('user_id', '==', userId).orderBy('timestamp', 'desc').limit(30).get();
    res.json(snap.docs.map(d => ({ amount: d.data().amount || 0, type: d.data().type, date: d.data().timestamp?.toDate().toISOString().split('T')[0] })));
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
// ADMIN CONTROLLERS
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
  try {
    const wdRef = db.collection('withdrawals').doc(req.body.id);
    const wdDoc = await wdRef.get();
    if (!wdDoc.exists) return res.status(404).json({ error: 'Not found' });
    
    await wdRef.update({ status: 'approved', approved_at: serverTimestamp() });
    
    const wdData = wdDoc.data();
    await createNotification(wdData.user_id, 'withdraw_approved', 'Withdrawal Approved', `Your withdrawal of ${wdData.amount} DOGE has been approved`);
    await logAction('approve_withdrawal', req.body.id, { amount: wdData.amount, user: wdData.user_id });
    
    res.json({ success: true });
  } catch (err) { logger.error('Approve error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function rejectWithdrawal(req, res) {
  try {
    const wdRef = db.collection('withdrawals').doc(req.body.id);
    const wdDoc = await wdRef.get();
    if (!wdDoc.exists) return res.status(404).json({ error: 'Not found' });
    
    const wdData = wdDoc.data();
    if (wdData.status !== 'pending') return res.status(400).json({ error: 'Not pending' });
    
    // Refund DOGE to user
    await db.collection('users').doc(wdData.user_id).update({
      doge_balance: increment(wdData.amount)
    });
    
    await wdRef.update({ status: 'rejected', rejected_at: serverTimestamp() });
    await createNotification(wdData.user_id, 'withdraw_rejected', 'Withdrawal Rejected', `Your withdrawal of ${wdData.amount} DOGE was rejected. Funds returned.`);
    
    res.json({ success: true });
  } catch (err) { logger.error('Reject error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function addBalance(req, res) {
  try {
    const { userId, amount, currency } = req.body;
    const field = currency === 'doge' ? 'doge_balance' : 'balance';
    await db.collection('users').doc(String(userId)).update({ [field]: increment(Number(amount)) });
    await logAction('admin_adjust_balance', userId, { amount, currency });
    await createNotification(userId, 'balance', 'Balance Adjusted', `Admin adjusted your ${currency.toUpperCase()} balance by ${amount}`);
    res.json({ success: true });
  } catch (err) { logger.error('Add balance error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function banUser(req, res) {
  try { 
    await db.collection('users').doc(String(req.body.userId)).update({ banned: true });
    await logAction('ban_user', req.body.userId, {});
    res.json({ success: true }); 
  } catch (err) { logger.error('Ban error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function unbanUser(req, res) {
  try { 
    await db.collection('users').doc(String(req.body.userId)).update({ banned: false });
    await logAction('unban_user', req.body.userId, {});
    res.json({ success: true }); 
  } catch (err) { logger.error('Unban error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function deleteUser(req, res) {
  try { 
    await db.collection('users').doc(String(req.body.userId)).delete();
    await logAction('delete_user', req.body.userId, {});
    res.json({ success: true }); 
  } catch (err) { logger.error('Delete error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function getLogs(req, res) {
  try {
    const snap = await db.collection('logs').orderBy('timestamp', 'desc').limit(100).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() })));
  } catch (err) { logger.error('Logs error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function getOfferwallLogs(req, res) {
  try {
    const snap = await db.collection('offerwall_completions').orderBy('timestamp', 'desc').limit(100).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() })));
  } catch (err) { logger.error('Offerwall logs error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function getSettings(req, res) {
  try { const doc = await db.collection('settings').doc('global').get(); res.json(doc.exists ? doc.data() : {}); }
  catch (err) { logger.error('Settings get error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function updateSettings(req, res) {
  try { 
    await db.collection('settings').doc('global').set(req.body, { merge: true });
    await logAction('update_settings', 'admin', req.body);
    res.json({ success: true }); 
  } catch (err) { logger.error('Settings update error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

async function broadcast(req, res) {
  try { 
    await db.collection('broadcasts').add({ message: req.body.message, timestamp: serverTimestamp() });
    
    // Notify all users
    const usersSnap = await db.collection('users').get();
    const batch = db.batch();
    usersSnap.docs.forEach(userDoc => {
      const notifRef = db.collection('notifications').doc();
      batch.set(notifRef, {
        user_id: userDoc.id,
        type: 'broadcast',
        title: 'Announcement',
        message: req.body.message,
        read: false,
        timestamp: serverTimestamp()
      });
    });
    await batch.commit();
    
    await logAction('broadcast', 'admin', { message: req.body.message.substring(0, 100) });
    res.json({ success: true, count: usersSnap.size });
  } catch (err) { logger.error('Broadcast error', { error: err.message }); res.status(500).json({ error: 'Failed' }); }
}

// ============================================
// EXPRESS APP
// ============================================
const app = express();
process.on('unhandledRejection', (err) => { logger.error('Unhandled Rejection', { error: err.message, stack: err.stack }); });
process.on('uncaughtException', (err) => { logger.error('Uncaught Exception', { error: err.message, stack: err.stack }); });

// Keep-alive ping
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

// Auth
app.post('/api/auth', authLimiter, auth);

// User routes (JWT protected)
app.use('/api', generalLimiter);
app.get('/api/me', jwtAuth, getMe);
app.get('/api/balance', jwtAuth, getBalance);
app.post('/api/claim', claimLimiter, jwtAuth, claim);
app.post('/api/withdraw', withdrawLimiter, jwtAuth, withdraw);
app.get('/api/withdrawals', jwtAuth, getWithdrawHistory);
app.get('/api/withdrawals/recent', getRecentWithdrawals);
app.get('/api/withdrawals/stats', jwtAuth, getWithdrawStats);
app.post('/api/swap', jwtAuth, swap);
app.get('/api/referral', jwtAuth, getReferral);
app.get('/api/referral/details', jwtAuth, getReferralDetails);
app.get('/api/offerwall/offerwall', jwtAuth, getOfferwallUrl);
app.get('/api/offerwall/ptc', jwtAuth, getPTCAds);
app.get('/api/offerwall/shortlinks', jwtAuth, getShortlinks);
app.get('/api/history', jwtAuth, getHistory);
app.get('/api/leaderboard', getLeaderboard);

// Notifications
app.get('/api/notifications', jwtAuth, getNotifications);
app.post('/api/notifications/read', jwtAuth, markNotificationsRead);

// Messages (Contact admin)
app.post('/api/contact', messageLimiter, jwtAuth, sendMessageToAdmin);
app.get('/api/messages', jwtAuth, getUserMessages);

// Postbacks (Offerwall)
app.post('/api/postback', postback);
app.post('/api/offerwall-postback', offerwallPostback);

// Stats
app.get('/api/stats', adminAuth, getGlobalStats);
app.get('/api/stats/user/:userId', jwtAuth, getUserStats);
app.get('/api/stats/user/:userId/charts', jwtAuth, getUserCharts);

// Admin routes
app.get('/api/admin/charts', adminAuth, getAdminCharts);
app.get('/api/admin/users', adminAuth, getUsers);
app.get('/api/admin/withdrawals', adminAuth, getAdminWithdrawals);
app.post('/api/admin/approve-withdrawal', adminAuth, approveWithdrawal);
app.post('/api/admin/reject-withdrawal', adminAuth, rejectWithdrawal);
app.post('/api/admin/add-balance', adminAuth, addBalance);
app.post('/api/admin/ban-user', adminAuth, banUser);
app.post('/api/admin/unban-user', adminAuth, unbanUser);
app.post('/api/admin/delete-user', adminAuth, deleteUser);
app.get('/api/admin/logs', adminAuth, getLogs);
app.get('/api/admin/offerwall-logs', adminAuth, getOfferwallLogs);
app.get('/api/admin/settings', adminAuth, getSettings);
app.post('/api/admin/settings', adminAuth, updateSettings);
app.post('/api/admin/broadcast', adminAuth, broadcast);
app.get('/api/admin/notifications', adminAuth, getAdminNotifications);
app.get('/api/admin/messages', adminAuth, getAdminMessages);
app.post('/api/admin/reply-message', adminAuth, replyMessage);

// SPA Fallback - All routes to single index.html
const spaPages = ['/', '/dashboard', '/faucet', '/ptc', '/withdraw', '/swap', '/history', '/admin',
                  '/offerwall', '/balance', '/referral', '/leaderboard', '/settings'];
spaPages.forEach(route => {
  app.get(route, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
});
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// Error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, path: req.path, method: req.method });
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  logger.info('COINIX FAUCET v3.0 running', { port: PORT, env: process.env.NODE_ENV || 'development', url: APP_URL });
});

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
// FIREBASE INIT
// ============================================
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp();
const increment = (n) => admin.firestore.FieldValue.increment(n);

// ============================================
// CONFIG
// ============================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME || 'your_bot';
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const ADMIN_ID = process.env.ADMIN_ID; // Your Telegram user ID
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY;
const OFFERWALL_APP_ID = process.env.OFFERWALL_APP_ID;
const OFFERWALL_SECRET = process.env.OFFERWALL_SECRET_KEY;
const APP_URL = process.env.APP_URL || 'https://yourdomain.com';
const PORT = process.env.PORT || 3000;

// ============================================
// LOGGER
// ============================================
const logger = {
  info: (msg, meta = {}) => console.log(`[INFO] ${msg}`, JSON.stringify(meta)),
  error: (msg, meta = {}) => console.error(`[ERROR] ${msg}`, JSON.stringify(meta)),
  debug: (msg, meta = {}) => console.log(`[DEBUG] ${msg}`, JSON.stringify(meta)),
  warn: (msg, meta = {}) => console.warn(`[WARN] ${msg}`, JSON.stringify(meta))
};

// ============================================
// SECURITY
// ============================================
function setupSecurity(app) {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'", "https://offerwall.me", "https://*.offerwall.me"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://offerwall.me", "https://telegram.org", "https://cdn.gtranslate.net", "https://translate.google.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.gtranslate.net"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:", "https:", "blob:"],
        connectSrc: ["'self'", "https://*.googleapis.com", "https://*.firebaseio.com"],
        frameSrc: ["'self'", "https://offerwall.me", "https://*.offerwall.me"],
        objectSrc: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false,
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
  }));
}

// ============================================
// RATE LIMITERS
// ============================================
const generalLimiter = rateLimit({ windowMs: 60*1000, max: 60, message: {error:'Too many requests'}, standardHeaders:true, legacyHeaders:false });
const authLimiter = rateLimit({ windowMs: 5*60*1000, max: 10, message: {error:'Too many auth attempts'}, standardHeaders:true, legacyHeaders:false });
const claimLimiter = rateLimit({ windowMs: 60*1000, max: 30, message: {error:'Too many claims'}, standardHeaders:true, legacyHeaders:false });
const withdrawLimiter = rateLimit({ windowMs: 60*60*1000, max: 10, message: {error:'Too many withdrawals'}, standardHeaders:true, legacyHeaders:false });
const messageLimiter = rateLimit({ windowMs: 60*60*1000, max: 5, message: {error:'Too many messages'}, standardHeaders:true, legacyHeaders:false });

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
    const dataCheckString = Array.from(urlParams.entries()).map(([k,v]) => `${k}=${v}`).join('\n');
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
  if (!ADMIN_ID || key !== ADMIN_ID) return res.status(403).json({ error: 'Forbidden - Admin only' });
  next();
}

// ============================================
// UTILS
// ============================================
async function logAction(action, userId, details = {}) {
  try {
    await db.collection('logs').add({ action, user_id: userId || null, details, ip: details.ip || null, timestamp: serverTimestamp() });
  } catch (e) { logger.error('Log error', { error: e.message }); }
}

async function sendNotification(userId, type, title, message, data = {}) {
  try {
    await db.collection('notifications').add({ user_id: String(userId), type, title, message, data, read: false, timestamp: serverTimestamp() });
  } catch (e) { logger.error('Notification error', { error: e.message }); }
}

async function sendAdminNotification(type, title, message, data = {}) {
  try {
    await db.collection('admin_notifications').add({ type, title, message, data, read: false, timestamp: serverTimestamp() });
  } catch (e) { logger.error('Admin notif error', { error: e.message }); }
}

// ============================================
// AUTH
// ============================================
async function auth(req, res) {
  const { initData, ref } = req.body;
  if (!initData) return res.status(400).json({ error: 'Missing initData' });
  if (!validateTelegramInitData(initData)) return res.status(403).json({ error: 'Invalid Telegram signature' });
  
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
        telegram_id: userId, username: user.username || null, first_name: user.first_name || null,
        last_name: user.last_name || null, photo_url: user.photo_url || null,
        balance: 0, doge_balance: 0, total_earned: 0, total_doge_earned: 0, total_ptc_earnings: 0,
        total_claims: 0, total_withdrawals: 0, referrals: 0, referral_earnings: 0,
        referred_by: ref || null, banned: false, last_claim: null, created_at: serverTimestamp()
      };
      await userRef.set(newUser);
      
      if (ref && ref !== userId) {
        const refRef = db.collection('users').doc(String(ref));
        const refDoc = await refRef.get();
        if (refDoc.exists && !refDoc.data().banned) {
          await refRef.update({ referrals: increment(1), balance: increment(50), referral_earnings: increment(50) });
          await db.collection('referrals').add({ referrer_id: String(ref), referred_id: userId, bonus: 50, currency: 'CNX', timestamp: serverTimestamp() });
          await sendNotification(ref, 'referral', 'New Referral!', `You earned +50 CNX from ${user.first_name || 'a friend'}`);
          await logAction('referral_bonus', String(ref), { referred_id: userId, bonus: 50 });
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
  } catch (err) { 
    logger.error('GetMe error', { error: err.message }); 
    res.status(500).json({ error: 'Server error' }); 
  }
}

// ============================================
// FAUCET
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
    
    if (now - lastClaim < cooldown) {
      return res.status(429).json({ error: 'Cooldown active', wait: cooldown - (now - lastClaim) });
    }
    
    const amount = 0.5;
    await userRef.update({ 
      balance: increment(amount), 
      total_earned: increment(amount), 
      total_claims: increment(1), 
      last_claim: serverTimestamp() 
    });
    
    res.json({ success: true, amount, balance: (d.balance || 0) + amount });
  } catch (err) { 
    logger.error('Claim error', { error: err.message, userId }); 
    res.status(500).json({ error: 'Claim failed' }); 
  }
}

// ============================================
// SWAP
// ============================================
async function swap(req, res) {
  const userId = String(req.user.userId);
  const { amount, direction } = req.body;
  const amt = Number(amount);
  
  if (!amt || amt <= 0 || isNaN(amt)) return res.status(400).json({ error: 'Invalid amount' });
  if (!direction || !['cnx-to-doge', 'doge-to-cnx'].includes(direction)) 
    return res.status(400).json({ error: 'Invalid direction' });
  
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
  } catch (err) { 
    logger.error('Swap error', { error: err.message, userId }); 
    res.status(500).json({ error: 'Swap failed' }); 
  }
}

// ============================================
// WITHDRAW
// ============================================
async function withdraw(req, res) {
  const userId = String(req.user.userId);
  const { faucetpay_email, amount } = req.body;
  const amt = Number(amount);
  
  if (!amt || amt <= 0 || isNaN(amt)) return res.status(400).json({ error: 'Invalid amount' });
  if (!faucetpay_email || !faucetpay_email.includes('@')) 
    return res.status(400).json({ error: 'Invalid email' });
  
  const userRef = db.collection('users').doc(userId);
  
  try {
    const doc = await userRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });
    const d = doc.data();
    if (d.banned) return res.status(403).json({ error: 'User banned' });
    if ((d.doge_balance || 0) < amt) return res.status(400).json({ error: 'Insufficient DOGE' });
    if (amt < 0.1) return res.status(400).json({ error: 'Minimum 0.10 DOGE' });
    
    await userRef.update({ doge_balance: increment(-amt), total_withdrawals: increment(1) });
    
    const wdRef = await db.collection('withdrawals').add({ 
      user_id: userId, faucetpay_email, amount: amt, status: 'pending', timestamp: serverTimestamp() 
    });
    
    await sendNotification(userId, 'withdraw', 'Withdrawal Submitted', 
      `Your withdrawal of ${amt} DOGE is pending approval.`);
    
    await sendAdminNotification('withdrawal_request', 'New Withdrawal Request', 
      `${d.username || userId} requested ${amt} DOGE`, 
      { withdrawal_id: wdRef.id, user_id: userId, amount: amt, email: faucetpay_email });
    
    res.json({ success: true, message: 'Withdrawal submitted' });
  } catch (err) { 
    logger.error('Withdraw error', { error: err.message, userId }); 
    res.status(500).json({ error: 'Withdrawal failed' }); 
  }
}

async function getWithdrawHistory(req, res) {
  try {
    const userId = String(req.user.userId);
    const snapshot = await db.collection('withdrawals')
      .where('user_id', '==', userId)
      .orderBy('timestamp', 'desc')
      .limit(50).get();
    res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() })));
  } catch (err) { 
    logger.error('Withdraw history error', { error: err.message }); 
    res.status(500).json({ error: 'Failed' }); 
  }
}

async function getRecentWithdrawals(req, res) {
  try {
    const snapshot = await db.collection('withdrawals')
      .where('status', '==', 'approved')
      .orderBy('timestamp', 'desc')
      .limit(25).get();
    res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() })));
  } catch (err) { 
    logger.error('Recent withdrawals error', { error: err.message }); 
    res.status(500).json({ error: 'Failed' }); 
  }
}

// ============================================
// NOTIFICATIONS
// ============================================
async function getNotifications(req, res) {
  try {
    const userId = String(req.user.userId);
    const snap = await db.collection('notifications')
      .where('user_id', '==', userId)
      .orderBy('timestamp', 'desc')
      .limit(50).get();
    
    const notifications = snap.docs.map(d => ({
      id: d.id, ...d.data(),
      timestamp: d.data().timestamp?.toMillis() || Date.now()
    }));
    
    const unreadCount = notifications.filter(n => !n.read).length;
    res.json({ notifications, unreadCount });
  } catch (err) {
    logger.error('Notifications error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function markNotificationsRead(req, res) {
  try {
    const userId = String(req.user.userId);
    const batch = db.batch();
    const snap = await db.collection('notifications')
      .where('user_id', '==', userId)
      .where('read', '==', false)
      .get();
    
    snap.docs.forEach(doc => { batch.update(doc.ref, { read: true }); });
    await batch.commit();
    res.json({ success: true });
  } catch (err) {
    logger.error('Mark read error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

// ============================================
// ADMIN NOTIFICATIONS
// ============================================
async function getAdminNotifications(req, res) {
  try {
    const snap = await db.collection('admin_notifications')
      .orderBy('timestamp', 'desc')
      .limit(100).get();
    
    const notifications = snap.docs.map(d => ({
      id: d.id, ...d.data(),
      timestamp: d.data().timestamp?.toMillis() || Date.now()
    }));
    
    const unreadCount = notifications.filter(n => !n.read).length;
    res.json({ notifications, unreadCount });
  } catch (err) {
    logger.error('Admin notifications error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function markAdminNotifRead(req, res) {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing ID' });
    await db.collection('admin_notifications').doc(id).update({ read: true });
    res.json({ success: true });
  } catch (err) {
    logger.error('Mark admin notif error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function clearAdminNotifs(req, res) {
  try {
    const batch = db.batch();
    const snap = await db.collection('admin_notifications')
      .where('read', '==', true)
      .limit(100).get();
    snap.docs.forEach(doc => { batch.delete(doc.ref); });
    await batch.commit();
    res.json({ success: true, deleted: snap.size });
  } catch (err) {
    logger.error('Clear admin notifs error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

// ============================================
// USER → ADMIN MESSAGES
// ============================================
async function sendMessageToAdmin(req, res) {
  const userId = String(req.user.userId);
  const { subject, message } = req.body;
  
  if (!message || message.trim().length < 5) 
    return res.status(400).json({ error: 'Message too short (min 5 chars)' });
  
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    const user = userDoc.exists ? userDoc.data() : null;
    
    const msgRef = await db.collection('admin_messages').add({
      user_id: userId,
      username: user?.username || user?.first_name || userId,
      subject: (subject || 'General Inquiry').substring(0, 100),
      message: message.substring(0, 2000),
      status: 'pending',
      timestamp: serverTimestamp()
    });
    
    await sendAdminNotification('user_message', 'New User Message', 
      `${user?.username || userId}: ${message.substring(0, 50)}...`, 
      { message_id: msgRef.id, user_id: userId, subject });
    
    await logAction('user_message', userId, { subject, message: message.substring(0, 100) });
    
    res.json({ success: true, message: 'Message sent to admin' });
  } catch (err) {
    logger.error('Send message error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function getUserMessages(req, res) {
  try {
    const userId = String(req.user.userId);
    const snap = await db.collection('admin_messages')
      .where('user_id', '==', userId)
      .orderBy('timestamp', 'desc')
      .limit(20).get();
    
    res.json(snap.docs.map(d => ({
      id: d.id, ...d.data(),
      timestamp: d.data().timestamp?.toMillis() || Date.now()
    })));
  } catch (err) {
    logger.error('Get messages error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function getAdminMessages(req, res) {
  try {
    const snap = await db.collection('admin_messages')
      .orderBy('timestamp', 'desc')
      .limit(50).get();
    
    res.json(snap.docs.map(d => ({
      id: d.id, ...d.data(),
      timestamp: d.data().timestamp?.toMillis() || Date.now()
    })));
  } catch (err) {
    logger.error('Admin messages error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function replyToMessage(req, res) {
  try {
    const { messageId, reply } = req.body;
    if (!messageId || !reply || reply.trim().length < 3) 
      return res.status(400).json({ error: 'Invalid reply' });
    
    const msgRef = db.collection('admin_messages').doc(messageId);
    const msgDoc = await msgRef.get();
    
    if (!msgDoc.exists) return res.status(404).json({ error: 'Message not found' });
    
    const msgData = msgDoc.data();
    
    await msgRef.update({
      status: 'replied',
      reply: reply.substring(0, 2000),
      replied_at: serverTimestamp(),
      replied_by: 'admin'
    });
    
    await sendNotification(msgData.user_id, 'admin_reply', 'Admin Reply', 
      `Admin replied to your message: ${reply.substring(0, 100)}...`);
    
    res.json({ success: true });
  } catch (err) {
    logger.error('Reply message error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

// ============================================
// OFFERWALL
// ============================================
async function getOfferwallUrl(req, res) {
  const userId = String(req.user.userId);
  const subId = Buffer.from(userId).toString('base64');
  const url = `https://offerwall.me/offerwall/${OFFERWALL_APP_ID}?subid=${subId}`;
  res.json({ url });
}

async function postback(req, res) {
  try {
    const { subid, transid, reward, signature } = req.body;
    if (!subid || !transid || !reward || !signature) return res.status(400).send('missing params');
    
    const expected = crypto.createHash('md5')
      .update(`${subid}.${transid}.${reward}.${OFFERWALL_SECRET}`)
      .digest('hex');
    
    if (signature !== expected) return res.status(403).send('invalid sig');
    
    let userId;
    try { userId = Buffer.from(subid, 'base64').toString('ascii'); }
    catch (e) { return res.status(400).send('invalid subid'); }
    
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    
    if (!doc.exists) return res.status(404).send('user not found');
    if (doc.data().banned) return res.status(403).send('banned');
    
    // Duplicate check
    const existingSnap = await db.collection('offerwall_completions')
      .where('trans_id', '==', transid).limit(1).get();
    if (!existingSnap.empty) return res.status(200).send('ok');
    
    const amt = Number(reward);
    if (isNaN(amt) || amt <= 0) return res.status(400).send('invalid reward');
    
    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error('User not found');
      t.update(userRef, {
        balance: increment(amt),
        total_earned: increment(amt),
        total_ptc_earnings: increment(amt)
      });
    });
    
    await db.collection('offerwall_completions').add({
      user_id: userId, trans_id: transid, amount: amt,
      status: 'completed', source: 'offerwall_native',
      timestamp: serverTimestamp()
    });
    
    await sendNotification(userId, 'offerwall', 'Offerwall Reward!', 
      `You earned +${amt} CNX`);
    
    logger.info('Postback reward credited', { userId, transid, amt });
    res.status(200).send('OK');
  } catch (err) {
    logger.error('Offerwall postback error', { error: err.message });
    res.status(500).send('error');
  }
}

// ============================================
// STATS
// ============================================
async function getGlobalStats(req, res) {
  try {
    const usersSnap = await db.collection('users').get();
    const totalUsers = usersSnap.size;
    const activeToday = usersSnap.docs.filter(d => { 
      const lc = d.data().last_claim; 
      return lc && (Date.now() - lc.toMillis() < 86400000); 
    }).length;
    
    const wdSnap = await db.collection('withdrawals').get();
    const totalPaid = wdSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
    
    const claimsSnap = await db.collection('users').get();
    const totalClaims = claimsSnap.docs.reduce((s, d) => s + (d.data().total_claims || 0), 0);
    
    res.json({ totalUsers, activeToday, totalPaid, totalClaims });
  } catch (err) { 
    logger.error('Global stats error', { error: err.message }); 
    res.status(500).json({ error: 'Failed' }); 
  }
}

// ============================================
// ADMIN
// ============================================
async function getUsers(req, res) {
  try {
    const snap = await db.collection('users').orderBy('created_at', 'desc').limit(100).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data(), created_at: d.data().created_at?.toMillis() })));
  } catch (err) { 
    logger.error('Admin users error', { error: err.message }); 
    res.status(500).json({ error: 'Failed' }); 
  }
}

async function getAdminWithdrawals(req, res) {
  try {
    const snap = await db.collection('withdrawals').orderBy('timestamp', 'desc').limit(100).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() })));
  } catch (err) { 
    logger.error('Admin withdrawals error', { error: err.message }); 
    res.status(500).json({ error: 'Failed' }); 
  }
}

async function approveWithdrawal(req, res) {
  try {
    const wdId = req.body.id;
    const wdRef = db.collection('withdrawals').doc(wdId);
    const wdDoc = await wdRef.get();
    
    if (!wdDoc.exists) return res.status(404).json({ error: 'Not found' });
    
    const wdData = wdDoc.data();
    await wdRef.update({ status: 'approved', approved_at: serverTimestamp(), approved_by: 'admin' });
    await sendNotification(wdData.user_id, 'withdraw', 'Withdrawal Approved!', 
      `Your withdrawal of ${wdData.amount} DOGE has been approved.`);
    await logAction('approve_withdrawal', wdData.user_id, { withdrawal_id: wdId, amount: wdData.amount });
    
    res.json({ success: true });
  } catch (err) { 
    logger.error('Approve error', { error: err.message }); 
    res.status(500).json({ error: 'Failed' }); 
  }
}

async function rejectWithdrawal(req, res) {
  try {
    const wdId = req.body.id;
    const wdRef = db.collection('withdrawals').doc(wdId);
    const wdDoc = await wdRef.get();
    
    if (!wdDoc.exists) return res.status(404).json({ error: 'Not found' });
    
    const wdData = wdDoc.data();
    await db.collection('users').doc(wdData.user_id).update({ doge_balance: increment(wdData.amount) });
    await wdRef.update({ status: 'rejected', rejected_at: serverTimestamp(), rejected_by: 'admin' });
    await sendNotification(wdData.user_id, 'withdraw', 'Withdrawal Rejected', 
      `Your withdrawal of ${wdData.amount} DOGE was rejected. Amount refunded.`);
    
    res.json({ success: true });
  } catch (err) {
    logger.error('Reject error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function addBalance(req, res) {
  try {
    const { userId, amount, currency } = req.body;
    const field = currency === 'doge' ? 'doge_balance' : 'balance';
    await db.collection('users').doc(String(userId)).update({ [field]: increment(Number(amount)) });
    await sendNotification(userId, 'balance', 'Balance Updated', 
      `Admin added ${amount} ${currency.toUpperCase()} to your account.`);
    await logAction('admin_adjust_balance', userId, { amount, currency });
    res.json({ success: true });
  } catch (err) { 
    logger.error('Add balance error', { error: err.message }); 
    res.status(500).json({ error: 'Failed' }); 
  }
}

async function banUser(req, res) {
  try { 
    await db.collection('users').doc(String(req.body.userId)).update({ banned: true });
    await logAction('ban_user', req.body.userId, {});
    res.json({ success: true }); 
  } catch (err) { 
    logger.error('Ban error', { error: err.message }); 
    res.status(500).json({ error: 'Failed' }); 
  }
}

async function deleteUser(req, res) {
  try { 
    await db.collection('users').doc(String(req.body.userId)).delete(); 
    await logAction('delete_user', req.body.userId, {});
    res.json({ success: true }); 
  } catch (err) { 
    logger.error('Delete error', { error: err.message }); 
    res.status(500).json({ error: 'Failed' }); 
  }
}

async function getLogs(req, res) {
  try {
    const snap = await db.collection('logs').orderBy('timestamp', 'desc').limit(100).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() })));
  } catch (err) { 
    logger.error('Logs error', { error: err.message }); 
    res.status(500).json({ error: 'Failed' }); 
  }
}

async function getSettings(req, res) {
  try { 
    const doc = await db.collection('settings').doc('global').get(); 
    res.json(doc.exists ? doc.data() : {}); 
  } catch (err) { 
    logger.error('Settings get error', { error: err.message }); 
    res.status(500).json({ error: 'Failed' }); 
  }
}

async function updateSettings(req, res) {
  try { 
    await db.collection('settings').doc('global').set(req.body, { merge: true }); 
    await logAction('update_settings', 'admin', req.body);
    res.json({ success: true }); 
  } catch (err) { 
    logger.error('Settings update error', { error: err.message }); 
    res.status(500).json({ error: 'Failed' }); 
  }
}

async function broadcast(req, res) {
  try { 
    await db.collection('broadcasts').add({ message: req.body.message, timestamp: serverTimestamp() });
    
    // Notify all users
    const usersSnap = await db.collection('users').get();
    const batch = db.batch();
    usersSnap.docs.forEach(doc => {
      const notifRef = db.collection('notifications').doc();
      batch.set(notifRef, {
        user_id: doc.id,
        type: 'broadcast',
        title: 'Announcement',
        message: req.body.message,
        read: false,
        timestamp: serverTimestamp()
      });
    });
    await batch.commit();
    
    res.json({ success: true }); 
  } catch (err) { 
    logger.error('Broadcast error', { error: err.message }); 
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
  https.get(`${APP_URL}/ping`, (res) => { logger.debug('Keep-alive ping', { status: res.statusCode }); })
    .on('error', (err) => { logger.error('Keep-alive ping error', { error: err.message }); });
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
app.use('/api', generalLimiter);

// User endpoints
app.get('/api/me', jwtAuth, getMe);
app.post('/api/claim', claimLimiter, jwtAuth, claim);
app.post('/api/withdraw', withdrawLimiter, jwtAuth, withdraw);
app.get('/api/withdrawals', jwtAuth, getWithdrawHistory);
app.get('/api/withdrawals/recent', getRecentWithdrawals);
app.post('/api/swap', jwtAuth, swap);

// Notifications
app.get('/api/notifications', jwtAuth, getNotifications);
app.post('/api/notifications/read', jwtAuth, markNotificationsRead);

// Messages (user → admin)
app.post('/api/contact', messageLimiter, jwtAuth, sendMessageToAdmin);
app.get('/api/messages', jwtAuth, getUserMessages);

// Admin notifications
app.get('/api/admin/notifications', adminAuth, getAdminNotifications);
app.post('/api/admin/notifications/read', adminAuth, markAdminNotifRead);
app.post('/api/admin/notifications/clear', adminAuth, clearAdminNotifs);

// Admin messages
app.get('/api/admin/messages', adminAuth, getAdminMessages);
app.post('/api/admin/reply-message', adminAuth, replyToMessage);

// Offerwall
app.get('/api/offerwall/offerwall', jwtAuth, getOfferwallUrl);
app.post('/api/postback', postback);

// Stats
app.get('/api/stats', adminAuth, getGlobalStats);

// Admin
app.get('/api/admin/users', adminAuth, getUsers);
app.get('/api/admin/withdrawals', adminAuth, getAdminWithdrawals);
app.post('/api/admin/approve-withdrawal', adminAuth, approveWithdrawal);
app.post('/api/admin/reject-withdrawal', adminAuth, rejectWithdrawal);
app.post('/api/admin/add-balance', adminAuth, addBalance);
app.post('/api/admin/ban-user', adminAuth, banUser);
app.post('/api/admin/delete-user', adminAuth, deleteUser);
app.get('/api/admin/logs', adminAuth, getLogs);
app.get('/api/admin/settings', adminAuth, getSettings);
app.post('/api/admin/settings', adminAuth, updateSettings);
app.post('/api/admin/broadcast', adminAuth, broadcast);

// SPA Fallback
const spaPages = ['/', '/dashboard', '/faucet', '/withdraw', '/swap', '/history', '/admin',
                  '/offerwall', '/balance', '/referral', '/leaderboard', '/settings', '/contact'];
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
  logger.info('COINIX FAUCET v3.0.0 running', { port: PORT, env: process.env.NODE_ENV || 'development', url: APP_URL });
});

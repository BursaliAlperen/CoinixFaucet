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
const BOT_USERNAME = process.env.BOT_USERNAME || 'coinix_faucet_bot';
const JWT_SECRET = process.env.JWT_SECRET || 'Kp9mN2xQwR7vL4jT8hY3sF6gD1aZ5bW0cX9nM2kV7uI4oE3rJ6tA8qS1wG5yH0pL';
const ADMIN_ID = process.env.ADMIN_ID;
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY;

// OFFERWALL SETTINGS - UPDATED
const OFFERWALL_APP_ID = process.env.OFFERWALL_APP_ID || '1582';
const OFFERWALL_API_KEY = process.env.OFFERWALL_API_KEY || '5jxyggxcc6vwbyu64cqo7w2u42';
const OFFERWALL_SECRET = process.env.OFFERWALL_SECRET || 'uugscq4j4qs4v06t4p61unsb57';

const APP_URL = process.env.APP_URL || 'https://coinixfaucet.onrender.com';
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
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://translate.google.com", "https://translate.googleapis.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:", "blob:"],
        connectSrc: ["'self'", "https://*.googleapis.com", "https://*.firebaseio.com"],
        frameSrc: ["'self'", "https://offerwall.me", "https://*.offerwall.me"],
        objectSrc: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false
  }));
}

// ============================================
// RATE LIMITERS
// ============================================
const generalLimiter = rateLimit({ windowMs: 60*1000, max: 100, message: {error:'Too many requests'} });
const authLimiter = rateLimit({ windowMs: 5*60*1000, max: 20, message: {error:'Too many auth attempts'} });
const claimLimiter = rateLimit({ windowMs: 10*1000, max: 1, message: {error:'Cooldown active, wait 10 seconds'} });
const postbackLimiter = rateLimit({ windowMs: 60*1000, max: 1000, message: {error:'Too many postbacks'} });

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
    const sortedParams = Array.from(urlParams.entries()).sort();
    const dataCheckString = sortedParams.map(([k, v]) => `${k}=${v}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const checkHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    return hash.toLowerCase() === checkHash.toLowerCase();
  } catch (e) { 
    logger.error('Telegram validation error', { error: e.message });
    return false; 
  }
}

function jwtAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) { 
    logger.error('JWT error', { error: e.message });
    return res.status(403).json({ error: 'Invalid token' }); 
  }
}

function adminAuth(req, res, next) {
  const key = req.query.admin_key || req.headers['x-admin-key'];
  if (!ADMIN_ID || key !== ADMIN_ID) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ============================================
// UTILS
// ============================================
async function logAction(action, userId, details = {}) {
  try {
    await db.collection('logs').add({
      action, user_id: userId || null, details, timestamp: serverTimestamp()
    });
  } catch (e) { logger.error('Log error', { error: e.message }); }
}

async function sendNotification(userId, type, title, message, data = {}) {
  try {
    await db.collection('notifications').add({ 
      user_id: String(userId), type, title, message, data, 
      read: false, timestamp: serverTimestamp() 
    });
  } catch (e) { logger.error('Notification error', { error: e.message }); }
}

// ============================================
// AUTH
// ============================================
async function auth(req, res) {
  const { initData, ref } = req.body;
  if (!initData) return res.status(400).json({ error: 'Missing initData' });
  if (!validateTelegramInitData(initData)) {
    return res.status(403).json({ error: 'Invalid Telegram signature' });
  }
  
  let user;
  try {
    const urlParams = new URLSearchParams(initData);
    user = JSON.parse(urlParams.get('user'));
  } catch (e) { 
    return res.status(400).json({ error: 'Bad user data' }); 
  }
  
  if (!user || !user.id) return res.status(400).json({ error: 'No user data' });
  
  const userId = String(user.id);
  const userRef = db.collection('users').doc(userId);
  
  try {
    const doc = await userRef.get();
    let isNewUser = false;
    
    if (!doc.exists) {
      isNewUser = true;
      const newUser = {
        telegram_id: userId, 
        username: user.username || null, 
        first_name: user.first_name || null,
        last_name: user.last_name || null, 
        photo_url: user.photo_url || null,
        balance: 0, doge_balance: 0, total_earned: 0, 
        total_doge_earned: 0, total_ptc_earnings: 0,
        total_claims: 0, total_withdrawals: 0, referrals: 0,
        referral_earnings: 0, referred_by: ref || null, 
        banned: false, last_claim: null, created_at: serverTimestamp()
      };
      await userRef.set(newUser);
      logger.info('New user created', { userId, username: user.username });
      
      if (ref && ref !== userId) {
        const refRef = db.collection('users').doc(String(ref));
        const refDoc = await refRef.get();
        if (refDoc.exists && !refDoc.data().banned) {
          await refRef.update({ 
            referrals: increment(1), 
            balance: increment(50), 
            referral_earnings: increment(50) 
          });
          await sendNotification(ref, 'referral', 'New Referral!', 
            `You earned +50 CNX from ${user.first_name || 'a friend'}`);
        }
      }
    }
    
    const token = jwt.sign({ userId, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, user_id: userId, username: user.username, token, isNewUser });
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
      const waitTime = Math.ceil((cooldown - (now - lastClaim)) / 1000);
      return res.status(429).json({ error: 'Cooldown active', wait: waitTime });
    }
    
    const amount = 0.5;
    await userRef.update({ 
      balance: increment(amount), total_earned: increment(amount), 
      total_claims: increment(1), last_claim: serverTimestamp() 
    });
    
    await sendNotification(userId, 'gold', 'Claim Success!', `You earned +${amount} CNX`);
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
    await sendNotification(userId, 'blue', 'Swap Success!', `Swapped ${amt} ${direction.includes('cnx') ? 'CNX → DOGE' : 'DOGE → CNX'}`);
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
      user_id: userId, faucetpay_email, amount: amt, 
      status: 'pending', timestamp: serverTimestamp() 
    });
    
    await sendNotification(userId, 'warn', 'Withdrawal Pending', `${amt} DOGE sent for approval`);
    res.json({ success: true, message: 'Withdrawal submitted', id: wdRef.id });
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
    res.json(snapshot.docs.map(d => ({ 
      id: d.id, ...d.data(), 
      timestamp: d.data().timestamp?.toMillis() 
    })));
  } catch (err) { 
    logger.error('Withdraw history error', { error: err.message }); 
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
    const snap = await db.collection('notifications')
      .where('user_id', '==', userId)
      .where('read', '==', false)
      .get();
    
    const batch = db.batch();
    snap.docs.forEach(doc => { batch.update(doc.ref, { read: true }); });
    await batch.commit();
    res.json({ success: true, count: snap.size });
  } catch (err) {
    logger.error('Mark read error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

// ============================================
// OFFERWALL - FIXED & COMPLETE
// ============================================
async function getOfferwallUrl(req, res) {
  const userId = String(req.user.userId);
  const subId = Buffer.from(userId).toString('base64');
  
  // offerwall.me iframe URL format
  const url = `https://offerwall.me/offerwall/${OFFERWALL_APP_ID}?subid=${subId}&api_key=${OFFERWALL_API_KEY}`;
  
  logger.debug('Offerwall URL generated', { userId, subId, url });
  res.json({ url });
}

// S2S Postback Handler - Receives rewards
async function postback(req, res) {
  try {
    logger.debug('Postback received', { body: req.body });
    
    const { subid, transid, reward, signature, status, debug } = req.body;
    
    // Validate required fields
    if (!subid || !transid || reward === undefined || !signature) {
      logger.warn('Postback missing fields', { subid, transid, reward, signature });
      return res.status(400).send('missing params');
    }
    
    // Verify signature (MD5: subid.transid.reward.SECRET)
    const expected = crypto.createHash('md5')
      .update(`${subid}.${transid}.${reward}.${OFFERWALL_SECRET}`)
      .digest('hex');
    
    if (signature !== expected) {
      logger.warn('Postback signature mismatch', { 
        received: signature, 
        expected, 
        data: `${subid}.${transid}.${reward}.${OFFERWALL_SECRET}` 
      });
      return res.status(403).send('invalid signature');
    }
    
    // Decode subid to get userId
    let userId;
    try { 
      userId = Buffer.from(subid, 'base64').toString('ascii'); 
    } catch (e) { 
      logger.warn('Invalid subid', { subid });
      return res.status(400).send('invalid subid'); 
    }
    
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    
    if (!doc.exists) {
      logger.warn('User not found for postback', { userId, transid });
      return res.status(404).send('user not found');
    }
    
    if (doc.data().banned) {
      logger.warn('Banned user postback', { userId, transid });
      return res.status(403).send('banned');
    }
    
    // Check if already credited
    const existingSnap = await db.collection('offerwall_completions')
      .where('trans_id', '==', transid).limit(1).get();
    
    if (!existingSnap.empty) {
      logger.debug('Postback already credited', { userId, transid });
      return res.status(200).send('ok');
    }
    
    const amt = Number(reward);
    if (isNaN(amt) || amt <= 0) {
      logger.warn('Invalid reward amount', { transid, reward });
      return res.status(400).send('invalid reward');
    }
    
    // Credit user
    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error('User not found');
      t.update(userRef, {
        balance: increment(amt),
        total_earned: increment(amt),
        total_ptc_earnings: increment(amt)
      });
    });
    
    // Log completion
    await db.collection('offerwall_completions').add({
      user_id: userId, trans_id: transid, amount: amt,
      status: status || 'completed', debug: debug || 0,
      source: 'offerwall_native', timestamp: serverTimestamp()
    });
    
    await sendNotification(userId, 'gold', 'Offerwall Reward!', `You earned +${amt} CNX`);
    
    logger.info('Offerwall reward credited', { userId, transid, amount: amt });
    res.status(200).send('OK');
  } catch (err) {
    logger.error('Offerwall postback error', { error: err.message, stack: err.stack });
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
// EXPRESS APP
// ============================================
const app = express();
app.set('trust proxy', 1);

process.on('unhandledRejection', (err) => { 
  logger.error('Unhandled Rejection', { error: err.message }); 
});
process.on('uncaughtException', (err) => { 
  logger.error('Uncaught Exception', { error: err.message }); 
});

setupSecurity(app);
app.use(cors({ origin: true, credentials: true }));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  setHeaders: (res, filePath) => { 
    if (filePath.endsWith('.html')) 
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); 
  }
}));

// ============================================
// ROUTES
// ============================================
app.get('/ping', (req, res) => res.status(200).send('OK'));

// Auth
app.post('/api/auth', authLimiter, auth);
app.use('/api/', generalLimiter);

// User endpoints
app.get('/api/me', jwtAuth, getMe);
app.post('/api/claim', claimLimiter, jwtAuth, claim);
app.post('/api/withdraw', jwtAuth, withdraw);
app.get('/api/withdrawals', jwtAuth, getWithdrawHistory);
app.post('/api/swap', jwtAuth, swap);

// Notifications
app.get('/api/notifications', jwtAuth, getNotifications);
app.post('/api/notifications/read', jwtAuth, markNotificationsRead);

// Offerwall
app.get('/api/offerwall/url', jwtAuth, getOfferwallUrl);
app.post('/api/postback', postbackLimiter, postback);  // S2S postback from Offerwall

// Stats
app.get('/api/stats', getGlobalStats);

// SPA Fallback
const spaPages = ['/', '/dashboard', '/faucet', '/withdraw', '/swap', '/history', '/admin',
                  '/offerwall', '/balance', '/referral', '/leaderboard'];
spaPages.forEach(route => {
  app.get(route, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
});
app.get('*', (req, res) => { 
  res.sendFile(path.join(__dirname, 'public', 'index.html')); 
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, path: req.path });
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  logger.info('COINIX FAUCET v4.0.0 running', { 
    port: PORT, 
    url: APP_URL,
    offerwall_app_id: OFFERWALL_APP_ID
  });
});

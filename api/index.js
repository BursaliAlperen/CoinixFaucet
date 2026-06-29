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
// FIREBASE INIT
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
        console.log('[Firebase] Using FIREBASE_SERVICE_ACCOUNT_JSON');
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
        const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
        serviceAccount = JSON.parse(decoded);
        console.log('[Firebase] Using FIREBASE_SERVICE_ACCOUNT_BASE64');
    }
    if (serviceAccount) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        db = admin.firestore();
        FieldValue = admin.firestore.FieldValue;
        Timestamp = admin.firestore.Timestamp;
        serverTimestamp = () => FieldValue.serverTimestamp();
        increment = (n) => FieldValue.increment(n);
        firebaseInitialized = true;
        console.log('[Firebase] Initialized successfully');
    } else {
        console.warn('[Firebase] Running WITHOUT database');
    }
} catch (e) {
    console.error('[Firebase] Init error:', e.message);
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
const BOT_USERNAME = process.env.BOT_USERNAME || 'CoinixBot';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '';
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || JWT_SECRET;
const OFFERWALL_APP_ID = process.env.OFFERWALL_APP_ID;
const OFFERWALL_SECRET_KEY = process.env.OFFERWALL_SECRET_KEY;
const OFFERWALL_API_TOKEN = process.env.OFFERWALL_API_TOKEN || '';
const APP_URL = process.env.APP_URL || 'https://coinixfaucet-teri.onrender.com';
const PORT = process.env.PORT || 10000;

// ============================================
// FAUCET / PROMO CONFIG
// ============================================
const FAUCET_COOLDOWN = 180000;
const FAUCET_REWARD = 1.0;
const REFERRAL_SIGNUP_BONUS = 50;
const REFERRAL_COMMISSION_PERCENT = 20;
const BONUS_PERCENT = 20;
const BONUS_TYPES = ['ptc', 'shortlink', 'shortlinks', 'game', 'games', 'visit', 'visits'];

// ============================================
// SECURITY (Helmet)
// ============================================
function setupSecurity(app) {
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'", "https://offerwall.me", "https://*.offerwall.me"],
                scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://offerwall.me", "https://*.offerwall.me", "https://telegram.org"],
                styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
                fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
                imgSrc: ["'self'", "data:", "https:", "blob:"],
                connectSrc: ["'self'", "https://*.googleapis.com", "https://*.firebaseio.com", "https://api.coingecko.com", "https://offerwall.me"],
                frameSrc: ["'self'", "https://offerwall.me", "https://*.offerwall.me"],
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
const generalLimiter = rateLimit({ windowMs: 60000, max: 120 });
const authLimiter = rateLimit({ windowMs: 300000, max: 20 });
const claimLimiter = rateLimit({ windowMs: 60000, max: 30 });
const withdrawLimiter = rateLimit({ windowMs: 3600000, max: 10 });
const promoLimiter = rateLimit({ windowMs: 3600000, max: 30 });

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
    } catch (e) {
        logger.error('Init data validation error', { error: e.message });
        return false;
    }
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
    if (!ADMIN_SECRET_KEY || key !== ADMIN_SECRET_KEY) return res.status(403).json({ error: 'Forbidden' });
    next();
}

// ============================================
// UTILS
// ============================================
async function logAction(action, userId, details = {}) {
    if (!db) return;
    try {
        await db.collection('logs').add({ action, user_id: userId, details, timestamp: serverTimestamp() });
    } catch (e) { logger.error('Log error', { error: e.message }); }
}

function getClientIP(req) {
    return (req.headers['x-forwarded-for'] || '0.0.0.0').split(',')[0].trim();
}

function startOfTodayTs() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return Timestamp ? Timestamp.fromDate(d) : d;
}

function startOfDayMinus(days) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - days);
    return Timestamp ? Timestamp.fromDate(d) : d;
}

// ============================================
// DOGE PRICE CACHE
// ============================================
let dogePriceCache = { price: 0, change: 0, lastUpdate: 0 };

async function fetchDogePrice() {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=dogecoin&vs_currencies=usd&include_24hr_change=true', { signal: controller.signal });
        clearTimeout(timeout);
        if (!response.ok) return dogePriceCache;
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

fetchDogePrice();
setInterval(fetchDogePrice, 120000);

// ============================================
// OFFERWALL.ME
// ============================================
async function getOfferwallUrl(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const userId = String(req.user.userId);
        const url = `https://offerwall.me/offerwall/${OFFERWALL_APP_ID}/${userId}`;
        res.json({ success: true, url, user_id: userId });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function getPTCAds(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const userId = String(req.user.userId);
        if (!OFFERWALL_API_TOKEN) return res.json({ success: true, ads: [], total: 0 });
        const userIp = getClientIP(req);
        const country = req.headers['cf-ipcountry'] || 'US';
        const apiUrl = `https://offerwall.me/api.php?api=${OFFERWALL_APP_ID}&id=${userId}&ip=${userIp}&token=${OFFERWALL_API_TOKEN}&country=${country}`;
        const response = await fetch(apiUrl, { headers: { 'Accept': 'application/json' } });
        if (!response.ok) return res.status(502).json({ error: 'Offerwall API error' });
        const data = await response.json();
        if (data.status !== 200) return res.json({ success: false, ads: [] });
        const ads = (data.data || []).map(ad => ({
            id: ad.id || String(Math.random()),
            title: ad.title || 'Ad',
            reward: Number(ad.reward) || 0,
            duration: ad.duration || 30,
            url: ad.url || ''
        }));
        res.json({ success: true, ads, total: ads.length });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function getShortlinks(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const userId = String(req.user.userId);
        if (!OFFERWALL_API_TOKEN) return res.json({ success: true, shortlinks: [], total: 0 });
        const userIp = getClientIP(req);
        const country = req.headers['cf-ipcountry'] || 'US';
        const apiUrl = `https://offerwall.me/slapi.php?api=${OFFERWALL_APP_ID}&id=${userId}&ip=${userIp}&token=${OFFERWALL_API_TOKEN}&country=${country}`;
        const response = await fetch(apiUrl, { headers: { 'Accept': 'application/json' } });
        if (!response.ok) return res.status(502).json({ error: 'Offerwall API error' });
        const data = await response.json();
        if (data.status !== 200) return res.json({ success: false, shortlinks: [] });
        const shortlinks = (data.data || []).map(link => ({
            id: link.id || String(Math.random()),
            name: link.name || 'Link',
            reward: Number(link.reward) || 0,
            url: link.url || ''
        }));
        res.json({ success: true, shortlinks, total: shortlinks.length });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function getGames(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const userId = String(req.user.userId);
        const url = `https://offerwall.me/offerwall/${OFFERWALL_APP_ID}/${userId}`;
        res.json({ success: true, url });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

// ============================================
// POSTBACK
// ============================================
const OFFERWALL_IPS = ['95.216.65.163', '2a01:4f9:2b:1dc::2'];

function isOfferwallIP(ip) {
    if (!ip) return false;
    return OFFERWALL_IPS.some(a => ip.toLowerCase() === a.toLowerCase());
}

async function postback(req, res) {
    try {
        const clientIp = getClientIP(req);
        if (!isOfferwallIP(clientIp)) return res.status(403).send('ERROR: Invalid source');
        const { subId, transId, reward, signature, status = '1', offer_name, offer_type } = req.body;
        if (!subId || !transId || !reward || !signature) return res.status(400).send('ERROR: Missing params');
        const expectedSig = crypto.createHash('md5').update(`${subId}${transId}${reward}${OFFERWALL_SECRET_KEY}`).digest('hex');
        if (signature !== expectedSig) return res.status(403).send('ERROR: Signature mismatch');
        const userRef = db.collection('users').doc(subId);
        const doc = await userRef.get();
        if (!doc.exists) return res.status(404).send('ERROR: User not found');
        if (doc.data().banned) return res.status(403).send('ERROR: User banned');
        const existingTx = await db.collection('offerwall_completions').where('trans_id', '==', transId).limit(1).get();
        if (!existingTx.empty) return res.status(200).send('ok');
        const baseAmt = Number(reward);
        if (isNaN(baseAmt) || baseAmt <= 0) return res.status(400).send('ERROR: Invalid reward');
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
            } else if (numericStatus === 2) {
                const deductAmt = Math.min(baseAmt, currentBalance);
                if (deductAmt > 0) {
                    t.update(userRef, {
                        balance: increment(-deductAmt),
                        total_earned: increment(-deductAmt),
                        total_offerwall_earned: increment(-deductAmt)
                    });
                }
            }
            t.set(db.collection('offerwall_completions').doc(transId), {
                user_id: subId, trans_id: transId, task_type: taskType,
                offer_name: offer_name || 'Unknown',
                base_amount: baseAmt, bonus_amount: bonusAmt, amount: totalAmt,
                status: numericStatus === 1 ? 'completed' : 'chargeback',
                timestamp: serverTimestamp()
            });
        });
        if (numericStatus === 1) await giveReferralBonus(subId, baseAmt, taskType);
        await logAction('offerwall_completed', subId, { transId, totalAmt });
        res.status(200).send('ok');
    } catch (err) {
        logger.error('Postback error', { error: err.message });
        res.status(500).send('ERROR: Server error');
    }
}

// ============================================
// AUTH
// ============================================
async function auth(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    const { initData, ref } = req.body;
    if (!initData) return res.status(400).json({ error: 'Missing initData' });
    if (!validateTelegramInitData(initData)) return res.status(403).json({ error: 'Invalid signature' });
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
                telegram_id: userId, username: user.username || null, first_name: user.first_name || null,
                balance: 0, doge_balance: 0, total_earned: 0,
                total_claims: 0, total_withdrawals: 0,
                referrals: 0, referral_earnings: 0, referral_balance: 0,
                referred_by: ref || null, banned: false,
                is_admin: String(userId) === String(ADMIN_TELEGRAM_ID),
                last_claim: null, created_at: serverTimestamp()
            };
            await userRef.set(newUser);
            if (ref && ref !== userId) {
                const refRef = db.collection('users').doc(String(ref));
                const refDoc = await refRef.get();
                if (refDoc.exists && !refDoc.data().banned) {
                    await refRef.update({
                        referrals: increment(1),
                        referral_balance: increment(REFERRAL_SIGNUP_BONUS),
                        referral_earnings: increment(REFERRAL_SIGNUP_BONUS)
                    });
                }
            }
            await logAction('user_register', userId, { ref });
        } else {
            if (doc.data().banned) return res.status(403).json({ error: 'User banned' });
        }
        const token = jwt.sign({ userId, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, user_id: userId, username: user.username, token, isNew });
    } catch (err) {
        logger.error('Auth error', { error: err.message });
        res.status(500).json({ error: 'Auth failed' });
    }
}

// ============================================
// USER ENDPOINTS
// ============================================
async function getMe(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const userId = String(req.user.userId);
        const doc = await db.collection('users').doc(userId).get();
        if (!doc.exists) return res.status(404).json({ error: 'User not found' });
        const d = doc.data();
        res.json({
            telegram_id: d.telegram_id, username: d.username, first_name: d.first_name,
            balance: d.balance || 0, doge_balance: d.doge_balance || 0,
            total_earned: d.total_earned || 0, total_claims: d.total_claims || 0,
            total_withdrawals: d.total_withdrawals || 0,
            total_offerwall_earned: d.total_offerwall_earned || 0,
            referrals: d.referrals || 0,
            referral_earnings: d.referral_earnings || 0,
            referral_balance: d.referral_balance || 0,
            last_claim: d.last_claim ? d.last_claim.toMillis() : null,
            banned: d.banned || false,
            is_admin: String(d.telegram_id) === String(ADMIN_TELEGRAM_ID)
        });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
}

async function getBalance(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const doc = await db.collection('users').doc(String(req.user.userId)).get();
        if (!doc.exists) return res.json({ balance: 0, doge_balance: 0, referral_balance: 0 });
        const d = doc.data();
        res.json({
            balance: d.balance || 0, doge_balance: d.doge_balance || 0,
            referral_balance: d.referral_balance || 0,
            total_earned: d.total_earned || 0, total_claims: d.total_claims || 0,
            referrals: d.referrals || 0,
            referral_earnings: d.referral_earnings || 0,
            last_claim: d.last_claim ? d.last_claim.toMillis() : null
        });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
}

async function getReferral(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const userId = String(req.user.userId);
        const doc = await db.collection('users').doc(userId).get();
        if (!doc.exists) return res.status(404).json({ error: 'User not found' });
        const d = doc.data();
        const link = `https://t.me/${BOT_USERNAME}?startapp=ref_${userId}`;
        res.json({ link, referrals: d.referrals || 0, earnings: d.referral_earnings || 0, referral_balance: d.referral_balance || 0 });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function giveReferralBonus(userId, amount, type) {
    if (!db || amount <= 0) return;
    try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) return;
        const userData = userDoc.data();
        if (!userData.referred_by) return;
        const referrerId = userData.referred_by;
        const bonusAmount = Math.round(amount * (REFERRAL_COMMISSION_PERCENT / 100) * 100) / 100;
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
            referrer: referrerId, referred: userId, amount: bonusAmount,
            type: type || 'unknown', timestamp: serverTimestamp()
        });
    } catch (e) { logger.error('Referral bonus error', { error: e.message }); }
}

async function collectReferralBonus(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    const userId = String(req.user.userId);
    const userRef = db.collection('users').doc(userId);
    try {
        let collected = 0;
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) throw new Error('User not found');
            const d = doc.data();
            const rb = d.referral_balance || 0;
            if (rb <= 0) throw new Error('No referral balance');
            collected = rb;
            t.update(userRef, { balance: increment(rb), referral_balance: increment(-rb) });
        });
        await logAction('referral_collected', userId, { amount: collected });
        res.json({ success: true, amount: collected });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function claim(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    const userId = String(req.user.userId);
    const { captchaAnswer } = req.body;
    if (!captchaAnswer) return res.status(400).json({ error: 'Captcha required', captchaRequired: true });
    const captchaResult = verifyCaptcha(userId, captchaAnswer);
    if (!captchaResult.valid) return res.status(403).json({ error: captchaResult.error, captchaRequired: true });
    const userRef = db.collection('users').doc(userId);
    try {
        const now = Date.now();
        let newBalance = 0;
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) throw new Error('User not found');
            const d = doc.data();
            if (d.banned) throw new Error('User banned');
            const lastClaim = d.last_claim ? d.last_claim.toMillis() : 0;
            if (now - lastClaim < FAUCET_COOLDOWN) {
                throw new Error(`Cooldown|${FAUCET_COOLDOWN - (now - lastClaim)}`);
            }
            newBalance = (d.balance || 0) + FAUCET_REWARD;
            t.update(userRef, {
                balance: increment(FAUCET_REWARD),
                total_earned: increment(FAUCET_REWARD),
                total_claims: increment(1),
                last_claim: serverTimestamp()
            });
        });
        await giveReferralBonus(userId, FAUCET_REWARD, 'faucet');
        await logAction('faucet_claim', userId, { amount: FAUCET_REWARD });
        res.json({ success: true, amount: FAUCET_REWARD, balance: newBalance });
    } catch (err) {
        const msg = err.message || '';
        if (msg.includes('Cooldown')) {
            const wait = parseInt(msg.split('|')[1]) || FAUCET_COOLDOWN;
            return res.status(429).json({ error: 'Cooldown active', wait });
        }
        if (msg.includes('User banned')) return res.status(403).json({ error: 'User banned' });
        if (msg.includes('User not found')) return res.status(404).json({ error: 'User not found' });
        res.status(500).json({ error: 'Claim failed' });
    }
}

async function swap(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
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
        res.json({ success: true });
    } catch (err) {
        if (err.message === 'User not found') return res.status(404).json({ error: 'User not found' });
        if (err.message === 'User banned') return res.status(403).json({ error: 'User banned' });
        if (err.message?.includes('Insufficient')) return res.status(400).json({ error: err.message });
        res.status(500).json({ error: 'Swap failed' });
    }
}

async function withdraw(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
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
        const ref = await db.collection('withdrawals').add({
            user_id: userId, faucetpay_email, amount: amt, status: 'pending', timestamp: serverTimestamp()
        });
        res.json({ success: true, id: ref.id });
    } catch (err) {
        if (err.message?.includes('Insufficient') || err.message?.includes('Minimum')) return res.status(400).json({ error: err.message });
        res.status(500).json({ error: 'Withdrawal failed' });
    }
}

async function getWithdrawHistory(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const userId = String(req.user.userId);
        const snapshot = await db.collection('withdrawals').where('user_id', '==', userId).orderBy('timestamp', 'desc').limit(50).get();
        res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() })));
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function getDogePrice(req, res) {
    try {
        if (Date.now() - dogePriceCache.lastUpdate > 60000) await fetchDogePrice();
        res.json({ price: dogePriceCache.price, change_24h: dogePriceCache.change, lastUpdate: dogePriceCache.lastUpdate });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

// ============================================
// CAPTCHA
// ============================================
const activeCaptchas = new Map();

function generateMathCaptcha(userId) {
    if (activeCaptchas.size > 5000) {
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
    if (!captcha) return { valid: false, error: 'No active captcha' };
    if (Date.now() > captcha.expiresAt) {
        activeCaptchas.delete(userId);
        return { valid: false, error: 'Captcha expired' };
    }
    if (parseInt(userAnswer) !== captcha.answer) {
        activeCaptchas.delete(userId);
        return { valid: false, error: 'Wrong answer' };
    }
    activeCaptchas.delete(userId);
    return { valid: true };
}

setInterval(() => {
    const now = Date.now();
    for (const [userId, captcha] of activeCaptchas) {
        if (now > captcha.expiresAt) activeCaptchas.delete(userId);
    }
}, 60000);

async function getCaptcha(req, res) {
    try {
        const userId = String(req.user.userId);
        const captcha = generateMathCaptcha(userId);
        res.json({ success: true, question: captcha.question, n1: captcha.n1, n2: captcha.n2 });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function verifyCaptchaEndpoint(req, res) {
    try {
        const userId = String(req.user.userId);
        const { answer } = req.body;
        if (!answer) return res.status(400).json({ valid: false, error: 'Answer required' });
        res.json(verifyCaptcha(userId, answer));
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

// ============================================
// PROMO CODES
// ============================================
function validatePromoCode(code) {
    if (!code) return null;
    const trimmed = String(code).trim().toUpperCase();
    if (trimmed.length < 3 || trimmed.length > 32) return null;
    if (!/^[A-Z0-9_-]+$/.test(trimmed)) return null;
    return trimmed;
}

async function redeemPromo(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const code = validatePromoCode(req.body.code);
        if (!code) return res.status(400).json({ error: 'Invalid code' });
        const userId = String(req.user.userId);
        const promoRef = db.collection('promoCodes').doc(code);
        const promoDoc = await promoRef.get();
        if (!promoDoc.exists) return res.status(400).json({ error: 'Invalid code' });
        const promo = promoDoc.data();
        if (promo.enabled === false) return res.status(400).json({ error: 'Code disabled' });
        if (promo.expiresAt) {
            const expTs = promo.expiresAt.toDate ? promo.expiresAt.toDate() : new Date(promo.expiresAt);
            if (expTs < new Date()) return res.status(400).json({ error: 'Code expired' });
        }
        if ((promo.usedCount || 0) >= (promo.usageLimit || promo.maxUses || 0)) return res.status(400).json({ error: 'Code usage limit reached' });
        if (promo.usedBy && Array.isArray(promo.usedBy) && promo.usedBy.includes(userId)) return res.status(400).json({ error: 'You already used this code' });
        const userRef = db.collection('users').doc(userId);
        const field = (promo.coin === 'DOGE') ? 'doge_balance' : 'balance';
        const totalField = (promo.coin === 'DOGE') ? 'total_doge_earned' : 'total_earned';
        const reward = Number(promo.reward);
        await db.runTransaction(async (t) => {
            const u = await t.get(userRef);
            if (!u.exists) throw new Error('User not found');
            const ud = u.data();
            if (ud.banned) throw new Error('User banned');
            const freshPromo = await t.get(promoRef);
            const fp = freshPromo.data();
            if (fp.enabled === false) throw new Error('Code disabled');
            if (fp.expiresAt) {
                const expTs = fp.expiresAt.toDate ? fp.expiresAt.toDate() : new Date(fp.expiresAt);
                if (expTs < new Date()) throw new Error('Code expired');
            }
            if ((fp.usedCount || 0) >= (fp.usageLimit || fp.maxUses || 0)) throw new Error('Code usage limit reached');
            if (fp.usedBy && Array.isArray(fp.usedBy) && fp.usedBy.includes(userId)) throw new Error('You already used this code');
            t.update(userRef, {
                [field]: increment(reward),
                [totalField]: increment(reward),
                promo_earnings: increment((promo.coin === 'DOGE') ? 0 : reward),
                total_promo_earned: increment((promo.coin === 'DOGE') ? 0 : reward),
                promo_used_count: increment(1)
            });
            t.update(promoRef, {
                usedCount: increment(1),
                usedBy: FieldValue ? FieldValue.arrayUnion(userId) : [...(fp.usedBy || []), userId]
            });
            const useRef = db.collection('promo_uses').doc();
            t.set(useRef, {
                user_id: userId, code, reward, coin: promo.coin,
                timestamp: serverTimestamp()
            });
        });
        await logAction('promo_redeem', userId, { code, reward, coin: promo.coin });
        res.json({ success: true, code, reward, coin: promo.coin });
    } catch (err) {
        return res.status(400).json({ error: err.message || 'Failed to redeem' });
    }
}

async function getPromoHistory(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const userId = String(req.user.userId);
        const snap = await db.collection('promo_uses').where('user_id', '==', userId).orderBy('timestamp', 'desc').limit(50).get();
        const history = snap.docs.map(d => {
            const data = d.data();
            return { id: d.id, code: data.code, reward: data.reward, coin: data.coin, usedAt: data.timestamp?.toMillis ? data.timestamp.toMillis() : null };
        });
        const totalBonus = history.reduce((s, h) => s + (h.reward || 0), 0);
        res.json({ history, totalBonus, count: history.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
}

// ============================================
// ADMIN ENDPOINTS
// ============================================
async function adminListPromos(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const snap = await db.collection('promoCodes').orderBy('createdAt', 'desc').get();
        const list = snap.docs.map(d => {
            const data = d.data();
            return {
                code: d.id, coin: data.coin || 'CNX', reward: data.reward || 0,
                usageLimit: data.usageLimit || 0, usedCount: data.usedCount || 0,
                enabled: data.enabled !== false,
                createdAt: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
                expiresAt: data.expiresAt?.toMillis ? data.expiresAt.toMillis() : null
            };
        });
        res.json(list);
    } catch (err) { res.status(500).json({ error: err.message }); }
}

async function adminCreatePromo(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const code = validatePromoCode(req.body.code);
        const { coin = 'CNX' } = req.body;
        const reward = Number(req.body.reward);
        const usageLimit = req.body.usageLimit ? parseInt(req.body.usageLimit) : 100;
        const expiresAt = req.body.expiresAt || null;
        if (!code) return res.status(400).json({ error: 'Invalid code' });
        if (!reward || reward <= 0 || isNaN(reward)) return res.status(400).json({ error: 'Invalid reward' });
        if (!['CNX', 'DOGE'].includes(coin)) return res.status(400).json({ error: 'Coin must be CNX or DOGE' });
        const promoRef = db.collection('promoCodes').doc(code);
        if ((await promoRef.get()).exists) return res.status(400).json({ error: 'Code already exists' });
        await promoRef.set({
            code, coin, reward, usageLimit, usedCount: 0, usedBy: [], enabled: true,
            createdBy: req.user.userId, createdAt: serverTimestamp(),
            expiresAt: expiresAt ? new Date(expiresAt) : null
        });
        await logAction('promo_create', req.user.userId, { code, coin, reward, usageLimit });
        res.json({ success: true, code, coin, reward, usageLimit });
    } catch (err) { res.status(500).json({ error: err.message }); }
}

async function adminTogglePromo(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const code = validatePromoCode(req.body.code);
        if (!code) return res.status(400).json({ error: 'Invalid code' });
        await db.collection('promoCodes').doc(code).update({ enabled: !!req.body.enabled });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
}

async function adminDeletePromo(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const code = validatePromoCode(req.body.code);
        if (!code) return res.status(400).json({ error: 'Invalid code' });
        await db.collection('promoCodes').doc(code).delete();
        await logAction('promo_delete', req.user.userId, { code });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
}

async function adminGetUsers(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const snap = await db.collection('users').orderBy('created_at', 'desc').limit(200).get();
        res.json(snap.docs.map(d => ({ id: d.id, ...d.data(), created_at: d.data().created_at?.toMillis() })));
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function adminGetWithdrawals(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const snap = await db.collection('withdrawals').orderBy('timestamp', 'desc').limit(200).get();
        res.json(snap.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() })));
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function adminApproveWithdrawal(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const id = req.body.id;
        if (!id) return res.status(400).json({ error: 'id required' });
        await db.collection('withdrawals').doc(id).update({ status: 'approved', approved_at: serverTimestamp() });
        await logAction('withdrawal_approved', req.user.userId, { id });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function adminRejectWithdrawal(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const id = req.body.id;
        if (!id) return res.status(400).json({ error: 'id required' });
        const wdRef = db.collection('withdrawals').doc(id);
        const wd = await wdRef.get();
        if (!wd.exists) return res.status(404).json({ error: 'Not found' });
        const wdData = wd.data();
        if (wdData.status === 'approved') return res.status(400).json({ error: 'Already approved' });
        await db.runTransaction(async (t) => {
            const u = await t.get(db.collection('users').doc(String(wdData.user_id)));
            if (u.exists) t.update(u.ref, { doge_balance: increment(wdData.amount || 0) });
            t.update(wdRef, { status: 'rejected', rejected_at: serverTimestamp() });
        });
        await logAction('withdrawal_rejected', req.user.userId, { id });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function adminBanUser(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: 'userId required' });
        await db.collection('users').doc(String(userId)).update({ banned: true });
        await logAction('user_ban', req.user.userId, { bannedUser: String(userId) });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function adminUnbanUser(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: 'userId required' });
        await db.collection('users').doc(String(userId)).update({ banned: false });
        await logAction('user_unban', req.user.userId, { unbannedUser: String(userId) });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function adminAddBalance(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const { userId, amount, currency } = req.body;
        if (!userId || !amount) return res.status(400).json({ error: 'userId and amount required' });
        const field = currency === 'doge' ? 'doge_balance' : 'balance';
        await db.collection('users').doc(String(userId)).update({ [field]: increment(Number(amount)) });
        await logAction('admin_add_balance', req.user.userId, { userId: String(userId), amount, currency });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function adminGetLogs(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const snap = await db.collection('logs').orderBy('timestamp', 'desc').limit(100).get();
        res.json(snap.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() })));
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function adminGetStats(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const [usersSnap, wdSnap, offerSnap, claimsSnap] = await Promise.all([
            db.collection('users').get(),
            db.collection('withdrawals').get(),
            db.collection('offerwall_completions').get(),
            db.collection('logs').where('action', '==', 'faucet_claim').get().catch(() => ({ size: 0, docs: [] }))
        ]);
        res.json({
            totalUsers: usersSnap.size,
            totalWithdrawals: wdSnap.size,
            totalPaid: wdSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0),
            totalOfferwall: offerSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0),
            totalClaims: claimsSnap.size,
            bannedUsers: usersSnap.docs.filter(d => d.data().banned).length
        });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function adminGetSettings(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const doc = await db.collection('settings').doc('global').get();
        res.json(doc.exists ? doc.data() : {});
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function adminUpdateSettings(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        await db.collection('settings').doc('global').set(req.body, { merge: true });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function adminBroadcast(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const { message, target } = req.body;
        if (!message) return res.status(400).json({ error: 'message required' });
        await db.collection('broadcasts').add({
            message, target: target || 'all', sentBy: req.user.userId, timestamp: serverTimestamp()
        });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function getGlobalStats(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const usersSnap = await db.collection('users').get();
        const wdSnap = await db.collection('withdrawals').get();
        res.json({
            totalUsers: usersSnap.size,
            activeToday: usersSnap.docs.filter(d => d.data().last_claim && (Date.now() - d.data().last_claim.toMillis() < 86400000)).length,
            totalPaid: wdSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0)
        });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

// ============================================
// EXPRESS APP
// ============================================
const app = express();

process.on('unhandledRejection', (err) => logger.error('Unhandled Rejection', { error: err.message }));
process.on('uncaughtException', (err) => logger.error('Uncaught Exception', { error: err.message }));

setupSecurity(app);
app.use(cors({ origin: true, credentials: true }));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================
// 🔍 DEBUG ENDPOINTS (TEST İÇİN)
// ============================================
app.get('/debug/env', (req, res) => {
    const token = process.env.BOT_TOKEN;
    res.json({
        botTokenExists: !!token,
        botTokenLength: token ? token.length : 0,
        botTokenFirst10: token ? token.substring(0, 10) + '...' : 'MISSING',
        botTokenLast10: token ? '...' + token.substring(token.length - 10) : 'MISSING',
        hasLeadingSpace: token ? token.startsWith(' ') : false,
        hasTrailingSpace: token ? token.endsWith(' ') : false,
        hasNewLine: token ? (token.includes('\n') || token.includes('\r')) : false,
        expectedLength: 46,
        allBotEnv: {
            BOT_TOKEN: token ? `${token.substring(0, 10)}...` : 'MISSING',
            BOT_USERNAME: process.env.BOT_USERNAME || 'MISSING',
            JWT_SECRET: process.env.JWT_SECRET ? `${process.env.JWT_SECRET.substring(0, 5)}...` : 'MISSING'
        }
    });
});

app.post('/debug/auth-test', (req, res) => {
    const { initData } = req.body;
    const token = process.env.BOT_TOKEN;
    
    if (!initData) return res.status(400).json({ error: 'Missing initData in body' });
    if (!token) return res.status(400).json({ error: 'BOT_TOKEN env is missing' });
    
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        
        if (!hash) {
            return res.status(400).json({ 
                error: 'Missing hash in initData',
                initDataPreview: initData.substring(0, 200)
            });
        }
        
        urlParams.delete('hash');
        urlParams.sort();
        
        const dataCheckString = Array.from(urlParams.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join('\n');
        
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
        const checkHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        
        let user = null;
        try {
            user = JSON.parse(urlParams.get('user'));
        } catch (e) {
            user = { parseError: e.message };
        }
        
        res.json({
            success: hash === checkHash,
            match: hash === checkHash,
            receivedHash: hash,
            computedHash: checkHash,
            hashesMatch: hash === checkHash,
            tokenLength: token.length,
            tokenPreview: `${token.substring(0, 10)}...`,
            dataCheckStringLength: dataCheckString.length,
            user: user,
            initDataKeys: Array.from(new URLSearchParams(initData).keys())
        });
    } catch (e) {
        res.status(500).json({ error: e.message, stack: e.stack });
    }
});

app.get('/debug/firebase', (req, res) => {
    res.json({
        firebaseInitialized: firebaseInitialized,
        dbExists: !!db,
        serviceAccountExists: !!serviceAccount,
        timestamp: new Date().toISOString()
    });
});
// ============================================
// 🔍 DEBUG ENDPOINTS SONU
// ============================================

// ============================================
// ROUTES
// ============================================
app.get('/ping', (req, res) => res.status(200).send('OK'));
app.get('/api/health', (req, res) => res.json({ ok: true, db: firebaseInitialized, ts: Date.now() }));

app.post('/api/auth', authLimiter, auth);
app.use('/api', generalLimiter);

app.get('/api/me', jwtAuth, getMe);
app.get('/api/balance', jwtAuth, getBalance);
app.get('/api/captcha', jwtAuth, getCaptcha);
app.post('/api/captcha/verify', jwtAuth, verifyCaptchaEndpoint);
app.post('/api/claim', claimLimiter, jwtAuth, claim);
app.post('/api/swap', jwtAuth, swap);
app.post('/api/withdraw', withdrawLimiter, jwtAuth, withdraw);
app.get('/api/withdrawals', jwtAuth, getWithdrawHistory);
app.get('/api/referral', jwtAuth, getReferral);
app.post('/api/referral/collect', jwtAuth, collectReferralBonus);
app.get('/api/doge-price', getDogePrice);
app.get('/api/offerwall/offerwall', jwtAuth, getOfferwallUrl);
app.get('/api/offerwall/ptc', jwtAuth, getPTCAds);
app.get('/api/offerwall/shortlinks', jwtAuth, getShortlinks);
app.get('/api/offerwall/games', jwtAuth, getGames);
app.post('/api/postback', postback);
app.post('/api/offerwall-postback', postback);
app.post('/api/promo/redeem', promoLimiter, jwtAuth, redeemPromo);
app.get('/api/promo/history', jwtAuth, getPromoHistory);
app.get('/api/stats/global', getGlobalStats);

app.get('/api/admin/stats', adminAuth, adminGetStats);
app.get('/api/admin/users', adminAuth, adminGetUsers);
app.get('/api/admin/withdrawals', adminAuth, adminGetWithdrawals);
app.post('/api/admin/approve-withdrawal', adminAuth, adminApproveWithdrawal);
app.post('/api/admin/reject-withdrawal', adminAuth, adminRejectWithdrawal);
app.post('/api/admin/add-balance', adminAuth, adminAddBalance);
app.post('/api/admin/ban-user', adminAuth, adminBanUser);
app.post('/api/admin/unban-user', adminAuth, adminUnbanUser);
app.get('/api/admin/logs', adminAuth, adminGetLogs);
app.get('/api/admin/settings', adminAuth, adminGetSettings);
app.post('/api/admin/settings', adminAuth, adminUpdateSettings);
app.post('/api/admin/broadcast', adminAuth, adminBroadcast);
app.get('/api/admin/promo/list', adminAuth, adminListPromos);
app.post('/api/admin/promo/create', adminAuth, adminCreatePromo);
app.post('/api/admin/promo/toggle', adminAuth, adminTogglePromo);
app.post('/api/admin/promo/delete', adminAuth, adminDeletePromo);

// ============================================
// ⭐ STATIC FILE SERVING (Render)
// ============================================
const publicPath = path.join(__dirname, '..');
console.log('[Static] Serving files from:', publicPath);

app.use(express.static(publicPath, {
    maxAge: '1d',
    setHeaders: (res, p) => {
        if (p.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
    }
}));

// ============================================
// ⭐ SPA FALLBACK
// ============================================
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'API endpoint not found' });
    }
    const indexPath = path.join(publicPath, 'index.html');
    res.sendFile(indexPath, (err) => {
        if (err) {
            logger.error('index.html not found', { path: indexPath, error: err.message });
            res.status(404).send('App not found');
        }
    });
});

// Error handler
app.use((err, req, res, next) => {
    logger.error('Express error', { error: err.message, path: req.path });
    res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;

if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        logger.info(`Coinix backend listening on port ${PORT}`);
        logger.info(`Static path: ${publicPath}`);
        logger.info(`App URL: ${APP_URL}`);
    });
    
    // ⭐ KEEP-ALIVE PING (Render free tier spin-down önleme)
    setInterval(() => {
        fetch(`${APP_URL}/ping`).catch(() => {});
    }, 14 * 60 * 1000);
}

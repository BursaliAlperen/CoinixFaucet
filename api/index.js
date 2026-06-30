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
let serviceAccount = null, firebaseInitialized = false, db = null, FieldValue = null, Timestamp = null;
let serverTimestamp = () => new Date(), increment = (n) => n;

try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        console.log('[Firebase] Using FIREBASE_SERVICE_ACCOUNT_JSON');
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
        serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'));
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
        console.log('[Firebase] ✅ Initialized successfully');
    } else { 
        console.warn('[Firebase] ⚠️ Running WITHOUT database'); 
    }
} catch (e) { 
    console.error('[Firebase] ❌ Init error:', e.message); 
    firebaseInitialized = false; 
    db = null; 
}

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
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '';
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || JWT_SECRET;
const APP_URL = process.env.APP_URL || 'https://coinixfaucet.onrender.com';
const PORT = process.env.PORT || 10000;

function validateCriticalConfig() {
    const missing = [];
    if (!BOT_TOKEN) missing.push('BOT_TOKEN');
    if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
    if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON && !process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
        missing.push('FIREBASE_SERVICE_ACCOUNT');
    }
    if (missing.length) {
        console.error('[CONFIG] ❌ MISSING:', missing.join(', '));
    } else {
        console.log('[CONFIG] ✅ All critical env vars present');
    }
}
validateCriticalConfig();

// ============================================
// MULTI-COIN CONFIG
// ============================================
const CNX_USD_VALUE = 0.01;
const COOLDOWN_MS = 10000;
const DAILY_LIMIT = 100;

const COINS = {
    doge: { symbol: 'DOGE', claimAmount: 0.004, priceId: 'dogecoin', decimals: 4 },
    pepe: { symbol: 'PEPE', claimAmount: 1000, priceId: 'pepe', decimals: 0 },
    pol:  { symbol: 'POL',  claimAmount: 0.05, priceId: 'polygon-ecosystem-token', decimals: 2 },
    feyorra: { symbol: 'FEYORRA', claimAmount: 1, priceId: null, decimals: 0, fixedPrice: 0.001 },
    dgb:  { symbol: 'DGB',  claimAmount: 1.5, priceId: 'digibyte', decimals: 2 }
};

const REFERRAL_SIGNUP_BONUS = 1;
const REFERRAL_COMMISSION_PERCENT = 20;

// ============================================
// PRICE CACHE
// ============================================
let priceCache = { lastUpdate: 0 };

async function fetchPrices() {
    try {
        const ids = Object.values(COINS).map(c => c.priceId).filter(Boolean).join(',');
        if (!ids) return priceCache;
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        
        const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, { 
            signal: controller.signal 
        });
        
        clearTimeout(timeout);
        
        if (!res.ok) return priceCache;
        const data = await res.json();
        
        Object.values(COINS).forEach(c => {
            if (c.priceId && data[c.priceId]?.usd != null) {
                priceCache[c.priceId] = data[c.priceId].usd;
            } else if (c.fixedPrice) {
                priceCache[c.priceId || c.symbol] = c.fixedPrice;
            }
        });
        
        priceCache.lastUpdate = Date.now();
        return priceCache;
    } catch (err) { 
        logger.error('Price fetch error', { error: err.message }); 
        return priceCache; 
    }
}

fetchPrices();
setInterval(fetchPrices, 120000);

function getCoinPrice(coinId) {
    const c = COINS[coinId];
    if (!c) return 0;
    return priceCache[c.priceId || c.symbol] || c.fixedPrice || 0;
}

function getMinWithdrawAmount(coinId) {
    const price = getCoinPrice(coinId);
    if (!price || price <= 0) return Infinity;
    return 0.03 / price;
}

function fmt(amount, decimals = 2) {
    return Number(amount).toFixed(decimals);
}

// ============================================
// SECURITY
// ============================================
function setupSecurity(app) {
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'", "https://richinfo.co", "https://*.richinfo.co"],
                scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://telegram.org", "https://richinfo.co", "https://*.richinfo.co", "https://dgbmining.pro", "https://adbits.online"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                fontSrc: ["'self'", "data:"],
                imgSrc: ["'self'", "data:", "https:", "blob:"],
                connectSrc: ["'self'", "https://*.googleapis.com", "https://*.firebaseio.com", "https://api.coingecko.com", "https://richinfo.co"],
                frameSrc: ["'self'", "https://richinfo.co", "https://adbits.online"],
                objectSrc: ["'none'"],
                upgradeInsecureRequests: []
            }
        },
        crossOriginEmbedderPolicy: false,
        hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
    }));
}

const generalLimiter = rateLimit({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 300000, max: 20, standardHeaders: true, legacyHeaders: false });
const claimLimiter = rateLimit({ windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false });
const withdrawLimiter = rateLimit({ windowMs: 3600000, max: 10, standardHeaders: true, legacyHeaders: false });
const swapLimiter = rateLimit({ windowMs: 60000, max: 20, standardHeaders: true, legacyHeaders: false });

// ============================================
// NONCE / REPLAY GUARD
// ============================================
const usedNonces = new Map();
const NONCE_MAX_AGE = 5 * 60 * 1000;

function validateNonce(nonce, timestamp) {
    if (!nonce || !timestamp) return { valid: false, error: 'Nonce and timestamp required' };
    const ts = parseInt(timestamp);
    if (isNaN(ts) || Math.abs(Date.now() - ts) > 300000) return { valid: false, error: 'Request expired' };
    const key = `${nonce}:${ts}`;
    if (usedNonces.has(key)) return { valid: false, error: 'Duplicate request' };
    usedNonces.set(key, Date.now());
    return { valid: true };
}

setInterval(() => { 
    const now = Date.now(); 
    for (const [key, time] of usedNonces) { 
        if (now - time > NONCE_MAX_AGE) usedNonces.delete(key); 
    } 
}, 60000);

// ============================================
// AUTH
// ============================================
function validateTelegramInitData(initData) {
    if (!initData || !BOT_TOKEN) return false;
    try {
        const pairs = initData.split('&');
        const params = {}; 
        let hash = '';
        
        for (const pair of pairs) {
            const idx = pair.indexOf('=');
            if (idx === -1) continue;
            const key = pair.substring(0, idx);
            const value = pair.substring(idx + 1);
            if (key === 'hash') hash = value; 
            else params[key] = value;
        }
        
        if (!hash) return false;
        
        if (params.auth_date) {
            const authDate = parseInt(params.auth_date, 10);
            const now = Math.floor(Date.now() / 1000);
            if (!isNaN(authDate) && Math.abs(now - authDate) > 300) return false;
        }
        
        const entries = Object.keys(params).sort().map(k => `${k}=${params[k]}`);
        const dataCheckString = entries.join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const checkHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        
        const a = Buffer.from(hash, 'hex'); 
        const b = Buffer.from(checkHash, 'hex');
        
        if (a.length !== b.length || a.length === 0) return false;
        return crypto.timingSafeEqual(a, b);
    } catch (e) { 
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
        return res.status(403).json({ error: 'Invalid token' }); 
    }
}

function adminAuth(req, res, next) {
    const key = req.headers['x-admin-key'];
    if (!ADMIN_SECRET_KEY || key !== ADMIN_SECRET_KEY) return res.status(403).json({ error: 'Forbidden' });
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(403).json({ error: 'Admin token required' });
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        if (!payload.is_admin) return res.status(403).json({ error: 'Admin only' });
        req.user = payload; 
        next();
    } catch (e) { 
        return res.status(403).json({ error: 'Invalid admin token' }); 
    }
}

// ============================================
// UTILS
// ============================================
async function logAction(action, userId, details = {}) {
    if (!db) return;
    try { 
        await db.collection('logs').add({ 
            action, 
            user_id: String(userId), 
            details, 
            timestamp: serverTimestamp() 
        }); 
    } catch (e) {}
}

async function logTransaction(userId, type, amount, currency, description, metadata = {}) {
    if (!db) return;
    try { 
        await db.collection('transactions').add({ 
            user_id: String(userId), 
            type, 
            amount: Number(amount), 
            currency: currency || 'CNX', 
            description, 
            metadata, 
            timestamp: serverTimestamp() 
        }); 
    } catch (e) {}
}

async function createNotification(userId, title, message, type = 'general') {
    if (!db) return;
    try { 
        await db.collection('notifications').add({ 
            user_id: String(userId), 
            title, 
            message, 
            type, 
            read: false, 
            timestamp: serverTimestamp() 
        }); 
    } catch (e) {}
}

function getClientIP(req) { 
    return (req.headers['x-forwarded-for'] || '0.0.0.0').split(',')[0].trim(); 
}

function tsToMillis(ts) { 
    if (!ts) return null; 
    if (ts.toMillis) return ts.toMillis(); 
    if (ts instanceof Date) return ts.getTime(); 
    return null; 
}

// ============================================
// TELEGRAM BOT HELPERS
// ============================================
async function sendTelegramMessage(chatId, text, parseMode = 'HTML') {
    if (!BOT_TOKEN) return { ok: false };
    try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode })
        });
        return await res.json();
    } catch (e) { 
        return { ok: false, error: e.message }; 
    }
}

async function broadcastToUsers(message) {
    if (!db || !BOT_TOKEN) return { sent: 0, failed: 0 };
    let sent = 0, failed = 0;
    try {
        const snap = await db.collection('users').where('banned', '!=', true).limit(500).get();
        for (const doc of snap.docs) {
            const user = doc.data();
            if (!user.telegram_id || user.banned) continue;
            const res = await sendTelegramMessage(user.telegram_id, message, 'Markdown');
            if (res.ok) sent++; 
            else failed++;
            await new Promise(r => setTimeout(r, 35));
        }
    } catch (e) {}
    return { sent, failed };
}

// ============================================
// CAPTCHA
// ============================================
const activeCaptchas = new Map();

function generateMathCaptcha(userId, coinId) {
    if (!activeCaptchas.has(coinId)) activeCaptchas.set(coinId, new Map());
    const coinMap = activeCaptchas.get(coinId);
    
    if (coinMap.size > 5000) { 
        const firstKey = coinMap.keys().next().value; 
        coinMap.delete(firstKey); 
    }
    
    const n1 = Math.floor(Math.random() * 10) + 1;
    const n2 = Math.floor(Math.random() * 10) + 1;
    const answer = n1 + n2;
    
    coinMap.set(userId, { answer, expiresAt: Date.now() + 5 * 60 * 1000 });
    return { n1, n2, question: `${n1} + ${n2} = ?` };
}

function verifyCaptcha(userId, coinId, userAnswer) {
    const coinMap = activeCaptchas.get(coinId);
    if (!coinMap) return { valid: false, error: 'No active captcha' };
    
    const captcha = coinMap.get(userId);
    if (!captcha) return { valid: false, error: 'No active captcha' };
    
    if (Date.now() > captcha.expiresAt) { 
        coinMap.delete(userId); 
        return { valid: false, error: 'Captcha expired' }; 
    }
    
    if (parseInt(userAnswer) !== captcha.answer) { 
        coinMap.delete(userId); 
        return { valid: false, error: 'Wrong answer' }; 
    }
    
    coinMap.delete(userId);
    return { valid: true };
}

setInterval(() => {
    const now = Date.now();
    for (const [coinId, coinMap] of activeCaptchas) {
        for (const [userId, captcha] of coinMap) { 
            if (now > captcha.expiresAt) coinMap.delete(userId); 
        }
    }
}, 60000);

// ============================================
// MILESTONE REWARD
// ============================================
function getMilestoneReward(totalClaims) {
    if (totalClaims < 25) return 0;
    let base = 25, reward = 0.10;
    while (base <= totalClaims) { 
        if (totalClaims === base) return reward; 
        base *= 10; 
        reward *= 10; 
    }
    return 0;
}

// ============================================
// REFERRAL SYSTEM
// ============================================
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
                referral_earnings: increment(bonusAmount) 
            });
        });
        
        await db.collection('referralBonuses').add({ 
            referrer: referrerId, 
            referred: userId, 
            amount: bonusAmount, 
            type: type || 'unknown', 
            timestamp: serverTimestamp() 
        });
        
        await logTransaction(referrerId, 'referral', bonusAmount, 'CNX', 
            `Referral bonus from ${userId}`, { referred: userId, sourceType: type });
    } catch (e) {}
}

// ============================================
// AUTH ENDPOINT
// ============================================
async function auth(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    
    const { initData, ref, device_fp, nonce, timestamp } = req.body;
    
    if (!initData) return res.status(400).json({ error: 'Missing initData' });
    if (!validateTelegramInitData(initData)) return res.status(403).json({ error: 'Invalid signature' });
    
    if (nonce && timestamp) { 
        const nc = validateNonce(nonce, timestamp); 
        if (!nc.valid) return res.status(403).json({ error: nc.error }); 
    }
    
    let user; 
    try {
        const pairs = initData.split('&'); 
        let userStr = '';
        for (const pair of pairs) { 
            const idx = pair.indexOf('='); 
            if (idx === -1) continue; 
            if (pair.substring(0, idx) === 'user') { 
                userStr = decodeURIComponent(pair.substring(idx + 1)); 
                break; 
            } 
        }
        user = JSON.parse(userStr);
    } catch (e) { 
        return res.status(400).json({ error: 'Bad user data' }); 
    }
    
    if (!user || !user.id) return res.status(400).json({ error: 'No user data' });
    
    const userId = String(user.id);
    const userRef = db.collection('users').doc(userId);
    
    if (ref && ref === userId) return res.status(400).json({ error: 'Self referral not allowed' });
    
    if (device_fp) {
        try {
            const deviceId = String(device_fp).slice(0, 64);
            const deviceRef = db.collection('devices').doc(deviceId);
            const deviceDoc = await deviceRef.get();
            
            if (deviceDoc.exists) { 
                const boundTo = deviceDoc.data().telegram_id; 
                if (boundTo && String(boundTo) !== userId) {
                    return res.status(403).json({ error: 'Device already linked to another account.' }); 
                } 
            } else { 
                await deviceRef.set({ 
                    telegram_id: userId, 
                    first_seen: serverTimestamp(), 
                    ua: req.headers['user-agent'] || null 
                }); 
            }
        } catch (e) {}
    }
    
    try {
        const doc = await userRef.get();
        const isNew = !doc.exists;
        
        if (isNew) {
            const newUser = {
                telegram_id: userId, 
                username: user.username || null, 
                first_name: user.first_name || null, 
                photo_url: user.photo_url || null,
                balance: 0, 
                balances: { doge: 0, pepe: 0, pol: 0, feyorra: 0, dgb: 0 },
                total_earned: 0, 
                total_claims: 0, 
                total_withdrawals: 0, 
                total_swaps: 0,
                referrals: 0,  
                referral_earnings: 0, 
                referral_balance: 0, 
                referred_by: ref || null,
                banned: false, 
                is_admin: String(userId) === String(ADMIN_TELEGRAM_ID),
                last_claim: null, 
                last_active: serverTimestamp(), 
                created_at: serverTimestamp(),
                daily_claims: {}, 
                last_claim_times: {}, 
                country: req.headers['cf-ipcountry'] || null
            };
            
            await userRef.set(newUser);
            
            if (ref && ref !== userId) {
                const refRef = db.collection('users').doc(String(ref));
                const refDoc = await refRef.get();
                
                if (refDoc.exists && !refDoc.data().banned) {
                    const existingRef = await db.collection('referralBonuses')
                        .where('referred', '==', userId)
                        .where('type', '==', 'signup')
                        .limit(1)
                        .get();
                    
                    if (existingRef.empty) {
                        await db.runTransaction(async (t) => {
                            const rdoc = await t.get(refRef); 
                            if (!rdoc.exists) return;
                            t.update(refRef, { 
                                referrals: increment(1), 
                                referral_balance: increment(REFERRAL_SIGNUP_BONUS), 
                                referral_earnings: increment(REFERRAL_SIGNUP_BONUS) 
                            });
                            t.set(db.collection('referralBonuses').doc(), { 
                                referrer: String(ref), 
                                referred: userId, 
                                amount: REFERRAL_SIGNUP_BONUS, 
                                type: 'signup', 
                                timestamp: serverTimestamp() 
                            });
                        });
                    }
                }
            }
            
            await logAction('user_register', userId, { ref });
        } else {
            if (doc.data().banned) return res.status(403).json({ error: 'User banned' });
            await userRef.update({ 
                last_active: serverTimestamp(), 
                username: user.username || doc.data().username, 
                first_name: user.first_name || doc.data().first_name, 
                photo_url: user.photo_url || doc.data().photo_url 
            });
        }
        
        const isAdmin = String(userId) === String(ADMIN_TELEGRAM_ID);
        const token = jwt.sign(
            { userId, username: user.username, is_admin: isAdmin }, 
            JWT_SECRET, 
            { expiresIn: '7d' }
        );
        
        res.json({ 
            success: true, 
            user_id: userId, 
            username: user.username, 
            token, 
            isNew, 
            is_admin: isAdmin 
        });
        
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
            telegram_id: d.telegram_id, 
            username: d.username, 
            first_name: d.first_name, 
            photo_url: d.photo_url || null,
            balance: d.balance || 0, 
            balances: d.balances || {},
            total_earned: d.total_earned || 0, 
            total_claims: d.total_claims || 0, 
            total_withdrawals: d.total_withdrawals || 0, 
            total_swaps: d.total_swaps || 0,
            referrals: d.referrals || 0, 
            referral_earnings: d.referral_earnings || 0, 
            referral_balance: d.referral_balance || 0,
            last_claim: tsToMillis(d.last_claim), 
            daily_claims: d.daily_claims || {}, 
            last_claim_times: d.last_claim_times || {},
            banned: d.banned || false, 
            is_admin: String(d.telegram_id) === String(ADMIN_TELEGRAM_ID)
        });
    } catch (err) { 
        res.status(500).json({ error: 'Server error' }); 
    }
}

async function getPrices(req, res) {
    try { 
        if (Date.now() - priceCache.lastUpdate > 60000) await fetchPrices(); 
        res.json(priceCache); 
    } catch (err) { 
        res.status(500).json({ error: 'Failed' }); 
    }
}

async function getCaptcha(req, res) {
    try { 
        const userId = String(req.user.userId); 
        const coinId = req.params.coin; 
        const captcha = generateMathCaptcha(userId, coinId); 
        res.json({ success: true, question: captcha.question }); 
    } catch (err) { 
        res.status(500).json({ error: 'Failed' }); 
    }
}

async function claim(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    
    const userId = String(req.user.userId);
    const coinId = req.params.coin;
    const coinConfig = COINS[coinId];
    
    if (!coinConfig) return res.status(400).json({ error: 'Invalid coin' });
    
    const { captchaAnswer, nonce, timestamp } = req.body;
    
    if (!captchaAnswer) return res.status(400).json({ error: 'Captcha required' });
    
    if (nonce && timestamp) { 
        const nc = validateNonce(nonce, timestamp); 
        if (!nc.valid) return res.status(403).json({ error: nc.error }); 
    }
    
    const captchaResult = verifyCaptcha(userId, coinId, captchaAnswer);
    if (!captchaResult.valid) return res.status(403).json({ error: captchaResult.error });
    
    const userRef = db.collection('users').doc(userId);
    
    try {
        const now = Date.now();
        let result = { amount: 0, milestoneReward: 0, newBalance: 0 };
        
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) throw new Error('User not found');
            const d = doc.data();
            if (d.banned) throw new Error('User banned');
            
            const dailyClaims = d.daily_claims || {};
            const lastClaimDate = d.last_claim_times?.[coinId] ? 
                new Date(d.last_claim_times[coinId].toMillis ? 
                    d.last_claim_times[coinId].toMillis() : 
                    d.last_claim_times[coinId]).toDateString() : null;
            
            const today = new Date().toDateString();
            const todayCount = (lastClaimDate === today) ? (dailyClaims[coinId] || 0) : 0;
            
            if (todayCount >= DAILY_LIMIT) throw new Error('Daily limit reached');
            
            const lastTime = d.last_claim_times?.[coinId] ? 
                (d.last_claim_times[coinId].toMillis ? 
                    d.last_claim_times[coinId].toMillis() : 
                    new Date(d.last_claim_times[coinId]).getTime()) : 0;
            
            if (now - lastTime < COOLDOWN_MS) {
                throw new Error(`Cooldown|${COOLDOWN_MS - (now - lastTime)}`);
            }
            
            const recentClaims = await db.collection('transactions')
                .where('user_id', '==', userId)
                .where('type', '==', 'faucet_claim')
                .where('currency', '==', coinConfig.symbol)
                .where('timestamp', '>=', Timestamp.fromMillis(now - 3000))
                .limit(1)
                .get();
            
            if (!recentClaims.empty) throw new Error('Duplicate claim');
            
            const newBalances = { ...(d.balances || {}) };
            newBalances[coinId] = (newBalances[coinId] || 0) + coinConfig.claimAmount;
            
            const newDaily = { ...dailyClaims };
            newDaily[coinId] = todayCount + 1;
            
            const newClaimTimes = { ...(d.last_claim_times || {}) };
            newClaimTimes[coinId] = serverTimestamp();
            
            const newTotalClaims = (d.total_claims || 0) + 1;
            
            let milestoneReward = 0;
            const milestone = getMilestoneReward(newTotalClaims);
            if (milestone > 0) milestoneReward = milestone;
            
            const updates = {
                balances: newBalances, 
                total_claims: newTotalClaims, 
                daily_claims: newDaily,
                last_claim_times: newClaimTimes, 
                last_active: serverTimestamp()
            };
            
            if (milestoneReward > 0) {
                updates.balance = increment(milestoneReward);
                updates.total_earned = increment(milestoneReward);
            }
            
            t.update(userRef, updates);
            
            t.set(db.collection('transactions').doc(), {
                user_id: userId, 
                type: 'faucet_claim', 
                amount: coinConfig.claimAmount,
                currency: coinConfig.symbol, 
                description: `${coinConfig.symbol} faucet claim`, 
                metadata: { coin: coinId }, 
                timestamp: serverTimestamp()
            });
            
            if (milestoneReward > 0) {
                t.set(db.collection('transactions').doc(), {
                    user_id: userId, 
                    type: 'milestone', 
                    amount: milestoneReward,
                    currency: 'CNX', 
                    description: `Milestone bonus at ${newTotalClaims} claims`, 
                    metadata: { totalClaims: newTotalClaims }, 
                    timestamp: serverTimestamp()
                });
            }
            
            result = { 
                amount: coinConfig.claimAmount, 
                milestoneReward, 
                newBalance: newBalances[coinId] 
            };
        });
        
        if (result.milestoneReward > 0) {
            await createNotification(userId, '🎉 Milestone Reached!', 
                `You earned ${result.milestoneReward} CNX!`, 'reward');
        }
        
        await giveReferralBonus(userId, result.amount, 'faucet');
        
        res.json({ 
            success: true, 
            amount: result.amount, 
            milestoneReward: result.milestoneReward, 
            balance: result.newBalance 
        });
        
    } catch (err) {
        const msg = err.message || '';
        if (msg.includes('Cooldown')) {
            return res.status(429).json({ 
                error: 'Cooldown active', 
                wait: parseInt(msg.split('|')[1]) || COOLDOWN_MS 
            });
        }
        if (msg.includes('Daily limit')) return res.status(429).json({ error: 'Daily limit reached' });
        if (msg.includes('Duplicate')) return res.status(429).json({ error: 'Duplicate claim' });
        if (msg.includes('User banned')) return res.status(403).json({ error: 'User banned' });
        
        logger.error('Claim error', { error: err.message });
        res.status(500).json({ error: 'Claim failed' });
    }
}

async function swapCoinToCnx(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    
    const userId = String(req.user.userId);
    const { coin, amount } = req.body;
    const amt = Number(amount);
    
    if (!amt || amt <= 0 || isNaN(amt)) return res.status(400).json({ error: 'Invalid amount' });
    
    const coinConfig = COINS[coin];
    if (!coinConfig) return res.status(400).json({ error: 'Invalid coin' });
    
    const price = getCoinPrice(coin);
    if (!price || price <= 0) return res.status(503).json({ error: 'Price unavailable' });
    
    const cnxAmount = Math.round((amt * price / CNX_USD_VALUE) * 1e8) / 1e8;
    if (cnxAmount <= 0) return res.status(400).json({ error: 'Amount too small' });
    
    const userRef = db.collection('users').doc(userId);
    
    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) throw new Error('User not found');
            const d = doc.data();
            if (d.banned) throw new Error('User banned');
            
            const balances = d.balances || {};
            if ((balances[coin] || 0) < amt) throw new Error('Insufficient balance');
            
            const newBalances = { ...balances };
            newBalances[coin] = (newBalances[coin] || 0) - amt;
            
            t.update(userRef, { 
                balances: newBalances, 
                balance: increment(cnxAmount), 
                total_earned: increment(cnxAmount), 
                total_swaps: increment(1), 
                last_active: serverTimestamp() 
            });
            
            t.set(db.collection('transactions').doc(), {
                user_id: userId, 
                type: 'swap', 
                amount: amt, 
                currency: coinConfig.symbol,
                description: `Swapped ${amt} ${coinConfig.symbol} to ${cnxAmount} CNX`,
                metadata: { direction: 'coin-to-cnx', coin, resultAmount: cnxAmount, price }, 
                timestamp: serverTimestamp()
            });
        });
        
        res.json({ success: true, resultAmount: cnxAmount });
    } catch (err) {
        if (err.message?.includes('Insufficient')) return res.status(400).json({ error: err.message });
        res.status(500).json({ error: 'Swap failed' });
    }
}

async function withdraw(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    
    const userId = String(req.user.userId);
    const { coin, faucetpay_email, amount } = req.body;
    
    const coinConfig = COINS[coin];
    if (!coinConfig) return res.status(400).json({ error: 'Invalid coin' });
    
    const amt = Number(amount);
    if (!amt || amt <= 0 || isNaN(amt)) return res.status(400).json({ error: 'Invalid amount' });
    
    if (!faucetpay_email || !faucetpay_email.includes('@')) {
        return res.status(400).json({ error: 'Invalid email' });
    }
    
    const minAmt = getMinWithdrawAmount(coin);
    if (amt < minAmt) {
        return res.status(400).json({ 
            error: `Minimum ${fmt(minAmt, coinConfig.decimals)} ${coinConfig.symbol} ($0.03)` 
        });
    }
    
    const userRef = db.collection('users').doc(userId);
    
    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) throw new Error('User not found');
            const d = doc.data();
            if (d.banned) throw new Error('User banned');
            
            const balances = d.balances || {};
            if ((balances[coin] || 0) < amt) throw new Error('Insufficient balance');
            
            const newBalances = { ...balances };
            newBalances[coin] = (newBalances[coin] || 0) - amt;
            
            t.update(userRef, { 
                balances: newBalances, 
                total_withdrawals: increment(1), 
                last_active: serverTimestamp() 
            });
            
            t.set(db.collection('transactions').doc(), {
                user_id: userId, 
                type: 'withdraw', 
                amount: amt, 
                currency: coinConfig.symbol,
                description: `Withdraw ${amt} ${coinConfig.symbol} to ${faucetpay_email}`,
                metadata: { faucetpay_email, coin }, 
                timestamp: serverTimestamp()
            });
        });
        
        const ref = await db.collection('withdrawals').add({
            user_id: userId, 
            coin, 
            faucetpay_email, 
            amount: amt, 
            status: 'pending', 
            timestamp: serverTimestamp()
        });
        
        res.json({ success: true, id: ref.id });
    } catch (err) {
        if (err.message?.includes('Insufficient') || err.message?.includes('Minimum')) {
            return res.status(400).json({ error: err.message });
        }
        res.status(500).json({ error: 'Withdrawal failed' });
    }
}

async function getWithdrawHistory(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const userId = String(req.user.userId);
        const snapshot = await db.collection('withdrawals')
            .where('user_id', '==', userId)
            .orderBy('timestamp', 'desc')
            .limit(50)
            .get();
        res.json(snapshot.docs.map(d => ({ 
            id: d.id, 
            ...d.data(), 
            timestamp: tsToMillis(d.data().timestamp) 
        })));
    } catch (err) { 
        res.status(500).json({ error: 'Failed' }); 
    }
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
            t.update(userRef, { 
                balance: increment(rb), 
                referral_balance: increment(-rb) 
            });
        });
        await logTransaction(userId, 'referral_collect', collected, 'CNX', 'Collected referral earnings');
        res.json({ success: true, amount: collected });
    } catch (err) { 
        res.status(400).json({ error: err.message }); 
    }
}

async function getReferral(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const userId = String(req.user.userId);
        const doc = await db.collection('users').doc(userId).get();
        if (!doc.exists) return res.status(404).json({ error: 'User not found' });
        const d = doc.data();
        res.json({ 
            link: `https://t.me/${BOT_USERNAME}?start=ref_${userId}`, 
            referrals: d.referrals || 0, 
            earnings: d.referral_earnings || 0, 
            referral_balance: d.referral_balance || 0 
        });
    } catch (err) { 
        res.status(500).json({ error: 'Failed' }); 
    }
}

async function getReferralList(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const userId = String(req.user.userId);
        const snap = await db.collection('users')
            .where('referred_by', '==', userId)
            .orderBy('created_at', 'desc')
            .limit(100)
            .get();
        res.json({ 
            count: snap.size, 
            list: snap.docs.map(d => {
                const x = d.data();
                return { 
                    id: d.id, 
                    first_name: x.first_name || null, 
                    username: x.username || null, 
                    photo_url: x.photo_url || null, 
                    total_earned: x.total_earned || 0, 
                    created_at: tsToMillis(x.created_at) 
                };
            })
        });
    } catch (err) { 
        res.status(500).json({ error: 'Failed' }); 
    }
}

async function getNotifications(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const userId = String(req.user.userId);
        const snap = await db.collection('notifications')
            .where('user_id', '==', userId)
            .orderBy('timestamp', 'desc')
            .limit(50)
            .get();
        const list = snap.docs.map(d => ({ 
            id: d.id, 
            ...d.data(), 
            timestamp: tsToMillis(d.data().timestamp) 
        }));
        res.json({ list, unreadCount: list.filter(n => !n.read).length });
    } catch (err) { 
        res.status(500).json({ error: 'Failed' }); 
    }
}

async function markNotificationsRead(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const userId = String(req.user.userId);
        const snap = await db.collection('notifications')
            .where('user_id', '==', userId)
            .where('read', '==', false)
            .limit(50)
            .get();
        const batch = db.batch();
        snap.docs.forEach(d => batch.update(d.ref, { read: true }));
        await batch.commit();
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: 'Failed' }); 
    }
}

async function getTransactionHistory(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const userId = String(req.user.userId);
        const snap = await db.collection('transactions')
            .where('user_id', '==', userId)
            .orderBy('timestamp', 'desc')
            .limit(50)
            .get();
        res.json({ 
            list: snap.docs.map(d => ({ 
                id: d.id, 
                ...d.data(), 
                timestamp: tsToMillis(d.data().timestamp) 
            })), 
            count: snap.size 
        });
    } catch (err) { 
        res.status(500).json({ error: 'Failed' }); 
    }
}

// ============================================
// ADMIN ENDPOINTS (Kısaca - aynı kalacak)
// ============================================
async function adminGetStats(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const usersSnap = await db.collection('users').get();
        const wdSnap = await db.collection('withdrawals').get();
        const claimsSnap = await db.collection('transactions')
            .where('type', '==', 'faucet_claim')
            .get()
            .catch(() => ({ size: 0 }));
        res.json({ 
            totalUsers: usersSnap.size, 
            totalPaid_doge: 0, 
            totalWithdrawals: wdSnap.size, 
            totalClaims: claimsSnap.size 
        });
    } catch (err) { 
        res.status(500).json({ error: 'Failed' }); 
    }
}

async function adminGetUsers(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const snap = await db.collection('users')
            .orderBy('created_at', 'desc')
            .limit(50)
            .get();
        let users = snap.docs.map(d => ({ 
            id: d.id, 
            ...d.data(), 
            created_at: tsToMillis(d.data().created_at) 
        }));
        if (req.query.search) {
            const q = req.query.search.toLowerCase();
            users = users.filter(u => 
                (u.first_name || '').toLowerCase().includes(q) || 
                (u.username || '').toLowerCase().includes(q) || 
                String(u.id).includes(q)
            );
        }
        res.json(users);
    } catch (err) { 
        res.status(500).json({ error: 'Failed' }); 
    }
}

async function adminGetWithdrawals(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const snap = await db.collection('withdrawals')
            .orderBy('timestamp', 'desc')
            .limit(200)
            .get();
        res.json(snap.docs.map(d => ({ 
            id: d.id, 
            ...d.data(), 
            timestamp: tsToMillis(d.data().timestamp) 
        })));
    } catch (err) { 
        res.status(500).json({ error: 'Failed' }); 
    }
}

async function adminApproveWithdrawal(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try { 
        await db.collection('withdrawals')
            .doc(req.body.id)
            .update({ 
                status: 'approved', 
                approved_at: serverTimestamp(), 
                approved_by: req.user.userId 
            }); 
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: 'Failed' }); 
    }
}

async function adminRejectWithdrawal(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const id = req.body.id;
        const wd = await db.collection('withdrawals').doc(id).get();
        if (!wd.exists) return res.status(404).json({ error: 'Not found' });
        const wdData = wd.data();
        if (wdData.status === 'approved') return res.status(400).json({ error: 'Already approved' });
        await db.runTransaction(async (t) => {
            const u = await t.get(db.collection('users').doc(String(wdData.user_id)));
            if (u.exists) {
                const newBalances = { ...(u.data().balances || {}) };
                newBalances[wdData.coin] = (newBalances[wdData.coin] || 0) + (wdData.amount || 0);
                t.update(u.ref, { balances: newBalances });
            }
            t.update(wd.ref, { 
                status: 'rejected', 
                rejected_at: serverTimestamp(), 
                rejected_by: req.user.userId 
            });
        });
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: 'Failed' }); 
    }
}

async function adminBanUser(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try { 
        await db.collection('users')
            .doc(String(req.body.userId))
            .update({ 
                banned: true, 
                banned_at: serverTimestamp(), 
                banned_by: req.user.userId 
            }); 
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: 'Failed' }); 
    }
}

async function adminAddBalance(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const { userId, amount, currency, reason } = req.body;
        if (!userId || !amount) return res.status(400).json({ error: 'userId and amount required' });
        const amt = Number(amount);
        const isCoin = Object.keys(COINS).includes(currency);
        await db.runTransaction(async (t) => {
            const u = await t.get(db.collection('users').doc(String(userId)));
            if (!u.exists) throw new Error('User not found');
            if (isCoin) {
                const newBalances = { ...(u.data().balances || {}) };
                newBalances[currency] = (newBalances[currency] || 0) + amt;
                t.update(u.ref, { balances: newBalances });
            } else {
                t.update(u.ref, { balance: increment(amt), total_earned: increment(amt) });
            }
            t.set(db.collection('transactions').doc(), {
                user_id: String(userId), 
                type: 'admin_edit', 
                amount: amt, 
                currency: isCoin ? COINS[currency].symbol : 'CNX',
                description: `Admin: ${reason || 'No reason'}`, 
                metadata: { adminId: req.user.userId, reason }, 
                timestamp: serverTimestamp()
            });
        });
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: err.message || 'Failed' }); 
    }
}

async function adminBroadcast(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try { 
        const botResult = await broadcastToUsers(req.body.message); 
        res.json({ success: true, bot: botResult }); 
    } catch (err) { 
        res.status(500).json({ error: 'Failed' }); 
    }
}

async function adminSendDM(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    try {
        const { userId, message } = req.body;
        const result = await sendTelegramMessage(String(userId), message, 'Markdown');
        res.json({ success: true, bot_sent: result.ok });
    } catch (err) { 
        res.status(500).json({ error: 'Failed' }); 
    }
}

// ============================================
// EXPRESS APP
// ============================================
const app = express();

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

app.get('/ping', (req, res) => res.status(200).send('OK'));
app.get('/api/health', (req, res) => res.json({ ok: true, db: firebaseInitialized, ts: Date.now() }));
app.post('/api/auth', authLimiter, auth);
app.use('/api', generalLimiter);

app.get('/api/me', jwtAuth, getMe);
app.get('/api/prices', getPrices);
app.get('/api/captcha/:coin', jwtAuth, getCaptcha);
app.post('/api/claim/:coin', claimLimiter, jwtAuth, claim);
app.post('/api/swap-coin', swapLimiter, jwtAuth, swapCoinToCnx);
app.post('/api/withdraw', withdrawLimiter, jwtAuth, withdraw);
app.get('/api/withdrawals', jwtAuth, getWithdrawHistory);
app.get('/api/referral', jwtAuth, getReferral);
app.get('/api/referral/list', jwtAuth, getReferralList);
app.post('/api/referral/collect', jwtAuth, collectReferralBonus);
app.get('/api/notifications', jwtAuth, getNotifications);
app.post('/api/notifications/read', jwtAuth, markNotificationsRead);
app.get('/api/transactions', jwtAuth, getTransactionHistory);

app.get('/api/admin/stats', adminAuth, adminGetStats);
app.get('/api/admin/users', adminAuth, adminGetUsers);
app.get('/api/admin/withdrawals', adminAuth, adminGetWithdrawals);
app.post('/api/admin/approve-withdrawal', adminAuth, adminApproveWithdrawal);
app.post('/api/admin/reject-withdrawal', adminAuth, adminRejectWithdrawal);
app.post('/api/admin/add-balance', adminAuth, adminAddBalance);
app.post('/api/admin/ban-user', adminAuth, adminBanUser);
app.post('/api/admin/broadcast', adminAuth, adminBroadcast);
app.post('/api/admin/send-dm', adminAuth, adminSendDM);

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

app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'API endpoint not found' });
    }
    res.sendFile(path.join(publicPath, 'index.html'), (err) => { 
        if (err) res.status(404).send('App not found'); 
    });
});

app.use((err, req, res, next) => { 
    logger.error('Express error', { error: err.message, path: req.path }); 
    res.status(500).json({ error: 'Internal server error' }); 
});

module.exports = app;

if (require.main === module) {
    const server = app.listen(PORT, '0.0.0.0', () => {
        logger.info(`🚀 Coinix backend listening on port ${PORT}`);
        logger.info(`📁 Static path: ${publicPath}`);
    });
    
    if (process.env.NODE_ENV === 'production' && APP_URL) {
        const PING_INTERVAL_MS = 14 * 60 * 1000;
        setInterval(async () => { 
            try { 
                await fetch(`${APP_URL}/ping`, { cache: 'no-store' }); 
            } catch (e) {} 
        }, PING_INTERVAL_MS);
    }
    
    const shutdown = (signal) => {
        logger.info(`${signal} received, shutting down...`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 10000).unref();
    };
    
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

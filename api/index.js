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
const axios = require('axios');

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

// ============================================
// LOGGER
// ============================================
const logger = {
    info: (msg, meta = {}) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`, meta),
    error: (msg, meta = {}) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`, meta),
    debug: (msg, meta = {}) => console.log(`[DEBUG] ${new Date().toISOString()} - ${msg}`, meta),
    warn: (msg, meta = {}) => console.warn(`[WARN] ${new Date().toISOString()} - ${msg}`, meta)
};

// ============================================
// CONFIG
// ============================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME || 'CoinixBot';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '';
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || JWT_SECRET;
const APP_URL = process.env.APP_URL || 'http://localhost:10000';
const PORT = process.env.PORT || 10000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Cloudflare Turnstile
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;
const TURNSTILE_ENABLED = !!TURNSTILE_SECRET_KEY;

function validateCriticalConfig() {
    const missing = [];
    if (!BOT_TOKEN) missing.push('BOT_TOKEN');
    if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
    if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON && !process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
        missing.push('FIREBASE_SERVICE_ACCOUNT');
    }
    if (TURNSTILE_ENABLED && !TURNSTILE_SECRET_KEY) missing.push('TURNSTILE_SECRET_KEY');
    
    if (missing.length) {
        logger.warn('Missing config vars', { missing });
    } else {
        logger.info('✅ All critical env vars present');
    }
}
validateCriticalConfig();

// ============================================
// MULTI-COIN CONFIG
// ============================================
const COOLDOWN_MS = parseInt(process.env.COOLDOWN_MS) || 10000;
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT) || 100;

const COINS = {
    doge: { 
        symbol: 'DOGE', 
        name: 'Dogecoin',
        claimAmount: parseFloat(process.env.DOGE_CLAIM_AMOUNT) || 0.004, 
        priceId: 'dogecoin', 
        decimals: 4,
        minWithdraw: parseFloat(process.env.DOGE_MIN_WITHDRAW) || 1,
        enabled: process.env.DOGE_ENABLED !== 'false'
    },
    pepe: { 
        symbol: 'PEPE', 
        name: 'Pepe Coin',
        claimAmount: parseFloat(process.env.PEPE_CLAIM_AMOUNT) || 1000, 
        priceId: 'pepe', 
        decimals: 0,
        minWithdraw: parseFloat(process.env.PEPE_MIN_WITHDRAW) || 100000,
        enabled: process.env.PEPE_ENABLED !== 'false'
    },
    pol: { 
        symbol: 'POL', 
        name: 'Polygon',
        claimAmount: parseFloat(process.env.POL_CLAIM_AMOUNT) || 0.05, 
        priceId: 'polygon-ecosystem-token', 
        decimals: 2,
        minWithdraw: parseFloat(process.env.POL_MIN_WITHDRAW) || 0.5,
        enabled: process.env.POL_ENABLED !== 'false'
    },
    feyorra: { 
        symbol: 'FEYORRA', 
        name: 'Feyorra',
        claimAmount: parseFloat(process.env.FEYORRA_CLAIM_AMOUNT) || 1, 
        priceId: null, 
        decimals: 0, 
        fixedPrice: parseFloat(process.env.FEYORRA_PRICE) || 0.001,
        minWithdraw: parseFloat(process.env.FEYORRA_MIN_WITHDRAW) || 50,
        enabled: process.env.FEYORRA_ENABLED !== 'false'
    },
    dgb: { 
        symbol: 'DGB', 
        name: 'DigiByte',
        claimAmount: parseFloat(process.env.DGB_CLAIM_AMOUNT) || 1.5, 
        priceId: 'digibyte', 
        decimals: 2,
        minWithdraw: parseFloat(process.env.DGB_MIN_WITHDRAW) || 5,
        enabled: process.env.DGB_ENABLED !== 'false'
    }
};

const REFERRAL_SIGNUP_BONUS = parseFloat(process.env.REFERRAL_SIGNUP_BONUS) || 1;
const REFERRAL_COMMISSION_PERCENT = parseFloat(process.env.REFERRAL_COMMISSION_PERCENT) || 20;

// ============================================
// PRICE CACHE
// ============================================
let priceCache = { lastUpdate: 0, coins: {} };

async function fetchPrices() {
    try {
        const ids = Object.values(COINS).map(c => c.priceId).filter(Boolean).join(',');
        if (!ids) {
            logger.debug('No coin IDs to fetch');
            return priceCache;
        }
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        
        const res = await axios.get(
            `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
            { signal: controller.signal, timeout: 10000 }
        );
        
        clearTimeout(timeout);
        
        if (!res.data) {
            logger.warn('No data from CoinGecko');
            return priceCache;
        }
        
        Object.values(COINS).forEach(c => {
            if (c.priceId && res.data[c.priceId]?.usd != null) {
                priceCache.coins[c.symbol.toLowerCase()] = res.data[c.priceId].usd;
            } else if (c.fixedPrice) {
                priceCache.coins[c.symbol.toLowerCase()] = c.fixedPrice;
            }
        });
        
        priceCache.lastUpdate = Date.now();
        logger.info('💹 Prices updated', { count: Object.keys(priceCache.coins).length });
        
        return priceCache;
    } catch (err) { 
        logger.error('Price fetch error', { error: err.message }); 
        return priceCache; 
    }
}

// Initial fetch and interval
fetchPrices();
setInterval(fetchPrices, 120000); // Every 2 minutes

function getCoinPrice(coinId) {
    const c = COINS[coinId];
    if (!c) return 0;
    return priceCache.coins[c.symbol.toLowerCase()] || c.fixedPrice || 0;
}

function getMinWithdrawAmount(coinId) {
    const coin = COINS[coinId];
    if (!coin) return Infinity;
    
    // If minWithdraw is set in config, use it
    if (coin.minWithdraw) return coin.minWithdraw;
    
    // Otherwise calculate based on $0.03 USD
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
                scriptSrc: [
                    "'self'", 
                    "'unsafe-inline'", 
                    "'unsafe-eval'", 
                    "https://telegram.org",
                    "https://challenges.cloudflare.com",
                    "https://richinfo.co",
                    "https://*.richinfo.co"
                ],
                styleSrc: ["'self'", "'unsafe-inline'"],
                fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
                imgSrc: ["'self'", "data:", "https:", "blob:"],
                connectSrc: [
                    "'self'", 
                    "https://*.googleapis.com", 
                    "https://*.firebaseio.com", 
                    "https://api.coingecko.com",
                    "https://richinfo.co",
                    "https://challenges.cloudflare.com"
                ],
                frameSrc: ["'self'", "https://challenges.cloudflare.com"],
                objectSrc: ["'none'"],
                upgradeInsecureRequests: []
            }
        },
        crossOriginEmbedderPolicy: false,
        hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
    }));
}

// Rate limiters
const generalLimiter = rateLimit({ 
    windowMs: 60000, 
    max: 120, 
    standardHeaders: true, 
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' }
});

const authLimiter = rateLimit({ 
    windowMs: 300000, 
    max: 20, 
    standardHeaders: true, 
    legacyHeaders: false,
    message: { error: 'Too many auth attempts' }
});

const claimLimiter = rateLimit({ 
    windowMs: 60000, 
    max: 60, 
    standardHeaders: true, 
    legacyHeaders: false,
    message: { error: 'Claim rate limit exceeded' }
});

const withdrawLimiter = rateLimit({ 
    windowMs: 3600000, 
    max: 10, 
    standardHeaders: true, 
    legacyHeaders: false,
    message: { error: 'Withdrawal rate limit exceeded' }
});

// ============================================
// NONCE / REPLAY GUARD
// ============================================
const usedNonces = new Map();
const NONCE_MAX_AGE = 5 * 60 * 1000;

function validateNonce(nonce, timestamp) {
    if (!nonce || !timestamp) return { valid: false, error: 'Nonce and timestamp required' };
    
    const ts = parseInt(timestamp);
    if (isNaN(ts) || Math.abs(Date.now() - ts) > 300000) {
        return { valid: false, error: 'Request expired' };
    }
    
    const key = `${nonce}:${ts}`;
    if (usedNonces.has(key)) {
        return { valid: false, error: 'Duplicate request' };
    }
    
    usedNonces.set(key, Date.now());
    return { valid: true };
}

// Cleanup old nonces
setInterval(() => { 
    const now = Date.now(); 
    for (const [key, time] of usedNonces) { 
        if (now - time > NONCE_MAX_AGE) usedNonces.delete(key); 
    } 
}, 60000);

// ============================================
// CLOUDFLARE TURNSTILE VERIFY
// ============================================
async function verifyTurnstileToken(token, ip) {
    if (!TURNSTILE_ENABLED) {
        logger.warn('Turnstile not enabled, skipping verification');
        return { success: true };
    }
    
    if (!token) {
        return { success: false, error: 'Turnstile token required' };
    }
    
    try {
        const response = await axios.post(
            'https://challenges.cloudflare.com/turnstile/v0/siteverify',
            new URLSearchParams({
                secret: TURNSTILE_SECRET_KEY,
                response: token,
                remoteip: ip
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 5000 }
        );
        
        const data = response.data;
        
        if (!data.success) {
            logger.warn('Turnstile verification failed', { errors: data['error-codes'] });
            return { success: false, error: 'Security verification failed' };
        }
        
        return { success: true };
    } catch (err) {
        logger.error('Turnstile verify error', { error: err.message });
        return { success: false, error: 'Security service unavailable' };
    }
}

// ============================================
// AUTH
// ============================================
function validateTelegramInitData(initData) {
    if (!initData || !BOT_TOKEN) {
        logger.warn('Missing initData or BOT_TOKEN');
        return false;
    }
    
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
        
        if (!hash) {
            logger.warn('No hash in initData');
            return false;
        }
        
        if (params.auth_date) {
            const authDate = parseInt(params.auth_date, 10);
            const now = Math.floor(Date.now() / 1000);
            if (!isNaN(authDate) && Math.abs(now - authDate) > 300) {
                logger.warn('Auth date expired');
                return false;
            }
        }
        
        const entries = Object.keys(params).sort().map(k => `${k}=${params[k]}`);
        const dataCheckString = entries.join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const checkHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        
        const a = Buffer.from(hash, 'hex'); 
        const b = Buffer.from(checkHash, 'hex');
        
        if (a.length !== b.length || a.length === 0) {
            logger.warn('Hash length mismatch');
            return false;
        }
        
        return crypto.timingSafeEqual(a, b);
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
        return res.status(403).json({ error: 'Invalid token' }); 
    }
}

function adminAuth(req, res, next) {
    const key = req.headers['x-admin-key'];
    if (!ADMIN_SECRET_KEY || key !== ADMIN_SECRET_KEY) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    
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
            timestamp: serverTimestamp(),
            ip: details.ip || null
        }); 
    } catch (e) {
        logger.debug('Log action failed', { error: e.message });
    }
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
    } catch (e) {
        logger.debug('Log transaction failed', { error: e.message });
    }
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
    } catch (e) {
        logger.debug('Create notification failed', { error: e.message });
    }
}

function getClientIP(req) { 
    return (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '0.0.0.0').split(',')[0].trim(); 
}

function startOfTodayTs() { 
    const d = new Date(); 
    d.setHours(0, 0, 0, 0); 
    return Timestamp ? Timestamp.fromDate(d) : d; 
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
    if (!BOT_TOKEN) {
        logger.warn('BOT_TOKEN not set, cannot send message');
        return { ok: false, error: 'BOT_TOKEN not configured' };
    }
    
    try {
        const res = await axios.post(
            `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
            { chat_id: chatId, text, parse_mode: parseMode },
            { timeout: 10000 }
        );
        return res.data;
    } catch (e) { 
        logger.error('Telegram send error', { error: e.message, chatId });
        return { ok: false, error: e.message }; 
    }
}

async function broadcastToUsers(message) {
    if (!db || !BOT_TOKEN) {
        return { sent: 0, failed: 0, error: 'DB or BOT_TOKEN not available' };
    }
    
    let sent = 0, failed = 0;
    
    try {
        const snap = await db.collection('users').where('banned', '!=', true).limit(500).get();
        
        for (const doc of snap.docs) {
            const user = doc.data();
            if (!user.telegram_id || user.banned) continue;
            
            const res = await sendTelegramMessage(user.telegram_id, message, 'Markdown');
            if (res.ok) sent++; 
            else failed++;
            
            await new Promise(r => setTimeout(r, 35)); // Avoid rate limit
        }
    } catch (e) {
        logger.error('Broadcast error', { error: e.message });
    }
    
    return { sent, failed };
}

// ============================================
// CAPTCHA
// ============================================
const activeCaptchas = new Map(); // coinId -> userId -> {answer, expiresAt}

function generateMathCaptcha(userId, coinId) {
    if (!activeCaptchas.has(coinId)) activeCaptchas.set(coinId, new Map());
    const coinMap = activeCaptchas.get(coinId);
    
    // Cleanup if too many
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

// Cleanup expired captchas
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
            
        logger.debug('Referral bonus given', { referrer: referrerId, amount: bonusAmount });
    } catch (e) { 
        logger.error('Referral bonus error', { error: e.message });
    }
}

// ============================================
// API ENDPOINTS
// ============================================

// Health check
async function healthCheck(req, res) {
    res.json({ 
        ok: true, 
        db: firebaseInitialized, 
        ts: Date.now(),
        uptime: process.uptime(),
        coins: Object.keys(COINS).filter(k => COINS[k].enabled),
        turnstile: TURNSTILE_ENABLED
    });
}

// Auth endpoint
async function auth(req, res) {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    
    const { initData, ref, device_fp, nonce, timestamp } = req.body;
    
    if (!initData) return res.status(400).json({ error: 'Missing initData' });
    if (!validateTelegramInitData(initData)) {
        logger.warn('Invalid Telegram initData');
        return res.status(403).json({ error: 'Invalid signature' });
    }
    
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
    
    if (ref && ref === userId) {
        return res.status(400).json({ error: 'Self referral not allowed' });
    }
    
    // Device fingerprinting
    if (device_fp) {
        try {
            const deviceId = String(device_fp).slice(0, 64);
            const deviceRef = db.collection('devices').doc(deviceId);
            const deviceDoc = await deviceRef.get();
            
            if (deviceDoc.exists) { 
                const boundTo = deviceDoc.data().telegram_id; 
                if (boundTo && String(boundTo) !== userId) {
                    logger.warn('Device already linked', { deviceId, boundTo, userId });
                    return res.status(403).json({ error: 'Device already linked to another account' }); 
                } 
            } else { 
                await deviceRef.set({ 
                    telegram_id: userId, 
                    first_seen: serverTimestamp(), 
                    ua: req.headers['user-agent'] || null,
                    ip: getClientIP(req)
                }); 
            }
        } catch (e) { 
            logger.debug('Device tracking error', { error: e.message });
        }
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
                country: req.headers['cf-ipcountry'] || null,
                language: req.headers['cf-ipcountry'] || null
            };
            
            await userRef.set(newUser);
            
            // Referral bonus
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
                        
                        logger.info('Referral signup bonus', { referrer: ref, new: userId });
                    }
                }
            }
            
            await logAction('user_register', userId, { ref, ip: getClientIP(req) });
            logger.info('New user registered', { userId, username: user.username, ref });
            
        } else {
            if (doc.data().banned) {
                return res.status(403).json({ error: 'User banned' });
            }
            
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
        logger.error('Auth failed', { error: err.message, userId });
        res.status(500).json({ error: 'Auth failed' });  
    }
}

// Get current user
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
        logger.error('GetMe error', { error: err.message });
        res.status(500).json({ error: 'Server error' }); 
    }
}

// Get prices
async function getPrices(req, res) {
    try { 
        if (Date.now() - priceCache.lastUpdate > 60000) {
            await fetchPrices();
        }
        res.json(priceCache.coins); 
    } catch (err) { 
        logger.error('GetPrices error', { error: err.message });
        res.status(500).json({ error: 'Failed' }); 
    }
}

// Get captcha
async function getCaptcha(req, res) {
    try { 
        const userId = String(req.user.userId); 
        const coinId = req.params.coin; 
        
        if (!COINS[coinId] || !COINS[coinId].enabled) {
            return res.status(400).json({ error: 'Invalid or disabled coin' });
        }
        
        const captcha = generateMathCaptcha(userId, coinId); 
        res.json({ success: true, question: captcha.question }); 
    } catch (err) { 
        logger.error('GetCaptcha error', { error: err.message });
        res.status(500).json({ error: 'Failed' }); 
    }
}

// Claim coins
async function claim(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    
    const userId = String(req.user.userId);
    const coinId = req.params.coin;
    const coinConfig = COINS[coinId];
    
    if (!coinConfig || !coinConfig.enabled) {
        return res.status(400).json({ error: 'Invalid or disabled coin' });
    }
    
    const { captchaAnswer, turnstileToken, nonce, timestamp } = req.body;
    
    if (!captchaAnswer) {
        return res.status(400).json({ error: 'Captcha required' });
    }
    
    // Verify Turnstile
    if (TURNSTILE_ENABLED) {
        const clientIP = getClientIP(req);
        const turnstileResult = await verifyTurnstileToken(turnstileToken, clientIP);
        if (!turnstileResult.success) {
            logger.warn('Turnstile failed on claim', { userId, coinId });
            return res.status(403).json({ error: turnstileResult.error });
        }
    }
    
    if (nonce && timestamp) { 
        const nc = validateNonce(nonce, timestamp); 
        if (!nc.valid) return res.status(403).json({ error: nc.error }); 
    }
    
    const captchaResult = verifyCaptcha(userId, coinId, captchaAnswer);
    if (!captchaResult.valid) {
        logger.warn('Captcha failed', { userId, coinId, error: captchaResult.error });
        return res.status(403).json({ error: captchaResult.error });
    }
    
    const userRef = db.collection('users').doc(userId);
    
    try {
        const now = Date.now();
        let result = { amount: 0, milestoneReward: 0, newBalance: 0 };
        
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            
            if (!doc.exists) throw new Error('User not found');
            const d = doc.data();
            
            if (d.banned) throw new Error('User banned');
            
            // Daily limit check
            const dailyClaims = d.daily_claims || {};
            const lastClaimDate = d.last_claim_times?.[coinId] ? 
                new Date(d.last_claim_times[coinId].toMillis ? 
                    d.last_claim_times[coinId].toMillis() : 
                    d.last_claim_times[coinId]).toDateString() : null;
            
            const today = new Date().toDateString();
            const todayCount = (lastClaimDate === today) ? (dailyClaims[coinId] || 0) : 0;
            
            if (todayCount >= DAILY_LIMIT) {
                throw new Error('Daily limit reached');
            }
            
            // Cooldown check
            const lastTime = d.last_claim_times?.[coinId] ? 
                (d.last_claim_times[coinId].toMillis ? 
                    d.last_claim_times[coinId].toMillis() : 
                    new Date(d.last_claim_times[coinId]).getTime()) : 0;
            
            if (now - lastTime < COOLDOWN_MS) {
                throw new Error(`Cooldown|${COOLDOWN_MS - (now - lastTime)}`);
            }
            
            // Duplicate check
            const recentClaims = await db.collection('transactions')
                .where('user_id', '==', userId)
                .where('type', '==', 'faucet_claim')
                .where('currency', '==', coinConfig.symbol)
                .where('timestamp', '>=', Timestamp.fromMillis(now - 3000))
                .limit(1)
                .get();
            
            if (!recentClaims.empty) {
                throw new Error('Duplicate claim');
            }
            
            // Update balances
            const newBalances = { ...(d.balances || {}) };
            newBalances[coinId] = (newBalances[coinId] || 0) + coinConfig.claimAmount;
            
            const newDaily = { ...dailyClaims };
            newDaily[coinId] = todayCount + 1;
            
            const newClaimTimes = { ...(d.last_claim_times || {}) };
            newClaimTimes[coinId] = serverTimestamp();
            
            const newTotalClaims = (d.total_claims || 0) + 1;
            
            // Milestone check
            let milestoneReward = 0;
            const milestone = getMilestoneReward(newTotalClaims);
            if (milestone > 0) {
                milestoneReward = milestone;
            }
            
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
            
            // Log transaction
            t.set(db.collection('transactions').doc(), {
                user_id: userId, 
                type: 'faucet_claim', 
                amount: coinConfig.claimAmount,
                currency: coinConfig.symbol, 
                description: `${coinConfig.symbol} faucet claim`, 
                metadata: { coin: coinId }, 
                timestamp: serverTimestamp()
            });
            
            // Milestone bonus
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
        
        // Notification for milestone
        if (result.milestoneReward > 0) {
            await createNotification(
                userId, 
                '🎉 Milestone Reached!', 
                `You earned ${result.milestoneReward} CNX for reaching ${result.newBalance} claims!`, 
                'reward'
            );
            logger.info('Milestone reached', { userId, milestone: result.milestoneReward });
        }
        
        // Referral bonus
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
        if (msg.includes('Daily limit')) {
            return res.status(429).json({ error: 'Daily limit reached' });
        }
        if (msg.includes('Duplicate')) {
            return res.status(429).json({ error: 'Duplicate claim' });
        }
        if (msg.includes('User banned')) {
            return res.status(403).json({ error: 'User banned' });
        }
        
        logger.error('Claim error', { error: err.message, userId, coinId });
        res.status(500).json({ error: 'Claim failed' });
    }
}

// Withdraw
async function withdraw(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    
    const userId = String(req.user.userId);
    const { coin, faucetpay_email, amount, turnstileToken } = req.body;
    
    const coinConfig = COINS[coin];
    if (!coinConfig || !coinConfig.enabled) {
        return res.status(400).json({ error: 'Invalid or disabled coin' });
    }
    
    const amt = Number(amount);
    if (!amt || amt <= 0 || isNaN(amt)) {
        return res.status(400).json({ error: 'Invalid amount' });
    }
    
    if (!faucetpay_email || !faucetpay_email.includes('@')) {
        return res.status(400).json({ error: 'Invalid email' });
    }
    
    // Verify Turnstile
    if (TURNSTILE_ENABLED) {
        const clientIP = getClientIP(req);
        const turnstileResult = await verifyTurnstileToken(turnstileToken, clientIP);
        if (!turnstileResult.success) {
            logger.warn('Turnstile failed on withdraw', { userId, coin });
            return res.status(403).json({ error: turnstileResult.error });
        }
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
            if ((balances[coin] || 0) < amt) {
                throw new Error('Insufficient balance');
            }
            
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
            timestamp: serverTimestamp(),
            requested_at: serverTimestamp()
        });
        
        logger.info('Withdrawal requested', { userId, coin, amount, email: faucetpay_email });
        
        res.json({ success: true, id: ref.id });
        
    } catch (err) {
        if (err.message?.includes('Insufficient') || err.message?.includes('Minimum')) {
            return res.status(400).json({ error: err.message });
        }
        
        logger.error('Withdraw error', { error: err.message, userId, coin });
        res.status(500).json({ error: 'Withdrawal failed' });
    }
}

// Withdrawal history
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
        logger.error('GetWithdrawHistory error', { error: err.message });
        res.status(500).json({ error: 'Failed' }); 
    }
}

// Collect referral bonus
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
        
        logger.info('Referral bonus collected', { userId, amount: collected });
        
        res.json({ success: true, amount: collected });
        
    } catch (err) { 
        logger.error('CollectReferral error', { error: err.message });
        res.status(400).json({ error: err.message }); 
    }
}

// Get referral info
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
        logger.error('GetReferral error', { error: err.message });
        res.status(500).json({ error: 'Failed' }); 
    }
}

// Get referral list
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
        logger.error('GetReferralList error', { error: err.message });
        res.status(500).json({ error: 'Failed' }); 
    }
}

// Get notifications
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
        
        res.json({ 
            list, 
            unreadCount: list.filter(n => !n.read).length 
        });
    } catch (err) { 
        logger.error('GetNotifications error', { error: err.message });
        res.status(500).json({ error: 'Failed' }); 
    }
}

// Mark notifications as read
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
        logger.error('MarkNotificationsRead error', { error: err.message });
        res.status(500).json({ error: 'Failed' }); 
    }
}

// Transaction history
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
        logger.error('GetTransactionHistory error', { error: err.message });
        res.status(500).json({ error: 'Failed' }); 
    }
}

// ============================================
// ADMIN ENDPOINTS
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
        logger.error('AdminGetStats error', { error: err.message });
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
        logger.error('AdminGetUsers error', { error: err.message });
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
        logger.error('AdminGetWithdrawals error', { error: err.message });
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
        logger.error('AdminApproveWithdrawal error', { error: err.message });
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
        
        if (wdData.status === 'approved') {
            return res.status(400).json({ error: 'Already approved' });
        }
        
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
        logger.error('AdminRejectWithdrawal error', { error: err.message });
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
        logger.error('AdminBanUser error', { error: err.message });
        res.status(500).json({ error: 'Failed' }); 
    }
}

async function adminAddBalance(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    
    try {
        const { userId, amount, currency, reason } = req.body;
        
        if (!userId || !amount) {
            return res.status(400).json({ error: 'userId and amount required' });
        }
        
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
        logger.error('AdminAddBalance error', { error: err.message });
        res.status(500).json({ error: err.message || 'Failed' }); 
    }
}

async function adminBroadcast(req, res) {
    if (!db) return res.status(503).json({ error: 'DB not available' });
    
    try { 
        const botResult = await broadcastToUsers(req.body.message); 
        res.json({ success: true, bot: botResult }); 
    } catch (err) { 
        logger.error('AdminBroadcast error', { error: err.message });
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
        logger.error('AdminSendDM error', { error: err.message });
        res.status(500).json({ error: 'Failed' }); 
    }
}

// ============================================
// EXPRESS APP SETUP
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

// Routes
app.get('/ping', (req, res) => res.status(200).send('OK'));
app.get('/api/health', healthCheck);
app.post('/api/auth', authLimiter, auth);

app.use('/api', generalLimiter);

// User endpoints
app.get('/api/me', jwtAuth, getMe);
app.get('/api/prices', getPrices);
app.get('/api/captcha/:coin', jwtAuth, getCaptcha);
app.post('/api/claim/:coin', claimLimiter, jwtAuth, claim);
app.post('/api/withdraw', withdrawLimiter, jwtAuth, withdraw);
app.get('/api/withdrawals', jwtAuth, getWithdrawHistory);
app.get('/api/referral', jwtAuth, getReferral);
app.get('/api/referral/list', jwtAuth, getReferralList);
app.post('/api/referral/collect', jwtAuth, collectReferralBonus);
app.get('/api/notifications', jwtAuth, getNotifications);
app.post('/api/notifications/read', jwtAuth, markNotificationsRead);
app.get('/api/transactions', jwtAuth, getTransactionHistory);

// Admin endpoints
app.get('/api/admin/stats', adminAuth, adminGetStats);
app.get('/api/admin/users', adminAuth, adminGetUsers);
app.get('/api/admin/withdrawals', adminAuth, adminGetWithdrawals);
app.post('/api/admin/approve-withdrawal', adminAuth, adminApproveWithdrawal);
app.post('/api/admin/reject-withdrawal', adminAuth, adminRejectWithdrawal);
app.post('/api/admin/add-balance', adminAuth, adminAddBalance);
app.post('/api/admin/ban-user', adminAuth, adminBanUser);
app.post('/api/admin/broadcast', adminAuth, adminBroadcast);
app.post('/api/admin/send-dm', adminAuth, adminSendDM);

// Static files
const publicPath = path.join(__dirname, '..');
logger.info('Static path', { path: publicPath });

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

// Error handler
app.use((err, req, res, next) => { 
    logger.error('Express error', { error: err.message, path: req.path }); 
    res.status(500).json({ error: 'Internal server error' }); 
});

module.exports = app;

// ============================================
// SERVER START
// ============================================
if (require.main === module) {
    const server = app.listen(PORT, '0.0.0.0', () => {
        logger.info(`🚀 Coinix backend listening on port ${PORT}`);
        logger.info(`📁 Static path: ${publicPath}`);
        logger.info(`🌍 Environment: ${NODE_ENV}`);
        logger.info(`🔐 Turnstile: ${TURNSTILE_ENABLED ? 'Enabled' : 'Disabled'}`);
    });
    
    // Keep-alive ping for free hosts
    if (NODE_ENV === 'production' && APP_URL) {
        const PING_INTERVAL_MS = 14 * 60 * 1000; // 14 minutes
        setInterval(async () => { 
            try { 
                await axios.get(`${APP_URL}/ping`, { 
                    cache: 'no-store',
                    timeout: 5000
                }); 
                logger.debug('Keep-alive ping sent');
            } catch (e) { 
                logger.debug('Keep-alive ping failed', { error: e.message });
            } 
        }, PING_INTERVAL_MS);
    }
    
    // Graceful shutdown
    const shutdown = (signal) => {
        logger.info(`${signal} received, shutting down gracefully...`);
        server.close(() => {
            logger.info('Server closed');
            process.exit(0);
        });
        
        setTimeout(() => {
            logger.error('Forced shutdown');
            process.exit(1);
        }, 10000).unref();
    };
    
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

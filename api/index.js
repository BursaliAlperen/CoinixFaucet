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
// COIN CONFIGURATION
// ============================================
const COINS = {
  doge:    { symbol: 'DOGE',    name: 'Dogecoin',     claimAmount: 0.004,   priceId: 'dogecoin',                  decimals: 4, color: '#c2a633', svg: 'doge' },
  pepe:    { symbol: 'PEPE',    name: 'Pepe',         claimAmount: 1000,    priceId: 'pepe',                      decimals: 0, color: '#4caf50', svg: 'pepe' },
  pol:     { symbol: 'POL',     name: 'Polygon',      claimAmount: 0.05,    priceId: 'polygon-ecosystem-token',   decimals: 2, color: '#8247e5', svg: 'pol' },
  feyorra: { symbol: 'FEYORRA', name: 'Feyorra',      claimAmount: 1,       priceId: 'feyorra',                   decimals: 0, color: '#00d4ff', svg: 'feyorra', fallbackPrice: 0.0001 },
  dgb:     { symbol: 'DGB',     name: 'DigiByte',     claimAmount: 1.5,     priceId: 'digibyte',                  decimals: 2, color: '#0066ff', svg: 'dgb' }
};

const COIN_ORDER = ['doge', 'pepe', 'pol', 'feyorra', 'dgb'];

// ============================================
// CONFIG
// ============================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME || 'CoinixBot';
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  console.error('[CONFIG] JWT_SECRET missing! Using ephemeral secret.');
  return crypto.randomBytes(32).toString('hex');
})();
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '';
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || JWT_SECRET;
const OFFERWALLAPI_API_KEY = process.env.OFFERWALLAPI_API_KEY || '';
const OFFERWALLAPI_SECRET_KEY = process.env.OFFERWALLAPI_SECRET_KEY || '';
const OFFERWALLAPI_BEARER_TOKEN = process.env.OFFERWALLAPI_BEARER_TOKEN || '';
const APP_URL = process.env.APP_URL || 'https://coinixfaucet.onrender.com';
const PORT = process.env.PORT || 10000;
const FAUCETPAY_API_KEY = process.env.FAUCETPAY_API_KEY || '';
const FAUCETPAY_API_URL = 'https://faucetpay.io/api/v2/send';
const FAUCETPAY_CURRENCIES = { doge: 'DOGE', dgb: 'DGB', feyorra: 'FEY' };
const FAUCETPAY_ATOMIC_UNITS = { doge: 100000000, dgb: 100000000, feyorra: 100000000 };

const FAUCET_COOLDOWN = 180000; // 3 minutes
const CNX_DECIMALS = 6;
const CNX_SCALE = 10 ** CNX_DECIMALS;
const CNX_PER_USD = 10000;
const CNX_MIN_WITHDRAW = 300;
const CNX_FAUCET_REWARD = 5;
const CNX_SIGNUP_REFERRAL_BONUS = 50;
const CNX_RETURN_BONUS = 10;
const REFERRAL_COMMISSION_PERCENT = 20;
const BONUS_PERCENT = 20;
const BONUS_TYPES = ['ptc', 'shortlink', 'offer', 'task', 'game'];
const WITHDRAW_USD_MIN = 0.03;

function validateCriticalConfig() {
  const missing = [];
  if (!BOT_TOKEN) missing.push('BOT_TOKEN');
  if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
  if (!OFFERWALLAPI_API_KEY) missing.push('OFFERWALLAPI_API_KEY (OfferwallAPI disabled until configured)');
  if (!OFFERWALLAPI_SECRET_KEY) missing.push('OFFERWALLAPI_SECRET_KEY (postbacks disabled until configured)');
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON && !process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    missing.push('FIREBASE_SERVICE_ACCOUNT_JSON or BASE64');
  }
  if (missing.length) {
    console.error('[CONFIG] MISSING:', missing.join(', '));
  } else {
    console.log('[CONFIG] All critical env vars present');
  }
}
validateCriticalConfig();

// ============================================
// SECURITY
// ============================================
function setupSecurity(app) {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'", "https://offerwall.me", "https://*.offerwall.me", "https://richinfo.co", "https://*.richinfo.co", "https://dgbmining.pro"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net", "https://offerwall.me", "https://*.offerwall.me", "https://telegram.org", "https://richinfo.co", "https://*.richinfo.co", "https://dgbmining.pro", "https://adbits.online"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://richinfo.co", "https://*.richinfo.co"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:", "https:", "blob:"],
        connectSrc: ["'self'", "https://*.googleapis.com", "https://*.firebaseio.com", "https://api.coingecko.com", "https://offerwall.me", "https://richinfo.co", "https://*.richinfo.co"],
        frameSrc: ["'self'", "https://offerwall.me", "https://*.offerwall.me", "https://richinfo.co", "https://*.richinfo.co", "https://adbits.online"],
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
const generalLimiter = rateLimit({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 300000, max: 20, standardHeaders: true, legacyHeaders: false });
const claimLimiter = rateLimit({ windowMs: 60000, max: 30, standardHeaders: true, legacyHeaders: false });
const withdrawLimiter = rateLimit({ windowMs: 3600000, max: 10, standardHeaders: true, legacyHeaders: false });
const promoLimiter = rateLimit({ windowMs: 3600000, max: 30, standardHeaders: true, legacyHeaders: false });
const postbackLimiter = rateLimit({ windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false });

// ============================================
// NONCE / REPLAY GUARD
// ============================================
const usedNonces = new Map();
const NONCE_MAX_AGE = 5 * 60 * 1000;

function validateNonce(nonce, timestamp) {
  if (!nonce || !timestamp) return { valid: false, error: 'Nonce and timestamp required' };
  const ts = parseInt(timestamp);
  if (isNaN(ts) || Math.abs(Date.now() - ts) > 300000) {
    return { valid: false, error: 'Request expired or invalid timestamp' };
  }
  const key = `${nonce}:${ts}`;
  if (usedNonces.has(key)) {
    return { valid: false, error: 'Duplicate request detected' };
  }
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
// AUTH MIDDLEWARE
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
      if (key === 'hash') { hash = value; } else { params[key] = value; }
    }
    if (!hash) return false;
    if (params.auth_date) {
      const authDate = parseInt(params.auth_date, 10);
      const now = Math.floor(Date.now() / 1000);
      if (!isNaN(authDate) && Math.abs(now - authDate) > 300) {
        logger.warn('Init data auth_date too old', { authDate, now });
        return false;
      }
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
    await db.collection('logs').add({ action, user_id: String(userId), details, timestamp: serverTimestamp() });
  } catch (e) { logger.error('Log error', { error: e.message }); }
}

async function logTransaction(userId, type, amount, currency, description, metadata = {}) {
  if (!db) return;
  try {
    await db.collection('transactions').add({
      user_id: String(userId), type, amount: Number(amount), currency: currency || 'DOGE',
      description, metadata, timestamp: serverTimestamp()
    });
  } catch (e) { logger.error('Transaction log error', { error: e.message }); }
}

async function createNotification(userId, title, message, type = 'general') {
  if (!db) return;
  try {
    await db.collection('notifications').add({
      user_id: String(userId), title, message, type, read: false, timestamp: serverTimestamp()
    });
  } catch (e) { logger.error('Notification error', { error: e.message }); }
}

function getClientIP(req) {
  return (req.headers['x-forwarded-for'] || '0.0.0.0').split(',')[0].trim();
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
// TELEGRAM BOT API HELPERS
// ============================================
async function sendTelegramMessage(chatId, text, parseMode = 'HTML') {
  if (!BOT_TOKEN) return { ok: false, error: 'No bot token' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode })
    });
    const data = await res.json();
    return data;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function notifyAdminNewUser(userData, ref) {
  if (!ADMIN_TELEGRAM_ID) return;
  const text = `🎉 New User Registered\n\nID: ${userData.telegram_id}\nUsername: ${userData.username ? '@' + userData.username : 'N/A'}\nFirst Name: ${userData.first_name || 'N/A'}\nReferral: ${ref || 'None'}\nTime: ${new Date().toISOString()}`;
  await sendTelegramMessage(ADMIN_TELEGRAM_ID, text);
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
      if (res.ok) sent++; else failed++;
      await new Promise(r => setTimeout(r, 35));
    }
  } catch (e) {
    logger.error('Broadcast error', { error: e.message });
  }
  return { sent, failed };
}

// ============================================
// COIN PRICE CACHE (CoinGecko)
// ============================================
const priceCache = {};
let priceLastUpdate = 0;

async function fetchCoinPrices() {
  try {
    const ids = Object.values(COINS).map(c => c.priceId).filter(Boolean).join(',');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return;
    const data = await response.json();
    for (const [coinKey, coin] of Object.entries(COINS)) {
      const cgData = data[coin.priceId];
      if (cgData && cgData.usd != null) {
        priceCache[coinKey] = {
          price: cgData.usd,
          change: typeof cgData.usd_24h_change === 'number' ? cgData.usd_24h_change : 0,
          lastUpdate: Date.now()
        };
      } else if (coin.fallbackPrice) {
        if (!priceCache[coinKey]) {
          priceCache[coinKey] = { price: coin.fallbackPrice, change: 0, lastUpdate: Date.now() };
        }
      }
    }
    priceLastUpdate = Date.now();
    logger.info('[Prices] Updated', Object.keys(priceCache).length);
  } catch (err) {
    logger.error('Price fetch error', { error: err.message });
  }
}

function getCoinPrice(coinKey) {
  const cached = priceCache[coinKey];
  if (cached) return cached.price;
  const coin = COINS[coinKey];
  return coin?.fallbackPrice || 0;
}

function getMinWithdrawAmount(coinKey) {
  const price = getCoinPrice(coinKey);
  if (!price || price <= 0) return Infinity;
  return WITHDRAW_USD_MIN / price;
}

function cnxToAtomic(value) { const n = Number(value); return Number.isFinite(n) ? Math.round(n * CNX_SCALE) : 0; }
function atomicToCnx(value) { return Number(value || 0) / CNX_SCALE; }
function roundCnx(value) { return Math.round(Number(value || 0) * CNX_SCALE) / CNX_SCALE; }
function getMilestoneReward(totalClaims) {
  if (totalClaims < 25) return 0;
  let base = 25, reward = 10;
  while (base <= totalClaims) { if (totalClaims === base) return reward; base *= 10; reward *= 10; }
  return 0;
}

function getNextMilestone(totalClaims) {
  let base = 25;
  while (base <= totalClaims) base *= 10;
  return base;
}

// Initial fetch
fetchCoinPrices();
setInterval(fetchCoinPrices, 120000);

// ============================================
// OFFERWALLAPI
// ============================================
async function offerwallFetch(url) {
  const headers={Accept:'application/json'};
  if(OFFERWALLAPI_BEARER_TOKEN)headers.Authorization=`Bearer ${OFFERWALLAPI_BEARER_TOKEN}`;
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
  try{return await fetch(url,{headers,signal:controller.signal});}finally{clearTimeout(timeout);}
}
async function getOfferwallUrl(req,res) {
  if(!db)return res.status(503).json({error:'DB not available'});
  if(!OFFERWALLAPI_API_KEY)return res.status(503).json({error:'OfferwallAPI is not configured.'});
  const userId=String(req.user.userId);
  const url=`https://offerwallapi.com/offerwall/${encodeURIComponent(OFFERWALLAPI_API_KEY)}/${encodeURIComponent(userId)}`;
  res.json({success:true,url,user_id:userId});
}
async function getPTCAds(req,res) {
  if(!db)return res.status(503).json({error:'DB not available'});
  try {
    const userId=String(req.user.userId);
    if(!OFFERWALLAPI_API_KEY||!OFFERWALLAPI_BEARER_TOKEN)return res.json({success:true,ads:[],total:0,configured:false});
    const url=`https://offerwallapi.com/ptc-api/${encodeURIComponent(OFFERWALLAPI_API_KEY)}/${encodeURIComponent(userId)}/${encodeURIComponent(getClientIP(req))}`;
    const response=await offerwallFetch(url); if(!response.ok)return res.status(502).json({error:'OfferwallAPI PTC feed error'});
    const data=await response.json(); if(String(data.status)!=='200')return res.json({success:true,ads:[],total:0,message:data.message||'No ads available'});
    const ads=(data.data||[]).map(x=>({id:String(x.id||''),title:x.title||'PTC Ad',description:x.description||'',reward:Number(x.reward)||0,currency:x.currency_name||'CNX',duration:Number(x.duration)||30,url:x.url||'',type:x.ad_type||'Window'})).filter(x=>x.url);
    res.json({success:true,ads,total:ads.length});
  }catch(e){logger.error('OfferwallAPI PTC error',{error:e.message});res.status(500).json({error:'Failed to load PTC ads'});}
}
async function getShortlinks(req,res) {
  if(!db)return res.status(503).json({error:'DB not available'});
  try {
    const userId=String(req.user.userId);
    if(!OFFERWALLAPI_API_KEY||!OFFERWALLAPI_BEARER_TOKEN)return res.json({success:true,shortlinks:[],total:0,configured:false});
    const url=`https://offerwallapi.com/sl-api/${encodeURIComponent(OFFERWALLAPI_API_KEY)}/${encodeURIComponent(userId)}/${encodeURIComponent(getClientIP(req))}`;
    const response=await offerwallFetch(url);if(!response.ok)return res.status(502).json({error:'OfferwallAPI shortlink feed error'});
    const data=await response.json();if(String(data.status)!=='200')return res.json({success:true,shortlinks:[],total:0,message:data.message||'No shortlinks available'});
    const shortlinks=(data.data||[]).map(x=>({id:String(x.id||''),name:x.title||'Shortlink',reward:Number(x.reward)||0,currency:x.currency_name||'CNX',url:x.url||'',remaining_views:Number(x.available)||0,daily_limit:Number(x.limit)||0})).filter(x=>x.url);
    res.json({success:true,shortlinks,total:shortlinks.length});
  }catch(e){logger.error('OfferwallAPI shortlink error',{error:e.message});res.status(500).json({error:'Failed to load shortlinks'});}
}
async function getGames(req,res) {
  if(!db)return res.status(503).json({error:'DB not available'});
  try {
    const userId=String(req.user.userId);
    if(!OFFERWALLAPI_API_KEY||!OFFERWALLAPI_BEARER_TOKEN)return res.json({success:true,videos:[],total:0,configured:false});
    const url=`https://offerwallapi.com/video-api/${encodeURIComponent(OFFERWALLAPI_API_KEY)}/${encodeURIComponent(userId)}/${encodeURIComponent(getClientIP(req))}`;
    const response=await offerwallFetch(url);if(!response.ok)return res.status(502).json({error:'OfferwallAPI video feed error'});
    const data=await response.json();if(String(data.status)!=='200')return res.json({success:true,videos:[],total:0,message:data.message||'No videos available'});
    const videos=(data.data||[]).map(x=>({id:String(x.id||''),title:x.title||'Video',description:x.description||'',reward:Number(x.reward)||0,duration:Number(x.duration)||0,url:x.url||'',type:x.ad_type||'Iframe'})).filter(x=>x.url);
    res.json({success:true,videos,total:videos.length});
  }catch(e){logger.error('OfferwallAPI video error',{error:e.message});res.status(500).json({error:'Failed to load videos'});}
}



// ============================================
// POSTBACK
// ============================================
async function postback(req,res) {
  try {
    if(!OFFERWALLAPI_SECRET_KEY)return res.status(503).send('ERROR: OfferwallAPI secret not configured');
    const b=req.body||{},subId=String(b.subId??''),transId=String(b.transId??''),rewardRaw=String(b.reward??'');
    const signature=String(b.signature??''),signature2=String(b.signature2??''),status=Number.parseInt(b.status??'1',10);
    if(!subId||!transId||!rewardRaw||subId.length>64||transId.length>240)return res.status(400).send('ERROR: Missing params');
    if(!/^\d+(?:\.\d+)?$/.test(rewardRaw))return res.status(400).send('ERROR: Invalid reward');
    const safeEq=(a,c)=>{if(!a||!c||a.length!==c.length)return false;try{return crypto.timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(c,'hex'));}catch(_){return false;}};
    const message=subId+transId+rewardRaw;
    const expected2=crypto.createHmac('sha256',OFFERWALLAPI_SECRET_KEY).update(message).digest('hex');
    const expected1=crypto.createHash('md5').update(message+OFFERWALLAPI_SECRET_KEY).digest('hex');
    if(!safeEq(expected2,signature2)&&!safeEq(expected1,signature)){logger.warn('OfferwallAPI signature mismatch',{subId,transId});return res.status(403).send('ERROR: Signature mismatch');}
    const baseAmt=Number(rewardRaw);
    if(!Number.isFinite(baseAmt)||baseAmt<=0||baseAmt>1e9||![1,2].includes(status))return res.status(400).send('ERROR: Invalid reward/status');
    if(String(b.debug||'0')==='1')return res.status(200).send('ok');
    const userRef=db.collection('users').doc(subId),completionId=crypto.createHash('sha256').update(transId).digest('hex'),completionRef=db.collection('offerwall_completions').doc(completionId);
    const taskType=String(b.offer_type||'offer').toLowerCase().slice(0,40),eligible=BONUS_TYPES.some(t=>taskType.includes(t));
    const bonusAmt=status===1&&eligible?roundCnx(baseAmt*BONUS_PERCENT/100):0,totalAmt=roundCnx(baseAmt+bonusAmt);
    const baseAtomic=cnxToAtomic(baseAmt),totalAtomic=cnxToAtomic(totalAmt);let duplicate=false;
    await db.runTransaction(async t=>{
      const old=await t.get(completionRef);if(old.exists){duplicate=true;return;}
      const user=await t.get(userRef);if(!user.exists)throw new Error('User not found');
      const d=user.data();if(d.banned)throw new Error('User banned');
      if(status===1)t.update(userRef,{cnx_atomic:increment(totalAtomic),total_earned:increment(totalAmt),total_offerwall_earned:increment(totalAmt)});
      else {
        const debit=Math.min(baseAtomic,Math.max(0,Number(d.cnx_atomic||0)));
        if(debit>0)t.update(userRef,{cnx_atomic:increment(-debit),total_earned:increment(-atomicToCnx(debit)),total_offerwall_earned:increment(-atomicToCnx(debit))});
      }
      t.create(completionRef,{user_id:subId,trans_id:transId,task_type:taskType,offer_name:String(b.offer_name||'OfferwallAPI').slice(0,200),reward_name:b.reward_name||'CNX',reward_value:b.reward_value||String(CNX_PER_USD),payout:b.payout||null,user_ip:b.userIp||null,country:b.country||null,debug:b.debug||'0',base_amount:baseAmt,bonus_amount:bonusAmt,amount:status===1?totalAmt:baseAmt,currency:'CNX',status:status===1?'completed':'chargeback',timestamp:serverTimestamp()});
    });
    if(!duplicate&&status===1){await giveReferralBonus(subId,baseAmt,taskType);await logTransaction(subId,'offerwall',totalAmt,'CNX',`OfferwallAPI: ${b.offer_name||'Task'}`,{transId,taskType,bonus:bonusAmt});}
    if(!duplicate)await logAction('offerwallapi_postback',subId,{transId,amount:baseAmt,status,taskType});
    return res.status(200).send('ok');
  }catch(e){
    if(e.message==='User not found')return res.status(404).send('ERROR: User not found');
    if(e.message==='User banned')return res.status(403).send('ERROR: User banned');
    logger.error('OfferwallAPI postback error',{error:e.message});return res.status(500).send('ERROR: Server error');
  }
}



// ============================================
// AUTH
// ============================================
async function auth(req, res) {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  const { initData, ref, device_fp, nonce, timestamp } = req.body;
  if (!initData) return res.status(400).json({ error: 'Missing initData' });
  if (!validateTelegramInitData(initData)) return res.status(403).json({ error: 'Invalid signature' });
  if (nonce && timestamp) {
    const nonceCheck = validateNonce(nonce, timestamp);
    if (!nonceCheck.valid) return res.status(403).json({ error: nonceCheck.error });
  }
  let user;
  try {
    const pairs = initData.split('&');
    let userStr = '';
    for (const pair of pairs) {
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      const key = pair.substring(0, idx);
      const value = pair.substring(idx + 1);
      if (key === 'user') { userStr = decodeURIComponent(value); break; }
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
          return res.status(403).json({ error: 'This device is already linked to another account.' });
        }
      } else {
        await deviceRef.set({ telegram_id: userId, first_seen: serverTimestamp(), ua: req.headers['user-agent'] || null });
      }
    } catch (e) { logger.warn('Device FP check error', { error: e.message }); }
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
        balances: { doge: 0, pepe: 0, pol: 0, feyorra: 0, dgb: 0 }, // legacy balances retained, not spendable
        referral_balance: { doge: 0, pepe: 0, pol: 0, feyorra: 0, dgb: 0 },
        cnx_atomic: 0,
        referral_cnx_atomic: 0,
        total_earned: 0,
        total_claims: 0,
        total_withdrawals: 0,
        total_offerwall_earned: 0,
        total_promo_earned: 0,
        referrals: 0,
        referral_earnings: 0,
        referred_by: ref || null,
        banned: false,
        is_admin: String(userId) === String(ADMIN_TELEGRAM_ID),
        last_claim: null,
        last_opened: null,
        last_active: serverTimestamp(),
        inactivity_reminder_sent: false,
        return_bonus_claimed: false,
        daily_claims: 0,
        last_claim_date: null,
        created_at: serverTimestamp(),
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
                referral_cnx_atomic: increment(cnxToAtomic(CNX_SIGNUP_REFERRAL_BONUS)),
                referral_earnings: increment(CNX_SIGNUP_REFERRAL_BONUS)
              });
              const rbRef = db.collection('referralBonuses').doc();
              t.set(rbRef, {
                referrer: String(ref), referred: userId, amount: CNX_SIGNUP_REFERRAL_BONUS, currency: 'CNX',
                type: 'signup', timestamp: serverTimestamp()
              });
            });
          }
        }
      }
      await logAction('user_register', userId, { ref });
      await logTransaction(userId, 'signup', 0, 'CNX', 'Account created', { ref });
      await notifyAdminNewUser(newUser, ref);
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
    const token = jwt.sign({ userId, username: user.username, is_admin: isAdmin }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, user_id: userId, username: user.username, token, isNew, is_admin: isAdmin });
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
    const d = doc.data(), cnx = atomicToCnx(d.cnx_atomic), referralCnx = atomicToCnx(d.referral_cnx_atomic);
    res.json({
      telegram_id: d.telegram_id, username: d.username, first_name: d.first_name, photo_url: d.photo_url || null,
      balances: { cnx }, balancesUSD: { cnx: cnx / CNX_PER_USD }, totalUSD: cnx / CNX_PER_USD,
      total_earned: d.total_earned || 0, total_claims: d.total_claims || 0,
      total_withdrawals: d.total_withdrawals || 0, total_offerwall_earned: d.total_offerwall_earned || 0,
      total_promo_earned: d.total_promo_earned || 0, referrals: d.referrals || 0,
      referral_earnings: d.referral_earnings || 0, referral_balance: { cnx: referralCnx },
      daily_claims: d.daily_claims || 0, last_claim: tsToMillis(d.last_claim),
      last_opened: tsToMillis(d.last_opened), banned: d.banned || false,
      is_admin: String(d.telegram_id) === String(ADMIN_TELEGRAM_ID),
      currency: { code: 'CNX', decimals: CNX_DECIMALS, units_per_usd: CNX_PER_USD }
    });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
}

async function getBalance(req, res) {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  try {
    const doc = await db.collection('users').doc(String(req.user.userId)).get();
    if (!doc.exists) return res.json({ balances: { cnx: 0 }, referral_balance: { cnx: 0 }, total_claims: 0 });
    const d = doc.data();
    res.json({
      balances: { cnx: atomicToCnx(d.cnx_atomic) },
      referral_balance: { cnx: atomicToCnx(d.referral_cnx_atomic) },
      total_earned: d.total_earned || 0, total_claims: d.total_claims || 0,
      referrals: d.referrals || 0, last_claim: tsToMillis(d.last_claim), daily_claims: d.daily_claims || 0
    });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
}



async function getTodayEarnings(req, res) {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  try {
    const userId = String(req.user.userId);
    const startOfDay = startOfTodayTs();
    const faucetSnap = await db.collection('transactions')
      .where('user_id', '==', userId)
      .where('type', '==', 'faucet_claim')
      .where('timestamp', '>=', startOfDay)
      .get();
    const faucetTotal = faucetSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
    const offerSnap = await db.collection('transactions')
      .where('user_id', '==', userId)
      .where('type', '==', 'offerwall')
      .where('timestamp', '>=', startOfDay)
      .get();
    const offerTotal = offerSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
    res.json({ total: faucetTotal + offerTotal, faucet: faucetTotal, offerwall: offerTotal });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
}

async function getReferral(req, res) {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  try {
    const userId = String(req.user.userId);
    const doc = await db.collection('users').doc(userId).get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });
    const d = doc.data();
    const link = `https://t.me/${BOT_USERNAME}?start=ref_${userId}`;
    res.json({ link, referrals: d.referrals || 0, earnings: d.referral_earnings || 0, referral_balance: { cnx: atomicToCnx(d.referral_cnx_atomic) } });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
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
    const list = snap.docs.map(d => {
      const x = d.data();
      return {
        id: d.id,
        first_name: x.first_name || null,
        username: x.username || null,
        photo_url: x.photo_url || null,
        total_earned: x.total_earned || 0,
        created_at: tsToMillis(x.created_at)
      };
    });
    res.json({ count: list.length, list });
  } catch (err) {
    logger.error('getReferralList error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function giveReferralBonus(userId, amount, type) {
  if (!db || amount <= 0) return;
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists || !userDoc.data().referred_by) return;
    const referrerId = userDoc.data().referred_by;
    const bonusAmount = roundCnx(amount * REFERRAL_COMMISSION_PERCENT / 100);
    const bonusAtomic = cnxToAtomic(bonusAmount);
    if (bonusAtomic <= 0) return;
    const referrerRef = db.collection('users').doc(referrerId);
    await db.runTransaction(async t => {
      const refDoc = await t.get(referrerRef);
      if (refDoc.exists) t.update(referrerRef, { referral_cnx_atomic: increment(bonusAtomic), referral_earnings: increment(bonusAmount) });
    });
    await db.collection('referralBonuses').add({ referrer: referrerId, referred: userId, amount: bonusAmount, currency: 'CNX', type: type || 'unknown', timestamp: serverTimestamp() });
    await logTransaction(referrerId, 'referral', bonusAmount, 'CNX', `Referral bonus from ${userId}`, { referred: userId, sourceType: type });
  } catch (e) { logger.error('Referral bonus error', { error: e.message }); }
}

async function collectReferralBonus(req, res) {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  const userId = String(req.user.userId), userRef = db.collection('users').doc(userId);
  try {
    let amountAtomic = 0;
    await db.runTransaction(async t => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error('User not found');
      amountAtomic = Number(doc.data().referral_cnx_atomic || 0);
      if (amountAtomic <= 0) throw new Error('No referral balance');
      t.update(userRef, { cnx_atomic: increment(amountAtomic), referral_cnx_atomic: increment(-amountAtomic) });
    });
    const amount = atomicToCnx(amountAtomic);
    await logAction('referral_collected', userId, { amount, currency: 'CNX' });
    await logTransaction(userId, 'referral_collect', amount, 'CNX', 'Collected referral earnings');
    res.json({ success: true, amount, coin: 'CNX' });
  } catch (err) { res.status(400).json({ error: err.message }); }
}



// ============================================
// ACTIVITY & RETURN BONUS
// ============================================
async function updateActivity(req, res) {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  const userId = String(req.user.userId);
  const userRef = db.collection('users').doc(userId);
  try {
    const doc = await userRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });
    const d = doc.data();
    const now = Date.now();
    const lastOpened = d.last_opened ? d.last_opened.toMillis() : 0;
    const threeDays = 3 * 24 * 60 * 60 * 1000;
    let bonusGranted = false;
    const updates = { last_opened: serverTimestamp(), last_active: serverTimestamp() };
    if (lastOpened && (now - lastOpened) >= threeDays && !d.return_bonus_claimed) {
      updates.cnx_atomic = increment(cnxToAtomic(CNX_RETURN_BONUS));
      updates.return_bonus_claimed = true;
      updates.total_earned = increment(CNX_RETURN_BONUS);
      bonusGranted = true;
      await logTransaction(userId, 'return_bonus', CNX_RETURN_BONUS, 'CNX', 'Return after inactivity bonus');
      await createNotification(userId, 'Welcome Back!', `You received ${CNX_RETURN_BONUS} CNX for coming back!`, 'reward');
    }
    if (d.inactivity_reminder_sent) {
      updates.inactivity_reminder_sent = false;
    }
    await userRef.update(updates);
    res.json({ success: true, bonusGranted, bonusAmount: bonusGranted ? CNX_RETURN_BONUS : 0, coin: 'CNX' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
}

// ============================================
// CUSTOM ICON CAPTCHA
// ============================================
const activeCaptchas = new Map();

const CAPTCHA_ICONS = ['⚡', '💎', '🔥', '⭐', '🎯', '🚀', '💰', '🎲', '', '🏆', '', '🎪'];

function generateIconCaptcha(userId) {
  if (activeCaptchas.size > 5000) {
    const firstKey = activeCaptchas.keys().next().value;
    activeCaptchas.delete(firstKey);
  }
  // Pick 4 random icons, one is the "target" (shown upright), others are rotated
  const targetIdx = Math.floor(Math.random() * CAPTCHA_ICONS.length);
  const targetIcon = CAPTCHA_ICONS[targetIdx];
  // Pick 3 distractors
  const distractors = [];
  while (distractors.length < 3) {
    const idx = Math.floor(Math.random() * CAPTCHA_ICONS.length);
    if (idx !== targetIdx && !distractors.includes(CAPTCHA_ICONS[idx])) {
      distractors.push(CAPTCHA_ICONS[idx]);
    }
  }
  // Shuffle all 4
  const allIcons = [targetIcon, ...distractors];
  for (let i = allIcons.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allIcons[i], allIcons[j]] = [allIcons[j], allIcons[i]];
  }
  // Target is shown rotated 180deg in instruction, user must find the upright one
  // Actually: show "Find the icon that matches: [icon]" and display 4 options, one correct
  const answer = targetIcon;
  activeCaptchas.set(userId, { answer, icons: allIcons, expiresAt: Date.now() + 5 * 60 * 1000 });
  return { icons: allIcons, target: targetIcon, expiresAt: Date.now() + 5 * 60 * 1000 };
}

function verifyIconCaptcha(userId, userAnswer) {
  const captcha = activeCaptchas.get(userId);
  if (!captcha) return { valid: false, error: 'No active captcha' };
  if (Date.now() > captcha.expiresAt) {
    activeCaptchas.delete(userId);
    return { valid: false, error: 'Captcha expired' };
  }
  if (userAnswer !== captcha.answer) {
    activeCaptchas.delete(userId);
    return { valid: false, error: 'Wrong icon selected' };
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
    const captcha = generateIconCaptcha(userId);
    res.json({ success: true, ...captcha });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function verifyCaptchaEndpoint(req, res) {
  try {
    const userId = String(req.user.userId);
    const { answer } = req.body;
    if (!answer) return res.status(400).json({ valid: false, error: 'Answer required' });
    res.json(verifyIconCaptcha(userId, answer));
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

// ============================================
// FAUCET CLAIM
// ============================================
async function claim(req, res) {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  const userId = String(req.user.userId), { captchaAnswer, nonce, timestamp } = req.body;
  if (!captchaAnswer) return res.status(400).json({ error: 'Captcha required', captchaRequired: true });
  if (nonce && timestamp) { const n = validateNonce(nonce, timestamp); if (!n.valid) return res.status(403).json({ error: n.error }); }
  const captchaResult = verifyIconCaptcha(userId, captchaAnswer);
  if (!captchaResult.valid) return res.status(403).json({ error: captchaResult.error, captchaRequired: true });
  const userRef = db.collection('users').doc(userId);
  try {
    const now = Date.now(), todayStr = new Date().toDateString();
    let newBalance = 0, milestoneReward = 0, milestoneHit = false;
    const claimAtomic = cnxToAtomic(CNX_FAUCET_REWARD);
    await db.runTransaction(async t => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error('User not found');
      const d = doc.data();
      if (d.banned) throw new Error('User banned');
      const lastClaim = d.last_claim ? d.last_claim.toMillis() : 0;
      if (now - lastClaim < FAUCET_COOLDOWN) throw new Error(`Cooldown|${FAUCET_COOLDOWN - (now - lastClaim)}`);
      const recent = await db.collection('transactions').where('user_id','==',userId).where('type','==','faucet_claim').where('timestamp','>=',Timestamp.fromMillis(now-5000)).limit(1).get();
      if (!recent.empty) throw new Error('Duplicate claim detected');
      const totalClaims = (d.total_claims || 0) + 1;
      let dailyClaims = d.last_claim_date !== todayStr ? 0 : (d.daily_claims || 0);
      dailyClaims++;
      milestoneReward = getMilestoneReward(totalClaims); milestoneHit = milestoneReward > 0;
      const totalAtomic = claimAtomic + cnxToAtomic(milestoneReward);
      newBalance = atomicToCnx(Number(d.cnx_atomic || 0) + totalAtomic);
      t.update(userRef, {
        cnx_atomic: increment(totalAtomic), total_earned: increment(CNX_FAUCET_REWARD + milestoneReward),
        total_claims: increment(1), last_claim: serverTimestamp(), last_active: serverTimestamp(),
        daily_claims: dailyClaims, last_claim_date: todayStr
      });
      t.set(db.collection('transactions').doc(), { user_id:userId, type:'faucet_claim', amount:CNX_FAUCET_REWARD, currency:'CNX', description:'Faucet claim CNX', metadata:{ milestone:milestoneReward }, timestamp:serverTimestamp() });
      if (milestoneHit) t.set(db.collection('transactions').doc(), { user_id:userId, type:'milestone', amount:milestoneReward, currency:'CNX', description:`Milestone reward: ${totalClaims} claims`, metadata:{ totalClaims }, timestamp:serverTimestamp() });
    });
    await giveReferralBonus(userId, CNX_FAUCET_REWARD, 'faucet');
    await logAction('faucet_claim', userId, { amount: CNX_FAUCET_REWARD, currency:'CNX', milestone: milestoneHit });
    if (milestoneHit) await createNotification(userId, '🏆 Milestone!', `Milestone reached! +${milestoneReward} CNX bonus!`, 'milestone');
    res.json({ success:true, amount:CNX_FAUCET_REWARD, balance:newBalance, coin:'CNX', milestone:milestoneHit, milestoneReward });
  } catch (err) {
    const msg=err.message||'';
    if (msg.includes('Cooldown')) return res.status(429).json({ error:'Cooldown active', wait:parseInt(msg.split('|')[1])||FAUCET_COOLDOWN });
    if (msg.includes('User banned')) return res.status(403).json({ error:'User banned' });
    if (msg.includes('User not found')) return res.status(404).json({ error:'User not found' });
    if (msg.includes('Duplicate')) return res.status(429).json({ error:'Duplicate claim detected' });
    logger.error('CNX claim failed',{userId,error:msg}); return res.status(500).json({ error:'Claim failed' });
  }
}



// ============================================
// WITHDRAW
// ============================================
async function withdraw(req, res) {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  if (!FAUCETPAY_API_KEY) return res.status(503).json({ error: 'FaucetPay is not configured yet.' });
  const userId=String(req.user.userId), {faucetpay_email,amount,nonce,timestamp}=req.body, amt=Number(amount);
  if (!Number.isFinite(amt)||amt<=0) return res.status(400).json({error:'Invalid CNX amount'});
  const cnxAtomic=cnxToAtomic(amt);
  if (!Number.isSafeInteger(cnxAtomic)||cnxAtomic<=0||Math.abs(atomicToCnx(cnxAtomic)-amt)>1e-8) return res.status(400).json({error:'CNX supports up to 6 decimal places.'});
  if (amt<CNX_MIN_WITHDRAW) return res.status(400).json({error:`Minimum withdrawal: ${CNX_MIN_WITHDRAW} CNX ($0.03)`});
  if (typeof faucetpay_email!=='string'||faucetpay_email.length>160||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(faucetpay_email.trim())) return res.status(400).json({error:'Enter a valid FaucetPay email address.'});
  if (nonce&&timestamp) { const n=validateNonce(nonce,timestamp); if(!n.valid)return res.status(403).json({error:n.error}); }
  const dogePrice=getCoinPrice('doge');
  if(!Number.isFinite(dogePrice)||dogePrice<=0)return res.status(503).json({error:'DOGE/USD price is temporarily unavailable.'});
  const usdAmount=amt/CNX_PER_USD, atomicAmount=Math.round((usdAmount/dogePrice)*1e8);
  if(!Number.isSafeInteger(atomicAmount)||atomicAmount<=0)return res.status(400).json({error:'Converted DOGE amount is too small.'});
  const dogeAmount=atomicAmount/1e8, userRef=db.collection('users').doc(userId), wdRef=db.collection('withdrawals').doc(), idempotencyKey=wdRef.id;
  try {
    await db.runTransaction(async t=>{
      const doc=await t.get(userRef); if(!doc.exists)throw new Error('User not found');
      const d=doc.data(); if(d.banned)throw new Error('User banned');
      if(Number(d.cnx_atomic||0)<cnxAtomic)throw new Error('Insufficient CNX balance');
      const recent=await db.collection('transactions').where('user_id','==',userId).where('type','==','withdraw').where('timestamp','>=',Timestamp.fromMillis(Date.now()-5000)).limit(1).get();
      if(!recent.empty)throw new Error('Duplicate withdrawal detected');
      t.update(userRef,{cnx_atomic:increment(-cnxAtomic),total_withdrawals:increment(1),last_active:serverTimestamp()});
      t.set(wdRef,{user_id:userId,faucetpay_email:faucetpay_email.trim(),amount:amt,amount_cnx:amt,amount_usd:usdAmount,doge_amount:dogeAmount,amount_atomic:atomicAmount,coin:'cnx',currency:'DOGE',status:'processing',provider:'faucetpay',idempotency_key:idempotencyKey,timestamp:serverTimestamp()});
      t.set(db.collection('transactions').doc(),{user_id:userId,type:'withdraw',amount:amt,currency:'CNX',description:'CNX to DOGE FaucetPay withdrawal',metadata:{faucetpay_email:faucetpay_email.trim(),cnx:amt,usd:usdAmount,doge:dogeAmount,withdrawal_id:wdRef.id},timestamp:serverTimestamp()});
    });
    let providerResponse;
    try {
      const controller=new AbortController(), timeout=setTimeout(()=>controller.abort(),15000);
      const response=await fetch(FAUCETPAY_API_URL,{method:'POST',headers:{Authorization:`Bearer ${FAUCETPAY_API_KEY}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({idempotency_key:idempotencyKey,to:faucetpay_email.trim(),amount:atomicAmount,currency:'DOGE',ip_address:getClientIP(req)}),signal:controller.signal});
      clearTimeout(timeout); providerResponse=await response.json().catch(()=>({}));
      if(!response.ok||providerResponse.success!==true){const e=new Error(String(providerResponse.message||'FaucetPay rejected payout').slice(0,240));e.faucetpayDefinitiveFailure=true;throw e;}
    } catch(e) {
      if(!e.faucetpayDefinitiveFailure){await wdRef.update({status:'processing',provider_note:'Provider response not confirmed; payout requires reconciliation.',updated_at:serverTimestamp()}).catch(()=>{});return res.status(202).json({success:true,id:wdRef.id,status:'processing',message:'Withdrawal is being verified. Do not submit again.'});}
      await db.runTransaction(async t=>{const u=await t.get(userRef);if(u.exists)t.update(userRef,{cnx_atomic:increment(cnxAtomic)});t.update(wdRef,{status:'failed',failure_reason:String(e.message).slice(0,240),failed_at:serverTimestamp()});t.set(db.collection('transactions').doc(),{user_id:userId,type:'withdraw_refund',amount:amt,currency:'CNX',description:'Refunded failed CNX withdrawal',metadata:{withdrawal_id:wdRef.id},timestamp:serverTimestamp()});});
      return res.status(502).json({error:`FaucetPay payment failed: ${e.message}. Your CNX was returned.`});
    }
    const payout=providerResponse.data||{};
    await wdRef.update({status:'approved',payout_id:payout.payout_id||null,payout_user_hash:payout.payout_user_hash||null,provider_message:providerResponse.message||'OK',completed_at:serverTimestamp()});
    await logAction('faucetpay_withdrawal_paid',userId,{withdrawalId:wdRef.id,cnx:amt,usd:usdAmount,doge:dogeAmount,payoutId:payout.payout_id||null});
    return res.json({success:true,id:wdRef.id,status:'paid',payout_id:payout.payout_id||null,coin:'DOGE',amount:dogeAmount,amount_cnx:amt,amount_usd:usdAmount});
  } catch(err) {
    if(err.message?.includes('Insufficient'))return res.status(400).json({error:err.message});
    if(err.message?.includes('Duplicate'))return res.status(429).json({error:err.message});
    if(err.message?.includes('User banned'))return res.status(403).json({error:'User banned'});
    if(err.message?.includes('User not found'))return res.status(404).json({error:'User not found'});
    logger.error('CNX withdrawal failed',{userId,withdrawalId:wdRef.id,error:err.message});
    return res.status(500).json({error:'Withdrawal could not be processed. Contact support before retrying.'});
  }
}



async function getWithdrawHistory(req, res) {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  try {
    const userId = String(req.user.userId);
    const snapshot = await db.collection('withdrawals').where('user_id', '==', userId).orderBy('timestamp', 'desc').limit(50).get();
    res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data(), timestamp: tsToMillis(d.data().timestamp) })));
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function getPrices(req, res) {
  try {
    const prices = {};
    for (const [key, coin] of Object.entries(COINS)) {
      const cached = priceCache[key];
      prices[key] = {
        symbol: coin.symbol,
        price: cached?.price || coin.fallbackPrice || 0,
        change: cached?.change || 0,
        minWithdraw: getMinWithdrawAmount(key),
        lastUpdate: cached?.lastUpdate || 0
      };
    }
    res.json({ prices, lastUpdate: priceLastUpdate });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function getLivePayouts(req, res) {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  try {
    const snapshot = await db.collection('withdrawals')
      .where('status', '==', 'approved')
      .orderBy('timestamp', 'desc')
      .limit(20)
      .get();
    const payouts = [];
    for (const doc of snapshot.docs) {
      const d = doc.data();
      const userDoc = await db.collection('users').doc(String(d.user_id)).get();
      const username = userDoc.exists ? (userDoc.data().username || `User${d.user_id.slice(0,4)}`) : `User${d.user_id.slice(0,4)}`;
      payouts.push({
        username,
        amount: d.amount,
        coin: COINS[d.coin]?.symbol || d.coin || 'DOGE',
        timestamp: tsToMillis(d.timestamp)
      });
    }
    res.json({ payouts });
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
    const targetCoin = 'cnx';
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
    if (promo.usedBy && Array.isArray(promo.usedBy) && promo.usedBy.includes(userId)) return res.status(400).json({ error: 'Already used' });
    const userRef = db.collection('users').doc(userId);
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
      if (fp.usedBy && Array.isArray(fp.usedBy) && fp.usedBy.includes(userId)) throw new Error('Already used');
      const rewardAtomic = cnxToAtomic(reward);
      t.update(userRef, { cnx_atomic: increment(rewardAtomic), total_earned: increment(roundCnx(reward)), total_promo_earned: increment(roundCnx(reward)), last_active: serverTimestamp() });
      t.update(promoRef, {
        usedCount: increment(1),
        usedBy: FieldValue ? FieldValue.arrayUnion(userId) : [...(fp.usedBy || []), userId]
      });
      const useRef = db.collection('promo_uses').doc();
      t.set(useRef, {
        user_id: userId, code, reward: roundCnx(reward), coin: 'cnx', currency: 'CNX',
        timestamp: serverTimestamp()
      });
      const txRef = db.collection('transactions').doc();
      t.set(txRef, {
        user_id: userId, type: 'promo', amount: reward,
        currency: 'CNX', description: `Promo code: ${code}`,
        metadata: { code, targetCoin: 'cnx' }, timestamp: serverTimestamp()
      });
    });
    await logAction('promo_redeem', userId, { code, reward, coin: targetCoin });
    res.json({ success: true, code, reward: roundCnx(reward), coin: 'CNX' });
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
      return { id: d.id, code: data.code, reward: data.reward, coin: data.coin, usedAt: tsToMillis(data.timestamp) };
    });
    const totalBonus = history.reduce((s, h) => s + (h.reward || 0), 0);
    res.json({ history, totalBonus, count: history.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ============================================
// NOTIFICATIONS
// ============================================
async function getNotifications(req, res) {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  try {
    const userId = String(req.user.userId);
    const snap = await db.collection('notifications')
      .where('user_id', '==', userId)
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();
    const list = snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id, title: data.title, message: data.message,
        type: data.type, read: data.read || false,
        timestamp: tsToMillis(data.timestamp)
      };
    });
    const unreadCount = list.filter(n => !n.read).length;
    res.json({ list, unreadCount });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function markNotificationsRead(req, res) {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  try {
    const userId = String(req.user.userId);
    const { ids } = req.body;
    if (ids && Array.isArray(ids) && ids.length > 0) {
      const batch = db.batch();
      for (const id of ids.slice(0, 10)) {
        batch.update(db.collection('notifications').doc(id), { read: true });
      }
      await batch.commit();
    } else {
      const snap = await db.collection('notifications')
        .where('user_id', '==', userId)
        .where('read', '==', false)
        .limit(50)
        .get();
      const batch = db.batch();
      snap.docs.forEach(d => batch.update(d.ref, { read: true }));
      await batch.commit();
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

// ============================================
// TRANSACTION HISTORY
// ============================================
async function getTransactionHistory(req, res) {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  try {
    const userId = String(req.user.userId);
    const { type, limit = 50 } = req.query;
    let query = db.collection('transactions')
      .where('user_id', '==', userId)
      .orderBy('timestamp', 'desc')
      .limit(parseInt(limit) || 50);
    if (type) {
      query = db.collection('transactions')
        .where('user_id', '==', userId)
        .where('type', '==', type)
        .orderBy('timestamp', 'desc')
        .limit(parseInt(limit) || 50);
    }
    const snap = await query.get();
    const list = snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id, type: data.type, amount: data.amount,
        currency: data.currency, description: data.description,
        metadata: data.metadata || {},
        timestamp: tsToMillis(data.timestamp)
      };
    });
    res.json({ list, count: list.length });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
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
        code: d.id, reward: data.reward || 0,
        usageLimit: data.usageLimit || 0, usedCount: data.usedCount || 0,
        enabled: data.enabled !== false,
        createdAt: tsToMillis(data.createdAt),
        expiresAt: tsToMillis(data.expiresAt)
      };
    });
    res.json(list);
  } catch (err) { res.status(500).json({ error: err.message }); }
}

async function adminCreatePromo(req, res) {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  try {
    const code = validatePromoCode(req.body.code);
    const reward = Number(req.body.reward);
    const usageLimit = req.body.usageLimit ? parseInt(req.body.usageLimit) : 100;
    const expiresAt = req.body.expiresAt || null;
    if (!code) return res.status(400).json({ error: 'Invalid code' });
    if (!reward || reward <= 0 || isNaN(reward)) return res.status(400).json({ error: 'Invalid reward' });
    const promoRef = db.collection('promoCodes').doc(code);
    if ((await promoRef.get()).exists) return res.status(400).json({ error: 'Code already exists' });
    await promoRef.set({
      code, reward, usageLimit, usedCount: 0, usedBy: [], enabled: true,
      createdBy: req.user.userId, createdAt: serverTimestamp(),
      expiresAt: expiresAt ? new Date(expiresAt) : null
    });
    await logAction('promo_create', req.user.userId, { code, reward, usageLimit });
    res.json({ success: true, code, reward, usageLimit });
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
    const { search, banned, sortBy = 'created_at', order = 'desc', limit = 50 } = req.query;
    let query = db.collection('users').orderBy(sortBy, order === 'asc' ? 'asc' : 'desc');
    if (banned === 'true') {
      query = db.collection('users').where('banned', '==', true).orderBy('created_at', 'desc');
    } else if (banned === 'false') {
      query = db.collection('users').where('banned', '==', false).orderBy('created_at', 'desc');
    }
    const snap = await query.limit(parseInt(limit) || 50).get();
    let users = snap.docs.map(d => ({
      id: d.id, ...d.data(),
      created_at: tsToMillis(d.data().created_at),
      last_active: tsToMillis(d.data().last_active)
    }));
    if (search) {
      const q = search.toLowerCase();
      users = users.filter(u =>
        (u.first_name || '').toLowerCase().includes(q) ||
        (u.username || '').toLowerCase().includes(q) ||
        String(u.id).includes(q)
      );
    }
    res.json(users);
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function adminGetUserDetail(req, res) {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  try {
    const userId = String(req.params.userId);
    const doc = await db.collection('users').doc(userId).get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });
    const d = doc.data();
    const txSnap = await db.collection('transactions')
      .where('user_id', '==', userId)
      .orderBy('timestamp', 'desc')
      .limit(20)
      .get();
    const transactions = txSnap.docs.map(d => ({
      id: d.id, ...d.data(),
      timestamp: tsToMillis(d.data().timestamp)
    }));
    res.json({
      user: { id: doc.id, ...d, created_at: tsToMillis(d.created_at) },
      transactions
    });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function adminGetWithdrawals(req, res) {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  try {
    const { status } = req.query;
    let query = db.collection('withdrawals').orderBy('timestamp', 'desc');
    if (status) query = query.where('status', '==', status);
    const snap = await query.limit(200).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data(), timestamp: tsToMillis(d.data().timestamp) })));
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function adminApproveWithdrawal(req, res) {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  try {
    const id = req.body.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    await db.collection('withdrawals').doc(id).update({ status: 'approved', approved_at: serverTimestamp(), approved_by: req.user.userId });
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
      if (u.exists) {
        const coin = wdData.coin || 'doge';
        t.update(u.ref, { [`balances.${coin}`]: increment(wdData.amount || 0) });
      }
      t.update(wdRef, { status: 'rejected', rejected_at: serverTimestamp(), rejected_by: req.user.userId });
    });
    await logAction('withdrawal_rejected', req.user.userId, { id });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function adminBanUser(req, res) {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  try {
    const { userId, reason } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    await db.collection('users').doc(String(userId)).update({ banned: true, ban_reason: reason || 'Admin ban', banned_at: serverTimestamp(), banned_by: req.user.userId });
    await logAction('user_ban', req.user.userId, { bannedUser: String(userId), reason });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function adminUnbanUser(req, res) {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    await db.collection('users').doc(String(userId)).update({ banned: false, unbanned_at: serverTimestamp(), unbanned_by: req.user.userId });
    await logAction('user_unban', req.user.userId, { unbannedUser: String(userId) });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function adminAddBalance(req, res) {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  try {
    const { userId, amount, coin, reason } = req.body;
    if (!userId || !amount) return res.status(400).json({ error: 'userId and amount required' });
    const targetCoin = coin || 'doge';
    if (!COINS[targetCoin]) return res.status(400).json({ error: 'Invalid coin' });
    const amt = Number(amount);
    await db.runTransaction(async (t) => {
      const u = await t.get(db.collection('users').doc(String(userId)));
      if (!u.exists) throw new Error('User not found');
      t.update(u.ref, { [`balances.${targetCoin}`]: increment(amt), last_active: serverTimestamp() });
      const txRef = db.collection('transactions').doc();
      t.set(txRef, {
        user_id: String(userId), type: 'admin_edit', amount: amt,
        currency: COINS[targetCoin].symbol,
        description: `Admin balance edit: ${reason || 'No reason'}`,
        metadata: { adminId: req.user.userId, reason, coin: targetCoin },
        timestamp: serverTimestamp()
      });
    });
    await logAction('admin_add_balance', req.user.userId, { userId: String(userId), amount, coin: targetCoin, reason });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message || 'Failed' }); }
}

async function adminGetLogs(req, res) {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  try {
    const snap = await db.collection('logs').orderBy('timestamp', 'desc').limit(100).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data(), timestamp: tsToMillis(d.data().timestamp) })));
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function adminGetStats(req, res) {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  try {
    const now = Date.now();
    const fiveMinAgo = Timestamp.fromDate(new Date(now - 5 * 60 * 1000));
    const oneDayAgo = Timestamp.fromDate(new Date(now - 24 * 60 * 60 * 1000));
    const sevenDaysAgo = Timestamp.fromDate(new Date(now - 7 * 24 * 60 * 60 * 1000));
    const todayStart = startOfTodayTs();
    const todayStartMs = tsToMillis(todayStart);
    const usersSnap = await db.collection('users').get();
    const wdSnap = await db.collection('withdrawals').get();
    const offerSnap = await db.collection('offerwall_completions').get();
    const promoSnap = await db.collection('promo_uses').get();
    const claimsSnap = await db.collection('transactions').where('type', '==', 'faucet_claim').get().catch(() => ({ size: 0, docs: [] }));
    const users = usersSnap.docs;
    const totalUsers = users.length;
    const todaysUsers = users.filter(d => {
      const ms = tsToMillis(d.data().created_at);
      return ms && ms >= todayStartMs;
    }).length;
    const onlineUsers = users.filter(d => {
      const ms = tsToMillis(d.data().last_active);
      return ms && ms >= fiveMinAgo.toMillis();
    }).length;
    const activeUsers = users.filter(d => {
      const ms = tsToMillis(d.data().last_active);
      return ms && ms >= oneDayAgo.toMillis();
    }).length;
    const weeklyActiveUsers = users.filter(d => {
      const ms = tsToMillis(d.data().last_active);
      return ms && ms >= sevenDaysAgo.toMillis();
    }).length;
    const pendingWithdraws = wdSnap.docs.filter(d => d.data().status === 'pending').length;
    const approvedWithdraws = wdSnap.docs.filter(d => d.data().status === 'approved').length;
    const rejectedWithdraws = wdSnap.docs.filter(d => d.data().status === 'rejected').length;
    const totalFaucetPaid = claimsSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
    const totalOfferwallEarnings = offerSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
    const totalPromoEarnings = promoSnap.docs.reduce((s, d) => s + (d.data().reward || 0), 0);
    const totalWithdrawals = wdSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
    const totalRevenue = totalOfferwallEarnings * 0.3;
    res.json({
      totalUsers, todaysUsers, onlineUsers,
      pendingWithdraws, approvedWithdraws, rejectedWithdraws,
      totalFaucetClaims: claimsSnap.size,
      totalFaucetPaid,
      totalOfferwallEarnings,
      totalPromoEarnings,
      totalWithdrawals,
      totalRevenue: Math.round(totalRevenue * 1e8) / 1e8,
      activeUsers, dailyActiveUsers: activeUsers, weeklyActiveUsers,
      bannedUsers: users.filter(d => d.data().banned).length
    });
  } catch (err) {
    logger.error('Admin stats error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
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
    let botResult = await broadcastToUsers(message);
    res.json({ success: true, bot: botResult });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
}

async function adminSendDM(req, res) {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  try {
    const { userId, message } = req.body;
    if (!userId || !message) return res.status(400).json({ error: 'userId and message required' });
    const target = await db.collection('users').doc(String(userId)).get();
    if (!target.exists) return res.status(404).json({ error: 'User not found' });
    await db.collection('admin_dms').add({
      user_id: String(userId), message, sent_by: req.user.userId, timestamp: serverTimestamp()
    });
    let botSent = false, botError = null;
    try {
      const result = await sendTelegramMessage(String(userId), message, 'Markdown');
      botSent = result.ok;
      if (!result.ok) botError = result.description || 'Unknown';
    } catch (e) {
      botError = e.message;
    }
    await logAction('admin_dm', req.user.userId, { targetUser: String(userId), botSent, botError });
    res.json({ success: true, bot_sent: botSent, bot_error: botError });
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
app.post('/api/withdraw', withdrawLimiter, jwtAuth, withdraw);
app.get('/api/withdrawals', jwtAuth, getWithdrawHistory);
app.get('/api/referral', jwtAuth, getReferral);
app.get('/api/referral/list', jwtAuth, getReferralList);
app.post('/api/referral/collect', jwtAuth, collectReferralBonus);
app.get('/api/prices', getPrices);
app.get('/api/live-payouts', getLivePayouts);
app.get('/api/today-earnings', jwtAuth, getTodayEarnings);
app.post('/api/activity', jwtAuth, updateActivity);
app.get('/api/offerwall/offerwall', jwtAuth, getOfferwallUrl);
app.get('/api/offerwall/ptc', jwtAuth, getPTCAds);
app.get('/api/offerwall/shortlinks', jwtAuth, getShortlinks);
app.get('/api/offerwall/games', jwtAuth, getGames);
app.post('/api/offerwallapi/postback', postbackLimiter, postback);
app.post('/api/postback', postbackLimiter, postback); // legacy alias
app.post('/api/promo/redeem', promoLimiter, jwtAuth, redeemPromo);
app.get('/api/promo/history', jwtAuth, getPromoHistory);
app.get('/api/notifications', jwtAuth, getNotifications);
app.post('/api/notifications/read', jwtAuth, markNotificationsRead);
app.get('/api/transactions', jwtAuth, getTransactionHistory);
app.get('/api/stats/global', getGlobalStats);
app.get('/api/admin/stats', adminAuth, adminGetStats);
app.get('/api/admin/users', adminAuth, adminGetUsers);
app.get('/api/admin/users/:userId', adminAuth, adminGetUserDetail);
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
app.post('/api/admin/send-dm', adminAuth, adminSendDM);
app.get('/api/admin/promo/list', adminAuth, adminListPromos);
app.post('/api/admin/promo/create', adminAuth, adminCreatePromo);
app.post('/api/admin/promo/toggle', adminAuth, adminTogglePromo);
app.post('/api/admin/promo/delete', adminAuth, adminDeletePromo);

// ============================================
// STATIC FILE SERVING
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
// SPA FALLBACK
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
  if (process.env.NODE_ENV === 'production') {
    res.status(500).json({ error: 'Internal server error' });
  } else {
    res.status(500).json({ error: 'Internal server error', debug: err.message });
  }
});

module.exports = app;

if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Coinix backend listening on port ${PORT}`);
    logger.info(`Static path: ${publicPath}`);
    logger.info(`App URL: ${APP_URL}`);
  });

  if (firebaseInitialized && BOT_TOKEN) {
    const scheduleInactiveScan = () => {
      const now = new Date();
      const nextRun = new Date(now);
      nextRun.setUTCHours(10, 0, 0, 0);
      if (nextRun <= now) nextRun.setUTCDate(nextRun.getUTCDate() + 1);
      const msUntilRun = nextRun.getTime() - now.getTime();
      console.log(`[Scheduler] Inactive scan in ${Math.round(msUntilRun / 60000)} minutes`);
      setTimeout(async () => {
        try {
          console.log('[Scheduler] Inactive scan executed');
        } catch (e) {
          console.error('[Scheduler] Inactive scan error:', e.message);
        }
        setInterval(async () => {
          try {
            console.log('[Scheduler] Inactive scan executed');
          } catch (e) {
            console.error('[Scheduler] Inactive scan error:', e.message);
          }
        }, 24 * 60 * 60 * 1000);
      }, msUntilRun);
    };
    scheduleInactiveScan();
  }

  if (process.env.NODE_ENV === 'production' && APP_URL) {
    const PING_INTERVAL_MS = 14 * 60 * 1000;
    const PING_ENDPOINTS = ['/ping', '/api/health'];
    let pingIndex = 0;
    let consecutiveFailures = 0;
    const keepAlivePing = async () => {
      const endpoint = PING_ENDPOINTS[pingIndex % PING_ENDPOINTS.length];
      pingIndex++;
      const url = `${APP_URL}${endpoint}`;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        consecutiveFailures = 0;
        logger.debug(`[KeepAlive] OK ${endpoint}`);
      } catch (e) {
        consecutiveFailures++;
        logger.warn(`[KeepAlive] FAIL ${endpoint} (${consecutiveFailures}): ${e.message}`);
      }
    };
    setTimeout(() => {
      keepAlivePing();
      setInterval(keepAlivePing, PING_INTERVAL_MS);
    }, 30 * 1000);
    logger.info('[KeepAlive] enabled (interval: 14m)');
  } else {
    logger.info('[KeepAlive] disabled');
  }

  const shutdown = (signal) => {
    logger.info(`${signal} received, shutting down gracefully...`);
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

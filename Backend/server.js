'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const admin = require('firebase-admin');

const PORT = Number(process.env.PORT || 3000);
const APP_ORIGIN = (process.env.APP_ORIGIN || '').replace(/\/$/, '');
const FRONTEND_DIR = path.resolve(__dirname, '../Frontend');
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const PIARFLOW_API_KEY = process.env.PIARFLOW_API_KEY || '';
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || '';
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT || '';
const ADMIN_IDS = new Set(String(process.env.ADMIN_IDS || '').split(',').map(v => v.trim()).filter(v => /^[0-9]+$/.test(v)));
const ANNOUNCEMENT_CHANNEL_ID = process.env.ANNOUNCEMENT_CHANNEL_ID || '';
const BOT_WEBHOOK_SECRET = process.env.BOT_WEBHOOK_SECRET || '';
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const WEBAPP_URL = String(process.env.WEBAPP_URL || '').replace(/\/$/, '');
const BOT_USERNAME = process.env.BOT_USERNAME || '';
const FLYERHUBS_KEY = process.env.FLYERHUBS_KEY || '';
const MONETAG_POSTBACK_SECRET = process.env.MONETAG_POSTBACK_SECRET || '';
const MAX_BODY = 24 * 1024;
const rate = new Map();
let firebaseReady = false;
let rtdb = null;
let firestore = null;

function initFirebase() {
  if (firebaseReady) return true;
  if (!FIREBASE_SERVICE_ACCOUNT || !FIREBASE_DATABASE_URL) return false;
  try {
    const raw = FIREBASE_SERVICE_ACCOUNT.trim().startsWith('{')
      ? FIREBASE_SERVICE_ACCOUNT
      : Buffer.from(FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: FIREBASE_DATABASE_URL
    });
    rtdb = admin.database();
    firestore = admin.firestore();
    firebaseReady = true;
    return true;
  } catch (error) {
    console.error('[firebase-init]', error.message);
    return false;
  }
}
function send(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()'
  });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch { reject(new Error('INVALID_JSON')); }
    });
    req.on('error', reject);
  });
}
function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN || typeof initData !== 'string' || !initData || initData.length > 8192) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  const userRaw = params.get('user');
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !Number.isFinite(authDate) || !userRaw) return null;
  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 30 || now - authDate > 300) return null;
  params.delete('hash');
  params.delete('signature');
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => key + '=' + value).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', secret).update(check).digest();
  const supplied = Buffer.from(hash, 'hex');
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  try {
    const user = JSON.parse(userRaw);
    if (!Number.isSafeInteger(user.id) || user.id <= 0) return null;
    return {
      id: String(user.id),
      name: String(user.first_name || 'User').slice(0, 80),
      username: String(user.username || '').slice(0, 64),
      photoUrl: typeof user.photo_url === 'string' ? user.photo_url.slice(0, 500) : '',
      languageCode: String(user.language_code || 'en').slice(0, 8)
    };
  } catch { return null; }
}
function allowedOrigin(req) {
  if (!APP_ORIGIN) return !req.headers.origin;
  // When configured, browser API requests must carry the exact app origin.
  return req.headers.origin === APP_ORIGIN;
}
function limited(key) {
  const now = Date.now();
  const recent = (rate.get(key) || []).filter(t => now - t < 60000);
  recent.push(now);
  rate.set(key, recent);
  if (rate.size > 5000) {
    for (const [k, v] of rate) if (!v.length || now - v[v.length - 1] > 120000) rate.delete(k);
  }
  return recent.length > 30;
}
function dayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.REWARD_TIMEZONE || 'Europe/Istanbul' }).format(new Date());
}
function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100000000) throw new Error('INVALID_AMOUNT');
  return Math.round(n * 10000) / 10000;
}
function randomId() { return crypto.randomBytes(16).toString('hex'); }
function isAdmin(uid) { return ADMIN_IDS.has(String(uid)); }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
async function telegramCall(method, payload) {
  if (!BOT_TOKEN) throw new Error('BOT_NOT_CONFIGURED');
  const response = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/' + method, {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify(payload), signal: AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.description || 'TELEGRAM_API_ERROR');
  return data.result;
}
async function sendTelegramMessage(chatId, text, extra = {}) {
  return telegramCall('sendMessage', {chat_id: chatId, text, ...extra});
}
function xpForNextLevel(level) {
  const n = Math.max(1, Math.min(99, Number(level) || 1));
  return Math.floor(50 + n * 10 + n * n * 0.5);
}
function applyXp(user, amount) {
  const gain = Math.max(0, Math.floor(Number(amount) || 0));
  user.xp = Math.max(0, Number(user.xp || 0)) + gain;
  user.level = Math.max(1, Math.min(100, Number(user.level || 1)));
  let required = xpForNextLevel(user.level);
  while (user.level < 100 && user.xp >= required) {
    user.xp -= required;
    user.level += 1;
    required = xpForNextLevel(user.level);
  }
  if (user.level >= 100) { user.level = 100; user.xp = Math.min(user.xp, required - 1); }
  user.xpToNext = user.level >= 100 ? 0 : required;
  user.xpUpdatedAt = Date.now();
  return { level: user.level, xp: user.xp, xpToNext: user.xpToNext, gained: gain };
}
function rewardMultiplier(user) { return Number(user.level || 1) >= 100 ? 2 : 1; }
async function flyerCall(route, payload) {
  if (!FLYERHUBS_KEY) throw new Error('FLYERHUBS_NOT_CONFIGURED');
  const response = await fetch('https://api.flyerhubs.com' + route, {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({key:FLYERHUBS_KEY,...payload}),
    signal:AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error('FLYERHUBS_UPSTREAM_ERROR');
  return data;
}
async function logTransaction(uid, type, amount, extra) {
  await firestore.collection('transactions').add({
    userId: uid, type, amount: Number(amount || 0),
    ...(extra || {}), timestamp: admin.firestore.FieldValue.serverTimestamp()
  });
}
async function getSettings() {
  const snap = await rtdb.ref('settings').once('value');
  return snap.val() || {};
}
async function bootstrap(user, referralCode) {
  let validReferralCode = '';
  if (referralCode && referralCode !== user.id && /^\d{1,20}$/.test(String(referralCode))) {
    const referrer = await rtdb.ref('users/' + String(referralCode)).once('value');
    if (referrer.exists() && !referrer.val()?.banned) validReferralCode = String(referralCode);
  }
  const userRef = rtdb.ref('users/' + user.id);
  let created = false;
  const result = await userRef.transaction(current => {
    if (current) { created = false; return current; }
    created = true;
    return {
      uid: user.id, name: user.name, username: user.username, photoUrl: user.photoUrl,
            balance: 0, totalEarned: 0, totalWithdrawn: 0, referralEarned: 0, referralCount: 0,
      xp: 0, level: 1, xpToNext: xpForNextLevel(1),
      referredBy: validReferralCode || null,
      todayAds: 0, lastAdDate: '', checkInStreak: 0, lastCheckIn: '',
      lastCardDate: '', spinCards: 0, completedTasks: {}, sponsorDone: {}, banned: false,
      createdAt: Date.now(), processedActions: {}
    };
  });
  if (!result.committed || !result.snapshot.exists()) throw new Error('USER_BOOTSTRAP_FAILED');
  if (created && validReferralCode) {
    const referralMarker = rtdb.ref('referralClaims/' + user.id);
    let claimedNow = false;
    const claim = await referralMarker.transaction(v => {
      if (v) { claimedNow = false; return v; }
      claimedNow = true;
      return { referrer: validReferralCode, at: Date.now() };
    });
    if (claim.committed && claimedNow && claim.snapshot.val() && claim.snapshot.val().referrer === validReferralCode) {
      const settings = await getSettings();
      const bonus = money(settings.referralBonus == null ? 0.1 : settings.referralBonus);
      if (bonus > 0) {
        const ref = rtdb.ref('users/' + validReferralCode);
        const refResult = await ref.transaction(u => {
          if (!u || u.banned) return;
          u.referralCount = Number(u.referralCount || 0) + 1;
          u.referralEarned = money(Number(u.referralEarned || 0) + bonus);
          u.balance = money(Number(u.balance || 0) + bonus);
          u.totalEarned = money(Number(u.totalEarned || 0) + bonus);
          const referralXp = applyXp(u, Number(settings.referralXp || 10));
          u.lastReferralXpAt = Date.now();
          return u;
        });
        if (refResult.committed) {
          await logTransaction(validReferralCode, 'referral', bonus, { referredUserId: user.id, xp: Number(settings.referralXp || 10) });
          await rtdb.ref('users/' + validReferralCode + '/notifications').push({title:'New referral',body:user.name + ' joined using your invitation. Your reward and ' + Number(settings.referralXp || 10) + ' XP were credited.',timestamp:Date.now(),type:'referral'});
          try { await sendTelegramMessage(validReferralCode, '🎉 Yeni referansın katıldı: ' + user.name + '. Bonusun ve ' + Number(settings.referralXp || 10) + ' XP hesabına eklendi.'); }
          catch (error) { console.warn('[referral-notification]', error.message); }
        }
      }
    }
  }
  return result.snapshot.val();
}
async function applyEconomyAction(uid, body) {
  const action = String(body.action || '');
  const actionId = String(body.actionId || randomId()).slice(0, 80);
  const userRef = rtdb.ref('users/' + uid);
  const settings = await getSettings();
  const taskId = String(body.taskId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
  const taskSnapshot = action === 'task' && taskId ? await rtdb.ref('tasks/' + taskId).once('value') : null;
  const taskRecord = taskSnapshot && taskSnapshot.exists() ? taskSnapshot.val() : null;
  const methodKey = String(body.method || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  const methodSnapshot = action === 'withdraw' && methodKey ? await rtdb.ref('withdrawMethods/' + methodKey).once('value') : null;
  const methodRecord = methodSnapshot && methodSnapshot.exists() ? methodSnapshot.val() : null;
  if (action === 'task' && !(await verifyTelegramTask(uid, taskRecord))) throw new Error('TASK_VERIFICATION_FAILED');
  let credited = 0;
  let logType = action;
  let extra = {};
  let failure = '';
  let alreadyProcessed = false;
  const tx = await userRef.transaction(user => {
    credited = 0; extra = {}; failure = ''; alreadyProcessed = false;
    if (!user || user.banned) { failure = 'ACCOUNT_UNAVAILABLE'; return; }
    user.processedActions = user.processedActions || {};
    if (user.processedActions[actionId]) { alreadyProcessed = true; return user; }
    const balance = Number(user.balance || 0);
    if (action === 'daily_card') {
      const today = dayKey();
      if (user.lastCardDate === today) { failure = 'ALREADY_CLAIMED'; return; }
      const count = Math.max(1, Math.min(10, parseInt(settings.dailyFreeCards || 1, 10)));
      user.spinCards = Number(user.spinCards || 0) + count;
      user.lastCardDate = today;
      extra = { cards: count };
    } else if (action === 'task') {
      const task = taskRecord;
      if (!taskId || !task || task.active === false) { failure = 'TASK_UNAVAILABLE'; return; }
      user.completedTasks = user.completedTasks || {};
      if (user.completedTasks[taskId]) { failure = 'ALREADY_COMPLETED'; return; }
      credited = money(Number(task.reward || 0) * rewardMultiplier(user));
      user.completedTasks[taskId] = Date.now();
      user.balance = money(balance + credited);
      user.totalEarned = money(Number(user.totalEarned || 0) + credited);
      const xpResult = applyXp(user, Number(settings.taskXp || 20));
      extra = { taskId, taskTitle: String(task.title || '').slice(0, 120), xp: xpResult, multiplier: rewardMultiplier(user) };
    } else if (action === 'checkin') {
      const today = dayKey();
      if (user.lastCheckIn === today) { failure = 'ALREADY_CLAIMED'; return; }
      const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: process.env.REWARD_TIMEZONE || 'Europe/Istanbul' });
      const streak = user.lastCheckIn === yesterday ? Math.min(7, Number(user.checkInStreak || 0) + 1) : 1;
      const rewards = Array.isArray(settings.checkinRewards) ? settings.checkinRewards : [0.01,0.02,0.03,0.05,0.08,0.12,0.2];
      credited = money(rewards[streak - 1] || 0.01);
      user.lastCheckIn = today;
      user.checkInStreak = streak;
      user.balance = money(balance + credited);
      user.totalEarned = money(Number(user.totalEarned || 0) + credited);
      const xpResult = applyXp(user, Number(settings.dailyCheckinXp || 10));
      extra = { day: streak, xp: xpResult };
    } else if (action === 'spin') {
      if (Number(user.spinCards || 0) < 1) { failure = 'NO_SPIN_CARDS'; return; }
      const rewards = Array.isArray(settings.spinRewards) ? settings.spinRewards : [0.01,0.05,0.02,0.1,0.01,0.5,0.03,1];
      if (!rewards.length) { failure = 'SPIN_NOT_CONFIGURED'; return; }
      const index = crypto.randomInt(0, rewards.length);
      credited = money(rewards[index]);
      user.spinCards = Number(user.spinCards || 0) - 1;
      user.balance = money(balance + credited);
      user.totalEarned = money(Number(user.totalEarned || 0) + credited);
      extra = { rewardIndex: index, cards: user.spinCards };
    } else if (action === 'buy_cards') {
      const count = Number(body.count);
      const priceKey = count === 1 ? 'spinCard1Price' : count === 5 ? 'spinCard5Price' : count === 10 ? 'spinCard10Price' : '';
      if (!priceKey) { failure = 'INVALID_CARD_PACK'; return; }
      const price = money(settings[priceKey] == null ? ({spinCard1Price:0.5,spinCard5Price:2,spinCard10Price:3.5})[priceKey] : settings[priceKey]);
      if (balance < price) { failure = 'INSUFFICIENT_BALANCE'; return; }
      user.balance = money(balance - price);
      user.spinCards = Number(user.spinCards || 0) + count;
      credited = -price;
      extra = { cards: count };
    } else if (action === 'withdraw') {
      const amount = money(body.amount);
      const account = String(body.account || '').trim().slice(0, 300);
      const method = methodRecord;
      if (!methodKey || !account || !method || method.active === false) { failure = 'INVALID_WITHDRAW_METHOD'; return; }
      if (amount < Number(method.minWithdraw || 5) || (Number(method.maxWithdraw || 0) > 0 && amount > Number(method.maxWithdraw)) || amount > balance) {
        failure = amount > balance ? 'INSUFFICIENT_BALANCE' : 'WITHDRAW_LIMIT';
        return;
      }
      user.balance = money(balance - amount);
      user.totalWithdrawn = money(Number(user.totalWithdrawn || 0) + amount);
      extra = { amount, method: methodKey, methodName: String(method.name || methodKey), account };
      credited = -amount;
    } else {
      failure = 'ACTION_NOT_ALLOWED';
      return;
    }
    user.processedActions[actionId] = Date.now();
    const keys = Object.keys(user.processedActions);
    if (keys.length > 100) for (const key of keys.slice(0, keys.length - 100)) delete user.processedActions[key];
    return user;
  });
  if (!tx.committed || failure) throw new Error(failure || 'ACTION_REJECTED');
  const updatedUser = tx.snapshot.val();
  if (alreadyProcessed) return { user: updatedUser, duplicate: true };
  if (action === 'withdraw') {
    try {
      await rtdb.ref('withdrawals').push({
        userId: uid, name: updatedUser.name || 'User', amount: extra.amount,
        method: extra.method, methodName: extra.methodName, account: extra.account,
        status: 'pending', requestedAt: Date.now()
      });
    } catch (error) {
      await userRef.transaction(user => {
        if (!user) return user;
        user.balance = money(Number(user.balance || 0) + extra.amount);
        user.totalWithdrawn = Math.max(0, Number(user.totalWithdrawn || 0) - extra.amount);
        if (user.processedActions) delete user.processedActions[actionId];
        return user;
      });
      throw new Error('WITHDRAW_SAVE_FAILED');
    }
  }
  if (action !== 'daily_card') {
    try { await logTransaction(uid, logType, credited, extra); }
    catch (error) { console.error('[transaction-log]', error.message); }
  }
  return { user: updatedUser, reward: action === 'spin' ? credited : undefined, extra };
}
async function completeFlyerTask(uid, signature, settings) {
  const taskKey = crypto.createHash('sha256').update(String(signature)).digest('hex');
  const taskRef = rtdb.ref('users/' + uid + '/flyerhubsTasks/' + taskKey);
  const taskSnap = await taskRef.once('value');
  if (!taskSnap.exists()) throw new Error('FLYERHUBS_TASK_NOT_FOUND');
  const task = taskSnap.val() || {};
  const checked = await flyerCall('/check_task', { signature: String(signature) });
  if (checked.result !== 'complete') return { completed: false, providerStatus: checked.result || 'unknown' };
  const userRef = rtdb.ref('users/' + uid);
  const reward = money(settings.flyerhubsTaskReward == null ? 0.01 : settings.flyerhubsTaskReward);
  let failure = '', already = false, credited = 0, xp = null;
  const tx = await userRef.transaction(user => {
    failure = ''; already = false; credited = 0; xp = null;
    if (!user || user.banned) { failure = 'ACCOUNT_UNAVAILABLE'; return; }
    user.completedTasks = user.completedTasks || {};
    const id = 'fh_' + taskKey;
    if (user.completedTasks[id]) { already = true; return user; }
    credited = money(reward * rewardMultiplier(user));
    user.balance = money(Number(user.balance || 0) + credited);
    user.totalEarned = money(Number(user.totalEarned || 0) + credited);
    user.completedTasks[id] = Date.now();
    xp = applyXp(user, Number(settings.flyerhubsTaskXp || settings.taskXp || 20));
    return user;
  });
  if (!tx.committed || failure) throw new Error(failure || 'FLYERHUBS_REWARD_FAILED');
  if (already) return { completed: true, duplicate: true, reward: 0, xp: null };
  await logTransaction(uid, 'flyerhubs_task', credited, { signatureHash: taskKey, taskName: String(task.name || task.task || 'FlyerHubs task').slice(0, 100), xp });
  await taskRef.remove();
  return { completed: true, duplicate: false, reward: credited, xp, multiplier: rewardMultiplier(tx.snapshot.val()) };
}
async function verifyTelegramTask(uid, task) {
  if (!BOT_TOKEN || !task || task.active === false) return false;
  const type = String(task.type || '').toLowerCase();
  if (!['telegram','channel','group'].includes(type)) return false;
  let chatId = task.chatId || task.chat_id || '';
  if (!chatId) {
    const link = String(task.url || task.link || '');
    const match = link.match(/^https:\/\/t\.me\/([A-Za-z0-9_]{5,})(?:[/?#]|$)/i);
    if (match) chatId = '@' + match[1];
  }
  if (!chatId) return false;
  const endpoint = 'https://api.telegram.org/bot' + BOT_TOKEN + '/getChatMember?chat_id=' +
    encodeURIComponent(String(chatId)) + '&user_id=' + encodeURIComponent(String(uid));
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !data.result) return false;
    const member = data.result;
    return ['creator','administrator','member'].includes(member.status) ||
      (member.status === 'restricted' && member.is_member === true);
  } catch { return false; }
}
async function callPiarflow(route, payload) {
  if (!PIARFLOW_API_KEY) throw new Error('SPONSOR_API_NOT_CONFIGURED');
  const response = await fetch('https://piarflow.com/v1' + route, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + PIARFLOW_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('SPONSOR_UPSTREAM_ERROR');
  return data;
}
async function handleAdminApi(user, url, body, res) {
  if (!isAdmin(user.id)) return send(res, 403, { status:'error', code:'ADMIN_REQUIRED' });
  if (url.pathname === '/api/admin/overview') {
    const [usersSnap, withdrawalsSnap, promosSnap] = await Promise.all([
      rtdb.ref('users').once('value'), rtdb.ref('withdrawals').orderByChild('status').equalTo('pending').limitToLast(100).once('value'),
      rtdb.ref('promotions').limitToLast(20).once('value')
    ]);
    let users = 0, totalBalance = 0, totalEarned = 0, level100 = 0;
    usersSnap.forEach(child => { const v=child.val()||{}; users++; totalBalance+=Number(v.balance||0); totalEarned+=Number(v.totalEarned||0); if(Number(v.level||1)>=100)level100++; });
    const withdrawals=[]; withdrawalsSnap.forEach(child=>withdrawals.push({id:child.key,...child.val()}));
    const promotions=[];promosSnap.forEach(child=>promotions.push({id:child.key,...child.val()}));
    promotions.reverse();
    return send(res,200,{status:'ok',stats:{users,totalBalance,totalEarned,level100,pendingWithdrawals:withdrawals.length},withdrawals,promotions,settings:await getSettings()});
  }
  if (url.pathname === '/api/admin/promo') {
    if (!ANNOUNCEMENT_CHANNEL_ID) return send(res, 503, {status:'error',code:'ANNOUNCEMENT_CHANNEL_NOT_CONFIGURED'});
    const title=String(body.title||'').trim().slice(0,80);
    const message=String(body.message||'').trim().slice(0,1800);
    const buttonText=String(body.buttonText||'').trim().slice(0,32);
    const buttonUrl=String(body.buttonUrl||'').trim();
    if(!title||!message) return send(res,400,{status:'error',code:'PROMO_FIELDS_REQUIRED'});
    if(buttonUrl&&!/^https:\/\//i.test(buttonUrl))return send(res,400,{status:'error',code:'INVALID_PROMO_URL'});
    const ref=rtdb.ref('promotions').push();
    const promo={title,message,buttonText,buttonUrl,status:'publishing',createdAt:Date.now(),createdBy:user.id};
    await ref.set(promo);
    const text='📢 <b>'+escapeHtml(title)+'</b>\n\n'+escapeHtml(message);
    const extra={parse_mode:'HTML',disable_web_page_preview:true};
    if(buttonUrl)extra.reply_markup={inline_keyboard:[[{text:buttonText||'Open',url:buttonUrl}]]};
    try{
      const sent=await sendTelegramMessage(ANNOUNCEMENT_CHANNEL_ID,text,extra);
      await ref.update({status:'published',channelMessageId:sent.message_id,publishedAt:Date.now()});
      await rtdb.ref('notifications').push({title:'Promotion: '+title,body:message,timestamp:Date.now(),showBanner:true,type:'promotion',promotionId:ref.key});
      return send(res,200,{status:'ok',promotion:{id:ref.key,...promo,status:'published',channelMessageId:sent.message_id}});
    }catch(error){
      await ref.update({status:'publish_failed',publishError:String(error.message||'Telegram send failed').slice(0,200)});
      return send(res,502,{status:'error',code:'CHANNEL_PUBLISH_FAILED',promotionId:ref.key});
    }
  }
  if (url.pathname === '/api/admin/settings') {
    const allowed=['flyerhubsTaskReward','flyerhubsTaskXp','taskXp','dailyCheckinXp','adWatchXp','referralXp','perAdEarning','dailyLimit'];
    const patch={};
    for(const key of allowed) if(body[key]!==undefined){const value=Number(body[key]);if(!Number.isFinite(value)||value<0||value>100000)return send(res,400,{status:'error',code:'INVALID_SETTING_'+key});patch[key]=value;}
    if(!Object.keys(patch).length)return send(res,400,{status:'error',code:'NO_SETTINGS'});
    await rtdb.ref('settings').update(patch);
    return send(res,200,{status:'ok',settings:patch});
  }
  if (url.pathname === '/api/admin/botmessages') {
    const target=String(body.userId||'').trim();
    const message=String(body.message||'').trim().slice(0,3000);
    if(!/^[0-9]{1,20}$/.test(target)||!message)return send(res,400,{status:'error',code:'INVALID_MESSAGE'});
    await sendTelegramMessage(target,message);
    return send(res,200,{status:'ok'});
  }
  return send(res,404,{status:'error',code:'NOT_FOUND'});
}
async function handleTelegramWebhook(req, res) {
  if(!BOT_WEBHOOK_SECRET)return send(res,503,{ok:false});
  const supplied=String(req.headers['x-telegram-bot-api-secret-token']||'');
  const expected=Buffer.from(BOT_WEBHOOK_SECRET), actual=Buffer.from(supplied);
  if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected))return send(res,403,{ok:false});
  let update;
  try{update=await readBody(req);}catch{return send(res,400,{ok:false});}
  const message=update.message;
  if(!message?.from?.id||typeof message.text!=='string')return send(res,200,{ok:true});
  const user=message.from;
  const uid=String(user.id);
  const text=message.text.trim();
  const command=text.split(/\s+/)[0].split('@')[0].toLowerCase();
  const name=[user.first_name,user.last_name].filter(Boolean).join(' ').slice(0,80)||'User';
  const profile={id:uid,name,username:String(user.username||''),photoUrl:'',languageCode:String(user.language_code||'en')};
  try{
    if(command==='/start'){
      if(!initFirebase())throw new Error('FIREBASE_NOT_CONFIGURED');
      const payload=text.split(/\s+/)[1]||'';
      const referral=payload.startsWith('ref_')?payload.slice(4).replace(/\D/g,'').slice(0,20):payload.replace(/\D/g,'').slice(0,20);
      await bootstrap(profile,referral);
      const url=WEBAPP_URL||PUBLIC_BASE_URL;
      const keyboard=url?{inline_keyboard:[[{text:'🚀 Open Coinix Faucet',web_app:{url:url+(referral?'?startapp=ref_'+referral:'')}}]]}:undefined;
      await sendTelegramMessage(uid,'Welcome to Coinix Faucet!\n\nEarn rewards, complete tasks and invite friends.' ,keyboard?{reply_markup:keyboard}:{});
    }else if(command==='/help'){
      await sendTelegramMessage(uid,'Coinix Faucet commands:\\n/start — Open the app\\n/help — Help\\n/level — Your level and XP\\n/referrals — Your referral link and stats\\n/botmessages — Admin bot message tools\\n/yeni — Latest referrals (admins only)\\n/admin — Admin dashboard (admins only)');
    }else if(command==='/level'){
      if(!initFirebase())throw new Error('FIREBASE_NOT_CONFIGURED');
      const snap=await rtdb.ref('users/'+uid).once('value');
      if(!snap.exists())await sendTelegramMessage(uid,'Open /start first to create your Coinix profile.');
      else{
        const v=snap.val()||{},level=Math.max(1,Math.min(100,Number(v.level||1))),xp=Number(v.xp||0),next=Number(v.xpToNext||0);
        await sendTelegramMessage(uid,'🏅 <b>Coinix Level</b>\\nLevel: <b>'+level+'/100</b>\\nXP: <b>'+(level>=100?'MAX':xp+' / '+next)+'</b>\\n'+(level>=100?'You unlocked 2× verified ad and task rewards.':'Complete verified ads, tasks and daily check-ins to earn XP.'),{parse_mode:'HTML'});
      }
    }else if(command==='/referrals'){
      if(!initFirebase())throw new Error('FIREBASE_NOT_CONFIGURED');
      const snap=await rtdb.ref('users/'+uid).once('value'),v=snap.val()||{},bot=BOT_USERNAME.replace(/^@/,'');
      const link=bot?'https://t.me/'+bot+'?start=ref_'+uid:'Open the Referrals tab in Coinix to copy your invite link.';
      await sendTelegramMessage(uid,'👥 <b>Your referrals</b>\\nInvited: <b>'+Number(v.referralCount||0)+'</b>\\nEarned: <b>'+Number(v.referralEarned||0).toFixed(4)+'</b>\\n\\n'+escapeHtml(link),{parse_mode:'HTML'});
    }else if(command==='/admin'){
      if(!isAdmin(uid))await sendTelegramMessage(uid,'You are not authorized to use the admin panel.');
      else{
        const url=(WEBAPP_URL||PUBLIC_BASE_URL)+'/admin';
        await sendTelegramMessage(uid,'🔐 Coinix Admin Panel',{reply_markup:{inline_keyboard:[[{text:'Open AAA Admin',web_app:{url}}]]}});
      }
    }else if(command==='/botmessages'){
      if(!isAdmin(uid))await sendTelegramMessage(uid,'This command is restricted to administrators.');
      else await sendTelegramMessage(uid,'📨 <b>Bot Messages</b>\n/start — Welcome + Mini App\n/yeni — Latest referral activity\n/admin — Admin dashboard\nPromotions created in the dashboard are automatically posted to the announcement channel.',{parse_mode:'HTML'});
    }else if(command==='/yeni'){
      if(!isAdmin(uid))await sendTelegramMessage(uid,'This command is restricted to administrators.');
      else{
        const snap=await rtdb.ref('referralClaims').once('value');
        const rows=[];snap.forEach(c=>rows.push({uid:c.key,...c.val()}));rows.sort((a,b)=>(b.at||0)-(a.at||0));
        const body=rows.slice(0,10).map(v=>'• '+escapeHtml(v.uid)+' → '+escapeHtml(v.referrer||'?')+' · '+new Date(v.at||0).toLocaleString('en-US')).join('\n')||'No referrals yet.';
        await sendTelegramMessage(uid,'🆕 <b>Latest referrals</b>\n'+body,{parse_mode:'HTML'});
      }
    }
  }catch(error){console.error('[telegram-webhook]',error.message);}
  return send(res,200,{ok:true});
}
async function configureTelegramWebhook() {
  if(!BOT_TOKEN||!BOT_WEBHOOK_SECRET||!PUBLIC_BASE_URL)return;
  try{
    await telegramCall('setWebhook',{url:PUBLIC_BASE_URL+'/telegram/webhook',secret_token:BOT_WEBHOOK_SECRET,allowed_updates:['message','callback_query'],drop_pending_updates:false});
    await telegramCall('setMyCommands',{commands:[
      {command:'start',description:'Open Coinix Faucet'},
      {command:'help',description:'Show help'},\n      {command:'level',description:'Your level and XP'},\n      {command:'referrals',description:'Your referral link and stats'},
      {command:'admin',description:'Open admin panel'},
      {command:'botmessages',description:'Admin bot message tools'},
      {command:'yeni',description:'Latest referrals (admin)'}
    ]});
    console.log('[telegram] webhook and commands configured');
  }catch(error){console.error('[telegram-config]',error.message);}
}
async function handleMonetagPostback(req, res, url) {
  if (!MONETAG_POSTBACK_SECRET) return send(res, 503, { error: 'MONETAG_NOT_CONFIGURED' });
  if (process.env.MONETAG_ZONE_ID && url.searchParams.get('zone_id') !== process.env.MONETAG_ZONE_ID) return send(res,403,{error:'INVALID_ZONE'});
  const secret = String(url.searchParams.get('secret') || '');
  const expected = Buffer.from(MONETAG_POSTBACK_SECRET);
  const supplied = Buffer.from(secret);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return send(res, 403, { error: 'FORBIDDEN' });
  if (url.searchParams.get('event_type') !== 'impression' || url.searchParams.get('reward_event_type') !== 'valued') return send(res, 200, { ok: true, ignored: true });
  const uid = String(url.searchParams.get('telegram_id') || '');
  const ymid = String(url.searchParams.get('ymid') || '');
  if (!/^\d{1,20}$/.test(uid) || !ymid || ymid.length > 160 || !ymid.startsWith(uid + '_')) return send(res, 400, { error: 'INVALID_EVENT' });
  const eventId = crypto.createHash('sha256').update(ymid).digest('hex');
  if (!initFirebase()) return send(res, 503, { error: 'FIREBASE_NOT_READY' });
  const userRef = rtdb.ref('users/' + uid);
  const snap = await userRef.once('value');
  if (!snap.exists() || snap.val()?.banned) return send(res, 404, { error: 'USER_NOT_FOUND' });
  const settings = await getSettings();
  const today = dayKey();
  let failure = '', duplicate = false, credited = 0, xp = null;
  const eventRef = rtdb.ref('monetagEvents/' + eventId);
  let eventBusy = false;
  const eventTx = await eventRef.transaction(v => {
    duplicate = false; eventBusy = false;
    if (v?.status === 'credited') { duplicate = true; return v; }
    if (v?.status === 'processing' && Date.now() - Number(v.createdAt || 0) < 60000) { eventBusy = true; return v; }
    return { uid, ymid, createdAt: Date.now(), status: 'processing' };
  });
  if (!eventTx.committed) return send(res, 503, { error: 'EVENT_LOCK_FAILED' });
  if (duplicate) return send(res, 200, { ok: true, duplicate: true });
  if (eventBusy) return send(res, 503, { error: 'EVENT_IN_PROGRESS' });
  duplicate = false;
  const tx = await userRef.transaction(user => {
    failure = ''; credited = 0; xp = null;
    if (!user || user.banned) { failure = 'USER_NOT_FOUND'; return; }
    user.processedAds = user.processedAds || {};
    if (user.processedAds[eventId]) { duplicate = true; return user; }
    const count = user.lastAdDate === today ? Number(user.todayAds || 0) : 0;
    const limit = Math.max(1, Number(settings.dailyLimit || 10));
    if (count >= limit) { failure = 'DAILY_LIMIT'; return; }
    const baseReward = money(settings.perAdEarning == null ? 0.005 : settings.perAdEarning);
    credited = money(baseReward * rewardMultiplier(user));
    user.balance = money(Number(user.balance || 0) + credited);
    user.totalEarned = money(Number(user.totalEarned || 0) + credited);
    user.lastAdDate = today;
    user.todayAds = count + 1;
    user.processedAds[eventId] = Date.now();
    const adKeys = Object.keys(user.processedAds);
    if (adKeys.length > 200) for (const key of adKeys.slice(0, adKeys.length - 200)) delete user.processedAds[key];
    xp = applyXp(user, Number(settings.adWatchXp || 10));
    return user;
  });
  if (!tx.committed || failure) {
    await eventRef.remove();
    return send(res, failure === 'DAILY_LIMIT' ? 200 : 503, { ok: failure === 'DAILY_LIMIT', ignored: failure === 'DAILY_LIMIT', error: failure || 'CREDIT_FAILED' });
  }
  if (duplicate) {
    await eventRef.update({status:'credited',creditedAt:Date.now(),recovered:true});
    return send(res,200,{ok:true,duplicate:true});
  }
  await eventRef.update({ status: 'credited', creditedAt: Date.now(), reward: credited });
  try { await logTransaction(uid, 'ad', credited, { ymid, xp, multiplier: rewardMultiplier(tx.snapshot.val()) }); }
  catch(error) { console.error('[monetag-log]',error.message); }
  return send(res, 200, { ok: true, reward: credited });
}
async function handleApi(req, res, url) {
  if (!allowedOrigin(req)) return send(res, 403, { status: 'error', message: 'Origin rejected' });
  if (req.method !== 'POST') return send(res, 405, { status: 'error', message: 'Method not allowed' });
  let body;
  try { body = await readBody(req); }
  catch (error) { return send(res, error.message === 'BODY_TOO_LARGE' ? 413 : 400, { status: 'error', message: 'Invalid request body' }); }
  const user = verifyTelegramInitData(body.initData);
  if (!user) return send(res, 401, { status: 'error', message: 'Telegram session invalid or expired' });
  if (limited(user.id)) return send(res, 429, { status: 'error', message: 'Rate limit exceeded' });
  if (!initFirebase()) return send(res, 503, { status: 'error', message: 'Firebase Admin is not configured' });
  try {
    if (url.pathname === '/api/session') {
      const referralCode = String(body.referralCode || '').replace(/\D/g, '').slice(0, 20);
      const profile = await bootstrap(user, referralCode);
      if (profile.banned) return send(res, 403, { status: 'error', message: 'Account unavailable' });
      const customToken = await admin.auth().createCustomToken(user.id);
      return send(res, 200, { status: 'ok', user: profile, customToken, isAdmin: isAdmin(user.id), botUsername: BOT_USERNAME, monetagZoneId: process.env.MONETAG_ZONE_ID || '' });
    }
    if (url.pathname === '/api/economy') {
      const result = await applyEconomyAction(user.id, body);
      return send(res, 200, { status: 'ok', ...result });
    }
    if (url.pathname.startsWith('/api/admin/')) {
      if (!isAdmin(user.id)) return send(res,403,{status:'error',code:'ADMIN_REQUIRED'});
      return await handleAdminApi(user,url,body,res);
    }
    if (url.pathname === '/api/flyerhubs/tasks') {
      const language = String(user.languageCode || 'en').slice(0, 8);
      const data = await flyerCall('/get_tasks', { user_id: Number(user.id), language_code: language, limit: 10 });
      const items = Array.isArray(data.result) ? data.result : [];
      const taskMap = {};
      const rewardValue = Number((await getSettings()).flyerhubsTaskReward ?? 0.01);
      const tasks = items.map(item => {
        const signature = String(item.signature || '');
        if (!signature) return null;
        const id = crypto.createHash('sha256').update(signature).digest('hex');
        taskMap[id] = { signature, name: String(item.name || item.task || 'FlyerHubs task').slice(0, 100), task: String(item.task || ''), links: Array.isArray(item.links) ? item.links.slice(0, 3) : [], price: item.price };
        return { id: 'fh_' + id, signature, source: 'flyerhubs', title: taskMap[id].name, type: 'telegram', url: taskMap[id].links[0] || '', reward: rewardValue, active: item.status !== 'complete' && item.status !== 'unavailable' };
      }).filter(Boolean);
      if (Object.keys(taskMap).length) await rtdb.ref('users/' + user.id + '/flyerhubsTasks').update(taskMap);
      return send(res, 200, { status: 'ok', tasks });
    }
    if (url.pathname === '/api/flyerhubs/check') {
      const signature = String(body.signature || '');
      if (!signature || signature.length > 300) return send(res, 400, { status: 'error', message: 'Invalid task signature' });
      const settings = await getSettings();
      const result = await completeFlyerTask(user.id, signature, settings);
      return send(res, 200, { status: 'ok', ...result });
    }
    if (url.pathname === '/api/leaderboard') {
      const snap = await rtdb.ref('users').orderByChild('totalEarned').limitToLast(50).once('value');
      const users = [];
      snap.forEach(child => {
        const value = child.val() || {};
        if (!value.banned) users.push({
          uid: String(value.uid || child.key),
          name: String(value.name || 'User').slice(0, 80),
          photoUrl: typeof value.photoUrl === 'string' ? value.photoUrl.slice(0, 500) : '',
          totalEarned: Number(value.totalEarned || 0)
        });
      });
      users.sort((a,b) => b.totalEarned - a.totalEarned);
      return send(res, 200, { status: 'ok', users });
    }
    if (url.pathname === '/api/referrals') {
      const snap = await rtdb.ref('users').orderByChild('referredBy').equalTo(user.id).limitToLast(20).once('value');
      const users = [];
      snap.forEach(child => {
        const value = child.val() || {};
        users.push({
          uid: String(value.uid || child.key),
          name: String(value.name || 'User').slice(0, 80),
          createdAt: Number(value.createdAt || 0)
        });
      });
      users.sort((a,b) => b.createdAt - a.createdAt);
      return send(res, 200, { status: 'ok', users });
    }
    if (url.pathname === '/api/sponsors') {
      const max = Math.min(10, Math.max(1, parseInt(body.max_sponsors, 10) || 10));
      const data = await callPiarflow('/sponsors', { user_id: Number(user.id), chat_id: Number(user.id), max_sponsors: max });
      return send(res, 200, data);
    }
    if (url.pathname === '/api/sponsors/check') {
      const links = Array.isArray(body.links) ? body.links.filter(v => typeof v === 'string' && /^https:\/\/\S+$/i.test(v) && v.length <= 300).slice(0, 10) : [];
      if (!links.length) return send(res, 400, { status: 'error', message: 'Valid links required' });
      const data = await callPiarflow('/sponsors/check', { user_id: Number(user.id), links });
      const matched = (data.sponsors || []).find(item => item.link === links[0]);
      if (matched && matched.status === 'subscribed') {
        let sponsorHash = 5381;
        for (let i = 0; i < links[0].length; i++) sponsorHash = ((sponsorHash << 5) + sponsorHash + links[0].charCodeAt(i)) >>> 0;
        const key = 'sp' + sponsorHash.toString(36);
        const sponsorSettings = await getSettings();
        const reward = money(sponsorSettings.sponsorReward == null ? 0.0025 : sponsorSettings.sponsorReward);
        const sponsorXpAmount = Number(sponsorSettings.sponsorTaskXp || sponsorSettings.taskXp || 20);
        let credited = false;
        const tx = await rtdb.ref('users/' + user.id).transaction(profile => {
          credited = false; data.reward = 0; data.xp = null; data.multiplier = 1;
          if (!profile || profile.banned) return;
          profile.sponsorDone = profile.sponsorDone || {};
          if (profile.sponsorDone[key]) return profile;
          profile.sponsorDone[key] = Date.now();
          const multiplier = rewardMultiplier(profile);
          const finalReward = money(reward * multiplier);
          profile.balance = money(Number(profile.balance || 0) + finalReward);
          profile.totalEarned = money(Number(profile.totalEarned || 0) + finalReward);
          const sponsorXp = applyXp(profile, sponsorXpAmount);
          data.xp = sponsorXp;
          data.multiplier = multiplier;
          data.reward = finalReward;
          credited = true;
          return profile;
        });
        if (tx.committed && credited) await logTransaction(user.id, 'sponsor', Number(data.reward || reward), { sponsorHash: key, xp: data.xp, multiplier: data.multiplier });
        data.rewarded = Boolean(tx.committed && credited);
        data.reward = data.rewarded ? Number(data.reward || reward) : 0;
      }
      return send(res, 200, data);
    }
    return send(res, 404, { status: 'error', message: 'Not found' });
  } catch (error) {
    const known = new Set(['ACCOUNT_UNAVAILABLE','ALREADY_CLAIMED','ALREADY_COMPLETED','NO_SPIN_CARDS','SPIN_NOT_CONFIGURED','INVALID_CARD_PACK','INSUFFICIENT_BALANCE','WITHDRAW_LIMIT','INVALID_WITHDRAW_METHOD','WITHDRAW_SAVE_FAILED','TASK_UNAVAILABLE','TASK_VERIFICATION_FAILED','FLYERHUBS_TASK_NOT_FOUND','FLYERHUBS_REWARD_FAILED','FLYERHUBS_UPSTREAM_ERROR','FLYERHUBS_NOT_CONFIGURED','ACTION_NOT_ALLOWED','INVALID_AMOUNT']);
    const status = known.has(error.message) ? 400 : error.message === 'SPONSOR_API_NOT_CONFIGURED' ? 503 : 502;
    return send(res, status, { status: 'error', code: error.message, message: known.has(error.message) ? error.message : 'Request could not be completed' });
  }
}
function serveFrontend(req, res, url) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return send(res, 400, { error: 'Bad path' }); }
  const requested = pathname === '/' ? '/index.html' : pathname === '/admin' ? '/admin.html' : pathname;
  const file = path.resolve(FRONTEND_DIR, '.' + requested);
  if (!file.startsWith(FRONTEND_DIR + path.sep)) return send(res, 403, { error: 'Forbidden' });
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) return send(res, 404, { error: 'Not found' });
    const types = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp' };
    res.writeHead(200, {
      'content-type': types[path.extname(file)] || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'cache-control': path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=300'
    });
    fs.createReadStream(file).pipe(res);
  });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/telegram/webhook') return handleTelegramWebhook(req,res);
  if (req.method === 'GET' && url.pathname === '/postback/monetag') return handleMonetagPostback(req, res, url).catch(error => { console.error('[monetag-postback]',error.message); return send(res,503,{error:'POSTBACK_RETRY'}); });
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, service: 'coinixfaucet', firebaseAdminConfigured: initFirebase(), telegramConfigured: Boolean(BOT_TOKEN), sponsorConfigured: Boolean(PIARFLOW_API_KEY), flyerhubsConfigured: Boolean(FLYERHUBS_KEY), monetagPostbackConfigured: Boolean(MONETAG_POSTBACK_SECRET), adminConfigured: ADMIN_IDS.size > 0 });
  }
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  if (req.method === 'GET' || req.method === 'HEAD') return serveFrontend(req, res, url);
  return send(res, 405, { error: 'Method not allowed' });
});
server.listen(PORT, '0.0.0.0', () => { console.log('CoinixFaucet listening on ' + PORT); configureTelegramWebhook(); });

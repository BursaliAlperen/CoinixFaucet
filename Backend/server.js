'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const admin = require('firebase-admin');
const { activeReferralBonusTotal, rewardMultiplier, isTelegramMember, isTaskOpen, cleanTaskInput } = require('./earn-core');

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
const REQUIRED_CHANNEL_ID = process.env.REQUIRED_CHANNEL_ID || '';
const REQUIRED_CHANNEL_URL = process.env.REQUIRED_CHANNEL_URL || '';
const TRAFFY_LINK_PREFIX = process.env.TRAFFY_LINK_PREFIX || '';
const API_AD_REWARD_USD = 0.002;
const FIREBASE_PUBLIC_CONFIG = {
  apiKey: process.env.FIREBASE_WEB_API_KEY || '',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
  databaseURL: FIREBASE_DATABASE_URL,
  projectId: process.env.FIREBASE_PROJECT_ID || '',
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
  appId: process.env.FIREBASE_APP_ID || '',
  measurementId: process.env.FIREBASE_MEASUREMENT_ID || ''
};
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
    const serviceProject = String(serviceAccount.project_id || '');
    if (!serviceProject) throw new Error('FIREBASE_SERVICE_ACCOUNT_PROJECT_MISSING');
    if (FIREBASE_PUBLIC_CONFIG.projectId && FIREBASE_PUBLIC_CONFIG.projectId !== serviceProject) throw new Error('FIREBASE_PROJECT_MISMATCH');
    const databaseHost = new URL(FIREBASE_DATABASE_URL).hostname.toLowerCase();
    if (!databaseHost.includes(serviceProject.toLowerCase())) throw new Error('FIREBASE_DATABASE_PROJECT_MISMATCH');
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
  if (!BOT_TOKEN || typeof initData !== 'string' || !initData || initData.length > 8192) {
    console.warn('[auth] Telegram initData missing or malformed');
    return null;
  }
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  const userRaw = params.get('user');
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !Number.isSafeInteger(authDate) || authDate <= 0 || !userRaw) {
    console.warn('[auth] Telegram initData required fields missing');
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  // Telegram can reopen a cached Mini App using its original signed initData.
  // Keep strict signature validation while allowing a 24-hour signed session.
  const configuredAge = Number(process.env.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS || 86400);
  const maxAge = Number.isFinite(configuredAge) ? Math.max(300, Math.min(86400, configuredAge)) : 86400;
  if (authDate > now + 30 || now - authDate > maxAge) {
    console.warn('[auth] Telegram initData expired; ageSeconds=' + (now - authDate));
    return null;
  }
  params.delete('hash');
  params.delete('signature');
  const check = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => key + '=' + value).join('\\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', secret).update(check).digest();
  const supplied = Buffer.from(hash, 'hex');
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    console.warn('[auth] Telegram initData signature mismatch');
    return null;
  }
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
  } catch {
    console.warn('[auth] Telegram initData user JSON invalid');
    return null;
  }
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
function dayKeyFor(timestamp) {
  if (!Number(timestamp) || !Number.isFinite(Number(timestamp))) return '';
  return new Intl.DateTimeFormat('en-CA',{timeZone:process.env.REWARD_TIMEZONE||'Europe/Istanbul'}).format(new Date(Number(timestamp)));
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
  const n = Math.max(1, Math.min(49, Number(level) || 1));
  return Math.floor(50 + n * 10 + n * n * 0.5);
}
function applyXp(user, amount) {
  const gain = Math.max(0, Math.floor(Number(amount) || 0));
  user.xp = Math.max(0, Number(user.xp || 0)) + gain;
  user.level = Math.max(1, Math.min(50, Number(user.level || 1)));
  let required = xpForNextLevel(user.level);
  while (user.level < 50 && user.xp >= required) {
    user.xp -= required;
    user.level += 1;
    required = xpForNextLevel(user.level);
  }
  if (user.level >= 50) { user.level = 50; user.xp = Math.min(user.xp, required - 1); }
  user.xpToNext = user.level >= 50 ? 0 : required;
  user.xpUpdatedAt = Date.now();
  return { level: user.level, xp: user.xp, xpToNext: user.xpToNext, gained: gain };
}
async function auditAdmin(actorId, action, targetId, details = {}) {
  return rtdb.ref('adminAudit').push({actorId:String(actorId),action:String(action).slice(0,80),targetId:String(targetId||'').slice(0,120),details,timestamp:Date.now()}).catch(()=>console.warn('[admin-audit] write_failed'));
}
async function notifyAdmins(message) {
  for (const adminId of ADMIN_IDS) { try { await sendTelegramMessage(adminId,message); } catch { console.warn('[admin-notify] delivery_failed'); } }
}
async function checkRequiredChannel(uid) {
  if (!REQUIRED_CHANNEL_ID || !REQUIRED_CHANNEL_URL) return {ok:false,reason:'CHANNEL_NOT_CONFIGURED'};
  try {
    const member=await telegramCall('getChatMember',{chat_id:REQUIRED_CHANNEL_ID,user_id:Number(uid)});
    const joined=isTelegramMember(member),status=String(member?.status||'');
    console.info('[channel-membership]',joined?'member':'not_member');
    if(firebaseReady){
      const recordRef=rtdb.ref('channelMembership/'+String(uid));
      let changed=false,previous='';
      await recordRef.transaction(current=>{
        previous=String(current?.status||'');changed=previous!==status;
        return {status,joined,checkedAt:Date.now()};
      });
      if(changed&&previous)await rtdb.ref('channelMembershipEvents').push({userId:String(uid),from:previous,to:status,joined,timestamp:Date.now()});
    }
    return {ok:joined,reason:joined?'MEMBER':'NOT_MEMBER',status};
  } catch(error) {
    const raw=String(error.message||'');
    const reason=/not enough rights|administrator/i.test(raw)?'BOT_NOT_ADMIN':/chat not found|channel_invalid/i.test(raw)?'CHANNEL_NOT_FOUND':'TELEGRAM_API_UNAVAILABLE';
    console.warn('[channel-membership]',reason);return {ok:false,reason};
  }
}
function membershipKeyboard() {
  const rows=[];if(REQUIRED_CHANNEL_URL)rows.push([{text:'📢 Kanala katıl',url:REQUIRED_CHANNEL_URL}]);
  rows.push([{text:'✅ Üyeliğimi kontrol et',callback_data:'check_required_channel'}]);return {inline_keyboard:rows};
}
async function sendMembershipGate(uid,reason='NOT_MEMBER') {
  const messages={NOT_MEMBER:'Görevleri ve kazanç özelliklerini açmak için önce duyuru kanalımıza katılmalısın.',CHANNEL_NOT_CONFIGURED:'Zorunlu kanal henüz yapılandırılmadı. Yöneticiler bilgilendirildi.',BOT_NOT_ADMIN:'Kanal üyeliği doğrulanamıyor. Botun kanalda yönetici olması gerekiyor.',CHANNEL_NOT_FOUND:'Zorunlu kanal bulunamadı. Yönetici ayarları kontrol etmeli.',TELEGRAM_API_UNAVAILABLE:'Telegram üyelik kontrolü şu anda yanıt vermiyor. Tekrar dene.'};
  await sendTelegramMessage(uid,messages[reason]||messages.NOT_MEMBER,{reply_markup:membershipKeyboard()});
}
async function savePendingReferral(uid,code) {
  code=String(code||'');if(!/^\\d{1,20}$/.test(code)||code===String(uid))return;
  await rtdb.ref('pendingReferrals/'+uid).transaction(v=>v||{referrer:code,createdAt:Date.now()});
}
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
async function ensurePayoutMethods() {
  const defaults={
    ton:{name:'TON',active:true,minWithdraw:0.05,maxWithdraw:0,accountLabel:'TON wallet address',accountPlaceholder:'EQ... or UQ...'},
    gram:{name:'GRAM',active:true,minWithdraw:0.05,maxWithdraw:0,accountLabel:'GRAM wallet address (TON network)',accountPlaceholder:'EQ... or UQ...'}
  };
  for(const [key,value] of Object.entries(defaults)){
    await rtdb.ref('withdrawMethods/'+key).transaction(current=>current||value);
  }
}
async function expireReferralBonuses(uid) {
  const now=Date.now();let expired=0;
  const tx=await rtdb.ref('users/'+String(uid)+'/referralBonuses').transaction(bonuses=>{
    if(!bonuses||typeof bonuses!=='object')return bonuses;
    for(const [key,bonus] of Object.entries(bonuses)){
      if(bonus&&bonus.status==='active'&&Number(bonus.endsAt||0)<=now){bonus.status='expired';bonus.expiredAt=now;expired++;}
    }
    return bonuses;
  });
  if(tx.committed&&expired)console.info('[referral-bonus] expired',expired);
}
async function bootstrap(user, referralCode) {
  await ensurePayoutMethods();
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
    const marker=rtdb.ref('referralClaims/'+user.id);let claimedNow=false;
    const claim=await marker.transaction(v=>{if(v)return v;claimedNow=true;return {referrer:validReferralCode,at:Date.now(),status:'claimed'};});
    if(claim.committed&&claimedNow&&claim.snapshot.val()?.referrer===validReferralCode){
      const settings=await getSettings();
      const multiplierBonus=Math.max(0,Math.min(0.25,Number(settings.referralMultiplierBonus??0.02)));
      const durationMs=Math.max(1,Math.min(168,Number(settings.referralBonusDurationHours??24)))*3600000;
      const startsAt=Date.now(),endsAt=startsAt+durationMs;let granted=false;
      const refResult=await rtdb.ref('users/'+validReferralCode).transaction(u=>{
        granted=false;if(!u||u.banned)return;
        u.referralBonuses=u.referralBonuses||{};if(u.referralBonuses[user.id])return u;
        u.referralCount=Number(u.referralCount||0)+1;
        u.referralBonuses[user.id]={source:'referral:'+user.id,referredUserId:user.id,multiplierBonus,startsAt,endsAt,status:'active'};
        applyXp(u,Number(settings.referralXp||10));granted=true;return u;
      });
      if(refResult.committed&&granted){
        await marker.update({status:'bonus_granted',startsAt,endsAt,multiplierBonus});
        await logTransaction(validReferralCode,'referral_bonus',0,{referredUserId:user.id,multiplierBonus,startsAt,endsAt});
        await rtdb.ref('users/'+validReferralCode+'/notifications').push({title:'Yeni davet bonusu',body:'Kazanç çarpanına +'+multiplierBonus.toFixed(2)+'x 24 saat boyunca eklendi.',timestamp:Date.now(),type:'referral'});
        try{await sendTelegramMessage(validReferralCode,'🎉 Yeni davetin katıldı! Kazanç çarpanına +'+multiplierBonus.toFixed(2)+'x 24 saat boyunca eklendi.');}catch{console.warn('[referral-notification] delivery_failed');}
      }
    }
  }
  return result.snapshot.val();
}
async function submitTaskClaim(uid, taskId, task, actionId, proof = '') {
  if (!isTaskOpen(task)) throw new Error('TASK_UNAVAILABLE');
  const method=String(task.verificationMethod||( ['channel','group','telegram'].includes(String(task.type))?'telegram_membership':'manual'));
  const automatic=method==='telegram_membership';
  if(automatic&&!(await verifyTelegramTask(uid,task)))throw new Error('TASK_VERIFICATION_FAILED');
  if(!automatic&&String(proof||'').trim().length<8)throw new Error('TASK_PROOF_REQUIRED');
  const taskRef=rtdb.ref('tasks/'+taskId);let reserved=false;
  const slot=await taskRef.transaction(current=>{
    if(!isTaskOpen(current))return;
    const next=Number(current.totalParticipants||0)+1;
    if(Number(current.totalLimit||0)>0&&next>Number(current.totalLimit))return;
    current.totalParticipants=next;reserved=true;return current;
  });
  if(!slot.committed||!reserved)throw new Error('TASK_LIMIT_REACHED');
  const claimsRef=rtdb.ref('taskClaims/'+taskId+'/'+uid);let duplicate=false,perUserLimit=false,created=false;
  const claimTx=await claimsRef.transaction(current=>{
    const claims=current||{};
    if(claims[actionId]){duplicate=true;return claims;}
    const used=Object.values(claims).filter(c=>c&&['pending','approved','verified','reviewing'].includes(c.status)).length;
    if(used>=Math.max(1,Math.min(10,Number(task.perUserLimit||1)))){perUserLimit=true;return;}
    claims[actionId]={taskId,userId:uid,actionId,title:String(task.title||'').slice(0,100),type:String(task.type||''),reward:Number(task.reward||0),
      proof:String(proof||'').slice(0,500),verificationMethod:method,perUserLimit:Math.max(1,Math.min(10,Number(task.perUserLimit||1))),status:automatic?'verified':'pending',createdAt:Date.now()};
    created=true;return claims;
  });
  if(!claimTx.committed||!created){
    if(!duplicate)await taskRef.child('totalParticipants').transaction(n=>Math.max(0,Number(n||0)-1));
    if(perUserLimit)throw new Error('TASK_USER_LIMIT');
    if(duplicate){const u=await rtdb.ref('users/'+uid).once('value');return {user:u.val(),pending:!automatic,duplicate:true};}
    throw new Error('TASK_CLAIM_FAILED');
  }
  if(!automatic){const u=await rtdb.ref('users/'+uid).once('value');return {user:u.val(),pending:true,taskClaim:{id:actionId,status:'pending'}};}
  const settings=await getSettings();let credited=0,failure='';
  const userTx=await rtdb.ref('users/'+uid).transaction(profile=>{
    credited=0;failure='';
    if(!profile||profile.banned){failure='ACCOUNT_UNAVAILABLE';return;}
    profile.completedTaskClaims=profile.completedTaskClaims||{};
    profile.taskClaimRewards=profile.taskClaimRewards||{};
    profile.taskCompletionCounts=profile.taskCompletionCounts||{};
    if(profile.completedTaskClaims[actionId]){failure='ALREADY_COMPLETED';credited=Number(profile.taskClaimRewards[actionId]||0);return;}
    const count=Number(profile.taskCompletionCounts[taskId]||0);
    if(count>=Math.max(1,Math.min(10,Number(task.perUserLimit||1)))){failure='TASK_USER_LIMIT';return;}
    const multiplier=rewardMultiplier(profile);credited=money(Number(task.reward||0)*multiplier);
    profile.balance=money(Number(profile.balance||0)+credited);profile.totalEarned=money(Number(profile.totalEarned||0)+credited);
    profile.taskCompletionCounts[taskId]=count+1;
    if(profile.taskCompletionCounts[taskId]>=Math.max(1,Math.min(10,Number(task.perUserLimit||1)))){profile.completedTasks=profile.completedTasks||{};profile.completedTasks[taskId]=Date.now();}
    profile.completedTaskClaims[actionId]=Date.now();profile.taskClaimRewards[actionId]=credited;applyXp(profile,Number(settings.taskXp||20));return profile;
  });
  if(!userTx.committed||failure){await claimsRef.child(actionId).update({status:'failed',failure,updatedAt:Date.now()});await taskRef.child('totalParticipants').transaction(n=>Math.max(0,Number(n||0)-1));if(failure==='ALREADY_COMPLETED'||failure==='TASK_USER_LIMIT')throw new Error(failure);throw new Error(failure||'TASK_REWARD_FAILED');}
  await claimsRef.child(actionId).update({status:'approved',reward:credited,approvedAt:Date.now(),autoVerified:true});
  await logTransaction(uid,'task',credited,{taskId,taskTitle:String(task.title||'').slice(0,100),taskType:String(task.type||''),claimId:actionId,provider:'coinix_task'});
  return {user:userTx.snapshot.val(),reward:credited,pending:false,taskClaim:{id:actionId,status:'approved'}};
}
async function applyEconomyAction(uid, body) {
  const action = String(body.action || '');
  const actionId = String(body.actionId || randomId()).replace(/[^a-zA-Z0-9_-]/g,'').slice(0, 80);
  const userRef = rtdb.ref('users/' + uid);
  const settings = await getSettings();
  const taskId = String(body.taskId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
  const taskSnapshot = action === 'task' && taskId ? await rtdb.ref('tasks/' + taskId).once('value') : null;
  const taskRecord = taskSnapshot && taskSnapshot.exists() ? taskSnapshot.val() : null;
  const methodKey = String(body.method || '').replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase().slice(0, 80);
  const methodSnapshot = action === 'withdraw' && ['ton','gram'].includes(methodKey) ? await rtdb.ref('withdrawMethods/' + methodKey).once('value') : null;
  const methodRecord = methodSnapshot && methodSnapshot.exists() ? methodSnapshot.val() : null;
  if (action === 'task') { if (!taskRecord) throw new Error('TASK_UNAVAILABLE'); return submitTaskClaim(uid,taskId,taskRecord,actionId,body.proof||''); }
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
      const multiplier = rewardMultiplier(user);
      credited = money(Number(task.reward || 0) * multiplier);
      user.completedTasks[taskId] = Date.now();
      user.balance = money(balance + credited);
      user.totalEarned = money(Number(user.totalEarned || 0) + credited);
      const xpResult = applyXp(user, Number(settings.taskXp || 20));
      extra = { taskId, taskTitle: String(task.title || '').slice(0, 120), xp: xpResult, multiplier };
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
      if (!['ton','gram'].includes(methodKey) || !account || (!/^(EQ|UQ)[A-Za-z0-9_-]{46}$/.test(account) && !/^0:[a-fA-F0-9]{64}$/.test(account)) || !method || method.active === false) { failure = 'INVALID_WITHDRAW_METHOD'; return; }
      if (amount < Number(method.minWithdraw || 0.05) || (Number(method.maxWithdraw || 0) > 0 && amount > Number(method.maxWithdraw)) || amount > balance) {
        failure = amount > balance ? 'INSUFFICIENT_BALANCE' : 'WITHDRAW_LIMIT';
        return;
      }
      user.balance = money(balance - amount);
      user.totalWithdrawn = money(Number(user.totalWithdrawn || 0) + amount);
      extra = { amount, currency: methodKey.toUpperCase(), method: methodKey, methodName: methodKey.toUpperCase(), account, payoutStatus: 'manual_review' };
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
  const reward = API_AD_REWARD_USD;
  let failure = '', already = false, credited = 0, xp = null, multiplier = 1;
  const tx = await userRef.transaction(user => {
    failure = ''; already = false; credited = 0; xp = null; multiplier = 1;
    if (!user || user.banned) { failure = 'ACCOUNT_UNAVAILABLE'; return; }
    user.completedTasks = user.completedTasks || {};
    const id = 'fh_' + taskKey;
    if (user.completedTasks[id]) { already = true; return user; }
    multiplier = 1;
    credited = reward;
    user.balance = money(Number(user.balance || 0) + credited);
    user.totalEarned = money(Number(user.totalEarned || 0) + credited);
    user.completedTasks[id] = Date.now();
    xp = applyXp(user, Number(settings.flyerhubsTaskXp || settings.taskXp || 20));
    return user;
  });
  if (!tx.committed || failure) throw new Error(failure || 'FLYERHUBS_REWARD_FAILED');
  if (already) return { completed: true, duplicate: true, reward: 0, xp: null };
  await logTransaction(uid, 'flyerhubs_task', credited, { signatureHash: taskKey, taskName: String(task.name || task.task || 'FlyerHubs task').slice(0, 100), xp, provider:'flyerhubs' });
  await taskRef.remove();
  return { completed: true, duplicate: false, reward: credited, xp, multiplier };
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
  if (url.pathname === '/api/admin/bot-control') {
    if(body.action==='status'){
      const snap=await rtdb.ref('botControl/enabled').once('value');
      return send(res,200,{status:'ok',enabled:!snap.exists()||snap.val()!==false});
    }
    const enabled=body.enabled===true;
    await rtdb.ref('botControl').update({enabled,updatedAt:Date.now(),updatedBy:user.id});
    await auditAdmin(user.id,enabled?'bot_start':'bot_stop','botControl',{enabled});
    return send(res,200,{status:'ok',enabled});
  }
  if (url.pathname === '/api/admin/providers') {
    return send(res,200,{status:'ok',providers:{
      piarflow:{configured:Boolean(PIARFLOW_API_KEY),status:PIARFLOW_API_KEY?'configured':'missing_key'},
      flyerhubs:{configured:Boolean(FLYERHUBS_KEY),status:FLYERHUBS_KEY?'configured':'missing_key'},
      traffy:{configured:Boolean(process.env.TRAFFY_API_KEY),status:'awaiting_official_api_contract',endpointEnabled:false,linkPrefixConfigured:Boolean(TRAFFY_LINK_PREFIX)}
    }});
  }
  if (url.pathname === '/api/admin/tasks') {
    const action=String(body.action||'list');
    if(action==='list'){
      const snap=await rtdb.ref('tasks').once('value'),items=[];
      snap.forEach(child=>items.push({id:child.key,...(child.val()||{})}));
      items.sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));
      return send(res,200,{status:'ok',tasks:items});
    }
    if(action==='create'||action==='update'){
      const id=String(body.id||'').trim().slice(0,120);let existing={};
      if(action==='update'){
        if(!id)return send(res,400,{status:'error',code:'TASK_ID_REQUIRED'});
        const old=await rtdb.ref('tasks/'+id).once('value');if(!old.exists())return send(res,404,{status:'error',code:'TASK_NOT_FOUND'});existing=old.val()||{};
      }
      let fields;try{fields=cleanTaskInput({...existing,...body});}catch(error){return send(res,400,{status:'error',code:error.message});}
      const status=String(body.status||existing.status||(action==='create'?'draft':'active'));
      if(!['draft','active','paused','completed'].includes(status))return send(res,400,{status:'error',code:'INVALID_TASK_STATUS'});
      const record={...existing,...fields,status,active:status==='active',totalParticipants:Number(existing.totalParticipants||0),
        createdAt:Number(existing.createdAt||Date.now()),updatedAt:Date.now(),createdBy:existing.createdBy||user.id,updatedBy:user.id};
      const ref=action==='create'?rtdb.ref('tasks').push():rtdb.ref('tasks/'+id);
      await ref.set(record);await auditAdmin(user.id,'task_'+action,ref.key,{status,type:record.type,reward:record.reward});
      return send(res,200,{status:'ok',task:{id:ref.key,...record}});
    }
    if(action==='status'){
      const id=String(body.id||'').trim(),status=String(body.status||'');
      if(!id||!['draft','active','paused','completed'].includes(status))return send(res,400,{status:'error',code:'INVALID_TASK_STATUS'});
      let changed=false;
      const tx=await rtdb.ref('tasks/'+id).transaction(t=>{if(!t)return;t.status=status;t.active=status==='active';t.updatedAt=Date.now();t.updatedBy=user.id;changed=true;return t;});
      if(!tx.committed||!changed)return send(res,404,{status:'error',code:'TASK_NOT_FOUND'});
      await auditAdmin(user.id,'task_status',id,{status});
      return send(res,200,{status:'ok',task:{id,...tx.snapshot.val()}});
    }
    return send(res,400,{status:'error',code:'INVALID_TASK_ACTION'});
  }
  if (url.pathname === '/api/admin/task-claims') {
    const snap=await rtdb.ref('taskClaims').once('value'),items=[];
    snap.forEach(taskNode=>taskNode.forEach(userNode=>userNode.forEach(claimNode=>{const c=claimNode.val()||{};if(c.status==='pending')items.push({id:claimNode.key,...c});})));
    items.sort((a,b)=>Number(a.createdAt||0)-Number(b.createdAt||0));
    return send(res,200,{status:'ok',claims:items.slice(0,200)});
  }
  if (url.pathname === '/api/admin/task-review') {
    const taskId=String(body.taskId||''),uid=String(body.userId||''),claimId=String(body.claimId||''),decision=String(body.decision||'');
    if(!taskId||!/^\\d{1,20}$/.test(uid)||!claimId||!['approve','reject'].includes(decision))return send(res,400,{status:'error',code:'INVALID_TASK_REVIEW'});
    const claimRef=rtdb.ref('taskClaims/'+taskId+'/'+uid+'/'+claimId);let locked=false;
    const lock=await claimRef.transaction(c=>{if(!c||c.status!=='pending')return;c.status='reviewing';c.reviewedBy=user.id;c.reviewStartedAt=Date.now();locked=true;return c;});
    if(!lock.committed||!locked)return send(res,409,{status:'error',code:'CLAIM_ALREADY_REVIEWED'});
    if(decision==='reject'){
      await claimRef.update({status:'rejected',rejectedAt:Date.now(),reviewedBy:user.id,reviewNote:String(body.note||'').slice(0,300)});
      await rtdb.ref('tasks/'+taskId+'/totalParticipants').transaction(n=>Math.max(0,Number(n||0)-1));
      await auditAdmin(user.id,'task_claim_reject',claimId,{taskId,uid});return send(res,200,{status:'ok',claim:{id:claimId,status:'rejected'}});
    }
    const settings=await getSettings();let credited=0,failure='',alreadyProcessed=false;
    const userTx=await rtdb.ref('users/'+uid).transaction(profile=>{
      credited=0;failure='';alreadyProcessed=false;if(!profile||profile.banned){failure='ACCOUNT_UNAVAILABLE';return;}
      profile.completedTaskClaims=profile.completedTaskClaims||{};profile.taskClaimRewards=profile.taskClaimRewards||{};profile.taskCompletionCounts=profile.taskCompletionCounts||{};
      if(profile.completedTaskClaims[claimId]){alreadyProcessed=true;credited=Number(profile.taskClaimRewards[claimId]||0);return profile;}
      const taskSnap=lock.snapshot.val()||{},limit=Math.max(1,Math.min(10,Number(taskSnap.perUserLimit||1)));
      const count=Number(profile.taskCompletionCounts[taskId]||0);if(count>=limit){failure='TASK_USER_LIMIT';return;}
      credited=money(Number(taskSnap.reward||0)*rewardMultiplier(profile));profile.balance=money(Number(profile.balance||0)+credited);
      profile.totalEarned=money(Number(profile.totalEarned||0)+credited);profile.taskCompletionCounts[taskId]=count+1;
      if(profile.taskCompletionCounts[taskId]>=limit){profile.completedTasks=profile.completedTasks||{};profile.completedTasks[taskId]=Date.now();}
      profile.completedTaskClaims[claimId]=Date.now();profile.taskClaimRewards[claimId]=credited;applyXp(profile,Number(settings.taskXp||20));return profile;
    });
    if(!userTx.committed||failure){await claimRef.update({status:'pending',reviewError:failure||'CREDIT_FAILED'});return send(res,503,{status:'error',code:failure||'TASK_REVIEW_CREDIT_FAILED'});}
    await claimRef.update({status:'approved',reward:credited,approvedAt:Date.now(),approvedBy:user.id,reviewNote:String(body.note||'').slice(0,300)});
    if(!alreadyProcessed)await logTransaction(uid,'task',credited,{taskId,claimId,taskType:String(lock.snapshot.val()?.type||''),provider:'manual_task'});
    await auditAdmin(user.id,'task_claim_approve',claimId,{taskId,uid,credited,recovered:alreadyProcessed});
    return send(res,200,{status:'ok',claim:{id:claimId,status:'approved',reward:credited,recovered:alreadyProcessed}});
  }
  if (url.pathname === '/api/admin/analytics') {
    const dayCount=Math.max(7,Math.min(30,Number(body.days||30)));
    const provider=String(body.provider||'all'),taskType=String(body.taskType||'all'),userFilter=String(body.userId||'').trim();
    const [usersSnap,txSnap]=await Promise.all([rtdb.ref('users').once('value'),firestore.collection('transactions').orderBy('timestamp','desc').limit(4000).get()]);
    const days=Array.from({length:dayCount},(_,i)=>{const d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()-(dayCount-1-i));return {key:dayKeyFor(d.getTime()),newUsers:0,activeUsers:0,referrals:0,taskCompletions:0,adRecords:0,rewardUsd:0,adCreditUsd:0};});
    const byDay=new Map(days.map(x=>[x.key,x]));
    if(!userFilter)usersSnap.forEach(child=>{const u=child.val()||{};const created=byDay.get(dayKeyFor(Number(u.createdAt||0)));if(created)created.newUsers++;const active=byDay.get(dayKeyFor(Number(u.lastActiveAt||0)));if(active)active.activeUsers++;});
    txSnap.forEach(doc=>{
      const v=doc.data()||{};if(userFilter&&String(v.userId||'')!==userFilter)return;
      if(provider!=='all'&&String(v.provider||'')!==provider)return;
      if(taskType!=='all'&&String(v.taskType||'')!==taskType)return;
      const stamp=v.timestamp?.toDate?v.timestamp.toDate().getTime():Number(v.timestamp||0),day=byDay.get(dayKeyFor(stamp));if(!day)return;
      if(v.type==='referral_bonus')day.referrals++;
      if(v.type==='task'||v.type==='flyerhubs_task')day.taskCompletions++;
      if(['ad','sponsor','flyerhubs_task','traffy'].includes(v.type)){day.adRecords++;day.adCreditUsd+=Number(v.amount||0);}
      if(Number(v.amount||0)>0)day.rewardUsd+=Number(v.amount||0);
    });
    const totals=days.reduce((a,d)=>{for(const k of ['newUsers','activeUsers','referrals','taskCompletions','adRecords','rewardUsd','adCreditUsd'])a[k]=(a[k]||0)+d[k];return a;},{});
    return send(res,200,{status:'ok',days,totals,filters:{days:dayCount,provider,taskType,userId:userFilter}});
  }
  if (url.pathname === '/api/admin/overview') {
    const [usersSnap, withdrawalsSnap, promosSnap] = await Promise.all([
      rtdb.ref('users').once('value'), rtdb.ref('withdrawals').orderByChild('status').equalTo('pending').limitToLast(100).once('value'),
      rtdb.ref('promotions').limitToLast(20).once('value')
    ]);
    let users = 0, totalBalance = 0, totalEarned = 0, level50 = 0;
    usersSnap.forEach(child => { const v=child.val()||{}; users++; totalBalance+=Number(v.balance||0); totalEarned+=Number(v.totalEarned||0); if(Number(v.level||1)>=50)level50++; });
    const withdrawals=[]; withdrawalsSnap.forEach(child=>{const w=child.val()||{};if(['ton','gram'].includes(String(w.method||'').toLowerCase()))withdrawals.push({id:child.key,...w});});
    const promotions=[];promosSnap.forEach(child=>promotions.push({id:child.key,...child.val()}));
    promotions.reverse();
    return send(res,200,{status:'ok',stats:{users,totalBalance,totalEarned,level50,pendingWithdrawals:withdrawals.length},withdrawals,promotions,settings:await getSettings()});
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
  if (url.pathname === '/api/admin/withdrawal') {
    const id=String(body.id||'').trim().slice(0,120);
    const action=String(body.action||'');
    if(!id||!['pay','reject'].includes(action))return send(res,400,{status:'error',code:'INVALID_WITHDRAWAL_ACTION'});
    const ref=rtdb.ref('withdrawals/'+id);
    const snap=await ref.once('value');
    if(!snap.exists())return send(res,404,{status:'error',code:'WITHDRAWAL_NOT_FOUND'});
    const withdrawal=snap.val()||{};
    if(withdrawal.status!=='pending')return send(res,409,{status:'error',code:'WITHDRAWAL_ALREADY_PROCESSED'});
    if(!['ton','gram'].includes(String(withdrawal.method||'').toLowerCase()))return send(res,400,{status:'error',code:'UNSUPPORTED_PAYOUT_CURRENCY'});
    if(action==='pay'){
      const txHash=String(body.txHash||'').trim().slice(0,160);
      const payoutAmount=Number(body.payoutAmount);
      if(txHash.length<20||!Number.isFinite(payoutAmount)||payoutAmount<=0)return send(res,400,{status:'error',code:'TX_HASH_AND_PAYOUT_AMOUNT_REQUIRED'});
      let changed=false;
      const lock=await ref.transaction(w=>{if(!w||w.status!=='pending')return;changed=true;w.status='paying';w.payoutTxStartedAt=Date.now();w.payoutBy=user.id;return w;});
      if(!lock.committed||!changed)return send(res,409,{status:'error',code:'WITHDRAWAL_ALREADY_PROCESSED'});
      await ref.update({status:'paid',txHash,payoutAmount,paidAt:Date.now(),paidBy:user.id});\n      await auditAdmin(user.id,'withdrawal_paid',id,{userId:withdrawal.userId,method:withdrawal.method,payoutAmount,txHash});
      try{await rtdb.ref('users/'+String(withdrawal.userId)+'/notifications').push({title:'Withdrawal paid',body:'Your '+String(withdrawal.method).toUpperCase()+' withdrawal has been paid.',timestamp:Date.now(),type:'withdrawal'});await sendTelegramMessage(String(withdrawal.userId),'✅ Your '+String(withdrawal.method).toUpperCase()+' withdrawal has been paid.\\nAmount: '+payoutAmount+'\\nTransaction: '+txHash);}catch(error){console.warn('[withdrawal-notification]',error.message);}
      return send(res,200,{status:'ok',withdrawal:{id,status:'paid',txHash,payoutAmount}});
    }
    const uid=String(withdrawal.userId||'');
    const amount=Number(withdrawal.amount||0);
    if(!/^\d{1,20}$/.test(uid)||!Number.isFinite(amount)||amount<=0)return send(res,400,{status:'error',code:'INVALID_WITHDRAWAL_RECORD'});
    let locked=false;
    const lock=await ref.transaction(w=>{if(!w||w.status!=='pending')return;locked=true;w.status='rejecting';w.rejectionStartedAt=Date.now();w.rejectedBy=user.id;return w;});
    if(!lock.committed||!locked)return send(res,409,{status:'error',code:'WITHDRAWAL_ALREADY_PROCESSED'});
    const userRef=rtdb.ref('users/'+uid);
    let refunded=false;
    const refund=await userRef.transaction(profile=>{
      if(!profile||profile.banned)return;
      profile.withdrawalRefunds=profile.withdrawalRefunds||{};
      if(profile.withdrawalRefunds[id])return profile;
      profile.balance=money(Number(profile.balance||0)+amount);
      profile.totalWithdrawn=Math.max(0,money(Number(profile.totalWithdrawn||0)-amount));
      profile.withdrawalRefunds[id]=Date.now();
      const keys=Object.keys(profile.withdrawalRefunds);
      if(keys.length>200)for(const key of keys.slice(0,keys.length-200))delete profile.withdrawalRefunds[key];
      refunded=true;
      return profile;
    });
    if(!refund.committed){await ref.update({status:'refund_failed',refundFailedAt:Date.now()});return send(res,503,{status:'error',code:'WITHDRAWAL_REFUND_FAILED'});}
    await ref.update({status:'rejected',rejectedAt:Date.now(),rejectedBy:user.id,rejectionReason:String(body.reason||'Rejected by admin').slice(0,200)});\n    await auditAdmin(user.id,'withdrawal_reject',id,{userId:uid,amount});
    if(refunded)try{await logTransaction(uid,'withdraw_refund',amount,{withdrawalId:id,currency:String(withdrawal.method).toUpperCase()});}catch(error){console.warn('[withdrawal-refund-log]',error.message);}
    try{await rtdb.ref('users/'+uid+'/notifications').push({title:'Withdrawal rejected',body:'Your withdrawal was rejected and the balance was returned.',timestamp:Date.now(),type:'withdrawal'});await sendTelegramMessage(uid,'Your withdrawal was rejected. The balance has been returned to your account.');}catch(error){console.warn('[withdrawal-notification]',error.message);}
    return send(res,200,{status:'ok',withdrawal:{id,status:'rejected',refunded:true}});
  }
  if (url.pathname === '/api/admin/settings') {
    const allowed=['flyerhubsTaskXp','taskXp','dailyCheckinXp','adWatchXp','referralXp','dailyLimit','referralMultiplierBonus','referralBonusDurationHours'];
    const patch={};
    for(const key of allowed) if(body[key]!==undefined){
      const value=Number(body[key]),max=key==='referralMultiplierBonus'?0.25:key==='referralBonusDurationHours'?168:100000,min=key==='referralBonusDurationHours'?1:0;
      if(!Number.isFinite(value)||value<min||value>max)return send(res,400,{status:'error',code:'INVALID_SETTING_'+key});
      patch[key]=value;
    }
    if(!Object.keys(patch).length)return send(res,400,{status:'error',code:'NO_SETTINGS'});
    await rtdb.ref('settings').update(patch);
    return send(res,200,{status:'ok',settings:patch});
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
  const callback=update.callback_query;
  if(callback?.from?.id){
    const uid=String(callback.from.id);
    if(callback.data==='check_required_channel'){
      const membership=await checkRequiredChannel(uid);
      try{await telegramCall('answerCallbackQuery',{callback_query_id:callback.id,text:membership.ok?'Üyelik doğrulandı.':'Henüz doğrulanamadı.',show_alert:!membership.ok});}catch{}
      if(membership.ok){
        const pending=await rtdb.ref('pendingReferrals/'+uid).once('value');
        const profile={id:uid,name:[callback.from.first_name,callback.from.last_name].filter(Boolean).join(' ')||'User',username:String(callback.from.username||''),photoUrl:'',languageCode:String(callback.from.language_code||'tr')};
        await bootstrap(profile,pending.val()?.referrer||'');await rtdb.ref('pendingReferrals/'+uid).remove();
        const appUrl=WEBAPP_URL||PUBLIC_BASE_URL;
        await sendTelegramMessage(uid,'Üyeliğin doğrulandı. Coinix’e hoş geldin!',{reply_markup:{inline_keyboard:[[{text:'Coinix’i aç',web_app:{url:appUrl}}]]}});
      }else{
        if(['CHANNEL_NOT_CONFIGURED','BOT_NOT_ADMIN','CHANNEL_NOT_FOUND'].includes(membership.reason))await notifyAdmins('Coinix kanal kontrolü başarısız: '+membership.reason+'. REQUIRED_CHANNEL_ID / REQUIRED_CHANNEL_URL ve bot yönetici yetkisini kontrol edin.');
        await sendMembershipGate(uid,membership.reason);
      }
    }
    return send(res,200,{ok:true});
  }
  const message=update.message;
  if(!message?.from?.id||typeof message.text!=='string')return send(res,200,{ok:true});
  const user=message.from;
  const uid=String(user.id);
  const text=message.text.trim();
  const command=text.split(/\s+/)[0].split('@')[0].toLowerCase();
  const name=[user.first_name,user.last_name].filter(Boolean).join(' ').slice(0,80)||'User';
  const profile={id:uid,name,username:String(user.username||''),photoUrl:'',languageCode:String(user.language_code||'en')};
  try{
    if(command==='/botstop'||command==='/botstart'){
      if(!isAdmin(uid)){await sendTelegramMessage(uid,'Bu komut yalnızca yöneticiler içindir.');return send(res,200,{ok:true});}
      const enabled=command==='/botstart';
      await rtdb.ref('botControl').update({enabled,updatedAt:Date.now(),updatedBy:uid});
      await auditAdmin(uid,enabled?'bot_start':'bot_stop','botControl',{enabled});
      await sendTelegramMessage(uid,enabled?'Bot yeniden etkinleştirildi.':'Bot kullanıcı işlemlerine kapatıldı.');
    }else if(command==='/start'){
      if(!initFirebase())throw new Error('FIREBASE_NOT_CONFIGURED');
      const control=await rtdb.ref('botControl/enabled').once('value');
      if(control.exists()&&control.val()===false){await sendTelegramMessage(uid,'Bot şu anda bakımda. Lütfen daha sonra tekrar dene.');return send(res,200,{ok:true});}
      const payload=text.split(/\s+/)[1]||'';
      const referral=payload.startsWith('ref_')?payload.slice(4).replace(/\D/g,'').slice(0,20):payload.replace(/\D/g,'').slice(0,20);
      await savePendingReferral(uid,referral);
      const membership=await checkRequiredChannel(uid);
      if(!membership.ok){
        await sendMembershipGate(uid,membership.reason);
        if(['CHANNEL_NOT_CONFIGURED','BOT_NOT_ADMIN','CHANNEL_NOT_FOUND'].includes(membership.reason))await notifyAdmins('Coinix zorunlu kanal kontrolü başarısız: '+membership.reason+'. Kanal ayarını ve bot yönetici yetkisini kontrol edin.');
        return send(res,200,{ok:true});
      }
      await bootstrap(profile,referral);await rtdb.ref('pendingReferrals/'+uid).remove();
      const url=WEBAPP_URL||PUBLIC_BASE_URL;
      const keyboard=url?{inline_keyboard:[[{text:'🚀 Open Coinix Faucet',web_app:{url:url+(referral?'?startapp=ref_'+referral:'')}}]]}:undefined;
      await sendTelegramMessage(uid,'Welcome to Coinix Faucet!\n\nEarn rewards, complete tasks and invite friends.' ,keyboard?{reply_markup:keyboard}:{});
    }else if(command==='/help'){
      await sendTelegramMessage(uid,'Coinix Faucet commands:\\n/start — Open the app\\n/help — Help\\n/level — Your level, XP and reward multiplier\\n/referrals — Your referral link and stats\\n/admin — Admin dashboard (admins only)');
    }else if(command==='/level'||command==='/referrals'){
      if(!initFirebase())throw new Error('FIREBASE_NOT_CONFIGURED');
      const membership=await checkRequiredChannel(uid);
      if(!membership.ok){await sendMembershipGate(uid,membership.reason);return send(res,200,{ok:true});}
      if(command==='/level'){
      const snap=await rtdb.ref('users/'+uid).once('value');
      if(!snap.exists())await sendTelegramMessage(uid,'Open /start first to create your Coinix profile.');
      else{
        const v=snap.val()||{},level=Math.max(1,Math.min(50,Number(v.level||1))),xp=Number(v.xp||0),next=Number(v.xpToNext||0);
        await sendTelegramMessage(uid,'🏅 <b>Coinix Level</b>\\nLevel: <b>'+level+'/50</b>\\nXP: <b>'+(level>=50?'MAX':xp+' / '+next)+'</b>\\nReward multiplier: <b>'+rewardMultiplier(v).toFixed(2)+'×</b>',{parse_mode:'HTML'});
      }
      }else if(command==='/referrals'){
      const snap=await rtdb.ref('users/'+uid).once('value'),v=snap.val()||{},bot=BOT_USERNAME.replace(/^@/,'');
      const link=bot?'https://t.me/'+bot+'?start=ref_'+uid:'Open the Referrals tab in Coinix to copy your invite link.';
      await sendTelegramMessage(uid,'👥 <b>Your referrals</b>\\nInvited: <b>'+Number(v.referralCount||0)+'</b>\\nEarned: <b>'+Number(v.referralEarned||0).toFixed(4)+'</b>\\n\\n'+escapeHtml(link),{parse_mode:'HTML'});
    }else if(command==='/admin'){
      if(!isAdmin(uid))await sendTelegramMessage(uid,'You are not authorized to use the admin panel.');
      else{
        const url=(WEBAPP_URL||PUBLIC_BASE_URL)+'/admin';
        await sendTelegramMessage(uid,'🔐 Coinix Admin Panel',{reply_markup:{inline_keyboard:[[{text:'Open AAA Admin',web_app:{url}}]]}});
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
      {command:'start',description:'Coinix’i aç'},\n      {command:'botstart',description:'Botu etkinleştir (yönetici)'},\n      {command:'botstop',description:'Botu duraklat (yönetici)'},
      {command:'help',description:'Show help'},
      {command:'level',description:'Your level and XP'},
      {command:'referrals',description:'Your referral link and stats'},
      {command:'admin',description:'Open admin panel'}
    ]});
    console.log('[telegram] webhook and commands configured');
  }catch(error){console.error('[telegram-config]',error.message);}
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
  if (url.pathname === '/api/channel/check') {
    const membership=await checkRequiredChannel(user.id);
    if(!membership.ok)return send(res,403,{status:'error',code:membership.reason,channelUrl:REQUIRED_CHANNEL_URL});
    return send(res,200,{status:'ok',membership:true});
  }
  if (!initFirebase()) return send(res, 503, { status: 'error', message: 'Firebase Admin is not configured' });
  if (!isAdmin(user.id)) {
    const control=await rtdb.ref('botControl/enabled').once('value');
    if(control.exists()&&control.val()===false)return send(res,503,{status:'error',code:'BOT_PAUSED',message:'Bot geçici olarak duraklatıldı.'});
    if(url.pathname!=='/api/channel/check'&&url.pathname!=='/api/session'){
      const membership=await checkRequiredChannel(user.id);
      if(!membership.ok)return send(res,403,{status:'error',code:membership.reason,channelUrl:REQUIRED_CHANNEL_URL});
    }
  }
  try {
    if (url.pathname === '/api/channel/check') {
      const membership=await checkRequiredChannel(user.id);
      if(!membership.ok)return send(res,403,{status:'error',code:membership.reason,channelUrl:REQUIRED_CHANNEL_URL});
      return send(res,200,{status:'ok',membership:true});
    }
    if (url.pathname === '/api/session') {
      const membership=await checkRequiredChannel(user.id);
      if(!membership.ok)return send(res,403,{status:'error',code:membership.reason,channelUrl:REQUIRED_CHANNEL_URL});
      const referralCode = String(body.referralCode || '').replace(/\D/g, '').slice(0, 20);
      await bootstrap(user, referralCode);
      await expireReferralBonuses(user.id);
      await rtdb.ref('users/'+user.id+'/lastActiveAt').set(Date.now());
      const profileSnap=await rtdb.ref('users/'+user.id).once('value'),profile=profileSnap.val()||{};
      if (profile.banned) return send(res, 403, { status: 'error', message: 'Account unavailable' });
      const customToken = await admin.auth().createCustomToken(user.id);
      return send(res, 200, { status: 'ok', user: profile, customToken, isAdmin: isAdmin(user.id), botUsername: BOT_USERNAME, referralBonusMultiplier: Number((await getSettings()).referralMultiplierBonus ?? 0.02), referralBonusDurationHours: Number((await getSettings()).referralBonusDurationHours ?? 24), traffyLink: TRAFFY_LINK_PREFIX ? 'https://t.me/Traffy_robot?startapp=l_'+TRAFFY_LINK_PREFIX+'_'+user.id : '' });
    }
    if (url.pathname === '/api/tasks/claims') {
      const snap=await rtdb.ref('taskClaims').once('value'),claims=[];
      snap.forEach(taskNode=>{const own=taskNode.child(user.id);own.forEach(claimNode=>{const v=claimNode.val()||{};if(['pending','approved','rejected'].includes(v.status))claims.push({taskId:taskNode.key,id:claimNode.key,...v});});});
      return send(res,200,{status:'ok',claims:claims.slice(-100)});
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
      const rewardValue = API_AD_REWARD_USD;
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
        const reward = API_AD_REWARD_USD;
        const sponsorXpAmount = Number(sponsorSettings.sponsorTaskXp || sponsorSettings.taskXp || 20);
        let credited = false;
        const tx = await rtdb.ref('users/' + user.id).transaction(profile => {
          credited = false; data.reward = 0; data.xp = null; data.multiplier = 1;
          if (!profile || profile.banned) return;
          profile.sponsorDone = profile.sponsorDone || {};
          if (profile.sponsorDone[key]) return profile;
          profile.sponsorDone[key] = Date.now();
          const multiplier = 1;
          const finalReward = reward;
          profile.balance = money(Number(profile.balance || 0) + finalReward);
          profile.totalEarned = money(Number(profile.totalEarned || 0) + finalReward);
          const sponsorXp = applyXp(profile, sponsorXpAmount);
          data.xp = sponsorXp;
          data.multiplier = multiplier;
          data.reward = finalReward;
          credited = true;
          return profile;
        });
        if (tx.committed && credited) await logTransaction(user.id, 'sponsor', Number(data.reward || reward), { sponsorHash: key, xp: data.xp, multiplier: data.multiplier, provider:'piarflow' });
        data.rewarded = Boolean(tx.committed && credited);
        data.reward = data.rewarded ? Number(data.reward || reward) : 0;
      }
      return send(res, 200, data);
    }
    return send(res, 404, { status: 'error', message: 'Not found' });
  } catch (error) {
    const known = new Set(['ACCOUNT_UNAVAILABLE','ALREADY_CLAIMED','ALREADY_COMPLETED','NO_SPIN_CARDS','SPIN_NOT_CONFIGURED','INVALID_CARD_PACK','INSUFFICIENT_BALANCE','WITHDRAW_LIMIT','INVALID_WITHDRAW_METHOD','WITHDRAW_SAVE_FAILED','TASK_UNAVAILABLE','TASK_VERIFICATION_FAILED','TASK_LIMIT_REACHED','TASK_USER_LIMIT','TASK_PROOF_REQUIRED','TASK_CLAIM_FAILED','TASK_REWARD_FAILED','FLYERHUBS_TASK_NOT_FOUND','FLYERHUBS_REWARD_FAILED','FLYERHUBS_UPSTREAM_ERROR','FLYERHUBS_NOT_CONFIGURED','ACTION_NOT_ALLOWED','INVALID_AMOUNT']);
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
  if (req.method === 'GET' && url.pathname === '/public-config/firebase') {
    const required=['apiKey','authDomain','databaseURL','projectId','appId'];
    const missing=required.filter(key=>!FIREBASE_PUBLIC_CONFIG[key]);
    if(missing.length)return send(res,503,{status:'error',code:'FIREBASE_WEB_CONFIG_MISSING',missing});
    if(!initFirebase())return send(res,503,{status:'error',code:'FIREBASE_ADMIN_NOT_READY'});
    return send(res,200,FIREBASE_PUBLIC_CONFIG);
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, service: 'coinixfaucet', firebaseAdminConfigured: initFirebase(), firebaseServiceAccountConfigured: Boolean(FIREBASE_SERVICE_ACCOUNT), firebaseDatabaseUrlConfigured: Boolean(FIREBASE_DATABASE_URL), firebaseWebConfigConfigured: Boolean(FIREBASE_PUBLIC_CONFIG.apiKey && FIREBASE_PUBLIC_CONFIG.authDomain && FIREBASE_PUBLIC_CONFIG.projectId && FIREBASE_PUBLIC_CONFIG.appId), telegramConfigured: Boolean(BOT_TOKEN), requiredChannelConfigured: Boolean(REQUIRED_CHANNEL_ID && REQUIRED_CHANNEL_URL), sponsorConfigured: Boolean(PIARFLOW_API_KEY), flyerhubsConfigured: Boolean(FLYERHUBS_KEY), traffyConfigured: Boolean(process.env.TRAFFY_API_KEY), traffyApiEnabled: false, adminConfigured: ADMIN_IDS.size > 0 });
  }
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  if (req.method === 'GET' || req.method === 'HEAD') return serveFrontend(req, res, url);
  return send(res, 405, { error: 'Method not allowed' });
});
server.listen(PORT, '0.0.0.0', () => { console.log('CoinixFaucet listening on ' + PORT); configureTelegramWebhook(); });

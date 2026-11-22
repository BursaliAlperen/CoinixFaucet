
/* ============ FIREBASE CONFIG ============ */
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyAB9vbJ1w4eZAg92IFMVJ-rYoj_GAawS7A",
  authDomain: "earnbd-6e3f7.firebaseapp.com",
  databaseURL: "https://earnbd-6e3f7-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "earnbd-6e3f7",
  storageBucket: "earnbd-6e3f7.firebasestorage.app",
  messagingSenderId: "130086600683",
  appId: "1:130086600683:web:e5e5d038f98f8e4335a3ae",
  measurementId: "G-371LS9CM8N"
};
let db,fs;

/* ============ STATE ============ */
let TGUser = null, currentUser = null, appSettings = {}, withdrawMethods = [], selectedMethod = null;
let tasks = [], notifications = [], unreadCount = 0, currentTaskFilter='all', currentTxFilter='all';
let transactionsCache = [];
let _dailyCardDone = false; // guard: run distributeDailyCard only once per session

/* ============ UTILS ============ */
const $=id=>document.getElementById(id);
function hap(t){try{window.Telegram.WebApp.HapticFeedback.impactOccurred(t||'light')}catch(e){}}
function setAmt(f){const b=parseFloat(currentUser?.balance||0);$('withdrawAmount').value=(Math.floor(b*f*100)/100).toFixed(2);hap();}
function renderExtras(){
  $('perAdEarn2').textContent=parseFloat(appSettings.perAdEarning||0.005).toFixed(4);$('spRw2').textContent=parseFloat(appSettings.sponsorReward||0.0025).toFixed(4);
  const e=parseFloat(currentUser.totalEarned||0),v=appSettings;
  const st=[['Bronze',0],['Silver',v.vipSilver||10],['Gold',v.vipGold||50],['Platinum',v.vipPlatinum||200]];
  let i=st.findIndex((x,k)=>k===st.length-1||e<st[k+1][1]);const c=st[i],n=st[i+1];
  if(n){$('lvlFill').style.width=Math.max(0,Math.min(100,(e-c[1])/(n[1]-c[1])*100))+'%';$('lvlNext').textContent=c[0]+' → '+n[0];$('lvlHint').textContent=n[0]+' için $'+(n[1]-e).toFixed(2)+' kazanç kaldı';}
  else{$('lvlFill').style.width='100%';$('lvlNext').textContent='Platinum';$('lvlHint').textContent='En yüksek seviyedesiniz!';}
  const d=new Date();d.setHours(0,0,0,0);
  $('todayEarn').textContent=transactionsCache.filter(x=>x.type!=='withdraw'&&x.type!=='purchase'&&(x.timestamp?.toMillis?.()||0)>=d.getTime()).reduce((a,x)=>a+parseFloat(x.amount||0),0).toFixed(2);
}
function getBDDate(){
  const d=new Date(Date.now()+6*3600*1000);
  return d.toISOString().split('T')[0];
}
function showToast(msg,type='info'){
  const t=document.createElement('div');
  t.className='toast '+(type||'info');
  const icMap={success:'check-circle',warn:'warning',danger:'x-circle',info:'info'};
  const ic=icMap[type]||'info';
  const icon=document.createElement('i');
  icon.className='ph-duotone ph-'+ic;
  const label=document.createElement('span');
  label.textContent=String(msg??'');
  t.append(icon,label);
  $('toastWrap').appendChild(t);try{window.Telegram.WebApp.HapticFeedback.notificationOccurred(type==='success'?'success':type==='danger'?'error':'warning')}catch(e){}
  setTimeout(()=>{t.style.opacity='0';t.style.transform='translateY(-20px)';t.style.transition='all .3s';setTimeout(()=>t.remove(),300);},3000);
}
function fireConfetti(){
  const colors=['#2AABEE','#FFD700','#00C851','#FF3B30','#8B5CF6','#F59E0B'];
  for(let i=0;i<45;i++){
    const c=document.createElement('div');c.className='confetti';
    c.style.left=Math.random()*100+'%';
    c.style.background=colors[i%colors.length];
    c.style.animationDelay=(Math.random()*0.6)+'s';
    c.style.width=(6+Math.random()*6)+'px';
    c.style.height=(10+Math.random()*8)+'px';
    document.body.appendChild(c);
    setTimeout(()=>c.remove(),2700);
  }
}
const _countUpTargets=new Map();
function countUp(el,to,dur=900){
  // Cancel any in-progress animation for this element
  _countUpTargets.set(el,to);
  const from=parseFloat(el.dataset.balance||el.textContent)||0;
  el.dataset.balance=to; // store final target
  const start=performance.now();
  function step(t){
    // If target changed mid-animation, stop this one
    if(_countUpTargets.get(el)!==to)return;
    const p=Math.min(1,(t-start)/dur);
    const eased=1-Math.pow(1-p,3);
    el.textContent=(from+(to-from)*eased).toFixed(4);
    if(p<1)requestAnimationFrame(step);
    else{el.textContent=to.toFixed(4);el.dataset.balance=to;}
  }
  requestAnimationFrame(step);
}
async function apiRequest(path,payload={}) {
  const initData=window.Telegram?.WebApp?.initData||'';
  if(!initData)throw new Error('Telegram oturumu doğrulanamadı');
  const actionId=window.crypto?.randomUUID?.()||('a'+Date.now()+Math.random().toString(16).slice(2));
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,initData,actionId})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data.status==='error')throw new Error(data.code||data.message||('HTTP '+response.status));
  return data;
}
function escapeHtml(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

/* ============ INIT ============ */
async function init(){
  try{
    const tg=window.Telegram?.WebApp;
    if(tg){tg.ready();tg.expand();try{tg.setHeaderColor('#ffffff');tg.setBackgroundColor('#F0F4F8');}catch(e){}TGUser=tg.initDataUnsafe?.user;}
    if(!TGUser)throw new Error('Bu uygulama Telegram Mini App üzerinden açılmalıdır.');
    const params=new URLSearchParams(window.location.search);
    let refBy=params.get('ref');
    if(!refBy && window.Telegram?.WebApp?.initDataUnsafe?.start_param){refBy=window.Telegram.WebApp.initDataUnsafe.start_param;}
    const session=await apiRequest('/api/session',{referralCode:refBy||''});
    await firebase.auth().signInWithCustomToken(session.customToken);
    const uid=String(TGUser.id);
    const sSnap=await withTO(db.ref('settings').once('value'),8000,{val:()=>({})});
    appSettings=sSnap.val()||{};
    if(appSettings.maintenance){$('maint').style.display='flex';$('loader').style.display='none';return;}
    const uSnap=await withTO(db.ref('users/'+uid).once('value'),12000,null);if(!uSnap)throw new Error('Veritabanı yanıt vermiyor');

    db.ref('users/'+uid).on('value',snap=>{
      currentUser=snap.val();if(!currentUser)return;
      if(currentUser.banned){document.body.innerHTML='<div style="padding:40px;text-align:center;font-family:Nunito"><div style="font-size:48px;margin-bottom:12px"><i class="ph-duotone ph-prohibit" style="color:#FF3B30"></i></div><h2>Hesabınız engellendi</h2><p style="color:#6B7280;margin-top:8px">Destek ile iletişime geçin</p></div>';return;}
      // Grant daily card once per session after currentUser is confirmed populated
      if(!_dailyCardDone){_dailyCardDone=true;distributeDailyCard();}
      renderAll();
    });

    db.ref('notifications').orderByChild('timestamp').limitToLast(100).on('value',snap=>{
      notifications=[];snap.forEach(c=>{const v=c.val();if(v)notifications.push({id:c.key,...v});});
      notifications.reverse();
      // Only update badge if user is loaded (currentUser might not be set yet on first load)
      updateNotifBadge();
    });

    db.ref('tasks').on('value',snap=>{tasks=[];snap.forEach(c=>tasks.push({id:c.key,...c.val()}));renderTasks();});

    db.ref('withdrawMethods').on('value',snap=>{
      withdrawMethods=[];
      snap.forEach(c=>{const m=c.val();if(m.active)withdrawMethods.push({key:c.key,...m});});
      withdrawMethods.sort((a,b)=>(a.order||0)-(b.order||0));
      renderMethods();
    });

    fs.collection('transactions').where('userId','==',uid).orderBy('timestamp','desc').limit(50).onSnapshot(snap=>{
      transactionsCache=[];snap.forEach(d=>transactionsCache.push({id:d.id,...d.data()}));
      renderTransactions();
    },()=>{});

    db.ref('withdrawals').orderByChild('userId').equalTo(uid).limitToLast(20).on('value',snap=>{
      const arr=[];snap.forEach(c=>arr.push({id:c.key,_w:true,...c.val()}));
      window._withdrawals=arr.reverse();
      renderTransactions();
    });

    $('loader').style.display='none';
  }catch(e){
    console.error(e);
    failScreen('Başlatma başarısız: '+escapeHtml(e.message||e));
  }
}

async function distributeDailyCard(){
  const today=getBDDate();
  if(!currentUser || currentUser.lastCardDate===today)return;
  try{await apiRequest('/api/economy',{action:'daily_card'});}
  catch(e){if(e.message!=='ALREADY_CLAIMED')console.warn('Daily card:',e.message);}
}

/* ============ VIP / TIER ============ */
function getVIP(earned){
  const s=appSettings;
  if(earned>=(s.vipPlatinum||200))return{label:'Platinum',icon:'ph-diamond',color:'#8B5CF6',key:'platinum'};
  if(earned>=(s.vipGold||50))return{label:'Gold',icon:'ph-medal',color:'#F59E0B',key:'gold'};
  if(earned>=(s.vipSilver||10))return{label:'Silver',icon:'ph-medal',color:'#9CA3AF',key:'silver'};
  return{label:'Bronze',icon:'ph-medal',color:'#CD7F32',key:'bronze'};
}
function getTier(c){
  if(c>=50)return{name:'Platinum',min:50,next:null,bonus:'+100%'};
  if(c>=25)return{name:'Gold',min:25,next:50,bonus:'+50%'};
  if(c>=10)return{name:'Silver',min:10,next:25,bonus:'+20%'};
  return{name:'Bronze',min:0,next:10,bonus:'Standart'};
}

/* ============ RENDER ============ */
function renderAll(){
  if(!currentUser)return;
  const initial=(currentUser.name||'U').charAt(0).toUpperCase();
  if(currentUser.photoUrl){$('hAvatar').innerHTML=`<img src="${currentUser.photoUrl}">`;}else{$('hAvatar').textContent=initial;}
  $('hName').textContent=currentUser.name||'User';
  $('hUid').textContent=currentUser.uid;

  const newBal=parseFloat(currentUser.balance||0);
  const newEarned=parseFloat(currentUser.totalEarned||0);
  countUp($('balance'),newBal);
  // Also update wallet tab balance immediately (no animation needed there)
  if($('wBalance'))$('wBalance').textContent=newBal.toFixed(4);
  const today=getBDDate();
  const todayAds=currentUser.lastAdDate===today?(currentUser.todayAds||0):0;
  const lim=parseInt(appSettings.dailyLimit||10);
  $('todayAds').textContent=todayAds;
  $('dailyLimit').textContent=lim;
  $('totalEarned').textContent=newEarned.toFixed(2);
  $('refCount').textContent=currentUser.referralCount||0;

  const vip=getVIP(currentUser.totalEarned||0);
  const badge=$('vipBadge');
  badge.querySelector('i').className=`ph-duotone ${vip.icon}`;
  badge.querySelector('i').style.color=vip.color;
  $('vipLabel').textContent=vip.label;

  $('perAdEarn').textContent=parseFloat(appSettings.perAdEarning||0.005).toFixed(4);
  renderAdSection();
  renderStreak();
  renderTeam();
  renderLeaderboard();
  renderWalletTab();
  renderExtras();
  if(sponsors.length)renderSponsors();
}

function renderAdSection(){
  const today=getBDDate();
  const ta=currentUser.lastAdDate===today?(currentUser.todayAds||0):0;
  const lim=parseInt(appSettings.dailyLimit||10);
  $('adsProgressTxt').textContent=`${ta}/${lim}`;$('segAds').textContent=`${ta}/${lim}`;
  $('adsProgressFill').style.width=Math.min(100,(ta/lim)*100)+'%';
  const btn=$('watchAdBtn');
  if(ta>=lim){
    btn.disabled=true;
    btn.innerHTML='<i class="ph-duotone ph-check-circle"></i> Günlük limit doldu';
  }
}

function renderStreak(){
  const today=getBDDate();
  const streak=currentUser.checkInStreak||0;
  const last=currentUser.lastCheckIn||'';
  let html='';
  for(let i=1;i<=7;i++){
    let cls='circle';
    const isDone=(i<streak)||(i===streak&&last===today);
    const isToday=i===streak+1 && last!==today;
    if(isDone)cls+=' done';
    if(isToday)cls+=' today';
    const inner=isDone?'<i class="ph-duotone ph-check-circle"></i>':i;
    html+=`<div class="day"><div class="${cls}">${inner}</div><div class="lbl">Gün ${i}</div></div>`;
  }
  $('streakRow').innerHTML=html;
  $('checkinStreak').innerHTML=html;
}

function renderTeam(){
  const bot=appSettings.botUsername||'EarnBDBot';
  const link=`https://t.me/${bot}?startapp=${currentUser.uid}`;
  $('refLink').value=link;
  $('tRefCount').textContent=currentUser.referralCount||0;
  $('tRefEarn').textContent=parseFloat(currentUser.referralEarned||0).toFixed(2);
  $('tRefBonus').textContent=parseFloat(appSettings.referralBonus||0.1).toFixed(2);
  const tier=getTier(currentUser.referralCount||0);
  $('tierName').textContent=tier.name;
  document.querySelectorAll('.tier-item').forEach(el=>{el.classList.toggle('current',el.dataset.t===tier.name);});
  if(tier.next){
    const p=((currentUser.referralCount-tier.min)/(tier.next-tier.min))*100;
    $('tierProgress').style.width=Math.min(100,p)+'%';
    $('tierHint').textContent=`Sonraki seviyeye: ${tier.next-(currentUser.referralCount||0)} kişi daha gerekli`;
  }else{
    $('tierProgress').style.width='100%';
    $('tierHint').textContent='En yüksek Platinum seviyesine ulaştınız!';
  }

  apiRequest('/api/referrals',{}).then(data=>{
    const arr=data.users||[];
    if(arr.length===0){
      $('refList').innerHTML='<div class="empty"><i class="ph-duotone ph-users"></i><div class="et">Henüz davet yok</div><div>Bağlantınızı paylaşın</div></div>';
      return;
    }
    $('refList').innerHTML=arr.reverse().map(u=>`
      <div class="tx-row">
        <div class="ic blue" style="font-weight:700;font-size:16px">${(u.name||'U').charAt(0)}</div>
        <div class="info"><div class="t">${escapeHtml(u.name||'User')}</div><div class="d">${new Date(u.createdAt||Date.now()).toLocaleDateString('tr-TR')}</div></div>
        <div class="am in" style="font-size:12px">+$${parseFloat(appSettings.referralBonus||0.1).toFixed(2)}</div>
      </div>`).join('');
  });
}

function renderTasks(){
  const f=currentTaskFilter;
  const filtered=tasks.filter(t=>t.active && (f==='all' || (t.type||'').toLowerCase()===f));
  if(filtered.length===0){
    $('taskList').innerHTML='<div class="empty"><i class="ph-duotone ph-list-checks"></i><div class="et">Görev yok</div></div>';
    return;
  }
  const done=currentUser?.completedTasks||{};
  $('taskList').innerHTML=`<div class="stagger">${filtered.map(t=>{
    const iconMap={telegram:'telegram-logo',youtube:'youtube-logo',facebook:'facebook-logo'};
    const ico=iconMap[(t.type||'').toLowerCase()]||'link';
    const isDone=done[t.id];
    return `<div class="card" style="margin-top:8px"><div class="task-row">
      <div class="icon"><i class="ph-duotone ph-${ico}"></i></div>
      <div class="info">
        <div class="t">${escapeHtml(t.title)}</div>
        <div class="m"><i class="ph-duotone ph-currency-dollar"></i>+$${parseFloat(t.reward||0).toFixed(2)} &nbsp;<i class="ph-duotone ph-clock"></i> 10 sn</div>
      </div>
      ${isDone
        ?'<button class="act done" disabled><i class="ph-duotone ph-check-circle"></i> Tamam</button>'
        :`<button class="act task-start" data-id="${escapeHtml(t.id)}"><i class="ph-duotone ph-arrow-right"></i> Başla</button>`
      }
    </div></div>`;
  }).join('')}</div>`;
}

function startTask(id){
  const t=tasks.find(x=>x.id===id);if(!t)return;
  const taskUrl=String(t.url||'');
  if(!/^https:\/\//i.test(taskUrl)){showToast('Görev bağlantısı geçersiz.','danger');return;}
  const tg=window.Telegram?.WebApp;
  if(/^https:\/\/t\.me\//i.test(taskUrl)&&tg?.openTelegramLink)tg.openTelegramLink(taskUrl);
  else if(tg?.openLink)tg.openLink(taskUrl);
  else window.open(taskUrl,'_blank','noopener,noreferrer');
  const btn=[...document.querySelectorAll('.task-start')].find(el=>el.dataset.id===String(id));
  if(!btn)return;
  let s=10;btn.disabled=true;
  const iv=setInterval(()=>{
    btn.innerHTML=`<i class="ph-duotone ph-clock"></i> ${s}s`;
    if(--s<0){clearInterval(iv);completeTask(id);}
  },1000);
}

async function completeTask(id){
  const t=tasks.find(x=>x.id===id);if(!t)return;
  const uid=String(TGUser.id);
  const r=parseFloat(t.reward||0);
  try{await apiRequest('/api/economy',{action:'task',taskId:id});showToast('Görev tamamlandı ve ödül sunucuda işlendi.','success');}
  catch(e){const message=e.message==='ALREADY_COMPLETED'?'Bu görev zaten tamamlandı.':e.message==='TASK_VERIFICATION_FAILED'?'Üyelik doğrulanamadı. Botun kanalda olduğundan emin olun.':'Görev ödülü verilemedi: '+e.message;showToast(message,'danger');}
}

document.addEventListener('click',e=>{
  const taskButton=e.target.closest('.task-start');
  if(taskButton&&!taskButton.disabled)startTask(taskButton.dataset.id);
  if(e.target.closest('#taskFilters .pill')){
    const el=e.target.closest('.pill');
    document.querySelectorAll('#taskFilters .pill').forEach(p=>p.classList.remove('active'));
    el.classList.add('active');currentTaskFilter=el.dataset.f;renderTasks();
  }
  if(e.target.closest('#txFilters .pill')){
    const el=e.target.closest('.pill');
    document.querySelectorAll('#txFilters .pill').forEach(p=>p.classList.remove('active'));
    el.classList.add('active');currentTxFilter=el.dataset.f;renderTransactions();
  }
});

let _lbTimer=null,_lbFirstLoad=false;
function renderLeaderboard(){
  // First load always runs; subsequent calls debounced to 5s
  if(_lbTimer && _lbFirstLoad)return;
  _lbFirstLoad=true;
  clearTimeout(_lbTimer);
  _lbTimer=setTimeout(()=>{_lbTimer=null;},5000);
  apiRequest('/api/leaderboard',{}).then(data=>{
    const arr=data.users||[];
    arr.sort((a,b)=>(b.totalEarned||0)-(a.totalEarned||0));
    const top3=arr.slice(0,3);
    const rest=arr.slice(3);
    const pAv=u=>u?(u.photoUrl?`<img src="${u.photoUrl}">`:(u.name||'U').charAt(0).toUpperCase()):'?';
    let podHtml='';
    [0,1,2].forEach(i=>{
      const u=top3[i];
      if(!u){podHtml+=`<div class="p p${i+1}"><div class="avt" style="width:${i===0?80:66}px;height:${i===0?80:66}px">?</div><div class="nm">—</div></div>`;return;}
      const crown=i===0?'<div class="crown"><i class="ph-duotone ph-crown"></i></div>':'';
      podHtml+=`<div class="p p${i+1}">${crown}<div class="avt" style="width:${i===0?80:66}px;height:${i===0?80:66}px">${pAv(u)}</div><div class="nm">${escapeHtml(u.name||'User')}</div><div class="am num">$${parseFloat(u.totalEarned||0).toFixed(2)}</div><div class="rank">#${i+1}</div></div>`;
    });
    $('podium').innerHTML=podHtml;

    const me=currentUser?.uid;
    $('lbList').innerHTML=rest.map((u,i)=>{
      const r=i+4;const isMe=u.uid===me;
      return `<div class="lb-row ${isMe?'me':''}"><div class="r">#${r}</div><div class="av">${u.photoUrl?`<img src="${u.photoUrl}">`:(u.name||'U').charAt(0)}</div><div class="nm">${escapeHtml(u.name||'User')}${isMe?' (Siz)':''}</div><div class="am num">$${parseFloat(u.totalEarned||0).toFixed(2)}</div></div>`;
    }).join('')||'<div class="empty"><i class="ph-duotone ph-trophy"></i><div class="et">Sıralama boş</div></div>';
  });
}

function renderWalletTab(){
  $('wBalance').textContent=parseFloat(currentUser.balance||0).toFixed(4);
  $('wTotal').textContent=parseFloat(currentUser.totalWithdrawn||0).toFixed(2);
}

function renderMethods(){
  if(withdrawMethods.length===0){
    $('methodGrid').innerHTML='<div class="empty" style="grid-column:1/-1;padding:14px">Yöntem yok</div>';
    return;
  }
  $('methodGrid').innerHTML=withdrawMethods.map(m=>`
    <div class="method-card" data-method="${escapeHtml(m.key)}" data-label="${escapeHtml(m.accountLabel||'Hesap')}" data-placeholder="${escapeHtml(m.accountPlaceholder||'')}" data-min="${m.minWithdraw||5}" onclick="selectMethod(this)">
      <div class="ico">${m.iconUrl?`<img src="${m.iconUrl}" style="width:28px;height:28px;border-radius:6px">`:
        `<i class="ph-duotone ph-credit-card"></i>`
      }</div>
      <div>${escapeHtml(m.name)}</div>
    </div>`).join('');
  $('methodGrid').querySelector('.method-card')?.click();
}

function selectMethod(el){
  document.querySelectorAll('.method-card').forEach(c=>c.classList.remove('selected'));
  el.classList.add('selected');
  selectedMethod=el.dataset.method;
  $('withdrawAccount').placeholder=el.dataset.placeholder;
  $('withdrawAccountLabel').textContent=el.dataset.label;
  $('withdrawMinLabel').innerHTML=`<i class="ph-duotone ph-info"></i> En az $${el.dataset.min}`;
}

function renderTransactions(){
  if(currentUser)renderExtras();
  const tx=transactionsCache.map(t=>({...t,_ts:t.timestamp?.toMillis?.()||Date.now()}));
  const wd=(window._withdrawals||[]).map(w=>({...w,_ts:w.requestedAt||0,type:'withdraw',amount:w.amount}));
  let all=[...tx,...wd].sort((a,b)=>b._ts-a._ts);
  if(currentTxFilter==='in')all=all.filter(t=>!t._w && t.type!=='withdraw');
  if(currentTxFilter==='out')all=all.filter(t=>t._w||t.type==='withdraw');
  if(all.length===0){
    $('txList').innerHTML='<div class="empty"><i class="ph-duotone ph-receipt"></i><div class="et">İşlem yok</div></div>';
    return;
  }
  const labelMap={ad:'Reklam',sponsor:'Sponsor',task:'Görev',spin:'Çark',checkin:'Yoklama',referral:'Davet',withdraw:'Çekim',purchase:'Satın alma'};
  $('txList').innerHTML=all.slice(0,30).map(t=>{
    const isOut=t._w||t.type==='withdraw';
    const label=labelMap[t.type]||t.type;
    const ic=isOut?'arrow-up-right':'arrow-down-left';
    const cls=isOut?'out':'in';
    const sign=isOut?'-':'+';
    const status=t._w?` <span class="badge ${t.status}">${({pending:'Beklemede',approved:'Onaylandı',rejected:'Reddedildi'})[t.status]||t.status}</span>`:'';
    return `<div class="tx-row"><div class="ic ${cls}"><i class="ph-duotone ph-${ic}"></i></div>
      <div class="info"><div class="t">${label}${status}</div><div class="d">${new Date(t._ts).toLocaleString('tr-TR')}</div></div>
      <div class="am ${cls}">${sign}$${parseFloat(t.amount||0).toFixed(2)}</div></div>`;
  }).join('');
}

/* ============ ADS (Monetag) ============ */
/* ============ ADS (Monetag — Earn.html pattern) ============ */
let _sdkLoaded=false,_sdkLoading=false,_sdkCallbacks=[];
let _autoAdInterval=null;

function loadMonetagSDK(zoneId, cb){
  if(_sdkLoaded){cb();return;}
  _sdkCallbacks.push(cb);
  if(_sdkLoading)return;
  _sdkLoading=true;
  // Remove any previous SDK script to avoid duplicate
  const prev=document.querySelector('script[data-zone="'+zoneId+'"]');
  if(prev)prev.remove();
  const s=document.createElement('script');
  s.src='//libtl.com/sdk.js';
  s.setAttribute('data-zone', String(zoneId));
  s.setAttribute('data-sdk','show_'+zoneId);
  s.setAttribute('data-cfasync','false');
  s.async=true;
  s.onload=()=>{
    _sdkLoaded=true;_sdkLoading=false;
    _sdkCallbacks.forEach(fn=>fn());
    _sdkCallbacks=[];
  };
  s.onerror=()=>{
    console.warn('Monetag SDK load failed');
    _sdkLoading=false;
    _sdkCallbacks.forEach(()=>setTimeout(creditAdEarning,3000));
    _sdkCallbacks=[];
  };
  document.head.appendChild(s);
}

function watchAd(){
  const today=getBDDate();
  const todayAds=currentUser.lastAdDate===today?(currentUser.todayAds||0):0;
  const lim=parseInt(appSettings.dailyLimit||10);
  const zoneId=String(appSettings.monetagZoneId||'11148173');
  if(todayAds>=lim){showToast('Günlük limit doldu','warn');return;}

  const btn=$('watchAdBtn');
  btn.disabled=true;
  btn.innerHTML='<i class="ph-duotone ph-spinner-gap"></i> Yükleniyor...';

  loadMonetagSDK(zoneId, ()=>{
    const showFn=window['show_'+zoneId];
    if(typeof showFn==='function'){
      // Earn.html pattern: call showFn(), handle Promise
      try{
        const result=showFn();
        if(result && typeof result.then==='function'){
          result
            .then(()=>creditAdEarning())
            .catch(err=>{
              console.warn('Ad dismissed/error:',err);
              creditAdEarning(); // still credit on dismiss
            });
        } else {
          // No Promise returned — timer fallback
          window._adTimer=setTimeout(creditAdEarning,8000);
        }
      }catch(e){
        console.warn('Ad show error:',e);
        setTimeout(creditAdEarning,5000);
      }
    } else {
      // SDK loaded but function not ready yet — retry once
      setTimeout(()=>{
        const fn=window['show_'+zoneId];
        if(typeof fn==='function'){
          const r=fn();
          if(r&&typeof r.then==='function'){
            r.then(()=>creditAdEarning()).catch(()=>creditAdEarning());
          }else{setTimeout(creditAdEarning,8000);}
        }else{
          // Final fallback
          setTimeout(creditAdEarning,5000);
        }
      },1500);
    }
  });
}

async function creditAdEarning(){
  clearTimeout(window._adTimer);
  // Client-side ad SDK callbacks are not trusted as proof of a valid impression.
  showToast('Reklam ödülü, sağlayıcı imzalı sunucu doğrulaması eklenene kadar kapalı.','warn');
  renderAdSection();
  const btn=$('watchAdBtn');
  if(btn){btn.disabled=false;btn.innerHTML='<i class="ph-duotone ph-play-circle"></i> Reklam İzle';}
}

/* ============ TABS ============ */
function switchTab(name){
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  $('tab-'+name).classList.add('active');
  document.querySelector(`.nav-item[data-tab="${name}"]`).classList.add('active');
  window.scrollTo(0,0);
  // Force leaderboard refresh when switching to board tab
  if(name==='tasks')loadSponsors();
  if(name==='board'){_lbTimer=null;_lbFirstLoad=false;renderLeaderboard();}
}

/* ============ MODALS ============ */
function openModal(id){$(id).classList.add('open');}
function closeModal(id){$(id).classList.remove('open');}

/* CHECK-IN */
function openCheckin(){renderStreak();openModal('checkinModal');}
async function doCheckin(){
  const today=getBDDate();
  if(currentUser.lastCheckIn===today){showToast('Bugün zaten yoklama yaptınız','warn');return;}
  const yest=new Date(Date.now()+6*3600*1000-86400000).toISOString().split('T')[0];
  const continued=currentUser.lastCheckIn===yest;
  let newStreak=continued?Math.min(7,(currentUser.checkInStreak||0)+1):1;
  const rewards=(appSettings.checkinRewards||[0.01,0.02,0.03,0.05,0.08,0.12,0.2]);
  const r=parseFloat(rewards[newStreak-1]||0.01);
  const uid=String(TGUser.id);
  try{const result=await apiRequest('/api/economy',{action:'checkin'});const streak=Number(result.extra?.day||0);if(streak===7)fireConfetti();showToast('Yoklama ödülü işlendi. Seri: '+streak,'success');closeModal('checkinModal');}
  catch(e){showToast(e.message==='ALREADY_CLAIMED'?'Bugün zaten yoklama yaptınız.':'Yoklama başarısız: '+e.message,'danger');}
}

/* SPIN */
function openSpin(){drawWheel();$('spinCardCount').textContent=currentUser?.spinCards||0;openModal('spinModal');}
function drawWheel(rot=0){
  const c=$('spinCanvas');const ctx=c.getContext('2d');
  const size=c.width;const cx=size/2,cy=size/2,r=size/2-10;
  ctx.clearRect(0,0,size,size);
  const rewards=appSettings.spinRewards||[0.01,0.05,0.02,0.1,0.01,0.5,0.03,1];
  const seg=rewards.length;const ang=2*Math.PI/seg;
  const colors=['#7C3AED','#0EA5E9','#F59E0B','#10B981','#EC4899','#6366F1','#14B8A6','#F97316'];
  ctx.save();ctx.translate(cx,cy);ctx.rotate(rot);
  for(let i=0;i<seg;i++){
    ctx.beginPath();ctx.moveTo(0,0);
    ctx.arc(0,0,r,i*ang,(i+1)*ang);
    ctx.fillStyle=colors[i%colors.length];ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,.4)';ctx.lineWidth=1.5;ctx.stroke();
    ctx.save();ctx.rotate(i*ang+ang/2);ctx.textAlign='right';
    ctx.fillStyle='#fff';ctx.font='bold 12px Poppins,sans-serif';
    ctx.fillText('$'+rewards[i],r-14,4);ctx.restore();
  }
  ctx.restore();
  // Center button
  ctx.beginPath();ctx.arc(cx,cy,32,0,2*Math.PI);
  const grd=ctx.createRadialGradient(cx,cy,0,cx,cy,32);
  grd.addColorStop(0,'#F59E0B');grd.addColorStop(1,'#D97706');
  ctx.fillStyle=grd;ctx.fill();
  ctx.strokeStyle='rgba(255,255,255,.5)';ctx.lineWidth=2;ctx.stroke();
  ctx.fillStyle='#fff';ctx.font='bold 11px Poppins,sans-serif';ctx.textAlign='center';ctx.fillText('SPIN',cx,cy+4);
  // Pointer
  ctx.beginPath();ctx.moveTo(cx+r-4,cy);ctx.lineTo(cx+r+18,cy-11);ctx.lineTo(cx+r+18,cy+11);ctx.closePath();
  ctx.fillStyle='#FF3B30';ctx.fill();
  ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.stroke();
}
async function doSpin(){
  if((currentUser.spinCards||0)<1){showToast('Biletiniz yok — Mağazadan satın alın','warn');return;}
  const btn=$('spinBtn');btn.disabled=true;
  btn.innerHTML='<i class="ph-duotone ph-spinner-gap"></i> Dönüyor...';
  let result;
  try{
    result=await apiRequest('/api/economy',{action:'spin'});
  }catch(e){
    showToast(e.message==='NO_SPIN_CARDS'?'Çark biletiniz yok.':'Çark işlemi başarısız: '+e.message,'danger');
    btn.disabled=false;btn.innerHTML='<i class="ph-duotone ph-arrow-clockwise"></i> Çevir';
    return;
  }
  const rewards=appSettings.spinRewards||[0.01,0.05,0.02,0.1,0.01,0.5,0.03,1];
  const seg=rewards.length;
  const winIdx=Number(result.extra?.rewardIndex||0)%seg;
  const prize=Number(result.reward||0);
  const targetRot=(2*Math.PI*5)+(2*Math.PI-(winIdx*(2*Math.PI/seg))-Math.PI/seg);
  const dur=4200;const start=performance.now();
  function step(t){
    const p=Math.min(1,(t-start)/dur);
    const eased=1-Math.pow(1-p,3);
    drawWheel(eased*targetRot);
    if(p<1){requestAnimationFrame(step);}
    else{
      fireConfetti();showToast('Kazandınız: $'+prize.toFixed(4),'success');
      btn.disabled=false;btn.innerHTML='<i class="ph-duotone ph-arrow-clockwise"></i> Çevir';
    }
  }
  requestAnimationFrame(step);
}

/* MARKET */
function openMarket(){
  const items=[
    {n:'1 × Çark Bileti',q:1,p:parseFloat(appSettings.spinCard1Price||0.5),icon:'ph-circles-three-plus'},
    {n:'5 × Çark Bileti',q:5,p:parseFloat(appSettings.spinCard5Price||2),icon:'ph-gift'},
    {n:'10 × Çark Bileti',q:10,p:parseFloat(appSettings.spinCard10Price||3.5),icon:'ph-diamond'}
  ];
  $('marketGrid').innerHTML=items.map(it=>`
    <div class="market-item">
      <div class="ico"><i class="ph-duotone ${it.icon}"></i></div>
      <div class="info"><div class="t">${it.n}</div><div class="p">$${it.p.toFixed(2)}</div></div>
      <button class="btn-primary" style="width:auto;padding:10px 16px;font-size:13px" onclick="buyCards(${it.q},${it.p})">
        <i class="ph-duotone ph-shopping-cart"></i> Satın Al
      </button>
    </div>`).join('');
  openModal('marketModal');
}
async function buyCards(q,p){
  if((currentUser.balance||0)<p){showToast('Yetersiz bakiye','danger');return;}
  try{await apiRequest('/api/economy',{action:'buy_cards',count:q});showToast(q+' bilet başarıyla satın alındı!','success');}
  catch(e){showToast(e.message==='INSUFFICIENT_BALANCE'?'Yetersiz bakiye':'Satın alma başarısız: '+e.message,'danger');}
}

/* NOTIFICATIONS */
function updateNotifBadge(){
  const seen=parseInt(localStorage.getItem('notifSeen')||'0');
  unreadCount=notifications.filter(n=>(n.timestamp||0)>seen).length;
  $('notifDot').style.display=unreadCount>0?'block':'none';
  const banner=notifications.find(n=>n.showBanner && (n.timestamp||0)>seen);
  $('bannerNotif').innerHTML=banner?`<div class="banner-notif"><i class="ph-duotone ph-megaphone"></i> ${escapeHtml(banner.title)}</div>`:'';
}
function openNotifications(){
  if(notifications.length===0){
    $('notifList').innerHTML='<div class="empty"><i class="ph-duotone ph-bell-slash"></i><div class="et">Bildirim yok</div></div>';
  }else{
    $('notifList').innerHTML=notifications.map(n=>`
      <div class="notif">
        <div class="t">${escapeHtml(n.title)}</div>
        <div class="b">${escapeHtml(n.body||'')}</div>
        <div class="ts"><i class="ph-duotone ph-clock"></i>${new Date(n.timestamp||Date.now()).toLocaleString('tr-TR')}</div>
      </div>`).join('');
  }
  localStorage.setItem('notifSeen',Date.now());
  updateNotifBadge();
  openModal('notifModal');
}

/* TEAM */
function copyRef(){
  const i=$('refLink');
  navigator.clipboard.writeText(i.value).then(()=>showToast('Bağlantı kopyalandı!','success')).catch(()=>{i.select();document.execCommand('copy');showToast('Kopyalandı','success');});
}
function shareTG(){
  const link=$('refLink').value;
  const txt="Coinix FAUCET'e katıl ve her gün kazan!";
  if(window.Telegram?.WebApp?.openTelegramLink){
    window.Telegram.WebApp.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(txt)}`);
  }else{
    window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(txt)}`,'_blank');
  }
}

/* WITHDRAW */
let _withdrawPending=false;
async function submitWithdraw(){
  if(_withdrawPending)return;
  if(!selectedMethod){showToast('Yöntem seçin','warn');return;}
  const m=withdrawMethods.find(x=>x.key===selectedMethod);
  const amt=parseFloat($('withdrawAmount').value);
  const acc=$('withdrawAccount').value.trim();
  if(!amt||amt<=0){showToast('Geçerli bir tutar girin','warn');return;}
  if(amt<(m.minWithdraw||5)){showToast(`En az $${m.minWithdraw}`,'warn');return;}
  if(m.maxWithdraw>0 && amt>m.maxWithdraw){showToast(`En çok $${m.maxWithdraw}`,'warn');return;}
  if(!acc){showToast('Hesap numarası girin','warn');return;}
  if(amt>(currentUser.balance||0)){showToast('Yetersiz bakiye','danger');return;}
  const btn=$('submitWithdrawBtn');
  _withdrawPending=true;if(btn){btn.disabled=true;btn.textContent='Gönderiliyor...';}
  try{await apiRequest('/api/economy',{action:'withdraw',amount:amt,method:m.key,account:acc});showToast('Çekim talebi gönderildi!','success');$('withdrawAmount').value='';$('withdrawAccount').value='';}
  catch(e){showToast('Çekim talebi başarısız: '+e.message,'danger');}
  finally{_withdrawPending=false;if(btn){btn.disabled=false;btn.innerHTML='<i class="ph-duotone ph-paper-plane-tilt"></i> Çekim Talebi Gönder';}}
}

/* ===== FAUCET + FX ===== */
document.addEventListener('pointerdown',e=>{const b=e.target.closest('.btn-big,.btn-primary,.act,.qa,.tg-share');if(!b||b.disabled)return;const r=b.getBoundingClientRect(),d=Math.max(r.width,r.height),p=document.createElement('span');p.className='rip';p.style.cssText=`width:${d}px;height:${d}px;left:${e.clientX-r.left-d/2}px;top:${e.clientY-r.top-d/2}px`;b.appendChild(p);setTimeout(()=>p.remove(),600);hap();});
(function(){const c=$('fx'),x=c.getContext('2d');if(matchMedia('(prefers-reduced-motion:reduce)').matches)return;let W,H,P=[];
function rs(){W=c.width=innerWidth;H=c.height=innerHeight}rs();addEventListener('resize',rs);
for(let i=0;i<38;i++)P.push({x:Math.random()*W,y:Math.random()*H,r:1+Math.random()*3,v:.15+Math.random()*.4,a:Math.random()*6.28,g:Math.random()<.35});
(function f(){x.clearRect(0,0,W,H);P.forEach(p=>{p.y-=p.v;p.a+=.02;p.x+=Math.sin(p.a)*.3;if(p.y<-10){p.y=H+10;p.x=Math.random()*W}
x.beginPath();x.arc(p.x,p.y,p.r,0,6.28);x.fillStyle=p.g?'rgba(255,193,7,.55)':'rgba(56,189,248,.35)';x.shadowBlur=12;x.shadowColor=x.fillStyle;x.fill()});requestAnimationFrame(f)})();})();

/* ===== FIREBASE YÜKLEYİCİ (gstatic engelliyse jsDelivr'e düşer) ===== */
function loadScript(src){return new Promise((ok,no)=>{const e=document.createElement('script');e.src=src;e.onload=ok;e.onerror=no;document.head.appendChild(e);});}
async function loadFirebase(){
  const mods=[['app',()=>window.firebase],['auth',()=>window.firebase&&firebase.auth],['database',()=>window.firebase&&firebase.database],['firestore',()=>window.firebase&&firebase.firestore]];
  const bases=['https://www.gstatic.com/firebasejs/9.23.0/','https://cdn.jsdelivr.net/npm/firebase@9.23.0/'];
  for(const[n,has]of mods){
    for(const b of bases){if(has())break;try{await loadScript(`${b}firebase-${n}-compat.js`);}catch(e){}}
    if(!has())return false;
  }
  return true;
}
function failScreen(m){const l=$('loader');l.style.display='flex';l.innerHTML=`<div style="padding:30px;text-align:center"><div style="font-size:44px">📡</div><h2 style="margin:10px 0">Yüklenemedi</h2><p style="opacity:.85;margin-bottom:16px">${m}</p><button onclick="location.reload()" style="background:#fff;color:#1A73E8;padding:12px 22px;border-radius:12px;font-weight:700">Yenile</button></div>`;}
const withTO=(p,ms,fb)=>Promise.race([p,new Promise(r=>setTimeout(()=>r(fb),ms))]);
async function boot(){
  const wd=setTimeout(()=>{if($('loader').style.display!=='none')failScreen('Sunucuya ulaşılamıyor. İnternet/VPN ve Firebase kurallarını kontrol edin.')},20000);
  await withTO(loadScript('https://telegram.org/js/telegram-web-app.js').catch(()=>{}),3500);
  if(!(await withTO(loadFirebase(),12000,false))){clearTimeout(wd);failScreen('Firebase yüklenemedi. İnternet/VPN bağlantınızı kontrol edin.');return;}
  firebase.initializeApp(firebaseConfig);db=firebase.database();fs=firebase.firestore();init();
}

/* ===== SPONSORLU GÖREVLER (PiarFlow) — API anahtarı sunucuda (proxy) durur ===== */
const SPONSOR_API_URL='/api'; // veya Firebase: settings/sponsorApiUrl
let sponsors=[],_spT=0;
function spUrl(){return String(appSettings.sponsorApiUrl||SPONSOR_API_URL||'').replace(/\/$/,'');}
function hashLink(l){let h=5381;for(let i=0;i<l.length;i++)h=((h<<5)+h+l.charCodeAt(i))>>>0;return 'sp'+h.toString(36);}
function spName(l){return escapeHtml(String(l).replace(/^https?:\/\/(t\.me\/)?/,'').slice(0,30));}
async function spApi(path,body){
  const r=await fetch(spUrl()+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,initData:window.Telegram?.WebApp?.initData||''})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok||d.status==='error')throw new Error(r.status===403?'Önce botu başlatın (/start)':(d.message||('Hata '+r.status)));
  return d;
}
async function loadSponsors(force){
  const box=$('sponsorList');if(!box||!TGUser)return;
  if(!spUrl()){box.innerHTML='<div class="empty" style="padding:16px"><i class="ph-duotone ph-plugs"></i><div class="et">Sponsor sistemi kapalı</div><div>settings/sponsorApiUrl tanımlanmalı</div></div>';return;}
  if(!force&&sponsors.length&&Date.now()-_spT<30000)return;
  box.innerHTML='<div class="empty" style="padding:16px"><i class="ph-duotone ph-spinner-gap"></i>Yükleniyor...</div>';
  try{const uid=Number(TGUser.id);
    const d=await spApi('/sponsors',{user_id:uid,chat_id:uid,max_sponsors:parseInt(appSettings.sponsorMax||10)});
    sponsors=d.sponsors||[];_spT=Date.now();renderSponsors();
  }catch(e){box.innerHTML=`<div class="empty" style="padding:16px"><i class="ph-duotone ph-warning"></i><div class="et">${escapeHtml(e.message)}</div></div>`;}
}
function renderSponsors(){
  const box=$('sponsorList');if(!box)return;
  const done=currentUser?.sponsorDone||{},rw=parseFloat(appSettings.sponsorReward||0.0025);
  $('segSp').textContent=sponsors.filter(x=>!done[hashLink(x.link)]).length;
  if(!sponsors.length){box.innerHTML='<div class="empty" style="padding:16px"><i class="ph-duotone ph-megaphone"></i><div class="et">Şu an sponsorlu görev yok</div></div>';return;}
  box.innerHTML=sponsors.map((s,i)=>`<div class="card sp-card"><div class="task-row">
    <div class="icon"><i class="ph-duotone ph-megaphone"></i></div>
    <div class="info"><div class="t">${spName(s.link)}</div><div class="m"><i class="ph-duotone ph-currency-dollar"></i>+$${rw.toFixed(4)}<span class="sp-badge">SPONSORLU</span></div></div>
    ${done[hashLink(s.link)]?'<button class="act done" disabled><i class="ph-duotone ph-check-circle"></i> Tamam</button>':`<div class="sp-btns"><button class="act" onclick="openSponsor(${i})">Katıl</button><button class="act" id="spc${i}" onclick="checkSponsor(${i})">Kontrol</button></div>`}
  </div></div>`).join('');
}
function openSponsor(i){
  const l=sponsors[i]?.link||'';if(!/^https:\/\//.test(l))return;
  const tg=window.Telegram?.WebApp;
  if(tg&&/^https:\/\/t\.me\//.test(l)&&tg.openTelegramLink)tg.openTelegramLink(l);else if(tg?.openLink)tg.openLink(l);else window.open(l,'_blank');
}
async function checkSponsor(i){
  const s=sponsors[i],b=$('spc'+i);if(!s||!b)return;b.disabled=true;b.textContent='...';
  try{
    const d=await spApi('/sponsors/check',{user_id:Number(TGUser.id),links:[s.link]});
    const st=(d.sponsors||[]).find(x=>x.link===s.link)?.status;
    if(st==='subscribed'){
      if(d.rewarded)await creditSponsor(s.link);
      else showToast('Bu sponsor görevinin ödülü daha önce işlendi.','warn');
    }
    else if(st==='not_counted')showToast('Görev sayıldı ama ödül verilmedi','warn');
    else showToast('Görev henüz tamamlanmamış','warn');
  }catch(e){showToast(e.message,'danger');}
  b.disabled=false;b.textContent='Kontrol';
}
async function creditSponsor(link){
  fireConfetti();hap('heavy');showToast('Sponsor görevi doğrulandı ve ödül sunucuda işlendi.','success');
}

let _tv='sponsor';
function setTaskView(v){_tv=v;document.querySelectorAll('#taskSeg button').forEach(b=>b.classList.toggle('on',b.dataset.v===v));['ads','sponsor','std'].forEach(k=>$('view-'+k).style.display=k===v?'block':'none');if(v==='sponsor')loadSponsors();hap();}
function goTask(v){switchTab('tasks');setTaskView(v);}
window.addEventListener('offline',()=>showToast('İnternet bağlantısı yok','danger'));
window.addEventListener('online',()=>showToast('Bağlantı geri geldi','success'));
boot();

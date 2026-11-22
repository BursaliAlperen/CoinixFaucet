'use strict';
const tg=window.Telegram?.WebApp;
if(tg){tg.ready();tg.expand();}
const $=id=>document.getElementById(id);
const initData=tg?.initData||'';
function showNotice(message,error=false){const el=$('notice');el.textContent=String(message||'');el.className='notice'+(error?' error':'');el.hidden=false;}
function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function api(path,payload={}){
  if(!initData)throw new Error('Open this dashboard inside the Coinix Telegram bot.');
  const res=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...payload,initData})});
  const data=await res.json().catch(()=>({}));
  if(!res.ok||data.status==='error')throw new Error(data.code||data.message||('HTTP '+res.status));
  return data;
}
function fmt(n){return Number(n||0).toLocaleString('en-US',{maximumFractionDigits:4});}
function moneyLabel(value){return '
  try{
    const d=await api('/api/admin/overview');
    $('adminStatus').textContent='ADMIN VERIFIED';
    $('statUsers').textContent=fmt(d.stats.users);
    $('statBalance').textContent='$'+fmt(d.stats.totalBalance);
    $('statEarned').textContent='$'+fmt(d.stats.totalEarned);
    $('statMax').textContent=fmt(d.stats.level50);
    $('pendingCount').textContent=fmt(d.stats.pendingWithdrawals)+' PENDING';
    const settings=d.settings||{};
    for(const [key,value] of Object.entries(settings)){
      const field=$('settingsForm').elements.namedItem(key);
      if(field&&value!==undefined)field.value=value;
    }
    const withdrawals=d.withdrawals||[];
    $('withdrawals').innerHTML=withdrawals.length?withdrawals.map(w=>{
      return '<div class="list-item withdrawal-item"><div><strong>'+
        escapeHtml(w.name||w.userId)+' · $'+fmt(w.amount)+' · '+escapeHtml(String(w.method||'').toUpperCase())+
        '</strong><small>'+escapeHtml(w.account||'')+'</small><small>'+
        new Date(w.requestedAt||Date.now()).toLocaleString()+
        '</small><div class="withdraw-actions"><button type="button" class="pay-btn" data-withdraw-action="pay" data-id="'+escapeHtml(w.id)+'" data-currency="'+escapeHtml(String(w.method||'').toUpperCase())+'">Mark paid</button>'+
        '<button type="button" class="reject-btn" data-withdraw-action="reject" data-id="'+escapeHtml(w.id)+'">Reject &amp; refund</button></div></div></div>';
    }).join(''):'<div class="empty">No pending TON/GRAM withdrawals.</div>';
    const promotions=d.promotions||[];
    $('promotions').innerHTML=promotions.length?promotions.map(p=>
      '<div class="list-item"><div><strong>'+escapeHtml(p.title)+'</strong><small>'+
      escapeHtml(p.message)+'</small></div><small>'+escapeHtml(p.status||'draft')+'</small></div>'
    ).join(''):'<div class="empty">No promotions yet.</div>';
    const panels=await Promise.allSettled([loadTasks(),loadClaims(),loadProviders(),loadAnalytics(),loadBotControl()]);
    if(panels.some(x=>x.status==='rejected'))showNotice('Bazı paneller yüklenemedi. Yenile düğmesini kullan.',true);else showNotice('Panel verileri güncellendi.');
  }catch(e){$('adminStatus').textContent='ACCESS DENIED';showNotice(e.message,true);}
}
$('promoForm').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.currentTarget,btn=form.querySelector('button');btn.disabled=true;
  try{
    await api('/api/admin/promo',Object.fromEntries(new FormData(form).entries()));
    showNotice('Promotion published to Telegram channel.');form.reset();await loadOverview();
  }catch(err){showNotice(err.message,true);}finally{btn.disabled=false;}
});
$('settingsForm').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.currentTarget,btn=form.querySelector('button');
  const values=Object.fromEntries([...new FormData(form).entries()].map(([k,v])=>[k,Number(v)]));btn.disabled=true;
  try{await api('/api/admin/settings',values);showNotice('Economy and XP settings saved.');}
  catch(err){showNotice(err.message,true);}finally{btn.disabled=false;}
});
function openWithdrawalModal(id,action,currency){
  $('withdrawActionId').value=id;
  $('withdrawAction').value=action;
  $('withdrawModalTitle').textContent=action==='pay'?'Complete '+currency+' payout':'Reject withdrawal';
  $('withdrawModalSummary').textContent=action==='pay'?'Enter the actual amount sent and the confirmed blockchain transaction hash.':'The original USD balance will be returned to the user.';
  $('payoutFields').hidden=action!=='pay';
  $('rejectFields').hidden=action!=='reject';
  $('confirmWithdrawAction').textContent=action==='pay'?'Mark as paid':'Reject & refund';
  $('withdrawModal').hidden=false;
}
function closeWithdrawalModal(){$('withdrawModal').hidden=true;}
$('withdrawals').addEventListener('click',e=>{
  const btn=e.target.closest('[data-withdraw-action]');if(!btn)return;
  openWithdrawalModal(btn.dataset.id,btn.dataset.withdrawAction,btn.dataset.currency||'TON');
});
$('closeWithdrawModal').addEventListener('click',closeWithdrawalModal);
$('cancelWithdrawModal').addEventListener('click',closeWithdrawalModal);
$('withdrawModal').addEventListener('click',e=>{if(e.target.id==='withdrawModal')closeWithdrawalModal();});
$('withdrawActionForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const id=$('withdrawActionId').value,action=$('withdrawAction').value,btn=$('confirmWithdrawAction');
  const payload={id,action};
  if(action==='pay'){
    payload.payoutAmount=Number($('payoutAmount').value);
    payload.txHash=$('payoutTxHash').value.trim();
    if(!Number.isFinite(payload.payoutAmount)||payload.payoutAmount<=0){showNotice('Enter a valid coin amount.',true);return;}
    if(payload.txHash.length<20){showNotice('A valid transaction hash is required.',true);return;}
  }else{payload.reason=$('payoutRejectReason').value.trim()||'Rejected by admin';}
  btn.disabled=true;
  try{
    await api('/api/admin/withdrawal',payload);
    showNotice(action==='pay'?'Withdrawal marked paid.':'Withdrawal rejected and USD balance refunded.');
    closeWithdrawalModal();$('withdrawActionForm').reset();await loadOverview();
  }catch(err){showNotice(err.message,true);}
  finally{btn.disabled=false;}
});
$('taskForm').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.currentTarget,btn=form.querySelector('button[type="submit"]'),v=Object.fromEntries(new FormData(form).entries());
  v.reward=Number(v.reward);v.totalLimit=Number(v.totalLimit);v.perUserLimit=Number(v.perUserLimit);
  v.startAt=v.startAt?new Date(v.startAt).toISOString():new Date().toISOString();v.endAt=v.endAt?new Date(v.endAt).toISOString():'';
  btn.disabled=true;try{await api('/api/admin/tasks',{...v,action:'create'});form.reset();form.elements.namedItem('reward').value='0.002';form.elements.namedItem('perUserLimit').value='1';showNotice('Görev kaydedildi.');await loadTasks();}
  catch(err){showNotice(err.message,true);}finally{btn.disabled=false;}
});
$('taskForm').elements.namedItem('type').addEventListener('change',e=>{$('taskForm').elements.namedItem('verificationMethod').value=['channel','group'].includes(e.target.value)?'telegram_membership':'manual';});
$('taskAdminList').addEventListener('click',async e=>{const b=e.target.closest('[data-task-status]');if(!b)return;b.disabled=true;try{await api('/api/admin/tasks',{action:'status',id:b.dataset.id,status:b.dataset.taskStatus});await loadTasks();showNotice('Görev durumu güncellendi.');}catch(err){showNotice(err.message,true);}finally{b.disabled=false;}});
$('taskClaims').addEventListener('click',async e=>{const b=e.target.closest('[data-claim-action]');if(!b)return;b.disabled=true;try{await api('/api/admin/task-review',{taskId:b.dataset.task,userId:b.dataset.user,claimId:b.dataset.claim,decision:b.dataset.claimAction});await loadClaims();showNotice('Görev kanıtı işlendi.');}catch(err){showNotice(err.message,true);}finally{b.disabled=false;}});
$('refreshTasksBtn').addEventListener('click',async()=>{try{await Promise.all([loadTasks(),loadClaims()]);}catch(e){showNotice(e.message,true);}});
$('analyticsApply').addEventListener('click',()=>loadAnalytics().catch(e=>showNotice(e.message,true)));
$('analyticsCsv').addEventListener('click',exportAnalyticsCsv);
$('botStartBtn').addEventListener('click',async()=>{try{await api('/api/admin/bot-control',{enabled:true});await loadBotControl();showNotice('Bot etkinleştirildi.');}catch(e){showNotice(e.message,true);}});
$('botStopBtn').addEventListener('click',async()=>{try{await api('/api/admin/bot-control',{enabled:false});await loadBotControl();showNotice('Bot duraklatıldı.');}catch(e){showNotice(e.message,true);}});

$('refreshBtn').addEventListener('click',loadOverview);
loadOverview();
+fmt(value);}
async function loadBotControl(){
  const d=await api('/api/admin/bot-control',{action:'status'}),enabled=d.enabled===true;
  $('botControlStatus').textContent=enabled?'Etkin':'Duraklatıldı';
  $('botControlStatus').className='pill '+(enabled?'green':'amber');
}
async function loadTasks(){
  const d=await api('/api/admin/tasks',{action:'list'}),items=d.tasks||[];
  $('taskAdminList').innerHTML=items.length?items.map(t=>{
    const status=t.status||(t.active?'active':'paused'),label={draft:'Taslak',active:'Aktif',paused:'Duraklatıldı',completed:'Tamamlandı'}[status]||status;
    return '<div class="list-item task-admin-item"><div><strong>'+escapeHtml(t.title)+'</strong><small>'+escapeHtml(t.type)+' · '+moneyLabel(t.reward)+' · '+fmt(t.totalParticipants)+' katılım</small></div><div class="task-admin-actions"><span class="pill">'+label+'</span>'+
      (status!=='active'?'<button class="secondary" data-task-status="active" data-id="'+escapeHtml(t.id)+'">Aktifleştir</button>':'<button class="secondary" data-task-status="paused" data-id="'+escapeHtml(t.id)+'">Duraklat</button>')+
      (status!=='completed'?'<button class="secondary" data-task-status="completed" data-id="'+escapeHtml(t.id)+'">Bitir</button>':'')+'</div></div>';
  }).join(''):'<div class="empty">Henüz görev oluşturulmadı.</div>';
}
async function loadClaims(){
  const d=await api('/api/admin/task-claims'),items=d.claims||[];$('claimCount').textContent=items.length+' BEKLİYOR';
  $('taskClaims').innerHTML=items.length?items.map(c=>'<div class="list-item"><div><strong>'+escapeHtml(c.title||c.taskId)+' · '+moneyLabel(c.reward)+'</strong><small>Kullanıcı: '+escapeHtml(c.userId)+' · '+new Date(c.createdAt||Date.now()).toLocaleString('tr-TR')+'</small><small>Kanıt: '+escapeHtml(c.proof||'—')+'</small></div><div class="task-admin-actions"><button class="pay-btn" data-claim-action="approve" data-task="'+escapeHtml(c.taskId)+'" data-user="'+escapeHtml(c.userId)+'" data-claim="'+escapeHtml(c.id)+'">Onayla</button><button class="reject-btn" data-claim-action="reject" data-task="'+escapeHtml(c.taskId)+'" data-user="'+escapeHtml(c.userId)+'" data-claim="'+escapeHtml(c.id)+'">Reddet</button></div></div>').join(''):'<div class="empty">Bekleyen kanıt yok.</div>';
}
async function loadProviders(){
  const d=await api('/api/admin/providers'),p=d.providers||{};
  $('providerStatus').innerHTML=[['Piarflow',p.piarflow],['FlyerHubs',p.flyerhubs],['Traffy',p.traffy]].map(([name,v])=>'<div class="list-item"><strong>'+name+'</strong><span class="pill '+(v?.status==='configured'?'green':'amber')+'">'+escapeHtml(v?.status||'bilinmiyor')+'</span></div>').join('');
}
async function loadAnalytics(){
  const filters={days:Number($('analyticsDays').value||30),provider:$('analyticsProvider').value,taskType:$('analyticsTaskType').value,userId:$('analyticsUserId').value.trim()};
  const d=await api('/api/admin/analytics',filters),t=d.totals||{},days=d.days||[];
  $('aNewUsers').textContent=fmt(t.newUsers);$('aActiveUsers').textContent=fmt(t.activeUsers);$('aReferrals').textContent=fmt(t.referrals);
  $('aTasks').textContent=fmt(t.taskCompletions);$('aAds').textContent=fmt(t.adRecords);$('aRewards').textContent=moneyLabel(t.rewardUsd);
  const max=Math.max(1,...days.map(x=>Number(x.rewardUsd||0)));
  $('analyticsChart').innerHTML=days.map(x=>'<div class="chart-col" title="'+escapeHtml(x.key)+' · '+moneyLabel(x.rewardUsd)+'"><div class="chart-bar" style="height:'+Math.max(2,Number(x.rewardUsd||0)/max*100)+'%"></div><small>'+escapeHtml(x.key.slice(5))+'</small></div>').join('');
  $('analyticsRows').innerHTML=days.slice().reverse().map(x=>'<tr><td>'+escapeHtml(x.key)+'</td><td>'+fmt(x.newUsers)+'</td><td>'+fmt(x.activeUsers)+'</td><td>'+fmt(x.referrals)+'</td><td>'+fmt(x.taskCompletions)+'</td><td>'+fmt(x.adRecords)+'</td><td>'+moneyLabel(x.rewardUsd)+'</td></tr>').join('');
  window._analyticsExport=days;
}
function exportAnalyticsCsv(){
  const rows=window._analyticsExport||[];if(!rows.length){showNotice('Önce istatistikleri yükle.',true);return;}
  const keys=['key','newUsers','activeUsers','referrals','taskCompletions','adRecords','rewardUsd','adCreditUsd'];
  const csv=[keys.join(','),...rows.map(r=>keys.map(k=>'"'+String(r[k]??'').replace(/"/g,'""')+'"').join(','))].join('\n');
  const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='coinix-gunluk-istatistik.csv';a.click();URL.revokeObjectURL(url);
}
async function loadOverview(){
  try{
    const d=await api('/api/admin/overview');
    $('adminStatus').textContent='ADMIN VERIFIED';
    $('statUsers').textContent=fmt(d.stats.users);
    $('statBalance').textContent='$'+fmt(d.stats.totalBalance);
    $('statEarned').textContent='$'+fmt(d.stats.totalEarned);
    $('statMax').textContent=fmt(d.stats.level50);
    $('pendingCount').textContent=fmt(d.stats.pendingWithdrawals)+' PENDING';
    const settings=d.settings||{};
    for(const [key,value] of Object.entries(settings)){
      const field=$('settingsForm').elements.namedItem(key);
      if(field&&value!==undefined)field.value=value;
    }
    const withdrawals=d.withdrawals||[];
    $('withdrawals').innerHTML=withdrawals.length?withdrawals.map(w=>{
      return '<div class="list-item withdrawal-item"><div><strong>'+
        escapeHtml(w.name||w.userId)+' · $'+fmt(w.amount)+' · '+escapeHtml(String(w.method||'').toUpperCase())+
        '</strong><small>'+escapeHtml(w.account||'')+'</small><small>'+
        new Date(w.requestedAt||Date.now()).toLocaleString()+
        '</small><div class="withdraw-actions"><button type="button" class="pay-btn" data-withdraw-action="pay" data-id="'+escapeHtml(w.id)+'" data-currency="'+escapeHtml(String(w.method||'').toUpperCase())+'">Mark paid</button>'+
        '<button type="button" class="reject-btn" data-withdraw-action="reject" data-id="'+escapeHtml(w.id)+'">Reject &amp; refund</button></div></div></div>';
    }).join(''):'<div class="empty">No pending TON/GRAM withdrawals.</div>';
    const promotions=d.promotions||[];
    $('promotions').innerHTML=promotions.length?promotions.map(p=>
      '<div class="list-item"><div><strong>'+escapeHtml(p.title)+'</strong><small>'+
      escapeHtml(p.message)+'</small></div><small>'+escapeHtml(p.status||'draft')+'</small></div>'
    ).join(''):'<div class="empty">No promotions yet.</div>';
    showNotice('Dashboard data refreshed.');
  }catch(e){$('adminStatus').textContent='ACCESS DENIED';showNotice(e.message,true);}
}
$('promoForm').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.currentTarget,btn=form.querySelector('button');btn.disabled=true;
  try{
    await api('/api/admin/promo',Object.fromEntries(new FormData(form).entries()));
    showNotice('Promotion published to Telegram channel.');form.reset();await loadOverview();
  }catch(err){showNotice(err.message,true);}finally{btn.disabled=false;}
});
$('settingsForm').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.currentTarget,btn=form.querySelector('button');
  const values=Object.fromEntries([...new FormData(form).entries()].map(([k,v])=>[k,Number(v)]));btn.disabled=true;
  try{await api('/api/admin/settings',values);showNotice('Economy and XP settings saved.');}
  catch(err){showNotice(err.message,true);}finally{btn.disabled=false;}
});
function openWithdrawalModal(id,action,currency){
  $('withdrawActionId').value=id;
  $('withdrawAction').value=action;
  $('withdrawModalTitle').textContent=action==='pay'?'Complete '+currency+' payout':'Reject withdrawal';
  $('withdrawModalSummary').textContent=action==='pay'?'Enter the actual amount sent and the confirmed blockchain transaction hash.':'The original USD balance will be returned to the user.';
  $('payoutFields').hidden=action!=='pay';
  $('rejectFields').hidden=action!=='reject';
  $('confirmWithdrawAction').textContent=action==='pay'?'Mark as paid':'Reject & refund';
  $('withdrawModal').hidden=false;
}
function closeWithdrawalModal(){$('withdrawModal').hidden=true;}
$('withdrawals').addEventListener('click',e=>{
  const btn=e.target.closest('[data-withdraw-action]');if(!btn)return;
  openWithdrawalModal(btn.dataset.id,btn.dataset.withdrawAction,btn.dataset.currency||'TON');
});
$('closeWithdrawModal').addEventListener('click',closeWithdrawalModal);
$('cancelWithdrawModal').addEventListener('click',closeWithdrawalModal);
$('withdrawModal').addEventListener('click',e=>{if(e.target.id==='withdrawModal')closeWithdrawalModal();});
$('withdrawActionForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const id=$('withdrawActionId').value,action=$('withdrawAction').value,btn=$('confirmWithdrawAction');
  const payload={id,action};
  if(action==='pay'){
    payload.payoutAmount=Number($('payoutAmount').value);
    payload.txHash=$('payoutTxHash').value.trim();
    if(!Number.isFinite(payload.payoutAmount)||payload.payoutAmount<=0){showNotice('Enter a valid coin amount.',true);return;}
    if(payload.txHash.length<20){showNotice('A valid transaction hash is required.',true);return;}
  }else{payload.reason=$('payoutRejectReason').value.trim()||'Rejected by admin';}
  btn.disabled=true;
  try{
    await api('/api/admin/withdrawal',payload);
    showNotice(action==='pay'?'Withdrawal marked paid.':'Withdrawal rejected and USD balance refunded.');
    closeWithdrawalModal();$('withdrawActionForm').reset();await loadOverview();
  }catch(err){showNotice(err.message,true);}
  finally{btn.disabled=false;}
});
$('refreshBtn').addEventListener('click',loadOverview);
loadOverview();

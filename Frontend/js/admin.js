'use strict';
const tg=window.Telegram?.WebApp;
if(tg){tg.ready();tg.expand();}
const $=id=>document.getElementById(id);
const initData=tg?.initData||'';
function showNotice(message,error=false){
  const el=$('notice');if(!el)return;
  el.textContent=String(message||'');el.className='notice'+(error?' error':'');el.hidden=false;
}
function escapeHtml(value){
  return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmt(value){return Number(value||0).toLocaleString('tr-TR',{maximumFractionDigits:4});}
function moneyLabel(value){return '$'+fmt(value);}
async function api(path,payload={}){
  if(!initData)throw new Error('Yönetim panelini Telegram botunun içinden aç.');
  const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...payload,initData})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data.status==='error')throw new Error(data.code||data.message||('HTTP '+response.status));
  return data;
}
async function loadBotControl(){
  const data=await api('/api/admin/bot-control',{action:'status'}),enabled=data.enabled===true;
  $('botControlStatus').textContent=enabled?'Etkin':'Duraklatıldı';
  $('botControlStatus').className='pill '+(enabled?'green':'amber');
}
async function loadTasks(){
  const data=await api('/api/admin/tasks',{action:'list'}),items=data.tasks||[];
  $('taskAdminList').innerHTML=items.length?items.map(task=>{
    const status=task.status||(task.active?'active':'paused');
    const label={draft:'Taslak',active:'Aktif',paused:'Duraklatıldı',completed:'Tamamlandı'}[status]||status;
    const toggle=status==='active'
      ?'<button class="secondary" data-task-status="paused" data-id="'+escapeHtml(task.id)+'">Duraklat</button>'
      :'<button class="secondary" data-task-status="active" data-id="'+escapeHtml(task.id)+'">Aktifleştir</button>';
    const finish=status==='completed'?'':'<button class="secondary" data-task-status="completed" data-id="'+escapeHtml(task.id)+'">Bitir</button>';
    return '<div class="list-item task-admin-item"><div><strong>'+escapeHtml(task.title)+'</strong><small>'+escapeHtml(task.type)+' · '+moneyLabel(task.reward)+' · '+fmt(task.totalParticipants)+' katılım</small></div><div class="task-admin-actions"><span class="pill">'+label+'</span>'+toggle+finish+'</div></div>';
  }).join(''):'<div class="empty">Henüz görev oluşturulmadı.</div>';
}
async function loadClaims(){
  const data=await api('/api/admin/task-claims'),items=data.claims||[];
  $('claimCount').textContent=items.length+' BEKLİYOR';
  $('taskClaims').innerHTML=items.length?items.map(claim=>
    '<div class="list-item"><div><strong>'+escapeHtml(claim.title||claim.taskId)+' · '+moneyLabel(claim.reward)+'</strong>'+
    '<small>Kullanıcı: '+escapeHtml(claim.userId)+' · '+new Date(claim.createdAt||Date.now()).toLocaleString('tr-TR')+'</small>'+
    '<small>Kanıt: '+escapeHtml(claim.proof||'—')+'</small></div><div class="task-admin-actions">'+
    '<button class="pay-btn" data-claim-action="approve" data-task="'+escapeHtml(claim.taskId)+'" data-user="'+escapeHtml(claim.userId)+'" data-claim="'+escapeHtml(claim.id)+'">Onayla</button>'+
    '<button class="reject-btn" data-claim-action="reject" data-task="'+escapeHtml(claim.taskId)+'" data-user="'+escapeHtml(claim.userId)+'" data-claim="'+escapeHtml(claim.id)+'">Reddet</button></div></div>'
  ).join(''):'<div class="empty">Bekleyen kanıt yok.</div>';
}
async function loadProviders(){
  const data=await api('/api/admin/providers'),providers=data.providers||{};
  $('providerStatus').innerHTML=[['Piarflow',providers.piarflow],['FlyerHubs',providers.flyerhubs],['Traffy',providers.traffy]].map(([name,value])=>
    '<div class="list-item"><strong>'+name+'</strong><span class="pill '+(value?.status==='configured'?'green':'amber')+'">'+escapeHtml(value?.status||'bilinmiyor')+'</span></div>'
  ).join('');
}
async function loadAnalytics(){
  const filters={
    days:Number($('analyticsDays').value||30),
    provider:$('analyticsProvider').value,
    taskType:$('analyticsTaskType').value,
    userId:$('analyticsUserId').value.trim()
  };
  const data=await api('/api/admin/analytics',filters),totals=data.totals||{},days=data.days||[];
  $('aNewUsers').textContent=fmt(totals.newUsers);
  $('aActiveUsers').textContent=fmt(totals.activeUsers);
  $('aReferrals').textContent=fmt(totals.referrals);
  $('aTasks').textContent=fmt(totals.taskCompletions);
  $('aAds').textContent=fmt(totals.adRecords);
  $('aRewards').textContent=moneyLabel(totals.rewardUsd);
  const max=Math.max(1,...days.map(day=>Number(day.rewardUsd||0)));
  $('analyticsChart').innerHTML=days.map(day=>
    '<div class="chart-col" title="'+escapeHtml(day.key)+' · '+moneyLabel(day.rewardUsd)+'"><div class="chart-bar" style="height:'+Math.max(2,Number(day.rewardUsd||0)/max*100)+'%"></div><small>'+escapeHtml(day.key.slice(5))+'</small></div>'
  ).join('');
  $('analyticsRows').innerHTML=days.slice().reverse().map(day=>
    '<tr><td>'+escapeHtml(day.key)+'</td><td>'+fmt(day.newUsers)+'</td><td>'+fmt(day.activeUsers)+'</td><td>'+fmt(day.referrals)+'</td><td>'+fmt(day.taskCompletions)+'</td><td>'+fmt(day.adRecords)+'</td><td>'+moneyLabel(day.rewardUsd)+'</td></tr>'
  ).join('');
  window._analyticsExport=days;
}
function exportAnalyticsCsv(){
  const rows=window._analyticsExport||[];
  if(!rows.length){showNotice('Önce istatistikleri yükle.',true);return;}
  const columns=['key','newUsers','activeUsers','referrals','taskCompletions','adRecords','rewardUsd','adCreditUsd'];
  const csv=[columns.join(','),...rows.map(row=>columns.map(key=>'"'+String(row[key]??'').replace(/"/g,'""')+'"').join(','))].join(String.fromCharCode(10));
  const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');
  anchor.href=url;anchor.download='teddygrow-daily-statistics.csv';anchor.click();URL.revokeObjectURL(url);
}
async function loadAudit(){
  const data=await api('/api/admin/audit'),items=data.items||[];
  $('auditList').innerHTML=items.length?items.map(item=>
    '<div class="list-item"><div><strong>'+escapeHtml(item.action)+'</strong><small>Yönetici: '+escapeHtml(item.actorId)+' · Hedef: '+escapeHtml(item.targetId||'—')+'</small></div><small>'+new Date(item.timestamp||Date.now()).toLocaleString('tr-TR')+'</small></div>'
  ).join(''):'<div class="empty">Henüz yönetici işlemi yok.</div>';
}
async function loadOverview(){
  try{
    const data=await api('/api/admin/overview');
    $('adminStatus').textContent='YÖNETİCİ DOĞRULANDI';
    $('statUsers').textContent=fmt(data.stats.users);
    $('statBalance').textContent=moneyLabel(data.stats.totalBalance);
    $('statEarned').textContent=moneyLabel(data.stats.totalEarned);
    $('statMax').textContent=fmt(data.stats.level50);
    $('statReferrals').textContent=fmt(data.stats.referrals);
    $('statActiveBonuses').textContent=fmt(data.stats.activeReferralBonuses);
    $('pendingCount').textContent=fmt(data.stats.pendingWithdrawals)+' BEKLİYOR';
    const settings=data.settings||{};
    for(const [key,value] of Object.entries(settings)){
      const field=$('settingsForm').elements.namedItem(key);
      if(field&&value!==undefined)field.value=value;
    }
    const withdrawals=data.withdrawals||[];
    $('withdrawals').innerHTML=withdrawals.length?withdrawals.map(item=>
      '<div class="list-item withdrawal-item"><div><strong>'+escapeHtml(item.name||item.userId)+' · '+moneyLabel(item.amount)+' · '+escapeHtml(String(item.method||'').toUpperCase())+'</strong>'+
      '<small>'+escapeHtml(item.account||'')+'</small><small>'+new Date(item.requestedAt||Date.now()).toLocaleString('tr-TR')+'</small>'+
      '<div class="withdraw-actions"><button type="button" class="pay-btn" data-withdraw-action="pay" data-id="'+escapeHtml(item.id)+'" data-currency="'+escapeHtml(String(item.method||'').toUpperCase())+'">Ödendi olarak işaretle</button>'+
      '<button type="button" class="reject-btn" data-withdraw-action="reject" data-id="'+escapeHtml(item.id)+'">Reddet ve iade et</button></div></div></div>'
    ).join(''):'<div class="empty">Bekleyen TON / GRAM çekimi yok.</div>';
    const promotions=data.promotions||[];
    $('promotions').innerHTML=promotions.length?promotions.map(item=>
      '<div class="list-item"><div><strong>'+escapeHtml(item.title)+'</strong><small>'+escapeHtml(item.message)+'</small></div><small>'+escapeHtml(item.status||'taslak')+'</small></div>'
    ).join(''):'<div class="empty">Henüz duyuru yok.</div>';
    const panels=await Promise.allSettled([loadTasks(),loadClaims(),loadProviders(),loadAnalytics(),loadBotControl(),loadAudit()]);
    if(panels.some(result=>result.status==='rejected'))showNotice('Bazı paneller yüklenemedi. Yenile düğmesini kullan.',true);
    else showNotice('Yönetim paneli güncellendi.');
  }catch(error){
    $('adminStatus').textContent='ERİŞİM YOK';showNotice(error.message,true);
  }
}
$('promoForm').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget,button=form.querySelector('button');button.disabled=true;
  try{
    const values=Object.fromEntries(new FormData(form).entries());
    await api('/api/admin/promo',values);showNotice('Duyuru Telegram kanalına gönderildi.');form.reset();await loadOverview();
  }catch(error){showNotice(error.message,true);}finally{button.disabled=false;}
});
$('settingsForm').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget,button=form.querySelector('button');button.disabled=true;
  const values=Object.fromEntries([...new FormData(form).entries()].map(([key,value])=>[key,Number(value)]));
  try{await api('/api/admin/settings',values);showNotice('Ekonomi ve XP ayarları kaydedildi.');}
  catch(error){showNotice(error.message,true);}finally{button.disabled=false;}
});
$('withdrawals').addEventListener('click',event=>{
  const button=event.target.closest('[data-withdraw-action]');if(!button)return;
  const action=button.dataset.withdrawAction;
  $('withdrawActionId').value=button.dataset.id;
  $('withdrawAction').value=action;
  const currency=button.dataset.currency||'TON';
  $('withdrawModalTitle').textContent=action==='pay'?currency+' ödemesini tamamla':'Çekim talebini reddet';
  $('withdrawModalSummary').textContent=action==='pay'?'Gönderdiğin gerçek coin miktarını ve doğrulanmış işlem hash’ini gir.':'Talep reddedilecek ve USD bakiyesi kullanıcıya iade edilecek.';
  $('payoutFields').hidden=action!=='pay';$('rejectFields').hidden=action!=='reject';
  $('confirmWithdrawAction').textContent=action==='pay'?'Ödendi olarak işaretle':'Reddet ve iade et';
  $('withdrawModal').hidden=false;
});
function closeWithdrawalModal(){$('withdrawModal').hidden=true;}
$('closeWithdrawModal').addEventListener('click',closeWithdrawalModal);
$('cancelWithdrawModal').addEventListener('click',closeWithdrawalModal);
$('withdrawModal').addEventListener('click',event=>{if(event.target.id==='withdrawModal')closeWithdrawalModal();});
$('withdrawActionForm').addEventListener('submit',async event=>{
  event.preventDefault();const action=$('withdrawAction').value,button=$('confirmWithdrawAction');
  const payload={id:$('withdrawActionId').value,action};
  if(action==='pay'){
    payload.payoutAmount=Number($('payoutAmount').value);payload.txHash=$('payoutTxHash').value.trim();
    if(!Number.isFinite(payload.payoutAmount)||payload.payoutAmount<=0){showNotice('Geçerli coin miktarı gir.',true);return;}
    if(payload.txHash.length<20){showNotice('Geçerli işlem hash’i gerekli.',true);return;}
  }else payload.reason=$('payoutRejectReason').value.trim()||'Yönetici tarafından reddedildi';
  button.disabled=true;
  try{
    await api('/api/admin/withdrawal',payload);
    showNotice(action==='pay'?'Çekim ödendi olarak kaydedildi.':'Çekim reddedildi ve bakiye iade edildi.');
    closeWithdrawalModal();$('withdrawActionForm').reset();await loadOverview();
  }catch(error){showNotice(error.message,true);}finally{button.disabled=false;}
});
$('taskForm').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget,button=form.querySelector('button[type="submit"]');
  const values=Object.fromEntries(new FormData(form).entries());
  values.reward=Number(values.reward);values.totalLimit=Number(values.totalLimit);values.perUserLimit=Number(values.perUserLimit);
  values.startAt=values.startAt?new Date(values.startAt).toISOString():new Date().toISOString();
  values.endAt=values.endAt?new Date(values.endAt).toISOString():'';
  button.disabled=true;
  try{
    await api('/api/admin/tasks',{...values,action:'create'});
    form.reset();form.elements.namedItem('reward').value='0.002';form.elements.namedItem('perUserLimit').value='1';
    showNotice('Görev oluşturuldu.');await loadTasks();
  }catch(error){showNotice(error.message,true);}finally{button.disabled=false;}
});
$('taskForm').elements.namedItem('type').addEventListener('change',event=>{
  $('taskForm').elements.namedItem('verificationMethod').value=['channel','group'].includes(event.target.value)?'telegram_membership':'manual';
});
$('taskAdminList').addEventListener('click',async event=>{
  const button=event.target.closest('[data-task-status]');if(!button)return;button.disabled=true;
  try{await api('/api/admin/tasks',{action:'status',id:button.dataset.id,status:button.dataset.taskStatus});await loadTasks();showNotice('Görev durumu güncellendi.');}
  catch(error){showNotice(error.message,true);}finally{button.disabled=false;}
});
$('taskClaims').addEventListener('click',async event=>{
  const button=event.target.closest('[data-claim-action]');if(!button)return;button.disabled=true;
  try{
    await api('/api/admin/task-review',{taskId:button.dataset.task,userId:button.dataset.user,claimId:button.dataset.claim,decision:button.dataset.claimAction});
    await Promise.all([loadClaims(),loadAudit()]);showNotice('Görev kanıtı işlendi.');
  }catch(error){showNotice(error.message,true);}finally{button.disabled=false;}
});
$('refreshTasksBtn').addEventListener('click',async()=>{try{await Promise.all([loadTasks(),loadClaims()]);}catch(error){showNotice(error.message,true);}});
$('analyticsApply').addEventListener('click',()=>loadAnalytics().catch(error=>showNotice(error.message,true)));
$('analyticsCsv').addEventListener('click',exportAnalyticsCsv);
$('refreshAuditBtn').addEventListener('click',()=>loadAudit().catch(error=>showNotice(error.message,true)));
$('botStartBtn').addEventListener('click',async()=>{try{await api('/api/admin/bot-control',{enabled:true});await loadBotControl();showNotice('Bot etkinleştirildi.');}catch(error){showNotice(error.message,true);}});
$('botStopBtn').addEventListener('click',async()=>{try{await api('/api/admin/bot-control',{enabled:false});await loadBotControl();showNotice('Bot duraklatıldı.');}catch(error){showNotice(error.message,true);}});
$('refreshBtn').addEventListener('click',loadOverview);
loadOverview();

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
async function loadOverview(){
  try{
    const d=await api('/api/admin/overview');
    $('adminStatus').textContent='ADMIN VERIFIED';
    $('statUsers').textContent=fmt(d.stats.users);
    $('statBalance').textContent='$'+fmt(d.stats.totalBalance);
    $('statEarned').textContent='$'+fmt(d.stats.totalEarned);
    $('statMax').textContent=fmt(d.stats.level100);
    $('pendingCount').textContent=fmt(d.stats.pendingWithdrawals)+' PENDING';
    const settings=d.settings||{};
    for(const [key,value] of Object.entries(settings)){const field=$('settingsForm').elements.namedItem(key);if(field&&value!==undefined)field.value=value;}
    $('withdrawals').innerHTML=d.withdrawals.length?d.withdrawals.map(w=>'<div class="list-item"><div><strong>'+escapeHtml(w.name||w.userId)+' · $'+fmt(w.amount)+'</strong><small>'+escapeHtml(w.methodName||w.method)+' · '+escapeHtml(w.account||'')+'</small></div><small>'+new Date(w.requestedAt||Date.now()).toLocaleString()+'</small></div>').join(''):'<div class="empty">No pending withdrawals.</div>';
    $('promotions').innerHTML=d.promotions.length?d.promotions.map(p=>'<div class="list-item"><div><strong>'+escapeHtml(p.title)+'</strong><small>'+escapeHtml(p.message)+'</small></div><small>'+escapeHtml(p.status||'draft')+'</small></div>').join(''):'<div class="empty">No promotions yet.</div>';
    showNotice('Dashboard data refreshed.');
  }catch(e){$('adminStatus').textContent='ACCESS DENIED';showNotice(e.message,true);}
}
$('promoForm').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.currentTarget,btn=form.querySelector('button');btn.disabled=true;
  try{const d=await api('/api/admin/promo',Object.fromEntries(new FormData(form).entries()));showNotice('Promotion published to Telegram channel.');form.reset();await loadOverview();}
  catch(err){showNotice(err.message,true);}finally{btn.disabled=false;}
});
$('settingsForm').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.currentTarget,btn=form.querySelector('button');
  const values=Object.fromEntries([...new FormData(form).entries()].map(([k,v])=>[k,Number(v)]));btn.disabled=true;
  try{await api('/api/admin/settings',values);showNotice('Economy and XP settings saved.');}
  catch(err){showNotice(err.message,true);}finally{btn.disabled=false;}
});
$('refreshBtn').addEventListener('click',loadOverview);
loadOverview();

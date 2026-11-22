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
        '</small><div class="withdraw-actions"><button type="button" class="pay-btn" data-withdraw-action="pay" data-id="'+escapeHtml(w.id)+'">Mark paid</button>'+
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

const API = '';
let state = { user: null, balance: 0, lastClaim: 0, initData: '', tgUser: null, timer: null, settings: {} };

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

function toast(msg, type) {
  const box = $('#toastBox');
  const el = document.createElement('div');
  el.className = 'toast toast-' + (type || 'info');
  const icons = { ok: '✅', err: '❌', info: 'ℹ️' };
  el.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${msg}</span>`;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(20px)'; setTimeout(() => el.remove(), 300); }, 3000);
}

function hideLoading() {
  const el = $('#loading');
  if (el) { el.style.opacity = '0'; setTimeout(() => el.style.display = 'none', 300); }
}

async function api(action, method, body) {
  const opts = {
    method: method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-InitData': state.initData }
  };
  if (body) opts.body = JSON.stringify({ ...body, initData: state.initData });
  try {
    const r = await fetch(`${API}/api/${action}`, opts);
    return await r.json();
  } catch (e) { toast('Network error', 'err'); return { success: false }; }
}

function initTG() {
  if (window.Telegram && Telegram.WebApp) {
    const tw = Telegram.WebApp;
    tw.ready(); tw.expand();
    tw.setHeaderColor('#1976d2');
    state.initData = tw.initData || '';
    state.tgUser = tw.initDataUnsafe?.user || null;
  }
  if (!state.tgUser) {
    const id = 'test_' + Math.floor(Math.random() * 1000000);
    state.tgUser = { id, first_name: 'Test', username: 'test', photo_url: '' };
    state.initData = 'user=' + encodeURIComponent(JSON.stringify(state.tgUser)) + '&hash=test';
  }
  updateProfile();
}

function updateProfile() {
  const u = state.tgUser;
  if (!u) return;
  const img = $('#profImg');
  const ph = $('#profPlaceholder');
  if (u.photo_url) { img.src = u.photo_url; img.style.display = 'block'; ph.style.display = 'none'; }
  else { img.style.display = 'none'; ph.style.display = 'flex'; ph.textContent = (u.first_name?.[0] || 'U').toUpperCase(); }
  $('#userName').textContent = u.first_name || 'User';
}

async function auth() {
  const ref = new URLSearchParams(location.search).get('ref');
  const r = await api('auth', 'POST', { ref });
  if (r.success && r.user) {
    state.user = r.user;
    state.balance = r.user.balance;
    state.lastClaim = r.user.last_claim;
    updateBal();
    updateStats();
    if (r.user.referral_code) $('#refCode').textContent = r.user.referral_code;
    state.referralLink = r.referral_link;
  }
}

async function loadUser() {
  const r = await api('user', 'GET');
  if (r.success && r.user) {
    state.user = r.user;
    state.balance = r.user.balance;
    state.lastClaim = r.user.last_claim;
    updateBal();
    updateStats();
    $('#refCount').textContent = r.referrals_count || 0;
    $('#refEarn').textContent = r.referral_earnings || 0;
    if (r.referral_link) state.referralLink = r.referral_link;
  }
}

function updateBal() {
  const b = state.balance || 0;
  $('#balDisplay').textContent = b.toLocaleString();
  $('#wdBal').textContent = b.toLocaleString() + ' CNX';
}

function updateStats() {
  if (!state.user) return;
  $('#stEarned').textContent = (state.user.total_earned || 0).toLocaleString();
  $('#stWithdrawn').textContent = (state.user.total_withdrawn || 0).toLocaleString();
}

function switchTab(name) {
  $$('.tab-content').forEach(t => t.classList.remove('active'));
  $$('.tab-btn').forEach(b => b.classList.remove('active'));
  $(`#tab-${name}`)?.classList.add('active');
  event.target.classList.add('active');
  if (name === 'tasks') loadTasks();
  if (name === 'withdraw') loadWDs();
  if (name === 'faucet') loadLB();
}

function updateTimer() {
  const now = Math.floor(Date.now() / 1000);
  const rem = Math.max(0, 10 - (now - state.lastClaim));
  const ready = $('#faucetReady');
  const wait = $('#faucetWait');
  const timer = $('#timerDisplay');
  if (rem <= 0) { ready.style.display = 'block'; wait.style.display = 'none'; if (state.timer) { clearInterval(state.timer); state.timer = null; } }
  else { ready.style.display = 'none'; wait.style.display = 'block'; timer.textContent = `00:${rem.toString().padStart(2,'0')}`; }
}

function startTimer() {
  if (state.timer) clearInterval(state.timer);
  updateTimer();
  state.timer = setInterval(updateTimer, 1000);
}

async function doClaim() {
  if (state.claiming) return;
  state.claiming = true;
  $('#claimBtn').disabled = true;
  $('#claimBtn').textContent = '⏳ Processing...';
  const r = await api('claim', 'POST');
  if (r.success) {
    state.balance = r.balance;
    state.lastClaim = Math.floor(Date.now() / 1000);
    updateBal();
    startTimer();
    showReward(r.reward);
    toast(`+${r.reward} CNX claimed!`, 'ok');
  } else {
    toast(r.error || 'Claim failed', 'err');
  }
  $('#claimBtn').textContent = '💧 CLAIM NOW';
  $('#claimBtn').disabled = false;
  state.claiming = false;
}

function showReward(amt) {
  const p = $('#rewardPopup');
  $('#rewardAmt').textContent = amt;
  p.classList.remove('show');
  void p.offsetWidth;
  p.classList.add('show');
  setTimeout(() => p.classList.remove('show'), 1200);
}

async function loadTasks() {
  const r = await api('tasks', 'GET');
  const list = $('#taskList');
  if (!r.success || !r.tasks) { list.innerHTML = '<div class="empty">Failed</div>'; return; }
  list.innerHTML = r.tasks.map(t => `
    <div class="list-item" onclick="completeTask('${t.id}', ${t.reward}, '${t.type}')">
      <div class="list-icon">${t.icon}</div>
      <div class="list-info"><div class="list-title">${t.title}</div><div class="list-sub">${t.type}</div></div>
      <div class="list-reward">+${t.reward}</div>
    </div>
  `).join('');
}

async function completeTask(id, reward, type) {
  if (type === 'offerwall') { toast('Use offerwall below!', 'info'); return; }
  const r = await api('task-complete', 'POST', { task_id: id, reward });
  if (r.success) { state.balance = r.balance; updateBal(); toast(`+${reward} CNX!`, 'ok'); loadTasks(); }
  else toast(r.error || 'Failed', 'err');
}

async function doWithdraw(e) {
  e.preventDefault();
  const amt = parseInt($('#wdAmount').value);
  const addr = $('#wdAddress').value.trim();
  const method = $('#wdMethod').value;
  if (amt < 500) { toast('Min 500 CNX', 'err'); return; }
  if (state.balance < amt) { toast('Insufficient balance', 'err'); return; }
  if (!addr) { toast('Enter address', 'err'); return; }
  const r = await api('withdraw', 'POST', { amount: amt, address: addr, method });
  if (r.success) { state.balance = r.balance; updateBal(); $('#wdForm').reset(); toast('Withdrawal submitted!', 'ok'); loadWDs(); }
  else toast(r.error || 'Failed', 'err');
}

async function loadWDs() {
  const r = await api('withdrawals', 'GET');
  const el = $('#wdHistory');
  if (!r.success || !r.withdrawals?.length) { el.innerHTML = '<div class="empty">No withdrawals yet</div>'; return; }
  el.innerHTML = r.withdrawals.map(w => {
    const d = new Date(w.created_at * 1000).toLocaleDateString();
    const st = w.status === 'approved' ? 'st-approved' : w.status === 'rejected' ? 'st-rejected' : 'st-pending';
    return `<div class="hist-item"><div><div style="font-weight:700">${w.amount} CNX</div><div style="font-size:12px;color:#888">${d} • ${w.method}</div></div><span class="hist-status ${st}">${w.status}</span></div>`;
  }).join('');
}

async function calcSwap() {
  const amt = parseFloat($('#swapFrom').value) || 0;
  $('#swapTo').value = (amt * 0.001).toFixed(6);
}

async function doSwap() {
  const amt = parseInt($('#swapFrom').value);
  if (!amt || amt <= 0) { toast('Enter amount', 'err'); return; }
  if (state.balance < amt) { toast('Insufficient CNX', 'err'); return; }
  const r = await api('swap', 'POST', { amount: amt, direction: 'cnx_to_usdt' });
  if (r.success) { state.balance = r.balance; updateBal(); $('#swapFrom').value = ''; $('#swapTo').value = ''; toast(`Swapped! Got ${r.received} USDT`, 'ok'); }
  else toast(r.error || 'Failed', 'err');
}

function copyRef() {
  if (!state.referralLink) state.referralLink = `https://t.me/YOUR_BOT?start=${state.user?.referral_code || ''}`;
  if (state.referralLink) navigator.clipboard.writeText(state.referralLink).then(() => toast('Copied!', 'ok')).catch(() => toast('Failed to copy', 'err'));
}

async function loadLB() {
  const r = await api('leaderboard', 'GET');
  const el = $('#lbList');
  if (!r.success || !r.leaderboard?.length) { el.innerHTML = '<div class="empty">No data</div>'; return; }
  el.innerHTML = r.leaderboard.map((u, i) => {
    const rank = i + 1;
    const color = rank === 1 ? '#FFD700' : rank === 2 ? '#C0C0C0' : rank === 3 ? '#CD7F32' : '#888';
    return `<div class="list-item" style="cursor:default"><div class="list-icon" style="color:${color};font-weight:800">#${rank}</div><div class="list-info"><div class="list-title">${u.username}</div></div><div class="list-reward">${u.total_earned} CNX</div></div>`;
  }).join('');
}

async function loadStats() {
  const r = await api('stats', 'GET');
  if (r.success) {
    $('#stEarned').textContent = (r.total_claims || 0).toLocaleString();
  }
}

async function init() {
  initTG();
  await auth();
  await loadUser();
  if (state.lastClaim > 0) startTimer();
  loadLB();
  hideLoading();
  setTimeout(() => toast('Welcome to CoinixFaucet! 🪙', 'ok'), 500);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

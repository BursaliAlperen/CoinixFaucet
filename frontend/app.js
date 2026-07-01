import { auth, db, COL, COINS, COIN_META, RECAPTCHA_SITE_KEY } from './firebase-config.js';
import {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, sendEmailVerification, sendPasswordResetEmail, reload
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, collection, addDoc, query, where,
  limit, getDocs, onSnapshot, serverTimestamp,
  increment
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

console.log('||| ========== APP START ========== |||');

const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];
const fmt = (n, d = 4) => Number(n || 0).toFixed(d);
const fmtUSD = n => '$' + Number(n || 0).toFixed(4);
const uid = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const now = () => Date.now();
const escapeHtml = s => String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

// ============ DARK MODE ============
function getDarkMode() { return localStorage.getItem('darkMode') === 'true'; }
function setDarkMode(isDark) {
  localStorage.setItem('darkMode', isDark);
  document.documentElement.classList.toggle('dark', isDark);
  updateDarkModeIcons();
}
function toggleDarkMode() { setDarkMode(!getDarkMode()); }
function updateDarkModeIcons() {
  const isDark = getDarkMode();
  document.querySelectorAll('.dark-mode-icon').forEach(el => {
    if (el) el.innerHTML = isDark ? '<i data-lucide="moon" class="w-5 h-5"></i>' : '<i data-lucide="sun" class="w-5 h-5"></i>';
  });
  if (typeof lucide !== 'undefined') lucide.createIcons();
}
if (getDarkMode()) document.documentElement.classList.add('dark');

// ============ TOAST ============
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<div class="flex-1 text-sm">${msg}</div>`;
  const root = $('#toastRoot');
  if (root) { root.appendChild(el); setTimeout(() => el.remove(), 3500); }
}

// ============ API ============
async function apiCall(endpoint, options = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not authenticated');
  const token = await user.getIdToken();
  const res = await fetch(endpoint, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...options.headers }
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.message);
  return data;
}

const state = { user: null, profile: null };

// ============ LANDING ============
function initLanding() {
  document.querySelectorAll('#darkModeToggle, #darkModeToggle2').forEach(btn => {
    if (btn) btn.addEventListener('click', toggleDarkMode);
  });
  setTimeout(updateDarkModeIcons, 100);
  
  $$('.open-auth-btn, #openLoginBtn, #openSignupBtn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode || (btn.id === 'openSignupBtn' ? 'register' : 'login');
      openAuthModal(mode);
    });
  });
  renderLandingCoins();
  loadLiveStats();
  loadLiveWithdraws();
  setInterval(loadLiveWithdraws, 10000);
  setInterval(loadLiveStats, 30000);
}

function renderLandingCoins() {
  const grid = $('#landingCoinsGrid');
  if (!grid) return;
  grid.innerHTML = '';
  COINS.forEach(coin => {
    const m = COIN_META[coin];
    const card = document.createElement('div');
    card.className = 'coin-landing-card';
    card.style.setProperty('--coin-color', m.color + '40');
    card.innerHTML = `
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-3">
          <div class="w-14 h-14 rounded-full flex items-center justify-center" style="background:${m.color}20;border:2px solid ${m.color}40">
            <div style="font-size:24px;font-weight:900;color:${m.color}">${coin[0]}</div>
          </div>
          <div><div class="font-bold text-lg">${m.name}</div><div class="text-xs text-zinc-500">${coin}</div></div>
        </div>
        <span class="badge badge-green"><span class="w-1.5 h-1.5 rounded-full bg-green-400"></span>Active</span>
      </div>
      <div class="space-y-2 text-sm">
        <div class="flex justify-between"><span class="text-zinc-500">Min Withdraw</span><span class="font-medium">$0.03</span></div>
        <div class="flex justify-between"><span class="text-zinc-500">Payout</span><span class="text-green-400 font-medium">Instant · FaucetPay</span></div>
      </div>`;
    grid.appendChild(card);
  });
}

async function loadLiveStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    if (data.success) {
      const s = data.stats;
      if ($('#statUsers')) $('#statUsers').textContent = (s.totalUsers || 0).toLocaleString();
      if ($('#statClaims')) $('#statClaims').textContent = (s.totalClaims || 0).toLocaleString();
      if ($('#statPaid')) $('#statPaid').textContent = fmtUSD(s.totalPaid || 0);
      if ($('#statAvg')) $('#statAvg').textContent = fmtUSD(s.totalClaims > 0 ? (s.totalPaid / s.totalClaims) : 0);
      if ($('#statRef')) $('#statRef').textContent = fmtUSD((s.totalPaid || 0) * 0.2);
      if ($('#heroOnline')) $('#heroOnline').textContent = (Math.min(s.totalUsers || 0, Math.floor((s.totalUsers || 0) * 0.15) + 50)).toLocaleString();
    }
  } catch (e) { console.error('Stats error:', e); }
}

async function loadLiveWithdraws() {
  const table = $('#withdrawsBody');
  if (!table) return;
  try {
    const res = await fetch('/api/live-withdraws');
    const data = await res.json();
    table.innerHTML = '';
    if (!data.success || !data.withdrawals.length) {
      table.innerHTML = '<tr><td colspan="6" class="p-8 text-center text-zinc-500">No withdrawals yet</td></tr>';
      return;
    }
    data.withdrawals.forEach(t => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="p-3"><div class="flex items-center gap-2"><div class="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-cyan-500 flex items-center justify-center text-xs font-bold">${(t.username || 'U')[0].toUpperCase()}</div><span class="font-medium text-sm">${escapeHtml(t.username || 'User')}</span></div></td>
        <td class="p-3"><span class="text-sm font-medium">${t.coin}</span></td>
        <td class="p-3 font-mono text-sm text-green-400">${fmt(t.amount)}</td>
        <td class="p-3 text-sm text-zinc-400">${fmtUSD(t.usdValue)}</td>
        <td class="p-3 text-xs text-zinc-500">${new Date(t.createdAt).toLocaleTimeString()}</td>
        <td class="p-3"><span class="badge badge-green">Completed</span></td>`;
      table.appendChild(row);
    });
  } catch (e) { console.error('Withdraws error:', e); }
}

// ============ AUTH ============
let authMode = 'login';
let recaptchaToken = null;

function openAuthModal(mode = 'login') {
  authMode = mode;
  updateAuthModalUI();
  const modal = $('#authModal');
  if (modal) modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeAuthModal() {
  const modal = $('#authModal');
  if (modal) modal.classList.add('hidden');
  document.body.style.overflow = '';
}

function updateAuthModalUI() {
  $$('[data-auth-tab]').forEach(b => b.classList.toggle('active', b.dataset.authTab === authMode));
  if ($('#usernameField')) $('#usernameField').classList.toggle('hidden', authMode !== 'register');
  if ($('#referralField')) $('#referralField').classList.toggle('hidden', authMode !== 'register');
  if ($('#authBtnText')) $('#authBtnText').textContent = authMode === 'login' ? 'Sign In' : 'Create Account';
  if ($('#authModalTitle')) $('#authModalTitle').textContent = authMode === 'login' ? 'Welcome Back' : 'Create Account';
}

$('#closeAuthModal')?.addEventListener('click', closeAuthModal);
document.querySelector('.auth-modal-backdrop')?.addEventListener('click', closeAuthModal);
$$('[data-auth-tab]').forEach(btn => btn.addEventListener('click', () => { authMode = btn.dataset.authTab; updateAuthModalUI(); }));

$('#authForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const email = fd.get('email').trim().toLowerCase();
  const password = fd.get('password');
  const btn = $('#authSubmit');
  if (btn) btn.disabled = true;

  try {
    if (authMode === 'login') {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      await reload(cred.user);
      toast('Welcome back!', 'success');
      closeAuthModal();
    } else {
      const username = fd.get('username').trim();
      const referral = fd.get('referral').trim().toUpperCase();
      if (username.length < 3) throw new Error('Username 3+ chars');
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await sendEmailVerification(cred.user);
      const refCode = uid();
      const profile = {
        uid: cred.user.uid, username, email,
        country: 'Unknown', timezone: 'UTC', faucetpayEmail: '',
        referralCode: refCode, referredBy: referral || null,
        balances: Object.fromEntries(COINS.map(c => [c, 0])),
        totalWithdrawn: 0, referralEarnings: 0, referralCount: 0,
        totalClaims: 0, lastClaimAt: 0,
        lastDailyBonus: 0, dailyStreak: 0, highestStreak: 0,
        isAdmin: false,
        createdAt: serverTimestamp()
      };
      await setDoc(doc(db, COL.users, cred.user.uid), profile);
      toast('Account created! Check email.', 'success');
      closeAuthModal();
      await signOut(auth);
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ============ AUTH STATE ============
onAuthStateChanged(auth, async user => {
  if (user) {
    state.user = user;
    await reload(user);
    const snap = await getDoc(doc(db, COL.users, user.uid));
    if (!snap.exists()) { await signOut(auth); return; }
    state.profile = snap.data();
    state.unsubProfile?.();
    state.unsubProfile = onSnapshot(doc(db, COL.users, user.uid), s => {
      if (s.exists()) { state.profile = s.data(); updateTopBar(); }
    });
    if ($('#landingPage')) $('#landingPage').classList.add('hidden');
    if ($('#appShell')) $('#appShell').classList.remove('hidden');
    if (typeof lucide !== 'undefined') lucide.createIcons();
    router.init();
  } else {
    state.user = null; state.profile = null; state.unsubProfile?.();
    if ($('#landingPage')) $('#landingPage').classList.remove('hidden');
    if ($('#appShell')) $('#appShell').classList.add('hidden');
  }
});

function updateTopBar() {
  if (!state.profile) return;
  const total = COINS.reduce((s, c) => s + (state.profile.balances[c] || 0) * (COIN_META[c].usd || 0), 0);
  if ($('#topBalance')) $('#topBalance').textContent = fmtUSD(total);
  if ($('#profileName')) $('#profileName').textContent = state.profile.username;
  if ($('#profileAvatar')) $('#profileAvatar').textContent = state.profile.username[0].toUpperCase();
  
  const loginBtn = $('#openLoginBtn');
  const signupBtn = $('#openSignupBtn');
  if (loginBtn) { loginBtn.textContent = 'Dashboard'; loginBtn.className = 'btn-primary text-sm'; loginBtn.onclick = () => router.go('#/dashboard'); }
  if (signupBtn) { signupBtn.textContent = 'Logout'; signupBtn.className = 'btn-ghost text-sm'; signupBtn.onclick = async () => { await signOut(auth); toast('Logged out', 'info'); }; }
}

$('#logoutBtn')?.addEventListener('click', async () => { await signOut(auth); toast('Signed out', 'info'); });

// ============ ROUTER ============
const router = {
  routes: {
    dashboard: renderDashboard,
    faucet: renderFaucet,
    'daily-bonus': renderDailyBonus,
    leaderboard: renderLeaderboard,
    ptc: renderPtc,          // YENİ PTC SAYFASI
    referrals: renderReferrals,
    withdraw: renderWithdraw,
    transactions: renderTransactions,
    settings: renderSettings
  },
  init() {
    window.addEventListener('hashchange', () => this.navigate());
    $('#menuToggle')?.addEventListener('click', () => $('#sidebar')?.classList.toggle('open'));
    if (!location.hash.startsWith('#/')) location.hash = '#/dashboard';
    else this.navigate();
  },
  go(h) { location.hash = h; },
  navigate() {
    const route = location.hash.replace('#/', '') || 'dashboard';
    const fn = this.routes[route];
    if (!fn) { this.go('#/dashboard'); return; }
    $$('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.route === route));
    const c = $('#pageContainer');
    if (c) {
      c.innerHTML = '';
      const tpl = $(`#tpl-${route}`);
      if (tpl) c.appendChild(tpl.content.cloneNode(true));
    }
    if (typeof lucide !== 'undefined') lucide.createIcons();
    fn();
  }
};
window.router = router;

// ============ PAGES ============
async function renderDashboard() {
  if (!state.profile) return;
  try {
    const data = await apiCall('/api/dashboard');
    const s = data.stats;
    const c = $('#pageContainer');
    if (!c) return;
    c.innerHTML = `
      <div class="space-y-6">
        <div class="relative overflow-hidden rounded-3xl p-8 gradient-border">
          <div class="absolute inset-0 bg-gradient-to-br from-purple-600/20 to-cyan-500/20"></div>
          <div class="relative">
            <p class="text-sm text-zinc-400 mb-1">Welcome back,</p>
            <h1 class="text-3xl sm:text-4xl font-bold mb-6">${escapeHtml(state.profile.username)}</h1>
            <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div class="stat-card"><div class="stat-label">Main Balance</div><div class="stat-value">${fmtUSD(s.totalBalanceUSD)}</div></div>
              <div class="stat-card"><div class="stat-label">Today</div><div class="stat-value text-green-400">${fmtUSD(s.todayEarnings)}</div></div>
              <div class="stat-card"><div class="stat-label">Referral</div><div class="stat-value text-purple-400">${fmtUSD(s.referralEarnings)}</div></div>
              <div class="stat-card"><div class="stat-label">Withdrawn</div><div class="stat-value text-cyan-400">${fmtUSD(s.totalWithdrawn)}</div></div>
            </div>
            <div class="mt-6 flex flex-wrap gap-3">
              <button onclick="router.go('#/faucet')" class="btn-primary"><i data-lucide="droplets" class="w-4 h-4"></i>Claim Now</button>
              <button onclick="router.go('#/withdraw')" class="btn-ghost"><i data-lucide="wallet" class="w-4 h-4"></i>Withdraw</button>
            </div>
          </div>
        </div>
      </div>`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
  } catch (e) { toast(e.message, 'error'); }
}

let faucetInterval = null;
function renderFaucet() {
  $('#claimBtn')?.addEventListener('click', handleClaim);
  startCountdown();
}

function startCountdown() {
  clearInterval(faucetInterval);
  const btn = $('#claimBtn');
  const cd = $('#faucetCountdown');
  if (!btn || !cd || !state.profile) return;
  const tick = () => {
    const remain = Math.max(0, 60000 - (now() - (state.profile.lastClaimAt || 0)));
    if (remain <= 0) { cd.textContent = '00:00'; btn.disabled = false; }
    else { const m = Math.floor(remain / 60000), s = Math.floor((remain % 60000) / 1000); cd.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`; btn.disabled = true; }
  };
  tick();
  faucetInterval = setInterval(tick, 1000);
}

async function handleClaim() {
  const btn = $('#claimBtn');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  try {
    let token = null;
    if (typeof grecaptcha !== 'undefined') {
      try { token = await grecaptcha.enterprise.execute(RECAPTCHA_SITE_KEY, { action: 'claim' }); } catch(e) {}
    }
    const data = await apiCall('/api/claim', { method: 'POST', body: JSON.stringify({ recaptchaToken: token }) });
    toast(`Claimed ${fmt(data.amount)} ${data.coin}!`, 'success');
    startCountdown();
  } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
}

function renderDailyBonus() {
  const p = state.profile;
  const c = $('#pageContainer');
  if (!c) return;
  c.innerHTML = `
    <div class="space-y-6">
      <div class="glass-card p-8 rounded-3xl gradient-border text-center">
        <h1 class="text-3xl font-bold mb-4">Daily Bonus</h1>
        <div class="text-6xl font-black bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent mb-2">${p.dailyStreak || 0}</div>
        <div class="text-zinc-400 mb-6">Day Streak · Best: ${p.highestStreak || 0}</div>
        <button id="claimBonusBtn" class="btn-primary">🎁 Claim Daily Bonus</button>
      </div>
    </div>`;
  $('#claimBonusBtn')?.addEventListener('click', async () => {
    try { const data = await apiCall('/api/daily-bonus', { method: 'POST' }); toast(`Day ${data.day} bonus: ${fmtUSD(data.reward)}`, 'success'); renderDailyBonus(); } catch (e) { toast(e.message, 'error'); }
  });
}

async function renderLeaderboard() {
  try {
    const res = await fetch('/api/leaderboard');
    const data = await res.json();
    const c = $('#pageContainer');
    if (!c || !data.success) return;
    c.innerHTML = `<div class="space-y-6"><h1 class="text-3xl font-bold">Leaderboard</h1><div class="glass-card rounded-3xl overflow-hidden divide-y divide-white/5">${data.leaderboard.map(u => `
      <div class="flex items-center justify-between p-4">
        <div class="flex items-center gap-4">
          <div class="w-10 font-bold text-zinc-500 text-center">#${u.rank}</div>
          <div class="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-cyan-500 flex items-center justify-center font-bold">${u.username[0].toUpperCase()}</div>
          <div><div class="font-medium">${escapeHtml(u.username)}</div><div class="text-xs text-zinc-500">${u.country || 'Unknown'}</div></div>
        </div>
        <div class="text-right"><div class="font-bold">${u.totalClaims} claims</div><div class="text-xs text-zinc-500">${fmtUSD(u.totalWithdrawn)}</div></div>
      </div>`).join('')}</div></div>`;
  } catch (e) { toast('Error loading', 'error'); }
}

// ============ PTC SAYFASI (YENİ) ============
function renderPtc() {
  const c = $('#pageContainer');
  if (!c) return;
  c.innerHTML = `
    <div class="space-y-6">
      <div class="glass-card p-8 rounded-3xl gradient-border">
        <h1 class="text-3xl font-bold mb-4">💰 PTC Ads</h1>
        <p class="text-zinc-400 mb-6">Click on ads and earn free CNX coins instantly.</p>
        <div class="grid sm:grid-cols-2 gap-4">
          <div class="p-6 rounded-2xl bg-white/5 border border-white/10 hover:border-yellow-500/50 transition cursor-pointer" onclick="toast('Ad clicked! +0.5 CNX', 'success')">
            <div class="flex items-center gap-4">
              <div class="w-12 h-12 rounded-full bg-yellow-500/20 flex items-center justify-center text-2xl">📢</div>
              <div><div class="font-bold">Ad #1</div><div class="text-sm text-zinc-400">Earn 0.5 CNX</div></div>
            </div>
          </div>
          <div class="p-6 rounded-2xl bg-white/5 border border-white/10 hover:border-yellow-500/50 transition cursor-pointer" onclick="toast('Ad clicked! +0.3 CNX', 'success')">
            <div class="flex items-center gap-4">
              <div class="w-12 h-12 rounded-full bg-blue-500/20 flex items-center justify-center text-2xl">🎯</div>
              <div><div class="font-bold">Ad #2</div><div class="text-sm text-zinc-400">Earn 0.3 CNX</div></div>
            </div>
          </div>
          <div class="p-6 rounded-2xl bg-white/5 border border-white/10 hover:border-yellow-500/50 transition cursor-pointer" onclick="toast('Ad clicked! +0.7 CNX', 'success')">
            <div class="flex items-center gap-4">
              <div class="w-12 h-12 rounded-full bg-purple-500/20 flex items-center justify-center text-2xl">🔥</div>
              <div><div class="font-bold">Ad #3</div><div class="text-sm text-zinc-400">Earn 0.7 CNX</div></div>
            </div>
          </div>
          <div class="p-6 rounded-2xl bg-white/5 border border-white/10 hover:border-yellow-500/50 transition cursor-pointer" onclick="toast('Ad clicked! +0.4 CNX', 'success')">
            <div class="flex items-center gap-4">
              <div class="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center text-2xl">💎</div>
              <div><div class="font-bold">Ad #4</div><div class="text-sm text-zinc-400">Earn 0.4 CNX</div></div>
            </div>
          </div>
        </div>
        <p class="text-xs text-zinc-500 mt-6">More ads coming soon. Click any ad to simulate earning.</p>
      </div>
    </div>`;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function renderReferrals() {
  const p = state.profile;
  const link = `${location.origin}?ref=${p.referralCode}`;
  const c = $('#pageContainer');
  if (!c) return;
  c.innerHTML = `
    <div class="space-y-6">
      <h1 class="text-3xl font-bold">Referrals</h1>
      <div class="glass-card p-8 rounded-3xl gradient-border text-center">
        <div class="text-xs text-zinc-500 mb-2">Your Referral Code</div>
        <div class="text-3xl font-black font-mono bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent mb-4">${p.referralCode}</div>
        <div class="flex gap-2 max-w-lg mx-auto">
          <input readonly value="${link}" class="input-field flex-1 text-center text-sm" />
          <button onclick="navigator.clipboard.writeText('${link}').then(() => toast('Copied!', 'success'))" class="btn-primary">Copy</button>
        </div>
      </div>
      <div class="grid sm:grid-cols-3 gap-4">
        <div class="glass-card p-6 rounded-3xl text-center"><div class="text-xs text-zinc-500">Total</div><div class="text-3xl font-bold mt-2">${p.referralCount || 0}</div></div>
        <div class="glass-card p-6 rounded-3xl text-center"><div class="text-xs text-zinc-500">Earned</div><div class="text-3xl font-bold mt-2 text-green-400">${fmtUSD(p.referralEarnings)}</div></div>
        <div class="glass-card p-6 rounded-3xl text-center"><div class="text-xs text-zinc-500">Rate</div><div class="text-3xl font-bold mt-2 text-purple-400">20%</div></div>
      </div>
    </div>`;
}

function renderWithdraw() {
  const c = $('#pageContainer');
  if (!c) return;
  const grid = document.createElement('div');
  grid.className = 'grid sm:grid-cols-2 lg:grid-cols-3 gap-4';
  COINS.forEach(coin => {
    const m = COIN_META[coin];
    const bal = state.profile.balances[coin] || 0;
    const balUSD = bal * m.usd;
    const can = balUSD >= m.min;
    const card = document.createElement('div');
    card.className = 'coin-card';
    card.innerHTML = `
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 rounded-full flex items-center justify-center" style="background:${m.color}20;border:2px solid ${m.color}40">
            <div style="font-size:24px;font-weight:900;color:${m.color}">${coin[0]}</div>
          </div>
          <div><div class="font-bold">${m.name}</div><div class="text-xs text-zinc-500">${coin}</div></div>
        </div>
        <span class="badge ${can ? 'badge-green' : 'badge-yellow'}">${can ? 'Ready' : 'Min $0.03'}</span>
      </div>
      <div class="space-y-2 mb-4">
        <div class="flex justify-between text-sm"><span class="text-zinc-500">Balance</span><span class="font-mono">${fmt(bal)} ${coin}</span></div>
        <div class="flex justify-between text-sm"><span class="text-zinc-500">USD</span><span>${fmtUSD(balUSD)}</span></div>
      </div>
      <button class="btn-primary w-full" ${!can ? 'disabled' : ''} onclick="doWithdraw('${coin}')">${can ? 'Withdraw' : 'Min $0.03 Required'}</button>`;
    grid.appendChild(card);
  });
  c.innerHTML = `<div class="space-y-6"><h1 class="text-3xl font-bold">Withdraw</h1><p class="text-zinc-400">Minimum $0.03 · Instant via FaucetPay</p><div id="withdrawGrid"></div></div>`;
  const gridContainer = $('#withdrawGrid');
  if (gridContainer) gridContainer.appendChild(grid);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

window.doWithdraw = async (coin) => {
  if (!state.profile.faucetpayEmail) { toast('Set FaucetPay email in Settings first', 'warning'); router.go('#/settings'); return; }
  if (!confirm(`Withdraw all ${coin} to ${state.profile.faucetpayEmail}?`)) return;
  try { const data = await apiCall('/api/withdraw', { method: 'POST', body: JSON.stringify({ coin }) }); toast(`Withdrew ${fmt(data.amount)} ${data.coin}!`, 'success'); renderWithdraw(); } catch (e) { toast(e.message, 'error'); }
};

async function renderTransactions() {
  try {
    const data = await apiCall('/api/transactions?limit=100');
    const list = data.transactions.map(t => `
      <div class="flex items-center justify-between p-4 hover:bg-white/5 transition">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center">
            <i data-lucide="${t.type === 'claim' ? 'droplets' : 'gift'}" class="w-5 h-5 ${t.type === 'withdraw' ? 'text-red-400' : 'text-green-400'}"></i>
          </div>
          <div><div class="text-sm font-medium capitalize">${t.type}</div><div class="text-xs text-zinc-500">${t.coin}</div></div>
        </div>
        <div class="text-right"><div class="text-sm font-bold ${t.type === 'withdraw' ? 'text-red-400' : 'text-green-400'}">${t.type === 'withdraw' ? '-' : '+'}${fmt(t.amount)} ${t.coin}</div></div>
      </div>`).join('');
    const c = $('#pageContainer');
    if (!c) return;
    c.innerHTML = `<div class="space-y-6"><h1 class="text-3xl font-bold">Transactions</h1><div class="glass-card rounded-3xl divide-y divide-white/5">${list || '<div class="p-8 text-center text-zinc-500">No transactions</div>'}</div></div>`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
  } catch (e) { toast(e.message, 'error'); }
}

function renderSettings() {
  const p = state.profile;
  const c = $('#pageContainer');
  if (!c) return;
  c.innerHTML = `
    <div class="space-y-6">
      <h1 class="text-3xl font-bold">Settings</h1>
      <form id="settingsForm" class="space-y-6">
        <div class="glass-card p-6 rounded-3xl space-y-4">
          <h3 class="font-semibold">Profile</h3>
          <div class="grid sm:grid-cols-2 gap-4">
            <div><label class="label">Username</label><input name="username" value="${escapeHtml(p.username)}" class="input-field" /></div>
            <div><label class="label">Email</label><input value="${escapeHtml(p.email)}" class="input-field" readonly /></div>
            <div><label class="label">Country</label><input name="country" value="${escapeHtml(p.country || '')}" class="input-field" /></div>
            <div><label class="label">Timezone</label><input name="timezone" value="${escapeHtml(p.timezone || '')}" class="input-field" /></div>
          </div>
        </div>
        <div class="glass-card p-6 rounded-3xl">
          <h3 class="font-semibold mb-4">Payment</h3>
          <label class="label">FaucetPay Email</label>
          <input name="faucetpayEmail" type="email" value="${escapeHtml(p.faucetpayEmail || '')}" class="input-field" placeholder="your@faucetpay.email" />
        </div>
        <button type="submit" class="btn-primary">💾 Save Changes</button>
      </form>
    </div>`;
  $('#settingsForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await apiCall('/api/settings', { method: 'PUT', body: JSON.stringify({ username: fd.get('username'), country: fd.get('country'), timezone: fd.get('timezone'), faucetpayEmail: fd.get('faucetpayEmail') }) });
      toast('Saved!', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ============ INIT ============
if (typeof lucide !== 'undefined') lucide.createIcons();
initLanding();
console.log('||| ⚡ CoinixFaucet ready |||');

import { 
  auth, db, COL, COINS, COIN_META, RECAPTCHA_SITE_KEY,
  applyActionCode, checkActionCode, confirmPasswordReset, 
  verifyPasswordResetCode, sendPasswordResetEmail, sendEmailVerification
} from './firebase-config.js';
import {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, reload
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

console.log('||| ========== APP START ========== |||');

const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];
const fmt = (n, d = 4) => Number(n || 0).toFixed(d);
const fmtUSD = n => '$' + Number(n || 0).toFixed(4);
const uid = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const now = () => Date.now();
const escapeHtml = s => String(s || '').replace(/[&<>"']/g, c => ({ '&':'&', '<':'<', '>':'>', '"':'"', "'":'' }[c]));

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
  const icon = isDark ? 'sun' : 'moon';
  $$('.dark-mode-icon').forEach(el => {
    if (el) el.innerHTML = `<i data-lucide="${icon}" class="w-4 h-4"></i>`;
  });
  if (typeof lucide !== 'undefined') lucide.createIcons();
}
if (getDarkMode()) document.documentElement.classList.add('dark');

// ============ TOAST ============
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icon = type === 'success' ? 'check-circle' : type === 'error' ? 'x-circle' : 'info';
  el.innerHTML = `<i data-lucide="${icon}" class="w-5 h-5"></i><span>${msg}</span>`;
  const root = $('#toastRoot');
  if (root) { root.appendChild(el); setTimeout(() => el.remove(), 3500); }
  if (typeof lucide !== 'undefined') lucide.createIcons();
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
  $$('#darkModeToggle, #darkModeToggle2').forEach(btn => {
    if (btn) btn.addEventListener('click', toggleDarkMode);
  });
  setTimeout(updateDarkModeIcons, 100);

  $('#openLoginBtn')?.addEventListener('click', () => openAuthModal('login'));
  $('#openSignupBtn')?.addEventListener('click', () => openAuthModal('register'));
  $('#heroLoginBtn')?.addEventListener('click', () => openAuthModal('login'));
  $('#heroSignupBtn')?.addEventListener('click', () => openAuthModal('register'));

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
    card.className = 'coin-landing-card group';
    card.style.setProperty('--coin-color', m.color + '40');
    card.innerHTML = `
      <img src="/coins/${coin.toLowerCase()}.png" alt="${coin}" class="w-12 h-12 rounded-xl mb-4" onerror="this.style.display='none'" />
      <h3 class="text-xl font-bold mb-1">${m.name}</h3>
      <p class="text-sm text-zinc-500 mb-4">${coin}</p>
      <div class="space-y-2 text-sm">
        <div class="flex justify-between"><span class="text-zinc-500">Status</span><span class="badge badge-green">Active</span></div>
        <div class="flex justify-between"><span class="text-zinc-500">Min Withdraw</span><span class="font-medium">$0.03</span></div>
        <div class="flex justify-between"><span class="text-zinc-500">Payout</span><span class="font-medium">Instant</span></div>
      </div>
    `;
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
      table.innerHTML = '<tr><td colspan="6" class="p-6 text-center text-zinc-500">No withdrawals yet</td></tr>';
      return;
    }
    data.withdrawals.forEach(t => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="p-3"><div class="w-8 h-8 rounded-full bg-gradient-to-br from-primary-500 to-secondary-500 flex items-center justify-center text-white font-bold text-xs">${(t.username || 'U')[0].toUpperCase()}</div></td>
        <td class="p-3 font-medium">${escapeHtml(t.username || 'User')}</td>
        <td class="p-3">${t.coin}</td>
        <td class="p-3">${fmt(t.amount)}</td>
        <td class="p-3">${fmtUSD(t.usdValue)}</td>
        <td class="p-3 text-zinc-500 text-sm">${new Date(t.createdAt).toLocaleTimeString()}</td>
        <td class="p-3"><span class="badge badge-green">Completed</span></td>
      `;
      table.appendChild(row);
    });
  } catch (e) { console.error('Withdraws error:', e); }
}

// ============ AUTH ============
let authMode = 'login';

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
document.querySelector('#authModal .auth-modal-backdrop')?.addEventListener('click', closeAuthModal);
$$('[data-auth-tab]').forEach(btn => btn.addEventListener('click', () => { authMode = btn.dataset.authTab; updateAuthModalUI(); }));

// ============ RECAPTCHA HELPER ============
async function getRecaptchaToken(action = 'login') {
  if (typeof grecaptcha === 'undefined') {
    console.warn('reCAPTCHA not loaded');
    return null;
  }
  
  try {
    // Enterprise ready olmasını bekle
    if (grecaptcha.enterprise && grecaptcha.enterprise.execute) {
      return await new Promise((resolve, reject) => {
        grecaptcha.enterprise.ready(async () => {
          try {
            const token = await grecaptcha.enterprise.execute(RECAPTCHA_SITE_KEY, { action });
            resolve(token);
          } catch (e) {
            reject(e);
          }
        });
      });
    } else if (grecaptcha.ready && grecaptcha.execute) {
      return await new Promise((resolve, reject) => {
        grecaptcha.ready(async () => {
          try {
            const token = await grecaptcha.execute(RECAPTCHA_SITE_KEY, { action });
            resolve(token);
          } catch (e) {
            reject(e);
          }
        });
      });
    }
  } catch (e) {
    console.warn('reCAPTCHA execute error:', e);
    return null;
  }
  return null;
}

// ============ AUTH FORM SUBMIT ============
$('#authForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const email = fd.get('email').trim().toLowerCase();
  const password = fd.get('password');
  const btn = $('#authSubmit');
  if (btn) btn.disabled = true;

  try {
    // reCAPTCHA token al
    const recaptchaToken = await getRecaptchaToken(authMode === 'login' ? 'login' : 'signup');
    console.log('||| reCAPTCHA Token:', recaptchaToken ? '✅ Alındı' : '❌ Alınamadı');
    
    if (authMode === 'login') {
      await signInWithEmailAndPassword(auth, email, password);
      await reload(auth.currentUser);
      
      // Email verified kontrolü
      if (!auth.currentUser.emailVerified) {
        toast('Please verify your email first. Check your inbox.', 'warning');
        await signOut(auth);
        if (btn) btn.disabled = false;
        return;
      }
      
      toast('Welcome back!', 'success');
      closeAuthModal();
    } else {
      const username = fd.get('username').trim();
      const referral = fd.get('referral').trim().toUpperCase();
      
      if (username.length < 3) throw new Error('Username must be 3+ characters');
      
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await sendEmailVerification(cred.user);
      
      const refCode = uid();
      const profile = {
        uid: cred.user.uid,
        username,
        email,
        country: 'Unknown',
        timezone: 'UTC',
        faucetpayEmail: '',
        referralCode: refCode,
        referredBy: referral || null,
        balances: Object.fromEntries(COINS.map(c => [c, 0])),
        totalWithdrawn: 0,
        referralEarnings: 0,
        referralCount: 0,
        totalClaims: 0,
        lastClaimAt: 0,
        lastDailyBonus: 0,
        dailyStreak: 0,
        highestStreak: 0,
        isAdmin: false,
        createdAt: serverTimestamp()
      };
      
      await setDoc(doc(db, COL.users, cred.user.uid), profile);
      
      toast('Account created! Please check your email to verify.', 'success');
      closeAuthModal();
      await signOut(auth);
    }
  } catch (err) {
    console.error('Auth error:', err);
    toast(err.message || 'Authentication failed', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ============ FORGOT PASSWORD ============
$('#forgotPasswordBtn')?.addEventListener('click', () => {
  closeAuthModal();
  setTimeout(() => {
    $('#forgotPasswordModal')?.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }, 200);
});

$('#closeForgotPassword')?.addEventListener('click', () => {
  $('#forgotPasswordModal')?.classList.add('hidden');
  document.body.style.overflow = '';
});

document.querySelector('#forgotPasswordModal .auth-modal-backdrop')?.addEventListener('click', () => {
  $('#forgotPasswordModal')?.classList.add('hidden');
  document.body.style.overflow = '';
});

$('#forgotPasswordForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const email = fd.get('email').trim().toLowerCase();
  const btn = e.target.querySelector('button[type="submit"]');
  
  if (btn) btn.disabled = true;
  
  try {
    await sendPasswordResetEmail(auth, email);
    toast('Password reset email sent! Check your inbox.', 'success');
    $('#forgotPasswordModal')?.classList.add('hidden');
    document.body.style.overflow = '';
    e.target.reset();
  } catch (err) {
    console.error('Forgot password error:', err);
    toast(err.message || 'Failed to send reset email', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ============ EMAIL ACTION HANDLERS ============
async function handleEmailAction() {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode');
  const oobCode = params.get('oobCode');
  
  if (!mode || !oobCode) return false;
  
  $('#landingPage')?.classList.add('hidden');
  $('#appShell')?.classList.add('hidden');
  $('#emailActionPage')?.classList.remove('hidden');
  
  const content = $('#emailActionContent');
  
  try {
    if (mode === 'verifyEmail') {
      await applyActionCode(auth, oobCode);
      content.innerHTML = `
        <div class="w-16 h-16 rounded-full bg-green-500/20 mx-auto mb-4 flex items-center justify-center">
          <i data-lucide="check-circle" class="w-8 h-8 text-green-500"></i>
        </div>
        <h2 class="text-2xl font-bold text-zinc-900 dark:text-white mb-2">Email Verified!</h2>
        <p class="text-zinc-500 dark:text-zinc-400 mb-6">Your email has been successfully verified.</p>
        <button onclick="location.href='/'" class="btn-primary">Go to Login</button>
      `;
    } else if (mode === 'resetPassword') {
      try {
        await verifyPasswordResetCode(auth, oobCode);
        content.innerHTML = `
          <div class="w-16 h-16 rounded-full bg-primary-500/20 mx-auto mb-4 flex items-center justify-center">
            <i data-lucide="key" class="w-8 h-8 text-primary-500"></i>
          </div>
          <h2 class="text-2xl font-bold text-zinc-900 dark:text-white mb-2">Reset Password</h2>
          <p class="text-zinc-500 dark:text-zinc-400 mb-6">Enter your new password</p>
          <form id="resetPasswordForm" class="space-y-4 text-left">
            <div>
              <label class="label">New Password</label>
              <input type="password" id="newPassword" class="input-field" placeholder="••••••••" required minlength="6" />
            </div>
            <div>
              <label class="label">Confirm Password</label>
              <input type="password" id="confirmPassword" class="input-field" placeholder="••••••••" required minlength="6" />
            </div>
            <button type="submit" class="btn-primary w-full">Reset Password</button>
          </form>
        `;
        if (typeof lucide !== 'undefined') lucide.createIcons();
        setTimeout(() => {
          $('#resetPasswordForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const newPass = $('#newPassword').value;
            const confirmPass = $('#confirmPassword').value;
            if (newPass !== confirmPass) {
              toast('Passwords do not match', 'error');
              return;
            }
            try {
              await confirmPasswordReset(auth, oobCode, newPass);
              content.innerHTML = `
                <div class="w-16 h-16 rounded-full bg-green-500/20 mx-auto mb-4 flex items-center justify-center">
                  <i data-lucide="check-circle" class="w-8 h-8 text-green-500"></i>
                </div>
                <h2 class="text-2xl font-bold text-zinc-900 dark:text-white mb-2">Password Reset!</h2>
                <p class="text-zinc-500 dark:text-zinc-400 mb-6">Your password has been successfully reset.</p>
                <button onclick="location.href='/'" class="btn-primary">Go to Login</button>
              `;
              if (typeof lucide !== 'undefined') lucide.createIcons();
            } catch (err) {
              toast(err.message || 'Failed to reset password', 'error');
            }
          });
        }, 100);
      } catch (err) {
        content.innerHTML = `
          <div class="w-16 h-16 rounded-full bg-red-500/20 mx-auto mb-4 flex items-center justify-center">
            <i data-lucide="x-circle" class="w-8 h-8 text-red-500"></i>
          </div>
          <h2 class="text-2xl font-bold text-zinc-900 dark:text-white mb-2">Invalid Link</h2>
          <p class="text-zinc-500 dark:text-zinc-400 mb-6">This password reset link is invalid or has expired.</p>
          <button onclick="location.href='/'" class="btn-primary">Go to Login</button>
        `;
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }
    }
    return true;
  } catch (err) {
    content.innerHTML = `
      <div class="w-16 h-16 rounded-full bg-red-500/20 mx-auto mb-4 flex items-center justify-center">
        <i data-lucide="x-circle" class="w-8 h-8 text-red-500"></i>
      </div>
      <h2 class="text-2xl font-bold text-zinc-900 dark:text-white mb-2">Error</h2>
      <p class="text-zinc-500 dark:text-zinc-400 mb-6">${err.message || 'An error occurred'}</p>
      <button onclick="location.href='/'" class="btn-primary">Go to Login</button>
    `;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return true;
  }
}

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
    if ($('#emailActionPage')) $('#emailActionPage').classList.add('hidden');

    if (typeof lucide !== 'undefined') lucide.createIcons();
    router.init();
    updateTopBar();
    initThreeDotsMenu();
  } else {
    state.user = null;
    state.profile = null;
    state.unsubProfile?.();

    if ($('#landingPage')) $('#landingPage').classList.remove('hidden');
    if ($('#appShell')) $('#appShell').classList.add('hidden');
    if ($('#emailActionPage')) $('#emailActionPage').classList.add('hidden');

    updateTopBar();
  }
});

function updateTopBar() {
  const loginBtn = $('#openLoginBtn');
  const signupBtn = $('#openSignupBtn');
  const heroLoginBtn = $('#heroLoginBtn');
  const heroSignupBtn = $('#heroSignupBtn');

  if (!state.profile) {
    if (loginBtn) { loginBtn.textContent = 'Login'; loginBtn.className = 'btn-ghost text-sm'; }
    if (signupBtn) { signupBtn.textContent = 'Sign Up'; signupBtn.className = 'btn-primary text-sm'; }
    if (heroLoginBtn) { heroLoginBtn.textContent = 'Login'; heroLoginBtn.className = 'btn-ghost text-base px-10 py-5'; }
    if (heroSignupBtn) { heroSignupBtn.textContent = 'Start Earning — It\'s Free'; heroSignupBtn.className = 'btn-primary text-base px-10 py-5 shadow-2xl shadow-primary-500/40'; }
    return;
  }

  const total = COINS.reduce((s, c) => s + (state.profile.balances[c] || 0) * (COIN_META[c].usd || 0), 0);
  if ($('#topBalance')) $('#topBalance').textContent = fmtUSD(total);
  if ($('#profileName')) $('#profileName').textContent = state.profile.username;
  if ($('#profileAvatar')) $('#profileAvatar').textContent = state.profile.username[0].toUpperCase();

  if (loginBtn) { loginBtn.textContent = 'Dashboard'; loginBtn.className = 'btn-primary text-sm'; loginBtn.onclick = () => { $('#landingPage')?.classList.add('hidden'); $('#appShell')?.classList.remove('hidden'); router.go('#/dashboard'); }; }
  if (signupBtn) { signupBtn.textContent = 'Logout'; signupBtn.className = 'btn-ghost text-sm'; signupBtn.onclick = async () => { await signOut(auth); toast('Logged out', 'info'); }; }
  if (heroLoginBtn) { heroLoginBtn.textContent = 'Dashboard'; heroLoginBtn.className = 'btn-ghost text-base px-10 py-5'; heroLoginBtn.onclick = () => { $('#landingPage')?.classList.add('hidden'); $('#appShell')?.classList.remove('hidden'); router.go('#/dashboard'); }; }
  if (heroSignupBtn) { heroSignupBtn.textContent = 'Logout'; heroSignupBtn.className = 'btn-ghost text-base px-10 py-5'; heroSignupBtn.onclick = async () => { await signOut(auth); toast('Logged out', 'info'); }; }
}

$('#logoutBtn')?.addEventListener('click', async () => { await signOut(auth); toast('Signed out', 'info'); });
$('#logoutBtnTop')?.addEventListener('click', async () => { await signOut(auth); toast('Signed out', 'info'); });

// ============ THREE DOTS MENU ============
function initThreeDotsMenu() {
  const btn = $('#threeDotsBtn');
  const menu = $('#threeDotsMenu');
  
  if (!btn || !menu) return;
  
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('hidden');
  });
  
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && !btn.contains(e.target)) {
      menu.classList.add('hidden');
    }
  });
  
  $('#logoutBtnMenu')?.addEventListener('click', async () => {
    await signOut(auth);
    toast('Signed out', 'info');
  });
}

// ============ ROUTER ============
const router = {
  routes: {
    dashboard: renderDashboard,
    faucet: renderFaucet,
    'daily-bonus': renderDailyBonus,
    leaderboard: renderLeaderboard,
    ptc: renderPtc,
    referrals: renderReferrals,
    withdraw: renderWithdraw,
    transactions: renderTransactions,
    settings: renderSettings,
    offerwall: renderOfferwall,
    games: renderGames
  },
  init() {
    window.addEventListener('hashchange', () => this.navigate());
    $('#menuToggle, #menuToggle2')?.addEventListener('click', () => $('#sidebar')?.classList.toggle('open'));
    if (!location.hash.startsWith('#/')) location.hash = '#/dashboard';
    else this.navigate();
  },
  go(h) { location.hash = h; },
  navigate() {
    const route = location.hash.replace('#/', '') || 'dashboard';
    const fn = this.routes[route];
    if (!fn) { this.go('#/dashboard'); return; }
    $$('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.route === route));

    if(window.innerWidth <= 1024) {
      $('#sidebar')?.classList.remove('open');
    }

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
      <div class="space-y-6 page-enter">
        <!-- Banner Reklam Alanı -->
        <div class="glass-card rounded-2xl p-4 text-center bg-gradient-to-r from-primary-500/10 to-secondary-500/10">
          <p class="text-sm text-zinc-500">Advertisement</p>
          <div class="h-20 flex items-center justify-center">
            <!-- Banner reklam kodu buraya eklenecek -->
            <p class="text-zinc-400">728x90 Banner</p>
          </div>
        </div>
        
        <div class="flex items-center justify-between">
          <div>
            <p class="text-zinc-500 text-sm">Welcome back,</p>
            <h1 class="text-3xl font-bold text-zinc-900 dark:text-white">${escapeHtml(state.profile.username)}</h1>
          </div>
        </div>
        
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div class="stat-glass-card">
            <div class="stat-icon primary"><i data-lucide="wallet" class="w-5 h-5"></i></div>
            <div class="stat-label">Main Balance</div>
            <div class="stat-value">${fmtUSD(s.totalBalanceUSD)}</div>
          </div>
          <div class="stat-glass-card">
            <div class="stat-icon green"><i data-lucide="trending-up" class="w-5 h-5"></i></div>
            <div class="stat-label">Today</div>
            <div class="stat-value">${fmtUSD(s.todayEarnings)}</div>
          </div>
          <div class="stat-glass-card">
            <div class="stat-icon purple"><i data-lucide="users" class="w-5 h-5"></i></div>
            <div class="stat-label">Referral</div>
            <div class="stat-value">${fmtUSD(s.referralEarnings)}</div>
          </div>
          <div class="stat-glass-card">
            <div class="stat-icon cyan"><i data-lucide="arrow-down-circle" class="w-5 h-5"></i></div>
            <div class="stat-label">Withdrawn</div>
            <div class="stat-value">${fmtUSD(s.totalWithdrawn)}</div>
          </div>
        </div>
        
        <div class="flex gap-4">
          <button onclick="router.go('#/faucet')" class="btn-primary flex-1">
            <i data-lucide="droplets" class="w-5 h-5"></i> Claim Now
          </button>
          <button onclick="router.go('#/withdraw')" class="btn-ghost flex-1">
            <i data-lucide="wallet" class="w-5 h-5"></i> Withdraw
          </button>
        </div>
      </div>
    `;

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
      try { 
        token = await getRecaptchaToken('claim');
        console.log('||| Claim reCAPTCHA Token:', token ? '✅ Alındı' : '❌ Alınamadı');
      } catch(e) {
        console.warn('reCAPTCHA claim error:', e);
      }
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
    <div class="space-y-6 page-enter">
      <h1 class="text-3xl font-bold text-zinc-900 dark:text-white">Daily Bonus</h1>
      <div class="glass-card rounded-3xl p-8 text-center">
        <div class="text-6xl font-black bg-gradient-to-r from-primary-500 to-secondary-500 bg-clip-text text-transparent mb-2">${p.dailyStreak || 0}</div>
        <p class="text-zinc-500 mb-6">Day Streak · Best: ${p.highestStreak || 0}</p>
        <button id="claimBonusBtn" class="btn-primary px-8 py-4 text-lg">Claim Daily Bonus</button>
      </div>
    </div>
  `;
  $('#claimBonusBtn')?.addEventListener('click', async () => {
    try { 
      const data = await apiCall('/api/daily-bonus', { method: 'POST' }); 
      toast(`Day ${data.day} bonus: ${fmtUSD(data.usdValue)}`, 'success'); 
      renderDailyBonus(); 
    } catch (e) { toast(e.message, 'error'); }
  });
}

async function renderLeaderboard() {
  try {
    const res = await fetch('/api/leaderboard');
    const data = await res.json();
    const c = $('#pageContainer');
    if (!c || !data.success) return;
    c.innerHTML = `
      <div class="space-y-6 page-enter">
        <h1 class="text-3xl font-bold text-zinc-900 dark:text-white">Leaderboard</h1>
        <div class="glass-card rounded-3xl overflow-hidden">
          ${data.leaderboard.map(u => `
            <div class="flex items-center gap-4 p-4 border-b border-zinc-200 dark:border-zinc-800 last:border-0">
              <div class="w-10 h-10 rounded-full bg-gradient-to-br from-primary-500 to-secondary-500 flex items-center justify-center text-white font-bold">#${u.rank}</div>
              <div class="w-10 h-10 rounded-full bg-zinc-200 dark:bg-zinc-700 flex items-center justify-center font-bold">${u.username[0].toUpperCase()}</div>
              <div class="flex-1">
                <div class="font-bold">${escapeHtml(u.username)}</div>
                <div class="text-sm text-zinc-500">${u.country || 'Unknown'}</div>
              </div>
              <div class="text-right">
                <div class="font-bold">${u.totalClaims} claims</div>
                <div class="text-sm text-zinc-500">${fmtUSD(u.totalWithdrawn)}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  } catch (e) { toast('Error loading', 'error'); }
}

async function renderPtc() {
  const c = $('#pageContainer');
  if (!c) return;
  
  try {
    const data = await apiCall('/api/ptc/available');
    c.innerHTML = `
      <div class="space-y-6 page-enter">
        <h1 class="text-3xl font-bold text-zinc-900 dark:text-white">PTC Ads</h1>
        <p class="text-zinc-500">Click on ads and earn free CNX coins instantly.</p>
        <div class="grid md:grid-cols-2 gap-6">
          ${data.ads.map(ad => `
            <div class="glass-card rounded-2xl p-6">
              <div class="flex items-center justify-between mb-4">
                <h3 class="font-bold text-lg">${escapeHtml(ad.title)}</h3>
                <span class="badge badge-green">+${ad.reward} CNX</span>
              </div>
              <p class="text-sm text-zinc-500 mb-4">${ad.duration}s · ${ad.remaining} available</p>
              <button onclick="viewPtcAd('${ad.id}')" class="btn-primary w-full">View Ad</button>
            </div>
          `).join('') || '<p class="text-zinc-500 col-span-2 text-center">No ads available</p>'}
        </div>
      </div>
    `;
  } catch (e) {
    c.innerHTML = `
      <div class="space-y-6 page-enter">
        <h1 class="text-3xl font-bold text-zinc-900 dark:text-white">PTC Ads</h1>
        <p class="text-zinc-500">No ads available at the moment.</p>
      </div>
    `;
  }
}

window.viewPtcAd = async (adId) => {
  try {
    const data = await apiCall('/api/ptc/view', { method: 'POST', body: JSON.stringify({ adId }) });
    const win = window.open(data.url, '_blank');
    setTimeout(async () => {
      try {
        const result = await apiCall('/api/ptc/complete', { method: 'POST', body: JSON.stringify({ adId }) });
        toast(`Earned ${result.reward} CNX!`, 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    }, data.duration * 1000);
  } catch (e) {
    toast(e.message, 'error');
  }
};

function renderReferrals() {
  const p = state.profile;
  const link = `${location.origin}?ref=${p.referralCode}`;
  const c = $('#pageContainer');
  if (!c) return;
  c.innerHTML = `
    <div class="space-y-6 page-enter">
      <h1 class="text-3xl font-bold text-zinc-900 dark:text-white">Referrals</h1>
      <div class="grid grid-cols-3 gap-4">
        <div class="stat-glass-card text-center">
          <div class="stat-label">Total</div>
          <div class="stat-value">${p.referralCount || 0}</div>
        </div>
        <div class="stat-glass-card text-center">
          <div class="stat-label">Earned</div>
          <div class="stat-value">${fmtUSD(p.referralEarnings)}</div>
        </div>
        <div class="stat-glass-card text-center">
          <div class="stat-label">Rate</div>
          <div class="stat-value">20%</div>
        </div>
      </div>
      <div class="glass-card rounded-2xl p-6">
        <label class="label">Your Referral Code</label>
        <div class="flex gap-2">
          <input type="text" value="${p.referralCode}" readonly class="input-field flex-1" />
          <button onclick="navigator.clipboard.writeText('${link}'); toast('Copied!', 'success');" class="btn-primary">Copy</button>
        </div>
      </div>
    </div>
  `;
}

function renderWithdraw() {
  const c = $('#pageContainer');
  if (!c) return;
  c.innerHTML = `
    <div class="space-y-6 page-enter">
      <div>
        <h1 class="text-3xl font-bold text-zinc-900 dark:text-white">Withdraw</h1>
        <p class="text-zinc-500 mt-1">Minimum $0.03 · Instant via FaucetPay</p>
      </div>
      <div id="withdrawGrid" class="grid md:grid-cols-2 lg:grid-cols-3 gap-6"></div>
    </div>
  `;
  const grid = $('#withdrawGrid');
  if(!grid) return;

  COINS.forEach(coin => {
    const m = COIN_META[coin];
    const bal = state.profile.balances[coin] || 0;
    const balUSD = bal * m.usd;
    const can = balUSD >= m.min;
    const card = document.createElement('div');
    card.className = 'coin-card group';
    card.innerHTML = `
      <img src="/coins/${coin.toLowerCase()}.png" alt="${coin}" class="w-12 h-12 rounded-xl mb-4" onerror="this.style.display='none'" />
      <h3 class="text-xl font-bold mb-1">${m.name}</h3>
      <p class="text-sm text-zinc-500 mb-4">${coin}</p>
      <div class="mb-4">
        <span class="badge ${can ? 'badge-green' : 'badge-yellow'}">${can ? 'Ready' : 'Min $0.03'}</span>
      </div>
      <div class="space-y-2 text-sm">
        <div class="flex justify-between"><span class="text-zinc-500">Balance</span><span class="font-medium">${fmt(bal)} ${coin}</span></div>
        <div class="flex justify-between"><span class="text-zinc-500">USD</span><span class="font-medium">${fmtUSD(balUSD)}</span></div>
      </div>
      <button onclick="doWithdraw('${coin}')" class="btn-primary w-full mt-4" ${!can ? 'disabled' : ''}>${can ? 'Withdraw' : 'Min $0.03 Required'}</button>
    `;
    grid.appendChild(card);
  });
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

window.doWithdraw = async (coin) => {
  if (!state.profile.faucetpayEmail) { toast('Set FaucetPay email in Settings first', 'warning'); router.go('#/settings'); return; }
  if (!confirm(`Withdraw all ${coin} to ${state.profile.faucetpayEmail}?`)) return;
  try { 
    const data = await apiCall('/api/withdraw', { method: 'POST', body: JSON.stringify({ coin }) }); 
    toast(`Withdrew ${fmt(data.amount)} ${data.coin}!`, 'success'); 
    renderWithdraw(); 
  } catch (e) { toast(e.message, 'error'); }
};

async function renderTransactions() {
  try {
    const data = await apiCall('/api/transactions?limit=100');
    const list = data.transactions.map(t => `
      <div class="flex items-center gap-4 p-4 border-b border-zinc-200 dark:border-zinc-800 last:border-0">
        <div class="w-10 h-10 rounded-full ${t.type === 'withdraw' ? 'bg-red-500/20' : 'bg-green-500/20'} flex items-center justify-center">
          <i data-lucide="${t.type === 'withdraw' ? 'arrow-down' : 'arrow-up'}" class="w-5 h-5 ${t.type === 'withdraw' ? 'text-red-500' : 'text-green-500'}"></i>
        </div>
        <div class="flex-1">
          <div class="font-bold capitalize">${t.type}</div>
          <div class="text-sm text-zinc-500">${t.coin}</div>
        </div>
        <div class="text-right font-bold ${t.type === 'withdraw' ? 'text-red-500' : 'text-green-500'}">
          ${t.type === 'withdraw' ? '-' : '+'}${fmt(t.amount)} ${t.coin}
        </div>
      </div>
    `).join('');
    const c = $('#pageContainer');
    if (!c) return;
    c.innerHTML = `
      <div class="space-y-6 page-enter">
        <h1 class="text-3xl font-bold text-zinc-900 dark:text-white">Transactions</h1>
        <div class="glass-card rounded-3xl overflow-hidden">
          ${list || '<div class="p-6 text-center text-zinc-500">No transactions</div>'}
        </div>
      </div>
    `;
    if (typeof lucide !== 'undefined') lucide.createIcons();
  } catch (e) { toast(e.message, 'error'); }
}

function renderSettings() {
  const p = state.profile;
  const c = $('#pageContainer');
  if (!c) return;
  c.innerHTML = `
    <div class="space-y-6 page-enter">
      <h1 class="text-3xl font-bold text-zinc-900 dark:text-white">Settings</h1>
      <form id="settingsForm" class="space-y-6">
        <div class="glass-card rounded-2xl p-6">
          <h3 class="font-bold text-lg mb-4">Profile</h3>
          <div class="grid md:grid-cols-2 gap-4">
            <div>
              <label class="label">Username</label>
              <input name="username" type="text" value="${escapeHtml(p.username)}" class="input-field" required minlength="3" />
            </div>
            <div>
              <label class="label">Email</label>
              <input type="email" value="${escapeHtml(p.email)}" class="input-field" readonly />
            </div>
            <div>
              <label class="label">Country</label>
              <input name="country" type="text" value="${escapeHtml(p.country)}" class="input-field" />
            </div>
            <div>
              <label class="label">Timezone</label>
              <input name="timezone" type="text" value="${escapeHtml(p.timezone)}" class="input-field" />
            </div>
          </div>
        </div>
        <div class="glass-card rounded-2xl p-6">
          <h3 class="font-bold text-lg mb-4">Payment</h3>
          <div>
            <label class="label">FaucetPay Email</label>
            <input name="faucetpayEmail" type="email" value="${escapeHtml(p.faucetpayEmail)}" class="input-field" placeholder="your@faucetpay.email" />
          </div>
        </div>
        <button type="submit" class="btn-primary">Save Changes</button>
      </form>
    </div>
  `;
  $('#settingsForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await apiCall('/api/settings', { method: 'PUT', body: JSON.stringify({ 
        username: fd.get('username'), 
        country: fd.get('country'), 
        timezone: fd.get('timezone'), 
        faucetpayEmail: fd.get('faucetpayEmail') 
      }) });
      toast('Saved!', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
}

function renderOfferwall() {
  const frame = $('#offerwallFrame');
  if (frame && state.profile) {
    const apiKey = 'YOUR_OFFERWALL_API_KEY';
    const userId = state.profile.uid;
    frame.src = `https://offerwall.me/offerwall/${apiKey}/${userId}`;
  }
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function renderGames() {
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

window.openGame = (game) => {
  const container = $('#gameFrameContainer');
  const frame = $('#gameFrame');
  if (!container || !frame) return;
  
  // Oyun URL'leri - kendi oyun sayfalarınız veya iframe oyunlar
  const gameUrls = {
    dice: 'https://www.freeonlinegames.com/embed/dice-game',
    coinflip: 'https://www.freeonlinegames.com/embed/coin-flip',
    wheel: 'https://www.freeonlinegames.com/embed/wheel-of-fortune'
  };
  
  frame.src = gameUrls[game] || '';
  container.classList.remove('hidden');
  container.scrollIntoView({ behavior: 'smooth' });
};

// ============ INIT ============
document.addEventListener('DOMContentLoaded', async () => {
  const hasEmailAction = await handleEmailAction();
  
  if (!hasEmailAction) {
    if (typeof lucide !== 'undefined') lucide.createIcons();
    initLanding();
  }
  
  console.log('||| ⚡ CoinixFaucet ready |||');
});

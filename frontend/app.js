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

console.log('🚀 CoinixFaucet App v3.0 Starting...');

const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];
const fmt = (n, d = 4) => Number(n || 0).toFixed(d);
const fmtUSD = n => '$' + Number(n || 0).toFixed(4);
const uid = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const now = () => Date.now();
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

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
  $$('#darkModeToggle i, #darkModeToggle2 i').forEach(el => {
    if (el) el.setAttribute('data-lucide', icon);
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

// ============ ADBLOCK DETECTION ============
async function detectAdBlock() {
  // Test reklam yükle
  const testAd = document.createElement('div');
  testAd.innerHTML = '<div class="adsbox ad-banner ad-placement" style="position:absolute;left:-9999px;width:1px;height:1px;"></div>';
  document.body.appendChild(testAd);
  
  await new Promise(resolve => setTimeout(resolve, 100));
  
  const adElement = testAd.querySelector('.adsbox');
  const isBlocked = !adElement || adElement.offsetHeight === 0 || 
                    window.getComputedStyle(adElement).display === 'none' ||
                    window.getComputedStyle(adElement).visibility === 'hidden';
  
  testAd.remove();
  
  if (isBlocked) {
    console.warn('⚠️ AdBlock detected!');
    $('#adBlockOverlay')?.classList.remove('hidden');
    return true;
  }
  return false;
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
  $('#darkModeToggle')?.addEventListener('click', toggleDarkMode);
  $('#darkModeToggle2')?.addEventListener('click', toggleDarkMode);
  setTimeout(updateDarkModeIcons, 100);

  $('#openLoginBtn')?.addEventListener('click', () => openAuthModal('login'));
  $('#openSignupBtn')?.addEventListener('click', () => openAuthModal('register'));
  $('#heroLoginBtn')?.addEventListener('click', () => openAuthModal('login'));
  $('#heroSignupBtn')?.addEventListener('click', () => openAuthModal('register'));

  $('#mobileLoginBtn')?.addEventListener('click', () => openAuthModal('login'));
  $('#mobileSignupBtn')?.addEventListener('click', () => openAuthModal('register'));
  $('#earnSignupBtn')?.addEventListener('click', () => openAuthModal('register'));
  $('#ctaSignupBtn')?.addEventListener('click', () => openAuthModal('register'));
  initLandingDrawer();
  initLandingReveal();
  renderLandingCoins();
  loadLiveStats();
  loadLiveWithdraws();
  setInterval(loadLiveWithdraws, 10000);
  setInterval(loadLiveStats, 30000);
}

// Mobile navigation drawer (landing). Open/close state lives on #menuToggle[aria-expanded].
function initLandingDrawer() {
  const panel = $('#mobileNavPanel');
  const btn = $('#menuToggle');
  const backdrop = $('#cxDrawerBackdrop');
  if (!panel || !btn) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let closeTimer = null;
  const isOpen = () => btn.getAttribute('aria-expanded') === 'true';
  const setOpen = (open) => {
    clearTimeout(closeTimer);
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    document.documentElement.classList.toggle('cx-lock', open);
    if (open) {
      panel.hidden = false;
      if (backdrop) backdrop.hidden = false;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        panel.classList.add('is-open');
        backdrop?.classList.add('is-open');
      }));
    } else {
      panel.classList.remove('is-open');
      backdrop?.classList.remove('is-open');
      const done = () => { panel.hidden = true; if (backdrop) backdrop.hidden = true; };
      if (reduce) done(); else closeTimer = setTimeout(done, 230);
    }
  };
  btn.addEventListener('click', () => setOpen(!isOpen()));
  backdrop?.addEventListener('click', () => setOpen(false));
  panel.addEventListener('click', e => { if (e.target.closest('a, button')) setOpen(false); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isOpen()) { setOpen(false); btn.focus(); }
  });
  const desktop = matchMedia('(min-width: 900px)');
  const onChange = e => { if (e.matches && isOpen()) setOpen(false); };
  desktop.addEventListener ? desktop.addEventListener('change', onChange) : desktop.addListener(onChange);
}

// Gentle scroll-reveal. Content is never hidden unless JS ran, and a timeout reveals everything as a fallback.
function initLandingReveal() {
  if (!('IntersectionObserver' in window)) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const targets = document.querySelectorAll('#landingPage .cx-section-head, #landingPage .cx-card, #landingPage .cx-stat, #landingPage .cx-final');
  if (!targets.length) return;
  targets.forEach(el => el.classList.add('cx-reveal'));
  document.documentElement.classList.add('cx-reveal-on');
  const io = new IntersectionObserver(entries => entries.forEach(en => {
    if (en.isIntersecting) { en.target.classList.add('is-visible'); io.unobserve(en.target); }
  }), { threshold: 0.08, rootMargin: '0px 0px -24px 0px' });
  targets.forEach(el => io.observe(el));
  setTimeout(() => targets.forEach(el => el.classList.add('is-visible')), 4000);
}

function renderLandingCoins() {
  const grid = $('#landingCoinsGrid');
  if (!grid) return;
  grid.innerHTML = '';
  COINS.forEach(coin => {
    const m = COIN_META[coin];
    if (!m) return;
    const card = document.createElement('div');
    card.className = 'cx-coin';
    card.style.setProperty('--coin', m.color);
    card.innerHTML = `
      <span class="cx-coin-badge" aria-hidden="true">${escapeHtml(coin[0])}</span>
      <h3>${escapeHtml(m.name)}</h3>
      <span class="cx-coin-ticker">${escapeHtml(coin)}</span>
      <p class="cx-coin-min">Minimum withdrawal<b>$${Number(m.min).toFixed(2)}</b></p>
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
    }
  } catch (e) { console.error('Stats error:', e); }
}

async function loadLiveWithdraws() {
  const table = $('#withdrawsBody');
  if (!table) return;
  const stateRow = (cls, title, text) => `<tr class="cx-row-state"><td colspan="6"><div class="cx-state ${cls}"><strong>${title}</strong><span>${text}</span></div></td></tr>`;
  try {
    const res = await fetch('/api/live-withdraws');
    const data = await res.json();
    if (!data.success) throw new Error('bad response');
    if (!data.withdrawals.length) {
      table.innerHTML = stateRow('', 'No completed withdrawals yet', 'Completed payouts will appear here.');
      return;
    }
    table.innerHTML = '';
    data.withdrawals.slice(0, 10).forEach(t => {
      const row = document.createElement('tr');
      const when = t.createdAt ? new Date(t.createdAt) : null;
      const time = when && !isNaN(when) ? when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
      row.innerHTML = `
        <td data-label="User">${escapeHtml(t.username || 'User')}</td>
        <td data-label="Coin">${escapeHtml(t.coin)}</td>
        <td data-label="Amount">${fmt(t.amount)}</td>
        <td data-label="USD">${fmtUSD(t.usdValue)}</td>
        <td data-label="Time">${escapeHtml(time)}</td>
        <td data-label="Status"><span class="cx-badge cx-badge--success">Completed</span></td>
      `;
      table.appendChild(row);
    });
  } catch (e) {
    console.error('Withdraws error:', e);
    if (!table.querySelector('td[data-label]')) {
      table.innerHTML = stateRow('cx-state--error', 'Could not load withdrawals', 'Please refresh the page in a moment.');
    }
  }
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

// ============ RECAPTCHA ============
async function getRecaptchaToken(action = 'login') {
  if (typeof grecaptcha === 'undefined') {
    console.warn('reCAPTCHA not loaded');
    return null;
  }
  
  return new Promise((resolve) => {
    try {
      if (grecaptcha.enterprise && grecaptcha.enterprise.ready) {
        grecaptcha.enterprise.ready(async () => {
          try {
            const token = await grecaptcha.enterprise.execute(RECAPTCHA_SITE_KEY, { action });
            resolve(token);
          } catch (e) {
            console.warn('reCAPTCHA execute error:', e);
            resolve(null);
          }
        });
      } else if (grecaptcha.ready) {
        grecaptcha.ready(async () => {
          try {
            const token = await grecaptcha.execute(RECAPTCHA_SITE_KEY, { action });
            resolve(token);
          } catch (e) {
            console.warn('reCAPTCHA execute error:', e);
            resolve(null);
          }
        });
      } else {
        resolve(null);
      }
    } catch (e) {
      console.warn('reCAPTCHA error:', e);
      resolve(null);
    }
  });
}

// ============ AUTH FORM ============
$('#authForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const email = fd.get('email').trim().toLowerCase();
  const password = fd.get('password');
  const btn = $('#authSubmit');
  if (btn) btn.disabled = true;

  try {
    const recaptchaToken = await getRecaptchaToken(authMode === 'login' ? 'login' : 'signup');
    console.log('reCAPTCHA Token:', recaptchaToken ? '✅' : '❌');
    
    if (authMode === 'login') {
      await signInWithEmailAndPassword(auth, email, password);
      await reload(auth.currentUser);
      
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
        cnx: 0,
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

// ============ AUTH STATE ============
onAuthStateChanged(auth, async user => {
  console.log('🔐 Auth state changed:', user?.email || 'No user');
  
  if (user) {
    state.user = user;
    
    // HIZLI YÜKLEME - reload bekleme
    const snap = await getDoc(doc(db, COL.users, user.uid));
    if (!snap.exists()) { 
      console.error('❌ User document not found');
      await signOut(auth); 
      return; 
    }
    
    state.profile = snap.data();
    console.log('✅ User loaded:', state.profile.username);
    
    state.unsubProfile?.();
    state.unsubProfile = onSnapshot(doc(db, COL.users, user.uid), s => {
      if (s.exists()) { 
        state.profile = s.data(); 
        updateTopBar(); 
      }
    });

    const landing = $('#landingPage');
    const appShell = $('#appShell');
    
    if (landing) landing.classList.add('hidden');
    if (appShell) {
      appShell.classList.remove('hidden');
      console.log('✅ App shell shown');
    }

    router.init();
    updateTopBar();
    initThreeDotsMenu();
    
    if (!location.hash || location.hash === '#/') {
      location.hash = '#/dashboard';
    } else {
      router.navigate();
    }
    
    if (typeof lucide !== 'undefined') lucide.createIcons();
  } else {
    state.user = null;
    state.profile = null;
    state.unsubProfile?.();

    const landing = $('#landingPage');
    const appShell = $('#appShell');
    
    if (landing) landing.classList.remove('hidden');
    if (appShell) appShell.classList.add('hidden');

    updateTopBar();
  }
});

function updateTopBar() {
  const landingAuthBtns = $('#landingAuthBtns');
  const heroBtns = $('#heroBtns');

  if (!state.profile) {
    // GİRİŞ YAPILMAMIŞ - Login/Signup göster
    if (landingAuthBtns) {
      landingAuthBtns.innerHTML = `
        <button id="openLoginBtn" class="cx-btn cx-btn--ghost" type="button">Log in</button>
        <button id="openSignupBtn" class="cx-btn cx-btn--primary" type="button">Sign up</button>
      `;
      $('#openLoginBtn')?.addEventListener('click', () => openAuthModal('login'));
      $('#openSignupBtn')?.addEventListener('click', () => openAuthModal('register'));
    }
    if (heroBtns) {
      heroBtns.innerHTML = `
        <button id="heroSignupBtn" class="cx-btn cx-btn--primary cx-btn--lg" type="button">Create free account</button>
        <button id="heroLoginBtn" class="cx-btn cx-btn--secondary cx-btn--lg" type="button">Sign in</button>
      `;
      $('#heroLoginBtn')?.addEventListener('click', () => openAuthModal('login'));
      $('#heroSignupBtn')?.addEventListener('click', () => openAuthModal('register'));
    }
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }

  // GİRİŞ YAPILMIŞ - Dashboard butonu göster
  if (landingAuthBtns) {
    landingAuthBtns.innerHTML = `
      <button id="landingDashboardBtn" class="cx-btn cx-btn--primary" type="button">Dashboard</button>
    `;
    $('#landingDashboardBtn')?.addEventListener('click', () => {
      $('#landingPage')?.classList.add('hidden');
      $('#appShell')?.classList.remove('hidden');
      router.go('#/dashboard');
    });
  }
  
  if (heroBtns) {
    heroBtns.innerHTML = `
      <button id="heroDashboardBtn" class="cx-btn cx-btn--primary cx-btn--lg" type="button">Go to Dashboard</button>
    `;
    $('#heroDashboardBtn')?.addEventListener('click', () => {
      $('#landingPage')?.classList.add('hidden');
      $('#appShell')?.classList.remove('hidden');
      router.go('#/dashboard');
    });
  }

  const total = COINS.reduce((s, c) => s + (state.profile.balances[c] || 0) * (COIN_META[c].usd || 0), 0);
  if ($('#topBalance')) $('#topBalance').textContent = fmtUSD(total);
  if ($('#profileName')) $('#profileName').textContent = state.profile.username;
  if ($('#profileAvatar')) $('#profileAvatar').textContent = state.profile.username[0].toUpperCase();

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

$('#logoutBtn')?.addEventListener('click', async () => { await signOut(auth); toast('Signed out', 'info'); });

// ============ THREE DOTS MENU - FIX ============
function initThreeDotsMenu() {
  const btn = $('#threeDotsBtn');
  const menu = $('#threeDotsMenu');
  
  if (!btn || !menu) {
    console.error('❌ Three dots menu elements not found');
    return;
  }
  
  console.log('✅ Three dots menu initialized');
  
  // Tıklama eventi
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    menu.classList.toggle('hidden');
    console.log('Menu toggled:', !menu.classList.contains('hidden'));
  });
  
  // Dışarı tıklama ile kapat
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && !btn.contains(e.target)) {
      menu.classList.add('hidden');
    }
  });
  
  // Logout
  $('#logoutBtnMenu')?.addEventListener('click', async () => {
    await signOut(auth);
    toast('Signed out', 'info');
  });
  
  if (typeof lucide !== 'undefined') lucide.createIcons();
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
    games: renderGames,
    swap: renderSwap
  },
  init() {
    window.addEventListener('hashchange', () => this.navigate());
    const sidebar = $('#sidebar');
    const menuToggle = $('#menuToggle2');
    const drawerBackdrop = $('#sidebarBackdrop');
    const closeDrawer = () => { sidebar?.classList.remove('open'); drawerBackdrop?.classList.remove('visible'); menuToggle?.setAttribute('aria-expanded', 'false'); };
    menuToggle?.addEventListener('click', () => {
      const opening = !sidebar?.classList.contains('open');
      sidebar?.classList.toggle('open', opening);
      drawerBackdrop?.classList.toggle('visible', opening);
      menuToggle.setAttribute('aria-expanded', String(opening));
    });
    $('#sidebarClose')?.addEventListener('click', closeDrawer);
    drawerBackdrop?.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
    if (!location.hash.startsWith('#/')) location.hash = '#/dashboard';
    else this.navigate();
  },
  go(h) { location.hash = h; },
  navigate() {
    const route = location.hash.replace('#/', '') || 'dashboard';
    const fn = this.routes[route];
    if (!fn) { this.go('#/dashboard'); return; }
    $$('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.route === route));

    if(window.innerWidth <= 1024) { $('#sidebar')?.classList.remove('open'); $('#sidebarBackdrop')?.classList.remove('visible'); $('#menuToggle2')?.setAttribute('aria-expanded', 'false'); }

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
  const c = $('#pageContainer');
  if (!c) return;
  const cnx = Number(state.profile.cnx || 0);
  const usd = cnx / 10000;
  const level = Math.max(1, Number(state.profile.level || 1));
  const streak = Math.max(0, Number(state.profile.dailyStreak || 0));
  const otherWallets = Object.values(state.profile.balances || {}).filter(v => Number(v) > 0).length;
  const username = escapeHtml(state.profile.username || 'Member');
  c.innerHTML = `
    <div class="orbit-dashboard page-enter">
      <header class="orbit-welcome">
        <div class="orbit-welcome-copy">
          <div class="orbit-overline"><span class="orbit-live-dot"></span> YOUR REWARDS COMMAND CENTER</div>
          <h1>Good to see you, <span>${username}</span></h1>
          <p>One place for your rewards, missions and next upgrade.</p>
        </div>
        <div class="orbit-welcome-meta">
          <div class="orbit-member-chip"><span class="orbit-avatar-mini"><i data-lucide="user-round"></i></span><span><small>ACCOUNT LEVEL</small><b>Level ${level}</b></span></div>
          <div class="orbit-member-chip"><span class="orbit-streak-mini"><i data-lucide="flame"></i></span><span><small>DAILY STREAK</small><b>${streak} days</b></span></div>
        </div>
      </header>

      <section class="orbit-feature-grid">
        <article class="orbit-balance-card">
          <div class="orbit-balance-glow orbit-glow-one"></div><div class="orbit-balance-glow orbit-glow-two"></div>
          <div class="orbit-balance-top"><div class="orbit-balance-brand"><span class="orbit-cnx-mark">C</span><span><b>COINIX WALLET</b><small>YOUR MAIN REWARDS BALANCE</small></span></div><span class="orbit-wallet-state"><i></i> ACCOUNT WALLET</span></div>
          <div class="orbit-balance-main"><span>Available balance</span><strong>${fmt(cnx, 2)} <em>CNX</em></strong><div class="orbit-balance-usd">≈ $${usd.toFixed(4)} USD <span>·</span> 10,000 CNX = $1</div></div>
          <div class="orbit-balance-bottom"><div class="orbit-balance-hint"><i data-lucide="shield-check"></i> Balance linked to your account</div><button class="orbit-balance-action" onclick="router.go('#/withdraw')">Withdraw <i data-lucide="arrow-up-right"></i></button></div>
          <div class="orbit-coin-orbit orbit-orbit-a"></div><div class="orbit-coin-orbit orbit-orbit-b"></div><div class="orbit-floating-coin">C</div>
        </article>
        <article class="orbit-minex-card">
          <div class="orbit-minex-head"><span class="orbit-minex-icon"><i data-lucide="pickaxe"></i></span><span class="orbit-preview-tag">IN DEVELOPMENT</span></div>
          <div class="orbit-minex-copy"><span class="orbit-card-kicker">THE NEXT REWARD LAYER</span><h2>MINEX <span>Miner Economy</span></h2><p>A second reward track for collecting rigs, unlocking GPUs and building your miner garage.</p></div>
          <div class="orbit-minex-footer"><div><small>MINEX WALLET</small><b>Not activated yet</b></div><a href="/mining.html">Explore preview <i data-lucide="arrow-up-right"></i></a></div>
          <div class="orbit-minex-art"><span class="orbit-chip"><i data-lucide="cpu"></i></span><span class="orbit-circuit circuit-one"></span><span class="orbit-circuit circuit-two"></span></div>
        </article>
      </section>

      <section class="orbit-earn-section">
        <div class="orbit-section-heading"><div><span class="orbit-card-kicker">CHOOSE YOUR NEXT MOVE</span><h2>Earn more with Coinix</h2><p>Jump straight into an activity.</p></div><span class="orbit-section-count">04 <i data-lucide="grid-2x2"></i></span></div>
        <div class="orbit-earn-grid">
          <button class="orbit-earn-tile orbit-faucet" onclick="router.go('#/faucet')"><span class="orbit-earn-icon"><i data-lucide="droplets"></i></span><span class="orbit-earn-label"><b>Faucet</b><small>Claim your rewards</small></span><span class="orbit-earn-arrow"><i data-lucide="arrow-up-right"></i></span><span class="orbit-tile-index">01</span></button>
          <button class="orbit-earn-tile orbit-offers" onclick="router.go('#/offerwall')"><span class="orbit-earn-icon"><i data-lucide="layers-3"></i></span><span class="orbit-earn-label"><b>Offerwalls</b><small>Partner opportunities</small></span><span class="orbit-earn-arrow"><i data-lucide="arrow-up-right"></i></span><span class="orbit-tile-index">02</span></button>
          <button class="orbit-earn-tile orbit-ptc" onclick="router.go('#/ptc')"><span class="orbit-earn-icon"><i data-lucide="mouse-pointer-click"></i></span><span class="orbit-earn-label"><b>PTC Ads</b><small>Browse sponsored ads</small></span><span class="orbit-earn-arrow"><i data-lucide="arrow-up-right"></i></span><span class="orbit-tile-index">03</span></button>
          <button class="orbit-earn-tile orbit-daily" onclick="router.go('#/daily-bonus')"><span class="orbit-earn-icon"><i data-lucide="calendar-check"></i></span><span class="orbit-earn-label"><b>Daily Bonus</b><small>Keep your streak alive</small></span><span class="orbit-earn-arrow"><i data-lucide="arrow-up-right"></i></span><span class="orbit-tile-index">04</span></button>
        </div>
      </section>

      <section class="orbit-bottom-grid">
        <article class="orbit-panel orbit-account-panel"><div class="orbit-panel-heading"><div><span class="orbit-card-kicker">YOUR ACCOUNT</span><h3>Progress snapshot</h3></div><span class="orbit-panel-icon"><i data-lucide="chart-no-axes-combined"></i></span></div><div class="orbit-progress-list"><div class="orbit-progress-row"><span class="orbit-progress-symbol purple"><i data-lucide="badge-check"></i></span><span><small>Membership level</small><b>Level ${level}</b></span><span class="orbit-progress-value">LVL</span></div><div class="orbit-progress-row"><span class="orbit-progress-symbol orange"><i data-lucide="flame"></i></span><span><small>Daily streak</small><b>${streak} days</b></span><span class="orbit-progress-value">DAY</span></div><div class="orbit-progress-row"><span class="orbit-progress-symbol teal"><i data-lucide="wallet"></i></span><span><small>Other funded wallets</small><b>${otherWallets} assets</b></span><span class="orbit-progress-value">ASSET</span></div></div><a class="orbit-panel-link" href="#/transactions">View transaction history <i data-lucide="arrow-right"></i></a></article>
        <article class="orbit-panel orbit-garage-panel"><div class="orbit-garage-visual"><div class="orbit-garage-ring ring-a"></div><div class="orbit-garage-ring ring-b"></div><span class="orbit-garage-gpu"><i data-lucide="cpu"></i></span><span class="orbit-garage-spark spark-a">✦</span><span class="orbit-garage-spark spark-b">✧</span></div><div class="orbit-garage-copy"><span class="orbit-card-kicker">BUILD YOUR COLLECTION</span><h3>Miner Garage</h3><p>Preview the GPU collection and the upcoming MINEX progression system.</p><a class="orbit-garage-link" href="/mining.html">Enter Miner Garage <i data-lucide="arrow-up-right"></i></a><small>Preview only · mining rewards are not active</small></div></article>
      </section>
      <footer class="orbit-dashboard-footer"><span>COINIXFAUCET</span><span>Earn · Collect · Level up</span><a href="/faq/">Need help? Visit FAQ</a></footer>
    </div>`;
  if (typeof lucide !== 'undefined') lucide.createIcons();
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
  const p = state.profile || {};
  const c = $('#pageContainer');
  if (!c) return;
  c.innerHTML = `
    <div class="nova-page page-enter">
      <div class="nova-page-heading"><div><span class="nova-section-kicker">DAILY REWARDS</span><h1>Daily Bonus</h1><p>Build a steady habit and keep your reward streak going.</p></div><span class="nova-status-pill"><i data-lucide="calendar-check"></i> Daily check-in</span></div>
      <section class="nova-daily-layout">
        <div class="nova-daily-card">
          <div class="nova-daily-art"><span class="nova-daily-orbit"></span><span class="nova-daily-gift"><i data-lucide="gift"></i></span><span class="nova-daily-spark spark-left"></span><span class="nova-daily-spark spark-right"></span></div>
          <span class="nova-section-kicker">YOUR CURRENT STREAK</span>
          <div class="nova-daily-count"><strong>${Number(p.dailyStreak || 0)}</strong><span>days</span></div>
          <p>Come back each day to maintain your streak. Your best recorded streak is <b>${Number(p.highestStreak || 0)} days</b>.</p>
          <button id="claimBonusBtn" class="btn-primary nova-daily-button"><i data-lucide="gift"></i> Claim daily bonus</button>
          <small class="nova-daily-caption"><i data-lucide="info"></i> Eligibility is checked by the account reward service.</small>
        </div>
        <aside class="nova-daily-side">
          <div class="nova-daily-side-icon"><i data-lucide="calendar-days"></i></div>
          <span class="nova-section-kicker">MAKE IT A ROUTINE</span>
          <h2>One visit at a time.</h2>
          <p>Check in regularly, watch your streak grow and keep your rewards together in your Coinix account.</p>
          <div class="nova-daily-side-row"><i data-lucide="check-circle-2"></i><span><b>Daily activity</b><small>Your account tracks eligible check-ins.</small></span></div>
          <div class="nova-daily-side-row"><i data-lucide="trophy"></i><span><b>Personal best</b><small>Your highest streak stays visible here.</small></span></div>
        </aside>
      </section>
    </div>
  `;
  if (typeof lucide !== 'undefined') lucide.createIcons();
  $('#claimBonusBtn')?.addEventListener('click', async () => {
    const button = $('#claimBonusBtn');
    if (button) button.disabled = true;
    try {
      const data = await apiCall('/api/daily-bonus', { method: 'POST' });
      toast(`Day ${data.day} bonus: ${fmtUSD(data.usdValue)}`, 'success');
      if (state.profile) state.profile.dailyStreak = data.day;
      renderDailyBonus();
    } catch (e) {
      toast(e.message, 'error');
      if (button) button.disabled = false;
    }
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
  c.innerHTML = `
    <div class="space-y-6 page-enter">
      <h1 class="text-3xl font-bold text-zinc-900 dark:text-white">PTC Ads</h1>
      <p class="text-zinc-500">Review sponsored campaigns and follow the listed completion timer. Rewards are credited after successful completion.</p>
      <div class="grid md:grid-cols-2 gap-6">
        <div class="glass-card rounded-2xl p-6 text-center">
          <div class="w-16 h-16 rounded-full bg-primary-500/20 mx-auto mb-4 flex items-center justify-center">📢</div>
          <h3 class="font-bold text-lg mb-2">Ad #1</h3>
          <p class="text-sm text-zinc-500 mb-4">Earn 5 CNX</p>
          <button onclick="viewPtcAd('ptc1')" class="btn-primary w-full">View Ad</button>
        </div>
      </div>
    </div>
  `;
}

window.viewPtcAd = async (adId) => {
  try {
    const data = await apiCall('/api/ptc/view', { method: 'POST', body: JSON.stringify({ adId }) });
    window.open(data.url, '_blank');
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
        <h1 class="text-3xl font-bold text-zinc-900 dark:text-white">Withdrawals</h1>
        <p class="text-zinc-500 mt-1">Minimum $0.03 · Requests are processed through the configured payout workflow</p>
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
      <div class="w-14 h-14 rounded-full flex items-center justify-center font-black text-white text-2xl mb-4 shadow-lg" style="background: linear-gradient(135deg, ${m.color}, ${m.color}80);">${coin[0]}</div>
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
      
      <div class="glass-card rounded-2xl p-6">
        <h3 class="font-bold text-lg mb-4">Redeem Promo Code</h3>
        <div class="flex gap-2">
          <input type="text" id="promoCodeInput" placeholder="Enter code..." class="input-field flex-1" />
          <button onclick="redeemPromo()" class="btn-primary">Redeem</button>
        </div>
      </div>
      
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

window.redeemPromo = async () => {
  const code = $('#promoCodeInput')?.value.trim();
  if (!code) {
    toast('Enter a code', 'error');
    return;
  }
  
  try {
    const data = await apiCall('/api/promo/redeem', { 
      method: 'POST', 
      body: JSON.stringify({ code }) 
    });
    toast(data.message || `Redeemed ${data.reward} CNX!`, 'success');
    $('#promoCodeInput').value = '';
  } catch (e) {
    toast(e.message, 'error');
  }
};

function renderOfferwall() {
  const frame = $('#offerwallFrame');
  if (frame && state.profile) {
    frame.src = `https://offerwall.me/offerwall/26tgnfk7s0fce1tscysrcpfeesr398/${state.profile.uid}`;
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
  
  const gameUrls = {
    dice: 'https://www.freeonlinegames.com/embed/dice-game'
  };
  
  frame.src = gameUrls[game] || '';
  container.classList.remove('hidden');
  container.scrollIntoView({ behavior: 'smooth' });
};

// ============ SWAP ============
let swapRates = null;

async function loadSwapRates() {
  try {
    const res = await fetch('/api/swap/rates');
    const data = await res.json();
    if (data.success) {
      swapRates = data.rates;
      updateSwapUI();
    }
  } catch (e) {
    console.error('Swap rates error:', e);
  }
}

function updateSwapUI() {
  if (!swapRates) return;
  
  const fromCoin = $('#swapFromCoin')?.value || 'CNX';
  const toCoin = $('#swapToCoin')?.value || 'PEPE';
  const fromAmount = parseFloat($('#swapFromAmount')?.value) || 0;
  
  const fromPrice = swapRates[fromCoin]?.usd || 0;
  const toPrice = swapRates[toCoin]?.usd || 0;
  
  if (fromPrice && toPrice && fromAmount > 0) {
    const fromUSD = fromAmount * fromPrice;
    const toAmount = fromUSD / toPrice;
    const fee = toAmount * 0.02;
    const finalAmount = toAmount - fee;
    
    if ($('#swapRate')) $('#swapRate').textContent = `1 ${fromCoin} = ${(fromPrice / toPrice).toFixed(6)} ${toCoin}`;
    if ($('#swapFinalAmount')) $('#swapFinalAmount').textContent = `${finalAmount.toFixed(6)} ${toCoin}`;
  } else {
    if ($('#swapRate')) $('#swapRate').textContent = '—';
    if ($('#swapFinalAmount')) $('#swapFinalAmount').textContent = '—';
  }
}

function renderSwap() {
  loadSwapRates();
  
  $('#swapFromCoin')?.addEventListener('change', updateSwapUI);
  $('#swapToCoin')?.addEventListener('change', updateSwapUI);
  $('#swapFromAmount')?.addEventListener('input', updateSwapUI);
  
  $('#swapReverseBtn')?.addEventListener('click', () => {
    const fromCoin = $('#swapFromCoin');
    const toCoin = $('#swapToCoin');
    const temp = fromCoin.value;
    fromCoin.value = toCoin.value;
    toCoin.value = temp;
    updateSwapUI();
  });
  
  $('#swapExecuteBtn')?.addEventListener('click', async () => {
    const fromCoin = $('#swapFromCoin')?.value;
    const toCoin = $('#swapToCoin')?.value;
    const amount = parseFloat($('#swapFromAmount')?.value);
    
    if (!fromCoin || !toCoin || !amount || amount <= 0) {
      toast('Invalid swap parameters', 'error');
      return;
    }
    
    if (fromCoin === toCoin) {
      toast('Cannot swap same coin', 'error');
      return;
    }
    
    if (!confirm(`Swap ${amount} ${fromCoin} to ${toCoin}?`)) return;
    
    try {
      const data = await apiCall('/api/swap', { 
        method: 'POST', 
        body: JSON.stringify({ fromCoin, toCoin, amount }) 
      });
      toast(`Swapped ${data.fromAmount} ${data.fromCoin} to ${data.toAmount.toFixed(6)} ${data.toCoin}!`, 'success');
      $('#swapFromAmount').value = '';
      updateSwapUI();
    } catch (e) {
      toast(e.message, 'error');
    }
  });
  
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ============ INIT ============
document.addEventListener('DOMContentLoaded', async () => {
  // ADBLOCK DETECTION
  const isAdBlocked = await detectAdBlock();
  
  if (!isAdBlocked) {
    if (typeof lucide !== 'undefined') lucide.createIcons();
    initLanding();
  }
  
  console.log('⚡ CoinixFaucet ready');
});

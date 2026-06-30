import { auth, db, COL, COINS, COIN_META } from './firebase-config.js';
import {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, updatePassword, sendEmailVerification, sendPasswordResetEmail,
  reload as reloadUser
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, collection, addDoc, query, where,
  orderBy, limit, getDocs, onSnapshot, serverTimestamp,
  increment, runTransaction, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const BACKEND_URL = 'https://coinixfaucet-backend.onrender.com';

// UTILS
const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];
const fmt = (n, d = 4) => Number(n || 0).toFixed(d);
const fmtUSD = n => '$' + Number(n || 0).toFixed(4);
const uid = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const now = () => Date.now();
const escapeHtml = s => String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

function toast(msg, type = 'info', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icon = type === 'success' ? 'check-circle' : type === 'error' ? 'alert-circle' : type === 'warning' ? 'alert-triangle' : 'info';
  el.innerHTML = `<i data-lucide="${icon}" class="w-5 h-5"></i><div class="flex-1 text-sm">${msg}</div>`;
  $('#toastRoot').appendChild(el);
  lucide.createIcons({ nodes: [el] });
  setTimeout(() => { el.style.animation = 'slideIn 0.3s reverse'; setTimeout(() => el.remove(), 300); }, duration);
}

function modal({ title, message, primary, secondary, onPrimary, onSecondary }) {
  const root = $('#modalRoot');
  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.innerHTML = `<div class="modal-content"><h3 class="text-xl font-bold mb-2">${title}</h3><div class="text-sm text-zinc-400 mb-6">${message}</div><div class="flex gap-3">${secondary ? `<button class="btn-ghost flex-1" data-act="secondary">${secondary}</button>` : ''}${primary ? `<button class="btn-primary flex-1" data-act="primary">${primary}</button>` : ''}</div></div>`;
  root.appendChild(el);
  el.addEventListener('click', e => {
    if (e.target === el) { el.remove(); onSecondary?.(); }
    const act = e.target.dataset.act;
    if (act === 'primary') { el.remove(); onPrimary?.(); }
    if (act === 'secondary') { el.remove(); onSecondary?.(); }
  });
  lucide.createIcons({ nodes: [el] });
  return el;
}

function timeAgo(ts) {
  if (!ts) return 'just now';
  const t = ts.toDate ? ts.toDate().getTime() : ts;
  const s = Math.floor((now() - t) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

// STATE
const state = { user: null, profile: null, unsubProfile: null, txFilter: 'all' };
let recaptchaToken = null;

// ========== LANDING ==========
function initLanding() {
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

  const urlRef = new URLSearchParams(location.search).get('ref');
  if (urlRef) {
    openAuthModal('register');
    setTimeout(() => { const inp = $('input[name="referral"]'); if (inp) inp.value = urlRef; }, 100);
  }
}

function renderLandingCoins() {
  const grid = $('#landingCoinsGrid');
  if (!grid) return;
  grid.innerHTML = '';
  COINS.forEach(coin => {
    const m = COIN_META[coin];
    const card = document.createElement('div');
    card.className = 'coin-landing-card relative';
    card.style.setProperty('--coin-color', m.color + '40');
    card.innerHTML = `
      <div class="relative">
        <div class="flex items-center justify-between mb-4">
          <div class="flex items-center gap-3">
            <div class="w-14 h-14 rounded-2xl flex items-center justify-center" style="background:${m.color}20;border:1px solid ${m.color}40">
              <img src="coins/${coin.toLowerCase()}.svg" class="w-8 h-8" onerror="this.outerHTML='<div style=\\'font-size:24px;font-weight:900;color:${m.color}\\'>${coin[0]}</div>'"/>
            </div>
            <div><div class="font-bold text-lg">${m.name}</div><div class="text-xs text-zinc-500">${coin}</div></div>
          </div>
          <span class="badge badge-green"><span class="w-1.5 h-1.5 rounded-full bg-green-400"></span>Active</span>
        </div>
        <div class="space-y-2 text-sm">
          <div class="flex justify-between"><span class="text-zinc-500">Min Withdraw</span><span class="font-medium">$0.03</span></div>
          <div class="flex justify-between"><span class="text-zinc-500">Payout</span><span class="text-green-400 font-medium">Instant · FaucetPay</span></div>
        </div>
      </div>`;
    grid.appendChild(card);
  });
}

async function loadLiveStats() {
  try {
    const usersSnap = await getDocs(collection(db, COL.users));
    $('#statUsers').textContent = usersSnap.size.toLocaleString();
    
    const claimsSnap = await getDocs(collection(db, COL.claims));
    $('#statClaims').textContent = claimsSnap.size.toLocaleString();
    
    let totalUSD = 0;
    claimsSnap.forEach(d => { totalUSD += d.data().usdValue || 0; });
    const avgClaim = claimsSnap.size > 0 ? totalUSD / claimsSnap.size : 0;
    $('#statAvg').textContent = fmtUSD(avgClaim);
    $('#statPaid').textContent = fmtUSD(totalUSD);
    $('#statRef').textContent = fmtUSD(totalUSD * 0.2);
    
    // Hero online (simulated based on users)
    const online = Math.min(usersSnap.size, Math.floor(usersSnap.size * 0.15) + 50);
    $('#heroOnline').textContent = online.toLocaleString();
  } catch (error) {
    console.error('Stats error:', error);
  }
}

async function loadLiveWithdraws() {
  const table = $('#withdrawsBody');
  const loading = $('#withdrawsLoading');
  if (!table) return;
  
  try {
    const snap = await getDocs(query(collection(db, COL.transactions), where('type', '==', 'withdraw'), orderBy('createdAt', 'desc'), limit(20)));
    if (loading) loading.style.display = 'none';
    table.innerHTML = '';
    
    if (snap.empty) {
      table.innerHTML = '<tr><td colspan="6" class="p-8 text-center text-zinc-500">No withdrawals yet</td></tr>';
      return;
    }
    
    // Get usernames for all users
    const userIds = [...new Set(snap.docs.map(d => d.data().userId))];
    const userNames = {};
    for (const uid of userIds) {
      const uSnap = await getDoc(doc(db, COL.users, uid));
      if (uSnap.exists()) userNames[uid] = uSnap.data().username;
    }
    
    snap.forEach(d => {
      const t = d.data();
      const username = userNames[t.userId] || 'User' + (t.userId?.slice(0, 4) || '');
      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="p-4"><div class="flex items-center gap-2"><div class="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-cyan-500 flex items-center justify-center text-xs font-bold">${username[0].toUpperCase()}</div><span class="font-medium text-sm">${escapeHtml(username)}</span></div></td>
        <td class="p-4"><div class="flex items-center gap-2"><img src="coins/${(t.coin || 'btc').toLowerCase()}.svg" class="w-5 h-5" onerror="this.style.display='none'"/><span class="text-sm font-medium">${t.coin || 'BTC'}</span></div></td>
        <td class="p-4 font-mono text-sm text-green-400">${fmt(t.amount || 0)}</td>
        <td class="p-4 text-sm text-zinc-400">${fmtUSD((t.amount || 0) * (COIN_META[t.coin]?.usd || 0))}</td>
        <td class="p-4 text-xs text-zinc-500">${timeAgo(t.createdAt)}</td>
        <td class="p-4"><span class="badge badge-green">Completed</span></td>
      `;
      table.appendChild(row);
    });
  } catch (error) {
    console.error('Withdrawals error:', error);
    if (loading) { loading.textContent = 'Error loading data'; loading.classList.add('text-red-400'); }
  }
}

// ========== AUTH MODAL ==========
let authMode = 'login';

function openAuthModal(mode = 'login') {
  authMode = mode;
  updateAuthModalUI();
  $('#authModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  
  if (typeof grecaptcha !== 'undefined') {
    grecaptcha.enterprise.ready(async () => {
      try {
        recaptchaToken = await grecaptcha.enterprise.execute('6LctET4tAAAAAAGcqEdyQbF_gcTH57Dnxztlv2hN', { action: 'auth' });
        $('#authSubmit').disabled = false;
      } catch (error) {
        console.error('reCAPTCHA error:', error);
      }
    });
  }
}

function closeAuthModal() {
  $('#authModal').classList.add('hidden');
  document.body.style.overflow = '';
  recaptchaToken = null;
}

function updateAuthModalUI() {
  $$('[data-auth-tab]').forEach(b => b.classList.toggle('active', b.dataset.authTab === authMode));
  $('#usernameField').classList.toggle('hidden', authMode !== 'register');
  $('#referralField').classList.toggle('hidden', authMode !== 'register');
  $('#authBtnText').textContent = authMode === 'login' ? 'Sign In' : 'Create Account';
  $('#authModalTitle').textContent = authMode === 'login' ? 'Welcome Back' : 'Create Account';
  $('#authModalSubtitle').textContent = authMode === 'login' ? 'Sign in to continue earning crypto' : 'Join thousands earning free crypto';
  $('#forgotPasswordLink').classList.toggle('hidden', authMode !== 'login');
}

$('#closeAuthModal')?.addEventListener('click', closeAuthModal);
$('.auth-modal-backdrop', $('#authModal'))?.addEventListener('click', closeAuthModal);
$$('[data-auth-tab]').forEach(btn => {
  btn.addEventListener('click', () => { authMode = btn.dataset.authTab; updateAuthModalUI(); });
});

// ========== FORGOT PASSWORD ==========
$('#openForgotPassword')?.addEventListener('click', () => {
  closeAuthModal();
  $('#forgotPasswordModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
});

$('#closeForgotPassword')?.addEventListener('click', () => {
  $('#forgotPasswordModal').classList.add('hidden');
  document.body.style.overflow = '';
});

$('#backToLogin')?.addEventListener('click', () => {
  $('#forgotPasswordModal').classList.add('hidden');
  openAuthModal('login');
});

$('#forgotPasswordForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('#forgotPasswordForm').email.value.trim().toLowerCase();
  const btn = $('#forgotPasswordSubmit');
  const txt = $('#forgotBtnText');
  btn.disabled = true;
  txt.textContent = 'Sending...';
  
  try {
    await sendPasswordResetEmail(auth, email);
    $('#forgotPasswordSuccess').classList.remove('hidden');
    toast('Password reset link sent to ' + email, 'success');
    setTimeout(() => {
      $('#forgotPasswordModal').classList.add('hidden');
      $('#forgotPasswordSuccess').classList.add('hidden');
      $('#forgotPasswordForm').reset();
      document.body.style.overflow = '';
    }, 3000);
  } catch (err) {
    console.error(err);
    const msg = err.code === 'auth/user-not-found' ? 'No account with this email' :
                err.code === 'auth/invalid-email' ? 'Invalid email address' :
                err.code === 'auth/too-many-requests' ? 'Too many requests. Try again later.' :
                err.message;
    toast(msg, 'error');
  } finally {
    btn.disabled = false;
    txt.textContent = 'Send Reset Link';
  }
});

// ========== AUTH FORM ==========
$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  
  if (!recaptchaToken) {
    toast('Please complete security verification', 'error');
    return;
  }
  
  // Verify reCAPTCHA on backend
  try {
    const verifyResponse = await fetch(`${BACKEND_URL}/api/verify-recaptcha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: recaptchaToken, action: 'auth' })
    });
    const verifyData = await verifyResponse.json();
    if (!verifyData.success) {
      toast('Security check failed', 'error');
      return;
    }
  } catch (error) {
    console.error('reCAPTCHA verification error:', error);
  }
  
  const fd = new FormData(e.target);
  const email = fd.get('email').trim().toLowerCase();
  const password = fd.get('password');
  const btn = $('#authSubmit');
  const txt = $('#authBtnText');
  btn.disabled = true;
  txt.textContent = 'Please wait...';

  try {
    if (authMode === 'login') {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      
      // Reload user to get fresh emailVerified status
      await reloadUser(cred.user);
      
      // Check email verification
      if (!cred.user.emailVerified) {
        await signOut(auth);
        toast('Please verify your email first', 'warning');
        showEmailVerificationModal(email);
        closeAuthModal();
        return;
      }
      
      toast('Welcome back!', 'success');
      closeAuthModal();
    } else {
      const username = fd.get('username').trim();
      const referral = fd.get('referral').trim().toUpperCase();
      if (username.length < 3) throw new Error('Username must be at least 3 characters');
      
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      
      // Send email verification
      await sendEmailVerification(cred.user, {
        url: 'https://coinixfaucet.mine.bz/',
        handleCodeInApp: false
      });
      
      const refCode = uid();
      const profile = {
        uid: cred.user.uid, username, email,
        country: 'Unknown', timezone: 'UTC', language: 'en',
        faucetpayEmail: '',
        referralCode: refCode, referredBy: referral || null,
        balances: Object.fromEntries(COINS.map(c => [c, 0])),
        totalWithdrawn: 0, referralEarnings: 0, referralCount: 0,
        totalClaims: 0, todayClaims: 0, lastClaimAt: 0,
        lastDailyBonus: 0, dailyStreak: 0, highestStreak: 0, claimedDays: [],
        twoFA: false, notifications: true, level: 1, xp: 0,
        emailVerified: false,
        createdAt: serverTimestamp()
      };
      await setDoc(doc(db, COL.users, cred.user.uid), profile);

      if (referral) {
        const snap = await getDocs(query(collection(db, COL.users), where('referralCode', '==', referral), limit(1)));
        if (!snap.empty) {
          const referrer = snap.docs[0];
          await addDoc(collection(db, COL.referrals), { referrerId: referrer.id, referredId: cred.user.uid, createdAt: serverTimestamp() });
          await updateDoc(doc(db, COL.users, referrer.id), { referralCount: increment(1) });
        }
      }
      
      toast('Account created! Check your email to verify.', 'success');
      closeAuthModal();
      showEmailVerificationModal(email);
      
      // Sign out until verified
      await signOut(auth);
    }
  } catch (err) {
    console.error(err);
    const msg = err.code === 'auth/email-already-in-use' ? 'Email already registered' :
                err.code === 'auth/invalid-email' ? 'Invalid email address' :
                err.code === 'auth/weak-password' ? 'Password must be at least 6 characters' :
                err.code === 'auth/invalid-credential' ? 'Invalid email or password' :
                err.code === 'auth/user-not-found' ? 'No account with this email' :
                err.code === 'auth/wrong-password' ? 'Incorrect password' :
                err.code === 'auth/too-many-requests' ? 'Too many attempts. Try again later.' :
                err.message;
    toast(msg, 'error');
    btn.disabled = false;
    txt.textContent = authMode === 'login' ? 'Sign In' : 'Create Account';
  }
});

// ========== EMAIL VERIFICATION MODAL ==========
function showEmailVerificationModal(email) {
  $('#verificationEmail').textContent = email;
  $('#emailVerificationModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function hideEmailVerificationModal() {
  $('#emailVerificationModal').classList.add('hidden');
  document.body.style.overflow = '';
}

$('#resendVerificationBtn')?.addEventListener('click', async () => {
  const btn = $('#resendVerificationBtn');
  const txt = $('#resendBtnText');
  btn.disabled = true;
  txt.textContent = 'Sending...';
  
  try {
    // Need to sign in temporarily to resend
    const email = $('#verificationEmail').textContent;
    // We can't resend without password, so prompt user
    toast('Please sign in again to resend verification email', 'info');
    hideEmailVerificationModal();
    openAuthModal('login');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    txt.textContent = 'Resend Verification Email';
  }
});

$('#checkVerificationBtn')?.addEventListener('click', async () => {
  const btn = $('#checkVerificationBtn');
  btn.disabled = true;
  
  try {
    // User needs to sign in to check
    toast('Please sign in to check verification status', 'info');
    hideEmailVerificationModal();
    openAuthModal('login');
  } finally {
    btn.disabled = false;
  }
});

$('#logoutFromVerification')?.addEventListener('click', async () => {
  await signOut(auth);
  hideEmailVerificationModal();
  toast('Logged out', 'info');
});

// ========== AUTH STATE ==========
onAuthStateChanged(auth, async user => {
  if (user) {
    state.user = user;
    
    // Check email verification
    await reloadUser(user);
    if (!user.emailVerified) {
      showEmailVerificationModal(user.email);
      return;
    }
    
    const snap = await getDoc(doc(db, COL.users, user.uid));
    if (!snap.exists()) { toast('Profile not found', 'error'); await signOut(auth); return; }
    state.profile = snap.data();

    state.unsubProfile?.();
    state.unsubProfile = onSnapshot(doc(db, COL.users, user.uid), s => {
      if (s.exists()) { state.profile = s.data(); updateTopBar(); }
    });

    $('#landingPage').classList.add('hidden');
    $('#appShell').classList.remove('hidden');
    lucide.createIcons();
    router.init();
  } else {
    state.user = null; state.profile = null; state.unsubProfile?.();
    $('#landingPage').classList.remove('hidden');
    $('#appShell').classList.add('hidden');
    hideEmailVerificationModal();
    lucide.createIcons();
  }
});

function updateTopBar() {
  if (!state.profile) return;
  const totalUSD = COINS.reduce((sum, c) => {
    const bal = state.profile.balances[c] || 0;
    return sum + bal * (COIN_META[c].usd || 0);
  }, 0);
  $('#topBalance').textContent = fmtUSD(totalUSD);
  $('#profileName').textContent = state.profile.username;
  $('#profileAvatar').textContent = state.profile.username[0].toUpperCase();
}

$('#logoutBtn')?.addEventListener('click', async () => { await signOut(auth); toast('Signed out', 'info'); });

// ========== ROUTER ==========
const router = {
  routes: {
    dashboard: renderDashboard, faucet: renderFaucet,
    'daily-bonus': renderDailyBonus, leaderboard: renderLeaderboard,
    referrals: renderReferrals, withdraw: renderWithdraw,
    transactions: renderTransactions, settings: renderSettings
  },
  init() {
    window.addEventListener('hashchange', () => this.navigate());
    $('#menuToggle')?.addEventListener('click', () => $('#sidebar').classList.toggle('open'));
    if (!location.hash.startsWith('#/')) location.hash = '#/dashboard';
    else this.navigate();
  },
  go(hash) { location.hash = hash; },
  navigate() {
    const route = location.hash.replace('#/', '') || 'dashboard';
    const fn = this.routes[route];
    if (!fn) { this.go('#/dashboard'); return; }
    $$('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.route === route));
    const container = $('#pageContainer');
    container.innerHTML = '';
    const tpl = $(`#tpl-${route}`);
    if (tpl) container.appendChild(tpl.content.cloneNode(true));
    container.classList.remove('page-enter');
    void container.offsetWidth;
    container.classList.add('page-enter');
    lucide.createIcons();
    fn();
    $('#sidebar').classList.remove('open');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
};
window.router = router;

// ========== DASHBOARD ==========
async function renderDashboard() {
  if (!state.profile) return;
  const p = state.profile;
  const totalUSD = COINS.reduce((s, c) => s + (p.balances[c] || 0) * (COIN_META[c].usd || 0), 0);
  
  const container = $('#pageContainer');
  container.innerHTML = `
    <div class="space-y-6">
      <div class="relative overflow-hidden rounded-3xl p-8 gradient-border">
        <div class="absolute inset-0 bg-gradient-to-br from-purple-600/20 via-blue-600/10 to-cyan-500/20"></div>
        <div class="relative">
          <p class="text-sm text-zinc-400 mb-1">Welcome back,</p>
          <h1 class="text-3xl sm:text-4xl font-bold mb-6">${escapeHtml(p.username)}</h1>
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div class="stat-card"><div class="stat-label">Main Balance</div><div class="stat-value">${fmtUSD(totalUSD)}</div></div>
            <div class="stat-card"><div class="stat-label">Total Claims</div><div class="stat-value">${p.totalClaims || 0}</div></div>
            <div class="stat-card"><div class="stat-label">Referral Earnings</div><div class="stat-value text-purple-400">${fmtUSD(p.referralEarnings || 0)}</div></div>
            <div class="stat-card"><div class="stat-label">Total Withdrawn</div><div class="stat-value text-cyan-400">${fmtUSD(p.totalWithdrawn || 0)}</div></div>
          </div>
          <div class="mt-6 flex flex-wrap gap-3">
            <button onclick="router.go('#/faucet')" class="btn-primary"><i data-lucide="droplets" class="w-4 h-4"></i>Claim Now</button>
            <button onclick="router.go('#/withdraw')" class="btn-ghost"><i data-lucide="wallet" class="w-4 h-4"></i>Withdraw</button>
          </div>
        </div>
      </div>
    </div>`;
  lucide.createIcons();
}

// ========== FAUCET ==========
let faucetInterval = null;
function renderFaucet() {
  $('#claimBtn').addEventListener('click', handleClaim);
  startFaucetCountdown();
}

function startFaucetCountdown() {
  clearInterval(faucetInterval);
  const btn = $('#claimBtn');
  const cd = $('#faucetCountdown');
  const tick = () => {
    const elapsed = now() - (state.profile.lastClaimAt || 0);
    const remain = Math.max(0, 60000 - elapsed);
    if (remain <= 0) { cd.textContent = '00:00'; btn.disabled = false; }
    else {
      const m = Math.floor(remain / 60000);
      const s = Math.floor((remain % 60000) / 1000);
      cd.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      btn.disabled = true;
    }
  };
  tick();
  faucetInterval = setInterval(tick, 1000);
}

async function handleClaim() {
  const btn = $('#claimBtn');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const coin = COINS[Math.floor(Math.random() * COINS.length)];
    const [min, max] = COIN_META[coin].reward;
    const amount = +(min + Math.random() * (max - min)).toFixed(8);
    const usdValue = +(amount * (COIN_META[coin].usd || 0)).toFixed(6);

    const userRef = doc(db, COL.users, state.user.uid);
    await runTransaction(db, async tx => {
      const snap = await tx.get(userRef);
      if (!snap.exists()) throw new Error('User not found');
      const data = snap.data();
      if (now() - (data.lastClaimAt || 0) < 55000) throw new Error('Please wait before claiming again');
      const newBal = { ...data.balances, [coin]: (data.balances[coin] || 0) + amount };
      tx.update(userRef, { balances: newBal, lastClaimAt: now(), totalClaims: increment(1), xp: increment(5) });
    });

    await addDoc(collection(db, COL.claims), { userId: state.user.uid, coin, amount, usdValue, createdAt: serverTimestamp() });
    await addDoc(collection(db, COL.transactions), { userId: state.user.uid, type: 'claim', coin, amount, usdValue, status: 'completed', createdAt: serverTimestamp() });

    toast(`Claimed ${fmt(amount)} ${coin}!`, 'success');
    startFaucetCountdown();
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
  }
}

// ========== OTHER PAGES ==========
function renderDailyBonus() { $('#pageContainer').innerHTML = '<div class="glass-card p-8 rounded-3xl"><h1 class="text-3xl font-bold mb-4">Daily Bonus</h1><p class="text-zinc-400">Claim every day to grow your streak!</p></div>'; }
function renderLeaderboard() { $('#pageContainer').innerHTML = '<div class="glass-card p-8 rounded-3xl"><h1 class="text-3xl font-bold mb-4">Leaderboard</h1><p class="text-zinc-400">Top earners this month.</p></div>'; }
function renderReferrals() { $('#pageContainer').innerHTML = '<div class="glass-card p-8 rounded-3xl"><h1 class="text-3xl font-bold mb-4">Referrals</h1><p class="text-zinc-400">Earn 20% from referrals.</p></div>'; }
function renderWithdraw() { $('#pageContainer').innerHTML = '<div class="glass-card p-8 rounded-3xl"><h1 class="text-3xl font-bold mb-4">Withdraw</h1><p class="text-zinc-400">Minimum $0.03 · Instant via FaucetPay</p></div>'; }
function renderTransactions() { $('#pageContainer').innerHTML = '<div class="glass-card p-8 rounded-3xl"><h1 class="text-3xl font-bold mb-4">Transactions</h1><p class="text-zinc-400">Your transaction history.</p></div>'; }
function renderSettings() { $('#pageContainer').innerHTML = '<div class="glass-card p-8 rounded-3xl"><h1 class="text-3xl font-bold mb-4">Settings</h1><p class="text-zinc-400">Manage your account.</p></div>'; }

// ========== INIT ==========
lucide.createIcons();
initLanding();
console.log('⚡ CoinixFaucet ready with Email Verification + Password Reset');

const API_URL = 'https://coinixfaucet-backend.onrender.com'; // Kendi backend URL'n

// Token al (Firebase Auth)
const getToken = async () => {
  const user = auth.currentUser;
  if (!user) throw new Error('Not authenticated');
  return await user.getIdToken();
};

// API çağrıları
async function apiCall(endpoint, options = {}) {
  const token = await getToken();
  const res = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...options.headers
    }
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.message);
  return data;
}

// Claim (server-side fiyat/ödül)
async function claimFaucet() {
  try {
    const data = await apiCall('/api/claim', {
      method: 'POST',
      body: JSON.stringify({ recaptchaToken })
    });
    toast(`Claimed ${data.amount} ${data.coin}!`, 'success');
    return data;
  } catch (err) {
    toast(err.message, 'error');
    throw err;
  }
}

// Withdraw (server-side kontrol)
async function withdraw(coin) {
  try {
    const data = await apiCall('/api/withdraw', {
      method: 'POST',
      body: JSON.stringify({ coin })
    });
    toast(`Withdrawal submitted: ${data.amount} ${data.coin}`, 'success');
    return data;
  } catch (err) {
    toast(err.message, 'error');
    throw err;
  }
}

// Dashboard stats
async function loadDashboard() {
  try {
    const data = await apiCall('/api/dashboard');
    return data.stats;
  } catch (err) {
    console.error(err);
    return null;
  }
}

// Settings update
async function updateSettings(updates) {
  try {
    const data = await apiCall('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(updates)
    });
    toast('Settings saved!', 'success');
    return data;
  } catch (err) {
    toast(err.message, 'error');
    throw err;
  }
}

// Coin prices (read-only, server'dan)
async function loadPrices() {
  try {
    const res = await fetch(`${API_URL}/api/prices`);
    const data = await res.json();
    return data;
  } catch (err) {
    console.error(err);
    return null;
  }
}

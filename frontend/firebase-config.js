import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// KENDİ FIREBASE YAPILANDIRMANIZI GİRİN
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export const COL = {
  users: 'users',
  transactions: 'transactions',
  claims: 'claims',
  referrals: 'referrals',
  promo_codes: 'promo_codes',
  blocked_ips: 'blocked_ips',
  global: 'global'
};

export const COINS = ['PEPE', 'DOGE', 'DGB', 'FEY', 'POL'];
export const COIN_META = {
  PEPE: { name: 'Pepe', color: '#4ade80', usd: 0.000008, min: 0.03 },
  DOGE: { name: 'Dogecoin', color: '#facc15', usd: 0.15, min: 0.03 },
  DGB: { name: 'DigiByte', color: '#60a5fa', usd: 0.01, min: 0.03 },
  FEY: { name: 'Feyswap', color: '#a78bfa', usd: 0.05, min: 0.03 },
  POL: { name: 'Polygon', color: '#f472b6', usd: 0.5, min: 0.03 }
};

export const RECAPTCHA_SITE_KEY = "6LctET4tAAAAAAGcqEdyQbF_gcTH57Dnxztlv2hN";

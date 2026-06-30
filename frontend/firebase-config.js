import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyC_jba0EPxo-eN9Y3GRNkKyGQZS3wYXnE0",
  authDomain: "coinixfaucet.firebaseapp.com",
  projectId: "coinixfaucet",
  storageBucket: "coinixfaucet.firebasestorage.app",
  messagingSenderId: "894864862453",
  appId: "1:894864862453:web:3f2da6e92ce63b3cc5e9bc",
  measurementId: "G-8V69KZQN75"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export const COL = {
  users: 'users',
  claims: 'claims',
  transactions: 'transactions',
  referrals: 'referrals',
  global: 'global'
};

export const COINS = ['BTC', 'DOGE', 'DGB', 'FEY', 'POL'];

export const COIN_META = {
  BTC:  { name: 'Bitcoin',   color: '#F7931A', min: 0.03, reward: [0.00000001, 0.00000050], usd: 65000 },
  DOGE: { name: 'Dogecoin',  color: '#C2A633', min: 0.03, reward: [100, 500],               usd: 0.15 },
  DGB:  { name: 'DigiByte',  color: '#006AD2', min: 0.03, reward: [50, 200],                usd: 0.01 },
  FEY:  { name: 'Feyrr',     color: '#7C3AED', min: 0.03, reward: [10, 100],                usd: 0.05 },
  POL:  { name: 'Polygon',   color: '#8247E5', min: 0.03, reward: [0.01, 0.1],              usd: 0.5 }
};

export const RECAPTCHA_SITE_KEY = '6LctET4tAAAAAAGcqEdyQbF_gcTH57Dnxztlv2hN';

console.log('🔥 Firebase initialized');

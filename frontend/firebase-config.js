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

// CNX = $0.01 (Faucet coin)
// 5 coin: PEPE, DOGE, DGB, FEY, POL
export const COINS = ['PEPE', 'DOGE', 'DGB', 'FEY', 'POL'];

export const COIN_META = {
  PEPE: { name: 'Pepe',      color: '#4CAF50', min: 0.03, usd: 0.000008, icon: 'pepe.png' },
  DOGE: { name: 'Dogecoin',  color: '#C2A633', min: 0.03, usd: 0.15,     icon: 'doge.png' },
  DGB:  { name: 'DigiByte',  color: '#006AD2', min: 0.03, usd: 0.01,     icon: 'dgb.png' },
  FEY:  { name: 'Feyrr',     color: '#7C3AED', min: 0.03, usd: 0.05,     icon: 'fey.png' },
  POL:  { name: 'Polygon',   color: '#8247E5', min: 0.03, usd: 0.5,      icon: 'pol.png' }
};

export const CNX_META = {
  name: 'CNX',
  color: '#F59E0B',
  usd: 0.01,
  icon: 'cnx.png'
};

export const RECAPTCHA_SITE_KEY = '6LctET4tAAAAAAGcqEdyQbF_gcTH57Dnxztlv2hN';

console.log('🔥 CoinixFaucet v2.0 initialized');

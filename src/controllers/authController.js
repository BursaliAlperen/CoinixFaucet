const { db, admin } = require('../config/firebase');
const logger = require('../utils/logger');
const jwt = require('jsonwebtoken');

const BOT_USERNAME = process.env.BOT_USERNAME || 'your_bot';
const JWT_SECRET = process.env.JWT_SECRET || 'coinix-default-secret-change-me';
const serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp();
const increment = (n) => admin.firestore.FieldValue.increment(n);

async function logAction(action, userId, details = {}) {
  try {
    await db.collection('logs').add({
      action, user_id: userId || null, details,
      ip: details.ip || null, timestamp: serverTimestamp()
    });
  } catch (e) {
    logger.error('Log error', { error: e.message });
  }
}

async function auth(req, res) {
  const { initData, ref } = req.body;
  if (!initData) return res.status(400).json({ error: 'Missing initData' });

  let user;
  try {
    const urlParams = new URLSearchParams(initData);
    user = JSON.parse(urlParams.get('user'));
  } catch (e) {
    return res.status(400).json({ error: 'Bad user data' });
  }

  if (!user || !user.id) return res.status(400).json({ error: 'No user data' });

  const userId = String(user.id);
  const userRef = db.collection('users').doc(userId);

  try {
    const doc = await userRef.get();
    if (!doc.exists) {
      const newUser = {
        telegram_id: userId,
        username: user.username || null,
        first_name: user.first_name || null,
        last_name: user.last_name || null,
        photo_url: user.photo_url || null,
        balance: 0,
        doge_balance: 0,
        total_earned: 0,
        total_doge_earned: 0,
        total_ptc_earnings: 0,
        total_claims: 0,
        total_withdrawals: 0,
        referrals: 0,
        referral_earnings: 0,
        referred_by: ref || null,
        banned: false,
        last_claim: null,
        created_at: serverTimestamp()
      };
      await userRef.set(newUser);

      if (ref && ref !== userId) {
        const refRef = db.collection('users').doc(String(ref));
        const refDoc = await refRef.get();
        if (refDoc.exists && !refDoc.data().banned) {
          await refRef.update({
            referrals: increment(1),
            balance: increment(50),
            referral_earnings: increment(50)
          });
          await db.collection('referrals').add({
            referrer_id: String(ref),
            referred_id: userId,
            bonus: 50,
            currency: 'CNX',
            timestamp: serverTimestamp()
          });
          await logAction('referral_bonus', String(ref), { referred_id: userId, bonus: 50, currency: 'CNX' });
        }
      }
      await logAction('user_register', userId, { username: user.username, ref });
    } else {
      const updates = {};
      if (user.photo_url) updates.photo_url = user.photo_url;
      if (user.username) updates.username = user.username;
      if (Object.keys(updates).length) await userRef.update(updates);
    }

    const token = jwt.sign({ userId, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, user_id: userId, username: user.username, token });
  } catch (err) {
    logger.error('Auth error', { error: err.message });
    res.status(500).json({ error: 'Auth failed' });
  }
}

async function getBalance(req, res) {
  try {
    const doc = await db.collection('users').doc(String(req.params.userId)).get();
    if (!doc.exists) {
      return res.json({ balance: 0, doge_balance: 0, total_earned: 0, total_doge_earned: 0, total_claims: 0, total_withdrawals: 0, referrals: 0, referral_earnings: 0, last_claim: null });
    }
    const d = doc.data();
    res.json({
      balance: d.balance || 0,
      doge_balance: d.doge_balance || 0,
      total_earned: d.total_earned || 0,
      total_doge_earned: d.total_doge_earned || 0,
      total_claims: d.total_claims || 0,
      total_withdrawals: d.total_withdrawals || 0,
      referrals: d.referrals || 0,
      referral_earnings: d.referral_earnings || 0,
      last_claim: d.last_claim ? d.last_claim.toMillis() : null
    });
  } catch (err) {
    logger.error('Balance error', { error: err.message });
    res.status(500).json({ error: 'Server error' });
  }
}

async function getReferral(req, res) {
  try {
    const userId = String(req.params.userId);
    const doc = await db.collection('users').doc(userId).get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });
    const d = doc.data();
    const link = `https://t.me/${BOT_USERNAME}?startapp=ref_${userId}`;
    res.json({ link, referrals: d.referrals || 0, earnings: d.referral_earnings || 0 });
  } catch (err) {
    logger.error('Referral error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

module.exports = { auth, getBalance, getReferral };

const { db, admin } = require('../config/firebase');
const logger = require('../utils/logger');

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

async function claim(req, res) {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });

  const userRef = db.collection('users').doc(String(user_id));

  try {
    const result = await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error('NO_USER');
      const data = doc.data();
      if (data.banned) throw new Error('BANNED');

      const settingsDoc = await db.collection('settings').doc('faucet').get();
      const settings = settingsDoc.exists ? settingsDoc.data() : {};
      const cooldownMs = (settings.cooldown_seconds || 10) * 1000;
      const minReward = settings.min_reward || 1;
      const maxReward = settings.max_reward || 10;

      const lastClaimTime = data.last_claim ? data.last_claim.toMillis() : 0;
      const now = Date.now();
      if (now - lastClaimTime < cooldownMs) throw new Error('COOLDOWN');

      const reward = Math.random() * (maxReward - minReward) + minReward;
      const newBalance = (data.balance || 0) + reward;
      t.update(userRef, {
        balance: increment(reward),
        total_earned: increment(reward),
        total_claims: increment(1),
        last_claim: admin.firestore.Timestamp.now()
      });

      await logAction('claim', user_id, { reward, timestamp: now });
      return { success: true, reward: parseFloat(reward.toFixed(2)), balance: parseFloat(newBalance.toFixed(2)) };
    });
    res.json(result);
  } catch (err) {
    if (err.message === 'COOLDOWN') {
      res.status(429).json({ error: 'Cooldown active', message: 'Come back later' });
    } else if (err.message === 'BANNED') {
      res.status(403).json({ error: 'Banned' });
    } else if (err.message === 'NO_USER') {
      res.status(404).json({ error: 'User not found' });
    } else {
      logger.error('Claim error', { error: err.message });
      res.status(500).json({ error: 'Claim failed' });
    }
  }
}

module.exports = { claim };

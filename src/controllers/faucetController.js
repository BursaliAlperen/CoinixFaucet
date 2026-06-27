const { db, admin } = require('../config/firebase');
const logger = require('../utils/logger');

const serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp();
const increment = (n) => admin.firestore.FieldValue.increment(n);

async function claim(req, res) {
  const userId = String(req.user.userId);
  const userRef = db.collection('users').doc(userId);

  try {
    const doc = await userRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });
    const d = doc.data();
    if (d.banned) return res.status(403).json({ error: 'User banned' });

    const now = Date.now();
    const lastClaim = d.last_claim ? d.last_claim.toMillis() : 0;
    const cooldown = 10000;

    if (now - lastClaim < cooldown) {
      return res.status(429).json({ error: 'Cooldown active', wait: cooldown - (now - lastClaim) });
    }

    const amount = 0.5;

    await userRef.update({
      balance: increment(amount),
      total_earned: increment(amount),
      total_claims: increment(1),
      last_claim: serverTimestamp()
    });

    res.json({ success: true, amount, balance: (d.balance || 0) + amount });
  } catch (err) {
    logger.error('Claim error', { error: err.message, userId });
    res.status(500).json({ error: 'Claim failed' });
  }
}

module.exports = { claim };

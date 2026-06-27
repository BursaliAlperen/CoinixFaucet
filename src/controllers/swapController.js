const { db, admin } = require('../config/firebase');
const logger = require('../utils/logger');

const serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp();

async function swap(req, res) {
  const userId = String(req.user.userId);
  const { amount, direction } = req.body;
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const userRef = db.collection('users').doc(userId);

  try {
    const doc = await userRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });
    const d = doc.data();
    if (d.banned) return res.status(403).json({ error: 'User banned' });

    if (direction === 'cnx-to-doge') {
      if ((d.balance || 0) < amt) return res.status(400).json({ error: 'Insufficient CNX' });
      await userRef.update({
        balance: admin.firestore.FieldValue.increment(-amt),
        doge_balance: admin.firestore.FieldValue.increment(amt)
      });
    } else if (direction === 'doge-to-cnx') {
      if ((d.doge_balance || 0) < amt) return res.status(400).json({ error: 'Insufficient DOGE' });
      await userRef.update({
        doge_balance: admin.firestore.FieldValue.increment(-amt),
        balance: admin.firestore.FieldValue.increment(amt)
      });
    } else {
      return res.status(400).json({ error: 'Invalid direction' });
    }

    await db.collection('swaps').add({
      user_id: userId,
      amount: amt,
      direction,
      timestamp: serverTimestamp()
    });

    res.json({ success: true, message: 'Swap completed' });
  } catch (err) {
    logger.error('Swap error', { error: err.message, userId });
    res.status(500).json({ error: 'Swap failed' });
  }
}

module.exports = { swap };

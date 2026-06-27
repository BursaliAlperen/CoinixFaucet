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

async function swap(req, res) {
  const { user_id, from_currency, to_currency, amount } = req.body;

  if (!user_id || !from_currency || !to_currency || !amount) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  if ((from_currency !== 'cnx' && from_currency !== 'doge') ||
      (to_currency !== 'cnx' && to_currency !== 'doge')) {
    return res.status(400).json({ error: 'Invalid currency pair. Only CNX and DOGE are supported.' });
  }

  if (from_currency === to_currency) {
    return res.status(400).json({ error: 'Cannot swap same currency' });
  }

  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const userRef = db.collection('users').doc(String(user_id));

  try {
    const result = await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error('NO_USER');

      const data = doc.data();
      const fromField = from_currency === 'doge' ? 'doge_balance' : 'balance';
      const toField = to_currency === 'doge' ? 'doge_balance' : 'balance';
      const fromBalance = data[fromField] || 0;

      if (fromBalance < numAmount) throw new Error('INSUFFICIENT');

      // 1:1 conversion rate
      const swapAmount = numAmount;
      t.update(userRef, {
        [fromField]: increment(-numAmount),
        [toField]: increment(swapAmount)
      });

      await logAction('swap', user_id, { from: from_currency, to: to_currency, amount: numAmount });

      return { success: true, swapped_amount: swapAmount };
    });
    res.json(result);
  } catch (err) {
    if (err.message === 'INSUFFICIENT') {
      res.status(400).json({ error: 'Insufficient balance' });
    } else if (err.message === 'NO_USER') {
      res.status(404).json({ error: 'User not found' });
    } else {
      logger.error('Swap error', { error: err.message });
      res.status(500).json({ error: 'Swap failed' });
    }
  }
}

module.exports = { swap };

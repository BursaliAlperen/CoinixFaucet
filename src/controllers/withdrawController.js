const { db, admin } = require('../config/firebase');
const logger = require('../utils/logger');

const serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp();
const increment = (n) => admin.firestore.FieldValue.increment(n);

async function withdraw(req, res) {
  const userId = String(req.user.userId);
  const { faucetpay_email, amount } = req.body;
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!faucetpay_email || !faucetpay_email.includes('@')) return res.status(400).json({ error: 'Invalid email' });

  const userRef = db.collection('users').doc(userId);

  try {
    const doc = await userRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });
    const d = doc.data();
    if (d.banned) return res.status(403).json({ error: 'User banned' });
    if ((d.doge_balance || 0) < amt) return res.status(400).json({ error: 'Insufficient DOGE' });
    if (amt < 0.1) return res.status(400).json({ error: 'Minimum 0.10 DOGE' });

    await userRef.update({
      doge_balance: increment(-amt),
      total_withdrawals: increment(1)
    });

    await db.collection('withdrawals').add({
      user_id: userId,
      faucetpay_email,
      amount: amt,
      status: 'pending',
      timestamp: serverTimestamp()
    });

    res.json({ success: true, message: 'Withdrawal submitted' });
  } catch (err) {
    logger.error('Withdraw error', { error: err.message, userId });
    res.status(500).json({ error: 'Withdrawal failed' });
  }
}

async function getHistory(req, res) {
  try {
    const userId = String(req.user.userId);
    const snapshot = await db.collection('withdrawals')
      .where('user_id', '==', userId)
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();
    const data = snapshot.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() }));
    res.json(data);
  } catch (err) {
    logger.error('Withdraw history error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function getRecent(req, res) {
  try {
    const snapshot = await db.collection('withdrawals')
      .orderBy('timestamp', 'desc')
      .limit(25)
      .get();
    const data = snapshot.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() }));
    res.json(data);
  } catch (err) {
    logger.error('Recent withdrawals error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function getStats(req, res) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const snapshot = await db.collection('withdrawals')
      .where('timestamp', '>=', admin.firestore.Timestamp.fromDate(today))
      .get();
    const total = snapshot.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
    const allSnap = await db.collection('withdrawals').get();
    const allTime = allSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
    res.json({ today: total, allTime });
  } catch (err) {
    logger.error('Withdraw stats error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

module.exports = { withdraw, getHistory, getRecent, getStats };

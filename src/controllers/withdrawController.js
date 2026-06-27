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

async function withdraw(req, res) {
  const { user_id, amount, address, currency } = req.body;

  if (!user_id || !amount || !address) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  if (currency !== 'cnx' && currency !== 'doge') {
    return res.status(400).json({ error: 'Invalid currency. Only CNX and DOGE are supported.' });
  }

  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount < 0.10) {
    return res.status(400).json({ error: 'Minimum withdrawal is 0.10' });
  }

  const userRef = db.collection('users').doc(String(user_id));

  try {
    const result = await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error('NO_USER');

      const data = doc.data();
      const balanceField = currency === 'doge' ? 'doge_balance' : 'balance';
      const currentBalance = data[balanceField] || 0;

      if (currentBalance < numAmount) throw new Error('INSUFFICIENT');

      const withdrawalRef = db.collection('withdrawals').doc();
      t.set(withdrawalRef, {
        user_id: String(user_id),
        username: data.username || 'Unknown',
        amount: numAmount,
        address,
        currency,
        status: 'pending',
        timestamp: admin.firestore.Timestamp.now()
      });

      t.update(userRef, {
        [balanceField]: increment(-numAmount),
        total_withdrawals: increment(1)
      });

      await logAction('withdrawal_request', user_id, { amount: numAmount, currency, address });

      return { success: true, withdrawal_id: withdrawalRef.id };
    });
    res.json(result);
  } catch (err) {
    if (err.message === 'INSUFFICIENT') {
      res.status(400).json({ error: 'Insufficient balance' });
    } else if (err.message === 'NO_USER') {
      res.status(404).json({ error: 'User not found' });
    } else {
      logger.error('Withdrawal error', { error: err.message });
      res.status(500).json({ error: 'Withdrawal failed' });
    }
  }
}

async function getHistory(req, res) {
  try {
    const snapshot = await db.collection('withdrawals')
      .where('user_id', '==', String(req.params.userId))
      .orderBy('timestamp', 'desc')
      .get();

    const withdrawals = [];
    snapshot.forEach(doc => {
      const d = doc.data();
      withdrawals.push({
        id: doc.id,
        amount: d.amount,
        address: d.address,
        currency: d.currency,
        status: d.status,
        timestamp: d.timestamp ? d.timestamp.toMillis() : null
      });
    });
    res.json(withdrawals);
  } catch (err) {
    logger.error('Withdrawal history error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch history' });
  }
}

async function getRecent(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const snapshot = await db.collection('withdrawals')
      .where('status', 'in', ['approved', 'paid'])
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    const userIds = new Set();
    snapshot.forEach(doc => {
      const d = doc.data();
      if (d.user_id) userIds.add(d.user_id);
    });

    const userMap = {};
    if (userIds.size > 0) {
      const idArr = Array.from(userIds).slice(0, 30);
      const userSnaps = await db.getAll(idArr.map(id => db.collection('users').doc(id)));
      userSnaps.forEach(snap => {
        if (snap.exists) {
          const u = snap.data();
          userMap[snap.id] = {
            username: u.username || null,
            first_name: u.first_name || null,
            last_name: u.last_name || null,
            photo_url: u.photo_url || null
          };
        }
      });
    }

    const items = [];
    snapshot.forEach(doc => {
      const d = doc.data();
      const u = userMap[d.user_id] || {};
      let maskedAddr = '';
      if (d.address && typeof d.address === 'string') {
        const atIdx = d.address.indexOf('@');
        if (atIdx > 0) {
          maskedAddr = d.address[0] + '***' + d.address.substring(atIdx);
        } else {
          maskedAddr = d.address.substring(0, 4) + '***' + d.address.substring(d.address.length - 3);
        }
      }
      items.push({
        id: doc.id,
        user_id: d.user_id,
        username: u.username || d.username || null,
        first_name: u.first_name || null,
        last_name: u.last_name || null,
        photo_url: u.photo_url || null,
        amount: d.amount,
        currency: d.currency,
        masked_address: maskedAddr,
        status: d.status,
        timestamp: d.timestamp ? d.timestamp.toMillis() : null
      });
    });
    res.json(items);
  } catch (err) {
    logger.error('Recent withdrawals error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function getStats(req, res) {
  try {
    const snap = await db.collection('withdrawals')
      .where('status', 'in', ['approved', 'paid'])
      .get();

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();
    let todayTotal = 0, todayCount = 0, totalPaid = 0, totalCount = 0;
    const byDay = {};
    snap.forEach(doc => {
      const d = doc.data();
      const ts = d.timestamp ? d.timestamp.toMillis() : 0;
      totalPaid += d.amount || 0;
      totalCount++;
      if (ts >= todayMs) {
        todayTotal += d.amount || 0;
        todayCount++;
      }
      const dayKey = new Date(ts).toISOString().slice(0, 10);
      byDay[dayKey] = (byDay[dayKey] || 0) + (d.amount || 0);
    });

    const series = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      series.push({ date: key, total: byDay[key] || 0 });
    }

    res.json({ today_total: todayTotal, today_count: todayCount, total_paid: totalPaid, total_count: totalCount, series });
  } catch (err) {
    logger.error('Withdraw stats error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

module.exports = { withdraw, getHistory, getRecent, getStats };

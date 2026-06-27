const { db, admin } = require('../config/firebase');
const logger = require('../utils/logger');

async function getGlobalStats(req, res) {
  try {
    const usersSnap = await db.collection('users').get();
    const totalUsers = usersSnap.size;
    const activeToday = usersSnap.docs.filter(d => {
      const lc = d.data().last_claim;
      return lc && (Date.now() - lc.toMillis() < 86400000);
    }).length;
    
    const wdSnap = await db.collection('withdrawals').get();
    const totalPaid = wdSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
    
    res.json({ totalUsers, activeToday, totalPaid });
  } catch (err) {
    logger.error('Global stats error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function getUserStats(req, res) {
  try {
    const userId = String(req.params.userId);
    if (req.user.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
    const doc = await db.collection('users').doc(userId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    const d = doc.data();
    res.json({
      balance: d.balance || 0,
      doge_balance: d.doge_balance || 0,
      total_earned: d.total_earned || 0,
      total_claims: d.total_claims || 0,
      total_withdrawals: d.total_withdrawals || 0,
      referrals: d.referrals || 0
    });
  } catch (err) {
    logger.error('User stats error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function getUserCharts(req, res) {
  try {
    const userId = String(req.params.userId);
    if (req.user.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
    const snap = await db.collection('withdrawals').where('user_id', '==', userId).orderBy('timestamp', 'desc').limit(30).get();
    const data = snap.docs.map(d => ({ amount: d.data().amount || 0, date: d.data().timestamp?.toDate().toISOString().split('T')[0] }));
    res.json(data);
  } catch (err) {
    logger.error('User charts error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function getAdminCharts(req, res) {
  try {
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 86400000);
    const snap = await db.collection('withdrawals').where('timestamp', '>=', admin.firestore.Timestamp.fromDate(since)).get();
    const daily = {};
    snap.docs.forEach(d => {
      const date = d.data().timestamp?.toDate().toISOString().split('T')[0];
      if (date) daily[date] = (daily[date] || 0) + (d.data().amount || 0);
    });
    res.json(daily);
  } catch (err) {
    logger.error('Admin charts error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

module.exports = { getGlobalStats, getUserStats, getUserCharts, getAdminCharts };

const { db, admin } = require('../config/firebase');
const logger = require('../utils/logger');

async function getGlobalStats(req, res) {
  try {
    const usersSnap = await db.collection('users').get();
    const totalUsers = usersSnap.size;

    let totalBalance = 0, totalDoge = 0;
    usersSnap.forEach(doc => {
      const d = doc.data();
      totalBalance += d.balance || 0;
      totalDoge += d.doge_balance || 0;
    });

    const claimsSnap = await db.collection('logs').where('action', '==', 'claim').get();
    const totalClaims = claimsSnap.size;

    const now = Date.now();
    const todayStart = new Date(now).setHours(0, 0, 0, 0);
    const claimsTodaySnap = await db.collection('logs')
      .where('action', '==', 'claim')
      .where('timestamp', '>=', admin.firestore.Timestamp.fromMillis(todayStart))
      .get();
    const activeToday = new Set();
    claimsTodaySnap.forEach(doc => {
      const d = doc.data();
      if (d.user_id) activeToday.add(d.user_id);
    });

    const withdrawSnap = await db.collection('withdrawals').get();
    let totalWithdrawn = 0;
    withdrawSnap.forEach(doc => totalWithdrawn += doc.data().amount || 0);

    const pendingSnap = await db.collection('withdrawals').where('status', '==', 'pending').get();

    const ptcSnap = await db.collection('logs').where('action', 'in', ['ptc_reward', 'offerwall_reward']).get();
    let totalPtc = ptcSnap.size;

    res.json({
      totalUsers, totalBalance, totalDoge, totalClaims, totalPtc,
      activeToday: activeToday.size, totalWithdrawn,
      pendingWithdrawals: pendingSnap.size
    });
  } catch (err) {
    logger.error('Stats error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
}

async function getUserStats(req, res) {
  try {
    const userDoc = await db.collection('users').doc(String(req.params.userId)).get();
    if (!userDoc.exists) return res.json({ balance: 0, claims: 0, earned: 0, withdrawn: 0, referrals: 0 });
    const d = userDoc.data();
    const wdSnap = await db.collection('withdrawals')
      .where('user_id', '==', String(req.params.userId))
      .where('status', '==', 'approved')
      .get();
    let withdrawn = 0;
    wdSnap.forEach(doc => withdrawn += doc.data().amount || 0);
    res.json({ balance: d.balance || 0, claims: d.total_claims || 0, earned: d.total_earned || 0, withdrawn, referrals: d.referrals || 0 });
  } catch (err) {
    logger.error('User stats error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function getUserCharts(req, res) {
  try {
    const userId = String(req.params.userId);
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const sinceTs = admin.firestore.Timestamp.fromMillis(sinceMs);

    const buckets = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      buckets[key] = { date: key, faucet: 0, ptc: 0, offerwall: 0, referrals: 0, swap: 0 };
    }

    const logsSnap = await db.collection('logs')
      .where('user_id', '==', userId)
      .where('timestamp', '>=', sinceTs)
      .get();

    logsSnap.forEach(doc => {
      const l = doc.data();
      if (!l.timestamp) return;
      const key = new Date(l.timestamp.toMillis()).toISOString().slice(0, 10);
      if (!buckets[key]) return;
      const reward = parseFloat((l.details && (l.details.reward || l.details.amount || l.details.bonus)) || 0);
      switch (l.action) {
        case 'claim': buckets[key].faucet += reward; break;
        case 'ptc_reward': buckets[key].ptc += reward; break;
        case 'offerwall_reward': buckets[key].offerwall += reward; break;
        case 'referral_bonus': buckets[key].referrals += reward; break;
        case 'swap': buckets[key].swap += (l.details && l.details.amount) || 0; break;
      }
    });

    const series = Object.values(buckets).sort((a, b) => a.date.localeCompare(b.date));

    const counts = { faucet: 0, ptc: 0, offerwall: 0, swap: 0, referral: 0, withdrawal: 0 };
    logsSnap.forEach(doc => {
      const l = doc.data();
      if (l.action === 'claim') counts.faucet++;
      else if (l.action === 'ptc_reward') counts.ptc++;
      else if (l.action === 'offerwall_reward') counts.offerwall++;
      else if (l.action === 'swap') counts.swap++;
      else if (l.action === 'referral_bonus') counts.referral++;
      else if (l.action === 'withdrawal_request') counts.withdrawal++;
    });

    const wdSnap = await db.collection('withdrawals').where('user_id', '==', userId).get();
    counts.withdrawal = wdSnap.size;

    res.json({ series, counts });
  } catch (err) {
    logger.error('User charts error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function getAdminCharts(req, res) {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const sinceTs = admin.firestore.Timestamp.fromMillis(sinceMs);

    const buckets = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      buckets[key] = { date: key, claims: 0, ptc: 0, offerwall: 0, swaps: 0, withdrawals: 0, newUsers: 0 };
    }

    const logsSnap = await db.collection('logs').where('timestamp', '>=', sinceTs).get();
    logsSnap.forEach(doc => {
      const l = doc.data();
      if (!l.timestamp) return;
      const key = new Date(l.timestamp.toMillis()).toISOString().slice(0, 10);
      if (!buckets[key]) return;
      switch (l.action) {
        case 'claim': buckets[key].claims++; break;
        case 'ptc_reward': buckets[key].ptc++; break;
        case 'offerwall_reward': buckets[key].offerwall++; break;
        case 'swap': buckets[key].swaps++; break;
        case 'withdrawal_request': buckets[key].withdrawals++; break;
      }
    });

    const usersSnap = await db.collection('users').where('created_at', '>=', sinceTs).get();
    usersSnap.forEach(doc => {
      const u = doc.data();
      if (!u.created_at) return;
      const key = new Date(u.created_at.toMillis()).toISOString().slice(0, 10);
      if (buckets[key]) buckets[key].newUsers++;
    });

    const series = Object.values(buckets).sort((a, b) => a.date.localeCompare(b.date));
    res.json({ series });
  } catch (err) {
    logger.error('Admin charts error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

module.exports = { getGlobalStats, getUserStats, getUserCharts, getAdminCharts };

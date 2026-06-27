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

async function getUsers(req, res) {
  try {
    const snapshot = await db.collection('users').get();
    const users = [];
    snapshot.forEach(doc => {
      const d = doc.data();
      users.push({
        id: doc.id,
        username: d.username || null,
        first_name: d.first_name || null,
        balance: d.balance || 0,
        doge_balance: d.doge_balance || 0,
        total_earned: d.total_earned || 0,
        total_doge_earned: d.total_doge_earned || 0,
        total_ptc_earnings: d.total_ptc_earnings || 0,
        total_claims: d.total_claims || 0,
        referrals: d.referrals || 0,
        referral_earnings: d.referral_earnings || 0,
        banned: d.banned || false,
        last_claim: d.last_claim ? d.last_claim.toMillis() : null,
        created_at: d.created_at ? d.created_at.toMillis() : null
      });
    });
    res.json(users);
  } catch (err) {
    logger.error('Admin users error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch users' });
  }
}

async function getWithdrawals(req, res) {
  try {
    const snapshot = await db.collection('withdrawals').orderBy('timestamp', 'desc').get();
    const items = [];
    snapshot.forEach(doc => {
      const d = doc.data();
      items.push({
        id: doc.id,
        user_id: d.user_id,
        username: d.username || 'Unknown',
        amount: d.amount,
        address: d.address,
        currency: d.currency,
        status: d.status,
        timestamp: d.timestamp ? d.timestamp.toMillis() : null
      });
    });
    res.json(items);
  } catch (err) {
    logger.error('Admin withdrawals error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }
}

async function approveWithdrawal(req, res) {
  const { id, status } = req.body;
  if (!id || !['approved', 'rejected', 'paid', 'canceled'].includes(status)) {
    return res.status(400).json({ error: 'Bad request' });
  }

  try {
    const ref = db.collection('withdrawals').doc(id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    const data = doc.data();
    if (data.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    if (status === 'rejected' || status === 'canceled') {
      const userRef = db.collection('users').doc(data.user_id);
      const balanceField = data.currency === 'doge' ? 'doge_balance' : 'balance';
      await userRef.update({ [balanceField]: increment(data.amount), total_withdrawals: increment(-1) });
    }
    await ref.update({ status, updated_at: admin.firestore.Timestamp.now() });
    await logAction('withdraw_' + status, data.user_id, { withdrawal_id: id, amount: data.amount });
    res.json({ success: true });
  } catch (err) {
    logger.error('Admin approve error', { error: err.message });
    res.status(500).json({ error: 'Failed to update' });
  }
}

async function addBalance(req, res) {
  const { user_id, amount } = req.body;
  if (!user_id || amount === undefined) return res.status(400).json({ error: 'Missing parameters' });
  try {
    const userRef = db.collection('users').doc(String(user_id));
    await userRef.set({ balance: increment(Number(amount)) }, { merge: true });
    await logAction('admin_balance_adjust', user_id, { amount: Number(amount) });
    res.json({ success: true });
  } catch (err) {
    logger.error('Admin add balance error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function banUser(req, res) {
  const { user_id, banned } = req.body;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });
  try {
    await db.collection('users').doc(String(user_id)).update({ banned: !!banned });
    await logAction('admin_ban', user_id, { banned: !!banned });
    res.json({ success: true });
  } catch (err) {
    logger.error('Admin ban error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function deleteUser(req, res) {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });
  try {
    await db.collection('users').doc(String(user_id)).delete();
    await logAction('admin_delete_user', user_id, {});
    res.json({ success: true });
  } catch (err) {
    logger.error('Admin delete error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function getLogs(req, res) {
  try {
    const snapshot = await db.collection('logs').orderBy('timestamp', 'desc').limit(200).get();
    const logs = [];
    snapshot.forEach(doc => {
      const d = doc.data();
      logs.push({
        id: doc.id,
        action: d.action,
        user_id: d.user_id,
        details: d.details,
        timestamp: d.timestamp ? d.timestamp.toMillis() : null
      });
    });
    res.json(logs);
  } catch (err) {
    logger.error('Admin logs error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
}

async function getSettings(req, res) {
  try {
    const doc = await db.collection('settings').doc('faucet').get();
    res.json(doc.exists ? doc.data() : { cooldown_seconds: 10, min_reward: 1, max_reward: 10, min_withdraw: 0.10, paused: false });
  } catch (err) {
    logger.error('Admin settings error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function updateSettings(req, res) {
  const { cooldown_seconds, min_reward, max_reward, min_withdraw, paused } = req.body;
  try {
    await db.collection('settings').doc('faucet').set({
      cooldown_seconds: Number(cooldown_seconds) || 10,
      min_reward: Number(min_reward) || 1,
      max_reward: Number(max_reward) || 10,
      min_withdraw: Number(min_withdraw) || 0.10,
      paused: !!paused
    }, { merge: true });
    res.json({ success: true });
  } catch (err) {
    logger.error('Admin settings update error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function broadcast(req, res) {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Missing message' });
  try {
    await db.collection('broadcasts').add({
      message: String(message),
      timestamp: serverTimestamp(),
      sent: false
    });
    res.json({ success: true, message: 'Broadcast queued' });
  } catch (err) {
    logger.error('Admin broadcast error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

module.exports = {
  getUsers, getWithdrawals, approveWithdrawal, addBalance,
  banUser, deleteUser, getLogs, getSettings, updateSettings, broadcast
};

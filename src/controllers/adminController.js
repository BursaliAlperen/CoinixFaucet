const { db, admin } = require('../config/firebase');
const logger = require('../utils/logger');

const serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp();
const increment = (n) => admin.firestore.FieldValue.increment(n);

async function getUsers(req, res) {
  try {
    const snap = await db.collection('users').orderBy('created_at', 'desc').limit(100).get();
    const data = snap.docs.map(d => ({ id: d.id, ...d.data(), created_at: d.data().created_at?.toMillis() }));
    res.json(data);
  } catch (err) {
    logger.error('Admin users error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function getWithdrawals(req, res) {
  try {
    const snap = await db.collection('withdrawals').orderBy('timestamp', 'desc').limit(100).get();
    const data = snap.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() }));
    res.json(data);
  } catch (err) {
    logger.error('Admin withdrawals error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function approveWithdrawal(req, res) {
  try {
    const { id } = req.body;
    await db.collection('withdrawals').doc(id).update({ status: 'approved', approved_at: serverTimestamp() });
    res.json({ success: true });
  } catch (err) {
    logger.error('Approve error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function addBalance(req, res) {
  try {
    const { userId, amount, currency } = req.body;
    const field = currency === 'doge' ? 'doge_balance' : 'balance';
    await db.collection('users').doc(String(userId)).update({ [field]: increment(Number(amount)) });
    res.json({ success: true });
  } catch (err) {
    logger.error('Add balance error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function banUser(req, res) {
  try {
    const { userId } = req.body;
    await db.collection('users').doc(String(userId)).update({ banned: true });
    res.json({ success: true });
  } catch (err) {
    logger.error('Ban error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function deleteUser(req, res) {
  try {
    const { userId } = req.body;
    await db.collection('users').doc(String(userId)).delete();
    res.json({ success: true });
  } catch (err) {
    logger.error('Delete error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function getLogs(req, res) {
  try {
    const snap = await db.collection('logs').orderBy('timestamp', 'desc').limit(100).get();
    const data = snap.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toMillis() }));
    res.json(data);
  } catch (err) {
    logger.error('Logs error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function getSettings(req, res) {
  try {
    const doc = await db.collection('settings').doc('global').get();
    res.json(doc.exists ? doc.data() : {});
  } catch (err) {
    logger.error('Settings get error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function updateSettings(req, res) {
  try {
    await db.collection('settings').doc('global').set(req.body, { merge: true });
    res.json({ success: true });
  } catch (err) {
    logger.error('Settings update error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function broadcast(req, res) {
  try {
    const { message } = req.body;
    await db.collection('broadcasts').add({ message, timestamp: serverTimestamp() });
    res.json({ success: true });
  } catch (err) {
    logger.error('Broadcast error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

module.exports = { getUsers, getWithdrawals, approveWithdrawal, addBalance, banUser, deleteUser, getLogs, getSettings, updateSettings, broadcast };

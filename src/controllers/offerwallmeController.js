const offerwallmeService = require('../services/offerwallme');
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

// ========================
// NATIVE POSTBACK (Offerwall.me S2S - POST request)
// Endpoint: /api/postback
// Method: POST
// Body: subId, transId, reward, status, signature, userIp, country, offer_name, offer_type, payout, reward_name, reward_value, debug
// Signature: MD5(subId.transId.reward.secretkey) - DOT separated!
// Response: "ok" (lowercase, no quotes in actual response, just plain text)
// ========================
async function postback(req, res) {
  try {
    const { subId, transId, reward, status: actionStatus, signature, userIp, country, offer_name, offer_type, payout, reward_name, reward_value, debug } = req.body;

    if (!subId || reward === undefined || !transId) {
      return res.status(400).send('missing params');
    }

    // Optional IP whitelist check
    const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const ipToCheck = clientIP.split(',')[0].trim();
    if (process.env.OFFERWALLME_CHECK_IP === 'true' && !offerwallmeService.isAllowedIP(ipToCheck)) {
      await logAction('postback_invalid_ip', null, { ip: ipToCheck, subId });
      return res.status(403).send('invalid ip');
    }

    // Verify Offerwall.me signature: MD5(subId.transId.reward.secretkey) - DOT separated!
    if (!offerwallmeService.verifyOfferwallSignature(subId, transId, reward, signature)) {
      await logAction('postback_invalid_signature', null, { subId, reward, transId });
      return res.status(403).send('invalid signature');
    }

    const numReward = parseFloat(reward);
    if (isNaN(numReward) || numReward <= 0) return res.status(400).send('invalid reward');

    const userId = String(subId);
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).send('user not found');
    if (userDoc.data().banned) return res.status(403).send('user banned');

    // Check duplicate transaction by transId
    const existing = await db.collection('offer_transactions').where('transId', '==', transId).limit(1).get();
    if (!existing.empty) {
      return res.send('DUP');
    }

    const balanceField = 'balance'; // CNX
    const totalField = 'total_earned';

    if (String(actionStatus) === '2') {
      // Chargeback - subtract reward
      await userRef.update({
        [balanceField]: increment(-numReward),
        [totalField]: increment(-numReward)
      });
      await logAction('offerwall_chargeback', userId, { reward: numReward, transId, offer_name, offer_type });
      return res.send('ok');
    }

    // Credit user (status = 1 or default)
    await userRef.update({
      [balanceField]: increment(numReward),
      [totalField]: increment(numReward),
      total_ptc_earnings: increment(numReward)
    });

    // Store transaction to prevent duplicates
    await db.collection('offer_transactions').add({
      transId,
      userId,
      reward: numReward,
      offer_name: offer_name || '',
      offer_type: offer_type || '',
      payout: payout || 0,
      userIp: userIp || '',
      country: country || '',
      timestamp: serverTimestamp()
    });

    await logAction('offerwall_reward', userId, {
      reward: numReward, transId, offer_name, offer_type, payout, userIp, country
    });

    // CRITICAL: Response must be plain text "ok" (lowercase)
    res.send('ok');
  } catch (err) {
    logger.error('Postback error', { error: err.message });
    res.status(500).send('error');
  }
}

// ========================
// CUSTOM POSTBACK (Backend integration with ADMIN_SECRET_KEY)
// Endpoint: /api/offerwall-postback
// Method: POST
// Body: user_id, offer_id, amount, status, signature
// Signature: MD5(user_id + offer_id + amount + status + ADMIN_SECRET_KEY)
// Response: JSON { success: true, message: "OK", reward }
// ========================
async function offerwallPostback(req, res) {
  try {
    const { user_id, offer_id, amount, status, signature } = req.body;

    // Validate required fields
    if (!user_id || !offer_id || amount === undefined || status === undefined || !signature) {
      logger.error('Offerwall postback missing params', { body: req.body });
      return res.status(400).json({ error: 'Missing required parameters: user_id, offer_id, amount, status, signature' });
    }

    // Only process approved status (status=1)
    if (String(status) !== '1') {
      logger.info('Offerwall postback rejected - status not approved', { user_id, offer_id, status });
      return res.status(400).json({ error: 'Status must be 1 (approved)' });
    }

    // Verify signature with ADMIN_SECRET_KEY
    if (!offerwallmeService.verifyAdminSignature(user_id, offer_id, amount, status, signature)) {
      logger.error('Offerwall postback invalid signature', { user_id, offer_id });
      await logAction('offerwall_postback_invalid_signature', user_id, { offer_id, amount, status });
      return res.status(403).json({ error: 'Invalid signature' });
    }

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Get exchange rate from settings (default 100 = 1:1)
    const settingsDoc = await db.collection('settings').doc('faucet').get();
    const exchangeRate = (settingsDoc.exists && settingsDoc.data().exchange_rate) || 100;
    const reward = offerwallmeService.calculateReward(numAmount, exchangeRate);

    const userId = String(user_id);
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      logger.error('Offerwall postback user not found', { user_id });
      return res.status(404).json({ error: 'User not found' });
    }
    if (userDoc.data().banned) {
      logger.error('Offerwall postback user banned', { user_id });
      return res.status(403).json({ error: 'User banned' });
    }

    // Check duplicate offer_id
    const existing = await db.collection('transactions')
      .where('offer_id', '==', offer_id)
      .where('user_id', '==', userId)
      .limit(1)
      .get();
    if (!existing.empty) {
      logger.warn('Offerwall postback duplicate', { user_id, offer_id });
      return res.status(400).json({ error: 'Duplicate offer_id' });
    }

    // Credit user balance
    await userRef.update({
      balance: increment(reward),
      total_earned: increment(reward),
      total_ptc_earnings: increment(reward)
    });

    // Save to transactions collection
    await db.collection('transactions').add({
      user_id: userId,
      offer_id,
      amount: numAmount,
      reward,
      exchange_rate: exchangeRate,
      status: 'approved',
      type: 'offerwall',
      source: 'offerwall.me',
      timestamp: serverTimestamp()
    });

    await logAction('offerwall_postback_reward', userId, {
      offer_id, amount: numAmount, reward, exchange_rate: exchangeRate
    });

    logger.info('Offerwall postback success', { user_id, offer_id, reward });
    res.json({ success: true, message: 'OK', reward });

  } catch (err) {
    logger.error('Offerwall postback error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ========================
// Other Offerwall.me endpoints
// ========================
async function getOfferwallUrl(req, res) {
  try {
    const { userId } = req.params;
    const url = offerwallmeService.getOfferwallUrl(userId);
    if (!url) return res.status(503).json({ error: 'Offerwall.me not configured' });
    res.json({ success: true, url });
  } catch (err) {
    logger.error('Offerwall.me offerwall error', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
}

async function getPTCAds(req, res) {
  try {
    const { userId } = req.params;
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const country = req.query.country || 'US';
    const result = await offerwallmeService.getPTCAds(userId, userIp, country);
    res.json(result);
  } catch (err) {
    logger.error('Offerwall.me PTC error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch PTC ads', data: [] });
  }
}

async function getShortlinks(req, res) {
  try {
    const { userId } = req.params;
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const country = req.query.country || 'US';
    const result = await offerwallmeService.getShortlinks(userId, userIp, country);
    res.json(result);
  } catch (err) {
    logger.error('Offerwall.me shortlinks error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch shortlinks', data: [] });
  }
}

module.exports = {
  getOfferwallUrl, getPTCAds, getShortlinks, postback, offerwallPostback
};

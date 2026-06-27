const { db, admin } = require('../config/firebase');
const logger = require('../utils/logger');
const crypto = require('crypto');

const serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp();
const increment = (n) => admin.firestore.FieldValue.increment(n);

const OFFERWALL_APP_ID = process.env.OFFERWALL_APP_ID;
const OFFERWALL_SECRET = process.env.OFFERWALL_SECRET_KEY;
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY;

async function getOfferwallUrl(req, res) {
  const userId = String(req.user.userId);
  const subId = Buffer.from(userId).toString('base64');
  const url = `https://offerwall.me/offerwall/${OFFERWALL_APP_ID}?subid=${subId}`;
  res.json({ url });
}

async function getPTCAds(req, res) {
  const userId = String(req.user.userId);
  res.json({ message: 'PTC ads loaded', userId });
}

async function getShortlinks(req, res) {
  const userId = String(req.user.userId);
  res.json({ message: 'Shortlinks loaded', userId });
}

async function postback(req, res) {
  try {
    const { subid, transid, reward, status, signature } = req.body;
    if (!subid || !transid || !reward || !signature) return res.status(400).send('missing params');
    
    const expected = crypto.createHash('md5').update(`${subid}.${transid}.${reward}.${OFFERWALL_SECRET}`).digest('hex');
    if (signature !== expected) return res.status(403).send('invalid sig');
    
    const userId = Buffer.from(subid, 'base64').toString('ascii');
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    if (!doc.exists) return res.status(404).send('user not found');
    if (doc.data().banned) return res.status(403).send('banned');
    
    const amt = Number(reward);
    await userRef.update({
      balance: increment(amt),
      total_earned: increment(amt),
      total_ptc_earnings: increment(amt)
    });
    
    await db.collection('offerwall_completions').add({
      user_id: userId,
      trans_id: transid,
      amount: amt,
      source: 'offerwall_native',
      timestamp: serverTimestamp()
    });
    
    res.send('ok');
  } catch (err) {
    logger.error('Offerwall postback error', { error: err.message });
    res.status(500).send('error');
  }
}

async function offerwallPostback(req, res) {
  try {
    const { user_id, amount, signature } = req.body;
    if (!user_id || !amount || !signature) return res.status(400).send('missing');
    
    const expected = crypto.createHash('md5').update(`${user_id}.${amount}.${ADMIN_SECRET_KEY}`).digest('hex');
    if (signature !== expected) return res.status(403).send('invalid');
    
    const userRef = db.collection('users').doc(String(user_id));
    const doc = await userRef.get();
    if (!doc.exists) return res.status(404).send('not found');
    if (doc.data().banned) return res.status(403).send('banned');
    
    const amt = Number(amount);
    await userRef.update({
      balance: increment(amt),
      total_earned: increment(amt),
      total_ptc_earnings: increment(amt)
    });
    
    res.send('ok');
  } catch (err) {
    logger.error('Custom postback error', { error: err.message });
    res.status(500).send('error');
  }
}

module.exports = { getOfferwallUrl, getPTCAds, getShortlinks, postback, offerwallPostback };

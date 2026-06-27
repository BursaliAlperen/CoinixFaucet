const express = require('express');
const router = express.Router();

const authController = require('../controllers/authController');
const faucetController = require('../controllers/faucetController');
const withdrawController = require('../controllers/withdrawController');
const swapController = require('../controllers/swapController');
const adminController = require('../controllers/adminController');
const offerwallmeController = require('../controllers/offerwallmeController');
const statsController = require('../controllers/statsController');

const { telegramAuth, adminAuth } = require('../middleware/auth');
const { generalLimiter, authLimiter, claimLimiter, withdrawLimiter } = require('../middleware/rateLimiter');
const { claimBody, withdrawBody, swapBody, userIdParam } = require('../utils/validators');

// Health check
router.get('/ping', (req, res) => res.status(200).send('OK'));

// Auth
router.post('/api/auth', authLimiter, authController.auth);

// Balance
router.get('/api/balance/:userId', generalLimiter, userIdParam, authController.getBalance);

// Faucet
router.post('/api/claim', claimLimiter, claimBody, faucetController.claim);

// Withdraw
router.post('/api/withdraw', withdrawLimiter, withdrawBody, withdrawController.withdraw);
router.get('/api/withdrawals/:userId', generalLimiter, userIdParam, withdrawController.getHistory);
router.get('/api/withdrawals/recent', generalLimiter, withdrawController.getRecent);
router.get('/api/withdrawals/stats', generalLimiter, withdrawController.getStats);

// Swap
router.post('/api/swap', generalLimiter, swapBody, swapController.swap);

// Stats
router.get('/api/stats', adminAuth, generalLimiter, statsController.getGlobalStats);
router.get('/api/stats/user/:userId', generalLimiter, userIdParam, statsController.getUserStats);
router.get('/api/stats/user/:userId/charts', generalLimiter, userIdParam, statsController.getUserCharts);
router.get('/api/admin/charts', adminAuth, generalLimiter, statsController.getAdminCharts);

// Referral
router.get('/api/referral/:userId', generalLimiter, userIdParam, authController.getReferral);

// Offerwall.me - iFrame, PTC, Shortlinks
router.get('/api/offerwall/offerwall/:userId', generalLimiter, offerwallmeController.getOfferwallUrl);
router.get('/api/offerwall/ptc/:userId', generalLimiter, offerwallmeController.getPTCAds);
router.get('/api/offerwall/shortlinks/:userId', generalLimiter, offerwallmeController.getShortlinks);

// Offerwall.me NATIVE Postback (POST request from Offerwall.me servers)
// Signature: MD5(subId.transId.reward.secretkey) - DOT separated!
// Response must be plain text "ok"
router.post('/api/postback', generalLimiter, offerwallmeController.postback);

// Offerwall.me CUSTOM Postback (POST with ADMIN_SECRET_KEY signature)
router.post('/api/offerwall-postback', generalLimiter, offerwallmeController.offerwallPostback);

// Admin
router.get('/api/admin/users', adminAuth, generalLimiter, adminController.getUsers);
router.get('/api/admin/withdrawals', adminAuth, generalLimiter, adminController.getWithdrawals);
router.post('/api/admin/approve-withdrawal', adminAuth, generalLimiter, adminController.approveWithdrawal);
router.post('/api/admin/add-balance', adminAuth, generalLimiter, adminController.addBalance);
router.post('/api/admin/ban-user', adminAuth, generalLimiter, adminController.banUser);
router.post('/api/admin/delete-user', adminAuth, generalLimiter, adminController.deleteUser);
router.get('/api/admin/logs', adminAuth, generalLimiter, adminController.getLogs);
router.get('/api/admin/settings', adminAuth, generalLimiter, adminController.getSettings);
router.post('/api/admin/settings', adminAuth, generalLimiter, adminController.updateSettings);
router.post('/api/admin/broadcast', adminAuth, generalLimiter, adminController.broadcast);

module.exports = router;

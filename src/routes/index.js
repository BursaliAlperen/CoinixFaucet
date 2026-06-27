const express = require('express');
const router = express.Router();

const authController = require('../controllers/authController');
const faucetController = require('../controllers/faucetController');
const withdrawController = require('../controllers/withdrawController');
const swapController = require('../controllers/swapController');
const adminController = require('../controllers/adminController');
const offerwallmeController = require('../controllers/offerwallmeController');
const statsController = require('../controllers/statsController');

const { telegramAuth, jwtAuth, adminAuth } = require('../middleware/auth');
const { generalLimiter, authLimiter, claimLimiter, withdrawLimiter } = require('../middleware/rateLimiter');
const { claimBody, withdrawBody, swapBody } = require('../utils/validators');

router.get('/ping', (req, res) => res.status(200).send('OK'));

router.post('/api/auth', authLimiter, authController.auth);

router.use('/api', generalLimiter);

router.get('/api/me', jwtAuth, authController.getMe);
router.get('/api/balance', jwtAuth, authController.getBalance);
router.post('/api/claim', claimLimiter, jwtAuth, claimBody, faucetController.claim);
router.post('/api/withdraw', withdrawLimiter, jwtAuth, withdrawBody, withdrawController.withdraw);
router.get('/api/withdrawals', jwtAuth, withdrawController.getHistory);
router.get('/api/withdrawals/recent', withdrawController.getRecent);
router.get('/api/withdrawals/stats', jwtAuth, withdrawController.getStats);
router.post('/api/swap', jwtAuth, swapBody, swapController.swap);
router.get('/api/referral', jwtAuth, authController.getReferral);

router.get('/api/offerwall/offerwall', jwtAuth, offerwallmeController.getOfferwallUrl);
router.get('/api/offerwall/ptc', jwtAuth, offerwallmeController.getPTCAds);
router.get('/api/offerwall/shortlinks', jwtAuth, offerwallmeController.getShortlinks);

router.post('/api/postback', offerwallmeController.postback);
router.post('/api/offerwall-postback', offerwallmeController.offerwallPostback);

router.get('/api/stats', adminAuth, statsController.getGlobalStats);
router.get('/api/stats/user/:userId', jwtAuth, statsController.getUserStats);
router.get('/api/stats/user/:userId/charts', jwtAuth, statsController.getUserCharts);
router.get('/api/admin/charts', adminAuth, statsController.getAdminCharts);

router.get('/api/admin/users', adminAuth, adminController.getUsers);
router.get('/api/admin/withdrawals', adminAuth, adminController.getWithdrawals);
router.post('/api/admin/approve-withdrawal', adminAuth, adminController.approveWithdrawal);
router.post('/api/admin/add-balance', adminAuth, adminController.addBalance);
router.post('/api/admin/ban-user', adminAuth, adminController.banUser);
router.post('/api/admin/delete-user', adminAuth, adminController.deleteUser);
router.get('/api/admin/logs', adminAuth, adminController.getLogs);
router.get('/api/admin/settings', adminAuth, adminController.getSettings);
router.post('/api/admin/settings', adminAuth, adminController.updateSettings);
router.post('/api/admin/broadcast', adminAuth, adminController.broadcast);

module.exports = router;

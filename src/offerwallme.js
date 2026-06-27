const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');

const OFFERWALLME_API_KEY = process.env.OFFERWALLME_API_KEY;
const OFFERWALLME_SECRET_KEY = process.env.OFFERWALLME_SECRET_KEY;
const OFFERWALLME_API_TOKEN = process.env.OFFERWALLME_API_TOKEN;
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY; // Ayrı env var for offerwall postback
const BASE_URL = 'https://offerwall.me';
const TIMEOUT = 15000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

// IP Whitelist for postback security (Offerwall.me servers)
const ALLOWED_IPS = ['95.216.65.163', '2a01:4f9:2b:1dc::2'];

class OfferwallMeService {
  constructor() {
    if (!OFFERWALLME_API_KEY) {
      logger.warn('OFFERWALLME_API_KEY is not set. Offerwall.me integration will be disabled.');
    }
  }

  async _request(method, endpoint, options = {}, retries = 0) {
    const url = `${BASE_URL}${endpoint}`;
    const config = {
      method,
      url,
      timeout: TIMEOUT,
      ...options
    };

    try {
      logger.debug('Offerwall.me API request', { method, endpoint });
      const response = await axios(config);
      logger.debug('Offerwall.me API success', { endpoint, status: response.status });
      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Offerwall.me API error', { endpoint, error: error.message, code: error.code });

      if (retries < MAX_RETRIES && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || !error.response)) {
        logger.warn(`Offerwall.me retry ${retries + 1}/${MAX_RETRIES}`, { endpoint });
        await new Promise(r => setTimeout(r, RETRY_DELAY * (retries + 1)));
        return this._request(method, endpoint, options, retries + 1);
      }

      return { 
        success: false, 
        error: error.response?.data?.message || error.message,
        status: error.response?.status || 500
      };
    }
  }

  // 1. Offerwall iFrame URL
  getOfferwallUrl(userId) {
    if (!OFFERWALLME_API_KEY) return null;
    const safeUserId = String(userId).replace(/[^a-zA-Z0-9]/g, '');
    return `${BASE_URL}/offerwall/${OFFERWALLME_API_KEY}/${safeUserId}`;
  }

  // 2. PTC Ads API
  async getPTCAds(userId, userIp, country = 'US') {
    if (!OFFERWALLME_API_KEY || !OFFERWALLME_API_TOKEN) {
      return { success: false, error: 'Offerwall.me not configured', data: [] };
    }
    const safeUserId = String(userId).replace(/[^a-zA-Z0-9]/g, '');
    const endpoint = `/api.php?api=${OFFERWALLME_API_KEY}&id=${safeUserId}&ip=${userIp}&token=${OFFERWALLME_API_TOKEN}&country=${country}`;
    const result = await this._request('GET', endpoint);
    if (result.success && result.data?.status === 200) {
      return { success: true, data: result.data.data || [] };
    }
    return { success: false, error: result.error || 'Failed to fetch PTC ads', data: [] };
  }

  // 3. Shortlinks API
  async getShortlinks(userId, userIp, country = 'US') {
    if (!OFFERWALLME_API_KEY || !OFFERWALLME_API_TOKEN) {
      return { success: false, error: 'Offerwall.me not configured', data: [] };
    }
    const safeUserId = String(userId).replace(/[^a-zA-Z0-9]/g, '');
    const endpoint = `/slapi.php?api=${OFFERWALLME_API_KEY}&id=${safeUserId}&ip=${userIp}&token=${OFFERWALLME_API_TOKEN}&country=${country}`;
    const result = await this._request('GET', endpoint);
    if (result.success && result.data?.status === 200) {
      return { success: true, data: result.data.data || [] };
    }
    return { success: false, error: result.error || 'Failed to fetch shortlinks', data: [] };
  }

  // 4. Offerwall.me native signature verification: MD5(subId.transId.reward.secretkey)
  // Note: Uses DOT (.) concatenation, not string concatenation!
  verifyOfferwallSignature(subId, transId, reward, signature) {
    if (!OFFERWALLME_SECRET_KEY) return true;
    const expected = crypto.createHash('md5').update(`${subId}.${transId}.${reward}.${OFFERWALLME_SECRET_KEY}`).digest('hex');
    return expected === signature;
  }

  // 5. ADMIN_SECRET_KEY signature verification for custom postback
  verifyAdminSignature(userId, offerId, amount, status, signature) {
    if (!ADMIN_SECRET_KEY) return false;
    const expected = crypto.createHash('md5').update(`${userId}${offerId}${amount}${status}${ADMIN_SECRET_KEY}`).digest('hex');
    return expected === signature;
  }

  // 6. IP whitelist check (optional)
  isAllowedIP(ip) {
    if (!ip) return false;
    return ALLOWED_IPS.includes(ip);
  }

  // 7. Calculate reward with exchange rate (amount * EXCHANGE_RATE / 100)
  calculateReward(amount, exchangeRate = 100) {
    return parseFloat((parseFloat(amount) * parseFloat(exchangeRate) / 100).toFixed(2));
  }
}

module.exports = new OfferwallMeService();

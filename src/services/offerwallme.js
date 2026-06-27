const axios = require('axios');
const logger = require('../utils/logger');

const OFFERWALL_APP_ID = process.env.OFFERWALL_APP_ID;
const OFFERWALL_SECRET = process.env.OFFERWALL_SECRET_KEY;

async function fetchOffers() {
  try {
    const res = await axios.get(`https://offerwall.me/api/offers/${OFFERWALL_APP_ID}`, {
      headers: { 'Authorization': `Bearer ${OFFERWALL_SECRET}` }
    });
    return res.data;
  } catch (err) {
    logger.error('Fetch offers error', { error: err.message });
    return [];
  }
}

module.exports = { fetchOffers };

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const compression = require('compression');
const https = require('https');

const { setupSecurity } = require('./middleware/security');
const routes = require('./routes');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 3000;

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  logger.error('Unhandled Rejection', { error: err.message, stack: err.stack });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
});

// Keep-Alive Mechanism
const KEEP_ALIVE_URL = process.env.APP_URL || `https://coinixfaucet.onrender.com`;
setInterval(() => {
  https.get(`${KEEP_ALIVE_URL}/ping`, (res) => {
    logger.debug('Keep-alive ping', { status: res.statusCode });
  }).on('error', (err) => {
    logger.error('Keep-alive ping error', { error: err.message });
  });
}, 600000); // Every 10 minutes

// ========================
// Security Middleware
// ========================
setupSecurity(app);

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ========================
// Static Files
// ========================
app.use(express.static(path.join(__dirname, '../public'), {
  maxAge: '1d',
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// ========================
// API Routes
// ========================
app.use('/', routes);

// ========================
// SPA Fallback (Telegram Mini App Fix)
// ========================
const spaPages = ['/', '/dashboard', '/faucet', '/ptc', '/withdraw', '/swap', '/history', '/admin'];
spaPages.forEach(route => {
  app.get(route, (req, res) => {
    if (route === '/admin') {
      const key = req.query.admin_key;
      const ADMIN_KEY = process.env.ADMIN_ID;
      if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(403).send('Forbidden');
    }
    const file = route === '/' ? 'index.html' : route.replace('/', '') + '.html';
    res.sendFile(path.join(__dirname, '../public', file));
  });
});

// Catch-all for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

// ========================
// Error Handling
// ========================
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, path: req.path, method: req.method });
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  logger.info('COINIX FAUCET v3.0 running', { port: PORT, env: process.env.NODE_ENV || 'development' });
});

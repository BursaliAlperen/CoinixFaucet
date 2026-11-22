'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const backend = fs.readFileSync('Backend/server.js','utf8');
const core = fs.readFileSync('Backend/earn-core.js','utf8');
const app = fs.readFileSync('Frontend/js/app.js','utf8');
const admin = fs.readFileSync('Frontend/js/admin.js','utf8');
const html = fs.readFileSync('Frontend/index.html','utf8');
const adminHtml = fs.readFileSync('Frontend/admin.html','utf8');
const icons = fs.readFileSync('Frontend/js/icons.js','utf8');
const required = [
  ['Telegram /start handler', "command==='/start'"],
  ['Required channel Telegram verification', "getChatMember"],
  ['Required channel callback retry', 'check_required_channel'],
  ['Mini App channel gate', 'showChannelGate'],
  ['Admin task lifecycle', '/api/admin/tasks'],
  ['Manual task review queue', '/api/admin/task-review'],
  ['Task idempotent claim path', 'taskClaims/'],
  ['24-hour referral multiplier', 'referralMultiplierBonus'],
  ['Referral bonus expiry', 'activeReferralBonusTotal'],
  ['Piarflow integration', 'piarflow.com/v1'],
  ['FlyerHubs integration', 'api.flyerhubs.com'],
  ['Traffy provider status', 'awaiting_official_api_contract'],
  ['Traffy personal tracking link', 'TRAFFY_LINK_PREFIX'],
  ['Daily analytics endpoint', '/api/admin/analytics'],
  ['CSV export UI', 'teddygrow-daily-statistics.csv'],
  ['Bot start/stop admin controls', '/api/admin/bot-control'],
  ['TON and GRAM payout whitelist', "['ton','gram'].includes(methodKey)"],
  ['Firestore-only authenticated data API', '/api/live'],
  ['Firestore compatibility store', 'new FirestoreCompat(firestore)'],
  ['70/30 task budget fields', 'platformBudget'],
  ['Telegram microtask commands', "{command:'campaign'"],
  ['Inline SVG icon system', 'ton:'],
  ['Istanbul reward timezone', 'Europe/Istanbul']
];
for (const [label, needle] of required) assert.ok(backend.includes(needle)||app.includes(needle)||admin.includes(needle)||html.includes(needle)||adminHtml.includes(needle)||icons.includes(needle)||core.includes(needle), 'Missing: '+label);
assert.ok(!backend.toLowerCase().includes('papara'),'Papara must not be accepted by the backend');
assert.ok(!html.toLowerCase().includes('w2e ads')&&!app.toLowerCase().includes('w2e ads'),'W2E Ads must be removed from the product');
assert.ok(!html.toLowerCase().includes('ad balance')&&!app.toLowerCase().includes('ad balance'),'Ad Balance must not appear in the user interface');
assert.ok(!backend.toLowerCase().includes('monetag')&&!app.toLowerCase().includes('monetag'),'Monetag must be fully removed from runtime code');
assert.ok(!backend.includes("command==='/botmessages'")&&!backend.includes("command==='/yeni'"),'Removed Telegram commands must stay removed');
assert.ok(!backend.includes("/api/admin/botmessages")&&!adminHtml.includes('messageForm')&&!admin.includes('messageForm'),'Removed bot-message feature must stay removed');
assert.ok(fs.readFileSync('Backend/earn-core.js','utf8').includes('1 + level * 0.02 + activeReferralBonusTotal(user, now)'),'Server level and referral multiplier formula missing');
assert.ok(fs.readFileSync('Backend/earn-core.js','utf8').includes('Math.min(1, 50, Number(user?.level) || 1)')===false && fs.readFileSync('Backend/earn-core.js','utf8').includes('Math.min(50, Number(user?.level) || 1)'),'Server level cap must be 50');
assert.ok(app.includes('Math.min(50,Number(user.level)||1)'),'Frontend level multiplier must cap at 50');
assert.ok(backend.includes("Number(settings.dailyCheckinXp || 10)"),'Daily check-in XP default missing');
assert.ok(backend.includes('API_AD_REWARD_USD = 0.002'),'Fixed provider API reward missing');
assert.ok(backend.includes("Number(settings.taskXp || 20)"),'Task XP default missing');
assert.ok(fs.existsSync('md/AD_NETWORKS.md'),'Ad network research doc missing');
assert.ok(!fs.existsSync('md/MONETAG.md'),'Retired Monetag docs must be removed');
assert.ok(fs.existsSync('md/FLYERHUBS.md'),'FlyerHubs docs missing');
assert.ok(!fs.existsSync('README.md')&&!fs.existsSync('API.md'),'Root markdown docs should live in /md');
console.log('TeddyGrow smoke checks passed: '+required.length+' feature checks + removed-feature and docs/layout checks.');

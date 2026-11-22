'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const backend = fs.readFileSync('Backend/server.js','utf8');
const app = fs.readFileSync('Frontend/js/app.js','utf8');
const admin = fs.readFileSync('Frontend/js/admin.js','utf8');
const html = fs.readFileSync('Frontend/index.html','utf8');
const adminHtml = fs.readFileSync('Frontend/admin.html','utf8');
const required = [
  ['Telegram /start handler', "command==='/start'"],
  ['Telegram /botmessages handler', "command==='/botmessages'"],
  ['Telegram /yeni handler', "command==='/yeni'"],
  ['Telegram /level handler', "command==='/level'"],
  ['Telegram /referrals handler', "command==='/referrals'"],
  ['Admin promo endpoint', "/api/admin/promo"],
  ['Admin bot message endpoint', "/api/admin/botmessages"],
  ['Promotion channel publish', "sendTelegramMessage(ANNOUNCEMENT_CHANNEL_ID"],
  ['Referral in-app notification', "users/' + validReferralCode + '/notifications"],
  ['Referral XP award', "settings.referralXp || 10"],
  ['FlyerHubs task listing', "'/get_tasks'"],
  ['FlyerHubs completion verification', "'/check_task'"],
  ['Monetag valued callback', "reward_event_type') !== 'valued'"],
  ['Monetag strict Telegram ID validation', "if (!/^\\d{1,20}$/.test(uid)"],
  ['Level 100 reward multiplier', "function rewardMultiplier(user)"],
  ['Istanbul reward timezone', "Europe/Istanbul"],
  ['Server admin shortcut', 'adminOpenBtn'],
  ['Admin dashboard actions', "api('/api/admin/promo'"]
];
for (const [label, needle] of required) assert.ok(backend.includes(needle)||app.includes(needle)||admin.includes(needle)||html.includes(needle)||adminHtml.includes(needle), 'Missing: '+label);
assert.ok(backend.includes("Number(settings.dailyCheckinXp || 10)"),'Daily check-in XP default missing');
assert.ok(backend.includes("Number(settings.adWatchXp || 10)"),'Verified ad XP default missing');
assert.ok(backend.includes("Number(settings.taskXp || 20)"),'Task XP default missing');
assert.ok(fs.existsSync('md/AD_NETWORKS.md'),'Ad network research doc missing');
assert.ok(fs.existsSync('md/FLYERHUBS.md'),'FlyerHubs docs missing');
assert.ok(!fs.existsSync('README.md')&&!fs.existsSync('API.md'),'Root markdown docs should live in /md');
console.log('Coinix smoke checks passed: '+required.length+' feature checks + docs/layout checks.');

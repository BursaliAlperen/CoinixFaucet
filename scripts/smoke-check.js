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
  ['Telegram /level handler', "command==='/level'"],
  ['Telegram /referrals handler', "command==='/referrals'"],
  ['Admin promo endpoint', "/api/admin/promo"],
  ['Promotion channel publish', "sendTelegramMessage(ANNOUNCEMENT_CHANNEL_ID"],
  ['Referral in-app notification', "users/' + validReferralCode + '/notifications"],
  ['Referral XP award', "settings.referralXp || 10"],
  ['FlyerHubs task listing', "'/get_tasks'"],
  ['FlyerHubs completion verification', "'/check_task'"],
  ['Monetag valued callback', "reward_event_type') !== 'valued'"],
  ['Monetag strict Telegram ID validation', "if (!/^\\d{1,20}$/.test(uid)"],
  ['Level multiplier function', "function rewardMultiplier(user)"],
  ['Frontend multiplier display', "getRewardMultiplier(currentUser.level)"],
  ['Istanbul reward timezone', "Europe/Istanbul"],
  ['Server admin shortcut', 'adminOpenBtn'],
  ['Admin dashboard actions', "api('/api/admin/promo'"]
];
for (const [label, needle] of required) assert.ok(backend.includes(needle)||app.includes(needle)||admin.includes(needle)||html.includes(needle)||adminHtml.includes(needle), 'Missing: '+label);
assert.ok(!backend.includes("command==='/botmessages'")&&!backend.includes("command==='/yeni'"),'Removed Telegram commands must stay removed');
assert.ok(!backend.includes("/api/admin/botmessages")&&!adminHtml.includes('messageForm')&&!admin.includes('messageForm'),'Removed bot-message feature must stay removed');
assert.ok(backend.includes("return Math.round((1 + level * 0.02) * 100) / 100;"),'Server level multiplier formula missing');
assert.ok(backend.includes('Math.min(50, Number(user.level || 1))') && backend.includes('user.level < 50'),'Server level cap must be 50');
assert.ok(app.includes('Math.min(50,Number(level)||1)'),'Frontend level multiplier must cap at 50');
assert.ok(backend.includes("Number(settings.dailyCheckinXp || 10)"),'Daily check-in XP default missing');
assert.ok(backend.includes("Number(settings.adWatchXp || 10)"),'Verified ad XP default missing');
assert.ok(backend.includes("Number(settings.taskXp || 20)"),'Task XP default missing');
assert.ok(fs.existsSync('md/AD_NETWORKS.md'),'Ad network research doc missing');
assert.ok(fs.existsSync('md/FLYERHUBS.md'),'FlyerHubs docs missing');
assert.ok(!fs.existsSync('README.md')&&!fs.existsSync('API.md'),'Root markdown docs should live in /md');
console.log('Coinix smoke checks passed: '+required.length+' feature checks + removed-feature and docs/layout checks.');

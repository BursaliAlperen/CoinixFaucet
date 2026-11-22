'use strict';
function activeReferralBonusTotal(user, now = Date.now()) {
  const bonuses = user?.referralBonuses || {};
  return Object.values(bonuses).reduce((sum, bonus) => {
    if (!bonus || Number(bonus.startsAt || 0) > now || Number(bonus.endsAt || 0) <= now) return sum;
    return sum + Math.max(0, Math.min(0.25, Number(bonus.multiplierBonus || 0)));
  }, 0);
}
function rewardMultiplier(user, now = Date.now()) {
  const level = Math.max(1, Math.min(50, Number(user?.level) || 1));
  return Math.round((1 + level * 0.02 + activeReferralBonusTotal(user, now)) * 10000) / 10000;
}
function isTelegramMember(member) {
  return ['creator','administrator','member'].includes(String(member?.status || '')) ||
    (member?.status === 'restricted' && member.is_member === true);
}
function isTaskOpen(task, now = Date.now()) {
  if (!task) return false;
  const status = task.status || (task.active === false ? 'paused' : 'active');
  if (status !== 'active') return false;
  if (Number(task.startAt || 0) > now) return false;
  if (Number(task.endAt || 0) > 0 && Number(task.endAt) < now) return false;
  const limit = Number(task.totalLimit || 0);
  if (limit > 0 && Number(task.totalParticipants || 0) >= limit) return false;
  return true;
}
function cleanTaskInput(body, now = Date.now()) {
  const title = String(body.title || '').trim().slice(0, 100);
  const description = String(body.description || '').trim().slice(0, 1000);
  const type = String(body.type || '').toLowerCase();
  const verificationMethod = String(body.verificationMethod || '').toLowerCase();
  const url = String(body.url || '').trim().slice(0, 500);
  const chatId = String(body.chatId || '').trim().slice(0, 120);
  const reward = Number(body.reward);
  const startAt = body.startAt ? new Date(body.startAt).getTime() : now;
  const endAt = body.endAt ? new Date(body.endAt).getTime() : 0;
  const totalLimit = Math.max(0, Math.min(10000000, Math.floor(Number(body.totalLimit || 0))));
  const perUserLimit = Math.max(1, Math.min(10, Math.floor(Number(body.perUserLimit || 1))));
  if (!title || !description || !['channel','group','link','manual'].includes(type)) throw new Error('INVALID_TASK_FIELDS');
  if (!Number.isFinite(reward) || reward <= 0 || reward > 100000) throw new Error('INVALID_TASK_REWARD');
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || (endAt && endAt <= startAt)) throw new Error('INVALID_TASK_DATES');
  if (!url.startsWith('https://')) throw new Error('INVALID_TASK_URL');
  if (['channel','group'].includes(type) && !chatId && !/^https:\/\/t\.me\/[A-Za-z0-9_]{5,}/i.test(url)) throw new Error('TASK_CHAT_REQUIRED');
  if (!['telegram_membership','manual'].includes(verificationMethod)) throw new Error('INVALID_TASK_VERIFICATION');
  if (['channel','group'].includes(type) && verificationMethod !== 'telegram_membership') throw new Error('TELEGRAM_TASK_REQUIRES_MEMBERSHIP_CHECK');
  if (['link','manual'].includes(type) && verificationMethod !== 'manual') throw new Error('MANUAL_TASK_REQUIRES_MANUAL_REVIEW');
  return { title, description, type, verificationMethod, url, chatId, reward, startAt, endAt, totalLimit, perUserLimit };
}
module.exports = { activeReferralBonusTotal, rewardMultiplier, isTelegramMember, isTaskOpen, cleanTaskInput };

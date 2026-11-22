'use strict';
const assert = require('node:assert/strict');
const {activeReferralBonusTotal,rewardMultiplier,isTelegramMember,isTaskOpen,cleanTaskInput,isValidReferral,FixedWindowLimiter,isNewExternalEvent,isTraffyApiReady,classifyProviderError}=require('../Backend/earn-core');
const now=Date.now();
const {splitTaskPrice}=require('../Backend/earn-core');
const split=splitTaskPrice(10);
assert.equal(split.reward,7);
assert.equal(split.platformFee,3);
assert.equal(split.grossPrice,10);
const u={level:10,referralBonuses:{
  live:{startsAt:now-1000,endsAt:now+10000,multiplierBonus:0.02},
  expired:{startsAt:now-20000,endsAt:now-10000,multiplierBonus:0.02},
  future:{startsAt:now+10000,endsAt:now+20000,multiplierBonus:0.02}
}};
assert.equal(activeReferralBonusTotal(u,now),0.02);
assert.equal(rewardMultiplier(u,now),1.22);
assert.equal(activeReferralBonusTotal(u,now+11000),0.02);
assert.equal(activeReferralBonusTotal(u,now+21000),0);
assert.equal(rewardMultiplier({level:50},now),2);
assert.equal(isTelegramMember({status:'member'}),true);
assert.equal(isTelegramMember({status:'left'}),false);
assert.equal(isTelegramMember({status:'restricted',is_member:true}),true);
assert.equal(isTaskOpen({status:'active',startAt:now-1,endAt:now+1000,totalLimit:0,totalParticipants:0},now),true);
assert.equal(isTaskOpen({status:'paused'},now),false);
assert.equal(isTaskOpen({status:'active',totalLimit:1,totalParticipants:1},now),false);
const task=cleanTaskInput({title:'Join',description:'Join channel',type:'channel',verificationMethod:'telegram_membership',url:'https://t.me/examplechannel',chatId:'@examplechannel',reward:0.002,startAt:new Date(now).toISOString(),totalLimit:100,perUserLimit:1},now);
assert.equal(task.reward,0.0014);
assert.equal(task.grossPrice,0.002);
assert.equal(task.platformFee,0.0006);
assert.equal(task.grossBudget,0.2);
assert.equal(task.workerBudget,0.14);
assert.equal(task.platformBudget,0.06);
assert.throws(()=>cleanTaskInput({title:'x',description:'x',type:'link',verificationMethod:'telegram_membership',url:'https://example.com',reward:1},now));
console.log('earn-core tests: referral, task, bonus expiry, Traffy limiter and idempotency assertions passed');

assert.equal(isValidReferral('123456','654321',false),true);
assert.equal(isValidReferral('123456','123456',false),false);
assert.equal(isValidReferral('abc','654321',false),false);
assert.equal(isValidReferral('123456','654321',true),false);
const limiter=new FixedWindowLimiter(300,60000);
for(let i=0;i<300;i++)assert.equal(limiter.take(1000),true);
assert.equal(limiter.take(1000),false);
assert.equal(limiter.take(61000),true);
assert.equal(isNewExternalEvent('evt_1',{}),true);
assert.equal(isNewExternalEvent('evt_1',{evt_1:true}),false);
assert.equal(isNewExternalEvent('',{}),false);
assert.equal(isTraffyApiReady('secret',false),false);
assert.equal(isTraffyApiReady('secret',true),true);
assert.equal(isTraffyApiReady('',true),false);
assert.equal(classifyProviderError(429),'RATE_LIMITED');
assert.equal(classifyProviderError(503),'TEMPORARY_UPSTREAM_ERROR');
assert.equal(classifyProviderError(401),'PROVIDER_REJECTED');

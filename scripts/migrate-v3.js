'use strict';
const admin=require('firebase-admin');

async function main(){
  const raw=String(process.env.FIREBASE_SERVICE_ACCOUNT||'').trim();
  const databaseURL=String(process.env.FIREBASE_DATABASE_URL||'').trim();
  if(!raw||!databaseURL)throw new Error('FIREBASE_SERVICE_ACCOUNT and FIREBASE_DATABASE_URL are required');
  const serviceAccount=raw.startsWith('{')?JSON.parse(raw):JSON.parse(Buffer.from(raw,'base64').toString('utf8'));
  if(!serviceAccount.project_id)throw new Error('Service account project_id missing');
  if(!new URL(databaseURL).hostname.toLowerCase().includes(serviceAccount.project_id.toLowerCase()))throw new Error('Firebase project mismatch');
  const apply=process.env.RUN_MIGRATION==='1';
  admin.initializeApp({credential:admin.credential.cert(serviceAccount),databaseURL});
  const db=admin.database();
  const defaults={referralMultiplierBonus:0.02,referralBonusDurationHours:24};
  const [usersSnap,tasksSnap,settingsSnap]=await Promise.all([
    db.ref('users').once('value'),db.ref('tasks').once('value'),db.ref('settings').once('value')
  ]);
  let users=0,tasks=0;
  const userUpdates={},taskUpdates={};
  usersSnap.forEach(child=>{
    const value=child.val()||{},patch={};
    if(!value.referralBonuses)patch.referralBonuses={};
    if(!value.taskCompletionCounts)patch.taskCompletionCounts={};
    if(!value.completedTaskClaims)patch.completedTaskClaims={};
    if(!value.processedActions)patch.processedActions={};
    if(Object.keys(patch).length){users++;userUpdates['users/'+child.key]=patch;}
  });
  tasksSnap.forEach(child=>{
    const value=child.val()||{},patch={};
    if(value.status==null)patch.status=value.active===false?'paused':'active';
    if(value.active==null)patch.active=patch.status?patch.status==='active':true;
    if(value.totalParticipants==null)patch.totalParticipants=0;
    if(value.perUserLimit==null)patch.perUserLimit=1;
    if(value.verificationMethod==null){
      const type=String(value.type||'').toLowerCase();
      patch.verificationMethod=['telegram','channel','group'].includes(type)?'telegram_membership':'manual';
    }
    if(Object.keys(patch).length){tasks++;taskUpdates['tasks/'+child.key]=patch;}
  });
  const currentSettings=settingsSnap.val()||{},settingsPatch={};
  for(const [key,value] of Object.entries(defaults))if(currentSettings[key]==null)settingsPatch[key]=value;
  console.log(JSON.stringify({mode:apply?'APPLY':'DRY_RUN',usersToPatch:users,tasksToPatch:tasks,settingsToAdd:Object.keys(settingsPatch).length,balancesPreserved:true,legacyReferralCashRecordsPreserved:true}));
  if(apply){
    const updates={...userUpdates,...taskUpdates};
    if(Object.keys(updates).length)await db.ref().update(updates);
    if(Object.keys(settingsPatch).length)await db.ref('settings').update(settingsPatch);
    await db.ref('schemaVersion').transaction(v=>Math.max(3,Number(v||0)));
    console.log('Coinix schema migration v3 applied.');
  }else{
    console.log('No data changed. Set RUN_MIGRATION=1 to apply the additive migration.');
  }
  await admin.app().delete();
}
main().catch(error=>{console.error('[migration]',String(error.message||'MIGRATION_FAILED'));process.exitCode=1;});

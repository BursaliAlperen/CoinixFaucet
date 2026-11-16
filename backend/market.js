import crypto from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
const BASE='https://offerwallapi.com';
const clean=(v,max=2000)=>typeof v==='string'?v.trim().slice(0,max):'';
function cfg(){const c={key:process.env.OFFERWALLAPI_KEY,bearer:process.env.OFFERWALLAPI_BEARER_TOKEN,secret:process.env.OFFERWALLAPI_SECRET};return c.key&&c.bearer&&c.secret?c:null;}
async function providerGet(path,bearer){const r=await fetch(BASE+path,{headers:{Authorization:'Bearer '+bearer,Accept:'application/json'},signal:AbortSignal.timeout(12000)});const d=await r.json().catch(()=>null);if(!r.ok||!d||String(d.status)!=='200'){const e=new Error(d?.message||'OfferwallAPI request failed');e.status=r.status||502;throw e;}return d;}
export function registerCoinixMarket(app,{db,verifyToken}){
 const ready=(req,res,next)=>db?next():res.status(503).json({success:false,code:'DATABASE_UNAVAILABLE'});
 const configured=(req,res,next)=>cfg()?next():res.status(503).json({success:false,code:'OFFERWALL_NOT_CONFIGURED',message:'OfferwallAPI credentials are not configured on the server.'});
 app.get('/api/market/feed',ready,verifyToken,configured,async(req,res)=>{
  try{
   const c=cfg(),uid=req.user.uid;if(uid.length>64)return res.status(400).json({success:false,message:'Account identifier is too long for OfferwallAPI Sub ID.'});
   const ip=String(req.ip||req.socket?.remoteAddress||'0.0.0.0').replace(/^::ffff:/,'');
   const p=encodeURIComponent(c.key)+'/'+encodeURIComponent(uid)+'/'+encodeURIComponent(ip);
   const results=await Promise.all([providerGet('/ptc-api/'+p,c.bearer),providerGet('/task-api/'+p,c.bearer)]);
   const ptc=(Array.isArray(results[0].data)?results[0].data:[]).map(x=>({id:String(x.id),type:'ptc',title:clean(x.title,180),description:clean(x.description,500),reward:Number(x.reward||0),currencyName:clean(x.currency_name,30)||'COINIX',duration:Number(x.duration||0),url:x.url||null,image:x.image||null,adType:x.ad_type||null}));
   const micro=(Array.isArray(results[1].data)?results[1].data:[]).map(x=>({id:String(x.id),type:'microtask',title:clean(x.title,180),description:clean(x.description,500),instructions:clean(x.instructions,3000),requirements:clean(x.requirements,500),proofType:clean(x.proofType,30),proofHint:clean(x.proofHint,500),targetUrl:x.targetUrl||null,ticket:x.ticket||null,reward:Number(x.reward||0),currencyName:clean(x.currency_name,30)||'COINIX',rewardUsd:Number(x.reward_usd||0),status:clean(x.status,30)||'available'}));
   res.json({success:true,currency:'COINIX',tasks:ptc.concat(micro)});
  }catch(e){console.error('OfferwallAPI feed error:',e);res.status(e.status||502).json({success:false,message:'Could not load partner tasks. Please try again shortly.'});}
 });
 app.post('/api/market/microtasks/:taskId/submit',ready,verifyToken,configured,async(req,res)=>{
  try{
   const c=cfg(),uid=req.user.uid;if(uid.length>64)return res.status(400).json({success:false,message:'Account identifier is too long.'});
   const ip=String(req.ip||req.socket?.remoteAddress||'0.0.0.0').replace(/^::ffff:/,'');
   const proof=clean(req.body.proof,2000),ticket=clean(req.body.ticket,500);
   if(!proof||!ticket)return res.status(400).json({success:false,message:'Proof and task ticket are required.'});
   const p=encodeURIComponent(c.key)+'/'+encodeURIComponent(uid)+'/'+encodeURIComponent(ip);
   const r=await fetch(BASE+'/task-api/'+p,{method:'POST',headers:{Authorization:'Bearer '+c.bearer,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({taskId:String(req.params.taskId),proof,ticket}),signal:AbortSignal.timeout(12000)});
   const d=await r.json().catch(()=>null);
   if(!r.ok||!d||String(d.status)!=='200')return res.status(r.status||400).json({success:false,message:d?.message||'OfferwallAPI did not accept this proof.'});
   res.json({success:true,status:'pending_review',message:d.message||'Proof submitted to OfferwallAPI for review.'});
  }catch(e){console.error('OfferwallAPI microtask submit error:',e);res.status(e.status||502).json({success:false,message:'Could not submit proof. Please try again.'});}
 });
 app.post('/api/market/offerwallapi/postback',ready,async(req,res)=>{
  try{
   const c=cfg();if(!c)return res.status(503).send('not configured');
   const b=req.body||{},uid=String(b.subId||''),transId=String(b.transId||''),rewardText=String(b.reward??''),status=String(b.status||'');
   if(!uid||uid.length>64||!transId||!/^(?:\d+\.?\d*|\.\d+)$/.test(rewardText)||!['1','2'].includes(status))return res.status(400).send('invalid payload');
   const payload=uid+transId+rewardText;
   const hmac=crypto.createHmac('sha256',c.secret).update(payload).digest('hex');
   const md5=crypto.createHash('md5').update(payload+c.secret).digest('hex');
   const eq=(a,b)=>{const x=Buffer.from(String(a||'').toLowerCase()),y=Buffer.from(String(b||'').toLowerCase());return x.length===y.length&&crypto.timingSafeEqual(x,y);};
   if(!eq(b.signature2,hmac)&&!eq(b.signature,md5))return res.status(401).send('invalid signature');
   if(String(b.debug||'0')==='1')return res.status(200).send('ok');
   const kind=String(b.offer_type||'').toLowerCase();if(!['ptc','microtask'].includes(kind))return res.status(200).send('ok');
   const amount=Number(rewardText),delta=status==='2'?-Math.abs(amount):Math.abs(amount);
   const eventId=crypto.createHash('sha256').update(transId).digest('hex');
   const eventRef=db.collection('coinix_offerwall_events').doc(eventId),userRef=db.collection('users').doc(uid);
   await db.runTransaction(async tx=>{
    const pair=await Promise.all([tx.get(eventRef),tx.get(userRef)]);
    if(pair[0].exists)return;
    if(!pair[1].exists)throw new Error('USER_NOT_FOUND');
    tx.create(eventRef,{userId:uid,transactionId:transId,offerType:kind,amount:delta,status,createdAt:FieldValue.serverTimestamp()});
    tx.update(userRef,{coinixAvailable:FieldValue.increment(delta)});
    tx.create(db.collection('coinix_ledger').doc(),{userId:uid,amount:delta,type:delta<0?'offerwall_chargeback':'offerwall_reward',provider:'OfferwallAPI',offerType:kind,transactionId:transId,createdAt:FieldValue.serverTimestamp()});
   });
   res.status(200).send('ok');
  }catch(e){if(e.message==='USER_NOT_FOUND')return res.status(404).send('unknown user');console.error('OfferwallAPI postback error:',e);res.status(500).send('processing error');}
 });
}

// Coinix FAUCET — Backend (bağımlılık yok, Node 18+)  ->  node server.js
// Ortam: BOT_TOKEN, PIARFLOW_API_KEY, PORT(3000), WEBHOOK_SECRET(ops.), DEV_USER_ID(ops., sadece yerel test)
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const{BOT_TOKEN,PIARFLOW_API_KEY,WEBHOOK_SECRET='',DEV_USER_ID,PORT=3000}=process.env;
const PF='https://piarflow.com/v1',hits=new Map();
if(!BOT_TOKEN||!PIARFLOW_API_KEY)console.warn('UYARI: BOT_TOKEN ve PIARFLOW_API_KEY tanımlı değil, sponsor API çalışmaz.');

const send=(res,code,obj)=>{res.writeHead(code,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'});res.end(JSON.stringify(obj));};
const limited=id=>{const n=Date.now(),a=(hits.get(id)||[]).filter(t=>n-t<60000);a.push(n);hits.set(id,a);return a.length>30;};
const body=req=>new Promise((ok,no)=>{let d='';req.on('data',c=>{d+=c;if(d.length>1e4){req.destroy();no(new Error('big'));}});req.on('end',()=>{try{ok(JSON.parse(d||'{}'))}catch{ok({})}});});

function verify(initData){ // Telegram Mini App initData doğrulaması
  if(!initData)return DEV_USER_ID?Number(DEV_USER_ID):null;
  if(!BOT_TOKEN)return null;
  const p=new URLSearchParams(initData),h=p.get('hash');p.delete('hash');
  const dcs=[...p.entries()].sort(([a],[b])=>a<b?-1:1).map(([k,v])=>k+'='+v).join('\n');
  const secret=crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
  const sig=crypto.createHmac('sha256',secret).update(dcs).digest('hex');
  if(!h||h.length!==sig.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(h)))return null;
  if(Date.now()/1000-Number(p.get('auth_date'))>86400)return null;
  try{return JSON.parse(p.get('user')).id}catch{return null}
}
async function pf(route,payload){
  const r=await fetch(PF+route,{method:'POST',headers:{Authorization:'Bearer '+PIARFLOW_API_KEY,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
  return{code:r.status,data:await r.json().catch(()=>({status:'error',message:'Geçersiz yanıt'}))};
}

http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://x');
  try{
    if(req.method==='OPTIONS')return send(res,204,{});
    if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='/index.html')){
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});
      return fs.createReadStream(path.join(__dirname,'index.html')).pipe(res);
    }
    if(u.pathname==='/health')return send(res,200,{ok:true,pf:!!PIARFLOW_API_KEY,bot:!!BOT_TOKEN});

    if(req.method==='POST'&&(u.pathname==='/api/sponsors'||u.pathname==='/api/sponsors/check')){
      const b=await body(req),uid=verify(b.initData);
      if(!uid)return send(res,401,{status:'error',message:'Yetkisiz: uygulamayı Telegram içinden açın'});
      if(limited(uid))return send(res,429,{status:'error',message:'Çok fazla istek, biraz bekleyin'});
      if(u.pathname==='/api/sponsors'){
        const max=Math.min(10,Math.max(1,parseInt(b.max_sponsors)||10));
        const r=await pf('/sponsors',{user_id:uid,chat_id:uid,max_sponsors:max});return send(res,r.code,r.data);
      }
      const links=(Array.isArray(b.links)?b.links:[]).filter(l=>typeof l==='string'&&l.length<300).slice(0,10);
      if(!links.length)return send(res,400,{status:'error',message:'links gerekli'});
      const r=await pf('/sponsors/check',{user_id:uid,links});return send(res,r.code,r.data);
    }

    // PiarFlow abonelikten çıkma webhook'u:  https://alanadiniz.com/api/piarflow/webhook?secret=WEBHOOK_SECRET
    if(req.method==='POST'&&u.pathname==='/api/piarflow/webhook'){
      if(WEBHOOK_SECRET&&u.searchParams.get('secret')!==WEBHOOK_SECRET)return send(res,403,{ok:false});
      const b=await body(req);
      if(!b.test&&b.status==='unsubscribed')fs.appendFile(path.join(__dirname,'unsubscribed.log'),JSON.stringify({t:Date.now(),...b})+'\n',()=>{});
      return send(res,200,{ok:true});
    }
    send(res,404,{status:'error',message:'Not found'});
  }catch(e){console.error(e.message);send(res,500,{status:'error',message:'Sunucu hatası'});}
}).listen(PORT,()=>console.log('Coinix FAUCET sunucusu: http://localhost:'+PORT));

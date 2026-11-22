'use strict';
(() => {
  const symbols = {
    home:'<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    users:'<path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    list:'<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3 6 1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2"/>',
    trophy:'<path d="M8 21h8m-4-4v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H3v2a4 4 0 0 0 4 4m10-6h4v2a4 4 0 0 1-4 4"/>',
    wallet:'<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 8h18m-5 5h5"/><circle cx="16" cy="13" r=".7"/>',
    bell:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18m-13 4 2 2 4-4"/>',
    shield:'<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11z"/><path d="m9 12 2 2 4-4"/>',
    check:'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    close:'<path d="m18 6-12 12M6 6l12 12"/>',
    play:'<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4z"/>',
    coins:'<ellipse cx="9" cy="6" rx="6" ry="3"/><path d="M3 6v5c0 1.7 2.7 3 6 3s6-1.3 6-3V6M3 11v5c0 1.7 2.7 3 6 3 1.4 0 2.7-.2 3.8-.7"/><path d="M15 13c3.3 0 6 1.3 6 3s-2.7 3-6 3-6-1.3-6-3 2.7-3 6-3z"/>',
    megaphone:'<path d="m3 11 18-5v12L3 13z"/><path d="m7 14 2 7h4l-2-6M21 10l2-2m-2 8 2 2"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h3"/>',
    crown:'<path d="m2 8 5 4 5-8 5 8 5-4-2 12H4z"/><path d="M4 17h16"/>',
    diamond:'<path d="m6 3-4 6 10 12L22 9l-4-6z"/><path d="M2 9h20M6 3l6 18 6-18"/>',
    gift:'<rect x="3" y="8" width="18" height="13" rx="2"/><path d="M2 8h20v4H2zM12 8v13m0-13H8a3 3 0 1 1 3-3z m0 3h4a3 3 0 1 0-3-3"/>',
    info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-9h.01"/>',
    bolt:'<path d="m13 2-3 9h7L9 22l3-9H5z"/>',
    receipt:'<path d="M5 3h14v18l-3-2-4 2-4-2-3 2zM8 8h8M8 12h8M8 16h4"/>',
    bag:'<path d="M5 8h14l1 13H4z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    cart:'<path d="M3 4h2l2 12h11l3-9H6"/><circle cx="9" cy="20" r="1"/><circle cx="17" cy="20" r="1"/>',
    store:'<path d="M3 10v11h18V10M2 10l2-7h16l2 7"/><path d="M2 10a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 4 0M9 21v-6h6v6"/>',
    sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>',
    plane:'<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    warning:'<path d="m10.3 3.9-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.1l-8-14a2 2 0 0 0-3.4 0z"/><path d="M12 9v4m0 4h.01"/>',
    wrench:'<path d="M14.7 6.3a5 5 0 0 0-6.4 6.4L3 18l3 3 5.3-5.3a5 5 0 0 0 6.4-6.4L14 13l-3-3z"/>',
    arrow:'<path d="M7 17 17 7M7 7h10v10"/>',
    link:'<path d="M10 13a5 5 0 0 0 7.1 0l3-3A5 5 0 0 0 13 2.9l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.1 0l-3 3A5 5 0 0 0 11 21.1l1.7-1.7"/>',
    help:'<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4.3 1.7c-1.1 1-1.8 1.3-1.8 2.8M12 17h.01"/>',
    telegram:'<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13m0 0 4 3"/>',
    ton:'<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="m3 7 9 5 9-5M12 12v10m-4-13 4 7 4-7"/>',
    teddy:'<circle cx="12" cy="13" r="8"/><circle cx="5" cy="5" r="3"/><circle cx="19" cy="5" r="3"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><path d="M10 16q2 2 4 0"/>',
    heart:'<path d="M20.8 8.8c0 5.2-8.8 11-8.8 11S3.2 14 3.2 8.8A4.8 4.8 0 0 1 12 6a4.8 4.8 0 0 1 8.8 2.8z"/>',
    sparkle:'<path d="m12 2 2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z"/>',
    rocket:'<path d="M5 14c-2 0-3 2-3 5 3 0 5-1 5-3"/><path d="M9 15 6 12c2-5 6-8 14-9-1 8-4 12-9 14l-2-2z"/><circle cx="15" cy="8" r="2"/>',
    target:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    paw:'<ellipse cx="12" cy="16" rx="6" ry="5"/><circle cx="5" cy="8" r="2"/><circle cx="10" cy="5" r="2"/><circle cx="15" cy="5" r="2"/><circle cx="20" cy="8" r="2"/>',
    channel:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9h10M7 13h7M7 17h4"/>',
    gram:'<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M8 8h8l-4 9z"/>'
  };
  const alias={
    'house':'home','users-three':'users','users':'users','user-list':'users','list-checks':'list',
    'trophy':'trophy','wallet':'wallet','bell-slash':'bell','calendar-check':'calendar','calendar-dots':'calendar',
    'shield-star':'shield','check-circle':'check','x':'close','play-circle':'play','coins':'coins',
    'currency-dollar':'coins','money':'coins','megaphone':'megaphone','clock-counter-clockwise':'clock',
    'clock':'clock','arrow-clockwise':'arrow','arrow-right':'arrow','arrow-up-right':'arrow',
    'copy':'copy','crown':'crown','diamond':'diamond','gift':'gift','info':'info','lightning':'bolt',
    'receipt':'receipt','shopping-bag':'bag','shopping-cart':'cart','storefront':'store','sun':'sun',
    'telegram-logo':'telegram','television':'play','warning':'warning','wrench':'wrench','question':'help',
    'plugs':'link','prohibit':'close','spinner-gap':'clock','circles-three-plus':'diamond','medal':'trophy',
    'ton':'ton','gram':'gram','teddy-bear':'teddy','bear':'teddy','heart':'heart','sparkle':'sparkle','sparkles':'sparkle','rocket':'rocket','target':'target','paw-print':'paw','paw':'paw','broadcast':'channel','channel':'channel'
  };
  const sprite=document.createElementNS('http://www.w3.org/2000/svg','svg');
  sprite.setAttribute('aria-hidden','true');sprite.style.cssText='position:absolute;width:0;height:0;overflow:hidden';
  sprite.innerHTML=Object.entries(symbols).map(([name,body])=>'<symbol id="icon-'+name+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'+body+'</symbol>').join('');
  document.addEventListener('DOMContentLoaded',()=>{document.body.prepend(sprite);});
  function render(root){
    if(root.nodeType===1 && root.matches?.('i[class*="ph-"]')) paint(root);
    root.querySelectorAll?.('i[class*="ph-"]').forEach(paint);
  }
  function paint(el){
    if(!el.matches?.('i[class*="ph-"]'))return;
    const cls=[...el.classList].find(x=>x.startsWith('ph-')&&!['ph-duotone','ph-bold','ph-fill','ph-light','ph-thin'].includes(x));
    const raw=(cls||'ph-info').replace(/^ph-/,'');
    const key=alias[raw]||'help';
    if(el.dataset.svgReady){el.querySelector('use')?.setAttribute('href','#icon-'+key);return;}
    el.dataset.svgReady='1';
    el.innerHTML='<svg class="svg-icon" aria-hidden="true" focusable="false"><use href="#icon-'+key+'"></use></svg>';
  }
  const start=()=>{render(document.body);new MutationObserver(records=>records.forEach(r=>{if(r.type==='attributes'){paint(r.target);return;}r.addedNodes.forEach(n=>{if(n.nodeType===1)render(n);});})).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
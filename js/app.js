/* app.js — boot, top-level tab nav, data loading, and shared UI helpers. */
window.App = (function(){
  var busyCount=0;

  function setPill(state, text){
    var p=document.getElementById('syncPill'); if(!p) return;
    p.className='pill '+(state==='ok'?'pill-ok':state==='err'?'pill-err':state==='busy'?'pill-busy':'pill-idle');
    p.textContent=text;
  }
  function toast(msg, isErr){
    var t=document.getElementById('toast'); t.textContent=msg; t.className='toast show'+(isErr?' err':'');
    clearTimeout(toast._t); toast._t=setTimeout(function(){ t.className='toast'+(isErr?' err':''); }, 2600);
  }
  function drawer(title, html){
    var d=document.getElementById('sheet');
    d.innerHTML='<div class="sheet-card"><div class="sheet-head"><h2>'+title+'</h2><button class="close-x" aria-label="Close">×</button></div><div class="sheet-body">'+html+'</div></div>';
    d.classList.add('open'); d.setAttribute('aria-hidden','false');
    d.querySelector('.close-x').onclick=closeDrawer;
    d.onclick=function(e){ if(e.target===d) closeDrawer(); };
  }
  function closeDrawer(){ var d=document.getElementById('sheet'); d.classList.remove('open'); d.setAttribute('aria-hidden','true'); d.innerHTML=''; }
  function setBusy(on){ busyCount+=on?1:-1; if(busyCount<0)busyCount=0; if(busyCount>0) setPill('busy','Saving…'); }

  async function reload(){
    try{
      var d = await API.getInventory();
      if(d && d.ok===false && d.error){ setPill('err','Sheet error'); toast('Live sheet error: '+d.error, true); INV.setData({configured:false}); INV.render(); return; }
      INV.setData(d);
      if(d.configured===false){ setPill('idle','Not connected'); }
      else { setPill('ok','Live'); }
      INV.render();
    }catch(e){ setPill('err','Offline'); toast('Could not reach the live sheet', true); }
  }

  function switchTab(tab){
    Array.prototype.forEach.call(document.querySelectorAll('.topnav-tab'), function(b){ b.classList.toggle('is-active', b.getAttribute('data-tab')===tab); });
    Array.prototype.forEach.call(document.querySelectorAll('.view'), function(v){ v.classList.toggle('is-active', v.id==='view-'+tab); });
  }

  function boot(){
    Array.prototype.forEach.call(document.querySelectorAll('.topnav-tab'), function(b){
      b.onclick=function(){ switchTab(b.getAttribute('data-tab')); };
    });
    document.getElementById('refreshBtn').onclick=function(){ setPill('busy','Refreshing…'); reload(); };
    setPill('busy','Connecting…');
    reload();
  }

  document.addEventListener('DOMContentLoaded', boot);
  return { toast:toast, drawer:drawer, closeDrawer:closeDrawer, setBusy:setBusy, reload:reload };
})();

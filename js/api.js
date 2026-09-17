/* api.js — thin wrapper over /api/inventory */
window.API = (function(){
  async function getInventory(){
    const r = await fetch('/api/inventory', { headers:{ 'accept':'application/json' } });
    const d = await r.json();
    return d;
  }
  async function post(payload){
    const r = await fetch('/api/inventory', {
      method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(payload)
    });
    let d; try{ d = await r.json(); }catch(e){ d = { ok:false, error:'bad_response' }; }
    if(!r.ok && d.ok===undefined) d = { ok:false, error:'http_'+r.status };
    return d;
  }
  return { getInventory, post };
})();

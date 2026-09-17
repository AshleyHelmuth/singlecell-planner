/* Annex Hub — Cloudflare Worker
 * Serves the static site and a small inventory API backed by the SAME Google
 * Sheet the singlecell-planner uses. Configure two variables on this Worker:
 *   GOOGLE_SA_KEY      (Secret)   — the service-account JSON key (paste the whole file)
 *   INVENTORY_SHEET_ID (Plaintext)— the Google Sheet ID of Live_Inventory
 * Share that Sheet with the service account's client_email as an Editor.
 *
 * Endpoints:
 *   GET  /api/inventory                      -> full inventory + reservations
 *   POST /api/inventory  {action, ...}       -> mutate (see handlers below)
 * Everything else is served from the bundled static assets.
 */

const SHEETS = {
  tenXAll:   '10X Kits_All',
  reagents:  'Reagents & Supplies',
  oligos:    'Oligos',
  antibodies:'Antibodies',
  totalseq:  'Totalseq Cocktails + HTOs',
  reservations:'Reservations',
  movements: 'Movements',
  lotsUsed:  'Lots Used',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/inventory') {
      try {
        if (request.method === 'GET')  return json(await getInventory(env));
        if (request.method === 'POST') return json(await postInventory(request, env));
        return json({ ok:false, error:'method_not_allowed' }, 405);
      } catch (e) {
        return json({ ok:false, error:String(e && e.message || e) }, 500);
      }
    }
    // static assets
    return env.ASSETS.fetch(request);
  }
};

/* ---------- helpers ---------- */
function json(obj, status=200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
  });
}
function cfg(env){ return !!(env.GOOGLE_SA_KEY && env.INVENTORY_SHEET_ID); }
function colLetter(n){ let s=''; n=n+1; while(n>0){ const m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=(n-m-1)/26; } return s; }
function cleanNum(v){ if(v==null||v==='') return null; const n=Number(String(v).replace(/[^0-9.\-]/g,'')); return isFinite(n)?n:null; }
function cleanId(v){ if(v==null) return ''; return String(v).trim().replace(/\.0$/,''); }
function cleanDate(v){ if(v==null||v==='') return ''; const s=String(v); const m=s.match(/^(\d{4}-\d{2}-\d{2})/); return m?m[1]:s; }
function todayISO(){ return new Date().toISOString().slice(0,10); }
function nowISO(){ return new Date().toISOString().slice(0,19).replace('T',' '); }

/* ---------- Google auth (service account, RS256 JWT) ---------- */
async function getAccessToken(env){
  const key = JSON.parse(env.GOOGLE_SA_KEY);
  const now = Math.floor(Date.now()/1000);
  const header = { alg:'RS256', typ:'JWT' };
  const claim = {
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now,
  };
  const enc = (o)=>b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc(header)+'.'+enc(claim);
  const pk = await importPrivateKey(key.private_key);
  const sig = await crypto.subtle.sign({name:'RSASSA-PKCS1-v1_5'}, pk, new TextEncoder().encode(unsigned));
  const jwt = unsigned+'.'+b64url(new Uint8Array(sig));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'},
    body:'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion='+encodeURIComponent(jwt)
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('auth_failed: '+(data.error_description||data.error||'no token'));
  return data.access_token;
}
function b64url(bytes){ let bin=''; for(const b of bytes) bin+=String.fromCharCode(b); return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
async function importPrivateKey(pem){
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/,'').replace(/-----END PRIVATE KEY-----/,'').replace(/\s+/g,'');
  const bin = atob(body); const buf = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) buf[i]=bin.charCodeAt(i);
  return crypto.subtle.importKey('pkcs8', buf.buffer, {name:'RSASSA-PKCS1-v1_5', hash:'SHA-256'}, false, ['sign']);
}

/* ---------- Sheets REST ---------- */
const API='https://sheets.googleapis.com/v4/spreadsheets';
async function sheetsBatchGet(env, token, ranges){
  const qs = ranges.map(r=>'ranges='+encodeURIComponent(r)).join('&');
  const res = await fetch(`${API}/${env.INVENTORY_SHEET_ID}/values:batchGet?${qs}&majorDimension=ROWS`, {
    headers:{ authorization:'Bearer '+token }
  });
  const d = await res.json();
  if (d.error) throw new Error('sheets_read: '+d.error.message);
  const out={}; (d.valueRanges||[]).forEach((vr,i)=>{ out[ranges[i]] = vr.values || []; });
  return out;
}
async function sheetsUpdate(env, token, range, row){
  const res = await fetch(`${API}/${env.INVENTORY_SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
    method:'PUT', headers:{ authorization:'Bearer '+token, 'content-type':'application/json' },
    body: JSON.stringify({ values:[row] })
  });
  const d = await res.json(); if (d.error) throw new Error('sheets_update: '+d.error.message); return d;
}
async function sheetsAppend(env, token, sheet, row){
  const res = await fetch(`${API}/${env.INVENTORY_SHEET_ID}/values/${encodeURIComponent("'"+sheet+"'!A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method:'POST', headers:{ authorization:'Bearer '+token, 'content-type':'application/json' },
    body: JSON.stringify({ values:[row] })
  });
  const d = await res.json(); if (d.error) throw new Error('sheets_append: '+d.error.message); return d;
}
async function sheetsAppendMany(env, token, sheet, rows){
  if(!rows.length) return;
  const res = await fetch(`${API}/${env.INVENTORY_SHEET_ID}/values/${encodeURIComponent("'"+sheet+"'!A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method:'POST', headers:{ authorization:'Bearer '+token, 'content-type':'application/json' },
    body: JSON.stringify({ values: rows })
  });
  const d = await res.json(); if (d.error) throw new Error('sheets_append_many: '+d.error.message); return d;
}
function hindex(values){ // header -> col index map from row 0
  const h={}; (values[0]||[]).forEach((v,i)=>{ if(v!=null&&String(v).trim()!=='') h[String(v).trim()]=i; }); return h;
}

/* ---------- 10X experiment classifier (fallback if Experiment col blank) ---------- */
function classifyExp(desc){
  const d=(desc||'').toLowerCase();
  const rules=[['flex','Flex v2'],['multiome','Epi Multiome'],['tcr',"5' v3 (VDJ)"],['bcr',"5' v3 (VDJ)"],
    ['v(d)j',"5' v3 (VDJ)"],['vdj',"5' v3 (VDJ)"],['atac','Epi ATAC v2'],['next gem chip h','Epi ATAC v2'],
    ['single index kit n','Epi ATAC v2'],['dual index kit ts','Flex v2'],['library construction kit c',"5' v3"],
    ['dual index kit tt',"5' v3"],['dual index kit tn',"5' v3"],["5'","5' v3"],['feature bar',"5' v3"],
    ["3'","3' v4"],['nuclei isolation','Nuclei prep (shared)'],['rnase inhibitor','Shared reagents'],
    ['dynabeads','Shared reagents'],['silane','Shared reagents']];
  for(const [k,v] of rules){ if(d.includes(k)) return v; }
  return 'Other / unclassified';
}

/* ---------- GET: assemble inventory ---------- */
async function getInventory(env){
  if(!cfg(env)) return { ok:true, configured:false };
  const token = await getAccessToken(env);
  const ranges = Object.values(SHEETS).map(s=>"'"+s+"'!A1:AZ2000");
  const g = await sheetsBatchGet(env, token, ranges);
  const val = (s)=> g["'"+s+"'!A1:AZ2000"] || [];

  // --- 10X kits (per box) -> group by catalog, then lot ---
  const allV = val(SHEETS.tenXAll); const ah = hindex(allV);
  const kmap = new Map();
  for(let i=1;i<allV.length;i++){
    const r=allV[i]; if(!r||!r[0]) continue;
    const cat = cleanId(r[ah['Catalog #']]);
    if(!cat) continue;
    const desc = r[ah['Description']]||'';
    const exp = (r[ah['Experiment']]!=null && String(r[ah['Experiment']]).trim()!=='') ? String(r[ah['Experiment']]).trim() : classifyExp(desc);
    const lot = cleanId(r[ah['Lot #(s)']]);
    const expiry = cleanDate(r[ah['Earliest expiry']]);
    const rxns = cleanNum(r[ah['Rxns/Indexes Remaining']]) || 0;
    const storage = r[ah['Storage']]||'';
    const reservedFor = (r[ah['Reserved for']]||'').toString().trim();
    const kitId = cleanId(r[0]);
    if(!kmap.has(cat)) kmap.set(cat,{catalog:cat, description:desc, experiment:exp, storage, reservedFor, unit:'rxns', lots:new Map(), boxes:0, rxns:0});
    const k=kmap.get(cat);
    if(!k.storage && storage) k.storage=storage;
    const lk = lot||'(no lot)';
    if(!k.lots.has(lk)) k.lots.set(lk,{lot:lot||'', expiry, boxes:0, rxns:0, kitIds:[]});
    const L=k.lots.get(lk);
    L.boxes++; L.rxns+=rxns; L.kitIds.push({kitId, rxns, row:i+1});
    if(expiry && (!L.expiry || expiry<L.expiry)) L.expiry=expiry;
    k.boxes++; k.rxns+=rxns;
  }
  const tenX = [...kmap.values()].map(k=>({
    catalog:k.catalog, description:k.description, experiment:k.experiment, storage:k.storage,
    reservedFor:k.reservedFor, unit:k.unit, boxes:k.boxes, rxns:k.rxns,
    lots:[...k.lots.values()].sort((a,b)=> (a.expiry||'').localeCompare(b.expiry||''))
  })).sort((a,b)=> a.description.localeCompare(b.description));

  // --- generic reagent-shaped tabs ---
  function reagentTab(sheet){
    const v=val(sheet); const h=hindex(v); const out=[];
    for(let i=1;i<v.length;i++){ const r=v[i]; if(!r||!r[0]) continue;
      const packRaw=(r[h['Pack size']]==null?'':String(r[h['Pack size']]).trim());
      const packConvertible=/^[0-9]*\.?[0-9]+$/.test(packRaw);
      const pack=cleanNum(r[h['Pack size']])||1;
      let units=cleanNum(r[h['On hand (units)']]); const cont=cleanNum(r[h['On hand (containers)']]);
      // units and containers are independent; only fall back for display when one is truly absent
      if(units==null && cont!=null && packConvertible) units=cont*pack;
      out.push({
        itemId:cleanId(r[0]), name:(r[h['Item']]||'').toString(), subcategory:(r[h['Category']]||'').toString(),
        type:(h['Type']!=null? (r[h['Type']]||'').toString():''),
        concentration:(h['Concentration']!=null?(r[h['Concentration']]||'').toString():''),
        catalog:(h['Catalog #']!=null?cleanId(r[h['Catalog #']]):''), vendor:(h['Vendor']!=null?(r[h['Vendor']]||'').toString():''),
        container:(r[h['Container']]||'').toString(), packSize:pack, packConvertible:packConvertible, unit:(r[h['Unit']]||'').toString(),
        onHandUnits:units, onHandContainers:(cont!=null?cont:null),
        reorderAt:cleanNum(r[h['Reorder at']]), orderStatus:(r[h['Order status']]||'').toString(),
        location:(r[h['Location']]||'').toString(), notes:(r[h['Notes']]||'').toString(), row:i+1
      });
    }
    return out;
  }
  const reagents = reagentTab(SHEETS.reagents);
  const oligos   = reagentTab(SHEETS.oligos);
  const antibodies = reagentTab(SHEETS.antibodies).filter(x=>x.name && x.name.trim()!=='' || x.onHandUnits!=null);

  // --- totalseq ---
  const tsV=val(SHEETS.totalseq); const th=hindex(tsV); const totalseq=[];
  for(let i=1;i<tsV.length;i++){ const r=tsV[i]; if(!r||!r[0]) continue;
    totalseq.push({ tubeId:(r[0]||'').toString().trim(), type:(r[th['Type']]||'').toString(),
      storageBox:(r[th['Storage Box']]||'').toString(), catalog:cleanId(r[th['Catalog Number']]),
      lot:(r[th['Lot Number']]||'').toString(), version:(r[th['TotalSeq Version']]||'').toString(),
      hashtag:cleanId(r[th['Hashtag Number']]), remaining:(r[th['Volume/Quantity Remaining']]||'').toString(),
      reservedFor:(r[th['Reserved For']]||'').toString(), row:i+1 });
  }

  // --- reservations ---
  const rV=val(SHEETS.reservations); const rh=hindex(rV); const reservations=[];
  for(let i=1;i<rV.length;i++){ const r=rV[i]; if(!r||!r[0]) continue;
    const id=String(r[0]).trim(); if(!id) continue;
    reservations.push({ id, category:(r[rh['category']]||'').toString(), itemKey:cleanId(r[rh['item_key']]),
      lot:(r[rh['lot']]||'').toString(), itemName:(r[rh['item_name']]||'').toString(),
      qty:cleanNum(r[rh['qty']])||0, unit:(r[rh['unit']]||'').toString(),
      experiment:(r[rh['experiment']]||'').toString(), project:(r[rh['project']]||'').toString(),
      date:(r[rh['date_created']]||'').toString(), by:(r[rh['created_by']]||'').toString(),
      status:(r[rh['status']]||'active').toString().toLowerCase(), notes:(r[rh['notes']]||'').toString(), row:i+1 });
  }

  return { ok:true, configured:true, tenX, reagents, oligos, antibodies, totalseq, reservations,
    experiments: [...new Set(tenX.map(k=>k.experiment))] };
}

/* ---------- POST: mutations ---------- */
async function postInventory(request, env){
  if(!cfg(env)) return { ok:false, error:'not_configured' };
  const body = await request.json();
  const action = body.action;
  const token = await getAccessToken(env);
  switch(action){
    case 'adjustReagent':   return adjustReagent(env, token, body);
    case 'addReagent':      return addReagent(env, token, body);
    case 'adjust10x':       return adjust10x(env, token, body);
    case 'add10xBox':       return add10xBox(env, token, body);
    case 'adjustTotalseq':  return adjustTotalseq(env, token, body);
    case 'addTotalseq':     return addTotalseq(env, token, body);
    case 'bulkAdd':         return bulkAdd(env, token, body);
    case 'reserve':         return reserve(env, token, body);
    case 'reserveBulk':     return reserveBulk(env, token, body);
    case 'updateReservation': return updateReservation(env, token, body);
    case 'fulfillReservation': return fulfillReservation(env, token, body);
    case 'releaseReservation': return releaseReservation(env, token, body);
    default: return { ok:false, error:'unknown_action:'+action };
  }
}

async function readTab(env, token, sheet){
  const g = await sheetsBatchGet(env, token, ["'"+sheet+"'!A1:AZ2000"]);
  return g["'"+sheet+"'!A1:AZ2000"] || [];
}
function findRow(values, keyCol, key){
  const k=cleanId(key);
  for(let i=1;i<values.length;i++){ if(values[i] && cleanId(values[i][keyCol])===k) return i; }
  return -1;
}

// adjust a reagent/oligo/antibody row: apply independent unit and container deltas
async function adjustReagent(env, token, b){
  const sheet=b.sheet; const v=await readTab(env,token,sheet); const h=hindex(v);
  const idx=findRow(v, 0, b.itemKey); if(idx<0) return {ok:false,error:'item_not_found'};
  const r=v[idx]; const row=idx+1;
  let units=cleanNum(r[h['On hand (units)']]); if(units==null) units=0;
  let cont=cleanNum(r[h['On hand (containers)']]); if(cont==null) cont=0;
  const ud=Number(b.unitDelta)||0, cd=Number(b.containerDelta)||0;
  units = Math.max(0, units+ud);
  cont  = Math.max(0, cont+cd);
  await sheetsUpdate(env, token, "'"+sheet+"'!"+colLetter(h['On hand (units)'])+row, [units]);
  if(h['On hand (containers)']!=null) await sheetsUpdate(env, token, "'"+sheet+"'!"+colLetter(h['On hand (containers)'])+row, [cont]);
  const parts=[]; if(ud) parts.push((ud<0?'':'+')+ud+' '+(r[h['Unit']]||'u')); if(cd) parts.push((cd<0?'':'+')+cd+' '+(r[h['Container']]||'cont'));
  await logMovement(env, token, { category:sheet, item_key:b.itemKey, lot:'', item_name:(r[h['Item']]||''),
    change:parts.join(', '), unit:(r[h['Unit']]||''),
    new_on_hand:units, reason:b.reason||'', experiment:b.experiment||'', by:b.by||'' });
  return { ok:true, onHandUnits:units, onHandContainers:cont };
}

async function addReagent(env, token, b){
  const sheet=b.sheet; const v=await readTab(env,token,sheet); const h=hindex(v);
  // next id using the sheet's prefix pattern
  let maxN=0, prefix=b.idPrefix||'R';
  for(let i=1;i<v.length;i++){ const id=(v[i]&&v[i][0]||'').toString().trim(); const m=id.match(/^([A-Za-z]+)0*(\d+)$/); if(m){ prefix=m[1]; const n=parseInt(m[2],10); if(n>maxN)maxN=n; } }
  const newId = prefix+String(maxN+1).padStart(3,'0');
  const pack=Number(b.packSize)||1; const units=(b.onHandUnits!=null?Number(b.onHandUnits):(Number(b.onHandContainers)||0)*pack);
  const cont=(b.onHandContainers!=null?Number(b.onHandContainers):(pack?units/pack:units));
  // build row in header order
  const row=new Array((v[0]||[]).length).fill('');
  const put=(name,val)=>{ if(h[name]!=null) row[h[name]]=val; };
  put('item_id',newId); put('Item',b.name||''); put('Category',b.subcategory||'Reagent');
  put('Type',b.type||''); put('Concentration',b.concentration||''); put('Sequence',b.sequence||'');
  put('Catalog #',b.catalog||''); put('Vendor',b.vendor||'');
  put('Container',b.container||''); put('Pack size',pack); put('Unit',b.unit||'');
  put('On hand (containers)',cont); put('On hand (units)',units);
  put('Reorder at',b.reorderAt!=null?Number(b.reorderAt):''); put('Order status',b.orderStatus||'stocked');
  put('Location',b.location||''); put('Notes',b.notes||'');
  await sheetsAppend(env, token, sheet, row);
  await logMovement(env, token, { category:sheet, item_key:newId, lot:'', item_name:b.name||'', change:'+'+units, unit:b.unit||'', new_on_hand:units, reason:'new item', experiment:'', by:b.by||'' });
  return { ok:true, itemId:newId };
}

// 10X: decrement rxns for a (catalog, lot); draws down boxes with most remaining first
async function adjust10x(env, token, b){
  const sheet=SHEETS.tenXAll; const v=await readTab(env,token,sheet); const h=hindex(v);
  const catC=h['Catalog #'], lotC=h['Lot #(s)'], rxC=h['Rxns/Indexes Remaining'];
  const cat=cleanId(b.itemKey), lot=cleanId(b.lot);
  const rows=[];
  for(let i=1;i<v.length;i++){ const r=v[i]; if(!r) continue;
    if(cleanId(r[catC])===cat && (b.lot==null || cleanId(r[lotC])===lot)) rows.push({i, rxns:cleanNum(r[rxC])||0});
  }
  if(!rows.length) return {ok:false,error:'lot_not_found'};
  let amt=Number(b.amount)||0; const unit=b.rxnUnit||'rxns';
  if(b.mode==='set'){
    // set the lot's total: put it on the first box, zero the rest (keeps rows stable)
    rows.sort((a,c)=>a.i-c.i);
    for(let j=0;j<rows.length;j++){ rows[j].rxns = j===0?amt:0; await sheetsUpdate(env,token,"'"+sheet+"'!"+colLetter(rxC)+(rows[j].i+1),[rows[j].rxns]); }
  } else {
    const sign = b.mode==='remove'?-1:1;
    rows.sort((a,c)=> sign<0 ? c.rxns-a.rxns : a.rxns-c.rxns);
    for(const rr of rows){ if(amt<=0) break; if(sign<0){ const take=Math.min(rr.rxns,amt); rr.rxns-=take; amt-=take; } else { rr.rxns+=amt; amt=0; } await sheetsUpdate(env,token,"'"+sheet+"'!"+colLetter(rxC)+(rr.i+1),[rr.rxns]); }
  }
  const total=rows.reduce((s,r)=>s+r.rxns,0);
  await logMovement(env, token, { category:'10X Kits', item_key:cat, lot:b.lot||'', item_name:(v[rows[0].i][h['Description']]||''),
    change:(b.mode==='set'?'set='+ (Number(b.amount)||0):(b.mode==='remove'?'-':'+')+(Number(b.amount)||0)), unit:unit,
    new_on_hand:total, reason:b.reason||b.mode, experiment:b.experiment||'', by:b.by||'' });
  // also append to Lots Used when consuming
  if(b.mode==='remove'){
    await sheetsAppend(env, token, SHEETS.lotsUsed, [todayISO(), b.experiment||'', b.project||'', cat, (v[rows[0].i][h['Description']]||''), b.lot||'', '', Number(b.amount)||0, b.by||'']);
  }
  return { ok:true, lotTotalRxns:total };
}

// add a new 10X box (optionally new lot) — appends a row with a new Kit ID
async function add10xBox(env, token, b){
  const sheet=SHEETS.tenXAll; const v=await readTab(env,token,sheet); const h=hindex(v);
  const cat=cleanId(b.itemKey);
  // find an existing box of this catalog to copy description/experiment/storage/reserved
  let template=null, maxSeq=0;
  for(let i=1;i<v.length;i++){ const r=v[i]; if(!r) continue;
    if(cleanId(r[h['Catalog #']])===cat){ template=r; const kid=(r[0]||'').toString(); const m=kid.match(/-(\d+)$/); if(m){ const n=parseInt(m[1],10); if(n>maxSeq)maxSeq=n; } }
  }
  const count=Math.max(1, Number(b.count)||1);
  const rxnsEach=Number(b.rxnsPerBox)|| (template?cleanNum(template[h['Rxns/Indexes Remaining']]):0) || 0;
  let lastTotal=0;
  for(let c=0;c<count;c++){
    const seq=String(maxSeq+1+c).padStart(3,'0');
    const row=new Array((v[0]||[]).length).fill('');
    const put=(name,val)=>{ if(h[name]!=null) row[h[name]]=val; };
    put('Kit ID', cat+'-'+seq); put('Catalog #', cat);
    put('Description', b.description || (template?template[h['Description']]:'') || '');
    put('Rxns/Indexes Remaining', rxnsEach); put('Indexes Used', 0);
    put('Storage', b.storage || (template?template[h['Storage']]:'') || '');
    put('Reserved for', b.reservedFor!=null?b.reservedFor:(template?template[h['Reserved for']]:'')||'');
    put('Reorder at', template?template[h['Reorder at']]:0); put('Order status','stocked');
    put('Lot #(s)', b.lot||''); put('Earliest expiry', b.expiry||'');
    put('Experiment', b.experiment || (template?template[h['Experiment']]:'') || '');
    await sheetsAppend(env, token, sheet, row);
    lastTotal+=rxnsEach;
  }
  await logMovement(env, token, { category:'10X Kits', item_key:cat, lot:b.lot||'', item_name:b.description||(template?template[h['Description']]:'')||'', change:'+'+count+' box', unit:'kit', new_on_hand:'', reason:'new box/lot', experiment:'', by:b.by||'' });
  return { ok:true, added:count };
}

async function adjustTotalseq(env, token, b){
  const sheet=SHEETS.totalseq; const v=await readTab(env,token,sheet); const h=hindex(v);
  const idx=findRow(v,0,b.itemKey); if(idx<0) return {ok:false,error:'tube_not_found'};
  const r=v[idx]; const row=idx+1; const c=h['Volume/Quantity Remaining'];
  let cur=cleanNum(r[c]); if(cur==null) cur=0; const delta=Number(b.amount)||0; let nv=cur;
  if(b.mode==='add') nv=cur+delta; else if(b.mode==='remove') nv=cur-delta; else if(b.mode==='set') nv=delta;
  if(nv<0) nv=0;
  await sheetsUpdate(env, token, "'"+sheet+"'!"+colLetter(c)+row, [nv]);
  await logMovement(env, token, { category:'Totalseq', item_key:b.itemKey, lot:(r[h['Lot Number']]||''), item_name:(r[h['Storage Box']]||'')+' '+(r[0]||''), change:(b.mode==='set'?'set='+nv:(b.mode==='remove'?'-':'+')+delta), unit:'uL', new_on_hand:nv, reason:b.reason||b.mode, experiment:b.experiment||'', by:b.by||'' });
  return { ok:true, remaining:nv };
}

// build a totalseq row (auto Tube ID if blank)
function buildTotalseqRow(h, headerLen, b, autoId){
  const row=new Array(Math.max(headerLen,9)).fill('');
  const put=(name,val)=>{ if(h[name]!=null) row[h[name]]=val; };
  const tube=(b.tubeId&&String(b.tubeId).trim())||autoId;
  // first column is the Tube ID key regardless of header label
  row[0]=tube;
  put('Type',b.type||'HTO'); put('Storage Box',b.storageBox||''); put('Catalog Number',b.catalog||'');
  put('Lot Number',b.lot||''); put('TotalSeq Version',b.version||''); put('Hashtag Number',b.hashtag||'');
  put('Volume/Quantity Remaining',b.remaining!=null&&b.remaining!==''?b.remaining:''); put('Reserved For',b.reservedFor||'');
  return {row, tube};
}
async function addTotalseq(env, token, b){
  const sheet=SHEETS.totalseq; const v=await readTab(env,token,sheet); const h=hindex(v);
  let maxN=0; for(let i=1;i<v.length;i++){ const id=(v[i]&&v[i][0]||'').toString(); const m=id.match(/(\d+)\s*$/); if(m){ const n=parseInt(m[1],10); if(n>maxN)maxN=n; } }
  const {row,tube}=buildTotalseqRow(h,(v[0]||[]).length,b,'TS-'+String(maxN+1).padStart(3,'0'));
  await sheetsAppend(env, token, sheet, row);
  await logMovement(env, token, { category:'Totalseq', item_key:tube, lot:b.lot||'', item_name:(b.storageBox||'')+' '+tube, change:'new tube', unit:'', new_on_hand:b.remaining||'', reason:'new item', experiment:'', by:b.by||'' });
  return { ok:true, tubeId:tube };
}

// bulk add many items to one category in a single append
async function bulkAdd(env, token, b){
  const cat=b.category; const items=Array.isArray(b.rows)?b.rows:[];
  if(!items.length) return { ok:false, error:'no_rows' };
  const sheetMap={ reagents:'Reagents & Supplies', oligos:'Oligos', antibodies:'Antibodies', totalseq:SHEETS.totalseq };
  const sheet=sheetMap[cat]; if(!sheet) return { ok:false, error:'bad_category' };
  const v=await readTab(env,token,sheet); const h=hindex(v); const headerLen=(v[0]||[]).length;
  const rows=[]; const assigned=[];

  if(cat==='totalseq'){
    let maxN=0; for(let i=1;i<v.length;i++){ const id=(v[i]&&v[i][0]||'').toString(); const m=id.match(/(\d+)\s*$/); if(m){ const n=parseInt(m[1],10); if(n>maxN)maxN=n; } }
    items.forEach((it,k)=>{ const {row,tube}=buildTotalseqRow(h,headerLen,it,'TS-'+String(maxN+1+k).padStart(3,'0')); rows.push(row); assigned.push(tube); });
  } else {
    let maxN=0, prefix=(cat==='oligos'?'OL':cat==='antibodies'?'AB':'R');
    for(let i=1;i<v.length;i++){ const id=(v[i]&&v[i][0]||'').toString().trim(); const m=id.match(/^([A-Za-z]+)0*(\d+)$/); if(m){ prefix=m[1]; const n=parseInt(m[2],10); if(n>maxN)maxN=n; } }
    items.forEach((it,k)=>{
      const newId=prefix+String(maxN+1+k).padStart(3,'0');
      const pack=Number(it.packSize)||1;
      const cont=(it.onHandContainers!=null&&it.onHandContainers!==''?Number(it.onHandContainers):0);
      const units=(it.onHandUnits!=null&&it.onHandUnits!==''?Number(it.onHandUnits):(/^[0-9]*\.?[0-9]+$/.test(String(it.packSize||'').trim())?cont*pack:''));
      const row=new Array(headerLen).fill('');
      const put=(name,val)=>{ if(h[name]!=null) row[h[name]]=val; };
      put('item_id',newId); put('Item',it.name||''); put('Category',it.subcategory||(cat==='antibodies'?'Antibody':cat==='oligos'?'Oligo':'Reagent'));
      put('Type',it.type||''); put('Concentration',it.concentration||''); put('Sequence',it.sequence||'');
      put('Catalog #',it.catalog||''); put('Vendor',it.vendor||'');
      put('Container',it.container||''); put('Pack size',it.packSize!=null&&it.packSize!==''?pack:''); put('Unit',it.unit||'');
      put('On hand (containers)',cont); put('On hand (units)',units);
      put('Reorder at',it.reorderAt!=null&&it.reorderAt!==''?Number(it.reorderAt):''); put('Order status',it.orderStatus||'stocked');
      put('Location',it.location||''); put('Notes',it.notes||'');
      rows.push(row); assigned.push(newId);
    });
  }
  await sheetsAppendMany(env, token, sheet, rows);
  await logMovement(env, token, { category:sheet, item_key:'(bulk)', lot:'', item_name:assigned.length+' items', change:'+'+assigned.length, unit:'', new_on_hand:'', reason:'bulk add', experiment:'', by:b.by||'' });
  return { ok:true, added:assigned.length, ids:assigned };
}

async function reserve(env, token, b){
  const v=await readTab(env,token,SHEETS.reservations); const h=hindex(v);
  let maxN=0; for(let i=1;i<v.length;i++){ const id=(v[i]&&v[i][0]||'').toString(); const m=id.match(/RSV-?0*(\d+)/i); if(m){ const n=parseInt(m[1],10); if(n>maxN)maxN=n; } }
  const id='RSV-'+String(maxN+1).padStart(4,'0');
  const row=new Array(Math.max((v[0]||[]).length, 13)).fill('');
  const put=(name,val)=>{ if(h[name]!=null) row[h[name]]=val; };
  put('reservation_id',id); put('category',b.category||''); put('item_key',cleanId(b.itemKey));
  put('lot',b.lot||''); put('item_name',b.itemName||''); put('qty',Number(b.qty)||0); put('unit',b.unit||'');
  put('experiment',b.experiment||''); put('project',b.project||''); put('date_created',todayISO());
  put('created_by',b.by||''); put('status','active'); put('notes',b.notes||'');
  await sheetsAppend(env, token, SHEETS.reservations, row);
  return { ok:true, reservationId:id };
}

async function releaseReservation(env, token, b){
  const v=await readTab(env,token,SHEETS.reservations); const h=hindex(v);
  const idx=findRow(v, h['reservation_id']||0, b.reservationId);
  if(idx<0) return {ok:false,error:'reservation_not_found'};
  await sheetsUpdate(env, token, "'"+SHEETS.reservations+"'!"+colLetter(h['status'])+(idx+1), ['released']);
  return { ok:true };
}

// reserve many items at once (one experiment/project), single append
async function reserveBulk(env, token, b){
  const items=Array.isArray(b.items)?b.items:[];
  if(!items.length) return { ok:false, error:'no_items' };
  const v=await readTab(env,token,SHEETS.reservations); const h=hindex(v);
  let maxN=0; for(let i=1;i<v.length;i++){ const id=(v[i]&&v[i][0]||'').toString(); const m=id.match(/RSV-?0*(\d+)/i); if(m){ const n=parseInt(m[1],10); if(n>maxN)maxN=n; } }
  const headerLen=Math.max((v[0]||[]).length,13); const rows=[]; const ids=[];
  items.forEach((it,k)=>{
    const id='RSV-'+String(maxN+1+k).padStart(4,'0'); ids.push(id);
    const row=new Array(headerLen).fill('');
    const put=(name,val)=>{ if(h[name]!=null) row[h[name]]=val; };
    put('reservation_id',id); put('category',it.category||''); put('item_key',cleanId(it.itemKey));
    put('lot',it.lot||''); put('item_name',it.itemName||''); put('qty',Number(it.qty)||0); put('unit',it.unit||'');
    put('experiment',b.experiment||''); put('project',b.project||''); put('date_created',todayISO());
    put('created_by',b.by||''); put('status','active'); put('notes',it.notes||b.notes||'');
    rows.push(row);
  });
  await sheetsAppendMany(env, token, SHEETS.reservations, rows);
  return { ok:true, reservationIds:ids, count:ids.length };
}

async function updateReservation(env, token, b){
  const v=await readTab(env,token,SHEETS.reservations); const h=hindex(v);
  const idx=findRow(v, h['reservation_id']||0, b.reservationId);
  if(idx<0) return {ok:false,error:'reservation_not_found'};
  if(b.qty!=null) await sheetsUpdate(env, token, "'"+SHEETS.reservations+"'!"+colLetter(h['qty'])+(idx+1), [Number(b.qty)||0]);
  if(b.experiment!=null && h['experiment']!=null) await sheetsUpdate(env, token, "'"+SHEETS.reservations+"'!"+colLetter(h['experiment'])+(idx+1), [b.experiment]);
  return { ok:true };
}

// fulfil a reservation: actually remove the reserved qty from stock, then mark it complete
async function fulfillReservation(env, token, b){
  const v=await readTab(env,token,SHEETS.reservations); const h=hindex(v);
  const idx=findRow(v, h['reservation_id']||0, b.reservationId);
  if(idx<0) return {ok:false,error:'reservation_not_found'};
  const r=v[idx];
  const cat=(r[h['category']]||'').toString();
  const key=cleanId(r[h['item_key']]);
  const lot=(r[h['lot']]||'').toString();
  const qty=cleanNum(r[h['qty']])||0;
  const exp=(r[h['experiment']]||'').toString();
  // deduct from the right sheet
  if(cat==='10X Kits' || cat==='10X Kits_All'){
    await adjust10x(env, token, { itemKey:key, lot:lot, mode:'remove', amount:qty, reason:'reservation fulfilled', experiment:exp, by:b.by||'' });
  } else if(cat==='Totalseq Cocktails + HTOs' || cat==='Totalseq'){
    await adjustTotalseq(env, token, { itemKey:key, mode:'remove', amount:qty, reason:'reservation fulfilled', experiment:exp, by:b.by||'' });
  } else if(cat==='Reagents & Supplies' || cat==='Oligos' || cat==='Antibodies'){
    await adjustReagent(env, token, { sheet:cat, itemKey:key, unitDelta:-qty, containerDelta:0, reason:'reservation fulfilled', experiment:exp, by:b.by||'' });
  } else {
    return { ok:false, error:'unknown_category:'+cat };
  }
  await sheetsUpdate(env, token, "'"+SHEETS.reservations+"'!"+colLetter(h['status'])+(idx+1), ['fulfilled']);
  return { ok:true, fulfilled:qty };
}

async function logMovement(env, token, m){
  try{
    await sheetsAppend(env, token, SHEETS.movements, [ nowISO(), m.category||'', m.item_key||'', m.lot||'', m.item_name||'', m.change||'', m.unit||'', m.new_on_hand===''?'':m.new_on_hand, m.reason||'', m.experiment||'', m.by||'' ]);
  }catch(e){ /* logging is best-effort */ }
}

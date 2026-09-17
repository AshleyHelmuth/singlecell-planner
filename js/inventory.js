/* inventory.js — the Inventory tab: sidebar, category pages, 10X lots,
 * reserved-quantity math, inline stock edits, and the reservation system.
 * Relies on App.toast / App.drawer / App.reload and window.API. */
window.INV = (function(){
  var data = null;                 // last payload from /api/inventory
  var section = 'update';          // current sub-section id
  var search = '';                 // current search text (per section)
  var expanded = {};               // 10X: expanded kit rows (catalog -> true)
  var updateMode = 'one';          // 'one' | 'bulk' within Update inventory
  var bulkCat = 'reagents';        // category for the bulk grid
  var elContent = null, elSubnav = null;

  var SECTIONS = [
    { id:'update',       label:'Update inventory', kind:'update', primary:true },
    { id:'tenx',         label:'10X reagents',     kind:'tenx' },
    { id:'reagents',     label:'Reagents & supplies', kind:'reagent', sheet:'Reagents & Supplies', src:'reagents',   subKey:'subcategory', idPrefix:'R'  },
    { id:'oligos',       label:'Oligos',           kind:'reagent', sheet:'Oligos',              src:'oligos',     subKey:'type',        idPrefix:'OL' },
    { id:'totalseq',     label:'TotalSeq + HTOs',  kind:'totalseq' },
    { id:'antibodies',   label:'Antibodies',       kind:'reagent', sheet:'Antibodies',         src:'antibodies', subKey:'subcategory', idPrefix:'AB' },
    { id:'reservations', label:'Edit reservations',kind:'reservations', danger:true },
  ];
  function sec(id){ return SECTIONS.filter(function(s){return s.id===id;})[0]; }

  /* ---------- utilities ---------- */
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function fmt(n){ if(n==null||n==='') return '—'; var x=Number(n); if(!isFinite(x)) return esc(n); return (Math.round(x*100)/100).toLocaleString(); }
  function who(){ try{ return localStorage.getItem('annexhub_who')||''; }catch(e){ return ''; } }
  function setWho(v){ try{ localStorage.setItem('annexhub_who', v||''); }catch(e){} }

  // active reservations indexed by "category|itemKey" and "category|itemKey|lot"
  function resIndex(){
    var byItem={}, byLot={}, listByItem={};
    (data.reservations||[]).forEach(function(r){
      if(r.status!=='active') return;
      var ki=r.category+'|'+r.itemKey;
      byItem[ki]=(byItem[ki]||0)+(r.qty||0);
      (listByItem[ki]=listByItem[ki]||[]).push(r);
      if(r.lot){ var kl=ki+'|'+r.lot; byLot[kl]=(byLot[kl]||0)+(r.qty||0); }
    });
    return { byItem:byItem, byLot:byLot, listByItem:listByItem };
  }

  /* ---------- public ---------- */
  function setData(d){ data=d; }
  function currentSection(){ return section; }

  function render(){
    elContent = document.getElementById('invContent');
    elSubnav  = document.getElementById('subnav');
    if(!data){ return; }
    if(data.configured===false){
      elSubnav.innerHTML='';
      elContent.innerHTML = '<div class="content"><div class="error-box">The live inventory isn\'t connected yet. Set <b>GOOGLE_SA_KEY</b> and <b>INVENTORY_SHEET_ID</b> on this Worker and share the sheet with the service account. See the README.</div></div>';
      return;
    }
    renderSubnav();
    renderSection();
  }

  function renderSubnav(){
    var html='';
    SECTIONS.forEach(function(s){
      if(s.primary){
        html+='<button class="sn-primary" data-sec="'+s.id+'">＋ '+esc(s.label)+'</button>';
        html+='<div class="sn-label">Supply categories</div>';
      } else if(s.danger){
        html+='<div class="sn-label">Reservations</div>';
        html+='<button class="sn-item sn-danger'+(section===s.id?' is-active':'')+'" data-sec="'+s.id+'">'+esc(s.label)+'</button>';
      } else {
        html+='<button class="sn-item'+(section===s.id?' is-active':'')+'" data-sec="'+s.id+'">'+
              '<span>'+esc(s.label)+'</span><span class="sn-count">'+countFor(s)+'</span></button>';
      }
    });
    elSubnav.innerHTML=html;
    Array.prototype.forEach.call(elSubnav.querySelectorAll('[data-sec]'), function(b){
      b.onclick=function(){ section=b.getAttribute('data-sec'); search=''; renderSubnav(); renderSection(); elContent.scrollIntoView({block:'start'}); };
    });
  }
  function countFor(s){
    if(s.kind==='tenx') return (data.tenX||[]).length;
    if(s.kind==='totalseq') return (data.totalseq||[]).length;
    if(s.kind==='reagent') return (data[s.src]||[]).length;
    return '';
  }

  function renderSection(){
    var s=sec(section);
    if(!s){ section='update'; s=sec('update'); }
    if(s.kind==='update') return renderUpdate();
    if(s.kind==='tenx') return render10x();
    if(s.kind==='reagent') return renderReagent(s);
    if(s.kind==='totalseq') return renderTotalseq();
    if(s.kind==='reservations') return renderReservations();
  }

  function pageHead(title, sub, withSearch){
    var h='<div class="page-head"><div><h1>'+esc(title)+'</h1>'+(sub?'<div class="sub">'+esc(sub)+'</div>':'')+'</div>';
    if(withSearch) h+='<div class="search"><input id="invSearch" type="search" placeholder="Search name, catalog #, lot…" value="'+esc(search)+'"></div>';
    h+='</div>';
    return h;
  }
  function wireSearch(rerender){
    var i=document.getElementById('invSearch'); if(!i) return;
    i.oninput=function(){ search=i.value; rerender(); var again=document.getElementById('invSearch'); if(again){ again.focus(); var v=again.value; again.value=''; again.value=v; } };
  }
  function matchText(q, parts){ q=(q||'').toLowerCase().trim(); if(!q) return true; var hay=parts.join(' ').toLowerCase(); return q.split(/\s+/).every(function(t){return hay.indexOf(t)>=0;}); }

  /* ---------- reserved cell (clickable) ---------- */
  function reservedCell(category, itemKey, unit){
    var idx=resIndex(); var ki=category+'|'+itemKey; var amt=idx.byItem[ki]||0;
    if(!amt) return '<span class="metric">reserved <span class="rsv-link none">0</span></span>';
    return '<span class="metric">reserved <span class="rsv-link" data-rsv="'+esc(ki)+'"><b>'+fmt(amt)+'</b>'+(unit?(' '+esc(unit)):'')+'</span></span>';
  }
  function openReservedBreakdown(ki){
    var idx=resIndex(); var list=(idx.listByItem[ki]||[]);
    var name = list.length? list[0].itemName : ki.split('|')[1];
    var html='<div class="res-list">';
    if(!list.length) html+='<div class="empty">No active reservations.</div>';
    list.forEach(function(r){
      html+='<div class="res-item"><div class="r-main"><div><b>'+esc(r.experiment||r.project||'(unlabeled)')+'</b>'+(r.lot?' <span class="key" style="font-family:var(--mono);color:var(--faint)">lot '+esc(r.lot)+'</span>':'')+'</div>'+
            '<div class="r-for">'+esc(r.date||'')+(r.by?' · '+esc(r.by):'')+(r.notes?' · '+esc(r.notes):'')+'</div></div>'+
            '<div style="display:flex;align-items:center;gap:10px"><span class="r-qty">'+fmt(r.qty)+' '+esc(r.unit||'')+'</span>'+
            '<button class="btn btn-sm btn-danger" data-release="'+esc(r.id)+'">Release</button></div></div>';
    });
    html+='</div>';
    App.drawer('Reserved · '+name, html);
    document.querySelectorAll('#sheet [data-release]').forEach(function(b){
      b.onclick=function(){ releaseRes(b.getAttribute('data-release')); };
    });
  }

  /* ---------- UPDATE INVENTORY ---------- */
  function allItemsFlat(){
    var out=[];
    (data.tenX||[]).forEach(function(k){ out.push({category:'10X Kits', key:k.catalog, catalog:k.catalog, name:k.description, kind:'tenx', ref:k}); });
    ['reagents','oligos','antibodies'].forEach(function(src){
      (data[src]||[]).forEach(function(x){ out.push({category:sourceSheet(src), key:x.itemId, catalog:x.catalog||'', name:x.name, kind:'reagent', src:src, ref:x}); });
    });
    (data.totalseq||[]).forEach(function(t){ out.push({category:'Totalseq Cocktails + HTOs', key:t.tubeId, catalog:t.catalog||'', name:(t.storageBox+' '+t.tubeId), kind:'totalseq', ref:t}); });
    return out;
  }
  function sourceSheet(src){ return src==='reagents'?'Reagents & Supplies':src==='oligos'?'Oligos':src==='antibodies'?'Antibodies':src; }

  function renderUpdate(){
    var html = pageHead('Update inventory', 'Find an item to add or use stock, add a new item, or paste in many at once.', false);
    html += '<div class="panel" style="padding:12px"><div class="field" style="margin:0"><label>Your initials (saved to the log)</label><input id="whoInput" class="mono" placeholder="e.g. AH" value="'+esc(who())+'" style="max-width:160px"></div></div>';
    html += '<div class="seg" id="upMode" style="margin:0 0 12px">'+
      '<button data-m="one"'+(updateMode==='one'?' class="on"':'')+'>Find / add one</button>'+
      '<button data-m="bulk"'+(updateMode==='bulk'?' class="on"':'')+'>Bulk add (paste)</button></div>';
    html += '<div id="upBody"></div>';
    elContent.innerHTML='<div class="content">'+html+'</div>';
    document.getElementById('whoInput').onchange=function(){ setWho(this.value.trim()); };
    Array.prototype.forEach.call(document.querySelectorAll('#upMode button'),function(b){
      b.onclick=function(){ updateMode=b.getAttribute('data-m'); renderUpdate(); };
    });
    if(updateMode==='bulk') buildBulkGrid(document.getElementById('upBody'));
    else renderOneItem(document.getElementById('upBody'));
  }
  function renderOneItem(host){
    host.innerHTML='<div class="panel">'+
      '<div class="field"><label>Catalog # or item ID</label><input id="lookupKey" class="mono" placeholder="e.g. 1000698, R001, or a reagent catalog #" autocomplete="off"></div>'+
      '<div class="field"><label>…or search by name</label><input id="lookupName" placeholder="e.g. Sterile Water, 5\' Chip, HTO" autocomplete="off"><div id="lookupSuggest"></div></div>'+
      '<div id="lookupResult"></div></div>'+
      '<div id="addNewWrap"></div>';
    var key=document.getElementById('lookupKey'), nm=document.getElementById('lookupName');
    key.oninput=function(){ nm.value=''; document.getElementById('lookupSuggest').innerHTML=''; lookupByKey(key.value.trim()); };
    nm.oninput=function(){ key.value=''; document.getElementById('lookupResult').innerHTML=''; suggestByName(nm.value.trim()); };
  }

  function lookupByKey(k){
    var wrap=document.getElementById('lookupResult'); var addWrap=document.getElementById('addNewWrap');
    addWrap.innerHTML='';
    if(!k){ wrap.innerHTML=''; return; }
    var norm=k.replace(/\.0$/,'').toLowerCase();
    var hit=allItemsFlat().filter(function(it){ return String(it.key).toLowerCase()===norm || (it.catalog&&String(it.catalog).toLowerCase()===norm); })[0];
    if(hit){ wrap.innerHTML=''; wrap.appendChild(matchCard(hit)); }
    else {
      wrap.innerHTML='<div class="hint">No item with that catalog #/ID — fill in the details below to add it as a new item.</div>';
      addWrap.appendChild(addNewForm({key:k}));
    }
  }
  function suggestByName(q){
    var box=document.getElementById('lookupSuggest'); var wrap=document.getElementById('lookupResult');
    wrap.innerHTML=''; if(!q||q.length<2){ box.innerHTML=''; return; }
    var hits=allItemsFlat().filter(function(it){ return matchText(q,[it.name,it.key,it.catalog,it.category]); }).slice(0,12);
    if(!hits.length){
      box.innerHTML='<div class="suggest"><div class="s-item" style="cursor:default">No matches — <span class="rsv-link" id="addByName">add “'+esc(q)+'” as a new item</span></div></div>';
      var ab=document.getElementById('addByName'); if(ab) ab.onclick=function(){ box.innerHTML=''; var aw=document.getElementById('addNewWrap'); aw.innerHTML=''; aw.appendChild(addNewForm({name:q})); aw.scrollIntoView({block:'start'}); };
      return;
    }
    box.innerHTML='<div class="suggest">'+hits.map(function(h,i){
      return '<div class="s-item" data-i="'+i+'">'+esc(h.name||'(unnamed)')+'<span class="key">'+esc(h.key)+' · '+esc(h.category)+'</span></div>';
    }).join('')+'</div>';
    Array.prototype.forEach.call(box.querySelectorAll('[data-i]'), function(el){
      el.onclick=function(){ var h=hits[+el.getAttribute('data-i')]; box.innerHTML=''; document.getElementById('lookupName').value=h.name;
        wrap.innerHTML=''; wrap.appendChild(matchCard(h)); };
    });
  }

  function matchCard(it){
    var d=document.createElement('div'); d.className='match-card';
    var line='';
    if(it.kind==='tenx'){ var idx=resIndex(); var rv=idx.byItem['10X Kits|'+it.key]||0;
      line=fmt(it.ref.boxes)+' kits · '+fmt(it.ref.rxns)+' rxns on hand'+(rv?(' · '+fmt(rv)+' reserved'):'');
    } else if(it.kind==='reagent'){ line=fmt(it.ref.onHandUnits)+' '+esc(it.ref.unit||'')+' on hand ('+fmt(it.ref.onHandContainers)+' '+esc(it.ref.container||'container')+')'; }
    else if(it.kind==='totalseq'){ line=esc(it.ref.remaining)+' remaining · lot '+esc(it.ref.lot||'—'); }
    d.innerHTML='<div class="mc-name">'+esc(it.name)+
      (it.catalog?' <span class="key" style="font-family:var(--mono);color:var(--faint);font-size:12px">#'+esc(it.catalog)+'</span>':'')+
      ' <span class="key" style="font-family:var(--mono);color:var(--faint);font-size:12px">'+esc(it.key)+'</span></div>'+
      '<div class="r-for" style="margin:3px 0 10px">'+line+'</div>'+
      '<div id="mcActions"></div>';
    setTimeout(function(){ mountUpdateActions(d.querySelector('#mcActions'), it); },0);
    return d;
  }

  // Add-stock vs take-out actions inside Update page
  function mountUpdateActions(host, it){
    if(it.kind==='tenx'){
      // choose lot for take-out; add box/lot for add
      var lotOpts=it.ref.lots.map(function(L){ return '<option value="'+esc(L.lot)+'">'+(L.lot?('lot '+esc(L.lot)):'(no lot)')+' · '+fmt(L.rxns)+' rxns · '+fmt(L.boxes)+' box</option>'; }).join('');
      host.innerHTML=''+
        '<div class="seg"><button class="on" data-m="use">Use rxns</button><button data-m="addbox">Add box / lot</button></div>'+
        '<div id="mcBody"></div>';
      var body=host.querySelector('#mcBody');
      function useUI(){ body.innerHTML=
        '<div class="field"><label>Lot</label><select id="u_lot">'+lotOpts+'</select></div>'+
        stepperHTML('u_amt',1)+
        '<div class="field"><label>For experiment (optional)</label><input id="u_exp" placeholder="e.g. BCP batch 13"></div>'+
        '<div class="row-actions"><button class="btn btn-primary" id="u_go">Remove rxns</button></div>';
        wireStepper('u_amt');
        body.querySelector('#u_go').onclick=function(){
          adjust10x('remove', it.key, body.querySelector('#u_lot').value, num('u_amt'), body.querySelector('#u_exp').value);
        };
      }
      function addUI(){ body.innerHTML=
        '<div class="grid2"><div class="field"><label>New lot #</label><input id="a_lot" class="mono"></div>'+
        '<div class="field"><label>Expiry (YYYY-MM-DD)</label><input id="a_exp" class="mono" placeholder="2028-01-01"></div></div>'+
        '<div class="grid2"><div class="field"><label>How many boxes</label><input id="a_cnt" class="mono" value="1"></div>'+
        '<div class="field"><label>Rxns / indexes per box</label><input id="a_rxn" class="mono" placeholder="e.g. 16"></div></div>'+
        '<div class="row-actions"><button class="btn btn-primary" id="a_go">Add box(es)</button></div>';
        body.querySelector('#a_go').onclick=function(){
          add10xBox(it.key, body.querySelector('#a_lot').value, body.querySelector('#a_exp').value, +body.querySelector('#a_cnt').value||1, +body.querySelector('#a_rxn').value||0);
        };
      }
      useUI();
      Array.prototype.forEach.call(host.querySelectorAll('.seg button'),function(b){ b.onclick=function(){
        Array.prototype.forEach.call(host.querySelectorAll('.seg button'),function(x){x.classList.remove('on');}); b.classList.add('on');
        (b.getAttribute('data-m')==='use'?useUI:addUI)();
      };});
      return;
    }
    if(it.kind==='reagent'){
      var pack=it.ref.packSize||1; var unit=it.ref.unit||'unit'; var contL=it.ref.container||'container';
      host.innerHTML=''+
        stepperHTML('r_amt',1)+
        '<div class="field"><label>Remove/add as</label>'+
          '<div class="seg" id="r_mode"><button class="on" data-u="unit">'+esc(unit)+'</button><button data-u="cont">'+esc(contL)+'</button></div>'+
          '<div class="hint" id="r_hint"></div></div>'+
        '<div class="field"><label>For experiment (optional)</label><input id="r_exp" placeholder="e.g. ASAP batch"></div>'+
        '<div class="row-actions"><button class="btn" id="r_take">Take out</button><button class="btn btn-primary" id="r_add">Add</button></div>';
      wireStepper('r_amt');
      function isCont(){ var on=host.querySelector('#r_mode button.on'); return on&&on.getAttribute('data-u')==='cont'; }
      function refreshHint(){ var h=host.querySelector('#r_hint');
        if(isCont()){ h.textContent = it.ref.packConvertible ? ('1 '+contL+' = '+fmt(pack)+' '+unit+'; changes both counts.') : ('Changes the '+contL+' count only (no pack size set).'); }
        else { h.textContent = 'Changes the '+unit+' total only (e.g. a partial '+contL+').'; }
      }
      refreshHint();
      Array.prototype.forEach.call(host.querySelectorAll('#r_mode button'),function(b){ b.onclick=function(){
        Array.prototype.forEach.call(host.querySelectorAll('#r_mode button'),function(x){x.classList.remove('on');}); b.classList.add('on'); refreshHint(); };});
      host.querySelector('#r_take').onclick=function(){ var v=num('r_amt'); if(v<=0)return App.toast('Enter an amount',true); var d=reagentDelta(it.ref, isCont(), v, -1); adjustReagentDual(it.src, it.key, d.unitDelta, d.containerDelta, 'take out', host.querySelector('#r_exp').value); };
      host.querySelector('#r_add').onclick=function(){ var v=num('r_amt'); if(v<=0)return App.toast('Enter an amount',true); var d=reagentDelta(it.ref, isCont(), v, 1); adjustReagentDual(it.src, it.key, d.unitDelta, d.containerDelta, 'add', host.querySelector('#r_exp').value); };
      return;
    }
    if(it.kind==='totalseq'){
      host.innerHTML=stepperHTML('t_amt',1,'uL')+
        '<div class="seg"><button class="on" data-m="remove">Use</button><button data-m="add">Add</button><button data-m="set">Set to</button></div>'+
        '<div class="row-actions"><button class="btn btn-primary" id="t_go">Apply</button></div>';
      wireStepper('t_amt'); var mode='remove';
      Array.prototype.forEach.call(host.querySelectorAll('.seg button'),function(b){ b.onclick=function(){
        Array.prototype.forEach.call(host.querySelectorAll('.seg button'),function(x){x.classList.remove('on');}); b.classList.add('on'); mode=b.getAttribute('data-m'); };});
      host.querySelector('#t_go').onclick=function(){ adjustTotalseq(it.key, mode, num('t_amt')); };
    }
  }

  function stepperHTML(id, val, unitLabel){
    return '<div class="field"><label>Amount'+(unitLabel?(' ('+esc(unitLabel)+')'):'')+'</label>'+
      '<div class="stepper"><button type="button" data-step="'+id+'|-1">−</button>'+
      '<input id="'+id+'" class="mono" inputmode="decimal" value="'+val+'">'+
      '<button type="button" data-step="'+id+'|1">＋</button></div></div>';
  }
  function wireStepper(id){
    Array.prototype.forEach.call(document.querySelectorAll('[data-step]'), function(b){
      var parts=b.getAttribute('data-step').split('|'); if(parts[0]!==id) return;
      b.onclick=function(){ var i=document.getElementById(id); var v=parseFloat(i.value)||0; v+=parseFloat(parts[1]); if(v<0)v=0; i.value=(Math.round(v*100)/100); };
    });
  }
  function num(id){ var i=document.getElementById(id); return Math.max(0, parseFloat(i&&i.value)||0); }

  function addNewForm(prefill){
    prefill = prefill||{};
    var d=document.createElement('div'); d.className='panel';
    var preCat = prefill.cat||'reagents';
    function opt(v,lbl){ return '<option value="'+v+'"'+(v===preCat?' selected':'')+'>'+lbl+'</option>'; }
    d.innerHTML='<h2 style="margin-bottom:10px">Add a new item</h2>'+
      '<div class="field"><label>Category *</label><select id="n_cat">'+
        opt('reagents','Reagents &amp; supplies')+opt('oligos','Oligos')+opt('antibodies','Antibodies')+
        opt('totalseq','TotalSeq / HTO')+opt('tenx','10X kit (new catalog #)')+
      '</select><div class="hint">Pick where this item belongs — it decides which sheet it\u2019s added to.</div></div>'+
      '<div id="n_fields"></div>'+
      '<div class="row-actions"><button class="btn btn-primary" id="n_add">Add new item</button></div>';
    setTimeout(function(){
      var catSel=d.querySelector('#n_cat'); var fields=d.querySelector('#n_fields');
      function draw(){ fields.innerHTML=fieldsFor(catSel.value, prefill); }
      catSel.onchange=draw; draw();
      d.querySelector('#n_add').onclick=function(){ submitNew(catSel.value); };
    },0);
    return d;
  }
  function fieldsFor(cat, prefill){
    prefill = prefill||{};
    var kv = prefill.key?esc(prefill.key):'';       // catalog # / ID / tube id they searched
    var nv = prefill.name?esc(prefill.name):'';     // name they searched
    if(cat==='tenx') return ''+
      '<div class="grid2"><div class="field"><label>Catalog #</label><input id="f_key" class="mono" value="'+kv+'"></div>'+
      '<div class="field"><label>Experiment group</label><input id="f_exp" placeholder="e.g. 5\' v3"></div></div>'+
      '<div class="field"><label>Description</label><input id="f_name" value="'+nv+'"></div>'+
      '<div class="grid2"><div class="field"><label>Storage</label><input id="f_loc" placeholder="e.g. -20C SHM 301B"></div>'+
      '<div class="field"><label>Reserved for (project)</label><input id="f_resv" placeholder="e.g. BCP"></div></div>'+
      '<div class="grid2"><div class="field"><label>Lot #</label><input id="f_lot" class="mono"></div>'+
      '<div class="field"><label>Expiry</label><input id="f_expiry" class="mono" placeholder="2028-01-01"></div></div>'+
      '<div class="grid2"><div class="field"><label>How many boxes</label><input id="f_cnt" class="mono" value="1"></div>'+
      '<div class="field"><label>Rxns per box</label><input id="f_rxn" class="mono" value="16"></div></div>';
    if(cat==='totalseq') return ''+
      '<div class="grid2"><div class="field"><label>Tube ID</label><input id="f_key" class="mono" value="'+kv+'"></div>'+
      '<div class="field"><label>Storage box / sub-category</label><input id="f_box" placeholder="e.g. TSC HTO (CITEseq Hashtags)"></div></div>'+
      '<div class="grid2"><div class="field"><label>Type</label><input id="f_type" value="HTO"></div>'+
      '<div class="field"><label>TotalSeq version</label><input id="f_ver" placeholder="A / C"></div></div>'+
      '<div class="grid2"><div class="field"><label>Catalog #</label><input id="f_cat" class="mono"></div>'+
      '<div class="field"><label>Lot #</label><input id="f_lot" class="mono"></div></div>'+
      '<div class="grid2"><div class="field"><label>Hashtag #</label><input id="f_ht" class="mono"></div>'+
      '<div class="field"><label>Volume/qty remaining</label><input id="f_qty" class="mono" placeholder="e.g. 16"></div></div>';
    // reagent-shaped (reagents/oligos/antibodies)
    var extra='';
    if(cat==='oligos') extra='<div class="grid2"><div class="field"><label>Type</label><input id="f_type" placeholder="To Use / Stock"></div>'+
      '<div class="field"><label>Concentration</label><input id="f_conc" placeholder="10uM"></div></div>'+
      '<div class="field"><label>Sequence</label><input id="f_seq" class="mono"></div>';
    return ''+
      '<div class="field"><label>Item name *</label><input id="f_name" value="'+nv+'"></div>'+
      '<div class="grid2"><div class="field"><label>Catalog #</label><input id="f_catalog" class="mono" value="'+kv+'"></div>'+
      '<div class="field"><label>Vendor</label><input id="f_vendor"></div></div>'+
      '<div class="grid2"><div class="field"><label>Sub-category</label><input id="f_sub" placeholder="'+(cat==='reagents'?'Reagent / Supply':cat==='antibodies'?'Antibody':'Oligo')+'"></div>'+
      '<div class="field"><label>Container</label><input id="f_container" placeholder="bottle / tube / aliquot"></div></div>'+
      extra+
      '<div class="grid2"><div class="field"><label>Pack size (units per container)</label><input id="f_pack" class="mono" value="1"></div>'+
      '<div class="field"><label>Unit</label><input id="f_unit" placeholder="mL / uL / rxn"></div></div>'+
      '<div class="grid2"><div class="field"><label>On hand — containers</label><input id="f_cont" class="mono" value="1"></div>'+
      '<div class="field"><label>On hand — units (blank = containers×pack)</label><input id="f_units" class="mono" placeholder="auto"></div></div>'+
      '<div class="grid2"><div class="field"><label>Reorder at (units)</label><input id="f_reorder" class="mono"></div>'+
      '<div class="field"><label>Location</label><input id="f_loc"></div></div>'+
      '<div class="field"><label>Order status</label><input id="f_status" value="stocked"></div>';
  }
  function val(id){ var e=document.getElementById(id); return e?e.value.trim():''; }
  function submitNew(cat){
    var by=who();
    if(cat==='tenx'){
      var key=val('f_key'); if(!key) return App.toast('Catalog # is required', true);
      busy(true);
      API.post({ action:'add10xBox', itemKey:key, description:val('f_name'), experiment:val('f_exp'),
        storage:val('f_loc'), reservedFor:val('f_resv'), lot:val('f_lot'), expiry:val('f_expiry'),
        count:+val('f_cnt')||1, rxnsPerBox:+val('f_rxn')||0, by:by })
        .then(afterWrite('Added 10X kit'));
      return;
    }
    if(cat==='totalseq'){
      var box=val('f_box'); if(!box && !val('f_key')) return App.toast('Give a Tube ID or storage box', true);
      busy(true);
      API.post({ action:'addTotalseq', tubeId:val('f_key'), storageBox:box, type:val('f_type')||'HTO',
        version:val('f_ver'), catalog:val('f_cat'), lot:val('f_lot'), hashtag:val('f_ht'),
        remaining:val('f_qty'), by:by }).then(afterWrite('Added TotalSeq tube'));
      return;
    }
    var sheet = cat==='oligos'?'Oligos':cat==='antibodies'?'Antibodies':'Reagents & Supplies';
    var prefix = cat==='oligos'?'OL':cat==='antibodies'?'AB':'R';
    var name=val('f_name'); if(!name) return App.toast('Item name is required', true);
    busy(true);
    API.post({ action:'addReagent', sheet:sheet, idPrefix:prefix, name:name,
      subcategory:val('f_sub')|| (cat==='antibodies'?'Antibody':cat==='oligos'?'Oligo':'Reagent'),
      catalog:val('f_catalog'), vendor:val('f_vendor'),
      type:val('f_type'), concentration:val('f_conc'), sequence:val('f_seq'),
      container:val('f_container'), packSize:+val('f_pack')||1, unit:val('f_unit'),
      onHandContainers:+val('f_cont')||0, onHandUnits:(val('f_units')!==''?+val('f_units'):null), reorderAt:val('f_reorder')?+val('f_reorder'):null,
      location:val('f_loc'), orderStatus:val('f_status')||'stocked', by:by })
      .then(afterWrite('Added item'));
  }

  /* ---------- BULK ADD (paste-in grid) ---------- */
  function bulkColumns(cat){
    if(cat==='totalseq') return [
      {k:'tubeId',label:'Tube ID (blank = auto)'},{k:'storageBox',label:'Storage box *'},{k:'type',label:'Type'},
      {k:'catalog',label:'Catalog #'},{k:'lot',label:'Lot #'},{k:'version',label:'Version'},
      {k:'hashtag',label:'Hashtag #'},{k:'remaining',label:'Remaining'},{k:'reservedFor',label:'Reserved for'} ];
    var base=[{k:'name',label:'Item name *'}];
    if(cat==='oligos') base=base.concat([{k:'type',label:'Type'},{k:'concentration',label:'Concentration'},{k:'sequence',label:'Sequence'}]);
    else base=base.concat([{k:'catalog',label:'Catalog #'},{k:'vendor',label:'Vendor'}]);
    return base.concat([
      {k:'subcategory',label:'Sub-category',opts:subcatOptions(cat)},{k:'container',label:'Container'},{k:'packSize',label:'Pack size'},
      {k:'unit',label:'Unit'},{k:'onHandContainers',label:'On hand (cont)'},{k:'onHandUnits',label:'On hand (units)'},
      {k:'reorderAt',label:'Reorder at'},{k:'location',label:'Location'},{k:'notes',label:'Notes'} ]);
  }
  function subcatOptions(cat){
    var src = cat==='oligos'?'oligos':cat==='antibodies'?'antibodies':'reagents';
    var set={}; (data[src]||[]).forEach(function(x){ var s=(x.subcategory||'').trim(); if(s) set[s]=1; });
    var list=Object.keys(set).sort();
    if(!list.length) list = cat==='oligos'?['Oligo']:cat==='antibodies'?['Antibody']:['Reagent','Supply'];
    return list;
  }
  function buildBulkGrid(host){
    var cols=bulkColumns(bulkCat); var START_ROWS=8;
    var html='<div class="panel">'+
      '<div class="field" style="max-width:280px"><label>Category *</label><select id="bulkCat">'+
        '<option value="reagents"'+(bulkCat==='reagents'?' selected':'')+'>Reagents &amp; supplies</option>'+
        '<option value="oligos"'+(bulkCat==='oligos'?' selected':'')+'>Oligos</option>'+
        '<option value="antibodies"'+(bulkCat==='antibodies'?' selected':'')+'>Antibodies</option>'+
        '<option value="totalseq"'+(bulkCat==='totalseq'?' selected':'')+'>TotalSeq / HTO</option>'+
      '</select></div>'+
      '<div class="hint" style="margin:-4px 0 10px">Type into cells, or copy a block from Excel/Sheets and paste into the first cell — rows are added automatically. Item IDs are assigned on save. * required.</div>'+
      '<div class="bulkwrap"><table class="bulk"><thead><tr>'+cols.map(function(c){return '<th>'+esc(c.label)+'</th>';}).join('')+'</tr></thead>'+
      '<tbody id="bulkBody">'+bulkRows(cols,START_ROWS)+'</tbody></table></div>'+
      '<div class="row-actions" style="margin-top:12px">'+
        '<button class="btn btn-sm" id="bulkAddRows">+ 5 rows</button>'+
        '<button class="btn btn-sm" id="bulkClear">Clear</button>'+
        '<span style="flex:1"></span>'+
        '<button class="btn btn-primary" id="bulkSave">Add all</button>'+
      '</div></div>';
    host.innerHTML=html;
    var body=document.getElementById('bulkBody');
    document.getElementById('bulkCat').onchange=function(){ bulkCat=this.value; buildBulkGrid(host); };
    document.getElementById('bulkAddRows').onclick=function(){ body.insertAdjacentHTML('beforeend', bulkRows(cols,5,body.querySelectorAll('tr').length)); wirePaste(body,cols); };
    document.getElementById('bulkClear').onclick=function(){ buildBulkGrid(host); };
    document.getElementById('bulkSave').onclick=function(){ bulkSave(cols); };
    wirePaste(body,cols);
  }
  function bulkRows(cols, n, startIndex){
    startIndex=startIndex||0; var out='';
    for(var r=0;r<n;r++){ var ri=startIndex+r; out+='<tr>'+cols.map(function(c,ci){
      if(c.opts){ return '<td><select class="gcell" data-r="'+ri+'" data-c="'+ci+'"><option value=""></option>'+
        c.opts.map(function(o){return '<option value="'+esc(o)+'">'+esc(o)+'</option>';}).join('')+'</select></td>'; }
      return '<td><input class="gcell" data-r="'+ri+'" data-c="'+ci+'" autocomplete="off"></td>';
    }).join('')+'</tr>'; }
    return out;
  }
  function wirePaste(body, cols){
    Array.prototype.forEach.call(body.querySelectorAll('.gcell'), function(inp){
      if(inp._wired) return; inp._wired=true;
      inp.addEventListener('paste', function(e){
        var text=(e.clipboardData||window.clipboardData).getData('text');
        if(!text || (text.indexOf('\t')<0 && text.indexOf('\n')<0)) return; // single value: let default happen
        e.preventDefault();
        var startR=+inp.getAttribute('data-r'), startC=+inp.getAttribute('data-c');
        var lines=text.replace(/\r/g,'').split('\n'); if(lines.length && lines[lines.length-1]==='') lines.pop();
        var need=startR+lines.length;
        while(body.querySelectorAll('tr').length < need){ body.insertAdjacentHTML('beforeend', bulkRows(cols,1,body.querySelectorAll('tr').length)); }
        wirePaste(body,cols); // wire any new cells
        lines.forEach(function(line,ri){
          line.split('\t').forEach(function(valCell,ci){
            var cell=body.querySelector('.gcell[data-r="'+(startR+ri)+'"][data-c="'+(startC+ci)+'"]');
            if(cell) cell.value=valCell.trim(); // for <select>, only takes if the option exists
          });
        });
      });
    });
  }
  function bulkSave(cols){
    var body=document.getElementById('bulkBody'); var rows=[];
    Array.prototype.forEach.call(body.querySelectorAll('tr'), function(tr){
      var obj={}, any=false;
      Array.prototype.forEach.call(tr.querySelectorAll('.gcell'), function(inp,ci){
        var v=(inp.value||'').trim(); if(v){ any=true; obj[cols[ci].k]=v; }
      });
      if(any) rows.push(obj);
    });
    if(!rows.length) return App.toast('Nothing to add — fill in some rows', true);
    // required-field check
    var reqKey = bulkCat==='totalseq' ? 'storageBox' : 'name';
    var missing = rows.filter(function(o){ return !(o[reqKey]|| (bulkCat==='totalseq' && o.tubeId)); }).length;
    if(missing) return App.toast(missing+' row(s) missing the required '+(bulkCat==='totalseq'?'storage box or tube ID':'item name'), true);
    busy(true);
    API.post({ action:'bulkAdd', category:bulkCat, rows:rows, by:who() }).then(function(d){
      if(d&&d.ok){ App.toast('Added '+d.added+' item'+(d.added===1?'':'s')); App.reload(); }
      else { busy(false); App.toast('Error: '+((d&&d.error)||'bulk add failed'), true); }
    });
  }

  /* ---------- 10X REAGENTS page ---------- */
  function render10x(){
    var idx=resIndex();
    var kits=(data.tenX||[]).filter(function(k){ return matchText(search,[k.description,k.catalog,k.experiment].concat(k.lots.map(function(L){return L.lot;}))); });
    var groups={}; (data.experiments||[]).forEach(function(e){groups[e]=[];});
    kits.forEach(function(k){ (groups[k.experiment]=groups[k.experiment]||[]).push(k); });
    var order=Object.keys(groups).filter(function(g){return groups[g].length;}).sort();
    var html=pageHead('10X reagents','Grouped by assay. Expand a kit to edit or reserve a specific lot.', true);
    var openAttr = search ? ' open' : '';
    if(!order.length) html+='<div class="empty">No kits match “'+esc(search)+'”.</div>';
    order.forEach(function(g){
      var list=groups[g].sort(function(a,b){return a.description.localeCompare(b.description);});
      var toOrder=0; // 10X has no reorder threshold wired; skip
      html+='<details class="group"'+openAttr+'><summary><span class="caret">▸</span><span class="g-title">'+esc(g)+'</span>'+
            '<span class="g-meta">'+list.length+' kit'+(list.length>1?'s':'')+'</span></summary><div class="rows">';
      list.forEach(function(k){
        var ki='10X Kits|'+k.catalog; var rv=idx.byItem[ki]||0; var avail=k.rxns-rv;
        var isOpen=!!expanded[k.catalog];
        html+='<div class="irow'+(isOpen?' expanded':'')+'" data-cat="'+esc(k.catalog)+'">'+
          '<div class="nm">'+esc(k.description)+'<span class="key">'+esc(k.catalog)+'</span>'+
            (k.reservedFor?'<span class="flag lock">'+esc(k.reservedFor)+'</span>':'')+'</div>'+
          '<div class="metrics">'+
            '<span class="metric">on hand <b>'+fmt(k.boxes)+'</b> kits · <b>'+fmt(k.rxns)+'</b> rxns</span>'+
            reservedCell('10X Kits', k.catalog, 'rxns')+
            '<span class="metric avail">avail <b>'+fmt(avail)+'</b> rxns</span>'+
            '<button class="expand-btn" data-exp="'+esc(k.catalog)+'">'+(isOpen?'Hide lots':(k.lots.length+' lot'+(k.lots.length>1?'s':'')))+'</button>'+
          '</div>'+
          '<div class="lots">'+k.lots.map(function(L){ return lotRow(k,L,idx); }).join('')+'</div>'+
        '</div>';
      });
      html+='</div></details>';
    });
    elContent.innerHTML='<div class="content">'+html+'</div>';
    wireSearch(render10x);
    // expand toggles
    Array.prototype.forEach.call(elContent.querySelectorAll('[data-exp]'),function(b){
      b.onclick=function(){ var c=b.getAttribute('data-exp'); expanded[c]=!expanded[c]; render10x(); };
    });
    wireReservedLinks();
    wireLotControls();
  }
  function lotRow(k, L, idx){
    var rvLot=idx.byLot['10X Kits|'+k.catalog+'|'+(L.lot||'')]||0;
    var availLot=L.rxns-rvLot;
    return '<div class="lot" data-lot="'+esc(L.lot)+'" data-cat="'+esc(k.catalog)+'">'+
      '<span class="lotno">'+(L.lot?('Lot '+esc(L.lot)):'(no lot)')+'</span>'+
      '<span class="lotmeta">'+fmt(L.boxes)+' box · '+fmt(L.rxns)+' rxns'+(L.expiry?(' · exp '+esc(L.expiry)):'')+(rvLot?(' · '+fmt(rvLot)+' reserved'):'')+'</span>'+
      '<span class="lotmeta" style="color:var(--teal-d);font-weight:600">avail '+fmt(availLot)+'</span>'+
      '<span style="flex:1"></span>'+
      '<button class="btn btn-sm" data-lotuse="1">Use</button>'+
      '<button class="btn btn-sm" data-lotresv="1">Reserve</button>'+
    '</div>';
  }
  function wireLotControls(){
    Array.prototype.forEach.call(elContent.querySelectorAll('.lot [data-lotuse]'),function(b){
      b.onclick=function(){ var lot=b.closest('.lot'); openUseLot(lot.getAttribute('data-cat'), lot.getAttribute('data-lot')); };
    });
    Array.prototype.forEach.call(elContent.querySelectorAll('.lot [data-lotresv]'),function(b){
      b.onclick=function(){ var lot=b.closest('.lot'); openReserveForm({category:'10X Kits', itemKey:lot.getAttribute('data-cat'), lot:lot.getAttribute('data-lot'), unit:'rxns', name:kitName(lot.getAttribute('data-cat'))}); };
    });
  }
  function kitName(cat){ var k=(data.tenX||[]).filter(function(x){return x.catalog===cat;})[0]; return k?k.description:cat; }
  function openUseLot(cat, lot){
    var html='<div class="field"><label>Remove rxns from lot '+esc(lot||'(no lot)')+'</label></div>'+
      stepperHTML('lu_amt',1,'rxns')+
      '<div class="field"><label>For experiment (optional)</label><input id="lu_exp"></div>'+
      '<div class="row-actions"><button class="btn btn-primary" id="lu_go">Remove</button></div>';
    App.drawer('Use · '+kitName(cat), html);
    wireStepper('lu_amt');
    document.getElementById('lu_go').onclick=function(){ App.closeDrawer(); adjust10x('remove', cat, lot, num('lu_amt'), val('lu_exp')); };
  }

  /* ---------- REAGENT-shaped page ---------- */
  function renderReagent(s){
    var idx=resIndex();
    var items=(data[s.src]||[]).filter(function(x){ return matchText(search,[x.name,x.itemId,x.subcategory,x.type]); });
    var groups={};
    items.forEach(function(x){ var g=(x[s.subKey]||'Other')||'Other'; (groups[g]=groups[g]||[]).push(x); });
    var order=Object.keys(groups).sort();
    var html=pageHead(s.label, null, true);
    var openAttr = search ? ' open' : '';
    if(!items.length) html+='<div class="empty">Nothing matches '+(search?('“'+esc(search)+'”'):'yet')+'.</div>';
    order.forEach(function(g){
      var list=groups[g].sort(function(a,b){return (a.name||'').localeCompare(b.name||'');});
      var toOrder=list.filter(function(x){ return reorderState(x, idx)!=='ok'; }).length;
      html+='<details class="group"'+openAttr+'><summary><span class="caret">▸</span><span class="g-title">'+esc(g)+'</span>'+
            '<span class="g-meta">'+list.length+' item'+(list.length>1?'s':'')+(toOrder?(' · '+toOrder+' low'):'')+'</span></summary><div class="rows">';
      list.forEach(function(x){ html+=reagentRow(s, x, idx); });
      html+='</div></details>';
    });
    elContent.innerHTML='<div class="content">'+html+'</div>';
    wireSearch(function(){ renderReagent(s); });
    wireReservedLinks();
    wireReagentControls(s);
  }
  function reorderState(x, idx){
    var rv=idx.byItem[(x._sheet||'')+'|'+x.itemId]||0;
    var avail=(x.onHandUnits||0)-rv;
    if((x.onHandUnits||0)<=0) return 'out';
    if(x.reorderAt!=null && avail<=x.reorderAt) return 'reorder';
    return 'ok';
  }
  function reagentRow(s, x, idx){
    var category=s.sheet; x._sheet=category;
    var rv=idx.byItem[category+'|'+x.itemId]||0; var avail=(x.onHandUnits||0)-rv;
    var st = (x.onHandUnits||0)<=0?'out':(x.reorderAt!=null && avail<=x.reorderAt?'reorder':'ok');
    var flag = st==='out'?'<span class="flag out">out</span>':st==='reorder'?'<span class="flag reorder">reorder</span>':'';
    var id=esc(x.itemId);
    var contLabel=esc(x.container||'container');
    var onhand='on hand <b>'+fmt(x.onHandUnits)+'</b> '+esc(x.unit||'')+
               (x.onHandContainers!=null?(' · <b>'+fmt(x.onHandContainers)+'</b> '+contLabel+(x.onHandContainers==1?'':'s')):'');
    return '<div class="irow" data-key="'+id+'">'+
      '<div class="nm">'+esc(x.name||'(unnamed)')+
        (x.catalog?'<span class="key" title="Catalog #">#'+esc(x.catalog)+'</span>':'')+
        '<span class="key" title="Item ID">'+id+'</span>'+
        (x.vendor?'<span class="key" title="Vendor">'+esc(x.vendor)+'</span>':'')+
        (x.concentration?'<span class="tag">'+esc(x.concentration)+'</span>':'')+' '+flag+'</div>'+
      '<div class="metrics">'+
        '<span class="metric">'+onhand+'</span>'+
        reservedCell(category, x.itemId, x.unit)+
        '<span class="metric '+(st==='out'?'zero':st==='reorder'?'low':'avail')+'">avail <b>'+fmt(avail)+'</b> '+esc(x.unit||'')+'</span>'+
      '</div>'+
      '<div class="qty">'+
        '<div class="stepper"><button data-adj="'+id+'|-1">−</button><input class="qv" id="q_'+id+'" value="1" inputmode="decimal"><button data-adj="'+id+'|1">＋</button></div>'+
        '<div class="seg unit-toggle" id="tg_'+id+'"><button class="on" data-u="unit">'+esc(x.unit||'unit')+'</button><button data-u="cont">'+contLabel+'</button></div>'+
        '<button class="btn btn-sm" data-take="'+id+'">Take out</button>'+
        '<button class="btn btn-sm" data-add="'+id+'">Add</button>'+
        '<button class="btn btn-sm btn-ghost" data-resv="'+id+'">Reserve</button>'+
      '</div>'+
    '</div>';
  }
  // compute {unitDelta, containerDelta} for a reagent change
  function reagentDelta(x, isContainer, amount, sign){
    if(isContainer){
      var ud = x.packConvertible ? sign*amount*(x.packSize||1) : 0;
      return { unitDelta: ud, containerDelta: sign*amount };
    }
    return { unitDelta: sign*amount, containerDelta: 0 };
  }
  function wireReagentControls(s){
    var map={}; (data[s.src]||[]).forEach(function(x){ map[x.itemId]=x; });
    Array.prototype.forEach.call(elContent.querySelectorAll('[data-adj]'),function(b){
      b.onclick=function(){ var p=b.getAttribute('data-adj').split('|'); var i=document.getElementById('q_'+p[0]); var v=parseFloat(i.value)||0; v+=parseFloat(p[1]); if(v<0)v=0; i.value=Math.round(v*100)/100; };
    });
    // unit/container toggle
    Array.prototype.forEach.call(elContent.querySelectorAll('.unit-toggle'),function(tg){
      Array.prototype.forEach.call(tg.querySelectorAll('button'),function(bt){
        bt.onclick=function(){ Array.prototype.forEach.call(tg.querySelectorAll('button'),function(x){x.classList.remove('on');}); bt.classList.add('on'); };
      });
    });
    function modeIsContainer(id){ var tg=document.getElementById('tg_'+id); var on=tg&&tg.querySelector('button.on'); return !!(on && on.getAttribute('data-u')==='cont'); }
    Array.prototype.forEach.call(elContent.querySelectorAll('[data-take]'),function(b){
      b.onclick=function(){ var id=b.getAttribute('data-take'); var x=map[id]; var v=parseFloat(document.getElementById('q_'+id).value)||0; if(v<=0) return App.toast('Enter an amount', true);
        var d=reagentDelta(x, modeIsContainer(id), v, -1);
        adjustReagentDual(s.src, id, d.unitDelta, d.containerDelta, 'take out'); };
    });
    Array.prototype.forEach.call(elContent.querySelectorAll('[data-add]'),function(b){
      b.onclick=function(){ var id=b.getAttribute('data-add'); var x=map[id]; var v=parseFloat(document.getElementById('q_'+id).value)||0; if(v<=0) return App.toast('Enter an amount', true);
        var d=reagentDelta(x, modeIsContainer(id), v, 1);
        adjustReagentDual(s.src, id, d.unitDelta, d.containerDelta, 'add'); };
    });
    Array.prototype.forEach.call(elContent.querySelectorAll('[data-resv]'),function(b){
      b.onclick=function(){ var x=map[b.getAttribute('data-resv')]; openReserveForm({category:s.sheet, itemKey:x.itemId, unit:x.unit, name:x.name}); };
    });
  }

  /* ---------- TOTALSEQ page ---------- */
  function renderTotalseq(){
    var idx=resIndex();
    var items=(data.totalseq||[]).filter(function(t){ return matchText(search,[t.tubeId,t.storageBox,t.catalog,t.lot,t.hashtag,t.version]); });
    var groups={}; items.forEach(function(t){ var g=t.storageBox||'Other'; (groups[g]=groups[g]||[]).push(t); });
    var order=Object.keys(groups).sort();
    var html=pageHead('TotalSeq cocktails + HTOs', 'Grouped by storage box.', true);
    var openAttr = search ? ' open' : '';
    if(!items.length) html+='<div class="empty">Nothing matches '+(search?('“'+esc(search)+'”'):'yet')+'.</div>';
    order.forEach(function(g){
      var list=groups[g].sort(function(a,b){ return String(a.tubeId).localeCompare(String(b.tubeId), undefined, {numeric:true}); });
      html+='<details class="group"'+openAttr+'><summary><span class="caret">▸</span><span class="g-title">'+esc(g)+'</span>'+
            '<span class="g-meta">'+list.length+' tube'+(list.length>1?'s':'')+'</span></summary><div class="rows">';
      list.forEach(function(t){
        var rv=idx.byItem['Totalseq Cocktails + HTOs|'+t.tubeId]||0;
        var cur=parseFloat(String(t.remaining).replace(/[^0-9.\-]/g,'')); var hasNum=isFinite(cur);
        html+='<div class="irow" data-tube="'+esc(t.tubeId)+'">'+
          '<div class="nm">'+esc(t.tubeId)+(t.hashtag?'<span class="tag">HTO '+esc(t.hashtag)+'</span>':'')+
            (t.catalog?'<span class="key" title="Catalog #">#'+esc(t.catalog)+'</span>':'')+
            '<span class="key">'+esc(t.version?('v'+t.version):'')+(t.lot?(' · '+t.lot):'')+'</span></div>'+
          '<div class="metrics">'+
            '<span class="metric">remaining <b>'+esc(t.remaining||'—')+'</b></span>'+
            reservedCell('Totalseq Cocktails + HTOs', t.tubeId, 'uL')+
          '</div>'+
          '<div class="qty">'+
            '<div class="stepper"><button data-tadj="'+esc(t.tubeId)+'|-1">−</button><input id="tq_'+esc(t.tubeId)+'" value="1" inputmode="decimal"><button data-tadj="'+esc(t.tubeId)+'|1">＋</button></div>'+
            '<button class="btn btn-sm" data-tuse="'+esc(t.tubeId)+'">Use</button>'+
            '<button class="btn btn-sm" data-tadd="'+esc(t.tubeId)+'">Add</button>'+
            '<button class="btn btn-sm btn-ghost" data-tset="'+esc(t.tubeId)+'">Set</button>'+
            '<button class="btn btn-sm btn-ghost" data-tresv="'+esc(t.tubeId)+'">Reserve</button>'+
          '</div>'+
        '</div>';
      });
      html+='</div></details>';
    });
    elContent.innerHTML='<div class="content">'+html+'</div>';
    wireSearch(renderTotalseq);
    wireReservedLinks();
    function amt(id){ return Math.max(0, parseFloat(document.getElementById('tq_'+id).value)||0); }
    Array.prototype.forEach.call(elContent.querySelectorAll('[data-tadj]'),function(b){
      b.onclick=function(){ var p=b.getAttribute('data-tadj').split('|'); var i=document.getElementById('tq_'+p[0]); var v=parseFloat(i.value)||0; v+=parseFloat(p[1]); if(v<0)v=0; i.value=Math.round(v*100)/100; };
    });
    Array.prototype.forEach.call(elContent.querySelectorAll('[data-tuse]'),function(b){ b.onclick=function(){ adjustTotalseq(b.getAttribute('data-tuse'),'remove',amt(b.getAttribute('data-tuse'))); };});
    Array.prototype.forEach.call(elContent.querySelectorAll('[data-tadd]'),function(b){ b.onclick=function(){ adjustTotalseq(b.getAttribute('data-tadd'),'add',amt(b.getAttribute('data-tadd'))); };});
    Array.prototype.forEach.call(elContent.querySelectorAll('[data-tset]'),function(b){ b.onclick=function(){ adjustTotalseq(b.getAttribute('data-tset'),'set',amt(b.getAttribute('data-tset'))); };});
    Array.prototype.forEach.call(elContent.querySelectorAll('[data-tresv]'),function(b){ b.onclick=function(){ var t=(data.totalseq||[]).filter(function(x){return x.tubeId===b.getAttribute('data-tresv');})[0]; openReserveForm({category:'Totalseq Cocktails + HTOs', itemKey:t.tubeId, lot:t.lot, unit:'uL', name:t.storageBox+' '+t.tubeId}); };});
  }

  /* ---------- RESERVATIONS page ---------- */
  function renderReservations(){
    var all=(data.reservations||[]).filter(function(r){return r.status==='active'||r.status==='fulfilled';});
    var html=pageHead('Reservations', 'Grouped by experiment. Expand one to adjust amounts or remove the reserved stock from inventory.', false);
    html+='<div class="panel"><div class="row-actions"><button class="btn btn-primary" id="newResBtn">＋ New reservation</button></div></div>';
    // group by experiment (fall back to project / unlabeled)
    var byExp={};
    all.forEach(function(r){ var e=(r.experiment||r.project||'(unlabeled)'); (byExp[e]=byExp[e]||[]).push(r); });
    // only surface experiments that still have at least one active reservation
    var order=Object.keys(byExp).filter(function(e){ return byExp[e].some(function(r){return r.status==='active';}); }).sort();
    if(!order.length) html+='<div class="empty">No active reservations. New reservations you make here — or that the planner creates — show up across every category page and reduce the available amount.</div>';
    order.forEach(function(exp){
      var list=byExp[exp]; var act=list.filter(function(r){return r.status==='active';});
      var proj=(act[0]&&act[0].project)||'';
      html+='<details class="group"><summary><span class="caret">▸</span>'+
        '<span class="g-title">'+esc(exp)+'</span>'+
        '<span class="g-meta">'+act.length+' item'+(act.length===1?'':'s')+' reserved'+(proj?(' · '+esc(proj)):'')+'</span></summary>'+
        '<div class="rows" style="padding:6px 14px">';
      list.forEach(function(r){
        var done = r.status==='fulfilled';
        html+='<div class="res-item" style="'+(done?'opacity:.6':'')+'">'+
          '<div class="r-main"><div><b>'+esc(r.itemName||r.itemKey)+'</b> <span class="key" style="font-family:var(--mono);color:var(--faint);font-size:12px">'+esc(r.itemKey)+(r.lot?(' · lot '+esc(r.lot)):'')+'</span></div>'+
          '<div class="r-for">'+esc(r.category)+' · '+esc(r.date||'')+(r.by?(' · '+esc(r.by)):'')+'</div>'+
          (done?'<div class="r-for" style="color:var(--green);font-weight:600">✓ complete — removed from inventory</div>':'')+
          '</div>'+
          (done
            ? '<div><span class="r-qty">'+fmt(r.qty)+' '+esc(r.unit||'')+'</span></div>'
            : '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end">'+
                '<div class="stepper"><button data-rq="'+esc(r.id)+'|-1">−</button><input id="rq_'+esc(r.id)+'" value="'+fmt(r.qty)+'" inputmode="decimal" style="width:56px"><button data-rq="'+esc(r.id)+'|1">＋</button></div>'+
                '<span style="font-size:12px;color:var(--muted)">'+esc(r.unit||'')+'</span>'+
                '<button class="btn btn-sm" data-rsave="'+esc(r.id)+'">Save</button>'+
                '<button class="btn btn-sm btn-primary" data-rfulfill="'+esc(r.id)+'">Remove from inventory</button>'+
                '<button class="btn btn-sm btn-danger" data-release="'+esc(r.id)+'">Cancel</button>'+
              '</div>')+
        '</div>';
      });
      html+='</div></details>';
    });
    elContent.innerHTML='<div class="content">'+html+'</div>';
    document.getElementById('newResBtn').onclick=function(){ openReserveForm({}); };
    Array.prototype.forEach.call(elContent.querySelectorAll('[data-rq]'),function(b){
      b.onclick=function(){ var p=b.getAttribute('data-rq').split('|'); var i=document.getElementById('rq_'+p[0]); var v=parseFloat(i.value)||0; v+=parseFloat(p[1]); if(v<0)v=0; i.value=Math.round(v*100)/100; };
    });
    Array.prototype.forEach.call(elContent.querySelectorAll('[data-rsave]'),function(b){
      b.onclick=function(){ var id=b.getAttribute('data-rsave'); var v=parseFloat(document.getElementById('rq_'+id).value)||0;
        busy(true); API.post({action:'updateReservation', reservationId:id, qty:v, by:who()}).then(afterWrite('Reservation updated')); };
    });
    Array.prototype.forEach.call(elContent.querySelectorAll('[data-rfulfill]'),function(b){
      b.onclick=function(){ var id=b.getAttribute('data-rfulfill');
        busy(true); API.post({action:'fulfillReservation', reservationId:id, by:who()}).then(afterWrite('Removed from inventory — reservation complete')); };
    });
    Array.prototype.forEach.call(elContent.querySelectorAll('[data-release]'),function(b){ b.onclick=function(){ releaseRes(b.getAttribute('data-release')); };});
  }

  // ---- Multi-item reservation form ----
  function openReserveForm(pre){
    pre=pre||{};
    var html=''+
      '<div class="grid2"><div class="field"><label>Experiment</label><input id="rf_exp" placeholder="e.g. BCP batch 13" value="'+esc(pre.experiment||'')+'"></div>'+
      '<div class="field"><label>Project</label><input id="rf_proj" placeholder="e.g. BCP" value="'+esc(pre.project||'')+'"></div></div>'+
      '<div class="field"><label>Items to reserve</label><div id="resRows"></div>'+
        '<button class="btn btn-sm" id="rf_addrow" style="margin-top:6px">＋ Add item</button></div>'+
      '<div class="field"><label>Notes (optional)</label><input id="rf_notes"></div>'+
      '<div class="row-actions"><button class="btn btn-primary" id="rf_go">Reserve all</button></div>';
    App.drawer('New reservation', html);
    var rowsHost=document.getElementById('resRows'); var seq=0; var picked={};
    var items=allItemsFlat();
    function unitLabel(it){ return it.kind==='tenx'?'rxns':it.kind==='totalseq'?'uL':(it.ref.unit||'unit'); }
    function addRow(preItem){
      var id='r'+(seq++);
      var row=document.createElement('div'); row.className='resrow'; row.setAttribute('data-row',id);
      row.innerHTML='<div class="resrow-item"><input class="ritem" placeholder="Search name or catalog #…" autocomplete="off"><div class="rsuggest"></div></div>'+
        '<input class="rqty" value="1" inputmode="decimal">'+
        '<select class="runit"><option value="unit">unit</option></select>'+
        '<button class="rrm" title="Remove row">×</button>';
      rowsHost.appendChild(row);
      var si=row.querySelector('.ritem'), box=row.querySelector('.rsuggest'), usel=row.querySelector('.runit');
      function setItem(it){ picked[id]=it; si.value=it.name||it.key; box.innerHTML='';
        var opts='<option value="unit">'+esc(unitLabel(it))+'</option>';
        if(it.kind==='reagent' && it.ref.container) opts+='<option value="cont">'+esc(it.ref.container)+'</option>';
        usel.innerHTML=opts;
      }
      si.oninput=function(){ picked[id]=null; var q=si.value.trim(); if(q.length<2){box.innerHTML='';return;}
        var hits=items.filter(function(it){return matchText(q,[it.name,it.key,it.catalog,it.category]);}).slice(0,8);
        box.innerHTML='<div class="suggest">'+(hits.length?hits.map(function(h,i){return '<div class="s-item" data-i="'+i+'">'+esc(h.name||'(unnamed)')+'<span class="key">'+esc(h.key)+' · '+esc(h.category)+'</span></div>';}).join(''):'<div class="s-item" style="cursor:default;color:var(--faint)">No matches</div>')+'</div>';
        Array.prototype.forEach.call(box.querySelectorAll('[data-i]'),function(el){ el.onclick=function(){ setItem(hits[+el.getAttribute('data-i')]); };});
      };
      row.querySelector('.rrm').onclick=function(){ delete picked[id]; row.parentNode.removeChild(row); };
      if(preItem) setItem(preItem);
    }
    // seed rows
    if(pre.itemKey){ var it0=items.filter(function(x){return x.category===pre.category && String(x.key)===String(pre.itemKey);})[0]; if(it0&&pre.lot) it0._lot=pre.lot; addRow(it0); }
    else { addRow(); addRow(); }
    document.getElementById('rf_addrow').onclick=function(){ addRow(); };
    document.getElementById('rf_go').onclick=function(){
      var exp=val('rf_exp'), proj=val('rf_proj'), notes=val('rf_notes');
      var out=[];
      Array.prototype.forEach.call(rowsHost.querySelectorAll('.resrow'),function(row){
        var id=row.getAttribute('data-row'); var it=picked[id]; if(!it) return;
        var qty=parseFloat(row.querySelector('.rqty').value)||0; if(qty<=0) return;
        var mode=row.querySelector('.runit').value; var unit=unitLabel(it); var note=notes;
        if(mode==='cont'){ if(it.ref&&it.ref.packConvertible){ qty=qty*(it.ref.packSize||1); note=(note?note+'; ':'')+'reserved by '+(it.ref.container||'container'); } else { unit=(it.ref&&it.ref.container)||'container'; } }
        out.push({ category:it.category, itemKey:it.key, lot:it._lot||'', itemName:it.name, qty:qty, unit:unit, notes:note });
      });
      if(!out.length) return App.toast('Add at least one item with a quantity', true);
      App.closeDrawer(); busy(true);
      API.post({ action:'reserveBulk', items:out, experiment:exp, project:proj, notes:notes, by:who() })
        .then(function(d){ if(d&&d.ok){ App.toast('Reserved '+d.count+' item'+(d.count===1?'':'s')); App.reload(); } else { busy(false); App.toast('Error: '+((d&&d.error)||'reserve failed'), true); } });
    };
  }
  function releaseRes(id){
    busy(true);
    API.post({ action:'releaseReservation', reservationId:id, by:who() }).then(afterWrite('Reservation cancelled'));
  }

  /* ---------- write helpers ---------- */
  function adjustReagentDual(src, key, unitDelta, containerDelta, reason, exp){
    var sheet = src==='reagents'?'Reagents & Supplies':src==='oligos'?'Oligos':'Antibodies';
    busy(true);
    var msg = (unitDelta||containerDelta) ? ((unitDelta<0||containerDelta<0)?'Removed':'Added') : 'Updated';
    API.post({ action:'adjustReagent', sheet:sheet, itemKey:key, unitDelta:unitDelta, containerDelta:containerDelta, reason:reason||'', experiment:exp||'', by:who() })
      .then(afterWrite(msg));
  }
  function adjust10x(mode, cat, lot, amount, exp){
    if(amount<=0) return App.toast('Enter an amount', true);
    busy(true);
    API.post({ action:'adjust10x', itemKey:cat, lot:lot, mode:mode, amount:amount, experiment:exp||'', by:who() })
      .then(afterWrite(mode==='remove'?'Removed '+fmt(amount)+' rxns':'Updated'));
  }
  function add10xBox(cat, lot, expiry, count, rxnsPerBox){
    busy(true);
    API.post({ action:'add10xBox', itemKey:cat, lot:lot, expiry:expiry, count:count, rxnsPerBox:rxnsPerBox, by:who() })
      .then(afterWrite('Added '+count+' box'+(count>1?'es':'')));
  }
  function adjustTotalseq(tube, mode, amount){
    if(amount<=0 && mode!=='set') return App.toast('Enter an amount', true);
    busy(true);
    API.post({ action:'adjustTotalseq', itemKey:tube, mode:mode, amount:amount, by:who() })
      .then(afterWrite(mode==='remove'?'Used '+fmt(amount):mode==='set'?'Set to '+fmt(amount):'Added '+fmt(amount)));
  }
  function afterWrite(msg){
    return function(d){
      if(d && d.ok){ App.toast(msg); App.reload(); }
      else { busy(false); App.toast('Error: '+((d&&d.error)||'write failed'), true); }
    };
  }
  function busy(on){ App.setBusy(on); }

  function wireReservedLinks(){
    Array.prototype.forEach.call(elContent.querySelectorAll('.rsv-link[data-rsv]'),function(el){
      el.onclick=function(){ openReservedBreakdown(el.getAttribute('data-rsv')); };
    });
  }

  return { setData:setData, render:render, currentSection:currentSection };
})();

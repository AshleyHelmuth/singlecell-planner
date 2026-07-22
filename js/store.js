/* ============================================================================
   store.js  —  Local persistence for saved experiments, projects and inventory
   transactions. Uses the browser's localStorage (this app is a self-hosted
   static site, so localStorage persists across sessions on the same browser).

   Nothing here touches the DOM or the workbook, so it is easy to test in Node
   with a small localStorage shim. All records are plain JSON.

   Data shape
   ----------
   experiment = {
     id, name, project, date, status ('planned'|'completed'),
     createdAt, updatedAt, inventoryApplied (bool),
     state:    { sel, gridRows, customCols, confounderIdx[], poolOverride, optValues{} },
     snapshot: { nSamples, nPools, arms[], modalities[], knownTotal,
                 reagents[], lineItems[], pooling{header[],rows[]}, batches[] }
   }
   transaction = { id, itemId, itemName, unit, delta, date, reason, experimentId }
   ============================================================================ */
(function (root) {
  'use strict';

  var EXP_KEY = 'scp:experiments:v1';
  var TX_KEY = 'scp:inventoryTx:v1';
  var PROJ_KEY = 'scp:projectsMeta:v1';

  function ls() {
    try { return (typeof localStorage !== 'undefined') ? localStorage : null; }
    catch (e) { return null; }
  }
  function readArr(key) {
    var s = ls(); if (!s) return [];
    try { var v = JSON.parse(s.getItem(key) || '[]'); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function writeArr(key, arr) {
    var s = ls(); if (!s) return false;
    try { s.setItem(key, JSON.stringify(arr)); return true; }
    catch (e) { return false; } // quota or disabled
  }
  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  }
  function nowIso() { return new Date().toISOString(); }

  // ---- Drive-backed cache ---------------------------------------------------
  // Experiments/projects live in a Google Sheet (source of truth). On load we
  // hydrate an in-memory cache from /api/experiments; the synchronous API below
  // reads that cache, and every write mirrors to Drive in the background
  // (read-before-write is handled server-side, one row at a time). localStorage
  // is kept only as an offline cache/fallback.
  var EXP_CACHE = null;   // null = not hydrated yet
  var PROJ_CACHE = null;
  var DRIVE_READY = false;

  function _exp() { if (EXP_CACHE === null) EXP_CACHE = readArr(EXP_KEY); return EXP_CACHE; }
  function _proj() { if (PROJ_CACHE === null) PROJ_CACHE = readArr(PROJ_KEY); return PROJ_CACHE; }

  var _driveQueue = Promise.resolve();
  function drivePost(payload) {
    if (!DRIVE_READY) return Promise.resolve(); // never push if we never connected
    // Chain writes so rapid saves for the same id can't race (each read-before-
    // write completes before the next begins).
    _driveQueue = _driveQueue.then(function () {
      return fetch('/api/experiments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      }).then(function (r) { if (!r.ok) console.warn('[experiments] sync failed', payload.action, r.status); })
        .catch(function (e) { console.warn('[experiments] sync error', payload.action, e); });
    });
    return _driveQueue;
  }

  // Pull the shared experiments/projects from Drive into the cache.
  function hydrateFromDrive() {
    return fetch('/api/experiments').then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then(function (d) {
      if (!d || !d.ok) throw new Error('bad response');
      EXP_CACHE = Array.isArray(d.experiments) ? d.experiments : [];
      PROJ_CACHE = Array.isArray(d.projects) ? d.projects : [];
      DRIVE_READY = true;
      writeArr(EXP_KEY, EXP_CACHE); writeArr(PROJ_KEY, PROJ_CACHE); // mirror offline
      return { ok: true, source: 'drive', experiments: EXP_CACHE.length };
    }).catch(function (e) {
      EXP_CACHE = readArr(EXP_KEY); PROJ_CACHE = readArr(PROJ_KEY); DRIVE_READY = false;
      console.warn('[experiments] using local cache (Drive unavailable):', e && e.message);
      return { ok: false, source: 'local', experiments: EXP_CACHE.length };
    });
  }

  // ---- Experiments ----------------------------------------------------------
  function allExperiments() { return _exp(); }

  function getExperiment(id) {
    return allExperiments().filter(function (e) { return e.id === id; })[0] || null;
  }

  // Insert or update. If rec.id exists it is replaced; otherwise a new id is set.
  function saveExperiment(rec) {
    var arr = _exp();
    if (!rec.id) rec.id = uuid();
    if (!rec.createdAt) rec.createdAt = nowIso();
    rec.updatedAt = nowIso();
    var idx = -1;
    for (var i = 0; i < arr.length; i++) { if (arr[i].id === rec.id) { idx = i; break; } }
    if (idx >= 0) arr[idx] = rec; else arr.push(rec);
    writeArr(EXP_KEY, arr);
    drivePost({ action: 'upsert', record: rec });
    return rec;
  }

  function deleteExperiment(id) {
    EXP_CACHE = _exp().filter(function (e) { return e.id !== id; });
    writeArr(EXP_KEY, EXP_CACHE);
    // also drop that experiment's inventory transactions (local)
    writeArr(TX_KEY, allTransactions().filter(function (t) { return t.experimentId !== id; }));
    drivePost({ action: 'delete', id: id });
  }

  // Distinct project names (non-empty), sorted, plus a flag for "unfiled".
  function projects() {
    var seen = {}, out = [], hasUnfiled = false;
    allExperiments().forEach(function (e) {
      var p = (e.project || '').trim();
      if (!p) { hasUnfiled = true; return; }
      if (!seen[p]) { seen[p] = true; out.push(p); }
    });
    out.sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; });
    return { names: out, hasUnfiled: hasUnfiled };
  }

  function experimentsInProject(project) {
    var target = (project || '').trim();
    return allExperiments().filter(function (e) {
      var p = (e.project || '').trim();
      return target === '__all__' ? true : (target === '' ? p === '' : p === target);
    }).sort(function (a, b) {
      // by date if present, else by createdAt
      var da = a.date || a.createdAt || '', db = b.date || b.createdAt || '';
      return da < db ? -1 : (da > db ? 1 : 0);
    });
  }

  // ---- Project metadata (name + owner) --------------------------------------
  // Projects are still linked to experiments by the experiment.project name; this
  // store just holds per-project metadata (owner) and lets empty projects exist.
  function allProjects() { return _proj(); }
  function getProject(name) {
    var t = (name || '').trim();
    return allProjects().filter(function (p) { return (p.name || '') === t; })[0] || null;
  }
  function saveProject(rec) {
    var arr = _proj();
    rec.name = (rec.name || '').trim();
    if (!rec.name) return null;
    if (!rec.createdAt) rec.createdAt = nowIso();
    rec.updatedAt = nowIso();
    var idx = -1;
    for (var i = 0; i < arr.length; i++) { if ((arr[i].name || '') === rec.name) { idx = i; break; } }
    if (idx >= 0) arr[idx] = rec; else arr.push(rec);
    writeArr(PROJ_KEY, arr);
    drivePost({ action: 'saveProject', project: { name: rec.name, owner: rec.owner || '', notes: rec.notes || '' } });
    return rec;
  }
  function deleteProject(name) {
    var t = (name || '').trim();
    PROJ_CACHE = _proj().filter(function (p) { return (p.name || '') !== t; });
    writeArr(PROJ_KEY, PROJ_CACHE);
  }

  // ---- Inventory transactions ----------------------------------------------
  function allTransactions() { return readArr(TX_KEY); }
  function transactionsForExperiment(id) {
    return allTransactions().filter(function (t) { return t.experimentId === id; });
  }
  function addTransactions(list) {
    var arr = allTransactions();
    list.forEach(function (t) { if (!t.id) t.id = uuid(); arr.push(t); });
    writeArr(TX_KEY, arr);
    return arr;
  }
  function removeTransactionsForExperiment(id) {
    writeArr(TX_KEY, allTransactions().filter(function (t) { return t.experimentId !== id; }));
  }
  // Net change per item across all recorded transactions: { itemId: {delta, name, unit} }
  function inventoryNet() {
    var net = {};
    allTransactions().forEach(function (t) {
      if (!net[t.itemId]) net[t.itemId] = { delta: 0, name: t.itemName || '', unit: t.unit || '' };
      net[t.itemId].delta += (t.delta || 0);
    });
    return net;
  }

  // ---- Backup / portability -------------------------------------------------
  function exportAll() {
    return { version: 1, exportedAt: nowIso(), experiments: allExperiments(), transactions: allTransactions(), projects: allProjects() };
  }
  // mode: 'replace' | 'merge'
  function importAll(obj, mode) {
    if (!obj || !Array.isArray(obj.experiments)) return { ok: false, reason: 'No experiments in file.' };
    if (mode === 'replace') {
      writeArr(EXP_KEY, obj.experiments);
      writeArr(TX_KEY, Array.isArray(obj.transactions) ? obj.transactions : []);
      writeArr(PROJ_KEY, Array.isArray(obj.projects) ? obj.projects : []);
      return { ok: true, added: obj.experiments.length };
    }
    // merge: incoming ids overwrite same ids, others appended
    var cur = allExperiments(), byId = {};
    cur.forEach(function (e) { byId[e.id] = e; });
    obj.experiments.forEach(function (e) { if (e.id) byId[e.id] = e; else { e.id = uuid(); byId[e.id] = e; } });
    writeArr(EXP_KEY, Object.keys(byId).map(function (k) { return byId[k]; }));
    if (Array.isArray(obj.transactions)) {
      var curT = allTransactions(), tById = {};
      curT.forEach(function (t) { tById[t.id] = t; });
      obj.transactions.forEach(function (t) { if (!t.id) t.id = uuid(); tById[t.id] = t; });
      writeArr(TX_KEY, Object.keys(tById).map(function (k) { return tById[k]; }));
    }
    if (Array.isArray(obj.projects)) {
      var curP = allProjects(), pByName = {};
      curP.forEach(function (p) { pByName[p.name] = p; });
      obj.projects.forEach(function (p) { if (p && p.name) pByName[p.name] = p; });
      writeArr(PROJ_KEY, Object.keys(pByName).map(function (k) { return pByName[k]; }));
    }
    return { ok: true, added: obj.experiments.length };
  }

  var api = {
    uuid: uuid,
    hydrateFromDrive: hydrateFromDrive,
    allExperiments: allExperiments, getExperiment: getExperiment,
    saveExperiment: saveExperiment, deleteExperiment: deleteExperiment,
    projects: projects, experimentsInProject: experimentsInProject,
    allProjects: allProjects, getProject: getProject, saveProject: saveProject, deleteProject: deleteProject,
    allTransactions: allTransactions, transactionsForExperiment: transactionsForExperiment,
    addTransactions: addTransactions, removeTransactionsForExperiment: removeTransactionsForExperiment,
    inventoryNet: inventoryNet,
    exportAll: exportAll, importAll: importAll,
    _keys: { EXP_KEY: EXP_KEY, TX_KEY: TX_KEY }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Store = api;
})(typeof window !== 'undefined' ? window : globalThis);

/* ============================================================================
   app.js  —  Main controller. Loads the workbook, renders the sequential Plan
   form (modalities → sample grid → pooling review → per-arm assumptions →
   build), runs the pooling + cost + workflow engines, and populates all tabs.
   ============================================================================ */

(function () {
  'use strict';

  const DATA_URL = 'data/SingleCell_Pipeline_MasterSchema.xlsx';
  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));
  const fmtMoney = (n) => n == null ? '—' : '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });

  let DATA = null;         // parsed workbook
  let LASTPLAN = null;     // last computed plan (for cross-tab reuse)

  // ---- Sample grid state -----------------------------------------------------
  // Core columns are fixed (sampleId, patientId, lineage, cellsAvailable);
  // custom columns are user-added and are candidate confounders. GRID_ROWS is
  // a plain 2D array of strings, aligned to [core..., custom...] column order,
  // so Excel-style paste (which is fundamentally row/col text) is simple.
  const CORE_LEN = 4;
  let CUSTOM_COLS = [];                 // [colName, ...]
  let GRID_ROWS = [];                   // [[sampleId, patientId, lineage, cellsAvailable, ...custom], ...]
  let CONFOUNDER_CHECKED_IDX = new Set(); // indices into CUSTOM_COLS flagged as confounders

  // A reuploaded, user-edited pooling strategy, if any. When present and its
  // sample set matches the grid exactly, it overrides the automatic algorithm.
  let POOL_OVERRIDE = null; // { bySampleId: Map(sampleId -> {pool:0-based, hto, superPool:0-based|null}), hasFullHTO }
  let SAMPLE_NO_OVERRIDE = {}; // { sampleId -> explicit sample number } (set on Modify experiment)
  const LIBSTATUS_OPEN = {};   // which library-status attempt logs are expanded
  let PLAN_INPUT = 'grid'; // 'grid' (real samples) | 'counts' (planning: synthesize from counts)
  let SORT_SEL = new Set((window.Pooling && Pooling.SORT_MODEL) ? Pooling.SORT_MODEL.DEFAULT_ON : ['HSC', 'pDC', 'cDC', 'Treg']);
  let CUSTOM_SORT_POPS = [];   // user-added sort populations
  let SORT_PANEL = [];         // [{channel, marker, ul}] pasted sort antibody panel

  // ---- Two-tier navigation --------------------------------------------------
  // Top tabs are all-project-level. Plan / Record / Review show a left sidebar
  // (project + experiment selector, then step sub-tabs with completion checks).
  const NAV = {
    projects: { panels: [{ id: 'projects', label: 'Project manager' }] },
    calendar: { panels: [{ id: 'calendar', label: 'Calendar' }] },
    handbook: { panels: [{ id: 'handbook', label: 'Handbook' }] },
    inventory: { panels: [{ id: 'inventory', label: 'Inventory' }] },
    plan: { sidebar: true, panels: [
      { id: 'planproject', label: 'Create batch plan' }, { id: 'plan', label: 'Plan experiment' },
      { id: 'modify', label: 'Modify experiment' },
      { id: 'workflow', label: 'Workflow' }, { id: 'protocols', label: 'Protocols' },
      { id: 'scheduling', label: 'Scheduling' },
      { id: 'reagents', label: 'Reagents & cost' } ] },
    record: { sidebar: true, panels: [
      { id: 'rec-freezer', label: 'Freezer Record' },
      { id: 'rec-cellaca', label: 'Cellaca counts' }, { id: 'rec-batchday', label: 'Batch Day Worksheet' },
      { id: 'rec-sort', label: 'Sort summary' },
      { id: 'rec-library', label: 'Library Worksheets' }, { id: 'rec-tapestation', label: 'Tapestation Output' },
      { id: 'rec-supply', label: 'Supply Usage' }, { id: 'rec-seqdata', label: 'Sequencing data' }, { id: 'rec-libstatus', label: 'Library status' }, { id: 'rec-notes', label: 'General notes' } ] },
    review: { sidebar: true, panels: [
      { id: 'rev-design', label: 'Experimental design' }, { id: 'rev-seq', label: 'Sequencing' },
      { id: 'rev-sort', label: 'Sort' }, { id: 'rev-counts', label: 'Counts' },
      { id: 'rev-kits', label: 'Kit and supply usage' }, { id: 'rev-worksheets', label: 'Worksheets' }, { id: 'rev-libstatus', label: 'Library status' }, { id: 'rev-data', label: 'Tapestation' }, { id: 'rev-notes', label: 'General notes' } ] }
  };
  let CUR_TOP = 'projects';

  function panelRenderHook(id) {
    if (id === 'scheduling' && window.Scheduling) Scheduling.render($('#schedulingContent'));
    else if (id === 'plan') refreshBatchLoadControl();
    else if (id === 'modify') renderModify();
    else if (id === 'inventory') renderInventory();
    else if (id === 'projects') renderManage();
    else if (id === 'calendar') renderCalendar();
    else if (id.indexOf('rec-') === 0) renderRecord(id);
    else if (id.indexOf('rev-') === 0) renderReview(id);
  }
  function showPanel(id) {
    $$('.panel').forEach((p) => p.classList.remove('is-active'));
    const el = $('#tab-' + id); if (el) el.classList.add('is-active');
    panelRenderHook(id);
  }
  function markActiveStep(id) { $$('.side-step').forEach((s) => s.classList.toggle('is-active', s.dataset.panel === id)); }
  function updateStepChecks(top) {
    const rec = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    const done = {};
    if (top === 'plan') {
      done.planproject = !!CURRENT_PROJECT; done.plan = !!(rec && rec.snapshot);
      done.workflow = !!(rec && rec.snapshot); done.protocols = !!(rec && rec.snapshot);
      done.scheduling = !!(rec && rec.scheduledAt);
      done.reagents = !!(rec && rec.snapshot);
    }
    $$('.side-check').forEach((c) => c.classList.toggle('done', !!done[c.dataset.check]));
  }
  function renderSidebar(top) {
    const cfg = NAV[top]; const side = $('#sideNav');
    if (!cfg.sidebar) { if (side) side.hidden = true; return; }
    if (side) side.hidden = false;
    syncSideSelectors();
    const steps = $('#sideSteps');
    if (steps) steps.innerHTML = cfg.panels.map((p) => '<button class="side-step" data-panel="' + p.id + '"><span class="side-check" data-check="' + p.id + '"></span><span>' + p.label + '</span></button>').join('');
    updateStepChecks(top);
  }
  function selectTop(top, subId) {
    if (!NAV[top]) top = 'projects';
    CUR_TOP = top;
    $$('.tab').forEach((b) => { const on = b.dataset.top === top; b.classList.toggle('is-active', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    const cfg = NAV[top];
    renderSidebar(top);
    const first = subId || cfg.panels[0].id;
    showPanel(first);
    if (cfg.sidebar) markActiveStep(first);
  }
  window.selectTop = selectTop;

  // Mirror the project/experiment selection into the sidebar selectors.
  function syncSideSelectors() {
    const cur = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    const proj = CURRENT_PROJECT || (cur && cur.project) || '';   // explicit project wins
    const psel = $('#sideProjectSel'), esel = $('#sideExperimentSel');
    if (psel) {
      const names = Store.allProjects().map((p) => p.name).filter(Boolean);
      Store.allExperiments().forEach((e) => { if (e.project && names.indexOf(e.project) < 0) names.push(e.project); });
      names.sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1);
      psel.innerHTML = '<option value="">\u2014 select project \u2014</option>' + names.map((n) => '<option value="' + escAttr(n) + '"' + (n === proj ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
    }
    if (esel) {
      const exps = Store.allExperiments().filter((e) => (e.project || '') === proj);
      const selId = (cur && (cur.project || '') === proj) ? CURRENT_EXP_ID : '';   // only keep if it belongs to this project
      esel.innerHTML = '<option value="">\u2014 select experiment \u2014</option>' + exps.map((e) => '<option value="' + e.id + '"' + (e.id === selId ? ' selected' : '') + '>' + esc(e.name || 'experiment') + '</option>').join('');
    }
  }

  function initTabs() {
    $$('.tab').forEach((btn) => { btn.addEventListener('click', () => selectTop(btn.dataset.top)); });
    const steps = $('#sideSteps');
    if (steps) steps.addEventListener('click', (e) => {
      const b = e.target.closest('.side-step'); if (!b) return;
      showPanel(b.dataset.panel); markActiveStep(b.dataset.panel);
    });
    const sp = $('#sideProjectSel'), se = $('#sideExperimentSel');
    if (sp) sp.addEventListener('change', () => {
      CURRENT_PROJECT = sp.value || null; CURRENT_EXP_ID = null;
      EXPANDED_PROJECTS = {}; if (CURRENT_PROJECT) EXPANDED_PROJECTS[CURRENT_PROJECT] = true; EXPANDED_EXPERIMENTS = {};
      updatePlanExpBar(); updateContextBar(); renderManage(); syncSideSelectors(); updateStepChecks(CUR_TOP);
    });
    if (se) se.addEventListener('change', () => {
      const id = se.value;
      if (!id) { CURRENT_EXP_ID = null; updatePlanExpBar(); syncSideSelectors(); updateStepChecks(CUR_TOP); return; }
      const wasTop = CUR_TOP; const activeStep = document.querySelector('.side-step.is-active'); const wasStep = activeStep ? activeStep.dataset.panel : null;
      openExperiment(id);                       // restores the saved plan/state (jumps to Plan)
      if (wasTop !== 'plan') selectTop(wasTop, wasStep);   // return to Record/Review if that's where we were
      else if (wasStep) { markActiveStep(wasStep); showPanel(wasStep); }
      syncSideSelectors(); updateStepChecks(CUR_TOP);
    });
  }

  // Placeholder renderers for the new Record / Review / Calendar pages.
  function stubPage(elId, title, blurb) {
    const el = $('#' + elId); if (!el) return;
    el.innerHTML = '<div class="wrap"><h2>' + esc(title) + '</h2><div class="callout info">' + esc(blurb) + '</div></div>';
  }
  const REC_STUBS = {
    'rec-freezer': ['recFreezerContent', 'Freezer Record', 'Track sample storage moves here: samples moved to a temporary batch box, removed from the LN2 tank, and library/cDNA storage locations logged into the official freezer record. Coming soon \u2014 this will confirm each sample\u2019s chain of custody from LN2 \u2192 batch box \u2192 freezer.'],
    'rec-cellaca': ['recCellacaContent', 'Cellaca counts', 'Record cell-count readouts from the Cellaca here (per sample: live %, cells/mL). Coming soon \u2014 this will feed the Cell count sheet automatically.'],
    'rec-batchday': ['recBatchdayContent', 'Batch Day Worksheet', 'Log the batch-day timeline and per-step notes here. Coming soon.'],
    'rec-library': ['recLibraryContent', 'Library Worksheets', 'Enter per-library prep details (volumes, indexes used, yields). Coming soon.'],
    'rec-tapestation': ['recTapestationContent', 'Tapestation Output', 'Attach or enter TapeStation traces and sizing per library. Coming soon.'],
    'rec-supply': ['recSupplyContent', 'Supply Usage', 'Record actual kit / reagent / tip usage for this experiment. Coming soon \u2014 will reconcile against Inventory.'],
    'rec-seqdata': ['recSeqdataContent', 'Sequencing data', 'Enter sequencing run info and data paths. Coming soon.']
  };
  const REV_STUBS = {
    'rev-design': ['revDesignContent', 'Experimental design', 'A read-only view of the batching / pooling plan and the pipeline cell-flow figure for the chosen plan. Coming soon.'],
    'rev-seq': ['revSeqContent', 'Sequencing', 'Chosen sequencing depths and a summary of libraries generated per modality. Coming soon.'],
    'rev-kits': ['revKitsContent', 'Kit and supply usage', 'Summary of cost and kit / supply usage for the project or experiment. Coming soon.'],
    'rev-data': ['revDataContent', 'Data', 'Concentrations and TapeStation traces for every library, plus paths to stored data. Coming soon.']
  };
  function renderRecord(id) {
    if (id === 'rec-supply') { renderSupplyUsage(); return; }
    if (id === 'rec-cellaca') { renderCellaca(); return; }
    if (id === 'rec-tapestation') { renderTapestation(); return; }
    if (id === 'rec-sort') { renderSortRecord(); return; }
    if (id === 'rec-batchday') { renderWorksheet('batchday'); return; }
    if (id === 'rec-library') { renderWorksheet('library'); return; }
    if (id === 'rec-notes') { renderNotes(); return; }
    if (id === 'rec-libstatus') { renderLibStatus('recLibStatusContent', true); return; }
    const s = REC_STUBS[id]; if (s) stubPage(s[0], s[1], s[2]);
  }

  // ===== Worksheet recorder: capture the fill-in tables from the batch-day (ASAP)
  // and library (5') worksheets \u2014 kit lots + rxns used, cell counts, key metrics,
  // and notes. Stored on the record + a durable Drive companion sheet. =====
  const QUBIT_TABLES = [
    { key: 'cdna5', title: "5' cDNA" },
    { key: 'tcrbcr', title: 'TCR / BCR initial amplification' },
    { key: 'final5', title: "Final 5' libraries (GEX, ADT, TCR/BCR)" },
    { key: 'finalasap', title: 'Final ASAP libraries (ATAC, ADT, HTO)' }
  ];
  const WORKSHEET_CFG = {
    batchday: { title: 'Batch Day Worksheet', host: 'recBatchdayContent',
      kits: [['Chromium Next GEM Single Cell ATAC Library Kit v2', ''], ['Chromium Next GEM Single Cell ATAC Gel Bead Kit v2', ''], ['Chromium Next GEM Chip H Single Cell Kit', ''], ['Single Index Kit N Set A, 96 rxns', 'PN-1000212']],
      countCols: ['Tube / population', 'Total vol (µL)', 'Count', 'Total cell # (count×vol)', 'Dilution', 'Final conc (nuclei/µL)'] },
    library: { title: 'Library Worksheets', host: 'recLibraryContent',
      kits: [["Single Cell 5' GEM Kit v3", ''], ['Library Construction Kit C', ''], ["Single Cell 5' Gel Bead Kit v3", ''], ["GEM-X 5' Feature Barcode Kit v3, 16 rxns", 'PN-1000703'], ["GEM-X 5' Chip Kit v3, 4 chips", 'PN-1000698'], ['Dual Index Kit TT Set A, 96 rxns', 'PN-1000215'], ['Dual Index Kit TN Set A, 96 rxns', 'PN-1000250'], ['Single Cell Human TCR Amplification, 16 rxns', 'PN-1000252'], ['Single Cell Human BCR Amplification, 16 rxns', 'PN-1000253']],
      countCols: ['Population', 'Tube label', 'Total vol (µL)', 'Total count', 'Viability', 'Live count', 'Total live cell #', 'Dilution', 'Final conc (cells/µL)'] }
  };
  function getWorksheet(rec, type) {
    rec.worksheets = rec.worksheets || {};
    if (!rec.worksheets[type]) {
      const cfg = WORKSHEET_CFG[type];
      rec.worksheets[type] = { expId: rec.experimentId || '', operator: '', date: '', notes: '',
        kits: cfg.kits.map((k) => ({ kit: k[0], pn: k[1], lot: '', rxns: '', notes: '' })),
        counts: [cfg.countCols.map(() => '')], qubit: { cdna5: [['', '', '']], tcrbcr: [['', '', '']], final5: [['', '', '']], finalasap: [['', '', '']] } };
    }
    return rec.worksheets[type];
  }
  function renderWorksheet(type) {
    const cfg = WORKSHEET_CFG[type]; const host = $('#' + cfg.host); if (!host) return;
    const rec = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    if (!rec) { host.innerHTML = '<h2>' + esc(cfg.title) + '</h2><p class="empty">Select a project and experiment in the sidebar first.</p>'; return; }
    const w = getWorksheet(rec, type);
    const kitRows = w.kits.map((k, i) => '<tr><td>' + esc(k.kit) + '</td><td class="who">' + esc(k.pn || '') + '</td>'
      + '<td><input class="ws-lot" data-i="' + i + '" value="' + escAttr(k.lot || '') + '" style="width:120px"></td>'
      + '<td><input class="ws-rxns" data-i="' + i + '" value="' + escAttr(k.rxns || '') + '" style="width:70px"></td>'
      + '<td><input class="ws-knote" data-i="' + i + '" value="' + escAttr(k.notes || '') + '" style="width:150px"></td></tr>').join('');
    const cHead = cfg.countCols.map((c) => '<th>' + esc(c) + '</th>').join('');
    const cRows = w.counts.map((row, ri) => '<tr>' + cfg.countCols.map((c, ci) => '<td><input class="ws-cnt" data-r="' + ri + '" data-c="' + ci + '" value="' + escAttr(row[ci] || '') + '" style="width:90px"></td>').join('') + '<td><button class="btn tiny" data-ws-delrow="' + ri + '">\u2715</button></td></tr>').join('');
    host.innerHTML = '<h2>' + esc(cfg.title) + ' <span class="who">' + esc(rec.name || '') + '</span></h2>'
      + '<div class="row-actions" style="margin:0 0 10px"><button class="btn ghost" id="wsReload">Reload from Drive</button><span id="wsReloadStatus" class="muted"></span></div>'
      + '<p class="step-hint">Enter the values written on the paper worksheet. Saved to the experiment and to a durable <strong>data \u203a worksheets</strong> sheet in Drive, and surfaced in Review.</p>'
      + '<div class="row-actions" style="margin:6px 0"><label>Experiment ID <input id="wsExpId" style="width:120px" value="' + escAttr(w.expId || '') + '"></label> <label>Operator <input id="wsOperator" style="width:140px" value="' + escAttr(w.operator || '') + '"></label> <label>Date <input id="wsDate" style="width:120px" value="' + escAttr(w.date || '') + '"></label></div>'
      + '<h3>10X kit lots &amp; rxns used</h3><table class="cost-table"><thead><tr><th>10X kit</th><th>PN</th><th>Lot #</th><th>Rxns used</th><th>Notes</th></tr></thead><tbody>' + kitRows + '</tbody></table>'
      + '<h3 style="margin-top:18px">Cell counts &amp; dilution</h3><div style="overflow:auto"><table class="cost-table"><thead><tr>' + cHead + '<th></th></tr></thead><tbody>' + cRows + '</tbody></table></div>'
      + '<div class="row-actions" style="margin:6px 0"><button class="btn ghost" id="wsAddRow">+ Add count row</button></div>'
      + (type === 'library' ? (function () {
          const qc = ['Tube ID', 'Qubit dilution', 'Qubit conc (ng/µL)'];
          if (!w.qubit || Array.isArray(w.qubit)) { const old = Array.isArray(w.qubit) ? w.qubit : []; w.qubit = { cdna5: old.length ? old.map((r) => [r[0] || '', r[1] || '', r[2] || '']) : [['', '', '']], tcrbcr: [['', '', '']], final5: [['', '', '']], finalasap: [['', '', '']] }; }
          return QUBIT_TABLES.map((qt) => {
            const rowsQ = w.qubit[qt.key] && w.qubit[qt.key].length ? w.qubit[qt.key] : (w.qubit[qt.key] = [['', '', '']]);
            const body = rowsQ.map((row, ri) => '<tr>' + qc.map((c, ci) => '<td><input class="ws-qb" data-qt="' + qt.key + '" data-r="' + ri + '" data-c="' + ci + '" value="' + escAttr(row[ci] || '') + '" style="width:130px"></td>').join('') + '<td><button class="btn tiny" data-ws-qdel="' + qt.key + '|' + ri + '">\u2715</button></td></tr>').join('');
            return '<h3 style="margin-top:18px">Qubit \u2014 ' + esc(qt.title) + '</h3><div style="overflow:auto"><table class="cost-table"><thead><tr>' + qc.map((c) => '<th>' + esc(c) + '</th>').join('') + '<th></th></tr></thead><tbody>' + body + '</tbody></table></div>'
              + '<div class="row-actions" style="margin:6px 0"><button class="btn ghost" data-ws-qadd="' + qt.key + '">+ Add row</button></div>';
          }).join('');
        })() : '')
      + '<h3 style="margin-top:18px">Notes</h3><textarea id="wsNotes" style="width:100%;min-height:80px">' + esc(w.notes || '') + '</textarea>'
      + '<div class="row-actions" style="margin-top:12px"><button class="btn primary" id="wsSave">Save worksheet</button><span id="wsStatus" class="muted"></span></div>';
    // wiring
    const bind = (id, key) => { const el = $('#' + id); if (el) el.addEventListener('input', () => { w[key] = el.value; }); };
    bind('wsExpId', 'expId'); bind('wsOperator', 'operator'); bind('wsDate', 'date'); bind('wsNotes', 'notes');
    host.querySelectorAll('.ws-lot').forEach((el) => el.addEventListener('input', () => { w.kits[+el.dataset.i].lot = el.value; }));
    host.querySelectorAll('.ws-rxns').forEach((el) => el.addEventListener('input', () => { w.kits[+el.dataset.i].rxns = el.value; }));
    host.querySelectorAll('.ws-knote').forEach((el) => el.addEventListener('input', () => { w.kits[+el.dataset.i].notes = el.value; }));
    host.querySelectorAll('.ws-cnt').forEach((el) => el.addEventListener('input', () => { w.counts[+el.dataset.r][+el.dataset.c] = el.value; }));
    const addRow = $('#wsAddRow'); if (addRow) addRow.addEventListener('click', () => { w.counts.push(cfg.countCols.map(() => '')); renderWorksheet(type); });
    host.querySelectorAll('button[data-ws-delrow]').forEach((b) => b.addEventListener('click', () => { w.counts.splice(+b.dataset.wsDelrow, 1); if (!w.counts.length) w.counts.push(cfg.countCols.map(() => '')); renderWorksheet(type); }));
    host.querySelectorAll('.ws-qb').forEach((el) => el.addEventListener('input', () => { w.qubit[el.dataset.qt][+el.dataset.r][+el.dataset.c] = el.value; }));
    host.querySelectorAll('button[data-ws-qadd]').forEach((b) => b.addEventListener('click', () => { const k = b.dataset.wsQadd; (w.qubit[k] = w.qubit[k] || []).push(['', '', '']); renderWorksheet(type); }));
    host.querySelectorAll('button[data-ws-qdel]').forEach((b) => b.addEventListener('click', () => { const p = b.dataset.wsQdel.split('|'); const k = p[0], ri = +p[1]; w.qubit[k].splice(ri, 1); if (!w.qubit[k].length) w.qubit[k].push(['', '', '']); renderWorksheet(type); }));
    const save = $('#wsSave'); if (save) save.addEventListener('click', () => saveWorksheet(rec, type));
    const reload = $('#wsReload'); if (reload) reload.addEventListener('click', () => reloadWorksheetFromDrive(rec, type));
  }
  function saveWorksheet(rec, type) {
    const cfg = WORKSHEET_CFG[type]; const w = getWorksheet(rec, type);
    const stEl = $('#wsStatus'); if (stEl) stEl.textContent = ' Saving\u2026';
    Store.saveExperiment(rec);   // record-stored (small text, syncs safely)
    // durable Drive companion sheet
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Experiment ID', w.expId || ''], ['Operator', w.operator || ''], ['Date', w.date || ''], ['Notes', w.notes || '']]), 'Info');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['10X kit', 'PN', 'Lot #', 'Rxns used', 'Notes']].concat(w.kits.map((k) => [k.kit, k.pn, k.lot, k.rxns, k.notes]))), 'Kit lots');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cfg.countCols].concat(w.counts)), 'Cell counts');
    if (w.qubit && !Array.isArray(w.qubit)) { QUBIT_TABLES.forEach((qt) => { const rowsQ = (w.qubit[qt.key] || []).filter((r) => r.some((c) => c !== '')); if (rowsQ.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Tube ID', 'Qubit dilution', 'Qubit conc (ng/µL)']].concat(rowsQ)), ('Qubit ' + qt.title).slice(0, 31)); }); }
    const b64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
    const expId2 = rec.experimentId || projectLabel(rec.name || 'experiment');
    const req = rec.driveFolderId ? { action: 'ensurePath', parentId: rec.driveFolderId, subPath: ['data', 'worksheets'] } : { action: 'ensurePath', project: rec.project || CURRENT_PROJECT, experiment: rec.name || 'Experiment', subPath: ['data', 'worksheets'] };
    driveApi(req)
      .then((path) => { if (path && path.experimentId && rec.driveFolderId !== path.experimentId) { rec.driveFolderId = path.experimentId; }
        if (!path || !path.subId) throw new Error('could not reach data/worksheets'); return driveApi({ action: 'upload', name: sanitizeName(expId2 + ' ' + type + ' worksheet'), folderId: path.subId, base64: b64, sourceMime: XLSX_MIME, targetMime: GSHEET_MIME }); })
      .then(() => { if (stEl) stEl.textContent = ' Saved to the experiment and Drive.'; })
      .catch((e) => { if (stEl) stEl.textContent = ' Saved to the experiment. Drive save failed: ' + e; });
  }
  function reloadWorksheetFromDrive(rec, type) {
    const stEl = $('#wsReloadStatus'); if (stEl) stEl.textContent = ' Reading Drive\u2026';
    const req = rec.driveFolderId ? { action: 'getWorksheet', parentId: rec.driveFolderId, type: type } : { action: 'getWorksheet', project: rec.project || CURRENT_PROJECT, experiment: rec.name || 'Experiment', type: type };
    driveApi(req).then((res) => {
      if (!res || !res.ok || !res.worksheet) { if (stEl) stEl.textContent = ' No worksheet found in Drive.'; return; }
      rec.worksheets = rec.worksheets || {}; rec.worksheets[type] = res.worksheet; Store.saveExperiment(rec);
      if (stEl) stEl.textContent = ' Loaded from Drive.'; renderWorksheet(type);
    }).catch((e) => { if (stEl) stEl.textContent = ' Reload failed: ' + e; });
  }

  // ===== TapeStation: drag-drop a run .zip, tag it with the experiment part,
  // edit lane names / dilutions / notes, store to Drive + on the record. =====
  const TS_ARMS = {
    'ASAP': { prefix: 'A', types: ['ATAC', 'ADT', 'HTO'] },
    "5' unsort": { prefix: 'U', types: ['GEX', 'TCR', 'BCR', 'ADT/CSP', 'HTO'] },
    "5' sort": { prefix: 'S', types: ['GEX', 'TCR', 'BCR', 'ADT/CSP'] },
    'cDNA': { prefix: 'C', types: ['cDNA'] },
    'Other': { prefix: '', types: ['GEX', 'ATAC', 'HTO', 'ADT', 'TCR', 'BCR', 'cDNA'] }
  };
  const TS_ARM_NAMES = Object.keys(TS_ARMS);
  // Trace images are large (a single PNG can be ~100k base64 chars). They must NOT
  // live on the experiment record (which syncs to a Sheet cell, ~50k limit), so we
  // keep them in a device-local store keyed by experiment/run/well.
  function tsImgKey(expId, run, well) { return (expId || '') + '|' + (run || '') + '|' + (well || ''); }
  function tsImgStoreGet() { try { return JSON.parse(localStorage.getItem('sc_ts_images') || '{}'); } catch (e) { return {}; } }
  function tsImgStoreSet(m) { try { localStorage.setItem('sc_ts_images', JSON.stringify(m)); return true; } catch (e) { return false; } }
  function tsSetImg(key, b64) { if (!key || !b64) return; const m = tsImgStoreGet(); m[key] = b64; tsImgStoreSet(m); }
  function tsGetImg(w) { if (w && w.imgKey) { const v = tsImgStoreGet()[w.imgKey]; if (v) return v; } return (w && w.img) || null; }
  // Prefer the Drive-served image (shared across devices); fall back to any local cache.
  function tsGetImgSrc(w) {
    if (w && w.imgFileId) return '/api/tsimage?fileId=' + encodeURIComponent(w.imgFileId);
    const im = tsGetImg(w);
    return im ? ('data:image/png;base64,' + im) : '';
  }
  // One-time migration: move any base64 images off existing records into the local
  // store, so the (now small) records sync cleanly again.
  function healExperimentBlobs() {
    try {
      (Store.allExperiments() || []).forEach((rec) => {
        let changed = false;
        (rec.tapestation || []).forEach((run) => (run.wells || []).forEach((w) => {
          if (w.img && w.img.length > 200) { const key = tsImgKey(rec.id, run.runName, w.well); tsSetImg(key, w.img); w.imgKey = key; delete w.img; changed = true; }
        }));
        if (changed) Store.saveExperiment(rec);   // re-sync the now-small record
      });
    } catch (e) { /* best-effort */ }
  }
  // Guess { arm, type, no } from a TapeStation sample description, e.g. "BCP-1 ASAP ATAC A9 1:5".
  function tsGuessTags(desc) {
    const d = (desc || '').toUpperCase();
    // sample number + its letter prefix from the lane/tube label (e.g. U1, A9, S3, C1)
    const lane = d.match(/\b([AUSC])(\d+)\b/);
    let arm = '';
    if (/ASAP/.test(d)) arm = 'ASAP';
    else if (/UNSORT/.test(d)) arm = "5' unsort";
    else if (/SORT/.test(d)) arm = "5' sort";
    else if (/CDNA/.test(d)) arm = 'cDNA';
    else if (lane) arm = { A: 'ASAP', U: "5' unsort", S: "5' sort", C: 'cDNA' }[lane[1]] || '';   // fall back to the label prefix
    let type = '';
    if (/ATAC/.test(d)) type = 'ATAC';
    else if (/HTO/.test(d)) type = 'HTO';
    else if (/ADT|CSP/.test(d)) type = (arm === 'ASAP' ? 'ADT' : 'ADT/CSP');
    else if (/GEX/.test(d)) type = 'GEX';
    else if (/\bTCR\b/.test(d)) type = 'TCR';
    else if (/\bBCR\b/.test(d)) type = 'BCR';
    else if (/CDNA/.test(d)) type = 'cDNA';
    // (generic "VDJ" with no TCR/BCR is left blank so the user picks)
    return { arm: arm, type: type, no: lane ? lane[2] : '' };
  }
  // Full lane label, e.g. "ASAP A9-ATAC".
  function tsLaneName(w) {
    const a = TS_ARMS[w.arm]; const prefix = a ? a.prefix : '';
    const lane = (w.sampleNo != null && w.sampleNo !== '') ? (prefix + w.sampleNo) : '';
    const parts = [];
    if (w.arm) parts.push(w.arm);
    if (lane) parts.push(lane + (w.sampleType ? '-' + w.sampleType : ''));
    else if (w.sampleType) parts.push(w.sampleType);
    return parts.join(' ') || (w.description || w.well);
  }
  let TS_PENDING = null;   // { fileName, base64(zip), runName, part, notes, wells:[{well,description,name,conc,dilution,note,img}] }
  function parseCsvText(text) {
    const rows = []; let i = 0, field = '', row = [], inQ = false;
    while (i < text.length) { const ch = text[i];
      if (inQ) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += ch; }
      else { if (ch === '"') inQ = true; else if (ch === ',') { row.push(field); field = ''; } else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; } else field += ch; }
      i++; }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.length && r.some((c) => c !== ''));
  }
  // Collect files from a drop, traversing folders (dragging the run folder itself
  // doesn't populate dataTransfer.files, so walk the directory entries).
  async function filesFromDataTransfer(dt) {
    const items = dt.items;
    if (items && items.length && items[0] && items[0].webkitGetAsEntry) {
      const roots = []; for (let i = 0; i < items.length; i++) { const e = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry(); if (e) roots.push(e); }
      if (roots.length) {
        const out = [];
        const walk = async (entry) => {
          if (entry.isFile) { await new Promise((res) => entry.file((f) => { out.push(f); res(); }, res)); }
          else if (entry.isDirectory) { const rd = entry.createReader(); let batch; do { batch = await new Promise((res) => rd.readEntries(res, () => res([]))); for (const e of batch) await walk(e); } while (batch.length); }
        };
        for (const r of roots) await walk(r);
        if (out.length) return out;
      }
    }
    return Array.prototype.slice.call(dt.files || []);
  }
  function tsGuessMime(name) {
    const n = name.toLowerCase();
    if (n.endsWith('.pdf')) return 'application/pdf';
    if (n.endsWith('.png')) return 'image/png';
    if (n.endsWith('.csv')) return 'text/csv';
    if (n.endsWith('.zip')) return 'application/zip';
    if (n.endsWith('.xlsx')) return XLSX_MIME;
    return 'application/octet-stream';
  }
  function tsParseSampleTable(csvText) {
    const rows = parseCsvText(csvText);
    if (!rows.length) return [];
    const hdr = rows[0].map((h) => h.toLowerCase());
    const iWell = hdr.findIndex((h) => h === 'well'), iConc = hdr.findIndex((h) => h.indexOf('conc') === 0), iDesc = hdr.findIndex((h) => h.indexOf('sample description') === 0);
    const wells = [];
    rows.slice(1).forEach((r) => {
      const well = (r[iWell] || '').trim(); const desc = (r[iDesc] || '').trim();
      if (!well || /ladder/i.test(desc)) return;   // skip the ladder well
      wells.push({ well: well, description: desc, name: desc, conc: iConc >= 0 ? (r[iConc] || '').trim() : '', dilution: '', note: '' });
    });
    return wells;
  }
  function bufToB64(buf) { let bin = ''; const u8 = new Uint8Array(buf); for (let k = 0; k < u8.length; k++) bin += String.fromCharCode(u8[k]); return btoa(bin); }
  // Per-peak table: each peak's Calibrated Conc is its region-weighted concentration,
  // so summing peaks in a bp range gives the concentration over that range.
  function tsParsePeaks(csvText) {
    const rows = parseCsvText(csvText); if (!rows.length) return {};
    const hdr = rows[0].map((h) => h.toLowerCase());
    const iWell = hdr.findIndex((h) => h === 'well');
    const iSize = hdr.findIndex((h) => h.indexOf('size') === 0);
    const iConc = hdr.findIndex((h) => h.indexOf('calibrated conc') === 0);
    const iObs = hdr.findIndex((h) => h.indexOf('observation') >= 0);
    const byWell = {};
    rows.slice(1).forEach((r) => {
      const well = (r[iWell] || '').trim(); if (!well) return;
      const size = parseFloat(r[iSize]); const conc = parseFloat(r[iConc]);
      const marker = /marker/i.test(iObs >= 0 ? (r[iObs] || '') : '');
      if (isNaN(size)) return;
      (byWell[well] = byWell[well] || []).push({ size: size, conc: isNaN(conc) ? 0 : conc, marker: marker });
    });
    return byWell;
  }
  function tsDilFactor(dil) {
    const s = String(dil || '').trim();
    const m = s.match(/1\s*[:/]\s*([\d.]+)/); if (m) return parseFloat(m[1]) || 1;
    const n = parseFloat(s); return (!isNaN(n) && n > 0) ? n : 1;
  }
  // Region concentration (sum of non-marker peaks in [min,max]) + conc-weighted avg bp.
  function tsRegion(peaks, minBp, maxBp) {
    const inR = (peaks || []).filter((p) => !p.marker && (minBp == null || p.size >= minBp) && (maxBp == null || p.size <= maxBp));
    const conc = inR.reduce((s, p) => s + p.conc, 0);
    const wsize = inR.reduce((s, p) => s + p.size * p.conc, 0);
    return { conc: conc, avgBp: conc > 0 ? Math.round(wsize / conc) : null, n: inR.length };
  }

  async function handleTsZip(file) {
    if (!window.JSZip) { alert('Zip reader not loaded \u2014 reload the page and try again.'); return; }
    const buf = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);
    let sampleCsv = null, peakCsv = null; const imgs = {};
    const names = Object.keys(zip.files);
    for (const n of names) { const base = n.split('/').pop();
      if (/sampletable\.csv$/i.test(base)) sampleCsv = await zip.files[n].async('string');
      else if (/compactpeaktable\.csv$/i.test(base)) peakCsv = await zip.files[n].async('string');
      else if (/\.png$/i.test(base)) { const m = base.match(/_([A-H]\d{1,2})_/); if (m) imgs[m[1]] = await zip.files[n].async('base64'); }
    }
    const wells = sampleCsv ? tsParseSampleTable(sampleCsv) : [];
    const peaks = peakCsv ? tsParsePeaks(peakCsv) : {};
    wells.forEach((w) => { w.img = imgs[w.well] || null; w.peaks = peaks[w.well] || []; const g = tsGuessTags(w.description); w.arm = g.arm; w.sampleType = g.type; w.sampleNo = g.no; w.name = tsLaneName(w); });
    const runName = file.name.replace(/\.zip$/i, '');
    // the whole zip is stored/uploaded as one file
    TS_PENDING = { fileName: file.name, files: [{ name: file.name, base64: bufToB64(buf), mime: 'application/zip' }], runName: runName, notes: '', wells: wells };
    if (!wells.length) alert('Zip uploaded, but no sampleTable.csv was found \u2014 you can still save it (no per-lane summary).');
    renderTapestation();
  }

  // Loose files (any mix of sampleTable.csv, per-well .png traces, and .pdf summaries),
  // one or many. A single .zip is delegated to the zip reader.
  async function handleTsFiles(fileList) {
    const files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    if (files.length === 1 && /\.zip$/i.test(files[0].name)) return handleTsZip(files[0]);
    let sampleCsv = null, peakCsv = null; const imgs = {}; const stored = []; let runName = '';
    for (const f of files) {
      const buf = await f.arrayBuffer(); const u8 = new Uint8Array(buf); const b64 = bufToB64(buf);
      stored.push({ name: f.name, base64: b64, mime: f.type || tsGuessMime(f.name) });
      if (/sampletable\.csv$/i.test(f.name)) sampleCsv = new TextDecoder('latin1').decode(u8);
      else if (/compactpeaktable\.csv$/i.test(f.name)) peakCsv = new TextDecoder('latin1').decode(u8);
      else if (/\.png$/i.test(f.name)) { const m = f.name.match(/_([A-H]\d{1,2})_/); if (m) imgs[m[1]] = b64; }
      if (!runName) runName = f.name.replace(/\.(csv|png|pdf|xlsx?|zip)$/i, '').replace(/[ _]*(sampleTable|compactPeakTable|Electropherogram|[A-H]\d.*)$/i, '').trim();
    }
    const wells = sampleCsv ? tsParseSampleTable(sampleCsv) : [];
    const peaks = peakCsv ? tsParsePeaks(peakCsv) : {};
    wells.forEach((w) => { w.img = imgs[w.well] || null; w.peaks = peaks[w.well] || []; const g = tsGuessTags(w.description); w.arm = g.arm; w.sampleType = g.type; w.sampleNo = g.no; w.name = tsLaneName(w); });
    TS_PENDING = { fileName: files.length === 1 ? files[0].name : (files.length + ' files'), files: stored, runName: runName || 'TapeStation run', notes: '', wells: wells };
    if (!wells.length) alert('Files added' + (Object.keys(imgs).length ? '' : ' \u2014 no sampleTable.csv found, so there\u2019s no per-lane summary') + '. You can still tag the part/notes and save (e.g. to archive a PDF).');
    renderTapestation();
  }
  function renderTapestation() {
    const host = $('#recTapestationContent'); if (!host) return;
    const rec = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    if (!rec) { host.innerHTML = '<h2>Tapestation Output</h2><p class="empty">Select a project and experiment in the sidebar first.</p>'; return; }
    const runs = rec.tapestation || [];
    const runList = runs.length
      ? '<h3>Saved runs (' + runs.length + ')</h3><table class="cost-table"><thead><tr><th>Run</th><th>Sections</th><th class="num">Lanes</th><th>Notes</th><th></th></tr></thead><tbody>'
        + runs.map((r, i) => { const secs = []; (r.wells || []).forEach((w) => { if (w.arm && secs.indexOf(w.arm) < 0) secs.push(w.arm); });
          return '<tr><td>' + esc(r.runName || '') + '</td><td>' + esc(secs.join(', ') || r.part || '') + '</td><td class="num">' + (r.wells || []).length + '</td><td class="who">' + esc(r.notes || '') + '</td><td><button class="btn tiny" data-ts-del="' + i + '">\u2715</button></td></tr>'; }).join('')
        + '</tbody></table>'
      : '<p class="muted">No TapeStation runs saved yet.</p>';

    let editUI = '';
    if (TS_PENDING) {
      const armOptions = (sel) => TS_ARM_NAMES.map((a) => '<option' + (sel === a ? ' selected' : '') + '>' + esc(a) + '</option>').join('');
      const typeOptions = (arm, sel) => { const t = (TS_ARMS[arm] && TS_ARMS[arm].types) || []; return '<option value="">\u2014</option>' + t.map((x) => '<option' + (sel === x ? ' selected' : '') + '>' + esc(x) + '</option>').join(''); };
      const noOptions = (sel) => { let o = '<option value="">\u2014</option>'; for (let k = 1; k <= 24; k++) o += '<option' + (String(sel) === String(k) ? ' selected' : '') + '>' + k + '</option>'; return o; };
      const rows = TS_PENDING.wells.map((w, i) => '<tr><td class="num">' + esc(w.well) + '</td>'
        + '<td class="who">' + esc(w.description || '') + '</td>'
        + '<td><select class="ts-arm" data-i="' + i + '">' + armOptions(w.arm) + '</select></td>'
        + '<td><select class="ts-type" data-i="' + i + '">' + typeOptions(w.arm, w.sampleType) + '</select></td>'
        + '<td><select class="ts-no" data-i="' + i + '">' + noOptions(w.sampleNo) + '</select></td>'
        + '<td class="who">' + esc(tsLaneName(w)) + '</td>'
        + '<td class="num">' + esc(w.conc) + '</td>'
        + '<td><input class="ts-dil" data-i="' + i + '" value="' + escAttr(w.dilution) + '" placeholder="e.g. 1:5" style="width:70px"></td>'
        + '<td><input class="ts-note" data-i="' + i + '" value="' + escAttr(w.note) + '" placeholder="notes" style="width:130px"></td>'
        + '<td>' + (w.img ? '<img src="data:image/png;base64,' + w.img + '" style="height:38px;border:1px solid #e4e9ef;border-radius:4px">' : '') + '</td></tr>').join('');
      editUI = '<h3>This run <span class="who">' + esc(TS_PENDING.fileName) + '</span></h3>'
        + '<div class="row-actions" style="margin:6px 0"><label>Run notes <input id="tsNotes" style="width:300px" value="' + escAttr(TS_PENDING.notes) + '"></label></div>'
        + '<p class="step-hint">Tag each lane: <strong>experimental section</strong> \u2192 <strong>sample type</strong> \u2192 <strong>sample #</strong> (auto-filled from the descriptions where possible). The full ID (e.g. \u201cASAP A9-ATAC\u201d) is built from those. Enter the dilution used and any notes.</p>'
        + '<div style="overflow:auto"><table class="cost-table"><thead><tr><th>Well</th><th>Original name (from file)</th><th>Section</th><th>Type</th><th>Sample #</th><th>Full ID</th><th class="num">Conc [pg/\u00b5l]</th><th>Dilution</th><th>Notes</th><th>Trace</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        + '<div class="row-actions" style="margin-top:12px"><button class="btn primary" id="tsSave">Save run + upload to Drive</button> <button class="btn ghost" id="tsCancel">Cancel</button></div>'
        + '<div id="tsStatus" class="muted" style="margin-top:8px"></div>';
    }

    host.innerHTML = '<h2>Tapestation Output <span class="who">' + esc(rec.name || '') + '</span></h2>'
      + '<p class="step-hint">Drag a TapeStation run <strong>.zip</strong>, or its <strong>loose files</strong> (sampleTable.csv, the .png traces, and/or the .pdf summary) \u2014 one or many at once. It reads the concentration summary + traces where present, and stores everything (plus a durable <strong>lane-tags sheet</strong>) in the experiment\u2019s <strong>data \u203a tapestation</strong> folder.</p>'
      + '<div class="row-actions" style="margin:0 0 10px"><button class="btn ghost" id="tsReload">Reload tags from Drive</button><button class="btn ghost" id="tsBackfill">Backfill trace images to Drive</button><span id="tsReloadStatus" class="muted"></span></div>'
      + '<div id="tsDrop" class="cc-drop">Drop a .zip, or the run\u2019s .csv / .png / .pdf files here (multiple ok), or click to browse<input type="file" id="tsFile" accept=".zip,.csv,.png,.pdf,.xlsx" multiple hidden></div>'
      + editUI + '<div style="margin-top:20px"></div>' + runList;

    const drop = $('#tsDrop'), fileInput = $('#tsFile');
    const onFiles = (fl) => { if (fl && fl.length) handleTsFiles(fl).catch((e) => alert('Could not read those files: ' + e)); };
    if (drop) {
      drop.addEventListener('click', () => fileInput && fileInput.click());
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
      drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); filesFromDataTransfer(e.dataTransfer).then((fs) => onFiles(fs)); });
    }
    if (fileInput) fileInput.addEventListener('change', () => onFiles(fileInput.files));
    const notesInp = $('#tsNotes'); if (notesInp) notesInp.addEventListener('input', () => { TS_PENDING.notes = notesInp.value; });
    host.querySelectorAll('.ts-arm').forEach((el) => el.addEventListener('change', () => { const w = TS_PENDING.wells[+el.dataset.i]; w.arm = el.value; const types = (TS_ARMS[w.arm] && TS_ARMS[w.arm].types) || []; if (types.indexOf(w.sampleType) < 0) w.sampleType = ''; renderTapestation(); }));
    host.querySelectorAll('.ts-type').forEach((el) => el.addEventListener('change', () => { const w = TS_PENDING.wells[+el.dataset.i]; w.sampleType = el.value; el.closest('tr').querySelector('.who').textContent = tsLaneName(w); }));
    host.querySelectorAll('.ts-no').forEach((el) => el.addEventListener('change', () => { const w = TS_PENDING.wells[+el.dataset.i]; w.sampleNo = el.value; el.closest('tr').querySelector('.who').textContent = tsLaneName(w); }));
    host.querySelectorAll('.ts-dil').forEach((el) => el.addEventListener('input', () => { TS_PENDING.wells[+el.dataset.i].dilution = el.value; }));
    host.querySelectorAll('.ts-note').forEach((el) => el.addEventListener('input', () => { TS_PENDING.wells[+el.dataset.i].note = el.value; }));
    const cancel = $('#tsCancel'); if (cancel) cancel.addEventListener('click', () => { TS_PENDING = null; renderTapestation(); });
    const saveBtn = $('#tsSave'); if (saveBtn) saveBtn.addEventListener('click', () => saveTapestation(rec));
    const reloadBtn = $('#tsReload'); if (reloadBtn) reloadBtn.addEventListener('click', () => reloadTapestationFromDrive(rec));
    const backfillBtn = $('#tsBackfill'); if (backfillBtn) backfillBtn.addEventListener('click', () => backfillTapestationImages(rec));
    host.querySelectorAll('button[data-ts-del]').forEach((b) => b.addEventListener('click', () => {
      const i = +b.dataset.tsDel; if (rec.tapestation && !isNaN(i)) { rec.tapestation.splice(i, 1); Store.saveExperiment(rec); renderTapestation(); }
    }));
  }
  // Rebuild rec.tapestation from the durable lane-tags sheets in Drive - so tags +
  // notes survive any record reset / site update (Drive is the source of truth).
  // Backfill Drive-served trace images: for lanes missing an imgFileId, grab the id
  // from a loose PNG already in Drive, or upload the locally-cached PNG. Run this on
  // a device that can see the traces so they become visible everywhere.
  function backfillTapestationImages(rec) {
    const stEl = $('#tsReloadStatus'); if (stEl) stEl.textContent = ' Backfilling\u2026';
    const runs = rec.tapestation || [];
    if (!runs.length) { if (stEl) stEl.textContent = ' No TapeStation runs.'; return; }
    const req = rec.driveFolderId
      ? { action: 'getTapestation', parentId: rec.driveFolderId }
      : { action: 'getTapestation', project: rec.project || CURRENT_PROJECT, experiment: rec.name || 'Experiment' };
    driveApi(req).then(async (res) => {
      const driveByRun = {};
      ((res && res.runs) || []).forEach((r) => { const m = {}; (r.wells || []).forEach((w) => { if (w.imgFileId) m[w.well] = w.imgFileId; }); driveByRun[r.runName] = m; });
      let fromDrive = 0, fromCache = 0, skipped = 0;
      for (const run of runs) {
        const dm = driveByRun[run.runName] || {};
        const needUpload = [];
        (run.wells || []).forEach((w) => {
          if (w.imgFileId) return;
          if (dm[w.well]) { w.imgFileId = dm[w.well]; fromDrive += 1; return; }
          const cached = tsGetImg(w);
          if (cached) needUpload.push({ w: w, b64: cached }); else skipped += 1;
        });
        if (needUpload.length) {
          const folder = run.folder || sanitizeName(run.runName);
          const preq = rec.driveFolderId
            ? { action: 'ensurePath', parentId: rec.driveFolderId, subPath: ['data', 'tapestation', folder] }
            : { action: 'ensurePath', project: rec.project || CURRENT_PROJECT, experiment: rec.name || 'Experiment', subPath: ['data', 'tapestation', folder] };
          let path; try { path = await driveApi(preq); } catch (e) { path = null; }
          if (path && path.subId) {
            for (const item of needUpload) {
              if (stEl) stEl.textContent = ' Uploading ' + run.runName + ' ' + item.w.well + '\u2026';
              try { const up = await driveApi({ action: 'upload', name: 'trace_' + item.w.well + '.png', folderId: path.subId, base64: item.b64, sourceMime: 'image/png' }); if (up && up.id) { item.w.imgFileId = up.id; fromCache += 1; } else skipped += 1; }
              catch (e) { skipped += 1; }
            }
          } else { skipped += needUpload.length; }
        }
      }
      Store.saveExperiment(rec);
      if (stEl) stEl.textContent = ' Backfilled: ' + fromDrive + ' from Drive, ' + fromCache + ' uploaded'
        + (skipped ? ', ' + skipped + ' still missing (only inside a zip \u2014 re-save that run on the device that has it)' : '') + '.';
      renderTapestation();
    }).catch((e) => { if (stEl) stEl.textContent = ' Backfill failed: ' + e; });
  }
  function reloadTapestationFromDrive(rec) {
    const stEl = $('#tsReloadStatus'); if (stEl) stEl.textContent = ' Reading Drive\u2026';
    const req = rec.driveFolderId
      ? { action: 'getTapestation', parentId: rec.driveFolderId }
      : { action: 'getTapestation', project: rec.project || CURRENT_PROJECT, experiment: rec.name || 'Experiment' };
    driveApi(req)
      .then((res) => {
        if (!res || !res.ok) throw new Error('no response');
        const runs = res.runs || [];
        if (!runs.length) { if (stEl) stEl.textContent = ' No lane-tags sheets found in Drive for this experiment.'; return; }
        rec.tapestation = runs.map((r) => ({ runName: r.runName, notes: r.notes || '', folder: r.folder,
          wells: (r.wells || []).map((w) => ({ well: w.well, arm: w.arm || '', sampleType: w.sampleType || '', sampleNo: w.sampleNo || '', name: w.name || tsLaneName(w), description: w.description || '', conc: w.conc || '', dilution: w.dilution || '', note: w.note || '', peaks: w.peaks || [], imgFileId: w.imgFileId || '', imgKey: tsImgKey(rec.id, r.runName, w.well) })) }));
        Store.saveExperiment(rec);
        if (stEl) stEl.textContent = ' Loaded ' + runs.length + ' run(s) from Drive.';
        renderTapestation();
      })
      .catch((e) => { if (stEl) stEl.textContent = ' Reload failed: ' + e; });
  }
  function saveTapestation(rec) {
    if (!TS_PENDING) return;
    const stEl = $('#tsStatus');
    const files = TS_PENDING.files || [];
    if (!files.length) { stEl.textContent = 'Nothing to upload.'; return; }
    const runFolder = sanitizeName(TS_PENDING.runName).slice(0, 80) || 'TapeStation run';
    if (!confirm('Save ' + files.length + ' file(s) to the experiment\u2019s data/tapestation/\u201c' + runFolder + '\u201d folder? Files with the same name there will be overwritten. The lane tags + traces are stored on the experiment for the Review tab.')) return;
    stEl.textContent = 'Uploading to Drive\u2026';
    const req = rec.driveFolderId
      ? { action: 'ensurePath', parentId: rec.driveFolderId, subPath: ['data', 'tapestation', runFolder] }
      : { action: 'ensurePath', project: rec.project || CURRENT_PROJECT, experiment: rec.name || 'Experiment', subPath: ['data', 'tapestation', runFolder] };
    driveApi(req)
      .then(async (path) => {
        if (path && path.experimentId && rec.driveFolderId !== path.experimentId) { rec.driveFolderId = path.experimentId; }
        if (!path || !path.subId) throw new Error('could not reach the experiment\u2019s data/tapestation folder');
        let n = 0;
        for (const f of files) { n += 1; stEl.textContent = 'Uploading ' + n + '/' + files.length + '\u2026';
          await driveApi({ action: 'upload', name: f.name, folderId: path.subId, base64: f.base64, sourceMime: f.mime }); }
        // Upload each trace PNG individually so it's Drive-served (visible on every device),
        // and capture its file id per well.
        const imgFileByWell = {};
        for (const w of TS_PENDING.wells) { if (w.img) { stEl.textContent = 'Saving trace ' + w.well + '\u2026';
          const up = await driveApi({ action: 'upload', name: 'trace_' + w.well + '.png', folderId: path.subId, base64: w.img, sourceMime: 'image/png' });
          if (up && up.id) imgFileByWell[w.well] = up.id; } }
        TS_PENDING._imgFileByWell = imgFileByWell;
        // Durable lane-tags Google Sheet (source of truth for tags + notes, survives any record reset)
        stEl.textContent = 'Saving lane tags\u2026';
        const tagRows = [['Well', 'Original name', 'Section', 'Type', 'Sample #', 'Full ID', 'Dilution', 'Conc [pg/µl]', 'Notes', 'Peaks (JSON)']];
        TS_PENDING.wells.forEach((w) => tagRows.push([w.well, w.description || '', w.arm || '', w.sampleType || '', w.sampleNo || '', tsLaneName(w), w.dilution || '', w.conc || '', w.note || '', JSON.stringify(w.peaks || [])]));
        const tagWb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(tagWb, XLSX.utils.aoa_to_sheet([['Run', TS_PENDING.runName], ['Run notes', TS_PENDING.notes || ''], ['Saved', new Date().toISOString().slice(0, 16).replace('T', ' ')]]), 'Run info');
        XLSX.utils.book_append_sheet(tagWb, XLSX.utils.aoa_to_sheet(tagRows), 'Lane tags');
        await driveApi({ action: 'upload', name: runFolder + ' - lane tags', folderId: path.subId, base64: XLSX.write(tagWb, { type: 'base64', bookType: 'xlsx' }), sourceMime: XLSX_MIME, targetMime: GSHEET_MIME });
      })
      .then(() => {
        rec.tapestation = rec.tapestation || [];
        rec.tapestation.push({ runName: TS_PENDING.runName, notes: TS_PENDING.notes || '', folder: runFolder, fileCount: files.length, savedAt: new Date().toISOString().slice(0, 10),
          wells: TS_PENDING.wells.map((w) => { let imgKey = ''; if (w.img) { imgKey = tsImgKey(rec.id, TS_PENDING.runName, w.well); tsSetImg(imgKey, w.img); }
            return { well: w.well, arm: w.arm || '', sampleType: w.sampleType || '', sampleNo: w.sampleNo || '', name: tsLaneName(w), description: w.description, conc: w.conc, dilution: w.dilution, note: w.note, imgKey: imgKey, imgFileId: (TS_PENDING._imgFileByWell && TS_PENDING._imgFileByWell[w.well]) || '', peaks: w.peaks || [] }; }) });
        Store.saveExperiment(rec);
        TS_PENDING = null; renderTapestation();
      })
      .catch((e) => { stEl.textContent = 'Save failed: ' + e; });
  }

  // ---- Cellaca counts: drag-drop a WellLevel .xlsx, map wells -> sample IDs,
  // store the file in the project's Data/cellaca counts folder, and keep the
  // per-sample live / viability / total counts on the experiment record.
  let CELLACA_PENDING = null;   // { fileName, base64, byWell: {A1:{live,viability,total,...}} }
  function parseCellacaWorkbook(wb) {
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    const byWell = {}; const order = [];
    rows.slice(1).forEach((r) => {
      const well = String((r[0] != null ? r[0] : '')).trim();
      const calc = String((r[1] != null ? r[1] : '')).trim().toLowerCase();
      if (!well) return;
      if (!byWell[well]) { byWell[well] = {}; order.push(well); }
      const conc = Number(r[7]); const via = Number(r[8]); const cnt = Number(r[4]);
      if (calc === 'live') { if (!isNaN(conc)) byWell[well].live = conc; if (!isNaN(cnt)) byWell[well].liveCount = cnt; if (!isNaN(via)) byWell[well].viability = via; }
      else if (calc === 'total') { if (!isNaN(conc)) byWell[well].total = conc; if (!isNaN(cnt)) byWell[well].totalCount = cnt; }
      else if (byWell[well].viability == null && !isNaN(via)) byWell[well].viability = via;
    });
    return { byWell: byWell, order: order };
  }
  // Map between canonical sample # (pool-grouped order, same as the labels /
  // Cell count) and sampleId, so Cellaca wells can be entered by sample number.
  // Count purposes: thawing is keyed by sample #; pooled counts are keyed by a tube
  // label matching the printed convention (asap1..asapN before super-pooling, asap-sp
  // for the loaded super-pool; likewise unsort / sort).
  const CC_PURPOSES = [
    { name: 'Thawing count', mode: 'sample' },
    { name: 'ASAP super-pooling', mode: 'tube', prefix: 'asap' },
    { name: 'ASAP pre-load', mode: 'tube', fixed: 'asap-sp' },
    { name: "5' unsort super-pooling", mode: 'tube', prefix: 'unsort' },
    { name: "5' unsort pre-load", mode: 'tube', fixed: 'unsort-sp' },
    { name: 'Pre-sort', mode: 'tube', prefix: 'sort' },
    { name: 'Sort pre-load', mode: 'tube', fixed: 'sort-sp' }
  ];
  function ccPurposeCfg(name) { return CC_PURPOSES.filter((p) => p.name === name)[0] || { name: name, mode: 'tube' }; }
  function ccPurposeMode(name) { return ccPurposeCfg(name).mode; }
  // Standard tube labels for a pooled count, in well order.
  function ccAutoLabels(purposeName, nWells) {
    const cfg = ccPurposeCfg(purposeName);
    if (cfg.fixed) { const out = {}; return { first: cfg.fixed }; }   // single super-pool tube
    if (cfg.prefix) { const nPools = (function () { try { const c = computePooling(); return (c && c.poolRes && c.poolRes.nPools) || nWells; } catch (e) { return nWells; } })(); const arr = []; for (let i = 0; i < Math.max(nWells, nPools); i++) arr.push(cfg.prefix + (i + 1)); return { seq: arr }; }
    return { seq: [] };
  }
  function sampleNoMap() {
    const calc = computePooling();
    const byId = {}, byNo = {}; let n = 0;
    if (calc && calc.poolRes && calc.poolRes.pools) {
      calc.poolRes.pools.forEach((pool) => pool.forEach((s) => { n += 1; byId[s.sampleId] = n; }));
    }
    // explicit per-sample overrides (set on Modify experiment) win over pool order
    Object.keys(byId).forEach((sid) => { const ov = SAMPLE_NO_OVERRIDE[sid]; if (ov != null && ov !== '' && !isNaN(Number(ov))) byId[sid] = Number(ov); });
    let max = n; Object.keys(byId).forEach((sid) => { byNo[byId[sid]] = sid; if (byId[sid] > max) max = byId[sid]; });
    return { byId: byId, byNo: byNo, max: max };
  }
  function renderCellaca() {
    const host = $('#recCellacaContent'); if (!host) return;
    const rec = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    if (!rec) { host.innerHTML = '<h2>Cellaca counts</h2><p class="empty">Select a project and experiment in the sidebar first.</p>'; return; }
    const list = (rec.cellacaCountsList || []).slice();
    const _ccMap = (function () { try { return sampleNoMap(); } catch (e) { return { byId: {}, byNo: {} }; } })();
    const _ccNoMap = _ccMap.byId;
    const storedRows = list.map((c, i) => {
      const _dn = (c.sampleId && _ccNoMap[c.sampleId] != null) ? _ccNoMap[c.sampleId] : (c.sampleNo != null && c.sampleNo !== '' ? c.sampleNo : '');
      const orphan = !c.tubeLabel && c.sampleId && _ccNoMap[c.sampleId] == null;   // its sample was removed/renamed
      let idCell;
      if (c.tubeLabel) idCell = esc(c.tubeLabel);
      else idCell = '<input class="cc-fix-no" data-i="' + i + '" type="number" min="1" value="' + escAttr(_dn) + '" style="width:56px" title="Sample # \u2014 edit to re-link this count"> '
        + esc(c.sampleId || '') + (orphan ? ' <span class="ph-tag" title="This count\u2019s sample was removed/renamed \u2014 re-number it or delete it">\u26a0 orphaned</span>' : '');
      return '<tr' + (orphan ? ' style="background:#fff6f6"' : '') + '><td>' + idCell + '</td>'
        + '<td class="who">' + esc(c.well || '') + '</td><td>' + esc(c.purpose || '') + '</td><td>' + esc(c.thawer || '') + '</td>'
        + '<td class="num">' + (c.live != null ? Number(c.live).toLocaleString() : '\u2014') + '</td>'
        + '<td class="num">' + (c.viability != null ? c.viability + '%' : '\u2014') + '</td>'
        + '<td class="num">' + (c.total != null ? Number(c.total).toLocaleString() : '\u2014') + '</td>'
        + '<td><input class="cc-note" data-i="' + i + '" value="' + escAttr(c.notes || '') + '" placeholder="notes" style="width:170px"></td>'
        + '<td><button class="btn tiny" data-cc-del="' + i + '">\u2715</button></td></tr>'; }).join('');
    const storedTable = list.length
      ? '<h3>Stored counts (' + list.length + ' rows)</h3><p class="who small">Edit a Sample # to re-link a count to the current sample with that number (fixes counts left over from a removed/renamed sample). Orphaned rows are flagged.</p><table class="cost-table"><thead><tr><th>Sample / tube</th><th>Well</th><th>Count for</th><th>Thawer</th><th class="num">Live (cells/mL)</th><th class="num">Viability</th><th class="num">Total (cells/mL)</th><th>Notes</th><th></th></tr></thead><tbody>' + storedRows + '</tbody></table>'
      : '<p class="muted">No counts stored yet for this experiment.</p>';

    let mapUI = '';
    if (CELLACA_PENDING) {
      const nmap = sampleNoMap();
      const mode = ccPurposeMode(CELLACA_PENDING.purpose);
      const wells = CELLACA_PENDING.order;
      const grid = wells.map((w) => {
        const c = CELLACA_PENDING.byWell[w];
        const cur = (CELLACA_PENDING.assign && CELLACA_PENDING.assign[w]) || '';
        const metrics = (c.live != null ? (Math.round(c.live / 1000) / 1000) + 'M/mL' : '\u2014') + ' \u00b7 ' + (c.viability != null ? c.viability + '%' : '\u2014');
        const input = mode === 'sample'
          ? '<input type="number" min="1" class="cc-sample" data-well="' + escAttr(w) + '" placeholder="sample #" value="' + esc(cur) + '">'
          : '<input type="text" class="cc-tube" data-well="' + escAttr(w) + '" placeholder="tube label" value="' + escAttr(cur) + '">';
        const preview = (mode === 'sample' && cur && nmap.byNo[cur]) ? esc(nmap.byNo[cur]) + ' \u00b7 ' : '';
        return '<div class="cc-well"><div class="cc-wname">' + esc(w) + '</div>' + input + '<div class="cc-metrics">' + preview + metrics + '</div></div>';
      }).join('');
      const purposeOpts = CC_PURPOSES.map((p) => '<option value="' + escAttr(p.name) + '"' + (CELLACA_PENDING.purpose === p.name ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('')
        + '<option value="__other__"' + (CELLACA_PENDING.purpose === '__other__' ? ' selected' : '') + '>Other\u2026</option>';
      const fillCtrls = mode === 'sample'
        ? 'start at # <input id="ccStartNo" type="number" min="1" value="1" style="width:70px"> <button class="btn ghost" id="ccFillOrder">Fill in order from #</button>'
        : '<button class="btn ghost" id="ccAutoLabel">Auto-label tubes</button>';
      const entryHint = mode === 'sample'
        ? 'Type the <strong>sample #</strong> loaded in each well (same numbering as the labels / Cell count tab).'
        : 'Type the <strong>tube label</strong> in each well (same convention as the printed tube labels, e.g. asap1, asap-sp). Use <em>Auto-label tubes</em> to fill the standard labels for this count.';
      mapUI = '<h3>This upload <span class="who">' + esc(CELLACA_PENDING.fileName) + '</span></h3>'
        + '<div class="row-actions" style="margin:6px 0;flex-wrap:wrap">'
        + '<label>Count for <select id="ccPurpose">' + purposeOpts + '</select></label>'
        + '<input id="ccPurposeOther" placeholder="describe count" style="width:180px;' + (CELLACA_PENDING.purpose === '__other__' ? '' : 'display:none') + '" value="' + escAttr(CELLACA_PENDING.purposeOther || '') + '">'
        + '<label>Thawer / operator <input id="ccPlate" placeholder="who" style="width:130px" value="' + escAttr(CELLACA_PENDING.plate || '') + '"></label>'
        + '<label>Notes <input id="ccNotes" placeholder="notes for this file" style="width:220px" value="' + escAttr(CELLACA_PENDING.notes || '') + '"></label>'
        + '</div>'
        + '<h4 style="margin:12px 0 4px">' + (mode === 'sample' ? 'Enter the sample # in each well' : 'Enter the tube label in each well') + '</h4>'
        + '<p class="step-hint">' + entryHint + '</p>'
        + '<div class="row-actions" style="margin:6px 0">' + fillCtrls + ' <button class="btn ghost" id="ccClearAssign">Clear</button></div>'
        + '<div class="cc-grid">' + grid + '</div>'
        + '<div class="row-actions" style="margin-top:12px"><button class="btn primary" id="ccSave">Save this count + upload to Drive</button> <button class="btn ghost" id="ccCancel">Cancel</button></div>'
        + '<div id="ccStatus" class="muted" style="margin-top:8px"></div>';
    }

    const topActions = '<div class="row-actions" style="margin:4px 0 14px">'
      + (list.length ? '<button class="btn" id="ccSaveAll">Re-save counts spreadsheet to Drive</button>' : '')
      + '<button class="btn ghost" id="ccReload">Reload counts from Drive</button><span id="ccAllStatus" class="muted"></span></div>';

    host.innerHTML = '<h2>Cellaca counts <span class="who">' + esc(rec.name || '') + '</span></h2>'
      + '<p class="step-hint">Drag a Cellaca <strong>WellLevel .xlsx</strong> here (one plate at a time). Each file is renamed and saved to the experiment\u2019s <strong>data \u203a cellaca counts</strong> folder with thawer + count-purpose metadata, and the per-sample counts are stored on the experiment.</p>'
      + topActions
      + '<div id="ccDrop" class="cc-drop">Drop a WellLevel .xlsx here, or click to browse<input type="file" id="ccFile" accept=".xlsx" hidden></div>'
      + mapUI + '<div style="margin-top:20px"></div>' + storedTable;

    // wire drop zone
    const drop = $('#ccDrop'), fileInput = $('#ccFile');
    const handleFile = (file) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          const wb = XLSX.read(data, { type: 'array' });
          const parsed = parseCellacaWorkbook(wb);
          if (!parsed.order.length) { alert('No wells found in that file \u2014 is it a Cellaca WellLevel export?'); return; }
          let bin = ''; for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);
          CELLACA_PENDING = { fileName: file.name, base64: btoa(bin), wb: wb, byWell: parsed.byWell, order: parsed.order, assign: {}, purpose: 'Thawing count', purposeOther: '', plate: '' };
          renderCellaca();
        } catch (err) { alert('Could not read that file: ' + err); }
      };
      reader.readAsArrayBuffer(file);
    };
    if (drop) {
      drop.addEventListener('click', () => fileInput && fileInput.click());
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
      drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); handleFile(e.dataTransfer.files[0]); });
    }
    if (fileInput) fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));

    // wire assignment helpers (store the typed sample #, refresh the id preview)
    host.querySelectorAll('.cc-sample').forEach((s) => s.addEventListener('input', () => {
      if (!CELLACA_PENDING) return;
      CELLACA_PENDING.assign = CELLACA_PENDING.assign || {};
      const v = parseInt(s.value, 10);
      CELLACA_PENDING.assign[s.dataset.well] = (isNaN(v) || v < 1) ? '' : v;
      const nmap = sampleNoMap(); const sid = nmap.byNo[v];
      const metric = s.parentNode.querySelector('.cc-metrics');
      const c = CELLACA_PENDING.byWell[s.dataset.well];
      if (metric) metric.innerHTML = (sid ? esc(sid) + ' \u00b7 ' : '') + (c.live != null ? (Math.round(c.live / 1000) / 1000) + 'M/mL' : '\u2014') + ' \u00b7 ' + (c.viability != null ? c.viability + '%' : '\u2014');
    }));
    const fillOrder = $('#ccFillOrder');
    if (fillOrder) fillOrder.addEventListener('click', () => {
      let start = parseInt($('#ccStartNo') && $('#ccStartNo').value, 10); if (isNaN(start) || start < 1) start = 1;
      CELLACA_PENDING.assign = {};
      CELLACA_PENDING.order.forEach((w, i) => { CELLACA_PENDING.assign[w] = start + i; });
      renderCellaca();
    });
    host.querySelectorAll('.cc-tube').forEach((s) => s.addEventListener('input', () => {
      if (!CELLACA_PENDING) return; CELLACA_PENDING.assign = CELLACA_PENDING.assign || {}; CELLACA_PENDING.assign[s.dataset.well] = s.value.trim();
    }));
    const autoLabel = $('#ccAutoLabel');
    if (autoLabel) autoLabel.addEventListener('click', () => {
      const labels = ccAutoLabels(CELLACA_PENDING.purpose, CELLACA_PENDING.order.length);
      CELLACA_PENDING.assign = {};
      if (labels.first) { CELLACA_PENDING.assign[CELLACA_PENDING.order[0]] = labels.first; }
      else if (labels.seq) { CELLACA_PENDING.order.forEach((w, i) => { if (labels.seq[i]) CELLACA_PENDING.assign[w] = labels.seq[i]; }); }
      renderCellaca();
    });
    const clearAssign = $('#ccClearAssign');
    if (clearAssign) clearAssign.addEventListener('click', () => { CELLACA_PENDING.assign = {}; renderCellaca(); });
    const purposeSel = $('#ccPurpose');
    if (purposeSel) purposeSel.addEventListener('change', () => { CELLACA_PENDING.purpose = purposeSel.value; CELLACA_PENDING.assign = {}; renderCellaca(); });
    const purposeOther = $('#ccPurposeOther'); if (purposeOther) purposeOther.addEventListener('input', () => { CELLACA_PENDING.purposeOther = purposeOther.value; });
    const plateInp = $('#ccPlate'); if (plateInp) plateInp.addEventListener('input', () => { CELLACA_PENDING.plate = plateInp.value; });
    const notesInp = $('#ccNotes'); if (notesInp) notesInp.addEventListener('input', () => { CELLACA_PENDING.notes = notesInp.value; });
    const saveAll = $('#ccSaveAll'); if (saveAll) saveAll.addEventListener('click', () => saveAllCounts(rec));
    const ccReload = $('#ccReload'); if (ccReload) ccReload.addEventListener('click', () => reloadCellacaFromDrive(rec));
    const cancel = $('#ccCancel'); if (cancel) cancel.addEventListener('click', () => { CELLACA_PENDING = null; renderCellaca(); });
    const save = $('#ccSave'); if (save) save.addEventListener('click', () => saveCellaca(rec));
    host.querySelectorAll('button[data-cc-del]').forEach((b) => b.addEventListener('click', () => {
      const i = parseInt(b.dataset.ccDel, 10);
      if (rec.cellacaCountsList && !isNaN(i)) { rec.cellacaCountsList.splice(i, 1); Store.saveExperiment(rec); renderCellaca(); }
    }));
    host.querySelectorAll('.cc-note').forEach((el) => el.addEventListener('change', () => {
      const i = parseInt(el.dataset.i, 10);
      if (rec.cellacaCountsList && rec.cellacaCountsList[i]) { rec.cellacaCountsList[i].notes = el.value; Store.saveExperiment(rec); }
    }));
    host.querySelectorAll('.cc-fix-no').forEach((el) => el.addEventListener('change', () => {
      const i = parseInt(el.dataset.i, 10); const v = parseInt(el.value, 10);
      const nmap = sampleNoMap(); const sid = nmap.byNo[v];
      if (rec.cellacaCountsList && rec.cellacaCountsList[i]) {
        if (!sid) { alert('No sample is currently #' + v + ' (max is ' + nmap.max + '). Re-number the sample on Modify experiment, or delete this count.'); renderCellaca(); return; }
        rec.cellacaCountsList[i].sampleNo = v; rec.cellacaCountsList[i].sampleId = sid;
        Store.saveExperiment(rec); renderCellaca();
      }
    }));
  }
  function confirmOverwrite(name) {
    return confirm('This will save \u201c' + name + '\u201d to Drive and OVERWRITE any existing file with that name in the experiment folder. Continue?');
  }
  function cellacaPurposeOf(p) {
    if (p && p.purpose === '__other__') return (p.purposeOther || 'Other').trim();
    return p ? (p.purpose || '') : '';
  }
  function sanitizeName(s) { return String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim(); }

  // Resolve the experiment's data/cellaca counts folder, reusing the already-known
  // experiment folder id when we have it (so we never create a duplicate by name).
  function ensureCellacaFolder(rec) {
    const req = rec.driveFolderId
      ? { action: 'ensurePath', parentId: rec.driveFolderId, subPath: ['data', 'cellaca counts'] }
      : { action: 'ensurePath', project: rec.project || CURRENT_PROJECT, experiment: rec.name || 'Experiment', subPath: ['data', 'cellaca counts'] };
    return driveApi(req).then((path) => {
      if (path && path.experimentId && rec.driveFolderId !== path.experimentId) { rec.driveFolderId = path.experimentId; Store.saveExperiment(rec); }
      return path;
    });
  }
  // One spreadsheet, one tab per count purpose; metadata (thawer) as columns so
  // every thawer's rows accumulate on the same tab.
  function buildCellacaWb(rec) {
    const listAll = rec.cellacaCountsList || [];
    const wb = XLSX.utils.book_new();
    const byPurpose = {}; const order = [];
    listAll.forEach((r) => { const p = r.purpose || 'Other'; if (!byPurpose[p]) { byPurpose[p] = []; order.push(p); } byPurpose[p].push(r); });
    if (!order.length) { XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['No counts yet']]), 'Counts'); return wb; }
    const used = {};
    order.forEach((p) => {
      const rows = [['Sample #', 'Sample ID', 'Tube label', 'Well', 'Thawer', 'Live (cells/mL)', 'Viability (%)', 'Total (cells/mL)', 'Notes', 'Uploaded']];
      byPurpose[p].slice().sort((a, b) => (a.sampleNo || 0) - (b.sampleNo || 0))
        .forEach((r) => rows.push([r.sampleNo, r.sampleId, r.tubeLabel || '', r.well, r.thawer || '', r.live != null ? r.live : '', r.viability != null ? r.viability : '', r.total != null ? r.total : '', r.notes || '', r.uploadedAt || '']));
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [{ wch: 9 }, { wch: 20 }, { wch: 12 }, { wch: 7 }, { wch: 14 }, { wch: 16 }, { wch: 13 }, { wch: 16 }, { wch: 20 }, { wch: 17 }];
      let tab = (sanitizeName(p) || 'Counts').slice(0, 28); let t = tab, n = 2; while (used[t]) { t = tab + ' ' + (n++); } used[t] = 1;
      XLSX.utils.book_append_sheet(wb, ws, t);
    });
    return wb;
  }

  function saveCellaca(rec) {
    if (!CELLACA_PENDING) return;
    const stEl = $('#ccStatus'); const thawer = (CELLACA_PENDING.plate || '').trim(); const fileNotes = (CELLACA_PENDING.notes || '').trim();
    const purpose = cellacaPurposeOf(CELLACA_PENDING) || 'Other';
    const mode = ccPurposeMode(CELLACA_PENDING.purpose);
    const assign = CELLACA_PENDING.assign || {};
    const nmap = sampleNoMap();
    let mapped, unresolved = [];
    if (mode === 'sample') {
      mapped = Object.keys(assign).filter((w) => assign[w] && nmap.byNo[assign[w]]);
      unresolved = Object.keys(assign).filter((w) => assign[w] && !nmap.byNo[assign[w]]);
      if (!mapped.length) { stEl.textContent = unresolved.length ? ('No entered sample # matches a sample (max is ' + nmap.max + ').') : 'Enter a sample # in at least one well first.'; return; }
    } else {
      mapped = Object.keys(assign).filter((w) => assign[w]);
      if (!mapped.length) { stEl.textContent = 'Enter a tube label in at least one well first.'; return; }
    }
    const expId = rec.experimentId || projectLabel(rec.name || 'experiment');
    const fileName = sanitizeName(expId + ' cellaca counts');
    if (!confirm('Add these ' + mapped.length + ' counts (' + purpose + (thawer ? ', ' + thawer : '') + ') to the \u201c' + fileName + '\u201d spreadsheet in Drive? Existing counts are kept \u2014 the new rows are appended.')) return;
    stEl.textContent = 'Saving\u2026';
    const uploadedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
    rec.cellacaCountsList = rec.cellacaCountsList || [];
    mapped.forEach((w) => { const c = CELLACA_PENDING.byWell[w]; const v = assign[w];
      const rowRec = { well: w, thawer: thawer, purpose: purpose, notes: fileNotes, live: c.live != null ? c.live : null, viability: c.viability != null ? c.viability : null, total: c.total != null ? c.total : null, uploadedAt: uploadedAt };
      if (mode === 'sample') { rowRec.sampleNo = v; rowRec.sampleId = nmap.byNo[v]; rowRec.tubeLabel = ''; }
      else { rowRec.tubeLabel = v; rowRec.sampleNo = ''; rowRec.sampleId = ''; }
      rec.cellacaCountsList.push(rowRec); });
    Store.saveExperiment(rec);
    const base64 = XLSX.write(buildCellacaWb(rec), { type: 'base64', bookType: 'xlsx' });
    ensureCellacaFolder(rec)
      .then((path) => { if (!path || !path.subId) throw new Error('could not reach the experiment\u2019s data/cellaca counts folder');
        return driveApi({ action: 'upload', name: fileName, folderId: path.subId, base64: base64, sourceMime: XLSX_MIME, targetMime: GSHEET_MIME }); })
      .then(() => { CELLACA_PENDING = null; renderCellaca(); if (unresolved.length) alert('Saved ' + mapped.length + ' wells. ' + unresolved.length + ' well(s) had a sample # with no matching sample and were skipped.'); })
      .catch((e) => { stEl.textContent = 'Save failed: ' + e; });
  }

  // Re-generate the consolidated counts spreadsheet from the stored list.
  function reloadCellacaFromDrive(rec) {
    const stEl = $('#ccAllStatus'); if (stEl) stEl.textContent = ' Reading Drive\u2026';
    const req = rec.driveFolderId ? { action: 'getCellaca', parentId: rec.driveFolderId } : { action: 'getCellaca', project: rec.project || CURRENT_PROJECT, experiment: rec.name || 'Experiment' };
    driveApi(req).then((res) => {
      if (!res || !res.ok) throw new Error('no response');
      const list = res.list || [];
      if (!list.length) { if (stEl) stEl.textContent = ' No counts spreadsheet found in Drive for this experiment.'; return; }
      rec.cellacaCountsList = list.map((c) => ({ sampleNo: c.sampleNo, sampleId: c.sampleId, tubeLabel: c.tubeLabel || '', well: c.well, thawer: c.thawer, purpose: c.purpose, notes: c.notes || '', live: c.live, viability: c.viability, total: c.total, uploadedAt: c.uploadedAt }));
      Store.saveExperiment(rec);
      if (stEl) stEl.textContent = ' Loaded ' + list.length + ' counts from Drive.';
      renderCellaca();
    }).catch((e) => { if (stEl) stEl.textContent = ' Reload failed: ' + e; });
  }
  function saveAllCounts(rec) {
    const stEl = $('#ccAllStatus');
    if (!(rec.cellacaCountsList || []).length) { if (stEl) stEl.textContent = 'No counts to save yet.'; return; }
    const expId = rec.experimentId || projectLabel(rec.name || 'experiment');
    const fileName = sanitizeName(expId + ' cellaca counts');
    if (stEl) stEl.textContent = 'Uploading to Drive\u2026';
    const base64 = XLSX.write(buildCellacaWb(rec), { type: 'base64', bookType: 'xlsx' });
    ensureCellacaFolder(rec)
      .then((path) => { if (!path || !path.subId) throw new Error('could not reach the experiment\u2019s data/cellaca counts folder');
        return driveApi({ action: 'upload', name: fileName, folderId: path.subId, base64: base64, sourceMime: XLSX_MIME, targetMime: GSHEET_MIME }); })
      .then((res) => { if (stEl) stEl.innerHTML = ' Saved.' + (res && res.id ? ' <a href="https://docs.google.com/spreadsheets/d/' + escAttr(res.id) + '/edit" target="_blank" rel="noopener">Open</a>' : ''); })
      .catch((e) => { if (stEl) stEl.textContent = 'Save failed: ' + e; });
  }

  // Supply Usage — a per-experiment pick-list that logs reagent/kit usage to
  // inventory (the "removed" event). Reads the experiment's computed reagent
  // demand and lets you confirm what was actually consumed on batch day.
  function renderSupplyUsage() {
    const host = $('#recSupplyContent'); if (!host) return;
    const rec = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    if (!rec) { host.innerHTML = '<h2>Supply Usage</h2><p class="empty">Select a project and experiment in the sidebar to log its supply usage.</p>'; return; }
    if (!rec.snapshot) { host.innerHTML = '<h2>Supply Usage</h2><p class="empty">This experiment has no computed plan yet \u2014 build and save it on the Plan tab first.</p>'; return; }
    if (!DATA || !((DATA.liveInventory || []).length)) { host.innerHTML = '<h2>Supply Usage</h2><p class="empty">Live inventory isn\u2019t loaded, so usage can\u2019t be matched. Open the Inventory tab to load it, then return here.</p>'; return; }
    const usage = computeExperimentUsage(rec);
    const st = computeInventoryState(); const byId = {}; st.items.forEach((i) => { byId[i.id] = i; });
    const applied = !!rec.inventoryApplied;
    const rows = usage.map((u) => {
      const it = byId[u.itemId] || {};
      const avail = it.availableUnits != null ? fmtQ(it.availableUnits) + ' ' + esc(it.usageUnit || u.unit) : '\u2014';
      return '<tr><td><input type="checkbox" class="su-chk" data-id="' + escAttr(u.itemId) + '"' + (applied ? '' : ' checked') + '></td>'
        + '<td>' + esc(u.itemName) + ' <span class="who">' + esc(u.itemId) + '</span></td>'
        + '<td class="num">' + fmtQ(u.amount) + ' ' + esc(u.unit) + '</td>'
        + '<td class="num">' + avail + '</td>'
        + '<td class="num"><input type="number" class="su-used" data-id="' + escAttr(u.itemId) + '" value="' + (Math.round(u.amount * 1000) / 1000) + '" step="any" style="width:90px"> ' + esc(u.unit) + '</td></tr>';
    }).join('');
    const statusLine = applied
      ? '<div class="callout info">Usage for this experiment has already been deducted from the inventory sheet (' + (rec.actualUsage && rec.actualUsage.recordedAt ? esc(rec.actualUsage.recordedAt.slice(0, 10)) : 'previously') + '). Re-logging reverses the previous deduction and re-applies the current amounts.</div>'
      : '<div class="callout info">Confirm the amounts actually used, then log them \u2014 this subtracts directly from the inventory sheet\u2019s on-hand (visible to anyone viewing the sheet) and releases this experiment\u2019s reservation.</div>';
    host.innerHTML = '<h2>Supply Usage <span class="who">' + esc(rec.name || '') + (rec.experimentId ? ' \u00b7 ' + esc(rec.experimentId) : '') + '</span></h2>'
      + statusLine
      + (usage.length
        ? '<h3>Reagents &amp; supplies</h3><table class="cost-table"><thead><tr><th>Use</th><th>Item</th><th class="num">Planned</th><th class="num">Available</th><th class="num">Actually used</th></tr></thead><tbody>' + rows + '</tbody></table>'
          + '<div class="row-actions" style="margin-top:10px"><button class="btn primary" id="suLog">' + (applied ? 'Re-log usage to inventory' : 'Log usage to inventory') + '</button>'
          + (applied ? '<button class="btn ghost" id="suUndo">Undo deduction</button>' : '') + '</div>'
        : '<p class="empty">None of this experiment\u2019s reagents matched an item in the live inventory (by item_id). Add matching item_ids in the inventory sheet to track them here.</p>')
      + '<h3 style="margin-top:22px">10x kit boxes</h3><p class="step-hint">Kit boxes are drawn down per-box (rxns / index wells). Log the exact boxes used:</p>'
      + '<div class="row-actions"><button class="btn ghost" id="suKits">Log kit-box usage\u2026</button></div>'
      + '<div id="suStatus" class="muted" style="margin-top:10px"></div>';

    const logBtn = $('#suLog');
    const postAdjust = (itemId, deltaUnits) => fetch('/api/inventory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'adjustOnHand', itemId: itemId, deltaUnits: deltaUnits }) }).then((r) => r.json());
    const cssEsc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : s;
    if (logBtn) logBtn.addEventListener('click', () => {
      const picked = Array.prototype.slice.call(host.querySelectorAll('.su-chk:checked')).map((c) => c.dataset.id);
      const stEl = $('#suStatus');
      if (!picked.length) { stEl.textContent = 'Tick at least one item to log.'; return; }
      const items = picked.map((id) => {
        const u = usage.find((x) => x.itemId === id) || {};
        const inp = host.querySelector('.su-used[data-id="' + cssEsc(id) + '"]');
        const amt = inp ? (Number(inp.value) || 0) : u.amount;
        return { itemId: id, itemName: u.itemName, unit: u.unit, amount: Math.abs(amt) };
      }).filter((x) => x.amount);
      if (!items.length) { stEl.textContent = 'Enter the amounts used.'; return; }
      logBtn.disabled = true;
      const date = rec.date || new Date().toISOString().slice(0, 10);
      (async () => {
        try {
          // Re-logging: reverse the previous sheet deductions first.
          if (rec.inventoryApplied) {
            const prior = Store.transactionsForExperiment(rec.id) || [];
            for (const t of prior) { if (t.sheetDelta) { stEl.textContent = 'Reversing previous deduction\u2026'; await postAdjust(t.itemId, -t.sheetDelta); } }
            Store.removeTransactionsForExperiment(rec.id);
          }
          const txs = []; let n = 0;
          for (const it of items) { n += 1; stEl.textContent = 'Deducting from the inventory sheet\u2026 (' + n + '/' + items.length + ')';
            const d = await postAdjust(it.itemId, -it.amount);
            if (d && d.ok) txs.push({ itemId: it.itemId, itemName: it.itemName, unit: it.unit, delta: 0, sheetDelta: -it.amount, date: date, reason: 'Used \u2014 ' + rec.name, experimentId: rec.id });
          }
          Store.addTransactions(txs);
          rec.inventoryApplied = true; rec.status = 'completed'; rec.reserved = false; Store.saveExperiment(rec);
          await loadLiveInventory().catch(() => {}); pushReservedToSheet();
          renderSupplyUsage();
        } catch (e) { stEl.textContent = 'Deduction failed: ' + e; logBtn.disabled = false; }
      })();
    });
    const undoBtn = $('#suUndo');
    if (undoBtn) undoBtn.addEventListener('click', () => {
      if (!confirm('Undo this experiment\u2019s deductions? This adds the amounts back to the inventory sheet and moves it back to reserved.')) return;
      const stEl = $('#suStatus'); undoBtn.disabled = true;
      (async () => {
        try {
          const prior = Store.transactionsForExperiment(rec.id) || [];
          let n = 0; for (const t of prior) { if (t.sheetDelta) { n += 1; stEl.textContent = 'Restoring stock\u2026 (' + n + ')'; await postAdjust(t.itemId, -t.sheetDelta); } }
          Store.removeTransactionsForExperiment(rec.id);
          rec.inventoryApplied = false; rec.status = 'planned'; rec.reserved = true; Store.saveExperiment(rec);
          await loadLiveInventory().catch(() => {}); pushReservedToSheet();
          renderSupplyUsage();
        } catch (e) { stEl.textContent = 'Undo failed: ' + e; undoBtn.disabled = false; }
      })();
    });
    const kitBtn = $('#suKits'); if (kitBtn) kitBtn.addEventListener('click', () => recordUsageUI(rec.id));
  }
  let REV_TS_ARM = 'all', REV_TS_TYPE = 'all', REV_TS_VIEW = 'summary', REV_TS_MIN = '', REV_TS_MAX = '';
  function renderReview(id) {
    if (id === 'rev-data') { renderReviewData(); return; }
    if (id === 'rev-sort') { renderReviewSort(); return; }
    if (id === 'rev-counts') { renderReviewCounts(); return; }
    if (id === 'rev-kits') { renderReviewKits(); return; }
    if (id === 'rev-worksheets') { renderReviewWorksheets(); return; }
    if (id === 'rev-libstatus') { renderLibStatus('revLibStatusContent', false); return; }
    if (id === 'rev-notes') { renderNotesReview(); return; }
    const s = REV_STUBS[id]; if (s) stubPage(s[0], s[1], s[2]);
  }
  // Counts summary: cells per sample at each stage (Cellaca counts by purpose),
  // the worksheet loading counts, and how the pools ended up.
  function renderReviewCounts() {
    const host = $('#revCountsContent'); if (!host) return;
    const rec = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    if (!rec) { host.innerHTML = '<h2>Counts</h2><p class="empty">Select a project and experiment in the sidebar first.</p>'; return; }
    const fmtN = (n) => (n == null || n === '') ? '\u2014' : Number(n).toLocaleString();
    let body = '';

    // 1) Cellaca counts \u2014 one row per count: identifier, count, viability, count type
    const list = rec.cellacaCountsList || [];
    if (list.length) {
      const noMap = (function () { try { return sampleNoMap().byId; } catch (e) { return {}; } })();
      const dispNo = (c) => (c.sampleId && noMap[c.sampleId] != null) ? noMap[c.sampleId] : (c.sampleNo != null && c.sampleNo !== '' ? c.sampleNo : '');
      const ordered = list.slice().sort((a, b) => (Number(dispNo(a)) || 999) - (Number(dispNo(b)) || 999)
        || String(a.tubeLabel || '').localeCompare(String(b.tubeLabel || '')) || String(a.purpose || '').localeCompare(String(b.purpose || '')));
      const rows = ordered.map((c) => { const dn = dispNo(c);
        return '<tr><td>' + esc(c.tubeLabel || c.sampleId || '') + (dn !== '' ? ' <span class="who">#' + esc(dn) + '</span>' : '') + '</td>'
        + '<td class="num">' + (c.live != null ? fmtN(c.live) : '\u2014') + '</td>'
        + '<td class="num">' + (c.viability != null ? c.viability + '%' : '\u2014') + '</td>'
        + '<td>' + esc(c.purpose || '') + '</td>'
        + '<td class="who">' + esc(c.notes || '') + '</td></tr>'; }).join('');
      body += '<h3>Cellaca counts <span class="who">(live cells/mL)</span></h3>'
        + '<table class="cost-table"><thead><tr><th>Sample / tube</th><th class="num">Count (cells/mL)</th><th class="num">Viability</th><th>Count type</th><th>Notes</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }

    // 2) Worksheet loading counts (the counting-calculation tables)
    const ws = rec.worksheets || {};
    ['batchday', 'library'].forEach((type) => { const w = ws[type]; if (!w) return; const cfg = WORKSHEET_CFG[type];
      const rws = (w.counts || []).filter((r) => r.some((c) => c !== ''));
      if (rws.length) body += '<h3 style="margin-top:20px">' + esc(cfg.title) + ' \u2014 counting calculations</h3><div style="overflow:auto"><table class="cost-table"><thead><tr>' + cfg.countCols.map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>' + rws.map((r) => '<tr>' + cfg.countCols.map((c, ci) => '<td>' + esc(r[ci] || '') + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
    });

    // 3) How the pools ended up (from the saved pooling snapshot)
    const snap = rec.snapshot;
    if (snap && snap.batches && snap.batches.length) {
      const cps = snap.poolContributionPerSample != null ? snap.poolContributionPerSample : snap.cellsPerSample;
      let pr = ''; snap.batches.forEach((b) => { const n = (b.samples || []).length;
        pr += '<tr><td>Pool ' + esc(b.pool) + '</td><td class="num">' + n + '</td><td class="num">' + (cps ? fmtN(n * cps) : '\u2014') + '</td><td class="who">' + (b.samples || []).map((s) => esc(s.sampleId)).join(', ') + '</td></tr>'; });
      body += '<h3 style="margin-top:20px">Per pool <span class="who">(from the pooling plan)</span></h3>'
        + '<p class="who">Target cells / pool = samples \u00d7 cells pooled per sample' + (cps ? ' (' + fmtN(cps) + ')' : '') + '.</p>'
        + '<table class="cost-table"><thead><tr><th>Pool</th><th class="num"># samples</th><th class="num">Target cells pooled</th><th>Samples</th></tr></thead><tbody>' + pr + '</tbody></table>';
    }

    host.innerHTML = '<h2>Counts <span class="who">' + esc(rec.name || '') + '</span></h2>' + (body || '<p class="empty">No counts yet. Upload Cellaca counts (Record \u2192 Cellaca counts) and enter worksheet counts (Record \u2192 Batch Day / Library Worksheets).</p>');
  }
  function renderReviewKits() {
    const host = $('#revKitsContent'); if (!host) return;
    const rec = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    if (!rec) { host.innerHTML = '<h2>Kit and supply usage</h2><p class="empty">Select a project and experiment in the sidebar first.</p>'; return; }
    const ws = rec.worksheets || {};
    let kitRows = '';
    ['batchday', 'library'].forEach((type) => { const w = ws[type]; if (!w) return;
      (w.kits || []).forEach((k) => { if (k.lot || k.rxns || k.notes) kitRows += '<tr><td>' + esc(WORKSHEET_CFG[type].title) + '</td><td>' + esc(k.kit) + '</td><td class="who">' + esc(k.pn || '') + '</td><td>' + esc(k.lot || '') + '</td><td class="num">' + esc(k.rxns || '') + '</td><td class="who">' + esc(k.notes || '') + '</td></tr>'; });
    });
    host.innerHTML = '<h2>Kit and supply usage <span class="who">' + esc(rec.name || '') + '</span></h2>'
      + '<h3>Recorded 10X kit lots &amp; rxns used</h3>'
      + (kitRows ? '<table class="cost-table"><thead><tr><th>Worksheet</th><th>10X kit</th><th>PN</th><th>Lot #</th><th class="num">Rxns used</th><th>Notes</th></tr></thead><tbody>' + kitRows + '</tbody></table>' : '<p class="empty">No kit lots recorded yet. Enter them on Record \u2192 Batch Day / Library Worksheets.</p>')
      + '<p class="who" style="margin-top:10px">Planned reagent quantities &amp; cost are on Plan \u2192 Reagents &amp; cost.</p>';
  }
  // ===== General notes: rich-text editor (Record) + read-only view (Review) =====
  const NOTES_CMDS = [
    { cmd: 'bold', label: 'B', style: 'font-weight:700' },
    { cmd: 'italic', label: 'I', style: 'font-style:italic' },
    { cmd: 'underline', label: 'U', style: 'text-decoration:underline' },
    { cmd: 'insertUnorderedList', label: '\u2022 List' },
    { cmd: 'insertOrderedList', label: '1. List' }
  ];
  function renderNotes() {
    const host = $('#recNotesContent'); if (!host) return;
    const rec = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    if (!rec) { host.innerHTML = '<h2>General notes</h2><p class="empty">Select a project and experiment in the sidebar first.</p>'; return; }
    const toolbar = NOTES_CMDS.map((c) => '<button type="button" class="nt-btn" data-cmd="' + c.cmd + '"' + (c.style ? ' style="' + c.style + '"' : '') + '>' + esc(c.label) + '</button>').join('')
      + '<select class="nt-size" title="Font size"><option value="">Size</option><option value="2">Small</option><option value="3">Normal</option><option value="5">Large</option><option value="6">X-Large</option></select>'
      + '<button type="button" class="nt-btn" data-cmd="formatBlock" data-val="h3">H</button>'
      + '<button type="button" class="nt-btn" data-cmd="removeFormat">Clear</button>';
    host.innerHTML = '<h2>General notes <span class="who">' + esc(rec.name || '') + '</span></h2>'
      + '<p class="step-hint">Free-form notes for this experiment. Formatting (bold, lists, size\u2026) is saved with the experiment and shown on Review \u2192 General notes.</p>'
      + '<div class="nt-toolbar">' + toolbar + '</div>'
      + '<div id="ntEditor" class="nt-editor" contenteditable="true"></div>'
      + '<div class="row-actions" style="margin-top:8px"><button class="btn primary" id="ntSave">Save notes</button><span id="ntStatus" class="muted"></span></div>';
    const ed = $('#ntEditor'); if (ed) ed.innerHTML = rec.notesHtml || '';
    host.querySelectorAll('.nt-btn').forEach((b) => b.addEventListener('mousedown', (e) => { e.preventDefault(); ed.focus(); document.execCommand(b.dataset.cmd, false, b.dataset.val || null); }));
    const sizeSel = host.querySelector('.nt-size');
    if (sizeSel) sizeSel.addEventListener('change', () => { if (!sizeSel.value) return; ed.focus(); document.execCommand('fontSize', false, sizeSel.value); sizeSel.value = ''; });
    const save = $('#ntSave'); if (save) save.addEventListener('click', () => {
      rec.notesHtml = ed.innerHTML; rec.notesUpdated = new Date().toISOString().slice(0, 16).replace('T', ' ');
      Store.saveExperiment(rec); const st = $('#ntStatus'); if (st) st.textContent = ' Saved.';
    });
  }
  function renderNotesReview() {
    const host = $('#revNotesContent'); if (!host) return;
    const rec = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    if (!rec) { host.innerHTML = '<h2>General notes</h2><p class="empty">Select a project and experiment in the sidebar first.</p>'; return; }
    host.innerHTML = '<h2>General notes <span class="who">' + esc(rec.name || '') + '</span></h2>'
      + (rec.notesUpdated ? '<p class="who">Last updated ' + esc(rec.notesUpdated) + '</p>' : '')
      + (rec.notesHtml ? '<div class="nt-view">' + rec.notesHtml + '</div>' : '<p class="empty">No notes yet. Add them on Record \u2192 General notes.</p>');
  }

  // ===== Library status tracker: one row per library (grouped by modality -> type),
  // pulling in Qubit + TapeStation conc/traces, with editable status/cycles and a
  // repeatable "attempts" log for libraries prepped more than once. =====
  const LIB_ARM_TYPES = {
    "5' unsort": ['GEX', 'ADT/CSP', 'TCR', 'BCR', 'HTO'],
    'ASAP': ['ATAC', 'ADT', 'HTO'],
    "5' sort": ['GEX', 'ADT/CSP', 'TCR', 'BCR']
  };
  const LIB_STATUSES = ['In progress', 'Good', 'Needs re-prep'];
  function libStatusRows(rec) {
    // present arms from the plan + any arms/types seen in TapeStation
    const arms = []; const byArm = {};
    let lanes = { unsort: 0, asap: 0, sort: 0 };
    try { const c = computePooling(); lanes = laneOverridesFromCost(c.samples.length, (c.poolRes && c.poolRes.nPools) || 0, c.samples) || lanes; } catch (e) { /* */ }
    const addArm = (a) => { if (!byArm[a]) { byArm[a] = []; arms.push(a); } };
    if (lanes.unsort > 0) addArm("5' unsort");
    if (lanes.asap > 0) addArm('ASAP');
    if (lanes.sort > 0) addArm("5' sort");
    arms.forEach((a) => { (LIB_ARM_TYPES[a] || []).forEach((t) => { if (byArm[a].indexOf(t) < 0) byArm[a].push(t); }); });
    // fold in any TapeStation-tagged (arm,type) not already listed
    (rec.tapestation || []).forEach((run) => (run.wells || []).forEach((w) => { if (w.arm && w.sampleType) { addArm(w.arm); if (byArm[w.arm].indexOf(w.sampleType) < 0) byArm[w.arm].push(w.sampleType); } }));
    return { arms: arms, byArm: byArm };
  }
  const LIB_PREFIX = { "5' unsort": 'U', 'ASAP': 'A', "5' sort": 'S' };
  // Enumerate every individual library (per lane) grouped by modality -> type.
  function libStatusLibs(rec) {
    const { arms, byArm } = libStatusRows(rec);
    let lanes = { unsort: 0, asap: 0, sort: 0 };
    try { const c = computePooling(); lanes = laneOverridesFromCost(c.samples.length, (c.poolRes && c.poolRes.nPools) || 0, c.samples) || lanes; } catch (e) { /* */ }
    const laneCount = (arm) => arm === 'ASAP' ? (lanes.asap || 0) : (arm === "5' sort" ? (lanes.sort || 0) : (lanes.unsort || 0));
    const out = [];
    arms.forEach((arm) => {
      const pfx = LIB_PREFIX[arm] || '';
      byArm[arm].forEach((type) => {
        const n = laneCount(arm) || 1;
        const libs = [];
        for (let i = 1; i <= n; i++) libs.push({ arm: arm, type: type, laneNo: i, id: pfx + i + '-' + type, name: arm + ' ' + pfx + i + '-' + type });
        out.push({ arm: arm, type: type, libs: libs });
      });
    });
    return out;
  }
  function renderLibStatus(hostId, editable) {
    const host = $('#' + hostId); if (!host) return;
    const rec = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    if (!rec) { host.innerHTML = '<h2>Library status</h2><p class="empty">Select a project and experiment in the sidebar first.</p>'; return; }
    rec.libStatus = rec.libStatus || {};
    const groups = libStatusLibs(rec);
    if (!groups.length) { host.innerHTML = '<h2>Library status</h2><p class="empty">Build a plan (and/or upload TapeStation) so libraries can be listed here.</p>'; return; }
    // TapeStation index by arm|type|laneNo
    const tsIdx = {};
    (rec.tapestation || []).forEach((run) => (run.wells || []).forEach((w) => { const k = (w.arm || '') + '|' + (w.sampleType || '') + '|' + (w.sampleNo || ''); if (!tsIdx[k]) tsIdx[k] = { conc: w.conc || '', img: (w.imgFileId || w.imgKey || w.img) ? w : null }; }));
    // Qubit index: all qubit rows across the 4 tables; match by tube ID containing the lib id
    const qAll = []; const qt = (rec.worksheets && rec.worksheets.library && rec.worksheets.library.qubit) || {};
    if (qt && !Array.isArray(qt)) QUBIT_TABLES.forEach((t) => (qt[t.key] || []).forEach((r) => { if (r && r[0]) qAll.push({ tube: String(r[0]), conc: r[2] || '', stage: t.title }); }));
    const qubitFor = (lib) => qAll.filter((q) => q.tube.toUpperCase().indexOf(lib.id.toUpperCase()) >= 0);

    const inp = (cls, k, val, w, ph) => editable ? ('<input class="' + cls + '" data-k="' + escAttr(k) + '" value="' + escAttr(val || '') + '" style="width:' + (w || 90) + 'px"' + (ph ? ' placeholder="' + ph + '"' : '') + '>') : esc(val || '\u2014');
    const statusSel = (k, val) => editable
      ? '<select class="lib-st" data-k="' + escAttr(k) + '">' + ['In progress', 'Good', 'Needs re-prep'].map((o) => '<option' + (val === o ? ' selected' : '') + '>' + o + '</option>').join('') + '</select>'
      : '<span class="lib-pill ' + (val === 'Good' ? 'ok' : (val === 'Needs re-prep' ? 'bad' : 'wip')) + '">' + esc(val || 'In progress') + '</span>';

    let body = '';
    groups.forEach((g, gi) => {
      const gkey = g.arm + '|' + g.type;
      const open = !!LIBSTATUS_OPEN[gkey];
      // summary of statuses in the group
      const counts = { Good: 0, 'Needs re-prep': 0, 'In progress': 0 };
      g.libs.forEach((l) => { const st = (rec.libStatus[l.id] && rec.libStatus[l.id].status) || 'In progress'; counts[st] = (counts[st] || 0) + 1; });
      const summary = Object.keys(counts).filter((c) => counts[c]).map((c) => counts[c] + ' ' + c).join(' \u00b7 ');
      body += '<div class="lib-group"><div class="lib-group-head" data-lib-grp="' + escAttr(gkey) + '"><span class="lib-caret">' + (open ? '\u25be' : '\u25b8') + '</span> <strong>' + esc(g.arm + ' \u2014 ' + g.type) + '</strong> <span class="who">(' + g.libs.length + ' librar' + (g.libs.length === 1 ? 'y' : 'ies') + ' \u00b7 ' + summary + ')</span></div>';
      if (open) {
        body += '<div style="overflow:auto"><table class="cost-table"><thead><tr><th>Library</th><th>Status</th><th class="num">Cycles</th><th>Qubit (ng/µL)</th><th class="num">TapeStation</th><th>Trace</th><th>Attempts</th><th>Note</th></tr></thead><tbody>';
        g.libs.forEach((l) => {
          const st = rec.libStatus[l.id] || {};
          const ts = tsIdx[l.arm + '|' + l.type + '|' + l.laneNo] || { conc: '', img: null };
          const qb = qubitFor(l).map((q) => esc(q.conc) + ' <span class="who">(' + esc(q.stage.replace('Final ', '').replace(' libraries', '')) + ')</span>').join('<br>');
          const trace = ts.img ? '<img src="' + tsGetImgSrc(ts.img) + '" class="ts-zoom lib-thumb" data-caption="' + escAttr(l.name) + '" loading="lazy">' : '\u2014';
          const nAtt = (st.attempts || []).length;
          const attBtn = editable ? ('<button class="btn tiny" data-lib-att="' + escAttr(l.id) + '">' + (nAtt ? nAtt + ' \u25be' : '+ log') + '</button>') : (nAtt ? ('<button class="btn tiny" data-lib-att="' + escAttr(l.id) + '">' + nAtt + ' \u25be</button>') : '\u2014');
          body += '<tr><td><strong>' + esc(l.id) + '</strong></td>'
            + '<td>' + statusSel(l.id, st.status) + '</td>'
            + '<td class="num">' + inp('lib-cyc', l.id, st.cycles, 56) + '</td>'
            + '<td class="who">' + (qb || '\u2014') + '</td>'
            + '<td class="num">' + (ts.conc || '\u2014') + '</td>'
            + '<td>' + trace + '</td>'
            + '<td>' + attBtn + '</td>'
            + '<td class="who">' + inp('lib-note', l.id, st.note, 150, 'note') + '</td></tr>';
          if (LIBSTATUS_OPEN['A:' + l.id]) {
            const att = st.attempts || [];
            body += '<tr class="lib-att-row"><td></td><td colspan="7"><div class="lib-att"><table class="cost-table"><thead><tr><th>#</th><th>Date</th><th>Stage</th><th>Qubit</th><th class="num">Cycles</th><th>Status</th><th>Note</th>' + (editable ? '<th></th>' : '') + '</tr></thead><tbody>'
              + att.map((a, ai) => '<tr><td>' + (ai + 1) + '</td>'
                  + ['date', 'stage', 'qubit', 'cycles', 'status', 'note'].map((f) => '<td' + (f === 'cycles' ? ' class="num"' : '') + '>' + (editable ? '<input class="la-f" data-k="' + escAttr(l.id) + '" data-i="' + ai + '" data-f="' + f + '" value="' + escAttr(a[f] || '') + '" style="width:' + (f === 'note' ? 140 : (f === 'cycles' ? 50 : 90)) + 'px">' : esc(a[f] || '\u2014')) + '</td>').join('')
                  + (editable ? '<td><button class="btn tiny" data-la-del="' + escAttr(l.id) + '" data-i="' + ai + '">\u2715</button></td>' : '') + '</tr>').join('')
              + '</tbody></table>' + (editable ? '<div class="row-actions" style="margin-top:6px"><button class="btn ghost tiny" data-la-add="' + escAttr(l.id) + '">+ Add attempt</button></div>' : '') + '</div></td></tr>';
          }
        });
        body += '</tbody></table></div>';
      }
      body += '</div>';
    });
    host.innerHTML = '<h2>Library status <span class="who">' + esc(rec.name || '') + '</span></h2>'
      + '<p class="step-hint">' + (editable ? 'Track every library through prep. Click a modality/type to expand its libraries; set status/cycles/notes and log repeated preps under <em>Attempts</em>. Qubit + TapeStation are pulled in automatically.' : 'Read-only view. Edit on Record \u2192 Library status.') + '</p>' + body;

    host.querySelectorAll('[data-lib-grp]').forEach((el) => el.addEventListener('click', () => { const k = el.dataset.libGrp; LIBSTATUS_OPEN[k] = !LIBSTATUS_OPEN[k]; renderLibStatus(hostId, editable); }));
    host.querySelectorAll('.ts-zoom').forEach((img) => img.addEventListener('click', () => openImageLightbox(img.src, img.getAttribute('data-caption') || '')));
    host.querySelectorAll('button[data-lib-att]').forEach((b) => b.addEventListener('click', () => { const k = 'A:' + b.dataset.libAtt; LIBSTATUS_OPEN[k] = !LIBSTATUS_OPEN[k]; if (editable && LIBSTATUS_OPEN[k]) { const id = b.dataset.libAtt; rec.libStatus[id] = rec.libStatus[id] || {}; rec.libStatus[id].attempts = rec.libStatus[id].attempts || []; if (!rec.libStatus[id].attempts.length) { rec.libStatus[id].attempts.push({ date: '', stage: '', qubit: '', cycles: '', status: '', note: '' }); Store.saveExperiment(rec); } } renderLibStatus(hostId, editable); }));
    if (!editable) return;
    const save = () => Store.saveExperiment(rec);
    host.querySelectorAll('.lib-st').forEach((el) => el.addEventListener('change', () => { const k = el.dataset.k; rec.libStatus[k] = rec.libStatus[k] || {}; rec.libStatus[k].status = el.value; save(); renderLibStatus(hostId, editable); }));
    host.querySelectorAll('.lib-cyc').forEach((el) => el.addEventListener('change', () => { const k = el.dataset.k; rec.libStatus[k] = rec.libStatus[k] || {}; rec.libStatus[k].cycles = el.value; save(); }));
    host.querySelectorAll('.lib-note').forEach((el) => el.addEventListener('change', () => { const k = el.dataset.k; rec.libStatus[k] = rec.libStatus[k] || {}; rec.libStatus[k].note = el.value; save(); }));
    host.querySelectorAll('.la-f').forEach((el) => el.addEventListener('change', () => { const k = el.dataset.k, i = +el.dataset.i, f = el.dataset.f; rec.libStatus[k].attempts[i][f] = el.value; save(); }));
    host.querySelectorAll('button[data-la-add]').forEach((b) => b.addEventListener('click', () => { const k = b.dataset.laAdd; rec.libStatus[k].attempts.push({ date: '', stage: '', qubit: '', cycles: '', status: '', note: '' }); save(); renderLibStatus(hostId, editable); }));
    host.querySelectorAll('button[data-la-del]').forEach((b) => b.addEventListener('click', () => { const k = b.dataset.laDel, i = +b.dataset.i; rec.libStatus[k].attempts.splice(i, 1); save(); renderLibStatus(hostId, editable); }));
  }

  function renderReviewWorksheets() {
    const host = $('#revWorksheetsContent'); if (!host) return;
    const rec = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    if (!rec) { host.innerHTML = '<h2>Worksheets</h2><p class="empty">Select a project and experiment in the sidebar first.</p>'; return; }
    const ws = rec.worksheets || {};
    let body = '';
    ['batchday', 'library'].forEach((type) => { const w = ws[type]; const cfg = WORKSHEET_CFG[type]; if (!w) return;
      body += '<h3>' + esc(cfg.title) + '</h3>';
      body += '<p class="who">Experiment ID: ' + esc(w.expId || '\u2014') + ' \u00b7 Operator: ' + esc(w.operator || '\u2014') + ' \u00b7 Date: ' + esc(w.date || '\u2014') + '</p>';
      const kr = (w.kits || []).filter((k) => k.lot || k.rxns).map((k) => '<tr><td>' + esc(k.kit) + '</td><td class="who">' + esc(k.pn || '') + '</td><td>' + esc(k.lot || '') + '</td><td class="num">' + esc(k.rxns || '') + '</td></tr>').join('');
      if (kr) body += '<h4>Kit lots</h4><table class="cost-table"><thead><tr><th>Kit</th><th>PN</th><th>Lot #</th><th class="num">Rxns</th></tr></thead><tbody>' + kr + '</tbody></table>';
      const rows = (w.counts || []).filter((r) => r.some((c) => c !== ''));
      if (rows.length) body += '<h4>Cell counts</h4><div style="overflow:auto"><table class="cost-table"><thead><tr>' + cfg.countCols.map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>' + rows.map((r) => '<tr>' + cfg.countCols.map((c, ci) => '<td>' + esc(r[ci] || '') + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
      if (w.notes) body += '<h4>Notes</h4><p class="who" style="white-space:pre-wrap">' + esc(w.notes) + '</p>';
      body += '<div style="margin-bottom:18px"></div>';
    });
    host.innerHTML = '<h2>Worksheets <span class="who">' + esc(rec.name || '') + '</span></h2>' + (body || '<p class="empty">Nothing recorded yet. Enter worksheet values on Record \u2192 Batch Day / Library Worksheets.</p>');
  }
  function renderReviewData() {
    const host = $('#revDataContent'); if (!host) return;
    const rec = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    if (!rec) { host.innerHTML = '<h2>Data \u2014 TapeStation traces</h2><p class="empty">Select a project and experiment in the sidebar first.</p>'; return; }
    const runs = rec.tapestation || [];
    if (!runs.length) { host.innerHTML = '<h2>Data \u2014 TapeStation traces</h2><p class="empty">No TapeStation runs yet. Upload them on Record \u2192 Tapestation Output.</p>'; return; }
    // flatten all lanes across runs
    const lanes = []; runs.forEach((r) => (r.wells || []).forEach((w) => lanes.push(Object.assign({}, w, { runName: r.runName }))));
    const arms = []; const types = [];
    lanes.forEach((w) => { if (w.arm && arms.indexOf(w.arm) < 0) arms.push(w.arm); if (w.sampleType && types.indexOf(w.sampleType) < 0) types.push(w.sampleType); });
    if (REV_TS_ARM !== 'all' && arms.indexOf(REV_TS_ARM) < 0) REV_TS_ARM = 'all';
    if (REV_TS_TYPE !== 'all' && types.indexOf(REV_TS_TYPE) < 0) REV_TS_TYPE = 'all';
    const shown = lanes.filter((w) => (REV_TS_ARM === 'all' || w.arm === REV_TS_ARM) && (REV_TS_TYPE === 'all' || w.sampleType === REV_TS_TYPE));
    // Only reorder when the user has actively filtered; otherwise keep the original
    // upload / chip-lane order (which is how the run was loaded).
    if (REV_TS_ARM !== 'all' || REV_TS_TYPE !== 'all') {
      shown.sort((a, b) => String(a.arm).localeCompare(String(b.arm)) || String(a.sampleType).localeCompare(String(b.sampleType)) || (Number(a.sampleNo) || 0) - (Number(b.sampleNo) || 0));
    }

    const armBtns = '<button class="btn ' + (REV_TS_ARM === 'all' ? 'primary' : 'ghost') + '" data-rev-arm="all">All sections</button> ' + arms.map((a) => '<button class="btn ' + (REV_TS_ARM === a ? 'primary' : 'ghost') + '" data-rev-arm="' + escAttr(a) + '">' + esc(a) + '</button>').join(' ');
    const typeBtns = '<button class="btn ' + (REV_TS_TYPE === 'all' ? 'primary' : 'ghost') + '" data-rev-type="all">All types</button> ' + types.map((t) => '<button class="btn ' + (REV_TS_TYPE === t ? 'primary' : 'ghost') + '" data-rev-type="' + escAttr(t) + '">' + esc(t) + '</button>').join(' ');

    const minBp = REV_TS_MIN === '' ? null : Number(REV_TS_MIN);
    const maxBp = REV_TS_MAX === '' ? null : Number(REV_TS_MAX);
    const hasPeaks = shown.some((w) => (w.peaks || []).length);
    let body = '';
    if (REV_TS_VIEW === 'summary') {
      const regionUI = hasPeaks
        ? '<div class="callout info" style="margin-bottom:10px"><strong>Library region:</strong> restrict the concentration to a bp range and multiply by dilution to get total library concentration. '
          + 'From <input id="tsMin" type="number" placeholder="min bp" value="' + escAttr(REV_TS_MIN) + '" style="width:80px"> to <input id="tsMax" type="number" placeholder="max bp" value="' + escAttr(REV_TS_MAX) + '" style="width:80px"> bp '
          + '<button class="btn ghost tiny" id="tsRegionApply">Apply</button> <button class="btn ghost tiny" id="tsRegionClear">Whole trace</button></div>'
        : '<p class="who">Upload the run\u2019s compactPeakTable.csv (or the full zip) to enable bp-range region concentrations.</p>';
      const rows = shown.map((w) => {
        const dil = tsDilFactor(w.dilution); const reg = tsRegion(w.peaks, minBp, maxBp);
        const hasReg = (w.peaks || []).length > 0; const regConc = hasReg ? reg.conc : null;
        const totalLibNg = regConc != null ? (regConc * dil) / 1000 : null;
        return '<tr><td>' + esc(w.name || w.description || '') + '</td><td>' + esc(w.arm || '') + '</td><td>' + esc(w.sampleType || '') + '</td><td class="num">' + esc(w.well) + '</td>'
          + '<td class="num">' + esc(w.conc) + '</td><td>' + esc(w.dilution || '') + '</td>'
          + '<td class="num">' + (regConc != null ? Math.round(regConc * 10) / 10 : '\u2014') + '</td>'
          + '<td class="num">' + (reg.avgBp != null ? reg.avgBp : '\u2014') + '</td>'
          + '<td class="num"><strong>' + (totalLibNg != null ? Math.round(totalLibNg * 100) / 100 : '\u2014') + '</strong></td>'
          + '<td class="who">' + esc(w.runName || '') + (w.note ? ' \u00b7 ' + esc(w.note) : '') + '</td></tr>';
      }).join('');
      body = regionUI + '<table class="cost-table"><thead><tr><th>Full ID</th><th>Section</th><th>Type</th><th class="num">Well</th><th class="num">Trace conc [pg/\u00b5l]</th><th>Dilution</th><th class="num">Region conc [pg/\u00b5l]</th><th class="num">Avg bp</th><th class="num">Total library [ng/\u00b5l]</th><th>Run / notes</th></tr></thead><tbody>' + rows + '</tbody></table>';
    } else {
      // Trace images grouped by section + sample type (e.g. "5' unsort GEX"), sorted by well within each.
      const bySec = {}; const secOrder = [];
      shown.forEach((w) => { const s = ((w.arm || 'Unassigned') + (w.sampleType ? ' ' + w.sampleType : '')).trim(); if (!bySec[s]) { bySec[s] = []; secOrder.push(s); } bySec[s].push(w); });
      secOrder.sort();
      const wellKey = (w) => { const m = String(w.well || '').match(/^([A-Za-z]+)(\d+)$/); return m ? [m[1], parseInt(m[2], 10)] : [String(w.well || ''), 0]; };
      secOrder.forEach((s) => bySec[s].sort((a, b) => { const ka = wellKey(a), kb = wellKey(b); return ka[0] < kb[0] ? -1 : (ka[0] > kb[0] ? 1 : ka[1] - kb[1]); }));
      body = secOrder.map((s) => '<h3 style="margin:14px 0 6px">' + esc(s) + '</h3><div class="ts-traces">'
        + bySec[s].map((w) => { const src = tsGetImgSrc(w); if (!src) return '';
            const fullId = w.name || w.description || w.well;
            const cap = fullId + (w.note ? ' \u2014 ' + w.note : '') + (w.dilution ? ' \u00b7 dil ' + w.dilution : '');
            return '<figure class="ts-trace"><img src="' + src + '" class="ts-zoom" tabindex="0" loading="lazy" data-caption="' + escAttr(cap) + '"><figcaption>' + esc(fullId) + (w.dilution ? ' \u00b7 ' + esc(w.dilution) : '') + '</figcaption></figure>'; }).join('')
        + '</div>').join('');
    }
    host.innerHTML = '<h2>Tapestation traces <span class="who">' + esc(rec.name || '') + '</span></h2>'
      + '<div class="row-actions" style="margin:4px 0 6px">' + armBtns + '</div>'
      + '<div class="row-actions" style="margin:0 0 10px">' + typeBtns + '</div>'
      + '<div class="row-actions" style="margin:0 0 12px"><button class="btn ' + (REV_TS_VIEW === 'summary' ? 'primary' : 'ghost') + '" data-rev-view="summary">Concentration summary</button> <button class="btn ' + (REV_TS_VIEW === 'traces' ? 'primary' : 'ghost') + '" data-rev-view="traces">Trace images</button></div>'
      + body;
    host.querySelectorAll('button[data-rev-arm]').forEach((b) => b.addEventListener('click', () => { REV_TS_ARM = b.dataset.revArm; renderReviewData(); }));
    host.querySelectorAll('button[data-rev-type]').forEach((b) => b.addEventListener('click', () => { REV_TS_TYPE = b.dataset.revType; renderReviewData(); }));
    host.querySelectorAll('button[data-rev-view]').forEach((b) => b.addEventListener('click', () => { REV_TS_VIEW = b.dataset.revView; renderReviewData(); }));
    const apply = $('#tsRegionApply'); if (apply) apply.addEventListener('click', () => { REV_TS_MIN = ($('#tsMin').value || '').trim(); REV_TS_MAX = ($('#tsMax').value || '').trim(); renderReviewData(); });
    const clr = $('#tsRegionClear'); if (clr) clr.addEventListener('click', () => { REV_TS_MIN = ''; REV_TS_MAX = ''; renderReviewData(); });
    host.querySelectorAll('.ts-zoom').forEach((img) => img.addEventListener('click', () => openImageLightbox(img.src, img.getAttribute('data-caption') || '')));
  }
  // ===== Sort summary: drag-drop Sony sort report PDFs, parse the Sorting Result
  // table (Sort Gate = population, Total Event = cells sorted, Sorted Count), tag
  // each with a tube # + note, store to Drive + on the record. =====
  const SORT_GATES = ['HSPCs', 'Tregs', 'cDCs', 'pDCs'];
  function sortNum(x) { const n = Number(String(x == null ? '' : x).replace(/,/g, '').trim()); return isNaN(n) ? 0 : n; }
  let SORT_PENDING = null;   // { fileName, base64, tube, note, rows:[{tube(collection),gate,totalEvent,sortedCount}] }
  async function parseSortPdf(arrayBuffer) {
    if (!window.pdfjsLib) throw new Error('PDF reader not loaded \u2014 reload the page.');
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;   // copy: getDocument detaches its buffer
    const out = []; const seen = {}; let sortPage = pdf.numPages;
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      if (tc.items.some((it) => /sorting result/i.test(it.str))) sortPage = p;
      const items = tc.items.map((it) => ({ str: it.str, x: it.transform[4], y: Math.round(it.transform[5]) }));
      const byY = {}; items.forEach((it) => { (byY[it.y] = byY[it.y] || []).push(it); });
      Object.keys(byY).map(Number).sort((a, b) => b - a).forEach((y) => {
        const cells = byY[y].sort((a, b) => a.x - b.x).map((it) => it.str.trim()).filter((s) => s !== '');
        const text = cells.join(' ');
        // Collection tube | Sort Gate | Sort Mode | Elapsed | Total Event | Target Ratio | Sorted Count | ...
        const m = text.match(/^(Far Left|Far Right|Left|Right)\s+(\S+)\s+\S+\s+[\d:]+\s+([\d,]+)\s+[\d.]+%\s+([\d,]+)/);
        if (m) {
          const key = m[1] + '|' + m[2] + '|' + m[4];
          if (!seen[key]) { seen[key] = 1; out.push({ collection: m[1], gate: m[2], totalEvent: m[3].replace(/,/g, ''), sortedCount: m[4].replace(/,/g, '') }); }
        }
      });
    }
    // Render the Sorting Result page as an image (the table is usually a raster, so
    // this lets the user read the values and enter them by hand).
    let pageImg = '';
    try {
      const page = await pdf.getPage(sortPage);
      const vp = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas'); canvas.width = vp.width; canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      pageImg = canvas.toDataURL('image/png');
    } catch (e) { /* preview optional */ }
    return { rows: out, pageImg: pageImg };
  }
  function renderSortRecord() {
    const host = $('#recSortContent'); if (!host) return;
    const rec = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    if (!rec) { host.innerHTML = '<h2>Sort summary</h2><p class="empty">Select a project and experiment in the sidebar first.</p>'; return; }
    const saved = rec.sortReports || [];
    const savedList = saved.length
      ? '<h3>Saved sorts (' + saved.length + ')</h3><table class="cost-table"><thead><tr><th>Tube #</th><th>File</th><th class="num">Populations</th><th>Note</th><th>PDF</th><th></th></tr></thead><tbody>'
        + saved.map((r, i) => '<tr><td class="num">' + esc(r.tube || '') + '</td><td class="who">' + esc(r.fileName || '') + '</td><td class="num">' + (r.rows || []).length + '</td><td class="who">' + esc(r.note || '') + '</td><td>' + (r.pdfId ? '<a href="https://drive.google.com/file/d/' + escAttr(r.pdfId) + '/view" target="_blank" rel="noopener">Open</a>' : '\u2014') + '</td><td><button class="btn tiny" data-sort-del="' + i + '">\u2715</button></td></tr>').join('')
        + '</tbody></table>'
      : '<p class="muted">No sort reports saved yet.</p>';
    let editUI = '';
    if (SORT_PENDING) {
      const rows = SORT_PENDING.rows.map((r, i) => { const isOther = r.gate && SORT_GATES.indexOf(r.gate) < 0;
        const gateOpts = '<option value="">\u2014</option>' + SORT_GATES.map((g) => '<option' + (r.gate === g ? ' selected' : '') + '>' + esc(g) + '</option>').join('') + '<option value="__other__"' + (isOther ? ' selected' : '') + '>Other\u2026</option>';
        const tot = sortNum(r.totalEvent), cnt = sortNum(r.sortedCount);
        return '<tr><td>' + esc(r.collection) + '</td>'
        + '<td><select class="sort-gate" data-i="' + i + '">' + gateOpts + '</select>'
        + '<input class="sort-gate-other" data-i="' + i + '" value="' + escAttr(isOther ? r.gate : '') + '" placeholder="name" style="width:90px;margin-left:4px;' + (isOther ? '' : 'display:none') + '"></td>'
        + '<td class="num"><input class="sort-tot" data-i="' + i + '" value="' + escAttr(r.totalEvent) + '" style="width:120px"></td>'
        + '<td class="num"><input class="sort-cnt" data-i="' + i + '" value="' + escAttr(r.sortedCount) + '" style="width:110px"></td>'
        + '<td class="num">' + (tot > 0 ? (Math.round(cnt / tot * 1e6) / 1e4) + '%' : '\u2014') + '</td></tr>'; }).join('');
      editUI = '<h3>This sort <span class="who">' + esc(SORT_PENDING.manual ? 'manual entry (no file)' : SORT_PENDING.fileName) + '</span></h3>'
        + '<div class="row-actions" style="margin:6px 0"><label>Sample tube # <input id="sortTube" style="width:80px" value="' + escAttr(SORT_PENDING.tube || '') + '"></label> <label>Note <input id="sortNote" style="width:280px" value="' + escAttr(SORT_PENDING.note || '') + '"></label></div>'
        + (SORT_PENDING.autoParsed
            ? '<p class="step-hint">Auto-parsed from the Sorting Result table \u2014 verify/edit.</p>'
            : '<p class="step-hint">This sorter report\u2019s Sorting Result table is a <strong>page image</strong>, so it can\u2019t be auto-read \u2014 enter the values from the preview below. <strong>Total event</strong> = cells processed from this sample, <strong>Sorted count</strong> = cells of that population collected.</p>')
        + '<table class="cost-table"><thead><tr><th>Collection tube</th><th>Sort gate (population)</th><th class="num">Total event</th><th class="num">Sorted count</th><th class="num">% of total</th></tr></thead><tbody>' + rows + '</tbody></table>'
        + (SORT_PENDING.pageImg ? '<h4 style="margin:14px 0 4px">Report preview \u2014 read the Sorting Result table</h4>'
            + '<img src="' + SORT_PENDING.pageImg + '" class="ts-zoom" style="max-width:100%;border:1px solid #e4e9ef;border-radius:6px;cursor:zoom-in">' : '')
        + '<div class="row-actions" style="margin-top:12px"><button class="btn primary" id="sortSave">' + (SORT_PENDING.manual ? 'Save sort' : 'Save sort + upload PDF') + '</button> <button class="btn ghost" id="sortCancel">Cancel</button></div>'
        + '<div id="sortStatus" class="muted" style="margin-top:8px"></div>';
    }
    host.innerHTML = '<h2>Sort summary <span class="who">' + esc(rec.name || '') + '</span></h2>'
      + '<p class="step-hint">Drag a sorter report <strong>.pdf</strong> (one per sample tube) here \u2014 or enter the numbers by hand if you don\u2019t have the file.</p>'
      + '<div class="row-actions" style="margin:0 0 10px"><button class="btn ghost" id="sortReload">Reload from Drive</button><button class="btn" id="sortManual">Enter manually (no file)</button><span id="sortReloadStatus" class="muted"></span></div>'
      + '<div id="sortDrop" class="cc-drop">Drop a sort report .pdf here, or click to browse<input type="file" id="sortFile" accept=".pdf" hidden></div>'
      + editUI + '<div style="margin-top:20px"></div>' + savedList;

    const drop = $('#sortDrop'), fileInput = $('#sortFile');
    const onFile = (f) => { if (!f) return;
      f.arrayBuffer().then((buf) => parseSortPdf(buf).then((res) => {
        let rows = res.rows || [];
        if (!rows.length) { rows = ['Far Left', 'Left', 'Right', 'Far Right'].map((c) => ({ collection: c, gate: '', totalEvent: '', sortedCount: '' })); }
        SORT_PENDING = { fileName: f.name, base64: bufToB64(buf), tube: '', note: '', rows: rows, pageImg: res.pageImg || '', autoParsed: (res.rows || []).length > 0 };
        renderSortRecord();
      })).catch((e) => alert('Could not read that PDF: ' + e));
    };
    if (drop) {
      drop.addEventListener('click', () => fileInput && fileInput.click());
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
      drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); onFile(e.dataTransfer.files[0]); });
    }
    if (fileInput) fileInput.addEventListener('change', () => onFile(fileInput.files[0]));
    const manualBtn = $('#sortManual'); if (manualBtn) manualBtn.addEventListener('click', () => {
      SORT_PENDING = { fileName: '', base64: '', tube: '', note: '', pageImg: '', autoParsed: false, manual: true,
        rows: ['Far Left', 'Left', 'Right', 'Far Right'].map((c) => ({ collection: c, gate: '', totalEvent: '', sortedCount: '' })) };
      renderSortRecord();
    });
    const tubeInp = $('#sortTube'); if (tubeInp) tubeInp.addEventListener('input', () => { SORT_PENDING.tube = tubeInp.value; });
    const noteInp = $('#sortNote'); if (noteInp) noteInp.addEventListener('input', () => { SORT_PENDING.note = noteInp.value; });
    host.querySelectorAll('.sort-gate').forEach((el) => el.addEventListener('change', () => {
      const i = +el.dataset.i; const other = host.querySelector('.sort-gate-other[data-i="' + i + '"]');
      if (el.value === '__other__') { if (other) { other.style.display = ''; other.focus(); } SORT_PENDING.rows[i].gate = (other && other.value) || ''; }
      else { if (other) other.style.display = 'none'; SORT_PENDING.rows[i].gate = el.value; }
    }));
    host.querySelectorAll('.sort-gate-other').forEach((el) => el.addEventListener('input', () => { SORT_PENDING.rows[+el.dataset.i].gate = el.value; }));
    host.querySelectorAll('.sort-tot').forEach((el) => el.addEventListener('input', () => { SORT_PENDING.rows[+el.dataset.i].totalEvent = el.value; }));
    host.querySelectorAll('.sort-cnt').forEach((el) => el.addEventListener('input', () => { SORT_PENDING.rows[+el.dataset.i].sortedCount = el.value; }));
    const cancel = $('#sortCancel'); if (cancel) cancel.addEventListener('click', () => { SORT_PENDING = null; renderSortRecord(); });
    const save = $('#sortSave'); if (save) save.addEventListener('click', () => saveSortReport(rec));
    const sortReload = $('#sortReload'); if (sortReload) sortReload.addEventListener('click', () => reloadSortFromDrive(rec));
    host.querySelectorAll('.ts-zoom').forEach((img) => img.addEventListener('click', () => openImageLightbox(img.src)));
    host.querySelectorAll('button[data-sort-del]').forEach((b) => b.addEventListener('click', () => {
      const i = +b.dataset.sortDel; if (rec.sortReports && !isNaN(i)) { rec.sortReports.splice(i, 1); Store.saveExperiment(rec); renderSortRecord(); }
    }));
  }
  function reloadSortFromDrive(rec) {
    const stEl = $('#sortReloadStatus'); if (stEl) stEl.textContent = ' Reading Drive\u2026';
    const req = rec.driveFolderId ? { action: 'getSort', parentId: rec.driveFolderId } : { action: 'getSort', project: rec.project || CURRENT_PROJECT, experiment: rec.name || 'Experiment' };
    driveApi(req).then((res) => {
      if (!res || !res.ok) throw new Error('no response');
      const reports = res.reports || []; const pdfs = res.pdfs || {};
      if (!reports.length) { if (stEl) stEl.textContent = ' No sort summary found in Drive for this experiment.'; return; }
      rec.sortReports = reports.map((rep) => ({ tube: rep.tube || '', note: rep.note || '', fileName: rep.fileName || '', pdfId: pdfs[rep.fileName] || '',
        rows: (rep.rows || []).map((r) => ({ collection: r.collection || '', gate: r.gate || '', totalEvent: Number(r.totalEvent) || 0, sortedCount: Number(r.sortedCount) || 0 })) }));
      Store.saveExperiment(rec);
      if (stEl) stEl.textContent = ' Loaded ' + rec.sortReports.length + ' report(s) from Drive.';
      renderSortRecord();
    }).catch((e) => { if (stEl) stEl.textContent = ' Reload failed: ' + e; });
  }
  function saveSortReport(rec) {
    if (!SORT_PENDING) return;
    const stEl = $('#sortStatus');
    const tube = (SORT_PENDING.tube || '').trim();
    const expId = rec.experimentId || projectLabel(rec.name || 'experiment');
    const manual = !!SORT_PENDING.manual || !SORT_PENDING.base64;
    const fileName = manual ? '' : sanitizeName(expId + ' sort' + (tube ? ' tube ' + tube : '') + ' - ' + SORT_PENDING.fileName.replace(/\.pdf$/i, '')) + '.pdf';
    const hasRows = SORT_PENDING.rows.some((r) => r.gate || r.totalEvent || r.sortedCount);
    if (!hasRows) { stEl.textContent = 'Enter at least one population + count first.'; return; }
    if (!confirm(manual ? 'Save these sort numbers to the experiment?' : ('Save this sort report to the experiment\u2019s data/sort folder as \u201c' + fileName + '\u201d (overwrites a same-named file)?'))) return;
    stEl.textContent = 'Saving\u2026';
    const req = rec.driveFolderId
      ? { action: 'ensurePath', parentId: rec.driveFolderId, subPath: ['data', 'sort'] }
      : { action: 'ensurePath', project: rec.project || CURRENT_PROJECT, experiment: rec.name || 'Experiment', subPath: ['data', 'sort'] };
    driveApi(req)
      .then((path) => {
        if (path && path.experimentId && rec.driveFolderId !== path.experimentId) { rec.driveFolderId = path.experimentId; }
        if (!path || !path.subId) throw new Error('could not reach the experiment\u2019s data/sort folder');
        SORT_PENDING._folderId = path.subId;
        if (manual) return Promise.resolve(null);   // no PDF to upload
        return driveApi({ action: 'upload', name: fileName, folderId: path.subId, base64: SORT_PENDING.base64, sourceMime: 'application/pdf' });
      })
      .then((up) => {
        rec.sortReports = rec.sortReports || [];
        rec.sortReports.push({ tube: tube, note: SORT_PENDING.note || '', fileName: fileName, pdfId: (up && up.id) || '', manual: manual, savedAt: new Date().toISOString().slice(0, 10),
          rows: SORT_PENDING.rows.map((r) => ({ collection: r.collection, gate: r.gate, totalEvent: sortNum(r.totalEvent), sortedCount: sortNum(r.sortedCount) })) });
        Store.saveExperiment(rec);
        // durable sort-summary Google Sheet (all tubes) \u2014 source of truth + read-back
        stEl.textContent = 'Saving sort summary\u2026';
        const rows = [['Tube #', 'Note', 'PDF', 'Collection tube', 'Sort gate', 'Total event', 'Sorted count']];
        rec.sortReports.forEach((rep) => (rep.rows || []).forEach((r) => rows.push([rep.tube || '', rep.note || '', rep.fileName || '', r.collection || '', r.gate || '', r.totalEvent || 0, r.sortedCount || 0])));
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sort summary');
        const expId2 = rec.experimentId || projectLabel(rec.name || 'experiment');
        return driveApi({ action: 'upload', name: sanitizeName(expId2 + ' sort summary'), folderId: SORT_PENDING._folderId, base64: XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }), sourceMime: XLSX_MIME, targetMime: GSHEET_MIME });
      })
      .then(() => { SORT_PENDING = null; renderSortRecord(); })
      .catch((e) => { stEl.textContent = 'Save failed: ' + e; });
  }
  // ---- Review -> Sort: per-tube counts + combined by population + percentages ----
  function renderReviewSort() {
    const host = $('#revSortContent'); if (!host) return;
    const rec = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    if (!rec) { host.innerHTML = '<h2>Sort</h2><p class="empty">Select a project and experiment in the sidebar first.</p>'; return; }
    const reports = rec.sortReports || [];
    if (!reports.length) { host.innerHTML = '<h2>Sort</h2><p class="empty">No sort reports yet. Upload them on Record \u2192 Sort summary.</p>'; return; }
    // per-tube rows + combine by gate
    const perTube = []; const byGate = {}; let grandTotalEvents = 0; const tubeTotals = {};
    reports.forEach((r, ri) => {
      const tubeKey = 'r' + ri;   // each report is its own tube (manual entries may share a blank tube #)
      (r.rows || []).forEach((row) => {
        perTube.push({ tube: r.tube, collection: row.collection, gate: row.gate, totalEvent: row.totalEvent, sortedCount: row.sortedCount });
        if (!byGate[row.gate]) byGate[row.gate] = { sorted: 0, tubeTotals: {} };
        byGate[row.gate].sorted += row.sortedCount || 0;
        if (row.totalEvent > 0) byGate[row.gate].tubeTotals[tubeKey] = row.totalEvent;   // only tubes with an entered total
        if (tubeTotals[tubeKey] == null && row.totalEvent > 0) tubeTotals[tubeKey] = row.totalEvent;
      });
    });
    Object.keys(tubeTotals).forEach((t) => { grandTotalEvents += tubeTotals[t] || 0; });

    const pct = (n, d) => d > 0 ? (Math.round(n / d * 1e6) / 1e4) + '%' : '\u2014';
    const perRows = perTube.map((x) => '<tr><td class="num">' + esc(x.tube || '') + '</td><td>' + esc(x.collection || '') + '</td><td>' + esc(x.gate || '') + '</td><td class="num">' + (x.totalEvent > 0 ? Number(x.totalEvent).toLocaleString() : '\u2014') + '</td><td class="num">' + (x.sortedCount || 0).toLocaleString() + '</td><td class="num">' + pct(x.sortedCount, x.totalEvent) + '</td></tr>').join('');
    const gateRows = Object.keys(byGate).sort().map((g) => { const gt = Object.keys(byGate[g].tubeTotals).reduce((s, k) => s + byGate[g].tubeTotals[k], 0);
      return '<tr><td>' + esc(g) + '</td><td class="num"><strong>' + byGate[g].sorted.toLocaleString() + '</strong></td><td class="num">' + pct(byGate[g].sorted, gt) + '</td></tr>'; }).join('');

    host.innerHTML = '<h2>Sort <span class="who">' + esc(rec.name || '') + '</span></h2>'
      + '<h3>Combined across all tubes, by population</h3>'
      + '<p class="who">% of total = sorted count \u00f7 total cells processed across all tubes (' + grandTotalEvents.toLocaleString() + ').</p>'
      + '<table class="cost-table"><thead><tr><th>Population (sort gate)</th><th class="num">Total sorted</th><th class="num">% of total</th></tr></thead><tbody>' + gateRows + '</tbody></table>'
      + '<h3 style="margin-top:22px">Per tube</h3>'
      + '<table class="cost-table"><thead><tr><th class="num">Tube #</th><th>Collection tube</th><th>Population</th><th class="num">Total event</th><th class="num">Sorted count</th><th class="num">% of total</th></tr></thead><tbody>' + perRows + '</tbody></table>';
  }

  function openImageLightbox(src, caption) {
    let ov = document.getElementById('imgLightbox');
    if (!ov) { ov = document.createElement('div'); ov.id = 'imgLightbox'; ov.className = 'img-lightbox'; ov.innerHTML = '<div class="lb-inner"><img><div class="lb-cap"></div></div>'; document.body.appendChild(ov); ov.addEventListener('click', () => { ov.style.display = 'none'; }); }
    ov.querySelector('img').src = src;
    const cap = ov.querySelector('.lb-cap'); if (cap) cap.textContent = caption || '';
    ov.style.display = 'flex';
  }

  // ---- Calendar page (all scheduled experiments + month grid + equipment week)
  function renderCalendar() {
    const el = $('#calendarContent'); if (!el) return;
    const dOf = (e) => e.date || (e.scheduledAt ? String(e.scheduledAt).slice(0, 10) : '');
    const exps = Store.allExperiments().filter((e) => dOf(e)).sort((a, b) => dOf(a).localeCompare(dOf(b)));
    let h = '<h2>Calendar</h2><h3>Scheduled experiments</h3>';
    if (!exps.length) h += '<p class="muted">No experiments have a date yet. Set one on the Plan \u2192 Scheduling step.</p>';
    else h += '<table class="tbl"><thead><tr><th>Date</th><th>Project</th><th>Experiment</th><th>Status</th><th>Modalities</th></tr></thead><tbody>'
      + exps.map((e) => '<tr><td>' + esc(dOf(e)) + '</td><td>' + esc(e.project || '\u2014') + '</td><td>' + esc(e.name || 'experiment') + '</td><td>' + esc(e.status || '') + '</td><td>' + esc(((e.snapshot && e.snapshot.modalities) || []).join(', ')) + '</td></tr>').join('')
      + '</tbody></table>';
    // month grid (current month), experiments marked on their day
    const now = new Date(); const y = now.getFullYear(), m = now.getMonth();
    const byDay = {}; exps.forEach((e) => { const d = dOf(e); if (d.slice(0, 7) === (y + '-' + String(m + 1).padStart(2, '0'))) { const day = parseInt(d.slice(8, 10), 10); (byDay[day] = byDay[day] || []).push(e.name || 'exp'); } });
    const first = new Date(y, m, 1).getDay(); const days = new Date(y, m + 1, 0).getDate();
    const monthName = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
    let cells = ''; for (let i = 0; i < first; i++) cells += '<td class="mcal-empty"></td>';
    for (let d = 1; d <= days; d++) { const evs = byDay[d] || []; cells += '<td class="mcal-day' + (evs.length ? ' mcal-has' : '') + '"><span class="mcal-n">' + d + '</span>' + evs.map((n) => '<span class="mcal-ev">' + esc(n) + '</span>').join('') + '</td>'; if ((first + d) % 7 === 0) cells += '</tr><tr>'; }
    h += '<h3>' + esc(monthName) + '</h3><table class="mcal"><thead><tr><th>Sun</th><th>Mon</th><th>Tue</th><th>Wed</th><th>Thu</th><th>Fri</th><th>Sat</th></tr></thead><tbody><tr>' + cells + '</tr></tbody></table>';
    // weekly equipment (view-only)
    const embed = (window.Scheduling && Scheduling.mergedEmbedUrl) ? Scheduling.mergedEmbedUrl() : '';
    h += '<h3>Equipment schedule (this week)</h3><p class="muted small">View only \u2014 book equipment on the Plan \u2192 Scheduling step.</p>'
      + (embed ? '<iframe src="' + embed + '" class="cal-embed" frameborder="0" scrolling="no"></iframe>' : '<p class="muted">Equipment calendar unavailable.</p>');
    el.innerHTML = h;
  }

  // ---- Load workbook --------------------------------------------------------
  // Pull the live inventory (kits + reagents) from the Google Sheet via
  // /api/inventory and normalize into the liveInventory item shape used by the
  // inventory engine. Falls back silently to the workbook's Live_Inventory tab
  // if the endpoint isn't reachable (e.g. running the bundled file locally).
  async function loadLiveInventory() {
    try {
      const r = await fetch('/api/inventory');
      if (!r.ok) return;
      const d = await r.json();
      if (!d || !d.ok || d.configured === false) return;
      const num = (v) => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : null; };
      const kits = (d.kits || []).map((k) => ({
        id: String(k['Catalog #'] || '').trim(), name: k['Description'] || '', category: '10X Kits',
        container: 'kit', packSize: 1, usageUnit: 'kit', unit: 'kit',
        currentUnits: num(k['On hand (kits)']), currentContainers: num(k['On hand (kits)']), currentStock: num(k['On hand (kits)']),
        minStock: num(k['Reorder at']), orderStatus: k['Order status'] || '', location: k['Storage'] || '',
        reservedForProject: String(k['Reserved for'] || '').trim(), lots: k['Lot #(s)'] || '', expiry: k['Earliest expiry'] || '', notes: k['Notes'] || ''
      })).filter((x) => x.id);
      const reagents = (d.reagents || []).map((r2) => {
        const pack = num(r2['Pack size']) || 1;
        let cu = num(r2['On hand (units)']); const cc = num(r2['On hand (containers)']);
        if (cu == null && cc != null) cu = cc * pack;
        const cat = String(r2['Category'] || 'Reagent').trim();
        return {
          id: String(r2['item_id'] || '').trim(), name: r2['Item'] || '', category: (cat === 'Supply' ? 'Supplies' : 'Reagents'),
          container: r2['Container'] || '', packSize: pack, usageUnit: r2['Unit'] || '', unit: r2['Unit'] || '',
          currentUnits: cu, currentContainers: (cc != null ? cc : (cu != null && pack ? cu / pack : null)), currentStock: cu,
          minStock: num(r2['Reorder at']), orderStatus: r2['Order status'] || '', location: r2['Location'] || '',
          reservedForProject: '', lots: '', expiry: '', notes: r2['Notes'] || ''
        };
      }).filter((x) => x.id);
      const mapReagentLike = (arr, category) => (arr || []).map((r2) => {
        const pack = num(r2['Pack size']) || 1;
        let cu = num(r2['On hand (units)']); const cc = num(r2['On hand (containers)']);
        if (cu == null && cc != null) cu = cc * pack;
        return {
          id: String(r2['item_id'] || '').trim(), name: r2['Item'] || '', category: category,
          container: r2['Container'] || '', packSize: pack, usageUnit: r2['Unit'] || '', unit: r2['Unit'] || '',
          currentUnits: cu, currentContainers: (cc != null ? cc : (cu != null && pack ? cu / pack : null)), currentStock: cu,
          minStock: num(r2['Reorder at']), orderStatus: r2['Order status'] || '', location: r2['Location'] || '',
          reservedForProject: '', lots: '', expiry: '', notes: r2['Notes'] || ''
        };
      }).filter((x) => x.id);
      const oligos = mapReagentLike(d.oligos, 'Oligos');
      const antibodies = mapReagentLike(d.antibodies, 'Antibodies');
      // TotalSeq cocktails + HTOs — multiple vials per hashtag; aggregate by
      // (version + hashtag number), summing volumes (blank / "not measured" = 0).
      const clean = (v) => String(v == null ? '' : v).replace(/\.0$/, '').trim();
      const tsGroups = {}; const tsOrder = [];
      (d.totalseq || []).forEach((t) => {
        const ver = clean(t['TotalSeq Version']);
        const ht = clean(t['Hashtag Number']);
        if (ver === '' && ht === '') return;
        const key = ver + ht;                       // e.g. "A2"
        if (!tsGroups[key]) { tsGroups[key] = { ver: ver, ht: ht, vol: 0, vials: 0, box: t['Storage Box'] || '', cat: clean(t['Catalog Number']), type: t['Type'] || 'HTO', reserved: '' }; tsOrder.push(key); }
        const g = tsGroups[key];
        g.vol += (num(t['Volume/Quantity Remaining']) || 0);   // non-numeric / blank -> 0
        g.vials += 1;
        if (t['Reserved For']) g.reserved = String(t['Reserved For']).trim();
        if (!g.cat && clean(t['Catalog Number'])) g.cat = clean(t['Catalog Number']);
      });
      const totalseq = tsOrder.map((key) => {
        const g = tsGroups[key];
        return {
          id: key, name: 'TotalSeq-' + g.ver + ' Hashtag ' + g.ht + ' (' + g.type + ')', category: 'TotalSeq / HTOs',
          container: 'vial', packSize: 1, usageUnit: 'µL', unit: 'µL',
          currentUnits: g.vol, currentContainers: g.vials, currentStock: g.vol,
          minStock: null, orderStatus: '', location: g.box, reservedForProject: g.reserved,
          lots: '', expiry: '', notes: g.vials + ' vial(s)' + (g.cat ? ' \u00b7 Cat ' + g.cat : '')
        };
      });
      if (kits.length || reagents.length || oligos.length || antibodies.length || totalseq.length) {
        DATA.liveInventory = kits.concat(reagents, oligos, antibodies, totalseq);
        DATA.inventorySource = 'live';
      }
    } catch (e) { /* keep workbook fallback */ }
  }

  async function loadData() {
    const status = $('#dataStatus');
    try {
      const resp = await fetch(DATA_URL);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const buf = await resp.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      DATA = SchemaParse.parseWorkbook(wb);
      await loadLiveInventory();
      status.textContent = DATA.modalities.length + ' modalities · ' + DATA.kits.length + ' kits loaded';
      status.classList.add('ok');
      $('#handbookContent').innerHTML = HandbookContent.handbookHTML;
      if (window.Scheduling) Scheduling.render($('#schedulingContent'));
      inventoryBadge();
    } catch (err) {
      status.textContent = 'Could not load spreadsheet';
      status.classList.add('err');
      const de = $('#dataError');
      de.hidden = false;
      de.innerHTML = '<div class="placeholder-card"><strong>Spreadsheet did not load.</strong> ' +
        'You can still design the experiment below, but reagents &amp; cost need the spreadsheet. ' +
        'If you opened this file directly (file://), browsers block local reads — use a local server or GitHub Pages (see README). ' +
        'If it persists online, the SheetJS library CDN may be blocked; see README to vendor it locally.<br><br><code>' + String(err) + '</code></div>';
      console.error(err);
    }
  }

  // ---- Step 1: population → modality builder --------------------------------
  // Cells flow from a *population* (unsorted / sorted / stim / bulk) into one
  // downstream modality; some populations offer add-ons (ASAP on unsorted) or
  // a V(D)J add-on (any 5' chemistry). This structure captures the routing the
  // old flat checkbox list couldn't — e.g. that V(D)J rides on the 5' load and
  // never gets its own lane.
  const MODALITY_LABELS = {
    cite5: "5\u2032 CITE-seq", scrna5: "5\u2032 scRNA-seq (hashed)", flex: "Flex",
    asap: "ASAP-seq", bulkrna: "Bulk RNA-seq", bulktcrbcr: "Bulk TCR/BCR"
  };
  const FIVE_PRIME = new Set(['cite5', 'scrna5']); // chemistries that can carry V(D)J
  const POP_CONFIG = {
    unsorted: { label: 'Unsorted single-cell', desc: 'Whole thawed population, no enrichment', modalities: ['cite5', 'scrna5', 'flex'], asap: true },
    sorted:   { label: 'Sorted single-cell', desc: 'FACS-enriched populations', modalities: ['scrna5', 'flex'], asap: false },
    stim:     { label: 'Stimulated single-cell', desc: 'In-vitro stimulated aliquot', modalities: ['cite5', 'scrna5', 'flex'], asap: false },
    bulk:     { label: 'Bulk', desc: 'Per-sample, not droplet-loaded', modalities: ['bulkrna', 'bulktcrbcr'], asap: false }
  };

  // Selection state.
  let SEL = freshSelection();
  function freshSelection() {
    return {
      unsorted: { enabled: false, modality: null, asap: false, vdj: false },
      sorted:   { enabled: false, modality: null, vdj: false },
      stim:     { enabled: false, modality: null, vdj: false },
      bulk:     { enabled: false, modality: null }
    };
  }

  function applyMadiDefault() {
    SEL = {
      unsorted: { enabled: true, modality: 'cite5', asap: true, vdj: true },
      sorted:   { enabled: true, modality: 'scrna5', vdj: false },
      stim:     { enabled: true, modality: 'cite5', vdj: false },
      bulk:     { enabled: true, modality: 'bulkrna' }
    };
  }

  function renderPopulationBuilder() {
    const html = Object.keys(POP_CONFIG).map((popKey) => {
      const cfg = POP_CONFIG[popKey];
      const st = SEL[popKey];
      const modChoices = cfg.modalities.map((m) => `
        <label class="choice">
          <input type="radio" name="mod_${popKey}" data-pop-modality="${popKey}" value="${m}" ${st.modality === m ? 'checked' : ''} />
          ${esc(MODALITY_LABELS[m])}
        </label>`).join('');

      const fivePrimeChosen = FIVE_PRIME.has(st.modality);
      let addons = '';
      const addonBits = [];
      if (cfg.asap) {
        addonBits.push(`<label class="addon">
          <input type="checkbox" data-pop-asap="${popKey}" ${st.asap ? 'checked' : ''} />
          Add ASAP-seq <span class="addon-hint">(separate 3′/ATAC load from this population)</span>
        </label>`);
      }
      if (popKey !== 'bulk') {
        addonBits.push(`<label class="addon ${fivePrimeChosen ? '' : 'disabled'}">
          <input type="checkbox" data-pop-vdj="${popKey}" ${st.vdj ? 'checked' : ''} ${fivePrimeChosen ? '' : 'disabled'} />
          Add V(D)J (TCR/BCR) <span class="addon-hint">${fivePrimeChosen ? '(rides on the 5′ cDNA — no extra lane)' : '(needs a 5′ modality)'}</span>
        </label>`);
      }
      if (addonBits.length) addons = `<div class="addon-row">${addonBits.join('')}</div>`;

      const body = st.enabled ? `
        <div class="pop-body">
          <div>
            <div class="pop-choice-label">Downstream modality</div>
            <div class="choice-row">${modChoices}</div>
          </div>
          ${addons}
        </div>` : '';

      return `<div class="pop-card ${st.enabled ? 'on' : ''}">
        <label class="pop-head">
          <input type="checkbox" data-pop-enable="${popKey}" ${st.enabled ? 'checked' : ''} />
          <span class="pop-name">${esc(cfg.label)}</span>
          <span class="pop-desc">${esc(cfg.desc)}</span>
        </label>
        ${body}
      </div>`;
    }).join('');
    $('#populationBuilder').innerHTML = html;
  }

  function markCustomWorkflow() {
    // Any manual edit means the config is no longer the canned MADI preset.
    const box = $('#useMadiDefault');
    if (box) box.checked = false;
  }

  function onBuilderChange(e) {
    const t = e.target;
    let changed = false;
    if (t.matches('[data-pop-enable]')) {
      const k = t.dataset.popEnable;
      SEL[k].enabled = t.checked;
      if (!t.checked) {
        SEL[k].modality = null;
        if ('asap' in SEL[k]) SEL[k].asap = false;
        if ('vdj' in SEL[k]) SEL[k].vdj = false;
      }
      changed = true;
    } else if (t.matches('[data-pop-modality]')) {
      const k = t.dataset.popModality;
      SEL[k].modality = t.value;
      if (!FIVE_PRIME.has(t.value) && 'vdj' in SEL[k]) SEL[k].vdj = false; // Flex/bulk can't carry V(D)J
      changed = true;
    } else if (t.matches('[data-pop-asap]')) {
      SEL[t.dataset.popAsap].asap = t.checked;
      changed = true;
    } else if (t.matches('[data-pop-vdj]')) {
      SEL[t.dataset.popVdj].vdj = t.checked;
      changed = true;
    }
    if (changed) {
      markCustomWorkflow();
      renderPopulationBuilder();
      onSelectionChange();
    }
  }

  function initPopulationBuilder() {
    $('#populationBuilder').addEventListener('change', onBuilderChange);
    $('#useMadiDefault').addEventListener('change', (e) => {
      if (e.target.checked) applyMadiDefault();
      else SEL = freshSelection();
      renderPopulationBuilder();
      onSelectionChange();
    });
    renderPopulationBuilder();
  }

  /* ===== Unified input (real samples OR planning counts) + sort pops +
           navigator + explanation drawer ===== */

  const EXPLAIN = {
    inputMode: { title: 'Real samples vs. planning counts', body: 'Both paths run the identical pipeline. "I have my samples" uses the grid you fill in. "Planning / conceptual" synthesizes a sample set from summary counts (how many samples, patients, related lineages, timepoints, conditions) so you can size a batch before you have a real sample sheet — the synthetic set still obeys every biological rule (same-patient timepoints split across pools, related lineages kept apart, confounders spread).' },
    geneticPool: { title: 'Genetic pools (SNP demux)', body: 'Samples are partitioned into genetic pools of at most the cap. Within one pool no two samples may be from the same patient (e.g. different timepoints) or from genetically related people — that is what lets SNP-based demultiplexing separate individuals, and forces a patient\u2019s repeat timepoints into different pools so a later HTO layer can separate them too.' },
    samplesPerPool: { title: 'Max samples per pool', body: 'The SNP-demux capacity per genetic pool (lab handbook: up to ~20). Raising it lowers the number of pools (fewer HTOs, fewer super-pools) but packs more donors per pool. The alternative-options table shows the pool count and confounder-spread for each choice.' },
    allcells: { title: 'ALLCELLS control', body: 'ALLCELLS total = ALLCELLS % \u00d7 the per-sample pool contribution (e.g. 100% \u00d7 1.5M = 1.5M). That fixed total is split evenly across all pools, so more pools means less ALLCELLS per pool but the batch-wide total stays fixed at whatever one sample would contribute.' },
    perSampleAllocation: { title: 'Per-sample cell allocation', body: 'Each sample\u2019s thaw cells are split between the pooled load (goes into a genetic pool), the bulk RNA-seq reserve (set aside before pooling, needed for SNP demux), and the stimulation aliquot (conditions \u00d7 cells/condition). Leftover is spare; a deficit means you asked for more than the thaw yields.' },
    cellsLoadedPerLane: { title: 'Cells loaded per lane', body: 'For the 5\u2032 arms this is a super-load number your lab has custom-validated \u2014 NOT the standard 10x GEM-X 5\u2032 v3 cap (theirs is lower). For ASAP it is derived from 10x\u2019s documented ATAC v2 Recovery Efficiency Factor (\u2248 recovery/lane \u00d7 1.53). Update it in Assumptions if newer runs validate a different load.' },
    rawRecoveryPerLane: { title: 'Targeted recovery/lane (pre-QC)', body: 'Cells expected off a lane before computational QC/demux removal. Used as the cell basis for read-depth targets, since you sequence before QC removes anything. Based on your own prior-run observations, not a vendor figure \u2014 update as you gather data.' },
    qcRecoveryPerLane: { title: 'Post-QC recovery/lane', body: 'Cells expected to survive demultiplexing + QC per lane. Lane counts are set so that recovery/lane \u00d7 lanes meets your per-sample \u00d7 total-sample target (capped by available stained material).' },
    asapRecovery: { title: 'ASAP recovery convention', body: 'ASAP lane count uses the TARGET recovery/lane (not the loaded number). The ATAC library and the combined ADT/HTO library share the same nuclei basis because they come off the same GEM wells.' },
    stainingTarget: { title: 'Cells to stain / staining ceiling', body: 'Availability for GEM loading is min(raw pooled superpool, cells you chose to stain) \u00d7 staining/wash efficiency \u2014 you can\u2019t load antibody-tagged cells you never stained. If a target needs more than \u201cavailable\u201d can supply you\u2019ll see a shortfall flag; raise the staining target (more lyo panels) or the per-pool take.' },
    dynamicLanes: { title: 'Dynamic sort-lane assignment', body: 'Each selected population\u2019s estimated sorted count is compared to the per-lane load. Populations with enough cells get a dedicated lane, capped at the load (extra supply isn\u2019t loaded \u2014 the cap is not a quota). Smaller populations are bin-packed (largest-first) into shared lanes. A lane\u2019s libraries = GEX always, + VDJ-TCR if any member is T-lineage, + VDJ-BCR if any is B-lineage.' },
    sortFreq: { title: 'Sort population frequencies', body: 'Presort = expected PBMC fraction; empirical = observed sorted rate calibrated from a prior run (53.2M cells loaded \u2192 HSPC 13.2k / pDC 34.4k / cDC 517.5k / Treg 578.9k recovered). The empirical rates already fold in real sort losses, so the recovery adjustment defaults to 1.0.' },
    libraryPooling: { title: 'Library pooling & submission', body: 'Real practice: pool WITHIN a library type and submit one pooled lane per type (1\u00d7 GEX, 1\u00d7 VDJ-TCR, 1\u00d7 VDJ-BCR, 1\u00d7 CSP/ADT, 1\u00d7 ATAC) \u2014 not everything into one mixed pool. Normalize each library to equal molarity, then combine equal-molar volumes proportional to each library\u2019s read demand. The exact route (YCGA vs Biohub) may differ.' },
    thawCapacity: { title: 'Thaw capacity', body: 'People available \u00d7 max samples one person can thaw in the working window (19). Exceeding it means you should add a person or split the thaw across days.' },
    confounderSpread: { title: 'Confounder spread', body: 'A 0\u2013100% score for how evenly a flagged confounder\u2019s values (e.g. timepoints, conditions) are distributed across the genetic pools. 100% means each pool has a near-identical mix; a low score means some pools are dominated by one value (e.g. a pool that is almost all V00), which can confound batch effects with biology. The pooling algorithm maximizes this while never breaking the hard same-patient / same-lineage rule.' },
    laneEdit: { title: 'Adjusting lanes per modality', body: 'The tool computes lane counts to hit your per-sample cell targets. You can override any modality here \u2014 e.g. drop ASAP from 16 to 14 lanes to save reagents. Cells recovered per sample scale roughly linearly with lanes (\u2248 lanes \u00d7 recovered cells/lane \u00f7 samples), so fewer lanes means fewer cells/sample. The ~cells/sample figure is an estimate to help you weigh the trade-off; your chosen lane counts flow through to tube labels, the chip layout, index assignments, and the reagent/cost estimate. Reducing lanes below the computed value means you should confirm the resulting cells/sample is still adequate for your assay.' },
    poolComposition: { title: 'Pool composition & ALLCELLS', body: 'Each genetic pool combines the per-sample pooled contributions of its members, plus an even share of the batch-wide ALLCELLS control (ALLCELLS % \u00d7 one sample\u2019s pool contribution, split across all pools). ALLCELLS is a common reference aliquot loaded into every pool so cross-pool batch effects can be normalized during analysis.' }
  };

  function infoDot(key) {
    return '<button type="button" class="info-i" data-explain="' + key + '" title="What\u2019s this?" aria-label="Explain">i</button>';
  }

  function initPlanUI() {
    document.querySelectorAll('input[name="inputMode"]').forEach((r) => {
      r.addEventListener('change', (e) => setInputMode(e.target.value));
    });
    const pc = $('#planningCounts');
    if (pc) pc.addEventListener('input', () => { if (PLAN_INPUT === 'counts') { updateSampleCount(); renderThaw(); renderAllocation(); if (poolingReady()) runComputePooling(false); onSelectionChange(); } });
    // Section 2 thaw inputs (cells/sample, people)
    ['scen_cellsPerSample', 'scen_nPeople'].forEach((id) => {
      const el = $('#' + id); if (el) el.addEventListener('input', () => { renderThaw(); renderAllocation(); updateAccordion(); });
    });
    // Section 4 per-sample allocation inputs
    ['scen_poolContrib', 'scen_bulkTarget', 'scen_stimPerCond', 'scen_stimN'].forEach((id) => {
      const el = $('#' + id); if (el) el.addEventListener('input', () => { renderAllocation(); updateAccordion(); });
    });
    renderSortToggles();
    initExplainDrawer();
    initNav();
    initAccordion();
    setInputMode(PLAN_INPUT);
  }

  function setInputMode(mode) {
    PLAN_INPUT = mode === 'counts' ? 'counts' : 'grid';
    const isCounts = PLAN_INPUT === 'counts';
    const gw = $('#gridInputWrap'); if (gw) gw.hidden = isCounts;
    const cw = $('#countsInputWrap'); if (cw) cw.hidden = !isCounts;
    const r = document.querySelector('input[name="inputMode"][value="' + PLAN_INPUT + '"]'); if (r) r.checked = true;
    updateSampleCount();
    onSelectionChange();
    renderThaw(); renderAllocation();
    if (poolingReady()) runComputePooling(false);
    updateNav();
  }

  function readPlanningCounts() {
    const g = (id, def) => { const el = $('#' + id); return el && el.value !== '' ? Number(el.value) : def; };
    return {
      nSamples: g('pc_nSamples', 54), nPatients: g('pc_nPatients', 27),
      nLineages: g('pc_nLineages', 27), nTimepoints: g('pc_nTimepoints', 2),
      nConditions: g('pc_nConditions', 1)
    };
  }

  function renderSortToggles() {
    const host = $('#sortToggles');
    if (!host || !window.Pooling) return;
    const M = Pooling.SORT_MODEL;
    const pops = M.POPULATIONS.concat(CUSTOM_SORT_POPS.filter((p) => M.POPULATIONS.indexOf(p) < 0));
    host.innerHTML = pops.map((p) =>
      '<button type="button" class="pop-btn' + (SORT_SEL.has(p) ? ' active' : '') + '" data-sortpop="' + escAttr(p) + '">' +
      esc((M.DISPLAY && M.DISPLAY[p]) || p) + '</button>').join('')
      + '<button type="button" class="pop-btn" id="sortPopAdd" style="border-style:dashed">+ custom</button>';
    host.onclick = (e) => {
      if (e.target.id === 'sortPopAdd') { const name = (prompt('Custom sort population name:') || '').trim(); if (!name) return; if (CUSTOM_SORT_POPS.indexOf(name) < 0) CUSTOM_SORT_POPS.push(name); SORT_SEL.add(name); renderSortToggles(); onSelectionChange(); if (poolingReady()) runComputePooling(false); return; }
      const b = e.target.closest('[data-sortpop]'); if (!b) return;
      const p = b.dataset.sortpop;
      if (SORT_SEL.has(p)) SORT_SEL.delete(p); else SORT_SEL.add(p);
      b.classList.toggle('active');
      onSelectionChange();
      if (poolingReady()) runComputePooling(false);
    };
    // sort panel: spreadsheet-style editable table (paste-to-grow + add rows)
    renderSortPanelTable();
  }
  function renderSortPanelTable() {
    const host = $('#sortPanelTable'); if (!host) return;
    const MINROWS = 4;
    while (SORT_PANEL.length < MINROWS) SORT_PANEL.push({ channel: '', marker: '', ul: '' });
    const nPools = (function () { try { const c = computePooling(); return (c && c.poolRes && c.poolRes.nPools) || 8; } catch (e) { return 8; } })();
    const over = nPools + 1;
    let tot = 0;
    const rows = SORT_PANEL.map((r, i) => {
      const per = (r.ul === '' || r.ul == null) ? null : Number(r.ul) || 0; if (per != null) tot += per;
      return '<tr>'
        + '<td><input class="spx" data-r="' + i + '" data-c="0" value="' + escAttr(r.channel || '') + '" style="width:110px"></td>'
        + '<td><input class="spx" data-r="' + i + '" data-c="1" value="' + escAttr(r.marker || '') + '" style="width:120px"></td>'
        + '<td><input class="spx num" data-r="' + i + '" data-c="2" value="' + escAttr(r.ul == null ? '' : r.ul) + '" style="width:70px"></td>'
        + '<td class="num">' + (per == null ? '\u2014' : Math.round(per * over * 100) / 100) + '</td>'
        + '<td><button class="btn tiny" data-sp-del="' + i + '">\u2715</button></td></tr>';
    }).join('');
    host.innerHTML = '<div style="overflow:auto"><table class="cost-table"><thead><tr><th>Channel</th><th>Marker</th><th class="num">µL / pool</th><th class="num">Total for ' + nPools + ' pools (+1)</th><th></th></tr></thead><tbody>' + rows
      + '<tr><td colspan="2"><strong>Total Ab / pool</strong></td><td class="num"><strong>' + (Math.round(tot * 100) / 100) + '</strong></td><td class="num"><strong>' + (Math.round(tot * over * 100) / 100) + '</strong></td><td></td></tr>'
      + '</tbody></table></div><div class="row-actions" style="margin-top:6px"><button class="btn ghost" id="spAddRow">+ Add row</button> <span class="muted small">Tip: paste multiple rows straight from Excel into any cell.</span></div>';

    const setCell = (ri, ci, val) => { const key = ci === 0 ? 'channel' : (ci === 1 ? 'marker' : 'ul'); while (SORT_PANEL.length <= ri) SORT_PANEL.push({ channel: '', marker: '', ul: '' }); SORT_PANEL[ri][key] = (ci === 2 ? val.replace(/[^0-9.]/g, '') : val); };
    host.querySelectorAll('.spx').forEach((el) => {
      el.addEventListener('input', () => { setCell(+el.dataset.r, +el.dataset.c, el.value); onSelectionChange(); });
      el.addEventListener('blur', () => renderSortPanelTable());
      el.addEventListener('paste', (e) => {
        const text = (e.clipboardData || window.clipboardData).getData('text');
        if (!text || (text.indexOf('\t') < 0 && text.indexOf('\n') < 0)) return;   // single value: let default paste happen
        e.preventDefault();
        const startR = +el.dataset.r, startC = +el.dataset.c;
        text.replace(/\r/g, '').split('\n').forEach((line, ri) => { if (line === '' && ri > 0) return;
          line.split('\t').forEach((cell, ci) => { const c = startC + ci; if (c > 2) return; setCell(startR + ri, c, cell.trim()); });
        });
        onSelectionChange(); renderSortPanelTable();
      });
    });
    const add = $('#spAddRow'); if (add) add.addEventListener('click', () => { SORT_PANEL.push({ channel: '', marker: '', ul: '' }); renderSortPanelTable(); });
    host.querySelectorAll('button[data-sp-del]').forEach((b) => b.addEventListener('click', () => { SORT_PANEL.splice(+b.dataset.spDel, 1); onSelectionChange(); renderSortPanelTable(); }));
  }
  function sortSelList() {
    return (window.Pooling ? Pooling.SORT_MODEL.POPULATIONS : []).filter((p) => SORT_SEL.has(p));
  }

  // Global batch-scenario assumptions (the colleague's parameters), read from
  // the Assumptions step; used by both the sort-lane math and the scenario view.
  function readScenarioAssumptions() {
    const g = (id, def) => { const el = $('#' + id); return el && el.value !== '' ? Number(el.value) : def; };
    const presort = { HSC: g('scen_pre_HSC', 0.0005), pDC: g('scen_pre_pDC', 0.003), cDC: g('scen_pre_cDC', 0.007), Treg: g('scen_pre_Treg', 0.03), Trm: g('scen_pre_Trm', 0.005), AllT: g('scen_pre_AllT', 0.45), AllB: g('scen_pre_AllB', 0.10) };
    // empirical rates measured for HSC/pDC/cDC/Treg; Trm/AllT/AllB reuse presort
    const empirical = { HSC: g('scen_emp_HSC', 0.000248), pDC: g('scen_emp_pDC', 0.000647), cDC: g('scen_emp_cDC', 0.009734), Treg: g('scen_emp_Treg', 0.010889), Trm: presort.Trm, AllT: presort.AllT, AllB: presort.AllB };
    return {
      cellsPerSample: g('scen_cellsPerSample', 5000000),
      poolContributionPerSample: g('scen_poolContrib', 1500000),
      bulkTarget: g('scen_bulkTarget', 500000),
      stimPerCond: g('scen_stimPerCond', 200000),
      stimN: g('scen_stimN', 5),
      nPeople: g('scen_nPeople', 3),
      maxSamplesPerPerson: g('scen_maxPerPerson', 19),
      unsortAmt: g('scen_unsortAmt', 1200000),
      asapAmt: g('scen_asapAmt', 1200000),
      cellsLoadedPerLane: g('scen_cellsLoadedPerLane', 85000),
      rawRecoveryPerLane: g('scen_rawRecovery', 45000),
      qcRecoveryPerLane: g('scen_qcRecovery', 30000),
      targetRecoveryAsapPerLane: g('scen_asapTargetPerLane', 10000),
      asapPostQcPerLane: g('scen_asapPostQc', 9000),
      // per-sample recovery targets — shared with the cost engine (same input ids),
      // so the pooling preview and the built plan use one value per arm
      targetRecoveryUnsortPerSample: g('opt_chem_cite5_targetCellsPerSample', 7500),
      targetRecoveryAsapPerSample: g('opt_chem_asap_targetCellsPerSample', 3000),
      allcellsPct: g('scen_allcellsPct', 1),
      nucleiRecoveryFactor: g('scen_nucleiFactor', 1.53),
      sortRecoveryEff: g('scen_sortRecoveryEff', 1.0),
      stainEff: { unsort: g('scen_effUnsort', 0.85), asap: g('scen_effAsap', 0.75), sort: g('scen_effSort', 0.85) },
      populationFrequencyPresort: presort,
      populationFrequencyEmpirical: empirical,
      // reads asked per arm (Section 7), read from the cost-engine ids
      reads: {
        unsort: { gex: g('opt_chem_cite5_readsGEX', 35000), adt: g('opt_chem_cite5_readsADT', 5000), vdj: g('opt_chem_vdj_readsTCR', 5000), hto: g('opt_chem_cite5_readsHTO', 1000) },
        asap: { atac: g('opt_chem_asap_readsATAC', 25000), adt: g('opt_chem_asap_readsADT', 5000), hto: g('opt_chem_asap_readsHTO', 1000) },
        sort: { gex: g('opt_chem_scrna5_readsGEX', 35000), vdj: g('opt_chem_vdj_readsTCR', 5000), hto: g('opt_chem_scrna5_readsHTO', 1000) }
      }
    };
  }

  // Sort detail for the cost engine (dynamic sort lanes from selected pops).
  function buildSortDetail() {
    if (!window.Pooling) return null;
    const pops = sortSelList();
    if (!pops.length) return null;
    const a = readScenarioAssumptions();
    const nSamples = (samplesFromGrid().samples || []).length || 0;
    const cap = Number(($('#opt_cap') || {}).value) || 20;
    const nPools = nSamples ? Math.ceil(nSamples / cap) : 1;
    // sortable cells ≈ total pooled − unsort/ASAP superpool takes, × sort staining eff
    const totalPooled = nSamples * a.poolContributionPerSample;
    const sortSuperRaw = Math.max(0, totalPooled - nPools * a.unsortAmt - nPools * a.asapAmt);
    const avail = sortSuperRaw * a.stainEff.sort;
    const emp = a.populationFrequencyEmpirical;
    const popSortedCells = {};
    pops.forEach((p) => { popSortedCells[p] = avail * (emp[p] || 0) * a.sortRecoveryEff; });
    return { popSortedCells, cellsLoadedPerLane: a.cellsLoadedPerLane };
  }

  // Build a full explore scenario from the ACTUAL plan, for the numbers view.
  // Lane counts from exploreScenario (the source of truth) for the cost engine.
  // Lane counts come from the cost engine (target-recovered/sample ÷ recovered/
  // lane; sort = 1 lane/population). We feed these into the scenario so the
  // flowchart shows the SAME lanes as the reagent calc. The scenario's cell-flow
  // then just verifies there are enough cells to load them.
  let LANE_OVERRIDE = null;                 // { unsort, asap, sort } when the user edits lanes
  let LANE_COMPUTED = null;                 // the auto-computed baseline (for the impact display)
  const RECOVERED_PER_LANE = { unsort: 50000, asap: 45000, sort: 50000 };  // approx recovered cells/lane

  function computeDefaultLanes(nSamples, nPools, samples) {
    if (!DATA || !window.CostEngine) return null;
    try {
      const cost = CostEngine.computeCost(DATA, {
        armInstances: buildArmInstances(SEL), nSamples, samples, nPools, superPools: [], opts: readOpts()
      });
      let unsort = 0, asap = 0, sort = 0;
      (cost.laneBreakdown || []).forEach((l) => {
        if (l.chem === 'asap') asap += l.lanes;
        else if (l.population === 'sorted') sort += l.lanes;
        else if (l.population === 'unsorted' && l.laneChem === "5'") unsort += l.lanes;
      });
      return { unsort, asap, sort };
    } catch (e) { return null; }
  }

  function laneOverridesFromCost(nSamples, nPools, samples) {
    if (LANE_OVERRIDE) return { unsort: LANE_OVERRIDE.unsort, asap: LANE_OVERRIDE.asap, sort: LANE_OVERRIDE.sort };
    return computeDefaultLanes(nSamples, nPools, samples);
  }

  function scenarioForPlan(plan) {
    if (!window.Pooling) return null;
    const a = readScenarioAssumptions();
    const nSamples = plan.nSamples || 0;
    const nPools = plan.nPools || 1;
    const samplesPerPool = Math.max(1, Math.round(nSamples / nPools));
    const arms = {
      unsort: (plan.armInstances || []).some((x) => x.chem === 'cite5' || (x.population === 'unsorted' && x.chem === 'scrna5')),
      asap: (plan.armInstances || []).some((x) => x.chem === 'asap'),
      sort: (plan.armInstances || []).some((x) => x.laneMode === 'perSortPop')
    };
    return Pooling.exploreScenario(Object.assign({}, a, {
      nSamples, samplesPerPool, sortPopulations: sortSelList(), arms,
      laneOverrides: laneOverridesFromCost(nSamples, nPools, plan.samples)
    }));
  }

  /* ---- navigator ---- */
  const NAV_STEPS = [
    { key: 'modalities', label: 'Design', el: 'acc-1' },
    { key: 'samples', label: 'Samples', el: 'acc-2' },
    { key: 'assumptions', label: 'Assumptions', el: 'acc-3' },
    { key: 'allocation', label: 'Allocation', el: 'acc-4' },
    { key: 'staining', label: 'Lyo staining', el: 'acc-6' },
    { key: 'pooling', label: 'Pooling', el: 'acc-5' },
    { key: 'sequencing', label: 'Sequencing', el: 'acc-7' },
    { key: 'build', label: 'Build plan', el: 'stepRun' }
  ];
  let POOL_DONE = false;
  function initNav() {
    const host = $('#planNav'); if (!host) return;
    host.innerHTML = '<div class="nav-title">Workflow</div>' + NAV_STEPS.map((s) =>
      '<button type="button" class="nav-step" data-nav="' + s.el + '"><span class="nav-dot"></span>' + esc(s.label) + '</button>').join('');
    host.addEventListener('click', (e) => {
      const b = e.target.closest('[data-nav]'); if (!b) return;
      const el = document.getElementById(b.dataset.nav);
      if (!el) return;
      if (el.classList.contains('acc') && !el.classList.contains('open')) {
        document.querySelectorAll('.acc').forEach((s) => { s.classList.remove('open'); const h = s.querySelector('.acc-head'); if (h) h.setAttribute('aria-expanded', 'false'); });
        el.classList.add('open'); const h = el.querySelector('.acc-head'); if (h) h.setAttribute('aria-expanded', 'true');
        updateAccordion();
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    updateNav();
  }
  function navComplete() {
    const arms = buildArmInstances(SEL);
    const nSamp = (samplesFromGrid().samples || []).length;
    const alloc = currentAllocation();
    return {
      modalities: arms.length > 0,
      samples: nSamp > 0 && thawStatus().ok,
      assumptions: arms.length > 0,
      allocation: !!alloc && alloc.ok,
      pooling: POOL_DONE,
      staining: arms.some((a) => a.chem === 'cite5' || a.chem === 'asap'),
      arms: arms.length > 0,
      sequencing: true,
      build: !!LASTPLAN,
      save: !!CURRENT_EXP_ID
    };
  }
  function updateNav() {
    const host = $('#planNav'); if (!host) return;
    const done = navComplete();
    NAV_STEPS.forEach((s) => {
      const btn = host.querySelector('[data-nav="' + s.el + '"]');
      if (!btn) return;
      btn.classList.toggle('done', !!done[s.key]);
    });
  }

  /* ---- accordion ---- */
  const ACC_KEY = { 'acc-1': 'modalities', 'acc-2': 'samples', 'acc-3': 'assumptions', 'acc-4': 'allocation', 'acc-5': 'pooling', 'acc-6': 'staining', 'acc-7': 'sequencing' };
  function initAccordion() {
    document.querySelectorAll('.acc .acc-head').forEach((head) => {
      head.addEventListener('click', () => {
        const sec = head.closest('.acc');
        const isOpen = sec.classList.contains('open');
        // accordion: open the clicked one, collapse others (keep it simple + tidy)
        document.querySelectorAll('.acc').forEach((s) => { s.classList.remove('open'); const h = s.querySelector('.acc-head'); if (h) h.setAttribute('aria-expanded', 'false'); });
        if (!isOpen) { sec.classList.add('open'); head.setAttribute('aria-expanded', 'true'); }
        updateAccordion();
      });
    });
    updateAccordion();
  }
  function accSummary(key) {
    const arms = buildArmInstances(SEL);
    if (key === 'modalities') {
      if (!arms.length) return '';
      const names = Array.from(new Set(arms.map((a) => a.label || a.modality))).join(', ');
      const sorts = sortSelList(); const sortTxt = arms.some((a) => a.laneMode === 'perSortPop') && sorts.length ? ' · sort: ' + sorts.join(', ') : '';
      return names + sortTxt;
    }
    if (key === 'samples') {
      const n = (samplesFromGrid().samples || []).length;
      if (!n) return '';
      const t = thawStatus();
      return n + (PLAN_INPUT === 'counts' ? ' synthetic' : '') + ' samples · ' + (($('#scen_nPeople') || {}).value || '?') + ' thawing · ' + (t.ok ? 'within thaw capacity' : 'OVER thaw capacity');
    }
    if (key === 'allocation') {
      const a = currentAllocation(); if (!a) return '';
      return a.ok ? Math.round(a.committed).toLocaleString() + ' cells/sample committed · OK' : 'DEFICIT ' + Math.round(-a.leftover).toLocaleString() + '/sample';
    }
    if (key === 'assumptions') {
      const a = readScenarioAssumptions();
      return 'pool ' + (a.poolContributionPerSample / 1e6) + 'M/sample · load ' + a.cellsLoadedPerLane.toLocaleString() + '/lane';
    }
    if (key === 'pooling') { return POOL_DONE && LASTPLAN ? (LASTPLAN.nPools || '?') + ' genetic pools' : ''; }
    if (key === 'staining') {
      const rows = currentLyo(); if (!rows || !rows.rows.length) return '';
      return rows.rows.map((r) => r.label.replace(/ .*/, '') + ' ' + (r.stainCells / 1e6) + 'M→' + r.vials + ' vials').join(' · ');
    }
    if (key === 'sequencing') { const gx = ($('#opt_chem_cite5_readsGEX') || $('#opt_chem_scrna5_readsGEX') || {}).value; const at = ($('#opt_chem_asap_readsATAC') || {}).value; return [gx ? 'GEX ' + gx : '', at ? 'ATAC ' + at : ''].filter(Boolean).join(' · ') + (gx || at ? ' reads/cell' : ''); }
    return '';
  }
  function updateAccordion() {
    const done = navComplete();
    document.querySelectorAll('.acc').forEach((sec) => {
      const key = ACC_KEY[sec.id]; if (!key) return;
      const isOpen = sec.classList.contains('open');
      const statusEl = sec.querySelector('[data-status]');
      const summaryEl = sec.querySelector('.acc-summary');
      const isDone = !!done[key];
      if (statusEl) { statusEl.textContent = isDone ? '\u2713' : '\u2013'; statusEl.classList.toggle('is-done', isDone); }
      const summary = accSummary(key);
      if (summaryEl) {
        if (!isOpen && summary) { summaryEl.textContent = summary; summaryEl.hidden = false; }
        else summaryEl.hidden = true;
      }
    });
  }

  /* ---- Section 2: thaw capacity ---- */
  function thawStatus() {
    const n = (samplesFromGrid().samples || []).length;
    const people = Number(($('#scen_nPeople') || {}).value) || 0;
    const perPerson = Number(($('#scen_maxPerPerson') || {}).value) || 19;
    return Pooling.thawCapacity(n, people, perPerson);
  }
  function renderThaw() {
    const el = $('#thawMsg'); if (!el) return;
    const n = (samplesFromGrid().samples || []).length;
    if (!n) { el.hidden = true; return; }
    const t = thawStatus();
    el.hidden = false;
    el.className = 'feas-msg ' + (t.ok ? 'feas-ok' : 'feas-flag');
    el.textContent = t.message;
  }

  /* ---- Section 3: per-sample cell allocation ---- */
  function currentAllocation() {
    if (!window.Pooling) return null;
    const arms = buildArmInstances(SEL);
    if (!arms.length) return null;
    const a = readScenarioAssumptions();
    if (!a.cellsPerSample) return null;
    return Pooling.perSampleAllocation({
      cellsPerSample: a.cellsPerSample,
      poolContribution: a.poolContributionPerSample,
      bulkPerSample: a.bulkTarget,
      stimPerSample: a.stimPerCond * a.stimN,
      hasBulk: arms.some((x) => x.population === 'bulk'),
      hasStim: arms.some((x) => x.population === 'stim')
    });
  }
  function renderAllocation() {
    const host = $('#allocOutput'); if (!host) return;
    const a = currentAllocation();
    if (!a) { host.innerHTML = '<p class="empty">Pick modalities (Section 1) and set cells/sample (Section 2).</p>'; return; }
    const denom = Math.max(a.cellsPerSample, a.committed) || 1;
    const colour = { pool: '#33257A', bulk: '#9A84FB', stim: '#5A44D6', leftover: '#cfd6cf' };
    const bar = a.items.map((i) => i.amount > 0 ? '<span title="' + esc(i.label) + '" style="display:inline-block;height:16px;width:' + (i.amount / denom * 100) + '%;background:' + (colour[i.type] || '#ccc') + '"></span>' : '').join('') +
      (a.deficit ? '<span style="display:inline-block;height:16px;width:' + (-a.leftover / denom * 100) + '%;background:#ab3939"></span>' : '');
    const rows = a.items.map((i) => '<tr><td>' + esc(i.label) + '</td><td class="num">' + Math.round(i.amount).toLocaleString() + '</td></tr>').join('');
    host.innerHTML =
      '<div class="alloc-bar" style="display:flex;border-radius:6px;overflow:hidden;margin:8px 0">' + bar + '</div>' +
      '<table class="cost-table"><thead><tr><th>Per-sample allocation</th><th class="num">cells / sample</th></tr></thead><tbody>' + rows +
      '<tr class="tot"><td>Cells available / sample</td><td class="num">' + Math.round(a.cellsPerSample).toLocaleString() + '</td></tr></tbody></table>' +
      '<div class="feas-msg ' + (a.ok ? 'feas-ok' : 'feas-flag') + '">' + esc(a.message) + '</div>' +
      '<p class="ph-note">The pool contribution is what enters the genetic pool; the CITE / ASAP / sort split happens <em>after</em> pooling (see the pipeline flow once you compute the strategy).</p>';
  }

  /* ---- Section 5: lyo panel staining ---- */
  let LYO_SEL = {}; // chem -> { stainCells, cocktail }
  function stainingArms() {
    return buildArmInstances(SEL).filter((a) => a.chem === 'cite5' || a.chem === 'asap')
      .filter((a, i, arr) => arr.findIndex((b) => b.chem === a.chem) === i);
  }
  function renderLyoInputs(arms) {
    const host = $('#lyoInputs'); if (!host || !window.Pooling) return;
    const sa = stainingArms();
    if (!sa.length) { host.innerHTML = '<p class="empty">No antibody-stained modality selected (CITE-seq or ASAP-seq).</p>'; renderLyo(); return; }
    host.innerHTML = sa.map((a) => {
      const fam = a.chem === 'asap' ? 'asap' : 'cite';
      const opts = Pooling.COCKTAILS[fam];
      const sel = LYO_SEL[a.chem] || {};
      const optHtml = opts.map((o) => '<option' + (sel.cocktail === o ? ' selected' : '') + '>' + esc(o) + '</option>').join('');
      return '<div class="lyo-row"><span class="lyo-mod">' + esc(a.label || a.modality) + '</span>' +
        '<label>cells to stain<input type="number" class="lyo-cells" data-chem="' + a.chem + '" value="' + (sel.stainCells || 1500000) + '" step="100000" /></label>' +
        '<label>cocktail (' + (fam === 'asap' ? 'TotalSeq-A' : 'TotalSeq-C') + ')<select class="lyo-cocktail" data-chem="' + a.chem + '">' + optHtml + '</select></label></div>';
    }).join('');
    host.oninput = host.onchange = () => { readLyoInputs(); renderLyo(); if (poolingReady()) runComputePooling(false); updateAccordion(); };
    readLyoInputs(); renderLyo();
  }
  function readLyoInputs() {
    document.querySelectorAll('.lyo-cells').forEach((el) => { const c = el.dataset.chem; LYO_SEL[c] = LYO_SEL[c] || {}; LYO_SEL[c].stainCells = Number(el.value) || 0; });
    document.querySelectorAll('.lyo-cocktail').forEach((el) => { const c = el.dataset.chem; LYO_SEL[c] = LYO_SEL[c] || {}; LYO_SEL[c].cocktail = el.value; });
  }
  function currentLyo() {
    if (!window.Pooling) return null;
    const sa = stainingArms();
    if (!sa.length) return { rows: [], totalVials: 0 };
    return Pooling.lyoStaining({
      modalities: sa.map((a) => ({ key: a.chem, label: a.label || a.modality, family: a.chem === 'asap' ? 'asap' : 'cite', stainCells: (LYO_SEL[a.chem] || {}).stainCells || 1500000, cocktail: (LYO_SEL[a.chem] || {}).cocktail }))
    });
  }
  function renderLyo() {
    const host = $('#lyoOutput'); if (!host) return;
    const l = currentLyo();
    if (!l || !l.rows.length) { host.innerHTML = ''; return; }
    const rows = l.rows.map((r) => '<tr><td>' + esc(r.label) + '</td><td class="num">' + r.stainCells.toLocaleString() + '</td><td class="num">' + r.panels + '</td><td class="num">' + r.vials + '</td><td>' + esc(r.cocktail) + '</td></tr>').join('');
    host.innerHTML = '<table class="cost-table"><thead><tr><th>Modality</th><th class="num">Stain</th><th class="num">Panels</th><th class="num">Lyo vials</th><th>Cocktail</th></tr></thead><tbody>' + rows +
      '<tr class="tot"><td colspan="3">Total lyo vials</td><td class="num">' + l.totalVials + '</td><td></td></tr></tbody></table>' +
      '<p class="ph-note">Up to ' + l.stainPerPanel.toLocaleString() + ' cells per panel of ' + l.vialsPerPanel + ' vials. CITE-seq \u2192 TotalSeq-C, ASAP-seq \u2192 TotalSeq-A.</p>';
  }

  /* ---- explanation drawer ---- */
  function initExplainDrawer() {
    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-explain]');
      if (t) { e.preventDefault(); openExplain(t.dataset.explain); return; }
      if (e.target.closest('#explainClose') || e.target.id === 'explainScrim') closeExplain();
    });
  }
  function openExplain(key) {
    const info = EXPLAIN[key]; if (!info) return;
    const d = $('#explainDrawer'); if (!d) return;
    $('#explainTitle').textContent = info.title;
    $('#explainBody').textContent = info.body;
    d.classList.add('open');
    const scrim = $('#explainScrim'); if (scrim) scrim.hidden = false;
  }
  function closeExplain() {
    const d = $('#explainDrawer'); if (d) d.classList.remove('open');
    const scrim = $('#explainScrim'); if (scrim) scrim.hidden = true;
  }

  // Turn the selection into concrete "arm instances" — one per cell load.
  // Each carries its loading chemistry (drives cells/GEM + reads assumptions),
  // its libraries, whether V(D)J rides along, and how its lanes are counted.
  function buildArmInstances(sel) {
    const arms = [];
    const make = (population, modality, vdj) => {
      const spec = {
        cite5:      { chem: 'cite5',      libraries: ['GEX', 'ADT', 'HTO'], laneChem: "5'" },
        scrna5:     { chem: 'scrna5',     libraries: ['GEX', 'HTO'],        laneChem: "5'" },
        flex:       { chem: 'flex',       libraries: ['FlexGEX'],            laneChem: 'Flex' },
        asap:       { chem: 'asap',       libraries: ['ATAC', 'ADT', 'HTO'], laneChem: "3'/ATAC" },
        bulkrna:    { chem: 'bulkrna',    libraries: ['BulkGEX'],            laneChem: 'bulk' },
        bulktcrbcr: { chem: 'bulktcrbcr', libraries: ['BulkTCR', 'BulkBCR'], laneChem: 'bulk' }
      }[modality];
      const libs = spec.libraries.slice();
      const carriesVdj = !!vdj && FIVE_PRIME.has(modality);
      if (carriesVdj) libs.push('TCR', 'BCR');
      let laneMode = 'pooled';
      if (population === 'sorted') laneMode = 'perSortPop';
      if (modality === 'bulkrna' || modality === 'bulktcrbcr') laneMode = 'none';
      return {
        key: population + '_' + modality, population, modality,
        chem: spec.chem, laneChem: spec.laneChem, libraries: libs, vdj: carriesVdj, laneMode
      };
    };
    if (sel.unsorted.enabled && sel.unsorted.modality) {
      arms.push(make('unsorted', sel.unsorted.modality, sel.unsorted.vdj));
      if (sel.unsorted.asap) arms.push(make('unsorted', 'asap', false));
    }
    if (sel.sorted.enabled && sel.sorted.modality) arms.push(make('sorted', sel.sorted.modality, sel.sorted.vdj));
    if (sel.stim.enabled && sel.stim.modality) arms.push(make('stim', sel.stim.modality, sel.stim.vdj));
    if (sel.bulk.enabled && sel.bulk.modality) arms.push(make('bulk', sel.bulk.modality, false));
    return arms;
  }

  // Which loading chemistries are in play (drives which assumption cards show).
  function chemsUsed(arms) {
    const s = new Set();
    arms.forEach((a) => { s.add(a.chem); if (a.vdj) s.add('vdj'); });
    return s;
  }

  function onSelectionChange() {
    const arms = buildArmInstances(SEL);
    // sort-population panel appears only when a sorted arm is in the design
    const hasSort = arms.some((a) => a.laneMode === 'perSortPop');
    const sp = $('#sortPopPanel'); if (sp) sp.hidden = !hasSort;
    refreshOptionCards(arms);
    renderSequencing();
    renderLyoInputs(arms);
    renderThaw();
    renderAllocation();
    updateAccordion();
    updateNav();
  }

  function poolingReady() { return buildArmInstances(SEL).length > 0 && (samplesFromGrid().samples || []).length > 0; }

  // ---- Step 4: options, per loading chemistry -------------------------------
  // Source tags used in the assumptions section.
  function srcTag(kind) {
    const label = { A: 'A', EMP: 'EMP', LAB: 'LAB', EST: 'EST', '10X': '10X' };
    return '<span class="src-tag src-' + kind + '" title="' +
      ({ A: 'Assumption \u2014 change freely', EMP: 'Empirical \u2014 measured from prior runs', LAB: 'Lab-validated', EST: 'Estimate', '10X': '10x Genomics spec' }[kind]) +
      '">' + label[kind] + '</span>';
  }
  function scenField(key, label, def, opt) {
    opt = opt || {};
    const step = opt.step != null ? ' step="' + opt.step + '"' : '';
    return '<div class="opt"><label for="scen_' + key + '">' + esc(label) +
      (opt.tag ? ' ' + srcTag(opt.tag) : '') + (opt.explain ? ' ' + infoDot(opt.explain) : '') +
      '</label><input id="scen_' + key + '" type="number" value="' + def + '"' + step + ' /></div>';
  }

  function renderOptions() {
    const legend = '<div class="src-legend">' +
      srcTag('A') + ' assumption ' + srcTag('EMP') + ' empirical ' + srcTag('LAB') + ' lab-validated ' +
      srcTag('EST') + ' estimate ' + srcTag('10X') + ' 10x spec</div>';

    const general = '<fieldset class="opt-card" data-group="general"><legend>General</legend>' +
      optField('cap', 'Max samples per genetic pool', 20, 'SNP-demux capacity (handbook: up to ~20).', 'samplesPerPool') +
      optField('htoAvailable', 'HTO hashtags available', 10, 'Distinct hashtags in your kit.') +
      scenField('maxPerPerson', 'Max samples / person (thaw)', 19, { explain: 'thawCapacity' }) +
      scenField('allcellsPct', 'ALLCELLS (\u00d7 one sample\u2019s pool contribution)', 1, { tag: 'A', explain: 'poolComposition', step: 'any' }) +
      '</fieldset>';

    const unsort = '<fieldset class="opt-card" data-group="unsort" hidden><legend>Unsorted / CITE-seq arm</legend>' +
      '<div class="opt"><label for="opt_chem_cite5_targetCellsPerSample">Target recovered cells / sample ' + srcTag('EST') + '</label><input id="opt_chem_cite5_targetCellsPerSample" type="number" value="7500" /></div>' +
      scenField('unsortAmt', 'Unsort cells / pool (after modality split)', 1200000, { explain: 'allcells' }) +
      scenField('effUnsort', 'Unsort stain/wash efficiency', 0.85, { tag: 'A', explain: 'stainingTarget', step: 'any' }) +
      scenField('cellsLoadedPerLane', 'Cells loaded / lane (unsort & sort)', 85000, { tag: 'LAB', explain: 'cellsLoadedPerLane' }) +
      scenField('rawRecovery', 'Targeted recovery / lane, pre-QC (unsort & sort)', 45000, { tag: 'EST', explain: 'rawRecoveryPerLane' }) +
      scenField('qcRecovery', 'Targeted post-QC recovery / lane (unsort & sort)', 30000, { tag: 'EST', explain: 'qcRecoveryPerLane' }) +
      '</fieldset>';

    const asap = '<fieldset class="opt-card" data-group="asap" hidden><legend>ASAP-seq arm</legend>' +
      '<div class="opt"><label for="opt_chem_asap_targetCellsPerSample">Target recovered nuclei / sample ' + srcTag('EST') + '</label><input id="opt_chem_asap_targetCellsPerSample" type="number" value="3000" /></div>' +
      scenField('asapAmt', 'ASAP cells / pool (after modality split)', 1200000, { explain: 'allcells' }) +
      scenField('effAsap', 'ASAP stain/fix/wash efficiency', 0.75, { tag: 'A', explain: 'stainingTarget', step: 'any' }) +
      scenField('asapTargetPerLane', 'ASAP targeted recovery / lane', 10000, { tag: '10X', explain: 'asapRecovery' }) +
      scenField('asapPostQc', 'ASAP targeted post-QC recovery / lane', 9000, { tag: 'EST', explain: 'asapRecovery' }) +
      scenField('nucleiFactor', 'ASAP nuclei recovery factor (loaded = recovery \u00d7 factor)', 1.53, { tag: '10X', explain: 'asapRecovery', step: 'any' }) +
      '</fieldset>';

    const sortFreqPre = [['HSC', 0.0005], ['pDC', 0.003], ['cDC', 0.007], ['Treg', 0.03], ['Trm', 0.005], ['AllT', 0.45], ['AllB', 0.10]];
    const sortFreqEmp = [['HSC', 0.000248], ['pDC', 0.000647], ['cDC', 0.009734], ['Treg', 0.010889]];
    const dispName = { HSC: 'HSC', pDC: 'pDC', cDC: 'cDC', Treg: 'Treg', Trm: 'Trm', AllT: 'All T cells', AllB: 'All B cells' };
    const sort = '<fieldset class="opt-card" data-group="sort" hidden><legend>Sorted arm</legend>' +
      scenField('effSort', 'Sort stain/wash efficiency', 0.85, { tag: 'A', explain: 'stainingTarget', step: 'any' }) +
      scenField('sortRecoveryEff', 'Sort recovery adj. factor', 1.0, { tag: 'EMP', explain: 'sortFreq', step: 'any' }) +
      '<div class="opt-subhead">Presort frequency estimates ' + srcTag('A') + ' ' + infoDot('sortFreq') + '</div>' +
      sortFreqPre.map(([k, d]) => scenField('pre_' + k, dispName[k] + ' presort estimate', d, { step: 'any' })).join('') +
      '<div class="opt-subhead">Sorted empirical rates ' + srcTag('EMP') + ' ' + infoDot('sortFreq') + '</div>' +
      sortFreqEmp.map(([k, d]) => scenField('emp_' + k, dispName[k] + ' sorted (empirical)', d, { step: 'any' })).join('') +
      '</fieldset>';

    const host = $('#assumptionsGrid');
    host.innerHTML = legend + general + unsort + asap + sort;
    host.addEventListener('input', (e) => {
      if (e.target.id === 'opt_cap') { const echo = $('#capEcho'); if (echo) echo.textContent = e.target.value; }
      if (/^scen_/.test(e.target.id) || /^opt_/.test(e.target.id)) { renderThaw(); renderAllocation(); updateAccordion(); }
    });
    onSelectionChange();
  }

  // Section 7: reads/cell asked separately per arm (drives cost.js via opt_chem_*
  // ids AND the flowchart via readScenarioAssumptions).
  function renderSequencing() {
    const host = $('#seqInputs'); if (!host) return;
    const arms = buildArmInstances(SEL);
    const has = {
      unsort: arms.some((a) => a.population === 'unsorted' && a.chem === 'cite5'),
      asap: arms.some((a) => a.chem === 'asap'),
      sort: arms.some((a) => a.population === 'sorted'),
      vdj: arms.some((a) => (a.libraries || []).some((l) => /VDJ|TCR|BCR/.test(l))),
      bulk: arms.some((a) => a.chem === 'bulkrna'),
      bulkir: arms.some((a) => a.chem === 'bulktcrbcr')
    };
    const rf = (id, label, def, step) => '<div class="opt"><label for="' + id + '">' + esc(label) +
      '</label><input id="' + id + '" type="number" value="' + def + '"' + (step ? ' step="' + step + '"' : '') + ' /></div>';
    const cards = [];
    if (has.unsort) cards.push('<fieldset class="opt-card"><legend>Unsorted / CITE-seq (5\u2032)</legend>' +
      rf('opt_chem_cite5_readsGEX', 'GEX reads / cell', 35000) +
      rf('opt_chem_cite5_readsADT', 'CSP / ADT reads / cell', 5000) +
      rf('opt_chem_cite5_readsHTO', 'HTO reads / cell', 1000) +
      rf('opt_chem_vdj_readsTCR', 'V(D)J TCR reads / cell', 5000) +
      rf('opt_chem_vdj_readsBCR', 'V(D)J BCR reads / cell', 5000) + '</fieldset>');
    if (has.asap) cards.push('<fieldset class="opt-card"><legend>ASAP-seq</legend>' +
      rf('opt_chem_asap_readsATAC', 'ATAC reads / nucleus', 25000) +
      rf('opt_chem_asap_readsADT', 'ADT reads / nucleus', 5000) +
      rf('opt_chem_asap_readsHTO', 'HTO reads / nucleus', 1000) + '</fieldset>');
    if (has.sort) cards.push('<fieldset class="opt-card"><legend>Sorted scRNA-seq (5\u2032)</legend>' +
      rf('opt_chem_scrna5_readsGEX', 'GEX reads / cell', 35000) +
      rf('opt_chem_scrna5_readsHTO', 'HTO reads / cell', 1000) +
      rf('opt_chem_vdj_readsTCR', 'V(D)J TCR reads / cell', 5000) +
      rf('opt_chem_vdj_readsBCR', 'V(D)J BCR reads / cell', 5000) + '</fieldset>');
    if (has.bulk) cards.push('<fieldset class="opt-card"><legend>Bulk RNA-seq</legend>' +
      rf('opt_chem_bulkrna_readsPerSample', 'Reads / sample', 30000000) + '</fieldset>');
    if (has.bulkir) cards.push('<fieldset class="opt-card"><legend>Bulk TCR/BCR</legend>' +
      rf('opt_chem_bulktcrbcr_readsPerSample', 'Reads / sample', 5000000) + '</fieldset>');
    host.innerHTML = cards.length ? cards.join('') : '<p class="empty">Pick modalities in Section 1 to set their sequencing depths.</p>';
    host.oninput = () => updateAccordion();
  }

  function refreshOptionCards(arms) {
    const host = $('#assumptionsGrid');
    if (!host || !host.children.length) return;
    arms = arms || buildArmInstances(SEL);
    const show = {
      unsort: arms.some((a) => a.population === 'unsorted'),
      asap: arms.some((a) => a.chem === 'asap'),
      sort: arms.some((a) => a.population === 'sorted' || a.laneMode === 'perSortPop')
    };
    ['unsort', 'asap', 'sort'].forEach((g) => {
      const card = host.querySelector('.opt-card[data-group="' + g + '"]');
      if (card) card.hidden = !show[g];
    });
  }

  function optField(key, label, def, hint, explainKey) {
    return `<div class="opt"><label for="opt_${key}">${esc(label)}${explainKey ? ' ' + infoDot(explainKey) : ''}</label>
      <input id="opt_${key}" type="number" value="${def}" min="1" />
      ${hint ? '<span class="opt-hint">' + esc(hint) + '</span>' : ''}</div>`;
  }

  function readOpts() {
    const g = (k) => { const el = $('#opt_' + k); return el ? Number(el.value) : undefined; };
    const sortDetail = buildSortDetail();
    const opts = {
      cap: g('cap'), htoAvailable: g('htoAvailable'),
      sortPopulations: sortSelList().length || g('sortPopulations'),
      sortDetail,
      chems: {}
    };
    Object.keys(CostEngine.CHEM_ASSUMPTIONS).forEach((chemKey) => {
      const vals = {};
      CostEngine.CHEM_ASSUMPTIONS[chemKey].fields.forEach((f) => {
        const v = g('chem_' + chemKey + '_' + f.key);
        if (v != null && !isNaN(v)) vals[f.key] = v;
      });
      opts.chems[chemKey] = vals;
    });
    return opts;
  }

  // ---- Load a project batch's samples into the sample grid --------------------
  // Pulls the samples assigned to batch N in the project's saved batch plan and
  // fills the sample grid (Sample ID + Patient ID + confounders as columns).
  // Pooling then proceeds exactly as normal from the loaded samples.
  function loadBatchIntoGrid(bp, batchNum) {
    if (!bp || !bp.plan || !bp.samples) return 0;
    const idF = bp.idField, assign = bp.plan.assignment || {};
    const rows = bp.samples.filter((r) => Number(assign[r[idF]]) === Number(batchNum));
    if (!rows.length) return 0;
    const headers = Object.keys(rows[0]);
    const patientCol = (bp.keepTogether && bp.keepTogether[0]) || null;
    const customCols = headers.filter((h) => h !== idF && h !== patientCol);
    CUSTOM_COLS = customCols.slice();
    GRID_ROWS = rows.map((r) => {
      const core = [r[idF] || '', patientCol ? (r[patientCol] || '') : '', '', ''];
      return core.concat(customCols.map((h) => (r[h] == null ? '' : r[h])));
    });
    renderGrid();
    return rows.length;
  }

  function refreshBatchLoadControl() {
    const row = $('#batchLoadRow'); if (!row) return;
    const cur = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    const proj = (cur && cur.project) ? cur.project : CURRENT_PROJECT;
    const bp = proj ? readBatchPlan(proj) : null;
    if (!bp || !bp.plan || !bp.plan.sizes) { row.hidden = true; return; }
    row.hidden = false;
    const sel = $('#batchLoadSel');
    sel.innerHTML = bp.plan.sizes.map((sz, i) => '<option value="' + (i + 1) + '"' + ((cur && cur.batchRef === i + 1) ? ' selected' : '') + '>Batch ' + (i + 1) + ' (' + sz + ' samples)</option>').join('');
    const note = $('#batchLoadNote'); if (note) note.textContent = 'from \u201c' + proj + '\u201d';
  }

  // ---- Step 2: sample grid ----------------------------------------------------
  function allColumnDefs() {
    const core = [
      { label: 'Sample ID', core: true },
      { label: 'Patient ID', core: true },
      { label: 'Lineage (optional)', core: true },
      { label: 'Cells available (optional)', core: true }
    ];
    const custom = CUSTOM_COLS.map((name, i) => ({ label: name, core: false, customIndex: i }));
    return core.concat(custom);
  }

  function ensureGridSize(rowCount, colCount) {
    while (GRID_ROWS.length < rowCount) GRID_ROWS.push(new Array(CORE_LEN + CUSTOM_COLS.length).fill(''));
    const neededCustom = colCount - CORE_LEN;
    while (CUSTOM_COLS.length < neededCustom) {
      CUSTOM_COLS.push('Variable ' + (CUSTOM_COLS.length + 1));
      GRID_ROWS.forEach((row) => row.push(''));
    }
  }

  function renderGrid() {
    const cols = allColumnDefs();
    const theadCells = cols.map((c) => {
      if (c.core) return `<th>${esc(c.label)}</th>`;
      return `<th class="col-custom"><div class="col-custom-inner">
        <input type="text" class="col-name-input" data-col-index="${c.customIndex}" value="${escAttr(c.label)}" />
        <button type="button" class="col-remove" data-col-index="${c.customIndex}" title="Remove column">×</button>
      </div></th>`;
    }).join('');
    const bodyRows = GRID_ROWS.map((row, ri) => {
      const cells = cols.map((c, ci) => `<td><input type="text" data-row="${ri}" data-col="${ci}" value="${escAttr(row[ci] == null ? '' : row[ci])}" /></td>`).join('');
      return `<tr>${cells}<td class="row-actions-cell"><button type="button" class="row-remove" data-row="${ri}" title="Remove row">×</button></td></tr>`;
    }).join('');
    $('#sampleGrid').innerHTML = `<thead><tr>${theadCells}<th></th></tr></thead><tbody>${bodyRows}</tbody>`;
    renderConfounderChecks();
    updateSampleCount();
  }

  function renderConfounderChecks() {
    const panel = $('#confounderPanel');
    if (!CUSTOM_COLS.length) { panel.hidden = true; $('#confounderChecks').innerHTML = ''; return; }
    panel.hidden = false;
    $('#confounderChecks').innerHTML = CUSTOM_COLS.map((name, i) => `
      <label class="confounder-check">
        <input type="checkbox" data-confounder-index="${i}" ${CONFOUNDER_CHECKED_IDX.has(i) ? 'checked' : ''} />
        ${esc(name)}
      </label>`).join('');
  }

  function addRow() {
    GRID_ROWS.push(new Array(CORE_LEN + CUSTOM_COLS.length).fill(''));
    renderGrid();
  }

  function addColumn() {
    CUSTOM_COLS.push('Variable ' + (CUSTOM_COLS.length + 1));
    GRID_ROWS.forEach((row) => row.push(''));
    renderGrid();
    const newIndex = CUSTOM_COLS.length - 1;
    requestAnimationFrame(() => {
      const input = $('.col-name-input[data-col-index="' + newIndex + '"]');
      if (input) { input.focus(); input.select(); }
    });
  }

  function clearGrid() {
    GRID_ROWS = [];
    CUSTOM_COLS = [];
    CONFOUNDER_CHECKED_IDX = new Set();
    POOL_OVERRIDE = null; LANE_OVERRIDE = null;
    renderGrid();
    resetPoolingPreview();
  }

  function loadMadiExample() {
    // 18 subjects x 3 timepoints = 54, 9 dyads related, 1 simulated low-count
    // ("infant") draw so the cell-budget shortfall messaging has something to show.
    CUSTOM_COLS = ['Timepoint'];
    CONFOUNDER_CHECKED_IDX = new Set([0]);
    GRID_ROWS = [];
    for (let s = 1; s <= 18; s++) {
      const lineage = s <= 9 ? ('dyad_' + Math.ceil(s / 2)) : '';
      for (const tp of ['V00', 'V06', 'V12']) {
        const sampleId = `MADI_${1000 + s}_${tp}`;
        const patientId = String(1000 + s);
        const cellsAvailable = (s === 1 && tp === 'V00') ? '2000' : '';
        GRID_ROWS.push([sampleId, patientId, lineage, cellsAvailable, tp]);
      }
    }
    POOL_OVERRIDE = null; LANE_OVERRIDE = null;
    renderGrid();
    resetPoolingPreview();
  }

  function samplesFromGrid() {
    // Planning / conceptual path: synthesize a sample set from summary counts.
    if (PLAN_INPUT === 'counts') {
      const s = (window.Pooling ? Pooling.synthSamples(readPlanningCounts()) : { samples: [], relatedPairs: [], balanceColumns: [] });
      return { samples: s.samples, relatedPairs: s.relatedPairs, balanceColumns: s.balanceColumns, synthetic: true };
    }
    const samples = [];
    const relatedByLineage = {};
    GRID_ROWS.forEach((row, idx) => {
      const sampleId = (row[0] || '').toString().trim();
      if (!sampleId) return;
      const patientId = (row[1] || '').toString().trim() || sampleId;
      const lineage = (row[2] || '').toString().trim();
      const cellsRaw = (row[3] || '').toString().trim();
      let cellsAvailable = null;
      if (cellsRaw !== '') {
        const n = Number(cellsRaw.replace(/[^0-9.\-]/g, ''));
        if (!isNaN(n)) cellsAvailable = n;
      }
      const confounders = {};
      CUSTOM_COLS.forEach((name, ci) => { confounders[name] = (row[CORE_LEN + ci] || '').toString().trim(); });
      samples.push({ id: idx, sampleId, patientId, lineage, cellsAvailable, confounders });
      if (lineage) (relatedByLineage[lineage] = relatedByLineage[lineage] || []).push(sampleId);
    });
    const relatedPairs = [];
    Object.values(relatedByLineage).forEach((ids) => { for (let i = 1; i < ids.length; i++) relatedPairs.push([ids[0], ids[i]]); });
    return { samples, relatedPairs, balanceColumns: getCheckedConfounderNames(), synthetic: false };
  }

  function getCheckedConfounderNames() {
    return Array.from(CONFOUNDER_CHECKED_IDX).sort((a, b) => a - b).map((i) => CUSTOM_COLS[i]).filter(Boolean);
  }

  function updateSampleCount() {
    const { samples } = samplesFromGrid();
    $('#sampleCount').textContent = samples.length ? samples.length + ' samples' : '';
    updateNav();
  }

  // ---- Grid event handlers (delegated; attached once in initGrid) -----------
  function gridInputHandler(e) {
    const t = e.target;
    if (t.matches('input[data-row]')) {
      GRID_ROWS[+t.dataset.row][+t.dataset.col] = t.value;
      updateSampleCount();
    } else if (t.matches('.col-name-input')) {
      CUSTOM_COLS[+t.dataset.colIndex] = t.value;
      renderConfounderChecks();
    }
  }

  function gridClickHandler(e) {
    const t = e.target;
    if (t.matches('.row-remove')) {
      GRID_ROWS.splice(+t.dataset.row, 1);
      renderGrid();
    } else if (t.matches('.col-remove')) {
      const i = +t.dataset.colIndex;
      CUSTOM_COLS.splice(i, 1);
      GRID_ROWS.forEach((row) => row.splice(CORE_LEN + i, 1));
      const shifted = new Set();
      CONFOUNDER_CHECKED_IDX.forEach((idx) => { if (idx !== i) shifted.add(idx > i ? idx - 1 : idx); });
      CONFOUNDER_CHECKED_IDX = shifted;
      renderGrid();
    }
  }

  function gridPasteHandler(e) {
    const t = e.target;
    if (!t.matches('input[data-row]')) return;
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (!text) return;
    e.preventDefault();
    const startRow = +t.dataset.row, startCol = +t.dataset.col;
    let lines = text.replace(/\r/g, '').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop(); // drop trailing blank line from copy
    lines.forEach((line, ri) => {
      line.split('\t').forEach((val, ci) => {
        const r = startRow + ri, c = startCol + ci;
        ensureGridSize(r + 1, c + 1);
        GRID_ROWS[r][c] = val;
      });
    });
    renderGrid();
  }

  function confounderChangeHandler(e) {
    const t = e.target;
    if (!t.matches('input[type="checkbox"]')) return;
    const i = +t.dataset.confounderIndex;
    if (t.checked) CONFOUNDER_CHECKED_IDX.add(i); else CONFOUNDER_CHECKED_IDX.delete(i);
  }

  function initGrid() {
    $('#sampleGrid').addEventListener('input', gridInputHandler);
    $('#sampleGrid').addEventListener('click', gridClickHandler);
    $('#sampleGrid').addEventListener('paste', gridPasteHandler);
    $('#confounderChecks').addEventListener('change', confounderChangeHandler);
    renderGrid();
  }

  // ---- Step 3: pooling strategy review (compute / download / reupload) ------
  function overrideMatchesSamples(override, samples) {
    const a = new Set(override.bySampleId.keys());
    const b = new Set(samples.map((s) => s.sampleId));
    if (a.size !== b.size) return false;
    for (const id of a) if (!b.has(id)) return false;
    return true;
  }

  function computePooling() {
    const { samples, relatedPairs, balanceColumns } = samplesFromGrid();
    if (!samples.length) return null;
    const cap = Number(($('#opt_cap') || {}).value) || 20;
    const htoAvailable = Number(($('#opt_htoAvailable') || {}).value) || 10;
    const confounderCols = balanceColumns || getCheckedConfounderNames();

    let poolRes, htoRes, usedOverride = false;

    if (POOL_OVERRIDE && overrideMatchesSamples(POOL_OVERRIDE, samples)) {
      const poolsMap = {};
      samples.forEach((s) => {
        const info = POOL_OVERRIDE.bySampleId.get(s.sampleId);
        (poolsMap[info.pool] = poolsMap[info.pool] || []).push(s);
      });
      const poolIdxs = Object.keys(poolsMap).map(Number).sort((a, b) => a - b);
      const pools = poolIdxs.map((k) => poolsMap[k]);
      poolRes = {
        pools, nPools: pools.length, cap, largestLineage: null, warnings: [],
        confounderReport: Pooling.buildConfounderReport(pools, confounderCols)
      };
      if (POOL_OVERRIDE.hasFullHTO) {
        const assignments = [];
        const superGroups = {};
        poolIdxs.forEach((origIdx, newIdx) => {
          const info = POOL_OVERRIDE.bySampleId.get(poolsMap[origIdx][0].sampleId);
          assignments.push({ pool: newIdx, hto: info.hto });
          const sp = info.superPool != null ? info.superPool : 0;
          (superGroups[sp] = superGroups[sp] || []).push(newIdx);
        });
        const superPools = Object.keys(superGroups).map(Number).sort((a, b) => a - b).map((k) => superGroups[k]);
        htoRes = { assignments, superPools, htoAvailable, htoReused: superPools.length > 1, warnings: [] };
      } else {
        htoRes = Pooling.assignHTOs(poolRes.nPools, { htoAvailable });
      }
      usedOverride = true;
    } else {
      poolRes = Pooling.buildGeneticPools(samples, relatedPairs, { cap, balanceColumns: confounderCols });
      htoRes = Pooling.assignHTOs(poolRes.nPools, { htoAvailable });
    }

    return { samples, relatedPairs, poolRes, htoRes, usedOverride, confounderCols };
  }

  function resetPoolingPreview() {
    $('#poolingPreview').innerHTML = '<p class="empty">Add samples above, then compute a pooling strategy.</p>';
    $('#downloadPooling').disabled = true;
    $('#poolingStatus').hidden = true;
    POOL_DONE = false;
    updateNav();
  }

  function runComputePooling(showAlertIfEmpty, scrollToResult) {
    const calc = computePooling();
    if (!calc) {
      if (showAlertIfEmpty) alert('Add at least one sample in Step 02 first.');
      resetPoolingPreview();
      return null;
    }
    renderPoolingPreview(calc, scrollToResult);
    return calc;
  }

  // Wire the per-modality lane inputs: update the override, refresh the
  // cells/sample impact live, and re-render everything that depends on lanes.
  function wireLaneEditor(nSamplesTot) {
    const host = $('#poolingPreview'); if (!host) return;
    const cps = (mod, lanes) => nSamplesTot ? Math.round(lanes * RECOVERED_PER_LANE[mod] / nSamplesTot) : 0;
    host.querySelectorAll('.lane-edit').forEach((inp) => {
      inp.addEventListener('input', () => {
        const base = LANE_OVERRIDE || Object.assign({}, LANE_COMPUTED || { unsort: 0, asap: 0, sort: 0 });
        const mod = inp.dataset.mod;
        let v = parseInt(inp.value, 10); if (isNaN(v) || v < 0) v = 0;
        base[mod] = v; LANE_OVERRIDE = base;
        const cur = cps(mod, v), def = cps(mod, (LANE_COMPUTED || {})[mod] || 0);
        const cell = host.querySelector('[data-cps="' + mod + '"]'); if (cell) cell.textContent = '~' + cur.toLocaleString();
        const was = host.querySelector('[data-cpsdef="' + mod + '"]');
        if (was) was.textContent = (v !== ((LANE_COMPUTED || {})[mod] || 0)) ? ('(was ~' + def.toLocaleString() + ')') : '';
        const rb = $('#resetLanes'); if (rb) rb.disabled = false;
      });
      inp.addEventListener('change', () => { refreshLaneDependents(); });
    });
    const reset = $('#resetLanes');
    if (reset) reset.addEventListener('click', () => {
      LANE_OVERRIDE = null;
      // Put the computed numbers back into the inputs + cells/sample, in place, so
      // it's obvious it reset — and leave the fields editable so they can be changed again.
      host.querySelectorAll('.lane-edit').forEach((inp) => {
        const mod = inp.dataset.mod;
        const def = (LANE_COMPUTED || {})[mod] || 0;
        inp.value = def;
        const cell = host.querySelector('[data-cps="' + mod + '"]'); if (cell) cell.textContent = '~' + cps(mod, def).toLocaleString();
        const was = host.querySelector('[data-cpsdef="' + mod + '"]'); if (was) was.textContent = '';
      });
      reset.disabled = true;
      try { flashSaveStatus('Lane counts reset to the computed values'); } catch (e) { /* noop */ }
    });
  }

  // After a lane override changes, labels/chip/indexes/cost pull lanes lazily
  // via laneOverridesFromCost, so they pick it up automatically on next use.
  function refreshLaneDependents() {
    try { flashSaveStatus('Lane counts updated \u2014 labels, chip layout, indexes & cost will use your values'); } catch (e) { /* noop */ }
  }

  function renderPoolingPreview(calc, scrollToResult) {    const { poolRes, htoRes, usedOverride, confounderCols } = calc;
    const htoByPool = {}; htoRes.assignments.forEach((a) => { htoByPool[a.pool] = a.hto; });
    const superPoolByPool = {};
    htoRes.superPools.forEach((grp, spIdx) => grp.forEach((p) => { superPoolByPool[p] = spIdx; }));

    // confounder spread lookup: col -> poolIndex -> "V00 ×3, V06 ×2"
    const spread = {};
    (poolRes.confounderReport || []).forEach((cr) => {
      spread[cr.column] = {};
      cr.perPool.forEach((pp) => {
        spread[cr.column][pp.poolIndex] = Object.keys(pp.counts).sort().map((v) => esc(v) + ' \u00d7' + pp.counts[v]).join(', ') || '\u2014';
      });
    });
    const confHeads = confounderCols.map((c) => `<th>${esc(c)} <button type="button" class="info-i" data-explain="confounderSpread">i</button></th>`).join('');
    const rows = poolRes.pools.map((pool, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${esc(htoByPool[i] || '\u2014')}</td>
        <td>${superPoolByPool[i] != null ? (superPoolByPool[i] + 1) : '\u2014'}</td>
        <td class="num">${pool.length}</td>
        ${confounderCols.map((c) => `<td class="src">${(spread[c] && spread[c][i]) || '\u2014'}</td>`).join('')}
      </tr>`).join('');

    // pool composition (cells) + ALLCELLS
    const _a = readScenarioAssumptions();
    const perSamplePool = _a.poolContributionPerSample || 1500000;
    const allcellsShare = poolRes.nPools ? (_a.allcellsPct * perSamplePool) / poolRes.nPools : 0; // ALLCELLS total split across pools
    const compRows = poolRes.pools.map((pool, i) => {
      const pooled = pool.length * perSamplePool;
      return `<tr><td>${i + 1}</td><td class="num">${pool.length}</td><td class="num">${Math.round(pooled).toLocaleString()}</td><td class="num">${Math.round(allcellsShare).toLocaleString()}</td><td class="num">${Math.round(pooled + allcellsShare).toLocaleString()}</td></tr>`;
    }).join('');
    const compositionHTML = `<h3>Pool composition <button type="button" class="info-i" data-explain="poolComposition">i</button></h3>
      <table class="cost-table"><thead><tr><th>Pool</th><th class="num">Samples</th><th class="num">Pooled cells</th><th class="num">+ ALLCELLS share</th><th class="num">= Pool total</th></tr></thead><tbody>${compRows}</tbody></table>`;

    const warnings = [].concat(poolRes.warnings, htoRes.warnings);
    const warnHTML = warnings.length ? '<div class="callout warn"><strong>Notes:</strong><ul>' + warnings.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul></div>' : '';

    // ---- Lanes-to-sequence editor (override the computed lane counts) --------
    const nSamplesTot = poolRes.pools.reduce((sum, p) => sum + p.length, 0) || 0;
    const defLanes = computeDefaultLanes(nSamplesTot, poolRes.nPools, calc.samples) || { unsort: 0, asap: 0, sort: 0 };
    LANE_COMPUTED = defLanes;
    const curLanes = LANE_OVERRIDE || defLanes;
    const cps = (mod, lanes) => nSamplesTot ? Math.round(lanes * RECOVERED_PER_LANE[mod] / nSamplesTot) : 0;
    const MOD_LABEL = { unsort: "Unsort 5'", asap: 'ASAP', sort: "Sort 5'" };
    const laneModRows = ['unsort', 'asap', 'sort'].filter((m) => defLanes[m] > 0).map((m) => {
      const def = defLanes[m], cur = curLanes[m];
      return '<tr><td>' + MOD_LABEL[m] + '</td><td class="num">' + def + '</td>'
        + '<td class="num"><input class="lane-edit" type="number" min="0" step="1" data-mod="' + m + '" value="' + cur + '" style="width:64px"></td>'
        + '<td class="num" data-cps="' + m + '">~' + cps(m, cur).toLocaleString() + '</td>'
        + '<td class="num" data-cpsdef="' + m + '">' + (cur !== def ? '(was ~' + cps(m, def).toLocaleString() + ')' : '') + '</td></tr>';
    }).join('');
    const laneEditorHTML = laneModRows ? (
      '<h3>Lanes to sequence per modality <button type="button" class="info-i" data-explain="laneEdit">i</button></h3>'
      + '<p class="step-hint">The tool computed these lane counts to hit your cell targets. You can run fewer (or more) lanes per modality \u2014 reducing lanes lowers the cells recovered per sample proportionally. Downstream labels, chip layout, indexes and cost follow your choice.</p>'
      + '<table class="cost-table"><thead><tr><th>Modality</th><th class="num">Computed</th><th class="num">Run</th><th class="num">~Cells / sample</th><th></th></tr></thead><tbody>' + laneModRows + '</tbody></table>'
      + '<div class="row-actions" style="margin-top:8px"><button type="button" id="resetLanes" class="btn ghost"' + (LANE_OVERRIDE ? '' : ' disabled') + '>Reset to computed</button></div>'
    ) : '';

    $('#poolingPreview').innerHTML = `
      ${warnHTML}
      <table class="cost-table"><thead><tr><th>Pool</th><th>HTO</th><th>Super-pool</th><th class="num">Samples</th>${confHeads}</tr></thead><tbody>${rows}</tbody></table>
      ${compositionHTML}
      ${laneEditorHTML}
      <div id="poolingOptionsHost"></div>
      <h3>Pipeline cell-flow (this strategy)</h3>
      <div id="pipelineFlow"></div>`;
    wireLaneEditor(nSamplesTot);

    // Alternative pooling options (only when auto-computing, not on an upload).
    if (!usedOverride && window.Workflow && calc.samples) {
      try {
        const opts = Pooling.poolingOptions(calc.samples, calc.relatedPairs, { balanceColumns: confounderCols });
        const host = $('#poolingOptionsHost');
        if (host && opts.length) {
          host.innerHTML = Workflow.renderPoolingOptions(opts);
          host.addEventListener('click', (e) => {
            const b = e.target.closest('[data-choose-spp]'); if (!b) return;
            const capEl = $('#opt_cap'); if (capEl) { capEl.value = b.dataset.chooseSpp; const echo = $('#capEcho'); if (echo) echo.textContent = b.dataset.chooseSpp; }
            POOL_OVERRIDE = null;
            runComputePooling(false);
          });
        }
      } catch (err) { /* options are best-effort */ }
    }

    const status = $('#poolingStatus');
    if (usedOverride) {
      status.hidden = false;
      status.className = 'callout info';
      status.innerHTML = 'Using your <strong>uploaded</strong> pooling strategy (' + poolRes.nPools + ' pools). ' +
        '<button id="clearPoolingOverrideInline" class="btn ghost" type="button">Clear override, recompute automatically</button>';
    } else {
      status.hidden = true;
      status.innerHTML = '';
    }
    $('#downloadPooling').disabled = false;
    POOL_DONE = true;

    // pipeline cell-flow from a scenario built on THIS strategy
    try {
      const flowHost = $('#pipelineFlow');
      if (flowHost && window.Workflow && window.Pooling) {
        const a = readScenarioAssumptions();
        const arms = buildArmInstances(SEL);
        const nSamples = (samplesFromGrid().samples || []).length || 0;
        const sc = Pooling.exploreScenario(Object.assign({}, a, {
          nSamples, nPools: poolRes.nPools, samplesPerPool: poolRes.nPools ? Math.round(nSamples / poolRes.nPools) : nSamples,
          sortPopulations: sortSelList(),
          stainTargetUnsort: (LYO_SEL.cite5 && LYO_SEL.cite5.stainCells) || 1500000,
          stainTargetAsap: (LYO_SEL.asap && LYO_SEL.asap.stainCells) || 1500000,
          arms: {
            unsort: arms.some((x) => x.population === 'unsorted'),
            asap: arms.some((x) => x.chem === 'asap'),
            sort: arms.some((x) => x.population === 'sorted' || x.laneMode === 'perSortPop')
          },
          laneOverrides: laneOverridesFromCost(nSamples, poolRes.nPools, calc.samples)
        }));
        flowHost.innerHTML = Workflow.renderPipelineFlow(sc);
      }
    } catch (err) { /* flow is best-effort */ }

    // Only auto-open + scroll to the results when the user explicitly clicks
    // "Compute pooling strategy". On every other recompute (typing planning
    // counts, switching input mode, toggling sort populations, rebuild, edit)
    // just refresh status in place — otherwise the page collapses the section
    // being edited and jumps down to the results at random.
    if (scrollToResult) openAccordion('acc-5');
    else updateAccordion();
  }

  function openAccordion(id) {
    const sec = document.getElementById(id); if (!sec || !sec.classList.contains('acc')) return;
    document.querySelectorAll('.acc').forEach((s) => { s.classList.remove('open'); const h = s.querySelector('.acc-head'); if (h) h.setAttribute('aria-expanded', 'false'); });
    sec.classList.add('open'); const h = sec.querySelector('.acc-head'); if (h) h.setAttribute('aria-expanded', 'true');
    updateAccordion();
    sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function downloadPoolingXlsx() {
    const calc = runComputePooling(true);
    if (!calc) return;
    const { poolRes, htoRes } = calc;
    const htoByPool = {}; htoRes.assignments.forEach((a) => { htoByPool[a.pool] = a.hto; });
    const superPoolByPool = {};
    htoRes.superPools.forEach((grp, spIdx) => grp.forEach((p) => { superPoolByPool[p] = spIdx; }));

    const header = ['Sample ID', 'Patient ID', 'Lineage'].concat(CUSTOM_COLS, ['Cells available', 'Genetic Pool', 'HTO', 'Loading Super-Pool']);
    const rows = [header];
    poolRes.pools.forEach((pool, i) => {
      pool.forEach((s) => {
        rows.push([
          s.sampleId, s.patientId, s.lineage || ''
        ].concat(
          CUSTOM_COLS.map((c) => (s.confounders && s.confounders[c]) || ''),
          [
            s.cellsAvailable != null ? s.cellsAvailable : '',
            i + 1,
            htoByPool[i] || '',
            superPoolByPool[i] != null ? (superPoolByPool[i] + 1) : ''
          ]
        ));
      });
    });

    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Pooling Strategy');
    XLSX.writeFile(wb, 'pooling_strategy.xlsx');
  }

  function handlePoolingReupload(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      let wb;
      try { wb = XLSX.read(e.target.result, { type: 'array' }); }
      catch (err) { alert('Could not read that file as a spreadsheet: ' + err); return; }
      const wsName = wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wsName], { defval: '' });
      if (!rows.length) { alert('That spreadsheet appears to be empty.'); return; }

      const bySampleId = new Map();
      rows.forEach((row) => {
        const sid = String(row['Sample ID'] || '').trim();
        const poolRaw = row['Genetic Pool'];
        if (!sid || poolRaw === '' || poolRaw == null) return;
        const pool = Number(poolRaw);
        if (isNaN(pool)) return;
        const hto = (row['HTO'] != null && row['HTO'] !== '') ? String(row['HTO']).trim() : null;
        const spRaw = row['Loading Super-Pool'];
        const superPool = (spRaw != null && spRaw !== '') ? (Number(spRaw) - 1) : null;
        bySampleId.set(sid, { pool: pool - 1, hto, superPool });
      });

      if (!bySampleId.size) { alert('Could not find "Sample ID" and "Genetic Pool" columns with values in that file.'); return; }

      const { samples } = samplesFromGrid();
      const currentIds = new Set(samples.map((s) => s.sampleId));
      const uploadedIds = new Set(bySampleId.keys());
      const missing = Array.from(currentIds).filter((id) => !uploadedIds.has(id));
      const extra = Array.from(uploadedIds).filter((id) => !currentIds.has(id));

      if (missing.length || extra.length) {
        const status = $('#poolingStatus');
        status.hidden = false;
        status.className = 'callout warn';
        status.innerHTML = '<strong>Upload not applied — sample list doesn\u2019t match Step 02.</strong> ' +
          (missing.length ? ('Missing from the file: ' + missing.slice(0, 8).map(esc).join(', ') + (missing.length > 8 ? ', …' : '') + '. ') : '') +
          (extra.length ? ('In the file but not in Step 02: ' + extra.slice(0, 8).map(esc).join(', ') + (extra.length > 8 ? ', …' : '') + '. ') : '') +
          'Make sure Step 02\u2019s samples match exactly what you downloaded (same sample IDs), then try again.';
        return;
      }

      const hasFullHTO = Array.from(bySampleId.values()).every((v) => v.hto != null && v.superPool != null);
      POOL_OVERRIDE = { bySampleId, hasFullHTO };
      runComputePooling();
    };
    reader.onerror = () => alert('Could not read that file.');
    reader.readAsArrayBuffer(file);
  }

  // ---- Run plan -------------------------------------------------------------
  // Derive the legacy arm/modality shape that workflow.js + handbook.js still
  // consume, from the new arm instances. Keeps those (large, careful) renderers
  // working without a rewrite while the cost engine uses the richer model.
  function legacyCompat(armInstances, lanesByChemArm) {
    const arms = new Set();
    const modalities = new Set();
    const lanesByArm = { unsort5: 0, asap3: 0, sort5: 0, flex: 0 };
    armInstances.forEach((a) => {
      const lanes = lanesByChemArm[a.key] || 0;
      if (a.chem === 'cite5' || a.chem === 'scrna5') {
        if (a.population === 'sorted') { arms.add('sort5'); lanesByArm.sort5 += lanes; }
        else { arms.add('unsort5'); lanesByArm.unsort5 += lanes; }
        if (a.chem === 'cite5') modalities.add('CITEseq'); else modalities.add('scRNAseq');
      } else if (a.chem === 'asap') {
        arms.add('asap3'); lanesByArm.asap3 += lanes; modalities.add('ASAPseq');
      } else if (a.chem === 'flex') {
        arms.add('flex'); lanesByArm.flex += lanes; modalities.add('Flex (fixed RNA profiling)');
        if (a.population === 'sorted') arms.add('sort5'); // still a FACS-sorted track for staining
      }
      if (a.population === 'stim') { arms.add('stim'); modalities.add('In vitro stimulation'); }
      if (a.population === 'sorted') modalities.add('Cell sorting (FACS enrichment)');
      if (a.vdj) modalities.add('VDJ (TCR/BCR)');
      if (a.chem === 'bulkrna') modalities.add('Bulk RNA');
      if (a.chem === 'bulktcrbcr') modalities.add('Bulk TCR/BCR');
    });
    return { arms: Array.from(arms), modalities: Array.from(modalities), lanesByArm };
  }

  function computeCurrent() {
    const armInstances = buildArmInstances(SEL);
    if (!armInstances.length) return { error: 'Design the experiment in Step 01 first (pick a population and its modality).' };
    if (!DATA) return { error: 'The spreadsheet has not loaded, so reagents & cost can\u2019t be computed. See the note in Step 01.' };
    const poolCalc = computePooling();
    if (!poolCalc) return { error: 'Add at least one sample in Step 02.' };
    const { samples, poolRes, htoRes, usedOverride, confounderCols } = poolCalc;
    const opts = readOpts();

    const cost = CostEngine.computeCost(DATA, {
      armInstances, nSamples: samples.length, samples, nPools: poolRes.nPools,
      superPools: htoRes.superPools, opts
    });

    // lanes keyed by arm-instance key, for the compat layer
    const lanesByChemArm = {};
    cost.laneBreakdown.forEach((l) => { lanesByChemArm[l.key] = l.lanes; });
    const legacy = legacyCompat(armInstances, lanesByChemArm);

    // cell-flow assumptions (editable in the Cell_Flow_Assumptions sheet)
    const A = (DATA && DATA.cellFlowAssumptions) || {};
    const cfa = (id, def) => (A[id] && A[id].value != null ? A[id].value : def);

    const plan = {
      selection: SEL, armInstances,
      modalities: legacy.modalities, arms: legacy.arms, lanesByArm: legacy.lanesByArm,
      nSamples: samples.length, samples,
      nPools: poolRes.nPools, pools: poolRes.pools, cap: opts.cap,
      superPools: htoRes.superPools, htoAssignments: htoRes.assignments,
      opts, includeBulk: legacy.modalities.includes('Bulk RNA') || legacy.modalities.includes('Bulk TCR/BCR'),
      confounderCols, confounderReport: poolRes.confounderReport, usedManualPooling: usedOverride,
      warnings: [].concat(poolRes.warnings, htoRes.warnings),
      laneBreakdown: cost.laneBreakdown,
      cellFlow: {
        start: cfa('cells_per_sample_start', 5000000),
        pooling: cfa('cells_per_sample_pooling', 1500000),
        bulk: cfa('cells_per_sample_bulk', 500000),
        bulkLow: cfa('cells_per_sample_bulk_low', 100000),
        stim: cfa('cells_per_sample_stim', 200000),
        poolLoad: cfa('cells_per_pool_load', 1200000),
        panelStain: cfa('cells_for_panel_stain', 1500000),
        atLoad: cfa('cells_at_load', 1200000),
        allcells: cfa('allcells_control_fraction', 0.25)
      }
    };

    // Protocol constraint: multi-donor genetic pools must have bulk RNA-seq to SNP-demux later.
    const multiSamplePool = (poolRes.pools || []).some((p) => (p.length || 0) > 1);
    const anyPooledArm = armInstances.some((a) => a.population === 'unsorted' || a.population === 'sorted');
    const hasBulkRna = SEL.bulk.enabled && SEL.bulk.modality === 'bulkrna';
    if (multiSamplePool && anyPooledArm && !hasBulkRna) {
      plan.warnings = plan.warnings.concat(['Genetic pools contain multiple donors, so bulk RNA-seq is required to SNP-demultiplex them later (protocol) \u2014 but no bulk RNA-seq is currently selected in Step 01.']);
    }

    return { plan, cost, poolRes, htoRes };
  }

  function runPlan() {
    const res = computeCurrent();
    if (res.error) { alert(res.error); return; }
    LASTPLAN = res;
    renderWorkflow(res.plan);
    renderReagents(res.plan, res.cost);
    renderProtocols(res.plan);
    // Auto-save the built plan to the current experiment (created from the
    // Project manager), so building persists without a separate save box.
    if (CURRENT_EXP_ID) {
      const rec = Store.getExperiment(CURRENT_EXP_ID);
      if (rec) {
        rec.state = serializeState();
        rec.snapshot = buildSnapshot(res);
        Store.saveExperiment(rec);
        exportExperimentToDrive(rec);
        pushReservedToSheet();
        renderManage();
        updatePlanExpBar();
        flashSaveStatus('Saved \u201c' + rec.name + '\u201d.', true);
      }
    }
    if (window.Scheduling) Scheduling.render($('#schedulingContent'));
    selectTop('plan', 'workflow');
  }

  function renderWorkflow(plan) {
    const manualNote = plan.usedManualPooling
      ? '<div class="callout info"><strong>Using your uploaded pooling strategy</strong> \u2014 pool/HTO assignments came from the spreadsheet you uploaded in Step 03, not the automatic algorithm.</div>' : '';
    const warn = plan.warnings.length
      ? '<div class="callout warn"><strong>Notes:</strong><ul>' + plan.warnings.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul></div>' : '';
    const summary = `
      <div class="summary-grid">
        <div class="summary-card"><span class="sc-num">${plan.nSamples}</span><span class="sc-lbl">samples</span></div>
        <div class="summary-card"><span class="sc-num">${plan.nPools}</span><span class="sc-lbl">genetic pools</span></div>
        <div class="summary-card"><span class="sc-num">${plan.superPools.length}</span><span class="sc-lbl">loading super-pool${plan.superPools.length === 1 ? '' : 's'}</span></div>
        <div class="summary-card"><span class="sc-num">${Object.values(plan.lanesByArm).reduce((a, b) => a + b, 0) || '—'}</span><span class="sc-lbl">10x lanes</span></div>
      </div>`;
    $('#workflowContent').innerHTML = `
      <div class="section-head"><h2>Workflow</h2><button class="btn ghost" onclick="window.print()">Print / save PDF</button></div>
      ${manualNote}${warn}${summary}
      <h3>Cell flow &amp; pooling</h3>
      <p class="muted">How cells move from samples \u2192 fixed per-sample takes (pooling / stim / bulk) \u2192 genetic pools \u2192 per-modality cells (unsort &amp; ASAP take a fixed amount per pool; sort takes the remainder) \u2192 loading channels \u2192 libraries. All the cell-count numbers (pooling take, bulk &amp; stim reserves, cells taken per pool, ALLCELLS %) live in the <strong>Cell_Flow_Assumptions</strong> sheet of the spreadsheet \u2014 edit there and reload. Channel counts come from the recovered-cell lane math (Step 04); the upstream numbers are raw thaw-cell counts.</p>
      <div class="flow-holder">${Workflow.renderSampleFlow(plan)}</div>
      <h3>Day-by-day plan &amp; personnel</h3>
      <p class="muted">One column per person, driven by the modalities you selected in Step 1 — add or remove a modality and this flowchart updates.</p>
      ${Workflow.renderWeekFlow(plan, DATA)}
      <h3>Batch scenario &amp; numbers ${infoDot('perSampleAllocation')}</h3>
      <p class="muted">Per-sample cell allocation, pool-size comparison, per-arm lane/chip/library counts, sort-population fill (dynamic lane assignment), and library-by-type pooling \u2014 computed from this plan and the assumptions in Step 04. Click any <span class="info-i-inline">i</span> for where a number comes from.</p>
      <div id="scenarioHolder">${(window.Pooling && window.Workflow) ? (function () { const sc = scenarioForPlan(plan); return sc ? Workflow.renderExplore(sc, (spp) => { const a = readScenarioAssumptions(); return Pooling.exploreScenario(Object.assign({}, a, { nSamples: plan.nSamples, samplesPerPool: spp, sortPopulations: sortSelList(), arms: sc.cfg.arms })); }) : ''; })() : ''}</div>`;
    updateNav();
  }

  // ---- Render: reagents & cost ----------------------------------------------
  let LAST_COST = null, LAST_PLAN = null;

  function fmtAmount(li) {
    if (li.totalAmount == null) return li.qty == null ? '\u2014' : esc(String(li.qty));
    const n = li.totalAmount;
    const s = (Math.abs(n) >= 100 || Number.isInteger(n)) ? Math.round(n).toLocaleString() : String(n);
    return esc(s + (li.units ? ' ' + li.units : ''));
  }
  function fmtOrderQty(li) {
    if (li.quantity == null) return li.unit && li.qty != null ? esc(li.qty + ' ' + li.unit) : '\u2014';
    return esc(li.quantity + ' ' + (li.quantityUnit || ''));
  }

  // ===== Modify experiment: editable summary + pipeline cell-flow + regenerate =====
  function renderModify() {
    const host = $('#modifyContent'); if (!host) return;
    const rec = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    let calc; try { calc = computePooling(); } catch (e) { calc = null; }
    if (!calc || !calc.samples || !calc.samples.length) { host.innerHTML = '<h2>Modify experiment</h2><p class="empty">Build a plan on <strong>Plan experiment</strong> first, then adjust it here.</p>'; return; }
    const nSamples = calc.samples.length;
    const nPools = (calc.poolRes && calc.poolRes.nPools) || 0;
    const lanes = laneOverridesFromCost(nSamples, nPools, calc.samples) || { unsort: 0, asap: 0, sort: 0 };
    const arms = (function () { try { return buildArmInstances(SEL); } catch (e) { return []; } })();
    const modList = []; arms.forEach((a) => { const lbl = a.label || a.key || a.chem; if (lbl && modList.indexOf(lbl) < 0) modList.push(lbl); });
    const poolOf = {}; if (calc.poolRes && calc.poolRes.pools) calc.poolRes.pools.forEach((p, i) => p.forEach((s) => { poolOf[s.sampleId] = i + 1; }));
    const sampleNo = sampleNoMap().byId;

    const laneRow = (key, label) => '<tr><td>' + esc(label) + '</td><td class="num"><input type="number" min="0" class="mod-lane" data-mod="' + key + '" value="' + (lanes[key] || 0) + '" style="width:80px"></td></tr>';
    const poolOpts = (cur) => { let o = ''; for (let k = 1; k <= Math.max(nPools, 1); k++) o += '<option value="' + k + '"' + (cur === k ? ' selected' : '') + '>' + k + '</option>'; o += '<option value="' + (nPools + 1) + '"' + (cur === nPools + 1 ? ' selected' : '') + '>+ new pool ' + (nPools + 1) + '</option>'; return o; };
    const sampleRows = calc.samples.slice().sort((a, b) => (sampleNo[a.sampleId] || 0) - (sampleNo[b.sampleId] || 0))
      .map((s) => '<tr><td><input class="mod-no" data-sid="' + escAttr(s.sampleId) + '" type="number" min="1" value="' + escAttr(sampleNo[s.sampleId] || '') + '" style="width:60px" title="Sample # (edit to override)"></td>'
        + '<td><input class="mod-sid" data-gid="' + s.id + '" data-sid="' + escAttr(s.sampleId) + '" value="' + escAttr(s.sampleId) + '" style="width:170px"></td>'
        + '<td><select class="mod-pool" data-sid="' + escAttr(s.sampleId) + '">' + poolOpts(poolOf[s.sampleId] || 1) + '</select></td>'
        + '<td><button class="btn tiny" data-mod-delsample="' + s.id + '">\u2715</button></td></tr>').join('');

    host.innerHTML = '<h2>Modify experiment <span class="who">' + esc((rec && rec.name) || '') + '</span></h2>'
      + '<p class="step-hint">Review the current plan and adjust the 10X lane counts per arm if needed. The cell-flow below updates live so you can sanity-check. When ready, <strong>Regenerate experiment materials</strong> builds a fresh, versioned set of protocols, tube labels and summary.</p>'
      + '<div class="mod-grid" style="display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start">'
      + '<div><h3>Summary</h3><table class="cost-table"><tbody>'
      + '<tr><td>Modalities / arms</td><td>' + esc(modList.join(', ') || '\u2014') + '</td></tr>'
      + '<tr><td>Samples</td><td class="num">' + nSamples + '</td></tr>'
      + '<tr><td>Genetic pools</td><td class="num">' + nPools + '</td></tr>'
      + '</tbody></table>'
      + '<h3 style="margin-top:16px">10X lanes per arm <span class="who">(editable)</span></h3>'
      + '<table class="cost-table"><thead><tr><th>Arm</th><th class="num">Lanes</th></tr></thead><tbody>'
      + laneRow('unsort', "5' unsort") + laneRow('asap', 'ASAP') + laneRow('sort', "5' sort")
      + '</tbody></table>'
      + '<div class="row-actions" style="margin-top:8px"><button class="btn ghost" id="modReset">Reset lanes to computed</button></div>'
      + '</div>'
      + '<div style="flex:1;min-width:280px"><h3>Samples &amp; pool assignments <span class="who">(editable)</span></h3><p class="who small">Sample # defaults to pool order; type to override it (used on labels, Cell count &amp; Cellaca mapping).</p><div style="max-height:360px;overflow:auto"><table class="cost-table"><thead><tr><th class="num">Sample #</th><th>Sample ID</th><th>Pool</th><th></th></tr></thead><tbody>' + sampleRows + '</tbody></table></div>'
      + '<div class="row-actions" style="margin-top:6px"><button class="btn ghost" id="modResetNos">Reset # to pool order</button></div>'
      + '<div class="row-actions" style="margin-top:6px"><button class="btn ghost" id="modAddSample">+ Add sample</button></div></div>'
      + '</div>'
      + '<h3 style="margin-top:22px">Pipeline cell-flow (this strategy)</h3><div id="modifyFlow"></div>'
      + '<div class="row-actions" style="margin-top:16px"><button class="btn primary" id="modRegen">Regenerate experiment materials (new version)</button><span id="modRegenStatus" class="muted"></span></div>';

    // render the cell-flow for the current (possibly overridden) lanes
    try {
      const flowHost = $('#modifyFlow');
      if (flowHost && window.Workflow && window.Pooling) {
        const a = readScenarioAssumptions();
        const sc = Pooling.exploreScenario(Object.assign({}, a, {
          nSamples: nSamples, nPools: nPools, samplesPerPool: nPools ? Math.round(nSamples / nPools) : nSamples,
          sortPopulations: sortSelList(),
          stainTargetUnsort: (LYO_SEL.cite5 && LYO_SEL.cite5.stainCells) || 1500000,
          stainTargetAsap: (LYO_SEL.asap && LYO_SEL.asap.stainCells) || 1500000,
          arms: { unsort: (lanes.unsort || 0) > 0, asap: (lanes.asap || 0) > 0, sort: (lanes.sort || 0) > 0 },
          laneOverrides: lanes
        }));
        flowHost.innerHTML = Workflow.renderPipelineFlow(sc);
      }
    } catch (e) { $('#modifyFlow').innerHTML = '<p class="who">Cell-flow unavailable: ' + esc(String(e)) + '</p>'; }

    host.querySelectorAll('.mod-lane').forEach((el) => el.addEventListener('change', () => {
      const base = LANE_OVERRIDE || Object.assign({}, LANE_COMPUTED || lanes);
      const v = parseInt(el.value, 10); base[el.dataset.mod] = isNaN(v) || v < 0 ? 0 : v;
      LANE_OVERRIDE = base; renderModify();
    }));
    const reset = $('#modReset'); if (reset) reset.addEventListener('click', () => { LANE_OVERRIDE = null; renderModify(); });
    // pool assignment edits (via POOL_OVERRIDE)
    host.querySelectorAll('.mod-pool').forEach((el) => el.addEventListener('change', () => { modSetPool(el.dataset.sid, parseInt(el.value, 10) - 1); }));
    host.querySelectorAll('.mod-no').forEach((el) => el.addEventListener('change', () => {
      const sid = el.dataset.sid; const v = el.value.trim();
      if (v === '' || isNaN(Number(v))) delete SAMPLE_NO_OVERRIDE[sid]; else SAMPLE_NO_OVERRIDE[sid] = Number(v);
      modPersist(); renderModify();
    }));
    // sample id rename (edits the grid; repools fresh to avoid stale keys)
    host.querySelectorAll('.mod-sid').forEach((el) => el.addEventListener('change', () => {
      const gid = parseInt(el.dataset.gid, 10); const val = el.value.trim();
      if (GRID_ROWS[gid] !== undefined) { GRID_ROWS[gid][0] = val; POOL_OVERRIDE = null; modPersist(); renderModify(); }
    }));
    host.querySelectorAll('button[data-mod-delsample]').forEach((b) => b.addEventListener('click', () => {
      const gid = parseInt(b.dataset.modDelsample, 10);
      if (GRID_ROWS[gid] !== undefined && confirm('Remove this sample from the experiment?')) { GRID_ROWS.splice(gid, 1); POOL_OVERRIDE = null; modPersist(); renderModify(); }
    }));
    const addSample = $('#modAddSample'); if (addSample) addSample.addEventListener('click', () => {
      const name = (prompt('New sample ID:') || '').trim(); if (!name) return;
      GRID_ROWS.push([name, '', '', ''].concat(CUSTOM_COLS.map(() => ''))); POOL_OVERRIDE = null; modPersist(); renderModify();
    });
    const regen = $('#modRegen'); if (regen) regen.addEventListener('click', () => regenerateMaterials(rec));
    const resetNos = $('#modResetNos'); if (resetNos) resetNos.addEventListener('click', () => { if (confirm('Reset all sample numbers to pool order?')) { SAMPLE_NO_OVERRIDE = {}; modPersist(); renderModify(); } });
  }
  function modPersist() {
    if (!CURRENT_EXP_ID) return; const rec = Store.getExperiment(CURRENT_EXP_ID); if (!rec) return;
    try { rec.state = serializeState(); } catch (e) { /* best-effort */ } Store.saveExperiment(rec);
  }
  function modSetPool(sampleId, pool0) {
    let calc; try { calc = computePooling(); } catch (e) { return; }
    if (!(POOL_OVERRIDE && overrideMatchesSamples(POOL_OVERRIDE, calc.samples))) {
      const ov = { bySampleId: new Map(), hasFullHTO: false };
      (calc.poolRes.pools || []).forEach((p, i) => p.forEach((s) => ov.bySampleId.set(s.sampleId, { pool: i, hto: null, superPool: null })));
      POOL_OVERRIDE = ov;
    }
    const info = POOL_OVERRIDE.bySampleId.get(sampleId) || { pool: 0, hto: null, superPool: null };
    info.pool = pool0 < 0 ? 0 : pool0; POOL_OVERRIDE.bySampleId.set(sampleId, info);
    modPersist(); renderModify();
  }
  function regenerateMaterials(rec) {
    const stEl = $('#modRegenStatus');
    if (!rec || !rec.snapshot) { if (stEl) stEl.textContent = ' Save the experiment on Plan experiment first (build the plan, then Save).'; return; }
    if (!confirm('Regenerate all experiment materials (protocols, tube labels, summary) as a NEW version? The previous version is kept.')) return;
    if (stEl) stEl.textContent = ' Building materials\u2026';
    exportExperimentToDrive(rec, { newVersion: true })
      .then(() => { if (stEl) stEl.textContent = ' Done \u2014 new version ' + ((rec.materialVersions && rec.materialVersions.length) || '') + ' created in Drive.'; renderModify(); })
      .catch((e) => { if (stEl) stEl.textContent = ' Failed: ' + e; });
  }

  function renderReagents(plan, cost) {
    LAST_COST = cost; LAST_PLAN = plan;
    const byCat = {};
    cost.lineItems.forEach((li) => { (byCat[li.category] = byCat[li.category] || []).push(li); });

    // Catalog lookups: kits by Kit_Catalog id (from the line's source), and
    // reagents/supplies/antibodies by item_id.
    const kitById = {}; ((DATA && DATA.kits) || []).forEach((k) => { kitById[k.id] = k; });
    const catById = {};
    ((DATA && DATA.supplies) || []).forEach((s) => { if (s.id && s.catalog) catById[s.id] = s.catalog; });
    ((DATA && DATA.antibodies) || []).forEach((a) => { if (a.id && a.catalog) catById[a.id] = a.catalog; });
    const kitInfo = (li) => { const m = /Kit_Catalog\s+(K\d+)/.exec(li.source || ''); return (m && kitById[m[1]]) || {}; };

    const REAGENT_CATS = ['Antibodies & staining', 'Buffers & reagents', 'Plasticware & consumables'];
    const order = ['10x kits'].concat(REAGENT_CATS, ['Sequencing']);
    const cats = order.filter((c) => byCat[c]).concat(Object.keys(byCat).filter((c) => order.indexOf(c) === -1));

    const tables = cats.map((cat) => {
      const items = byCat[cat];
      if (REAGENT_CATS.indexOf(cat) !== -1) {
        const rows = items.map((li) => `
          <tr class="${li.placeholder ? 'is-placeholder' : ''}">
            <td>${esc(li.label)}</td>
            <td>${esc(catById[li.itemId] || '\u2014')}</td>
            <td class="num">${fmtAmount(li)}</td>
            <td class="num">${fmtOrderQty(li)}</td>
            <td>${esc(li.scope || '')}</td>
            <td class="num">${li.total == null ? '<span class="ph-tag">no price</span>' : fmtMoney(li.total)}</td>
            <td class="src">${li.note ? esc(li.note) : ''}</td>
          </tr>`).join('');
        return `<h3>${esc(cat)}</h3><table class="cost-table">
          <thead><tr><th>Reagent</th><th>Catalog #</th><th class="num">Total needed</th><th class="num">Order qty</th><th>Scope</th><th class="num">Est. cost</th><th>Notes</th></tr></thead>
          <tbody>${rows}</tbody></table>`;
      }
      if (cat === '10x kits') {
        const rows = items.map((li) => {
          const k = kitInfo(li);
          const lanes = (li.qty == null ? null : Number(li.qty));
          const nKits = (k.reactions && lanes != null) ? Math.ceil(lanes / k.reactions) : null;
          const kitSize = k.reactions ? (k.reactions + ' rxn/kit') : '';
          return `
          <tr class="${li.placeholder ? 'is-placeholder' : ''}">
            <td>${esc(li.label)}</td>
            <td>${esc(k.part || '\u2014')}</td>
            <td class="num">${li.qty == null ? '\u2014' : esc(li.qty)}</td>
            <td class="num"><strong>${nKits == null ? '\u2014' : nKits}</strong></td>
            <td class="num">${esc(kitSize || '\u2014')}</td>
            <td class="num">${li.total == null ? '<span class="ph-tag">needs data</span>' : fmtMoney(li.total)}</td>
            <td class="src">${esc(li.source)}</td>
          </tr>`; }).join('');
        return `<h3>10x kits</h3><table class="cost-table">
          <thead><tr><th>Kit</th><th>Catalog #</th><th class="num">Lanes</th><th class="num"># kits</th><th class="num">Kit size</th><th class="num">Est. cost</th><th>Source</th></tr></thead>
          <tbody>${rows}</tbody></table>`;
      }
      const rows = items.map((li) => `
        <tr class="${li.placeholder ? 'is-placeholder' : ''}">
          <td>${esc(li.label)}</td>
          <td class="num">${li.qty == null ? '\u2014' : esc(li.qty)}</td>
          <td>${esc(li.unit || '')}</td>
          <td class="num">${li.unitCost == null ? '\u2014' : fmtMoney(li.unitCost)}</td>
          <td class="num">${li.total == null ? '<span class="ph-tag">needs data</span>' : fmtMoney(li.total)}</td>
          <td class="src">${esc(li.source)}</td>
        </tr>`).join('');
      return `<h3>${esc(cat)}</h3><table class="cost-table">
        <thead><tr><th>Item</th><th class="num">Qty</th><th>Unit</th><th class="num">Unit cost</th><th class="num">Total</th><th>Source</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
    }).join('');

    const laneRows = cost.laneBreakdown.map((l) => `<tr><td>${esc(l.label || l.arm)}${l.vdj ? ' <span class="who">+ V(D)J</span>' : ''}</td><td class="num">${l.lanes || (l.lanes === 0 ? '\u2014' : '\u2014')}</td><td>${esc(l.libraries.join(', '))}</td><td>${esc(l.detail)}</td></tr>`).join('');

    const notes = cost.notes.length ? '<div class="callout info"><strong>How to read this:</strong><ul>' + cost.notes.map((n) => '<li>' + esc(n) + '</li>').join('') + '</ul></div>' : '';

    // TotalSeq / HTO hashtag reminder — one unique hashtag per genetic pool. These
    // are selected from the TotalSeq inventory, not purchased as a bulk reagent.
    const nPools = plan.nPools || 0;
    const pArms = plan.arms || [];
    const htoLines = [];
    if (pArms.indexOf('asap3') !== -1 && nPools) htoLines.push(nPools + ' distinct <strong>TotalSeq-A</strong> hashtag vials (ASAP-seq)');
    if ((pArms.indexOf('unsort5') !== -1 || pArms.indexOf('sort5') !== -1) && nPools) htoLines.push(nPools + ' distinct <strong>TotalSeq-C</strong> hashtag vials (CITE-seq / sort 5\u2032)');
    const htoReminder = htoLines.length
      ? '<div class="callout info"><strong>TotalSeq / HTOs \u2014 hashtag reminder:</strong> this experiment needs ' + htoLines.join(' and ') + ' \u2014 one unique hashtag per genetic pool (don\u2019t reuse a hashtag within a batch). This is <em>not</em> a purchase; choose available vials from the <strong>TotalSeq / HTOs</strong> tab in Inventory.</div>'
      : '';

    $('#reagentsContent').innerHTML = `
      <div class="section-head"><h2>Reagents &amp; cost</h2>
        <div class="head-actions">
          <button class="btn" id="exportReagentsBtn">Export reagent list (Excel)</button>
          <button class="btn ghost" onclick="window.print()">Print / save PDF</button>
        </div>
      </div>
      <div class="cost-headline">
        <div><span class="ch-num">${fmtMoney(cost.knownTotal)}</span><span class="ch-lbl">estimated total (priced items)</span></div>
        <div><span class="ch-num">${cost.nPlaceholders}</span><span class="ch-lbl">line items still need spreadsheet data</span></div>
      </div>
      ${notes}
      ${htoReminder}
      <h3>Lanes per load</h3>
      <table class="cost-table"><thead><tr><th>Population &middot; modality</th><th class="num">Lanes</th><th>Libraries</th><th>Basis</th></tr></thead><tbody>${laneRows}</tbody></table>
      ${tables}`;

    const eb = $('#exportReagentsBtn');
    if (eb) eb.addEventListener('click', downloadReagentXlsx);
  }

  function downloadReagentXlsx() {
    if (!LAST_COST) return;
    const cost = LAST_COST;
    const header = ['Category', 'Reagent', 'Item ID', 'Catalog #', 'Total needed', 'Units', '# kits', 'Order quantity', 'Scope', 'Est. cost ($)', 'Notes / source'];
    const rows = [header];
    const kitById = {}; ((DATA && DATA.kits) || []).forEach((k) => { kitById[k.id] = k; });
    const catById = {};
    ((DATA && DATA.supplies) || []).forEach((s) => { if (s.id && s.catalog) catById[s.id] = s.catalog; });
    ((DATA && DATA.antibodies) || []).forEach((a) => { if (a.id && a.catalog) catById[a.id] = a.catalog; });
    const REAGENT_CATS = ['Antibodies & staining', 'Buffers & reagents', 'Plasticware & consumables'];
    // reagents first (the user's focus), then kits + sequencing
    const orderedCats = REAGENT_CATS.concat(['10x kits', 'Sequencing']);
    const seen = new Set();
    const emit = (li) => {
      const isReagent = ('totalAmount' in li);
      const km = /Kit_Catalog\s+(K\d+)/.exec(li.source || ''); const kit = km ? kitById[km[1]] : null;
      const catalog = kit ? (kit.part || '') : (catById[li.itemId] || '');
      const nKits = (kit && kit.reactions && li.qty != null) ? Math.ceil(Number(li.qty) / kit.reactions) : '';
      rows.push([
        li.category || '',
        li.label || '',
        li.itemId || '',
        catalog,
        isReagent ? (li.totalAmount == null ? '' : li.totalAmount) : (li.qty == null ? '' : li.qty),
        isReagent ? (li.units || '') : (li.unit || ''),
        nKits,
        li.quantity != null ? (li.quantity + ' ' + (li.quantityUnit || '')) : '',
        li.scope || '',
        li.total == null ? '' : li.total,
        li.note || li.source || ''
      ]);
    };
    orderedCats.forEach((cat) => cost.lineItems.forEach((li) => { if (li.category === cat) { emit(li); seen.add(li); } }));
    cost.lineItems.forEach((li) => { if (!seen.has(li)) emit(li); });

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 24 }, { wch: 34 }, { wch: 8 }, { wch: 12 }, { wch: 14 }, { wch: 22 }, { wch: 22 }, { wch: 12 }, { wch: 60 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Reagent list');
    XLSX.writeFile(wb, 'reagent_list.xlsx');
  }

  // ---- Render: protocols (printable packet) ---------------------------------
  // Build a clean, arm-gated SOP as a Word-compatible HTML document, reusing the
  // same number-injected protocol sections shown on the Protocols page. Only the
  // sections relevant to this experiment's arms are included.
  // Insert a checkbox at the start of every step in a "chk" list (works for the
  // on-page packet — interactive — and the Word SOP — renders as a checkbox).
  function stepCheckboxes(html, useChar) {
    try {
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      tmp.querySelectorAll('ol.chk > li, ul.chk > li').forEach((li) => {
        if (useChar) {
          li.insertBefore(document.createTextNode('\u2610\u00a0\u00a0'), li.firstChild);
        } else {
          const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'stepchk';
          li.insertBefore(document.createTextNode('\u00a0'), li.firstChild);
          li.insertBefore(cb, li.firstChild);
        }
      });
      return tmp.innerHTML;
    } catch (e) { return html; }
  }

  let PROTOCOL_PLAN = null;
  function buildSopHtml(plan) {
    const rec = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    const proj = (rec && rec.project) || CURRENT_PROJECT || '';
    const expName = (rec && rec.name) || 'experiment';
    const dateStr = (rec && rec.date) || 'MM/DD/YYYY';
    const batch = (rec && rec.batchRef) ? ('Batch ' + rec.batchRef) : 'Batch #';
    const nSuper = (plan.superPools && plan.superPools.length) || 1;
    const modLabels = {
      unsort5: "Unsort 5' CITE-seq — GEX, CSP (ADT), HTO" + (plan.armsVdj && plan.armsVdj.unsort5 ? ', V(D)J' : ''),
      asap3: 'ASAP-seq — ATAC, CSP (ADT), HTO',
      sort5: "Sorted 5' scRNA-seq — GEX, ADT (HTO)" + (plan.armsVdj && plan.armsVdj.sort5 ? ', V(D)J-TCR' : '')
    };
    const modlist = plan.arms.map((a) => modLabels[a] || a);
    if (plan.includeBulk) modlistPush(modlist, 'Bulk RNA-seq');
    if (plan.modalities.includes('In vitro stimulation')) modlistPush(modlist, "In vitro stim → 5' scRNA-seq w/ HTO");
    function modlistPush(arr, v) { arr.push(v); }

    const lanesByArm = plan.lanesByArm || {};
    const sec = (title, bodyHtml, color) => bodyHtml ? `<div class="sop-section sop-${color || 'blue'}" style="page-break-before:always"><div class="sop-tab">&nbsp;</div><h1>${esc(title)}</h1>${bodyHtml}</div>` : '';

    const designTable = `<table><tbody>
      <tr><th>Date (batch day)</th><td>${esc(dateStr)}</td></tr>
      <tr><th>Project</th><td>${esc(proj)}</td></tr>
      <tr><th>Batch</th><td>${esc(batch)}</td></tr>
      <tr><th>Samples / pools</th><td>${plan.nSamples} samples, ${plan.nPools} pools, ${nSuper} loading super-pool(s)</td></tr>
      <tr><th>Modalities</th><td>${modlist.map(esc).join('<br>')}</td></tr>
      <tr><th>Kits</th><td>${plan.arms.includes('unsort5') || plan.arms.includes('sort5') ? "10X 5' v3 with feature barcode<br>" : ''}${plan.arms.includes('asap3') ? '10X ATAC v2<br>' : ''}HTOs (TotalSeq-C for 5′; TotalSeq-A for ASAP)</td></tr>
      <tr><th>CSP staining panels</th><td>${plan.arms.includes('unsort5') ? 'TotalSeq-C 137-marker (399905) — unsort 5′<br>' : ''}${plan.arms.includes('asap3') ? 'TotalSeq-A 154+9-iso (399907) — ASAP' : ''}</td></tr>
    </tbody></table>`;

    // arm-gated batch-day sections, reusing the on-page generators
    let body = '';
    body += sec('A. Experimental design', designTable, 'blue');
    body += sec('Preparation checklist — T−3 weeks → batch day', prepChecklists(plan), 'blue');
    body += sec('Preparation — media & buffers (1–3 days before)', prepProtocol(plan), 'blue');
    body += sec('B1. PBMC thaw & count', thawProtocol(plan), 'blue');
    body += sec('B2. PBMC pool & split', poolProtocol(plan), 'blue');
    if (plan.arms.includes('unsort5')) body += sec("B3. Unsort 5' CITE-seq staining", citeStainProtocol(plan), 'green');
    if (plan.arms.includes('asap3')) body += sec('B4. ASAP-seq staining & protocol', asapProtocol(plan), 'orange');
    if (plan.arms.includes('sort5')) body += sec("B5. Sort 5' staining", sortStainProtocol(plan), 'purple');
    if (plan.includeBulk) body += sec('B6. Bulk RNA-seq Trizol isolation', bulkProtocol(plan), 'yellow');
    if (plan.modalities.includes('In vitro stimulation')) body += sec('B7. In vitro stimulation', stimProtocol(plan), 'pink');
    body += sec('B8. 10X Chromium GEM chip loading', gemLoadProtocol(plan), 'blue');
    body = stepCheckboxes(body, true);

    const style = `<style>
      body{font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#1a1a1a;line-height:1.35;}
      .sop-section{page-break-before:always;}
      .sop-tab{height:8pt;line-height:8pt;font-size:1pt;margin:0 0 4pt 0;}
      .sop-section h1{font-size:16pt;color:#1f2b3a;border:0;padding:6pt 8pt;margin:0 0 10pt 0;}
      .sop-blue .sop-tab{background:#4472C4}.sop-blue h1{background:#CDE9F3;border-bottom:2pt solid #4472C4}
      .sop-green .sop-tab{background:#70AD47}.sop-green h1{background:#E2EFD9;border-bottom:2pt solid #70AD47}
      .sop-purple .sop-tab{background:#7030A0}.sop-purple h1{background:#DDC8FF;border-bottom:2pt solid #7030A0}
      .sop-orange .sop-tab{background:#ED7D31}.sop-orange h1{background:#FBE4D5;border-bottom:2pt solid #ED7D31}
      .sop-yellow .sop-tab{background:#F6B000}.sop-yellow h1{background:#FFF2CC;border-bottom:2pt solid #F6B000}
      .sop-pink .sop-tab{background:#CE46BE}.sop-pink h1{background:#F4D7EE;border-bottom:2pt solid #CE46BE}
      h2,h3,h4,h5{color:#2f5c8f;margin:10pt 0 4pt;}
      table{border-collapse:collapse;width:100%;margin:7pt 0 10pt;}
      th,td{border:1px solid #B7C0CC;padding:5px 7px;text-align:left;vertical-align:top;font-size:10pt;}
      th{background:#F2F2F2;font-weight:bold;}
      .num{text-align:right;}
      ol,ul{margin:4pt 0 8pt 18pt;} li{margin:3pt 0;}
      ol.chk,ul.chk{list-style:none;margin-left:2pt;padding-left:2pt;}
      td{height:18px;}
      .recipe-box{border:1px solid #D9E2F3;border-left:4px solid #4472C4;padding:7px 10px;margin:8pt 0;background:#FAFCFF;}
      .sop-tip{background:#FFF7E6;border:1px solid #F3D891;border-left:4px solid #EDB000;padding:8px 10px;margin:9pt 0;color:#5F4A18;}
      .pp-meta{background:#F2F2F2;border:1px solid #D9DEE5;padding:5px 7px;}
      .who,.muted,.pp-source,.pp-meta{color:#5a6570;font-size:9pt;}
      p{margin:4pt 0;}
    </style>`;
    const titlePage = `<div style="text-align:center;margin-top:60pt">
      <div style="font-size:22pt;color:#1f3a5f;font-weight:bold">Multi-modal single-cell sequencing pipeline SOP</div>
      <div style="font-size:13pt;margin-top:8pt">Tsang Lab / CZ Biohub NY Yale Annex</div>
      <div style="font-size:14pt;margin-top:24pt"><strong>${esc(proj)}</strong> — ${esc(expName)}</div>
      <div style="font-size:12pt;margin-top:4pt">${esc(batch)} · ${esc(dateStr)} · ${plan.nSamples} samples / ${plan.nPools} pools</div>
      <div class="who" style="margin-top:20pt">Generated from the single-cell planner with this experiment's numbers filled in.</div>
    </div>`;
    return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>SOP — ${esc(proj)} ${esc(expName)}</title>${style}</head><body>${titlePage}${body}</body></html>`;
  }

  function downloadWordSOP() {
    const plan = PROTOCOL_PLAN;
    if (!plan) { alert('Build a plan first (Plan experiment → Build).'); return; }
    const rec = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    const name = ((rec && rec.project) || 'project') + '_' + ((rec && rec.name) || 'experiment');
    const html = buildSopHtml(plan);
    const blob = new Blob(['\ufeff', html], { type: 'application/msword' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'SOP_' + name.replace(/[^a-z0-9_\-]+/gi, '_') + '.doc';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  // Preparation timeline checklists (T-3 weeks -> morning-of), arm-gated with
  // plan-driven counts. Rendered as checkbox lists.
  function prepChecklists(plan) {
    const hasSort = plan.arms.includes('sort5');
    const hasAsap = plan.arms.includes('asap3');
    const hasBulk = !!plan.includeBulk;
    const hasStim = plan.modalities.includes('In vitro stimulation');
    const nSuper = (plan.superPools && plan.superPools.length) || 1;
    const modalityTubes = plan.arms.map((a) => ({ unsort5: 'unsort', asap3: 'ASAP', sort5: 'sort' }[a] || a)).join('/');
    const li = (t) => '<li>' + t + '</li>';
    return `
      <div class="recipe-box"><h5>T&minus;3 weeks &mdash; booking &amp; ordering</h5>
      <ul class="chk">
        ${li('Book equipment on the shared lab calendar: BSC hoods (3 people first half-day for thawing, 2 second half), centrifuges (\u22651 large; ideally one 25&nbsp;&deg;C + one 4&nbsp;&deg;C, + a benchtop), Chromium X/Xi, Cellaca MX counter, \u22651 PCR thermocycler.')}
        ${hasSort ? li('Reserve flow-sorter time (Flow Core or Rory in the Annex).') : ''}
        ${li('Check ALL reagents and consumables; order anything running low (use the Reagents &amp; cost list).')}
        ${li('Confirm 10X kit lot numbers and expiry are sufficient for ' + plan.nSamples + ' samples / ' + Object.values(plan.lanesByArm || {}).reduce((a, b) => a + b, 0) + ' lanes.')}
        ${li('If new lyo/HTO panel lots are used, confirm no re-titration is needed.')}
        ${li('Double-check the labeled cryovials for this batch fit securely into the Thawsome.')}
      </ul></div>

      <div class="recipe-box"><h5>T&minus;1 week &mdash; design lock</h5>
      <ul class="chk">
        ${li('Finalize the sample \u2192 pool assignment table (' + plan.nPools + ' pools; avoid pooling genetically related/too-similar subjects).')}
        ${li('Run the pipeline calculator with this batch\u2019s sample list to confirm pool sizes, lane/chip counts, and lyo-panel needs.')}
        ${li('Confirm barcode / dual-index plate assignments for GEX/CSP/TCR/BCR do not collide with any other run sequenced together.')}
        ${li('Generate the label manifest for this batch (sample ID, pool #, modality arm, date) from the calculator output.')}
      </ul></div>

      <div class="recipe-box"><h5>1&ndash;3 days before &mdash; labels &amp; buffers</h5>
      <ul class="chk">
        ${li('Print labels (lids + tubes) for: thawing tubes, pool tubes, modality-split tubes (' + modalityTubes + ')' + (hasBulk ? ', bulk RNA-seq aliquot tubes' : '') + '. Color-code/flag by pool # and modality arm.')}
        ${li('Prep fresh buffers (see the scaled recipes in the prep section): staining/wash buffer (PBS + 2% BSA)' + (hasSort ? ', FACS buffer (PBS + 10% FBS)' : '') + ', DNase I stock (10&nbsp;mg/mL).')}
        ${li('Re-constitute oligos if needed.')}
        ${li('Confirm cooling blocks are pre-chilled and plenty of ice is available as backup.')}
        ${li('Assign each participant a fixed station/role.')}
        ${hasSort ? li('Prep single-color control beads and run controls on the flow sorter (vortex beads, ~15&nbsp;µL into 50&nbsp;µL FACS buffer, add Abs at ~\u00bd conc; L/D via cells or L/D beads).') : ''}
      </ul></div>

      <div class="recipe-box"><h5>1 day before &mdash; labware &amp; cryovials</h5>
      <ul class="chk">
        ${li('Label and set out all tubes: <strong>' + plan.nSamples + ' + ALLCELLS</strong> 15&nbsp;mL conicals for thawing, <strong>' + plan.nPools + '</strong> pool tubes, <strong>' + plan.arms.length + '</strong> modality-split superpool FACS round-bottom tubes' + (hasBulk ? ', <strong>' + plan.nSamples + ' + ALLCELLS</strong> bulk RNA-seq 1.5&nbsp;mL LoBind tubes' : '') + '.')}
        ${li('Organize sample cryovials into groups (one per thawer); keep at &minus;80&nbsp;&deg;C / LN\u2082 until batch day.')}
        ${li('Confirm the HTO panel is prepped and located; set aside the HTOs to use (' + plan.nPools + ' unique per modality).')}
        ${li('Thaw the FBS needed and leave at 4&nbsp;&deg;C.')}
        ${li('Print pooling and counting worksheets for all personnel.')}
        ${li('Review the batch-day plan; note what needs to come out of &minus;80/&minus;20&nbsp;&deg;C and when.')}
      </ul></div>

      <div class="recipe-box"><h5>Morning of &mdash; setup</h5>
      <ul class="chk">
        ${li('Clean BSC surfaces with 70% EtOH; UV 15&nbsp;min.')}
        ${li('Water bath to <strong>37&nbsp;&deg;C</strong>; centrifuge to <strong>25&nbsp;&deg;C</strong> to start.')}
        ${li('Pre-warm media ingredients at 37&nbsp;&deg;C: RPMI-1640, FBS, DNase I (must warm to activate).')}
        ${li('Verify the label manifest matches the physical cryovials on hand (scan/check sample #s).')}
        ${li('Set up each hood: tube rack per thawing batch, waste containers, pipette tips (20/200/1000&nbsp;µL), serological pipettes (2/5/10/25&nbsp;mL) + pipettor \u2014 one set per thawer.')}
        ${li('Make fresh R10 media + thawing media (R10 + DNase I 0.1&nbsp;mg/mL); aliquot 10&nbsp;mL/tube into ' + plan.nSamples + ' + ALLCELLS 15&nbsp;mL tubes; pre-warm at 37&nbsp;&deg;C.')}
      </ul></div>`;
  }

  function renderProtocols(plan) {
    const stagesById = {};
    (DATA.stages || []).forEach((s) => { stagesById[s.id] = s; });

    // Which stages are in play
    const active = ['ST1', 'ST2'];
    if (plan.arms.includes('unsort5')) active.push('ST3');
    if (plan.arms.includes('asap3')) active.push('ST4');
    if (plan.arms.includes('sort5')) active.push('ST5');
    if (plan.modalities.includes('In vitro stimulation')) active.push('ST13');
    if (plan.includeBulk) active.push('ST14');
    active.push('ST6'); // GEM
    active.push('ST8'); // library
    active.push('ST15'); // sequencing

    // Detailed step-by-step protocols, keyed by stage id.
    const expanded = {
      ST1: thawProtocol(plan),
      ST2: poolProtocol(plan),
      ST3: citeStainProtocol(plan),
      ST4: asapProtocol(plan),
      ST5: sortStainProtocol(plan),
      ST13: stimProtocol(plan),
      ST14: bulkProtocol(plan),
      ST6: gemLoadProtocol(plan)
    };

    const checklistPage = `<article class="protocol-page pp-blue">
        <header class="pp-head"><span class="pp-no">Prep</span><h2>Preparation checklist &mdash; T&minus;3 weeks &rarr; batch day</h2></header>
        <p class="pp-meta"><strong>Source:</strong> Tsang SOP &ldquo;Preparation / Pre-batch checklist&rdquo;</p>
        ${prepChecklists(plan)}
      </article>`;

    const prepPage = `<article class="protocol-page pp-blue">
        <header class="pp-head"><span class="pp-no">Protocol 0</span><h2>Pre-experiment preparation &mdash; media &amp; buffers</h2></header>
        <p class="pp-meta"><strong>When:</strong> 1&ndash;3 days before &middot; <strong>Source:</strong> MADI02 batch protocol + CITE-seq batch protocol</p>
        ${prepProtocol(plan)}
      </article>`;

    const pages = stepCheckboxes(checklistPage + prepPage + active.filter((id, i, a) => a.indexOf(id) === i).map((id, idx) => {
      const st = stagesById[id];
      const title = st ? st.name + ' — ' + (st.description || '') : id;
      const body = expanded[id] || placeholderProtocol(st);
      // Modality colour coding: blue thaw/split, green 5' unsort+stain, purple sort,
      // orange ATAC/ASAP, yellow bulk RNA, pink stim, blue 10x chip loading.
      const STAGE_COLOR = { ST1: 'blue', ST2: 'blue', ST3: 'green', ST5: 'purple', ST4: 'orange', ST14: 'yellow', ST13: 'pink', ST6: 'blue', ST8: 'slate', ST15: 'slate' };
      const color = STAGE_COLOR[id] || 'slate';
      return `<article class="protocol-page pp-${color}">
        <header class="pp-head"><span class="pp-no">Protocol ${idx + 1}</span><h2>${esc(title)}</h2></header>
        ${st ? `<p class="pp-meta"><strong>When:</strong> ${esc(st.timeWindow || 'TBD')} · <strong>Staffing:</strong> ${esc(st.personnelRule || 'TBD')} · <strong>Source:</strong> ${esc(st.sourceDoc || '—')}</p>` : ''}
        ${body}
      </article>`;
    }).join(''));

    $('#protocolsContent').innerHTML = `
      <div class="section-head"><h2>Protocol packet</h2><div><button class="btn ghost" id="dlWordSop">Download Word SOP</button> <button class="btn primary" onclick="window.print()">Print packet</button></div></div>
      <p class="muted">Workflow summary first, then one page per module. “Download Word SOP” gives a Word document with only the sections for this experiment’s arms, all numbers filled in. “Print packet” → Save as PDF for a printable version.</p>
      <article class="protocol-page cover pp-slate">
        <header class="pp-head"><span class="pp-no">Overview</span><h2>Experiment workflow</h2></header>
        <div class="flow-holder">${Workflow.renderSampleFlow(plan)}</div>
        ${Workflow.renderWeekFlow(plan, DATA)}
      </article>
      ${pages}`;
    PROTOCOL_PLAN = plan;
    const dlBtn = document.getElementById('dlWordSop');
    if (dlBtn) dlBtn.addEventListener('click', downloadWordSOP);
  }

  function thawProtocol(plan) {
    const nThaw = Math.max(1, Math.ceil(plan.nSamples / 18));
    const nMedia = plan.nSamples + 1;                        // samples + ALLCELLS
    const samplesPerWorker = Math.ceil(nMedia / nThaw);
    const thawMediaTable = `<div class="recipe-box"><h5>Thawing media &mdash; R10 + DNase I (0.1&nbsp;mg/mL)</h5>
      <table><thead><tr><th>Component</th><th class="num">1&times; (per sample)</th><th class="num">&times; ${nMedia} (samples + ALLCELLS)</th></tr></thead><tbody>
      <tr><td>R10 media</td><td class="num">10&nbsp;mL</td><td class="num">${10 * nMedia}&nbsp;mL</td></tr>
      <tr><td>DNase I (10&nbsp;mg/mL stock)</td><td class="num">100&nbsp;µL (1:100)</td><td class="num">${(100 * nMedia / 1000).toFixed(1)}&nbsp;mL</td></tr>
      <tr><td><strong>Total</strong></td><td class="num">10&nbsp;mL</td><td class="num">${10 * nMedia}&nbsp;mL</td></tr>
      </tbody></table><p class="who">Aliquot 10&nbsp;mL into each pre-labeled 15&nbsp;mL tube; pre-warm at 37&nbsp;&deg;C.</p></div>`;
    const incMediaTable = `<div class="recipe-box"><h5>Incubation media &mdash; R10 + DNase I (50&nbsp;U/mL &approx; 0.025&nbsp;mg/mL), per worker</h5>
      <table><thead><tr><th>Component</th><th class="num">1&times; (per sample)</th><th class="num">Per worker (${samplesPerWorker} samples)</th></tr></thead><tbody>
      <tr><td>R10 media</td><td class="num">2&nbsp;mL</td><td class="num">${2 * samplesPerWorker}&nbsp;mL</td></tr>
      <tr><td>DNase I (10&nbsp;mg/mL stock)</td><td class="num">5&nbsp;µL</td><td class="num">${5 * samplesPerWorker}&nbsp;µL</td></tr>
      <tr><td><strong>Total</strong></td><td class="num">2&nbsp;mL</td><td class="num">${2 * samplesPerWorker}&nbsp;mL</td></tr>
      </tbody></table><p class="who">Make one tube per thawer (${nThaw} thawer${nThaw === 1 ? '' : 's'}). Add 2&nbsp;mL to each sample after the thaw spin.</p></div>`;
    return reagentHeader('ST1', plan, { foot: 'Per-sample amounts from the Pre_GEM_Consumables Thaw column, scaled to the ' + plan.nSamples + ' samples in this plan.' }) + `
      <p><strong>Materials:</strong> ${nMedia}× 15 mL pre-labeled conical tubes (samples + ALLCELLS), ${nMedia}× Thawsome adaptors, counting plates, ${plan.nPools}× FACS tubes.</p>
      ${sopTip('Be gentle — handle cells slowly and get them into warm media as fast as possible; keep them on ice after the post-thaw incubation. Watch temperature: warm media + RT centrifuge initially, then ice + 4&nbsp;&deg;C centrifuge once pooling. Note any irregularities per sample (pressurized cryovials → poor viability; small pellet → low yield; pink pellet → RBC contamination). Remove supernatant carefully on every spin — accurate counts and cell preservation matter through the whole process.')}
      ${thawMediaTable}
      <ol class="chk">
        <li>Warm complete R10 media (37 °C); set centrifuge to room temp. Thaw DNase.</li>
        <li>Prepare thawing media (R10 + DNase 0.1 mg/mL, table above): aliquot 10 mL into each pre-labeled 15 mL tube (${10 * nMedia} mL total; allow 20 min to warm before removing cells from LN₂).</li>
        <li>Centrifuge-thaw: invert cryovial into Thawsome on the 15 mL conical with media. Open frozen vials away from your face. Spin 10 min @ 350g, 25 °C.</li>
        <li>While spinning, prepare the incubation media (R10 + DNase, per-worker table below) — one tube per thawer.</li>
        <li>Pour off supernatant, add 2 mL incubation media, resuspend gently. Count 20 µL with AOPI dye.</li>
        <li>Incubate 10 min @ 37 °C, then move all tubes to ice for the rest of the experiment.</li>
        <li>Export counts → use the pooling volumes (next protocol) to determine µL/sample.</li>
      </ol>
      ${incMediaTable}
      <p class="pp-source">Source: handbook "Cell Thawing/PBMC Preparation" + MADI batch protocol.</p>`;
  }

  function poolProtocol(plan) {
    const poolList = plan.pools.map((p, i) => {
      const hto = plan.htoAssignments[i] ? plan.htoAssignments[i].hto : ('HTO-' + (i + 1));
      return `<tr><td>Pool ${i + 1}</td><td>${hto}</td><td>${p.length}</td><td class="src">${p.map((s) => esc(s.sampleId)).join(', ')}</td></tr>`;
    }).join('');
    return `
      <p>On ice, combine samples into the ${plan.nPools} genetic pools below. Each pool contains no two samples from the same patient or lineage, so SNP demux separates individuals and the pool's hashtag separates timepoints. Add the ALLCELLS control to each pool.</p>
      <table class="cost-table"><thead><tr><th>Pool</th><th>Hashtag</th><th class="num">Samples</th><th>Members</th></tr></thead><tbody>${poolList}</tbody></table>
      <p><strong>Split each pool</strong> into the arms in this experiment (${plan.arms.join(', ')}): take 1.2M cells for each unsort/ASAP arm; the remainder goes to the sort arm. Reserve 100–500k cells/sample for TriZol/stim before pooling.</p>
      <p class="pp-source">Source: handbook "Pool and split" + MADI batch protocol + flowchart.</p>`;
  }

  // ---- Reagent-quantity header for a protocol step --------------------------
  // Reads the per-stage amounts straight from Pre_GEM_Consumables and shows them
  // grouped by scope (per sample / per genetic pool / per HTO staining batch),
  // with per-unit amount and total for the current plan.
  function fmtQty(n) {
    if (n == null) return '';
    if (Number.isInteger(n)) return n.toLocaleString();
    return String(Math.round(n * 1000) / 1000);
  }
  function reagentHeader(stageId, plan, opts) {
    opts = opts || {};
    const pre = (DATA.preGem && DATA.preGem.items) || [];
    const buckets = { sample: [], gpool: [], hpool: [] };
    pre.forEach((it) => {
      const cell = it.perStage[stageId];
      if (!cell || cell.qty == null) return;
      const sec = it.section || '';
      const sk = /sample/i.test(sec) ? 'sample' : (/hto pool/i.test(sec) ? 'hpool' : 'gpool');
      buckets[sk].push({ item: it.item, qty: cell.qty, units: it.units || '' });
    });
    const cols = [
      { k: 'sample', title: 'Per sample', mult: plan.nSamples || 0 },
      { k: 'gpool', title: 'Per genetic pool', mult: plan.nPools || 0 },
      { k: 'hpool', title: 'Per HTO / staining batch', mult: 1 }
    ];
    const parts = cols.filter((c) => buckets[c.k].length).map((c) => {
      const rows = buckets[c.k].map((r) => {
        const tot = r.qty * c.mult;
        return `<tr><td>${esc(r.item)}</td><td class="n">${esc(fmtQty(r.qty))} ${esc(r.units)}</td><td class="n rgt-tot">${esc(fmtQty(tot))} ${esc(r.units)}</td></tr>`;
      }).join('');
      return `<div class="rgt-col"><h5>${esc(c.title)} <span class="muted">(&times;${c.mult})</span></h5>
        <table><tr><td></td><td class="n">each</td><td class="n">total</td></tr>${rows}</table></div>`;
    }).join('');
    if (!parts) return '';
    return `<div class="rgt-head"><h4>Reagents &amp; supplies for this step</h4><div class="rgt-grid">${parts}</div>
      ${opts.foot ? '<p class="muted" style="margin:9px 0 0;font-size:11.5px">' + opts.foot + '</p>' : ''}</div>`;
  }

  // ---- Pre-experiment prep (media + buffers) --------------------------------
  function prepProtocol(plan) {
    const nMedia = plan.nSamples + 1;              // samples + ALLCELLS control
    const r10TotalMl = nMedia * 15;                // 15 mL/sample made (12 used: 10 thaw + 2 incubation; +3 margin)
    const nBottles = Math.max(1, Math.ceil(r10TotalMl / 500));
    // Plan-scaled buffer volumes (match the Reagents & cost engine: staining
    // buffer = 14 mL/pool + 9 mL/super-pool per staining arm; sort adds a 2 mL/pool
    // wash). BSA is 2% w/v = 0.02 g/mL.
    const nSuper = (plan.superPools && plan.superPools.length) || 1;
    const hasUnsort = plan.arms.includes('unsort5');
    const hasAsap = plan.arms.includes('asap3');
    const hasSort = plan.arms.includes('sort5');
    let stainML = 0; const stainParts = [];
    if (hasUnsort) { stainML += 19 * plan.nPools + 9 * nSuper; stainParts.push('unsort ' + (19 * plan.nPools) + ' mL (19 \u00d7 ' + plan.nPools + ' pools) + ' + (9 * nSuper) + ' mL super-pool'); }
    if (hasAsap) { stainML += 19 * plan.nPools + 9 * nSuper; stainParts.push('ASAP ' + (19 * plan.nPools) + ' mL + ' + (9 * nSuper) + ' mL super-pool'); }
    if (hasSort) { stainML += 2 * plan.nPools; stainParts.push('sort wash ' + (2 * plan.nPools) + ' mL (2 \u00d7 ' + plan.nPools + ' pools)'); }
    const stainPrep = stainML ? Math.ceil(stainML * 1.1 / 5) * 5 : 0;   // +10% margin, round up to 5 mL
    const stainBSA = Math.round(stainPrep * 0.02 * 100) / 100;    // 2% w/v of the prep volume
    const stainBox = stainML
      ? `<div class="recipe-box"><h5>CITE-seq staining / wash buffer (1&times; PBS + 2% BSA) &mdash; prepare ~${stainPrep}&nbsp;mL</h5>
        <table><tr><th>Component</th><th>Amount</th></tr>
        <tr><td>BSA (from powder)</td><td class="num">${stainBSA}&nbsp;g (2% w/v)</td></tr>
        <tr><td>1&times; PBS</td><td class="num">to ${stainPrep}&nbsp;mL, then 0.22&nbsp;µm filter</td></tr></table>
        <p class="who">${stainML}&nbsp;mL needed for this plan (${stainParts.join('; ')}); prep with +10% margin, rounded up to ${stainPrep}&nbsp;mL.</p></div>`
      : `<div class="recipe-box"><h5>CITE-seq staining / wash buffer (1&times; PBS + 2% BSA)</h5>
        <table><tr><th>Component</th><th>Amount</th></tr>
        <tr><td>BSA (from powder)</td><td class="num">10&nbsp;g / 500&nbsp;mL PBS (2% w/v)</td></tr>
        <tr><td>1&times; PBS</td><td class="num">to 500&nbsp;mL, then 0.22&nbsp;µm filter</td></tr></table></div>`;

    // FACS sort buffer (1x PBS + 10% FBS, ~70 mL/pool) — only when sorting.
    const facsBox = hasSort ? (function () {
      const ml = 70 * plan.nPools, prep = Math.ceil(ml * 1.1 / 10) * 10, fbs = Math.round(prep * 0.10), pbs = prep - fbs;
      return `<div class="recipe-box"><h5>FACS sort buffer (1&times; PBS + 10% FBS) &mdash; prepare ~${prep}&nbsp;mL</h5>
        <table><tr><th>Component</th><th>Amount</th></tr>
        <tr><td>1&times; PBS</td><td class="num">${pbs}&nbsp;mL</td></tr>
        <tr><td>FBS</td><td class="num">${fbs}&nbsp;mL (10%)</td></tr></table>
        <p class="who">${ml}&nbsp;mL needed (70&nbsp;mL/pool &times; ${plan.nPools} pools); prep with +10% margin, rounded up to ${prep}&nbsp;mL.</p></div>`;
    })() : '';

    // DNase: always dissolve the full 100 mg vial; note how much this plan uses
    // so the remainder can be frozen. ~1.4 mg/sample (thaw + incubation media).
    const dnaseMg = Math.round(1.05 * nMedia);   // thaw (1.0) + incubation (0.05) mg/sample, incl. ALLCELLS
    const dnaseLeft = Math.max(0, 100 - dnaseMg);
    const dnaseBox = `<div class="recipe-box"><h5>DNase I (from 100&nbsp;mg vial)</h5>
        <table><tr><th>Use</th><th>Prep</th></tr>
        <tr><td>Thaw media (0.1&nbsp;mg/mL)</td><td>10&nbsp;mg/mL stock into warm R10</td></tr>
        <tr><td>Incubation media (0.025&nbsp;mg/mL)</td><td>125&nbsp;µL 10&nbsp;mg/mL stock per 50&nbsp;mL R10</td></tr></table>
        <p class="who">Dissolve the whole 100&nbsp;mg vial (no weighing). This experiment (${nMedia} samples incl. ALLCELLS) uses ~${dnaseMg}&nbsp;mg &mdash; aliquot and freeze the remaining ~${dnaseLeft}&nbsp;mg of 10&nbsp;mg/mL stock at &minus;20&nbsp;&deg;C for later batches.</p></div>`;

    // OMNI lysis + wash are prepared once on the bulk ASAP superpool (resuspend the
    // pellet in 100 µL lysis, add 1 mL wash), BEFORE the nuclei are counted and split
    // across GEM lanes at loading. So these buffers scale by the number of ASAP
    // super-pools, NOT by the ASAP GEM-lane count.
    const nAsapSuper = hasAsap ? nSuper : 0;
    const asapNote = hasAsap ? `<p class="who">Prepare OMNI lysis + wash for ${nAsapSuper} ASAP super-pool${nAsapSuper === 1 ? '' : 's'} (100&nbsp;µL lysis + 1&nbsp;mL wash each, done on the bulk super-pool before splitting across GEM lanes at loading): need ~${nAsapSuper * 100}&nbsp;µL lysis and ~${nAsapSuper}&nbsp;mL wash. The 2&nbsp;mL recipes below make one full batch of each (enough for a super-pool with margin).</p>` : '';
    return `
      <p>Prepare media, buffers and stocks 1&ndash;3 days ahead. Filter-sterilize buffers and store at 4&nbsp;&deg;C. Make DNase stock fresh from powder and store aliquots at &minus;20&nbsp;&deg;C.</p>
      <div class="recipe-box"><h5>R10 media (thaw + wash) &mdash; make ${nBottles} &times; 500&nbsp;mL bottle${nBottles === 1 ? '' : 's'} (${r10TotalMl}&nbsp;mL for ${nMedia} samples incl. ALLCELLS @ 15&nbsp;mL each)</h5>
        <table><tr><th>Component</th><th>Per 500&nbsp;mL bottle</th></tr>
        <tr><td>RPMI 1640 (phenol-free if stim on pregnancy samples)</td><td class="num">440&nbsp;mL</td></tr>
        <tr><td>FBS</td><td class="num">50&nbsp;mL</td></tr>
        <tr><td>1&nbsp;M HEPES</td><td class="num">5&nbsp;mL</td></tr>
        <tr><td>100&times; pen-strep</td><td class="num">5&nbsp;mL</td></tr></table></div>
      ${stainBox}
      ${facsBox}
      ${dnaseBox}
      <p><strong>ASAP-seq buffers</strong> (make fresh, keep on ice; incubate digitonin at 65&nbsp;&deg;C 10&nbsp;min before use):</p>
      ${asapNote}
      <div class="recipe-box"><h5>OMNI lysis buffer &mdash; per 2&nbsp;mL (use 100&nbsp;µL/rxn)</h5>
        <table><tr><th>Component (stock)</th><th>Final</th><th>Volume</th></tr>
        <tr><td>1&nbsp;M Tris-HCl pH 7.5</td><td>10&nbsp;mM</td><td class="num">20&nbsp;µL</td></tr>
        <tr><td>5&nbsp;M NaCl</td><td>10&nbsp;mM</td><td class="num">4&nbsp;µL</td></tr>
        <tr><td>1&nbsp;M MgCl₂</td><td>3&nbsp;mM</td><td class="num">6&nbsp;µL</td></tr>
        <tr><td>10% NP-40 (IGEPAL)</td><td>0.1%</td><td class="num">20&nbsp;µL</td></tr>
        <tr><td>5% digitonin</td><td>0.01%</td><td class="num">4&nbsp;µL</td></tr>
        <tr><td>10% Tween-20</td><td>0.1%</td><td class="num">20&nbsp;µL</td></tr>
        <tr><td>10% BSA</td><td>1%</td><td class="num">200&nbsp;µL</td></tr>
        <tr><td>Nuclease-free H₂O</td><td>&mdash;</td><td class="num">1726&nbsp;µL</td></tr></table></div>
      <div class="recipe-box"><h5>Wash buffer &mdash; per 2&nbsp;mL (use 1&nbsp;mL/rxn)</h5>
        <table><tr><th>Component</th><th>Final</th><th>Volume</th></tr>
        <tr><td>1&nbsp;M Tris-HCl pH 7.5</td><td>10&nbsp;mM</td><td class="num">20&nbsp;µL</td></tr>
        <tr><td>5&nbsp;M NaCl</td><td>10&nbsp;mM</td><td class="num">4&nbsp;µL</td></tr>
        <tr><td>1&nbsp;M MgCl₂</td><td>3&nbsp;mM</td><td class="num">6&nbsp;µL</td></tr>
        <tr><td>10% BSA</td><td>1%</td><td class="num">200&nbsp;µL</td></tr>
        <tr><td>Nuclease-free H₂O</td><td>&mdash;</td><td class="num">1770&nbsp;µL</td></tr></table></div>
      <ul>
        <li>Locate Fc block, HTO hashtag Abs (TotalSeq-C for CITE/sort, TotalSeq-A for ASAP), the 5&prime; lyo panels (TotalSeq-C 399905 &amp; TotalSeq-A 399907 &mdash; 3 vials of each per batch), and the sort antibody panel.</li>
        <li>Reserve labware: Thawsome adaptors, FACS tubes + filters, Flowmi strainers, 15/50&nbsp;mL conicals, RNA-free 1.5&nbsp;mL tubes for TriZol, pipette tips.</li>
        <li>Book the sorter with the Flow Core and confirm 10x kits + thermal-cycler programs are ready.</li>
      </ul>
      <p class="pp-source">Source: MADI02 batch1 protocol + CITE-seq batch2 protocol (buffer recipes, ASAP CHI protocol).</p>`;
  }

  // ---- CITE-seq (unsort 5') staining ----------------------------------------
  function citeStainProtocol(plan) {
    return reagentHeader('ST3', plan, { foot: 'Amounts are drawn straight from the Pre_GEM_Consumables sheet\u2019s CITE-seq column. Each genetic pool gets its own TotalSeq-C hashtag (2&nbsp;µL); the 3-vial lyo panel is used once for the combined batch.' }) + `
      ${sopTip('Completely remove DNase-containing media before staining — residual DNase degrades the DNA-conjugated antibodies. But avoid too many washes, which hurt viability and lose cells. Stain at 4&nbsp;&deg;C on ice; keep cells and reagents cold unless noted.')}
      <p>Staining the six per-pool unsort tubes (unsort5p1&hellip;${plan.nPools}), then combining and staining the surface-protein panel. Keep everything cold; minimise washes to protect viability.</p>
      <ol class="chk">
        <li><strong>Wash off media.</strong> Add 2&nbsp;mL CITE staining buffer (1&times; PBS + 2% BSA) to each unsort tube, spin 400g 5&nbsp;min 4&nbsp;&deg;C, pour off leaving ~40&nbsp;µL. Repeat once. (Media DNase degrades the DNA-conjugated antibodies, so it must be removed.)</li>
        <li><strong>HTO hashtag stain.</strong> To each unsort5p tube add <strong>10&nbsp;µL Fc block</strong> + <strong>2&nbsp;µL of a unique TotalSeq-C HTO</strong> (pool 1 &rarr; HTO-1, pool 2 &rarr; HTO-2, &hellip;). Keep total volume &lt;100&nbsp;µL. Spin briefly to collect.</li>
        <li>Incubate 30&nbsp;min on ice, covered. <em>Meanwhile reconstitute the TotalSeq-C lyo panel (see box below).</em></li>
        <li><strong>Wash 3&times;</strong> with CITE staining buffer, then resuspend each tube in 3&nbsp;mL. Count all ${plan.nPools} tubes.</li>
        <li><strong>Combine</strong> all ${plan.nPools} unsort tubes into one tube labelled &ldquo;unsort5p,&rdquo; pooling by the lowest-count tube. Transfer <strong>1.5M cells</strong> to a new tube (&ldquo;unsort5p-stain&rdquo;).</li>
        <li>Spin, leave ~25&ndash;30&nbsp;µL, then add buffer to <strong>exactly 75&nbsp;µL</strong> (equal volume to the 75&nbsp;µL panel added next).</li>
        <li><strong>Surface panel.</strong> Add 25&nbsp;µL &times; 3 = <strong>75&nbsp;µL TotalSeq-C lyo panel</strong> (150&nbsp;µL total). Stain 30&nbsp;min on ice.</li>
        <li>Wash 3&times; (staining buffer &times;2, then PBS &times;1). Resuspend in ~700&ndash;800&nbsp;µL 1&times; PBS, filter through a Flowmi strainer.</li>
        <li>Final count &rarr; superload the 10x chip (see the GEM loading protocol; ~1.1&ndash;1.2M cells at load).</li>
      </ol>
      ${lyoBox('TotalSeq-C', 'CITE-seq (399905)')}
      ${recordCounts('unsort pool cell counts', 'Unsort', plan.nPools)}
      <p class="pp-source">Source: CITE-seq batch2 protocol &ldquo;Unsort 5&prime; panel staining&rdquo; + MADI02 batch1.</p>`;
  }

  function sopTip(html) {
    return '<div class="sop-tip"><strong>\u2757 Important tips:</strong> ' + html + '</div>';
  }

  // Blank recording tables (worksheet mode) — filled in at the bench.
  function recordCounts(label, prefix, n) {
    const cols = Array.from({ length: n }, (_, i) => '<th>' + prefix + (i + 1) + '</th>').join('');
    const blanks = (last) => Array.from({ length: n }, () => '<td>&nbsp;</td>').join('') + (last || '<td>&nbsp;</td>');
    return `<div class="recipe-box"><h5>Record: ${esc(label)}</h5>
      <table><thead><tr><th></th>${cols}<th>SUPERPOOL</th></tr></thead><tbody>
      <tr><td>Cell conc (cells/mL)</td>${blanks()}</tr>
      <tr><td>Vol (mL)</td>${blanks()}</tr>
      <tr><td>Total cells</td>${blanks()}</tr>
      <tr><td>Vol pooled</td>${blanks('<td>Vol for 1.5M =</td>')}</tr>
      </tbody></table></div>`;
  }
  function recordSortYield() {
    const row = (p) => '<tr><td>' + p + '</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>';
    return `<div class="recipe-box"><h5>Record: sort yield</h5>
      <table><thead><tr><th>Population</th><th>Sort yield</th><th>Viability</th><th>Viable count (cells/mL)</th><th>Total volume</th><th>Cell #</th><th>Vol for loading</th></tr></thead>
      <tbody>${['HSC', 'pDC', 'cDC', 'Treg'].map(row).join('')}</tbody></table></div>`;
  }
  function recordChipLoad(plan) {
    const rows = [];
    if (plan.arms.includes('unsort5')) rows.push("Unsort 5' CITEseq superpool");
    if (plan.arms.includes('sort5')) ['Sort HSC+pDC', 'Sort cDC', 'Sort Treg'].forEach((r) => rows.push(r));
    if (plan.arms.includes('asap3')) rows.push('ASAP superpool');
    if (plan.modalities.includes('In vitro stimulation')) rows.push('Stim superpool');
    const tr = (r) => '<tr><td>' + r + '</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>';
    return `<div class="recipe-box"><h5>Record: final counts &amp; chip-loading plan</h5>
      <table><thead><tr><th>Modality</th><th># lanes</th><th>Cells·nuclei / lane</th><th>Conc. (cells/mL)</th><th>Vol / lane</th><th>Total vol</th></tr></thead>
      <tbody>${rows.map(tr).join('')}</tbody></table></div>`;
  }

  function lyoBox(type, label) {
    return `<div class="recipe-box"><h5>Lyo panel reconstitution &mdash; ${esc(type)} (${esc(label)}), 3 vials &rarr; stain 1.5M cells</h5>
      <ol style="margin:0;padding-left:18px">
        <li>Bring 3 lyo vials to room temp ≥5&nbsp;min; spin 10,000&times;g 30&nbsp;s.</li>
        <li>Resuspend each vial in 27.5&nbsp;µL staining buffer, cap, vortex 10&nbsp;s; incubate RT 5&nbsp;min; vortex + spin 10,000&times;g 30&nbsp;s.</li>
        <li>Combine all 3 into one low-bind tube; spin 14,000&times;g 10&nbsp;min 4&nbsp;&deg;C.</li>
        <li>Take 25&nbsp;µL &times; 3 = 75&nbsp;µL as the panel (added to 75&nbsp;µL cells = 150&nbsp;µL stain).</li>
      </ol></div>`;
  }

  // ---- ASAP-seq -------------------------------------------------------------
  function asapProtocol(plan) {
    return reagentHeader('ST4', plan, { foot: 'Amounts come from the Pre_GEM_Consumables ASAP-seq column. HTO stain (2&nbsp;µL TotalSeq-A per pool) and the 3-vial TotalSeq-A lyo panel mirror CITE-seq; the fixation/lysis buffer components are per staining batch.' }) + `
      ${sopTip('Same as unsort: fully remove DNase media (interferes with the DNA antibodies) while minimizing washes. Keep cold during staining. Warm digitonin to 65&nbsp;&deg;C before making lysis buffer; make OMNI lysis/wash buffers fresh and keep on ice.')}
      <p>ASAP-seq hashes and surface-stains like CITE-seq, then fixes, lightly lyses to nuclei, and transposes. Based on the CHI ASAP-seq protocol.</p>
      <ol class="chk">
        <li><strong>HTO hashtag stain.</strong> To each asap3p tube add <strong>10&nbsp;µL Fc block</strong> + <strong>2&nbsp;µL of a unique TotalSeq-A HTO</strong> (use TotalSeq-<em>A</em>, not C). Incubate 30&nbsp;min on ice with the unsort tubes.</li>
        <li>Wash 3&times; with staining buffer; resuspend in 3&nbsp;mL; count. <strong>Combine</strong> the ${plan.nPools} tubes into &ldquo;asap3p&rdquo; and move <strong>1.5&ndash;2M cells</strong> to &ldquo;asap3p-stain.&rdquo;</li>
        <li>Spin, bring to 75&nbsp;µL, add <strong>75&nbsp;µL TotalSeq-A lyo panel</strong> (150&nbsp;µL total), stain 30&nbsp;min on ice. Wash 3&times;; resuspend in <strong>450&nbsp;µL</strong> 1&times; PBS in a 2&nbsp;mL tube.</li>
        <li><strong>Fixation.</strong> Add <strong>30&nbsp;µL 16% formaldehyde</strong> (1% final), 10&nbsp;min RT, swirling occasionally. <em>Meanwhile: warm digitonin at 65&nbsp;&deg;C, thaw ATAC kit reagents, make OMNI lysis + wash + 1&times; nuclei buffer (see prep).</em></li>
        <li><strong>Quench</strong> with <strong>32&nbsp;µL 2&nbsp;M glycine</strong> (0.125&nbsp;M final). Wash 2&times; with 1&nbsp;mL ice-cold PBS (spin 400g 5&nbsp;min 4&nbsp;&deg;C).</li>
        <li><strong>Lyse to nuclei.</strong> Resuspend in <strong>100&nbsp;µL chilled OMNI lysis buffer</strong>, mix, incubate on ice 3&nbsp;min (primary cells). Add 1&nbsp;mL chilled wash buffer, spin 500g 5&nbsp;min 4&nbsp;&deg;C.</li>
        <li>Resuspend in <strong>100&nbsp;µL 1&times; Nuclei Buffer</strong> (10x). Filter (40&nbsp;µm Flowmi), count, adjust to 10x ATAC loading density.</li>
        <li><strong>Transposition &amp; GEM (10x ATAC).</strong> During barcoding, spike in <strong>0.5&nbsp;µL/rxn 1&nbsp;µM bridge oligo (BOA)</strong>; add a 40&nbsp;&deg;C 5&nbsp;min anneal step before the standard GEM program (helps tag capture). Store GEMs at 15&nbsp;&deg;C ≤18&nbsp;h or &minus;20&nbsp;&deg;C ≤1&nbsp;week.</li>
        <li><strong>Tag library PCR</strong> (one HTO, one ADT): 50&nbsp;µL 2&times; KAPA HiFi + 2.5&nbsp;µL 3&prime;-ASAP-P5 + 2.5&nbsp;µL RPxx/D7xx index + input, water to 100&nbsp;µL; 14&ndash;16 cycles; 1.6&times; AMPure XP, elute 30&nbsp;µL (~190&nbsp;bp product).</li>
      </ol>
      ${recordCounts('ASAP pool cell counts', 'ASAP', plan.nPools)}
      <p class="pp-source">Source: CHI ASAP-seq protocol (2022 + Yona&rsquo;s notes) via CITE-seq batch2; MADI02 batch1.</p>`;
  }

  // ---- Sort staining --------------------------------------------------------
  function sortStainProtocol(plan) {
    return reagentHeader('ST5', plan, { foot: 'From the Pre_GEM_Consumables Sort column. Each sort pool gets the fluorophore antibody cocktail (≈61.5&nbsp;µL) + 5&nbsp;µL of its TotalSeq-C HTO to a 200&nbsp;µL stain.' }) + `
      ${sopTip('Remove DNase media completely but avoid over-washing (viability/loss). Once Live/Dead dye is added, turn the hood lights off and keep tubes covered for the rest of staining — the fluorochromes are light-sensitive.')}
      <p>Live/dead + surface-marker staining of the six sort pools (sort5p1&hellip;${plan.nPools}) for FACS into HSC, pDC, cDC and Treg. Work on ice with the hood lights off once L/D dye is added.</p>
      <ol class="chk">
        <li><strong>Pre-wash.</strong> Top up each remaining pool tube with 1&times; PBS (to ~40&nbsp;mL), spin 400g 5&nbsp;min 4&nbsp;&deg;C, pour off, wash once more with PBS. (Removes proteins that interfere with the L/D stain.)</li>
        <li><strong>Live/Dead.</strong> Resuspend each tube in <strong>2&nbsp;mL Zombie Red 1:1000</strong> in PBS (0.5&nbsp;µL dye/tube-equivalent; dilute 1.5&nbsp;µL stock into 1500&nbsp;µL PBS for the batch). Incubate 20&nbsp;min on ice, dark.</li>
        <li>Add 2&nbsp;mL FACS buffer, spin, then resuspend in ~123.5&nbsp;µL FACS buffer. Add <strong>10&nbsp;µL Fc block</strong>, mix, incubate 5&nbsp;min on ice.</li>
        <li><strong>Surface stain.</strong> To each pool add <strong>61.5&nbsp;µL sort Ab cocktail</strong> + <strong>5&nbsp;µL of the pool&rsquo;s TotalSeq-C HTO</strong> &rarr; 200&nbsp;µL total. Incubate 20&nbsp;min on ice, dark.</li>
        <li>Wash: add 2&nbsp;mL FACS buffer, spin (400g 5&nbsp;min 4&nbsp;&deg;C); second wash with <strong>15&nbsp;mL</strong> FACS buffer, spin again (the SOP uses a larger second wash). Resuspend to ~10M cells/mL (~1&nbsp;mL); count.</li>
        <li>Pool the ${plan.nPools} hashtagged sort pools into ~2 FACS tubes; filter through the cap filter. Prepare an unstained control (ALLCELLS leukopak in 500&nbsp;µL FACS buffer, filtered).</li>
        <li><strong>Sort</strong> (70&nbsp;µm nozzle, into 50% FBS) into HSC, pDC, cDC, Treg collection tubes.</li>
        <li><strong>Post-sort:</strong> spin (save supernatant), resuspend; combine pDC+HSC into one lane; Treg and cDC can take their own lanes. Concentrate to ~77.4&nbsp;µL/lane and proceed to loading.</li>
      </ol>
      <div class="recipe-box"><h5>5&prime; sort antibody panel (per pool; &times;${plan.nPools} + controls)</h5>
        ${(function () { const rowsP = (SORT_PANEL || []).filter((r) => (r.channel || r.marker || r.ul !== '')); return rowsP.length ? (function () {
          const over = plan.nPools + 1; let tot = 0;
          const body = rowsP.map((r) => { const per = (r.ul === '' ? null : Number(r.ul) || 0); if (per != null) tot += per; return '<tr><td>' + esc(r.channel) + '</td><td>' + esc(r.marker) + '</td><td class="num">' + (per == null ? '&mdash;' : per) + '</td><td class="num">' + (per == null ? '&mdash;' : Math.round(per * over * 100) / 100) + '</td></tr>'; }).join('');
          return '<table><tr><th>Channel</th><th>Marker</th><th>µL / pool</th><th>Total for ' + plan.nPools + ' pools (+1 overage)</th></tr>' + body
            + '<tr><td colspan="2"><strong>Total antibody / pool</strong></td><td class="num"><strong>' + (Math.round(tot * 100) / 100) + '</strong></td><td class="num"><strong>' + (Math.round(tot * over * 100) / 100) + '</strong></td></tr></table>';
        })() : (
        '<table><tr><th>Channel</th><th>Marker</th><th>µL / pool</th></tr>'
        + '<tr><td>staining buffer</td><td>&mdash;</td><td class="num">10</td></tr>'
        + '<tr><td>BV785</td><td>CD19</td><td class="num">5</td></tr><tr><td>BV711</td><td>CD56</td><td class="num">5</td></tr>'
        + '<tr><td>BV650</td><td>CD127</td><td class="num">5</td></tr><tr><td>BV605</td><td>CD4</td><td class="num">4</td></tr>'
        + '<tr><td>BV510</td><td>CD123</td><td class="num">5</td></tr><tr><td>AF488</td><td>CD3</td><td class="num">4</td></tr>'
        + '<tr><td>PE-Cy5</td><td>CD25</td><td class="num">5</td></tr><tr><td>PE</td><td>CD11c</td><td class="num">3.5</td></tr>'
        + '<tr><td>APC-Cy7</td><td>CD14</td><td class="num">5</td></tr><tr><td>AF700</td><td>CD45</td><td class="num">5</td></tr>'
        + '<tr><td>AF647</td><td>CD34</td><td class="num">5</td></tr>'
        + '<tr><td>PE-TexasRed</td><td>L/D (Zombie Red, 1:1000)</td><td class="num">&mdash;</td></tr>'
        + '<tr><td colspan="2"><strong>Total antibody / pool</strong></td><td class="num"><strong>61.5</strong></td></tr></table>'
        + '<p class="pp-source" style="margin-top:4px">Tip: paste your actual panel on Plan &rarr; Sort populations to auto-fill this table with a total-for-pools column.</p>'); })()}</div>
      ${recordCounts('sort pool cell counts', 'Sort', plan.nPools)}
      ${recordSortYield()}
      <p class="pp-source">Source: MADI02 batch1 &amp; CITE-seq batch2 sort panels.</p>`;
  }

  // ---- Bulk RNA / TriZol ----------------------------------------------------
  function bulkProtocol(plan) {
    return reagentHeader('ST14', plan, { foot: 'Per-sample TriZol reserve set aside before pooling (100&ndash;500K cells/sample), needed for SNP demultiplexing of the pooled donors.' }) + `
      ${sopTip('Keep samples on ice. TriZol is hazardous — handle only in the fume hood, double-glove, keep TriZol waste (liquid + tips) separate and labeled, and cap tubes as soon as possible. Shock the cells: transfer to &minus;80&nbsp;&deg;C as soon as possible after the brief TriZol incubation (a dry-ice box next to the hood helps).')}
      <p>Reserve 100&ndash;500K cells per sample (before pooling) for bulk RNA-seq. Work under RNA-free conditions; RNA-Away gloves; TriZol in the hood only, kept cold and dark.</p>
      <ol class="chk">
        <li>Keep reserved cell aliquots on ice (up to 1&nbsp;mL / up to ~1M cells) in RNA-free 1.5&nbsp;mL tubes.</li>
        <li>Spin 4&nbsp;&deg;C, 400&times;g, 5&nbsp;min; gently remove supernatant (leave a thin layer to avoid disturbing the pellet).</li>
        <li>Add <strong>600&nbsp;µL TriZol</strong> per sample, resuspend thoroughly. Vortex 10&nbsp;s, hold RT 5&nbsp;min.</li>
        <li>Transfer to &minus;80&nbsp;&deg;C (no need to halt the reaction). Process to RNA later.</li>
      </ol>
      <p class="pp-source">Source: CITE-seq batch2 &ldquo;TriZol RNA isolation&rdquo; + MADI02 batch1 (bulk reserve).</p>`;
  }

  // ---- In-vitro stimulation -------------------------------------------------
  function stimProtocol(plan) {
    return reagentHeader('ST13', plan, { foot: 'Per-sample stim reserve set aside at thaw; plate setup and treatments (LPS / IFN-β / IL-15) per the separate stim protocol.' }) + `
      <p>Stim uses cells reserved per sample at thaw. Confirm the plate map and treatment doses with the stim lead before plating; exact volumes depend on cell counts.</p>
      <ol class="chk">
        <li>Set the mini-centrifuge to 4&nbsp;&deg;C. Label one 1.5&nbsp;mL tube per sample.</li>
        <li>Transfer the reserved cells (target ~3.2M cells/sample per the batch sheet) into each tube; top up with RPMI to wash; spin 400g 4&nbsp;&deg;C 5&ndash;10&nbsp;min.</li>
        <li>Remove supernatant, resuspend in <strong>880&nbsp;µL RPMI</strong>.</li>
        <li>Plate <strong>100&nbsp;µL/well</strong> per the plate map (U-bottom); reserve the remainder as directed. Incubate 37&nbsp;&deg;C until treatments (LPS, IFN-β, IL-15) are added.</li>
      </ol>
      <p class="pp-source">Source: MADI02 batch1 &amp; CITE-seq batch2 (stim plating); full stim protocol is separate.</p>`;
  }

  // ---- 10x GEM loading ------------------------------------------------------
  function gemLoadProtocol(plan) {
    return `
      <p>Super-load the 10x Chromium chip once cells are counted and filtered. Follow the relevant 10x user guide for GEM generation &amp; barcoding.</p>
      <ol class="chk">
        <li>At least 30&nbsp;min before loading, thaw the master-mix reagents to RT; take the RT enzyme out only right before use. (GEM-X 5&prime; v3: thaw RT primer &mdash; stored at &minus;80&nbsp;&deg;C with the beads &mdash; RT reagent mix, and additive A.)</li>
        <li><strong>Load target:</strong> GEM-X 5&prime; v3 &mdash; 85,000 cells/lane; dilute to 85,000&nbsp;/&nbsp;77.4&nbsp;µL &asymp; 1.1&times;10⁶ cells/mL in 1&times; PBS; load 77.4&nbsp;µL/lane. (~650&nbsp;µL covers 8 lanes.)</li>
        <li>Filter through a Flowmi strainer immediately before loading.</li>
        <li>For sorted fractions, combine low-yield populations onto shared lanes (e.g. pDC+HSC on one lane; Treg and cDC on their own).</li>
        <li>After GEM generation, proceed to the RT step and library construction in the 10x protocol (GEX / V(D)J / ADT; ATAC path for ASAP).</li>
      </ol>
      ${recordChipLoad(plan)}
      <p class="pp-source">Source: 10x Chromium GEM-X Single Cell 5&prime; v3 user guide (CG000733) + MADI02 batch1 loading notes.</p>`;
  }

  function placeholderProtocol(st) {
    return `<div class="placeholder-card">
      <p><strong>Detailed steps not yet in the tool.</strong> ${st ? 'This module (' + esc(st.name) + ') references ' + esc(st.sourceDoc || 'an external protocol') + '.' : ''}
      Add the step-by-step here by expanding the handbook / linking the source protocol document.</p>
      ${st && st.notes ? '<p class="muted">Note from schema: ' + esc(st.notes) + '</p>' : ''}
    </div>`;
  }

  // ==========================================================================
  //  Experiments, projects & inventory
  // ==========================================================================
  let CURRENT_EXP_ID = null;
  let CURRENT_PROJECT = null;
  let SELECTED_PROJECT = '__all__';
  let EXPANDED_PROJECTS = {};
  let EXPANDED_EXPERIMENTS = {};
  let CREATE_EXP_FOR = null;

  function renderAllTabs(res) {
    LASTPLAN = res;
    renderWorkflow(res.plan);
    renderReagents(res.plan, res.cost);
    renderProtocols(res.plan);
    if (window.Scheduling) Scheduling.render($('#schedulingContent'));
  }

  // ---- capture / restore the full builder state -----------------------------
  function serializeState() {
    const optValues = {};
    $$('#optsGrid input[id^="opt_"]').forEach((el) => { optValues[el.id] = el.value; });
    let poolOverride = null;
    if (POOL_OVERRIDE) {
      poolOverride = { hasFullHTO: POOL_OVERRIDE.hasFullHTO, bySampleId: Array.from(POOL_OVERRIDE.bySampleId.entries()) };
    }
    return {
      sel: JSON.parse(JSON.stringify(SEL)),
      gridRows: GRID_ROWS.map((r) => r.slice()),
      customCols: CUSTOM_COLS.slice(),
      confounderIdx: Array.from(CONFOUNDER_CHECKED_IDX),
      poolOverride, optValues,
      sortSel: sortSelList(), customSortPops: CUSTOM_SORT_POPS.slice(), sortPanel: SORT_PANEL.slice(), sampleNoOverride: Object.assign({}, SAMPLE_NO_OVERRIDE),
      inputMode: PLAN_INPUT,
      planningCounts: (function () { const v = {}; document.querySelectorAll('#planningCounts input').forEach((el) => { v[el.id] = el.value; }); return v; })()
    };
  }

  function restoreState(state) {
    if (!state) return;
    SEL = state.sel ? JSON.parse(JSON.stringify(state.sel)) : freshSelection();
    GRID_ROWS = (state.gridRows || []).map((r) => r.slice());
    CUSTOM_COLS = (state.customCols || []).slice();
    CONFOUNDER_CHECKED_IDX = new Set(state.confounderIdx || []);
    POOL_OVERRIDE = (state.poolOverride && state.poolOverride.bySampleId)
      ? { hasFullHTO: state.poolOverride.hasFullHTO, bySampleId: new Map(state.poolOverride.bySampleId) } : null;
    if (state.optValues) Object.keys(state.optValues).forEach((id) => { const el = document.getElementById(id); if (el) el.value = state.optValues[id]; });
    if (state.planningCounts) Object.keys(state.planningCounts).forEach((id) => { const el = document.getElementById(id); if (el) el.value = state.planningCounts[id]; });
    CUSTOM_SORT_POPS = (state.customSortPops || []).slice();
    SORT_PANEL = (state.sortPanel || []).slice();
    SAMPLE_NO_OVERRIDE = Object.assign({}, state.sampleNoOverride || {});
    if (state.sortSel && window.Pooling) { SORT_SEL = new Set(state.sortSel); renderSortToggles(); }
    const box = $('#useMadiDefault'); if (box) box.checked = false;
    renderPopulationBuilder();
    onSelectionChange();
    renderGrid();
    resetPoolingPreview();
    setInputMode(state.inputMode || 'grid');
    updateNav();
  }

  // ---- pooling / snapshot builders (shared with exports) --------------------
  function poolingAOA(plan, customCols) {
    const htoByPool = {}; (plan.htoAssignments || []).forEach((a) => { htoByPool[a.pool] = a.hto; });
    const superByPool = {}; (plan.superPools || []).forEach((grp, spi) => grp.forEach((p) => { superByPool[p] = spi; }));
    const header = ['Sample ID', 'Patient ID', 'Lineage'].concat(customCols, ['Cells available', 'Genetic Pool', 'HTO', 'Loading Super-Pool']);
    const rows = [header];
    (plan.pools || []).forEach((pool, i) => pool.forEach((s) => {
      rows.push(['' + s.sampleId, '' + s.patientId, s.lineage || ''].concat(
        customCols.map((c) => (s.confounders && s.confounders[c]) || ''),
        [s.cellsAvailable != null ? s.cellsAvailable : '', i + 1, htoByPool[i] || '', superByPool[i] != null ? (superByPool[i] + 1) : '']
      ));
    }));
    return { header, rows };
  }

  function buildSnapshot(res) {
    const plan = res.plan, cost = res.cost;
    const scen = readScenarioAssumptions();
    const customCols = CUSTOM_COLS.slice();
    const htoByPool = {}; (plan.htoAssignments || []).forEach((a) => { htoByPool[a.pool] = a.hto; });
    const superByPool = {}; (plan.superPools || []).forEach((grp, spi) => grp.forEach((p) => { superByPool[p] = spi; }));
    const batches = (plan.pools || []).map((pool, i) => ({
      pool: i + 1, hto: htoByPool[i] || '', superPool: superByPool[i] != null ? (superByPool[i] + 1) : '',
      samples: pool.map((s) => ({ sampleId: '' + s.sampleId, patientId: '' + s.patientId, lineage: s.lineage || '', confounders: s.confounders || {} }))
    }));
    const reagents = (cost.reagents || []).map((r) => ({
      category: r.category, reagent: r.reagent, itemId: r.itemId || '', units: r.units || '',
      totalAmount: r.totalAmount, quantity: r.quantity, quantityUnit: r.quantityUnit || '', total: r.total, scope: r.scope || '', note: r.note || ''
    }));
    const lineItems = (cost.lineItems || []).map((li) => ({
      category: li.category, label: li.label, itemId: li.itemId || '', qty: li.qty, unit: li.unit || '',
      unitCost: li.unitCost, total: li.total, isReagent: ('totalAmount' in li),
      totalAmount: li.totalAmount, units: li.units, quantity: li.quantity, quantityUnit: li.quantityUnit
    }));
    return {
      nSamples: plan.nSamples, nPools: plan.nPools, arms: (plan.arms || []).slice(), modalities: (plan.modalities || []).slice(),
      knownTotal: cost.knownTotal, reagents, lineItems, customCols, batches, warnings: (plan.warnings || []).slice(),
      cellsPerSample: scen.cellsPerSample, poolContributionPerSample: scen.poolContributionPerSample, unsortAmt: scen.unsortAmt, asapAmt: scen.asapAmt,
      laneBreakdown: (cost.laneBreakdown || []).map((l) => ({
        arm: l.arm || l.key, chem: l.chem, population: l.population, laneChem: l.laneChem, lanes: l.lanes,
        vdj: !!l.vdj, libraries: (l.libraries || []).slice(), label: l.label
      }))
    };
  }

  // ---- save / new / open ----------------------------------------------------
  function saveExperimentUI() {
    if (!CURRENT_EXP_ID) { alert('Create an experiment from the Project manager tab first.'); return; }
    const rec = Store.getExperiment(CURRENT_EXP_ID);
    if (!rec) { CURRENT_EXP_ID = null; updatePlanExpBar(); return; }
    const res = computeCurrent();
    rec.state = serializeState();
    if (!res.error) rec.snapshot = buildSnapshot(res);
    Store.saveExperiment(rec);
    renderManage();
    updatePlanExpBar();
    flashSaveStatus(res.error
      ? 'Saved inputs for \u201c' + rec.name + '\u201d \u2014 build the plan for reagents/cost (' + res.error + ')'
      : 'Saved \u201c' + rec.name + '\u201d.', !res.error);
  }

  function flashSaveStatus(msg, ok) {
    const el = $('#saveStatus');
    if (!el) return;
    el.textContent = msg;
    el.className = 'save-status ' + (ok ? 'ok' : 'warn');
    el.hidden = false;
  }

  // Reset the Plan editor to a blank design (used when creating a new experiment).
  function resetPlanEditor() {
    SEL = freshSelection();
    clearGrid();
    const box = $('#useMadiDefault'); if (box) box.checked = false;
    renderPopulationBuilder();
    onSelectionChange();
    const el = $('#saveStatus'); if (el) el.hidden = true;
  }

  // Create a new experiment (metadata from the Project manager form), then jump
  // to the Plan tab to build it.
  function createExperimentUI(meta) {
    const rec = { name: meta.name, project: meta.project || '', date: meta.date || '',
      plannedBy: meta.plannedBy || '', status: 'planned', reserved: true };
    if (rec.project) rec.experimentId = Store.nextExperimentId(rec.project);
    Store.saveExperiment(rec);
    CURRENT_EXP_ID = rec.id;
    resetPlanEditor();
    renderManage();
    updatePlanExpBar();
    selectTop('plan', 'plan');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    flashSaveStatus('New experiment \u201c' + rec.name + '\u201d \u2014 build the plan, then Save.', true);
  }

  function updatePlanExpBar() {
    const cur = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    if (cur && cur.project) CURRENT_PROJECT = cur.project;
    const lbl = $('#currentExpLabel');
    if (lbl) {
      lbl.textContent = cur ? ('Building: ' + (cur.name || 'experiment') + (cur.project ? ' \u00b7 ' + cur.project : '')) : 'No experiment selected';
      lbl.classList.toggle('is-saved', !!cur);
    }
    const hint = $('#noExpHint'); if (hint) hint.hidden = !!cur;
    const sb = $('#savePlanBtn'); if (sb) sb.disabled = !cur;
    updateContextBar();
  }

  // Global "Working on: Project > Experiment" bar (always visible under the tabs).
  function updateContextBar() {
    const cur = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    const proj = (cur && cur.project) ? cur.project : CURRENT_PROJECT;
    const psel = $('#ctxProjectSel'), esel = $('#ctxExperimentSel');
    const pp = $('#ctxProject'), ep = $('#ctxExperiment'), hint = $('#ctxHint');
    if (psel) {
      const names = Store.allProjects().map((p) => p.name).filter(Boolean);
      Store.allExperiments().forEach((e) => { if (e.project && names.indexOf(e.project) < 0) names.push(e.project); });
      names.sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1);
      psel.innerHTML = '<option value="">\u2014 select \u2014</option>' + names.map((n) => '<option value="' + escAttr(n) + '"' + (n === proj ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
    }
    if (esel) {
      const exps = Store.allExperiments().filter((e) => (e.project || '') === (proj || ''));
      esel.innerHTML = '<option value="">\u2014 select \u2014</option>' + exps.map((e) => '<option value="' + e.id + '"' + (e.id === CURRENT_EXP_ID ? ' selected' : '') + '>' + esc(e.name || 'experiment') + '</option>').join('');
    }
    if (pp) pp.classList.toggle('ctx-set', !!proj);
    if (ep) ep.classList.toggle('ctx-set', !!cur);
    if (hint) hint.hidden = !!(proj || cur);
  }
  // Switching in the context bar back-propagates to the Project manager:
  // expands the chosen project/experiment, collapses the rest, and opens the tab.
  function wireContextBar() {
    const psel = $('#ctxProjectSel'), esel = $('#ctxExperimentSel');
    if (psel) psel.addEventListener('change', () => {
      CURRENT_PROJECT = psel.value || null; CURRENT_EXP_ID = null;
      EXPANDED_PROJECTS = {}; if (CURRENT_PROJECT) EXPANDED_PROJECTS[CURRENT_PROJECT] = true;
      EXPANDED_EXPERIMENTS = {};
      updatePlanExpBar(); renderManage();
      selectTop('projects');
    });
    if (esel) esel.addEventListener('change', () => {
      const id = esel.value;
      if (!id) { CURRENT_EXP_ID = null; updatePlanExpBar(); return; }
      CURRENT_EXP_ID = id; const r = Store.getExperiment(id); CURRENT_PROJECT = r ? (r.project || CURRENT_PROJECT) : CURRENT_PROJECT;
      EXPANDED_PROJECTS = {}; if (CURRENT_PROJECT) EXPANDED_PROJECTS[CURRENT_PROJECT] = true;
      EXPANDED_EXPERIMENTS = {}; EXPANDED_EXPERIMENTS[id] = true;
      updatePlanExpBar(); renderManage();
      selectTop('projects');
    });
  }
  function setActiveProject(name) { CURRENT_PROJECT = name || null; updateContextBar(); }
  window.setActiveProject = setActiveProject;
  window.updateContextBar = updateContextBar;

  // Build a tube-label sheet (one row per physical tube) from the pooling
  // strategy + selected modalities. Columns: Tube, Line 1, Line 2, Line 3.
  function buildTubeLabelsWb() {
    const calc = computePooling();
    if (!calc || !calc.samples.length) return null;
    const curRec = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    const exp = (curRec && curRec.name) ? curRec.name : 'Experiment';
    const expId = (curRec && curRec.experimentId) ? curRec.experimentId : '';
    const arms = buildArmInstances(SEL);
    const hasUnsort = arms.some((a) => a.population === 'unsorted' && a.chem === 'cite5');
    const hasAsap = arms.some((a) => a.chem === 'asap');
    const hasSort = arms.some((a) => a.population === 'sorted' || a.laneMode === 'perSortPop');
    const hasBulk = !!(SEL.bulk && SEL.bulk.on) || arms.some((a) => a.bulk);
    const vdjOn = (key) => !!(SEL[key] && SEL[key].vdj);

    const poolOf = {};
    calc.poolRes.pools.forEach((pool, i) => pool.forEach((s) => { poolOf[s.sampleId] = i + 1; }));
    const htoByPool = {}; calc.htoRes.assignments.forEach((x) => { htoByPool[x.pool] = x.hto; });
    const htoNum = (i) => { const v = htoByPool[i] || ''; const m = /(\d+)/.exec(v); return m ? m[1] : (i + 1); };
    const nPools = calc.poolRes.nPools;

    // per-arm lane counts (drive the cDNA/library tube labels)
    const lanes = laneOverridesFromCost(calc.samples.length, nPools, calc.samples) || { unsort: 0, asap: 0, sort: 0 };

    // Canonical sample number = pool-grouped order (pool 1 samples first, then
    // pool 2, ...) — the SAME numbering used by the Samples and Cell count tabs.
    const sampleNo = sampleNoMap().byId;
    const sampleList = calc.samples.slice().sort((a, b) => (sampleNo[a.sampleId] || 0) - (sampleNo[b.sampleId] || 0));

    // ===== Sheet 1: sample prep + FACS + controls + sort output + bulk =====
    const rows1 = [['Tube', 'Line 1', 'Line 2', 'Line 3', 'Line 4']];
    const dateStr = (curRec && curRec.date) ? curRec.date : '';
    const a1 = (t, l1, l2, l3) => rows1.push([t, l1 == null ? '' : String(l1), l2 == null ? '' : String(l2), l3 == null ? '' : String(l3), dateStr]);

    sampleList.forEach((s) => {
      const no = sampleNo[s.sampleId] || '?';
      a1('Sample (15mL)', 'pool ' + (poolOf[s.sampleId] || '?'), no, no + ' / ' + s.sampleId);
    });
    a1('Sample (15mL)', '', 'Ctrl', 'CSEI Leukopak Control');   // unstained leukopak control
    for (let i = 0; i < nPools; i++) {
      if (hasSort) a1('Pool (50 mL)', 'TotalSeq-C HTO ' + htoNum(i), 'sort' + (i + 1), 'remainder from pool ' + (i + 1));
      else a1('Pool (50 mL)', 'pool ' + (i + 1), '50 mL pool', exp);
    }
    if (hasUnsort) for (let i = 0; i < nPools; i++) a1("5' unsort (FACS)", 'TotalSeq-C HTO ' + htoNum(i), 'unsort' + (i + 1), '');
    if (hasAsap) for (let i = 0; i < nPools; i++) a1('ASAP (FACS)', 'TotalSeq-A HTO ' + htoNum(i), 'asap' + (i + 1), '');
    if (hasUnsort) a1('Super-pool (FACS)', '', 'unsort sp', 'unsort super-pool');
    if (hasAsap) a1('Super-pool (FACS)', '', 'asap sp', 'asap super-pool');
    if (hasSort) a1('Super-pool (FACS)', '', 'sort sp', 'sort super-pool');
    a1('Unstain control (FACS)', '', 'Unstain', 'Unstain control');
    a1('L/D control (FACS)', '', 'L/D', 'L/D control');
    if (hasSort) ['HSC', 'pDC', 'cDC', 'Treg'].forEach((p) => a1('Sort output (FACS)', '', p, ''));
    if (hasBulk) sampleList.forEach((s) => { const no = sampleNo[s.sampleId] || '?'; a1('BulkRNA (1.5mL tube)', 'Bulk RNA', no, no + ' / ' + s.sampleId); });

    // ===== Sheet 2: GEM-RT + cDNA + library tubes (Sheet1 naming convention) =====
    // Base ID = {U/A/S}{lane-within-chip}; append -{chip} only when that modality
    // uses more than one chip. GEM-RT tubes get a -GEM suffix. Line 1 = experiment
    // ID, Line 2 = short tube name, Line 3 = batch date (YYMMDD).
    const dateYY = (function () { const d = (curRec && curRec.date) ? curRec.date : ''; const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d); return m ? (m[1].slice(2) + m[2] + m[3]) : ''; })();
    const baseName = (letter, g) => letter + (g + 1);   // sequential across all chips (no -chip suffix)
    const rangeN = (n) => Array.from({ length: n }, (_, i) => i);
    // Build groups; each group prints on its own tube strip(s) of 8 (no mixing types/modalities).
    const groups = [];
    const grp = (tube, modality, type, names) => { if (names.length) groups.push({ tube: tube, modality: modality, type: type, names: names }); };
    // unsort 5'
    grp('GEM-RT strip', "Unsort 5'", 'GEM RT output', rangeN(lanes.unsort).map((i) => baseName('U', i, 8, lanes.unsort) + '-GEM'));
    grp('cDNA strip', "Unsort 5'", 'pellet \u2192 GEX' + (vdjOn('unsorted') ? '/VDJ' : ''), rangeN(lanes.unsort).map((i) => baseName('U', i, 8, lanes.unsort) + '-P'));
    grp('cDNA strip', "Unsort 5'", 'supernatant \u2192 CSP (ADT)', rangeN(lanes.unsort).map((i) => baseName('U', i, 8, lanes.unsort) + '-S'));
    grp('Library', "Unsort 5'", 'GEX library', rangeN(lanes.unsort).map((i) => baseName('U', i, 8, lanes.unsort) + '-GEX'));
    grp('Library', "Unsort 5'", 'CSP/ADT library', rangeN(lanes.unsort).map((i) => baseName('U', i, 8, lanes.unsort) + '-ADT'));
    if (vdjOn('unsorted')) { grp('Library', "Unsort 5'", 'TCR library', rangeN(lanes.unsort).map((i) => baseName('U', i, 8, lanes.unsort) + '-TCR')); grp('Library', "Unsort 5'", 'BCR library', rangeN(lanes.unsort).map((i) => baseName('U', i, 8, lanes.unsort) + '-BCR')); }
    // ASAP
    grp('GEM-RT strip', 'ASAP', 'GEM RT output', rangeN(lanes.asap).map((i) => baseName('A', i, 8, lanes.asap) + '-GEM'));
    grp('cDNA strip', 'ASAP', 'ASAP transposed', rangeN(lanes.asap).map((i) => baseName('A', i, 8, lanes.asap)));
    grp('Library', 'ASAP', 'ATAC library', rangeN(lanes.asap).map((i) => baseName('A', i, 8, lanes.asap) + '-ATAC'));
    grp('Library', 'ASAP', 'CSP/ADT library', rangeN(lanes.asap).map((i) => baseName('A', i, 8, lanes.asap) + '-ADT'));
    grp('Library', 'ASAP', 'HTO library', rangeN(lanes.asap).map((i) => baseName('A', i, 8, lanes.asap) + '-HTO'));
    // sort 5'
    grp('GEM-RT strip', "Sort 5'", 'GEM RT output', rangeN(lanes.sort).map((i) => baseName('S', i, 8, lanes.sort) + '-GEM'));
    grp('cDNA strip', "Sort 5'", 'pellet \u2192 GEX' + (vdjOn('sorted') ? '/VDJ' : ''), rangeN(lanes.sort).map((i) => baseName('S', i, 8, lanes.sort) + '-P'));
    grp('cDNA strip', "Sort 5'", 'supernatant \u2192 CSP (ADT)', rangeN(lanes.sort).map((i) => baseName('S', i, 8, lanes.sort) + '-S'));
    grp('Library', "Sort 5'", 'GEX library', rangeN(lanes.sort).map((i) => baseName('S', i, 8, lanes.sort) + '-GEX'));
    grp('Library', "Sort 5'", 'CSP/ADT library', rangeN(lanes.sort).map((i) => baseName('S', i, 8, lanes.sort) + '-ADT'));
    if (vdjOn('sorted')) grp('Library', "Sort 5'", 'TCR library', rangeN(lanes.sort).map((i) => baseName('S', i, 8, lanes.sort) + '-TCR'));
    // Flatten into strips of 8, padding each group with "blank tube" spacers.
    // Split by tube type into separate tabs (printed on different-coloured paper):
    // Intermediate (GEM-RT) · cDNA · Library.
    function stripRows(groupList) {
      const rows = [['Strip #', 'Tube', 'Modality', 'Type', 'Line 1 (Experiment ID)', 'Line 2', 'Line 3']];
      let stripNo = 0;
      groupList.forEach((gp) => {
        const nStrips = Math.ceil(gp.names.length / 8);
        for (let sIdx = 0; sIdx < nStrips; sIdx++) {
          stripNo += 1;
          for (let j = 0; j < 8; j++) {
            const idx = sIdx * 8 + j;
            if (idx < gp.names.length) rows.push([stripNo, gp.tube, gp.modality, gp.type, expId || exp, gp.names[idx], dateYY]);
            else rows.push([stripNo, 'blank tube', '', '', '', '', '']);
          }
        }
      });
      return rows;
    }
    const interGroups = groups.filter((g) => g.tube === 'GEM-RT strip');
    const cdnaGroups = groups.filter((g) => g.tube === 'cDNA strip');
    const libGroups = groups.filter((g) => g.tube === 'Library');

    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet(rows1); ws1['!cols'] = [{ wch: 20 }, { wch: 18 }, { wch: 18 }, { wch: 30 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws1, 'Sample & FACS labels');
    const stripCols = [{ wch: 7 }, { wch: 14 }, { wch: 12 }, { wch: 22 }, { wch: 18 }, { wch: 12 }, { wch: 10 }];
    [['Intermediate labels', interGroups], ['cDNA labels', cdnaGroups], ['Library labels', libGroups]].forEach((pair) => {
      const ws = XLSX.utils.aoa_to_sheet(stripRows(pair[1])); ws['!cols'] = stripCols;
      XLSX.utils.book_append_sheet(wb, ws, pair[0]);
    });
    return { wb: wb, name: 'tube_labels_' + (expId || exp).replace(/[^A-Za-z0-9._-]+/g, '_') };
  }
  function generateTubeLabels() {
    const r = buildTubeLabelsWb();
    if (!r) { alert('Add samples and compute a pooling strategy first.'); return; }
    XLSX.writeFile(r.wb, r.name + '.xlsx');
  }

  // Library Sequencing Record — one row per library type, counts = lanes,
  // matching the shared record's columns (rest left blank to fill in later).
  function buildLibraryRecordWb() {
    const calc = computePooling();
    if (!calc || !calc.samples.length) return null;
    const curRec = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    const exp = (curRec && curRec.name) ? curRec.name : 'Experiment';
    const expId = (curRec && curRec.experimentId) ? curRec.experimentId : '';
    const project = (curRec && curRec.project) ? curRec.project : '';
    const arms = buildArmInstances(SEL);
    const hasUnsort = arms.some((a) => a.population === 'unsorted' && a.chem === 'cite5');
    const hasAsap = arms.some((a) => a.chem === 'asap');
    const hasSort = arms.some((a) => a.population === 'sorted' || a.laneMode === 'perSortPop');
    const vdjOn = (key) => !!(SEL[key] && SEL[key].vdj);
    const lanes = laneOverridesFromCost(calc.samples.length, calc.poolRes.nPools, calc.samples) || { unsort: 0, asap: 0, sort: 0 };

    const header = ['Project', 'Experiment', 'Experiment_ID', 'Library Type', '# of Libraries', 'Indexing Scheme', 'Storage Location', 'Requested Sequencing Depth', 'Service Provider', 'Sent Date', 'Sequencing Status', 'Flow Cell ID', 'Data Storage Location'];
    const rows = [header];
    const add = (libType, n) => { if (n > 0) rows.push([project, exp, expId, libType, n, '', '', '', '', '', '', '', '']); };
    if (hasUnsort) { add("5' unsort GEX", lanes.unsort); add("5' unsort CSP (ADT)", lanes.unsort); if (vdjOn('unsorted')) { add("5' unsort TCR", lanes.unsort); add("5' unsort BCR", lanes.unsort); } }
    if (hasAsap) { add('ASAP ATAC', lanes.asap); add('ASAP CSP (ADT)', lanes.asap); add('ASAP HTO', lanes.asap); }
    if (hasSort) { add("5' sort GEX", lanes.sort); add("5' sort CSP (ADT)", lanes.sort); if (vdjOn('sorted')) add("5' sort TCR", lanes.sort); }

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = header.map((h) => ({ wch: Math.max(12, h.length + 2) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Library record');
    return { wb: wb, name: 'library_record_' + (expId || exp).replace(/[^A-Za-z0-9._-]+/g, '_') };
  }
  function generateLibraryRecord() {
    const r = buildLibraryRecordWb();
    if (!r) { alert('Add samples and compute a pooling strategy first.'); return; }
    XLSX.writeFile(r.wb, r.name + '.xlsx');
  }

  // Build the library rows (data only, no header) for the current experiment.
  function buildLibraryRows() {
    const calc = computePooling();
    if (!calc || !calc.samples.length) return null;
    const curRec = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    const exp = (curRec && curRec.name) ? curRec.name : 'Experiment';
    const expId = (curRec && curRec.experimentId) ? curRec.experimentId : '';
    const project = (curRec && curRec.project) ? curRec.project : '';
    const arms = buildArmInstances(SEL);
    const hasUnsort = arms.some((a) => a.population === 'unsorted' && a.chem === 'cite5');
    const hasAsap = arms.some((a) => a.chem === 'asap');
    const hasSort = arms.some((a) => a.population === 'sorted' || a.laneMode === 'perSortPop');
    const vdjOn = (key) => !!(SEL[key] && SEL[key].vdj);
    const lanes = laneOverridesFromCost(calc.samples.length, calc.poolRes.nPools, calc.samples) || { unsort: 0, asap: 0, sort: 0 };
    const rows = [];
    const add = (libType, n) => { if (n > 0) rows.push([project, exp, expId, libType, n, '', '', '', '', '', '', '', '']); };
    if (hasUnsort) { add("5' unsort GEX", lanes.unsort); add("5' unsort CSP (ADT)", lanes.unsort); if (vdjOn('unsorted')) { add("5' unsort TCR", lanes.unsort); add("5' unsort BCR", lanes.unsort); } }
    if (hasAsap) { add('ASAP ATAC', lanes.asap); add('ASAP CSP (ADT)', lanes.asap); add('ASAP HTO', lanes.asap); }
    if (hasSort) { add("5' sort GEX", lanes.sort); add("5' sort CSP (ADT)", lanes.sort); if (vdjOn('sorted')) add("5' sort TCR", lanes.sort); }
    return { rows: rows, experimentId: expId, exp: exp };
  }

  // Build per-tab rows for the 9-tab Library Sequencing Record (auto-populated
  // columns only; volume/concentration/index sequence/storage stay blank for
  // manual entry; Tube Inventoried = FALSE renders as an unchecked checkbox).
  function buildLibraryRecordTabs() {
    const calc = computePooling();
    if (!calc || !calc.samples.length) return null;
    const curRec = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    const exp = (curRec && curRec.name) ? curRec.name : 'Experiment';
    const expId = (curRec && curRec.experimentId) ? curRec.experimentId : '';
    const project = (curRec && curRec.project) ? curRec.project : '';
    const proj = Store.allProjects().find((p) => p.name === project);
    const abbrev = (proj && proj.abbreviation) || '';
    const arms = buildArmInstances(SEL);
    const hasUnsort = arms.some((a) => a.population === 'unsorted' && a.chem === 'cite5');
    const hasAsap = arms.some((a) => a.chem === 'asap');
    const hasSort = arms.some((a) => a.population === 'sorted' || a.laneMode === 'perSortPop');
    const vdjOn = (key) => !!(SEL[key] && SEL[key].vdj);
    const lanes = laneOverridesFromCost(calc.samples.length, calc.poolRes.nPools, calc.samples) || { unsort: 0, asap: 0, sort: 0 };
    const bn = (letter, g) => letter + (g + 1);   // sequential across all chips (no -chip suffix)
    const ctr = {};
    const idxId = (kind) => { const n = (ctr[kind] = (ctr[kind] || 0) + 1) - 1; if (kind === 'rpi') return 'RPI' + ((n % 16) + 1); if (kind === 'd7xx') return 'D7' + String((n % 12) + 1).padStart(2, '0'); const w = n % 96; return String.fromCharCode(65 + Math.floor(w / 12)) + (w % 12 + 1); };
    const IDX = { gex: ['Dual Index TT Set A', 'plate'], csp: ['Dual Index TN Set A', 'plate'], vdj: ['Dual Index TT Set A (VDJ plate)', 'plate'], atac: ['Single Index N Set A', 'plate'], asapAdt: ['RPI oligos (ASAP ADT)', 'rpi'], asapHto: ['D7xx oligos (ASAP HTO)', 'd7xx'] };
    const libRow = (tube, modality, libType, idxKey) => [false, abbrev, exp, expId, tube, modality, libType, '', IDX[idxKey][0], idxId(IDX[idxKey][1]), '', '', '', '', '', ''];
    const cdnaRow = (tube, modality, cdnaType) => [false, abbrev, exp, expId, tube, modality, cdnaType, '', '', '', '', '', ''];
    const tabs = { '5 GEX': [], '5 ADT': [], 'ASAP ATAC': [], 'ASAP ADT': [], 'ASAP HTO': [], 'V(D)J': [], 'cDNA': [] };
    if (hasUnsort) {
      for (let i = 0; i < lanes.unsort; i++) tabs['5 GEX'].push(libRow(bn('U', i, 8, lanes.unsort) + '-GEX', 'Unsort', 'GEX', 'gex'));
      for (let i = 0; i < lanes.unsort; i++) tabs['5 ADT'].push(libRow(bn('U', i, 8, lanes.unsort) + '-ADT', 'Unsort', 'CSP/ADT', 'csp'));
      if (vdjOn('unsorted')) for (let i = 0; i < lanes.unsort; i++) { tabs['V(D)J'].push(libRow(bn('U', i, 8, lanes.unsort) + '-TCR', 'Unsort', 'TCR', 'vdj')); tabs['V(D)J'].push(libRow(bn('U', i, 8, lanes.unsort) + '-BCR', 'Unsort', 'BCR', 'vdj')); }
      for (let i = 0; i < lanes.unsort; i++) { const b = bn('U', i, 8, lanes.unsort); tabs['cDNA'].push(cdnaRow(b + '-P', 'Unsort', 'pellet \u2192 GEX' + (vdjOn('unsorted') ? '/VDJ' : ''))); tabs['cDNA'].push(cdnaRow(b + '-S', 'Unsort', 'supernatant \u2192 CSP')); }
    }
    if (hasAsap) {
      for (let i = 0; i < lanes.asap; i++) tabs['ASAP ATAC'].push(libRow(bn('A', i, 8, lanes.asap) + '-ATAC', 'ASAP', 'ATAC', 'atac'));
      for (let i = 0; i < lanes.asap; i++) tabs['ASAP ADT'].push(libRow(bn('A', i, 8, lanes.asap) + '-ADT', 'ASAP', 'CSP/ADT', 'asapAdt'));
      for (let i = 0; i < lanes.asap; i++) tabs['ASAP HTO'].push(libRow(bn('A', i, 8, lanes.asap) + '-HTO', 'ASAP', 'HTO', 'asapHto'));
      for (let i = 0; i < lanes.asap; i++) tabs['cDNA'].push(cdnaRow(bn('A', i, 8, lanes.asap), 'ASAP', 'ASAP transposed'));
    }
    if (hasSort) {
      for (let i = 0; i < lanes.sort; i++) tabs['5 GEX'].push(libRow(bn('S', i, 8, lanes.sort) + '-GEX', 'Sort', 'GEX', 'gex'));
      for (let i = 0; i < lanes.sort; i++) tabs['5 ADT'].push(libRow(bn('S', i, 8, lanes.sort) + '-ADT', 'Sort', 'CSP/ADT', 'csp'));
      if (vdjOn('sorted')) for (let i = 0; i < lanes.sort; i++) tabs['V(D)J'].push(libRow(bn('S', i, 8, lanes.sort) + '-TCR', 'Sort', 'TCR', 'vdj'));
      for (let i = 0; i < lanes.sort; i++) { const b = bn('S', i, 8, lanes.sort); tabs['cDNA'].push(cdnaRow(b + '-P', 'Sort', 'pellet \u2192 GEX' + (vdjOn('sorted') ? '/VDJ' : ''))); tabs['cDNA'].push(cdnaRow(b + '-S', 'Sort', 'supernatant \u2192 CSP')); }
    }
    Object.keys(tabs).forEach((t) => { if (!tabs[t].length) delete tabs[t]; });
    let total = 0; Object.keys(tabs).forEach((t) => { total += tabs[t].length; });
    return { tabs: tabs, experimentId: expId, exp: exp, total: total };
  }

  function sendLibraryTubesToRecord() {
    const built = buildLibraryRecordTabs();
    if (!built || !built.total) { alert('Add samples and compute a pooling strategy first.'); return; }
    if (!confirm('Auto-populate the Library Sequencing Record with ' + built.total + ' library/cDNA tubes for \u201c' + built.exp + '\u201d across ' + Object.keys(built.tabs).length + ' tab(s)? Existing rows for this experiment are replaced.')) return;
    fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'recordTubes', tabs: built.tabs, experimentId: built.experimentId }) })
      .then((r) => r.json())
      .then((d) => { if (d && d.ok) alert('Populated the Library Sequencing Record \u2014 ' + Object.keys(d.results || {}).map((t) => t + ': ' + d.results[t]).join(', ') + '.'); else alert('Could not write to the record: ' + (d && d.message ? d.message : JSON.stringify(d))); })
      .catch((e) => alert('Library record write failed: ' + e));
  }

  function sendLibraryToSheet() {
    const built = buildLibraryRows();
    if (!built || !built.rows.length) { alert('Add samples and compute a pooling strategy first.'); return; }
    if (!confirm('Add ' + built.rows.length + ' library rows for "' + built.exp + '" to the shared Library Sequencing Record? Existing rows for this experiment will be replaced.')) return;
    fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: built.rows, experimentId: built.experimentId, replace: true }) })
      .then((r) => r.json())
      .then((d) => { if (d && d.ok) alert('Added ' + d.appended + ' library rows to the record sheet.'); else alert('Could not write to the library record: ' + (d && d.message ? d.message : JSON.stringify(d))); })
      .catch((e) => alert('Library record write failed: ' + e));
  }

  // Post-experiment: record the exact kit boxes / index wells actually used, save
  // to the experiment record, and deduct from those boxes in 10X Kits_All.
  function recordUsageUI(id) {
    const rec = Store.getExperiment(id); if (!rec) return;
    const existing = rec.actualUsage || { items: [], notes: '', deducted: {} };
    // migrate: deducted may be {kitId:{rxns,indexes}} (old) or {kitId:number} (new)
    const baseline = {};   // kitId -> amount already deducted (mutable; advances after each apply)
    Object.keys(existing.deducted || {}).forEach((k) => {
      const v = existing.deducted[k];
      baseline[k] = (typeof v === 'object' && v) ? ((Number(v.rxns) || 0) + (Number(v.indexes) || 0)) : (Number(v) || 0);
    });
    const usedOf = (it) => (it.used != null ? it.used : (it.rxnsUsed != null || it.indexesUsed != null ? Math.max(Number(it.rxnsUsed) || 0, Number(it.indexesUsed) || 0) : ''));
    const rowHtml = (it) => {
      const applied = baseline[it.kitId];
      const badge = (applied != null && applied !== 0) ? '<span class="u-applied" title="already deducted">\u2713 ' + applied + ' used</span>' : '';
      return '<tr>'
        + '<td><input class="u-kit" value="' + esc(it.kitId || '') + '" placeholder="e.g. 1000215-001" /></td>'
        + '<td><input class="u-used" type="number" min="0" value="' + (usedOf(it) === '' ? '' : usedOf(it)) + '" /></td>'
        + '<td class="u-appliedcell">' + badge + '</td>'
        + '<td><button class="btn tiny u-del" title="remove">\u00d7</button></td></tr>';
    };
    const startRows = (existing.items && existing.items.length ? existing.items : [{ kitId: '', used: '' }]);
    const ov = document.createElement('div'); ov.className = 'usage-overlay';
    const bannerHtml = () => (Object.keys(baseline).some((k) => baseline[k]))
      ? '<div class="u-banner" id="uBanner">Already applied to inventory' + (existing.recordedAt ? ' (last on ' + esc(existing.recordedAt.slice(0, 10)) + ')' : '') + '. Saving deducts only the <strong>change</strong> since last save.</div>'
      : '<div id="uBanner"></div>';
    ov.innerHTML = '<div class="usage-modal"><h3>Material usage &mdash; ' + esc(rec.name || '') + (rec.experimentId ? ' <span class="exp-id">' + esc(rec.experimentId) + '</span>' : '') + '</h3>'
      + bannerHtml()
      + '<p class="muted">Enter the exact kit boxes (Kit ID from <strong>10X Kits_All</strong>) and one number for how many <strong>rxns / lanes / index wells</strong> you used from each. Saving deducts the net change from those boxes.</p>'
      + '<table class="usage-tbl"><thead><tr><th>Kit ID (box)</th><th>Rxns / lanes / indexes used</th><th>Applied</th><th></th></tr></thead><tbody id="uBody">' + startRows.map(rowHtml).join('') + '</tbody></table>'
      + '<button class="btn ghost" id="uAdd">+ Add box</button>'
      + '<label style="display:block;margin-top:10px">Notes<textarea id="uNotes" rows="2">' + esc(existing.notes || '') + '</textarea></label>'
      + '<div class="row-actions" style="margin-top:10px"><button class="btn primary" id="uSave">Save &amp; apply changes</button><button class="btn ghost" id="uCancel">Close</button></div>'
      + '<div id="uStatus" class="muted" style="margin-top:8px"></div></div>';
    document.body.appendChild(ov);
    const close = () => { if (ov.parentNode) document.body.removeChild(ov); };
    // refresh the per-row "Applied" badges from the current baseline
    const refreshBadges = () => {
      ov.querySelectorAll('#uBody tr').forEach((tr) => {
        const kit = tr.querySelector('.u-kit').value.trim();
        const applied = baseline[kit];
        tr.querySelector('.u-appliedcell').innerHTML = (applied != null && applied !== 0) ? '<span class="u-applied">\u2713 ' + applied + ' used</span>' : '';
      });
    };
    ov.addEventListener('click', (e) => {
      if (e.target === ov || e.target.id === 'uCancel') { close(); return; }
      if (e.target.id === 'uAdd') { ov.querySelector('#uBody').insertAdjacentHTML('beforeend', rowHtml({ kitId: '', used: '' })); return; }
      if (e.target.classList.contains('u-del')) { const tr = e.target.closest('tr'); if (tr) tr.remove(); return; }
      if (e.target.id === 'uSave') {
        const items = [];
        ov.querySelectorAll('#uBody tr').forEach((tr) => {
          const kit = tr.querySelector('.u-kit').value.trim();
          if (!kit) return;
          items.push({ kitId: kit, used: Number(tr.querySelector('.u-used').value) || 0 });
        });
        const newTotals = {}; items.forEach((it) => { newTotals[it.kitId] = it.used; });
        const kitset = {}; Object.keys(baseline).forEach((k) => { kitset[k] = 1; }); Object.keys(newTotals).forEach((k) => { kitset[k] = 1; });
        const deltas = [];
        Object.keys(kitset).forEach((kit) => {
          const d = (newTotals[kit] || 0) - (baseline[kit] || 0);
          if (d) deltas.push({ kitId: kit, used: d });
        });
        const st = ov.querySelector('#uStatus');
        rec.actualUsage = { items: items, notes: ov.querySelector('#uNotes').value, recordedAt: new Date().toISOString(), deducted: Object.assign({}, baseline) };
        if (!deltas.length) { Store.saveExperiment(rec); st.textContent = 'Saved. No inventory change (nothing new to deduct).'; refreshBadges(); return; }
        st.textContent = 'Saving and applying net change to inventory\u2026';
        const saveBtn = ov.querySelector('#uSave'); saveBtn.disabled = true;
        fetch('/api/inventory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'deductKitBoxes', items: deltas }) })
          .then((r) => r.json()).then((d) => {
            saveBtn.disabled = false;
            const errs = [];
            (d && d.results ? d.results : []).forEach((res) => {
              if (res.error) { errs.push(res.kitId); return; }
              // advance the baseline for successfully-applied boxes so a second click is a no-op
              if (newTotals[res.kitId] != null) baseline[res.kitId] = newTotals[res.kitId]; else delete baseline[res.kitId];
            });
            rec.actualUsage.deducted = Object.assign({}, baseline); Store.saveExperiment(rec);
            refreshBadges();
            const b = ov.querySelector('#uBanner'); if (b && Object.keys(baseline).some((k) => baseline[k])) b.outerHTML = bannerHtml();
            if (d && d.ok) st.textContent = errs.length ? ('Applied, but these Kit IDs were not found (fix and re-save): ' + errs.join(', ')) : ('Applied. Net change deducted from ' + (d.results || []).length + ' box(es). Clicking Save again now does nothing.');
            else st.textContent = 'Saved to the experiment, but the deduction failed: ' + (d && d.message ? d.message : JSON.stringify(d));
            renderManage();
          })
          .catch((err) => { saveBtn.disabled = false; Store.saveExperiment(rec); st.textContent = 'Saved to the experiment, but the deduction request failed: ' + err; });
      }
    });
  }

  function openExperiment(id) {
    const rec = Store.getExperiment(id);
    if (!rec) return;
    restoreState(rec.state);
    CURRENT_EXP_ID = id;
    try { runComputePooling(false); } catch (e) { /* preview is best-effort */ }
    const res = computeCurrent();
    if (!res.error) renderAllTabs(res);
    updatePlanExpBar();
    flashSaveStatus('Editing \u201c' + (rec.name || 'experiment') + '\u201d. Rebuild + Save to update its numbers.', true);
    selectTop('plan', 'plan');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function openExperimentProtocols(id) {
    const rec = Store.getExperiment(id);
    if (!rec) return;
    restoreState(rec.state);
    CURRENT_EXP_ID = id;
    const res = computeCurrent();
    if (res.error) { alert('Could not build protocols: ' + res.error); return; }
    renderAllTabs(res);
    selectTop('plan', 'protocols');
  }

  // ---- project-level exports ------------------------------------------------
  function withSnapshotExps(project) {
    return Store.experimentsInProject(project).filter((e) => e.snapshot);
  }

  function projectLabel(project) {
    if (project === '__all__') return 'all-experiments';
    return (project || 'unfiled').replace(/[^A-Za-z0-9._-]+/g, '_');
  }

  function projectReagentXlsx(project) {
    const exps = withSnapshotExps(project);
    if (!exps.length) { alert('No saved experiments with computed reagents in this project yet. Open an experiment and Save it after building the plan.'); return; }
    const merged = {};
    exps.forEach((e) => (e.snapshot.reagents || []).forEach((r) => {
      const key = (r.itemId || r.reagent) + '|' + (r.units || '');
      if (!merged[key]) merged[key] = { category: r.category, reagent: r.reagent, itemId: r.itemId || '', units: r.units || '', totalAmount: 0, cost: 0, priced: false, nExp: 0 };
      const m = merged[key];
      if (typeof r.totalAmount === 'number') m.totalAmount += r.totalAmount;
      if (r.total != null) { m.cost += r.total; m.priced = true; }
      m.nExp += 1;
    }));
    const rHeader = ['Category', 'Reagent', 'Item ID', 'Total amount', 'Units', 'Est. cost ($)', '# experiments'];
    const rRows = [rHeader];
    Object.keys(merged).sort((a, b) => (merged[a].category + merged[a].reagent).localeCompare(merged[b].category + merged[b].reagent)).forEach((k) => {
      const m = merged[k];
      rRows.push([m.category, m.reagent, m.itemId, Math.round(m.totalAmount * 1000) / 1000, m.units, m.priced ? Math.round(m.cost * 100) / 100 : '', m.nExp]);
    });

    const cHeader = ['Experiment', 'Project', 'Date', 'Status', 'Samples', 'Pools', 'Est. total ($)'];
    const cRows = [cHeader];
    let grand = 0;
    exps.forEach((e) => {
      const t = e.snapshot.knownTotal || 0; grand += t;
      cRows.push([e.name, e.project || '', e.date || '', e.status || '', e.snapshot.nSamples, e.snapshot.nPools, Math.round(t * 100) / 100]);
    });
    cRows.push([]); cRows.push(['PROJECT TOTAL', '', '', '', '', '', Math.round(grand * 100) / 100]);

    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet(cRows); ws1['!cols'] = [{ wch: 26 }, { wch: 18 }, { wch: 12 }, { wch: 11 }, { wch: 9 }, { wch: 7 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ws1, 'Cost summary');
    const ws2 = XLSX.utils.aoa_to_sheet(rRows); ws2['!cols'] = [{ wch: 24 }, { wch: 34 }, { wch: 9 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 13 }];
    XLSX.utils.book_append_sheet(wb, ws2, 'Reagent totals');
    XLSX.writeFile(wb, 'project_' + projectLabel(project) + '_reagents_cost.xlsx');
  }

  function projectBatchXlsx(project) {
    const exps = withSnapshotExps(project);
    if (!exps.length) { alert('No saved experiments with computed batches in this project yet.'); return; }
    const customSet = [];
    exps.forEach((e) => (e.snapshot.customCols || []).forEach((c) => { if (customSet.indexOf(c) === -1) customSet.push(c); }));
    const header = ['Experiment', 'Date', 'Status', 'Batch (genetic pool)', 'HTO', 'Loading super-pool', 'Sample ID', 'Patient ID', 'Lineage'].concat(customSet);
    const rows = [header];
    exps.forEach((e) => (e.snapshot.batches || []).forEach((b) => b.samples.forEach((s) => {
      rows.push([e.name, e.date || '', e.status || '', b.pool, b.hto, b.superPool, s.sampleId, s.patientId, s.lineage]
        .concat(customSet.map((c) => (s.confounders && s.confounders[c]) || '')));
    })));
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 24 }, { wch: 12 }, { wch: 10 }, { wch: 18 }, { wch: 8 }, { wch: 16 }, { wch: 20 }, { wch: 12 }, { wch: 12 }].concat(customSet.map(() => ({ wch: 14 })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Batches & samples');
    XLSX.writeFile(wb, 'project_' + projectLabel(project) + '_batches_samples.xlsx');
  }

  // ---- whole-project summary workbook ---------------------------------------
  const projLanes = (s) => { const L = { unsort: 0, asap: 0, sort: 0 }; (s.laneBreakdown || []).forEach((l) => { if (l.chem === 'asap') L.asap += l.lanes || 0; else if (l.population === 'sorted') L.sort += l.lanes || 0; else if (l.population === 'unsorted' && l.laneChem === "5'") L.unsort += l.lanes || 0; }); return L; };
  const projArmVdj = (s) => { const v = {}; (s.laneBreakdown || []).forEach((l) => { if (l.vdj) { if (l.population === 'sorted') v.sort = true; else if (l.chem !== 'asap') v.unsort = true; } }); return v; };

  function buildProjectWb(project) {
    const exps = withSnapshotExps(project);
    const proj = Store.allProjects().find((p) => p.name === project);
    const abbrev = (proj && proj.abbreviation) || '';
    const wb = XLSX.utils.book_new();
    const addSheet = (name, aoa, cols) => { const ws = XLSX.utils.aoa_to_sheet(aoa); if (cols) ws['!cols'] = cols; XLSX.utils.book_append_sheet(wb, ws, name); };

    // 1) Overview
    let totalSamples = 0, totalCost = 0; const dates = []; const statusCount = {}; const modSet = {};
    exps.forEach((e) => { const s = e.snapshot; totalSamples += s.nSamples || 0; totalCost += s.knownTotal || 0; if (e.date) dates.push(e.date); statusCount[e.status || 'planned'] = (statusCount[e.status || 'planned'] || 0) + 1; (s.modalities || []).forEach((m) => { modSet[m] = 1; }); });
    dates.sort();
    const ov = [['PROJECT SUMMARY'], [],
      ['Project', project], ['Abbreviation', abbrev], ['Owner', (proj && proj.owner) || ''], ['Generated', new Date().toISOString().slice(0, 10)], [],
      ['# experiments', exps.length], ['Total samples (all experiments)', totalSamples], ['Estimated total cost ($)', Math.round(totalCost * 100) / 100],
      ['Date range', dates.length ? (dates[0] + ' \u2192 ' + dates[dates.length - 1]) : '\u2014'],
      ['Modalities used', Object.keys(modSet).join(', ') || '\u2014'], [], ['Experiments by status']];
    Object.keys(statusCount).forEach((k) => ov.push([k, statusCount[k]]));
    addSheet('Overview', ov, [{ wch: 32 }, { wch: 40 }]);

    // 2) Experiments
    const eHdr = ['Experiment_ID', 'Experiment', 'Date', 'Scheduled', 'Status', 'Samples', 'Pools', 'Arms', 'Modalities', 'Est. cost ($)', 'Unsort lanes', 'ASAP lanes', 'Sort lanes'];
    const eRows = [eHdr];
    exps.forEach((e) => { const s = e.snapshot; const L = projLanes(s); eRows.push([e.experimentId || '', e.name, e.date || '', e.scheduledAt ? String(e.scheduledAt).slice(0, 10) : '', e.status || '', s.nSamples, s.nPools, (s.arms || []).join(', '), (s.modalities || []).join(', '), Math.round((s.knownTotal || 0) * 100) / 100, L.unsort, L.asap, L.sort]); });
    eRows.push([]); eRows.push(['TOTAL', '', '', '', '', totalSamples, '', '', '', Math.round(totalCost * 100) / 100]);
    addSheet('Experiments', eRows, [{ wch: 14 }, { wch: 24 }, { wch: 12 }, { wch: 11 }, { wch: 10 }, { wch: 8 }, { wch: 7 }, { wch: 18 }, { wch: 24 }, { wch: 13 }, { wch: 11 }, { wch: 10 }, { wch: 9 }]);

    // 3) Samples & pools (every sample across the project)
    const customSet = [];
    exps.forEach((e) => (e.snapshot.customCols || []).forEach((c) => { if (customSet.indexOf(c) === -1) customSet.push(c); }));
    const sHdr = ['Experiment_ID', 'Experiment', 'Sample ID', 'Patient ID', 'Lineage', 'Genetic pool', 'HTO', 'Loading super-pool'].concat(customSet);
    const sRows = [sHdr];
    exps.forEach((e) => (e.snapshot.batches || []).forEach((b) => b.samples.forEach((sm) => {
      sRows.push([e.experimentId || '', e.name, sm.sampleId, sm.patientId, sm.lineage, b.pool, b.hto, b.superPool].concat(customSet.map((c) => (sm.confounders && sm.confounders[c]) || '')));
    })));
    addSheet('Samples & pools', sRows, [{ wch: 14 }, { wch: 22 }, { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 16 }].concat(customSet.map(() => ({ wch: 14 }))));

    // 4) Cost by experiment
    const cHdr = ['Experiment_ID', 'Experiment', 'Date', 'Status', 'Samples', 'Pools', 'Est. cost ($)'];
    const cRows = [cHdr];
    exps.forEach((e) => cRows.push([e.experimentId || '', e.name, e.date || '', e.status || '', e.snapshot.nSamples, e.snapshot.nPools, Math.round((e.snapshot.knownTotal || 0) * 100) / 100]));
    cRows.push([]); cRows.push(['PROJECT TOTAL', '', '', '', '', '', Math.round(totalCost * 100) / 100]);
    addSheet('Cost by experiment', cRows, [{ wch: 14 }, { wch: 24 }, { wch: 12 }, { wch: 10 }, { wch: 9 }, { wch: 7 }, { wch: 14 }]);

    // 5) Reagent totals (merged across experiments)
    const merged = {};
    exps.forEach((e) => (e.snapshot.reagents || []).forEach((r) => {
      const key = (r.itemId || r.reagent) + '|' + (r.units || '');
      if (!merged[key]) merged[key] = { category: r.category, reagent: r.reagent, itemId: r.itemId || '', units: r.units || '', totalAmount: 0, cost: 0, priced: false, nExp: 0 };
      const m = merged[key];
      if (typeof r.totalAmount === 'number') m.totalAmount += r.totalAmount;
      if (r.total != null) { m.cost += r.total; m.priced = true; }
      m.nExp += 1;
    }));
    const rRows = [['Category', 'Reagent', 'Item ID', 'Total amount', 'Units', 'Est. cost ($)', '# experiments']];
    Object.keys(merged).sort((a, b) => (merged[a].category + merged[a].reagent).localeCompare(merged[b].category + merged[b].reagent)).forEach((k) => {
      const m = merged[k]; rRows.push([m.category, m.reagent, m.itemId, Math.round(m.totalAmount * 1000) / 1000, m.units, m.priced ? Math.round(m.cost * 100) / 100 : '', m.nExp]);
    });
    addSheet('Reagent totals', rRows, [{ wch: 24 }, { wch: 34 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 13 }, { wch: 13 }]);

    // 6) Libraries & cDNA generated
    const libRows = [['Experiment_ID', 'Experiment', 'Type', 'Modality', 'Count (lanes)']];
    exps.forEach((e) => { const s = e.snapshot; const L = projLanes(s); const v = projArmVdj(s);
      const add = (type, mod, n) => { if (n > 0) libRows.push([e.experimentId || '', e.name, type, mod, n]); };
      if (L.unsort) { add("5' GEX library", 'Unsort', L.unsort); add('CSP/ADT library', 'Unsort', L.unsort); if (v.unsort) { add('TCR library', 'Unsort', L.unsort); add('BCR library', 'Unsort', L.unsort); } add('cDNA \u2013 pellet', 'Unsort', L.unsort); add('cDNA \u2013 supernatant', 'Unsort', L.unsort); }
      if (L.asap) { add('ATAC library', 'ASAP', L.asap); add('ADT library', 'ASAP', L.asap); add('HTO library', 'ASAP', L.asap); add('cDNA \u2013 transposed', 'ASAP', L.asap); }
      if (L.sort) { add("5' GEX library", 'Sort', L.sort); add('CSP/ADT library', 'Sort', L.sort); if (v.sort) add('TCR library', 'Sort', L.sort); add('cDNA \u2013 pellet', 'Sort', L.sort); add('cDNA \u2013 supernatant', 'Sort', L.sort); }
    });
    addSheet('Libraries & cDNA', libRows, [{ wch: 14 }, { wch: 24 }, { wch: 22 }, { wch: 10 }, { wch: 13 }]);

    // 7) Scheduling
    const schHdr = ['Experiment_ID', 'Experiment', 'Planned date', 'Scheduled to calendar', 'Batch', 'Status'];
    const schRows = [schHdr];
    exps.forEach((e) => schRows.push([e.experimentId || '', e.name, e.date || '', e.scheduledAt ? String(e.scheduledAt).slice(0, 10) : '\u2014', e.batchRef ? ('batch ' + e.batchRef) : '\u2014', e.status || '']));
    addSheet('Scheduling', schRows, [{ wch: 14 }, { wch: 24 }, { wch: 13 }, { wch: 18 }, { wch: 10 }, { wch: 10 }]);

    // 8) Materials used (actual kit boxes deducted)
    const muRows = [['Experiment_ID', 'Experiment', 'Kit ID (box)', 'Rxns / indexes used', 'Recorded']];
    exps.forEach((e) => { const u = e.actualUsage; if (u && u.deducted) Object.keys(u.deducted).forEach((kit) => {
      const d = u.deducted[kit]; const amt = (typeof d === 'object' && d) ? ((d.rxns || 0) + (d.indexes || 0)) : d;
      if (amt) muRows.push([e.experimentId || '', e.name, kit, amt, u.recordedAt ? u.recordedAt.slice(0, 10) : '']);
    }); });
    if (muRows.length === 1) muRows.push(['\u2014', 'No material usage logged yet', '', '', '']);
    addSheet('Materials used', muRows, [{ wch: 14 }, { wch: 24 }, { wch: 16 }, { wch: 16 }, { wch: 12 }]);

    // 9) Per-modality lane / library rollup (across the whole project)
    const roll = { unsort: { lanes: 0, GEX: 0, ADT: 0, TCR: 0, BCR: 0, cDNA: 0 }, asap: { lanes: 0, ATAC: 0, ADT: 0, HTO: 0, cDNA: 0 }, sort: { lanes: 0, GEX: 0, ADT: 0, TCR: 0, cDNA: 0 } };
    exps.forEach((e) => { const L = projLanes(e.snapshot); const v = projArmVdj(e.snapshot);
      roll.unsort.lanes += L.unsort; roll.unsort.GEX += L.unsort; roll.unsort.ADT += L.unsort; if (v.unsort) { roll.unsort.TCR += L.unsort; roll.unsort.BCR += L.unsort; } roll.unsort.cDNA += L.unsort * 2;
      roll.asap.lanes += L.asap; roll.asap.ATAC += L.asap; roll.asap.ADT += L.asap; roll.asap.HTO += L.asap; roll.asap.cDNA += L.asap;
      roll.sort.lanes += L.sort; roll.sort.GEX += L.sort; roll.sort.ADT += L.sort; if (v.sort) roll.sort.TCR += L.sort; roll.sort.cDNA += L.sort * 2;
    });
    const rollRows = [['Modality', 'Total lanes', 'GEX libs', 'CSP/ADT libs', 'ATAC libs', 'HTO libs', 'TCR libs', 'BCR libs', 'cDNA tubes'],
      ["Unsort 5'", roll.unsort.lanes, roll.unsort.GEX, roll.unsort.ADT, '', '', roll.unsort.TCR, roll.unsort.BCR, roll.unsort.cDNA],
      ['ASAP', roll.asap.lanes, '', roll.asap.ADT, roll.asap.ATAC, roll.asap.HTO, '', '', roll.asap.cDNA],
      ["Sort 5'", roll.sort.lanes, roll.sort.GEX, roll.sort.ADT, '', '', roll.sort.TCR, '', roll.sort.cDNA]];
    const totLibs = roll.unsort.GEX + roll.unsort.ADT + roll.unsort.TCR + roll.unsort.BCR + roll.asap.ATAC + roll.asap.ADT + roll.asap.HTO + roll.sort.GEX + roll.sort.ADT + roll.sort.TCR;
    rollRows.push([]); rollRows.push(['TOTAL lanes', roll.unsort.lanes + roll.asap.lanes + roll.sort.lanes, 'TOTAL libraries', totLibs]);
    addSheet('Modality rollup', rollRows, [{ wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 13 }, { wch: 11 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 11 }]);

    // 10) Consolidated index usage (which index kits/wells the project consumes)
    const idxAgg = {}; const order = [];
    const addIdx = (type, cat, n) => { if (n <= 0) return; if (!idxAgg[type]) { idxAgg[type] = { cat: cat, count: 0 }; order.push(type); } idxAgg[type].count += n; };
    exps.forEach((e) => { const L = projLanes(e.snapshot); const v = projArmVdj(e.snapshot);
      addIdx('Dual Index TT Set A \u2014 GEX', '1000215', L.unsort + L.sort);
      addIdx('Dual Index TN Set A \u2014 CSP/ADT', '1000250', L.unsort + L.sort);
      if (v.unsort) addIdx('Dual Index TT Set A \u2014 V(D)J', '1000215', L.unsort * 2);
      if (v.sort) addIdx('Dual Index TT Set A \u2014 V(D)J', '1000215', L.sort);
      addIdx('Single Index N Set A \u2014 ATAC', '1000212', L.asap);
      addIdx('RPI oligos \u2014 ASAP ADT', 'OL016\u2013031', L.asap);
      addIdx('D7xx oligos \u2014 ASAP HTO', 'OL004\u2013015', L.asap);
    });
    const idxRows = [['Index type (kit)', 'Catalog #', 'Indexes / wells needed (planned)']];
    order.forEach((t) => idxRows.push([t, idxAgg[t].cat, idxAgg[t].count]));
    if (order.length === 0) idxRows.push(['\u2014 no indexed libraries yet \u2014', '', '']);
    addSheet('Index usage', idxRows, [{ wch: 34 }, { wch: 14 }, { wch: 30 }]);

    // 11) Project timeline (experiments in date order)
    const dated = exps.filter((e) => e.date).slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const undated = exps.filter((e) => !e.date);
    const tlRows = [['Date', 'Experiment_ID', 'Experiment', 'Status', 'Samples', 'Modalities', 'Scheduled to calendar']];
    dated.forEach((e) => tlRows.push([e.date, e.experimentId || '', e.name, e.status || '', e.snapshot.nSamples, (e.snapshot.modalities || []).join(', '), e.scheduledAt ? String(e.scheduledAt).slice(0, 10) : '']));
    undated.forEach((e) => tlRows.push(['(no date set)', e.experimentId || '', e.name, e.status || '', e.snapshot.nSamples, (e.snapshot.modalities || []).join(', '), '']));
    addSheet('Timeline', tlRows, [{ wch: 13 }, { wch: 14 }, { wch: 24 }, { wch: 10 }, { wch: 8 }, { wch: 26 }, { wch: 18 }]);

    return wb;
  }

  function downloadProjectSummary(project) {
    if (!withSnapshotExps(project).length) { alert('No saved experiments with computed plans in this project yet.'); return; }
    XLSX.writeFile(buildProjectWb(project), 'project_' + projectLabel(project) + '_summary.xlsx');
  }

  async function exportProjectSummaryToDrive(project) {
    if (!withSnapshotExps(project).length) { alert('No saved experiments with computed plans in this project yet.'); return; }
    if (!confirm('This will save the Project summary to Drive, OVERWRITING the current copy in the project folder. Continue?')) return;
    try {
      const path = await driveApi({ action: 'ensurePath', project: project });
      if (!path || !path.projectId) { alert('Could not reach the project\u2019s Drive folder.'); return; }
      const res = await driveApi({ action: 'upload', name: 'Project summary', folderId: path.projectId,
        base64: wbBase64(buildProjectWb(project)), sourceMime: XLSX_MIME, targetMime: GSHEET_MIME });
      if (res && res.id) { const pr = Store.allProjects().find((p) => p.name === project); if (pr) { pr.projectSummaryFileId = res.id; Store.saveProject(pr); } alert('Project summary saved to the project\u2019s Drive folder.'); renderManage(); }
      else alert('Upload failed: ' + JSON.stringify(res));
    } catch (e) { alert('Project summary export failed: ' + e); }
  }

  // ---- per-experiment workbook (pooling + reagents + pricing + summary) ------
  // ---- Drive export ---------------------------------------------------------
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const GSHEET_MIME = 'application/vnd.google-apps.spreadsheet';
  const HTML_MIME = 'text/html';
  const GDOC_MIME = 'application/vnd.google-apps.document';

  function wbBase64(wb) { return XLSX.write(wb, { bookType: 'xlsx', type: 'base64' }); }
  function htmlBase64(html) { return btoa(unescape(encodeURIComponent(html))); }
  // Google Docs conversion ignores CSS classes/stylesheets and only honours inline
  // styles, so inject an inline colored bar (a shaded 1-cell table, which converts
  // reliably) + a tinted header at the top of each protocol section for the Doc.
  function inlineProtocolColors(html) {
    // Google Docs' HTML importer discards most class-based CSS. Build a clean
    // inline-styled copy instead so the Drive document keeps the same visual
    // hierarchy as the on-screen/Word packet without touching protocol text.
    const accent = { blue: '#4472C4', green: '#70AD47', purple: '#7030A0', orange: '#ED7D31', yellow: '#F6B000', pink: '#CE46BE', slate: '#64748B' };
    const tint = { blue: '#CDE9F3', green: '#E2EFD9', purple: '#DDC8FF', orange: '#FBE4D5', yellow: '#FFF2CC', pink: '#F4D7EE', slate: '#EEF1F5' };
    const root = document.createElement('div');
    root.innerHTML = html;
    const css = (el, rules) => {
      if (!el) return;
      const prev = el.getAttribute('style');
      el.setAttribute('style', (prev ? prev.replace(/;?\s*$/, ';') : '') + rules);
    };

    const pages = Array.from(root.querySelectorAll('.protocol-page'));
    pages.forEach((page, pi) => {
      const cls = Array.from(page.classList).find((c) => /^pp-(blue|green|purple|orange|yellow|pink|slate)$/.test(c));
      const color = cls ? cls.slice(3) : (page.classList.contains('cover') ? 'slate' : 'blue');
      const ac = accent[color] || accent.slate, ti = tint[color] || tint.slate;
      css(page, 'font-family:Arial,Calibri,sans-serif;font-size:10.5pt;line-height:1.35;color:#1F2B3A;margin:0;padding:0;');
      if (pi > 0) {
        // Keep the page break as its own block before the section. This mirrors
        // the original export approach and is more reliably honored by the
        // Drive HTML->Docs converter than a break attached to a table/article.
        const pageBreak = document.createElement('div');
        pageBreak.innerHTML = '&nbsp;';
        pageBreak.setAttribute('style', 'page-break-before:always;break-before:page;height:0;line-height:0;font-size:1pt;margin:0;padding:0;');
        page.parentNode.insertBefore(pageBreak, page);
      }

      // A one-cell table survives Google Docs conversion much more reliably than
      // CSS borders and gives every modality a physical-page navigation bar.
      const bar = document.createElement('table');
      bar.className = 'sop-color-bar';
      bar.setAttribute('style', 'width:100%;border-collapse:collapse;margin:0 0 5pt 0;');
      const br = bar.insertRow(); const bc = br.insertCell();
      bc.innerHTML = '&nbsp;';
      bc.setAttribute('style', 'background-color:' + ac + ';height:10pt;line-height:10pt;font-size:1pt;border:0;padding:0;');
      page.insertBefore(bar, page.firstChild);

      // Use another one-cell table for the tinted section header: table-cell
      // shading is retained by the Drive HTML->Docs converter.
      const head = page.querySelector('.pp-head');
      if (head) {
        const ht = document.createElement('table'); ht.className = 'sop-head-table';
        ht.setAttribute('style', 'width:100%;border-collapse:collapse;margin:0 0 9pt 0;');
        const hr = ht.insertRow(); const hc = hr.insertCell();
        hc.setAttribute('style', 'background-color:' + ti + ';border:0;border-bottom:2pt solid ' + ac + ';padding:7pt 9pt;vertical-align:middle;');
        while (head.firstChild) hc.appendChild(head.firstChild);
        head.parentNode.replaceChild(ht, head);
        const no = hc.querySelector('.pp-no');
        css(no, 'display:block;color:' + ac + ';font-weight:bold;font-size:9pt;margin:0 0 2pt 0;');
        const h2 = hc.querySelector('h2');
        css(h2, 'font-family:Arial,Calibri,sans-serif;font-size:16pt;line-height:1.18;color:#1F2B3A;font-weight:bold;margin:0;');
      }

      page.querySelectorAll('h3').forEach((el) => css(el, 'font-size:13pt;color:#2F5C8F;margin:9pt 0 4pt;font-weight:bold;'));
      page.querySelectorAll('h4').forEach((el) => css(el, 'font-size:11.5pt;color:#2F5C8F;margin:8pt 0 3pt;font-weight:bold;'));
      page.querySelectorAll('h5').forEach((el) => css(el, 'font-size:10.5pt;color:#2F5C8F;margin:6pt 0 3pt;font-weight:bold;'));
      page.querySelectorAll('p').forEach((el) => css(el, 'margin:4pt 0;line-height:1.4;'));
      page.querySelectorAll('ol,ul').forEach((el) => css(el, 'margin:4pt 0 8pt 18pt;padding-left:10pt;'));
      page.querySelectorAll('li').forEach((el) => css(el, 'margin:3pt 0;line-height:1.38;'));
      page.querySelectorAll('.pp-meta').forEach((el) => css(el, 'background-color:#F2F2F2;border:1px solid #D9DEE5;padding:5pt 7pt;color:#5A6570;font-size:9pt;margin:0 0 9pt 0;'));
      page.querySelectorAll('.pp-source,.who,.muted').forEach((el) => css(el, 'color:#5A6570;font-size:9pt;'));
      page.querySelectorAll('.recipe-box').forEach((el) => css(el, 'background-color:#FAFCFF;border:1px solid #D9E2F3;border-left:4px solid ' + ac + ';padding:7pt 9pt;margin:8pt 0;'));
      page.querySelectorAll('.sop-tip').forEach((el) => css(el, 'background-color:#FFF7E6;border:1px solid #F3D891;border-left:4px solid #EDB000;padding:7pt 9pt;margin:8pt 0;color:#5F4A18;'));
      page.querySelectorAll('.flow-holder,svg,img').forEach((el) => css(el, 'max-width:100%;'));

      page.querySelectorAll('table:not(.sop-color-bar):not(.sop-head-table)').forEach((tbl) => {
        css(tbl, 'width:100%;border-collapse:collapse;margin:6pt 0 9pt;');
        tbl.querySelectorAll('th').forEach((th) => css(th, 'background-color:#F2F2F2;border:1px solid #B7C0CC;padding:5pt 6pt;text-align:left;vertical-align:middle;font-size:9.5pt;font-weight:bold;'));
        tbl.querySelectorAll('td').forEach((td) => css(td, 'border:1px solid #B7C0CC;padding:5pt 6pt;text-align:left;vertical-align:top;font-size:9.5pt;'));
        tbl.querySelectorAll('.num').forEach((td) => css(td, 'text-align:right;white-space:nowrap;'));
      });

      // Browser checkboxes do not survive HTML->Google Docs consistently; a
      // printed ballot box preserves the checklist without altering any wording.
      page.querySelectorAll('input.stepchk').forEach((cb) => {
        const box = document.createElement('span'); box.textContent = '\u2610\u00a0\u00a0';
        css(box, 'font-family:Arial,sans-serif;'); cb.parentNode.replaceChild(box, cb);
      });
    });
    return root.innerHTML;
  }

  function driveApi(payload) {
    return fetch('/api/drive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then((r) => r.json());
  }

  // Auto-export a built experiment's artifacts to its Drive folder as native
  // Google files. Fire-and-forget from the build; logs but never blocks the UI.
  async function exportExperimentToDrive(rec, opts) {
    try {
      if (!rec || !rec.snapshot) return;
      const project = rec.project || 'Unfiled';
      const path = await driveApi({ action: 'ensurePath', project: project, experiment: rec.name || 'Experiment' });
      if (!path || !path.ok || !path.experimentId) { console.warn('[drive] ensurePath failed', path); return; }
      if (rec.driveFolderId !== path.experimentId) {
        rec.driveFolderId = path.experimentId; rec.driveProjectId = path.projectId; Store.saveExperiment(rec);
      }
      // Building updates the working version in place; an explicit regenerate/export
      // (opts.newVersion) creates a new, preserved version. First-ever export = v1.
      const expId = (rec.experimentId || projectLabel(rec.name || 'experiment'));
      rec.materialVersions = rec.materialVersions || [];
      const makeNew = (opts && opts.newVersion) || !rec.materialVersions.length;
      let version, vFolderId, folderName;
      if (makeNew) {
        version = rec.materialVersions.length + 1;
        folderName = sanitizeName(expId + '_v' + version);
        const vpath = await driveApi({ action: 'ensurePath', parentId: path.experimentId, subPath: [folderName] });
        vFolderId = (vpath && vpath.subId) || path.experimentId;
      } else {
        const cur = rec.materialVersions[rec.materialVersions.length - 1];
        version = cur.version; vFolderId = cur.folderId; folderName = cur.folder;
      }
      const pfx = expId + '_v' + version + ' ';   // versioned file-name prefix
      const files = {};
      // Experiment summary (Summary + Pooling + Reagents + Pricing) -> Google Sheet
      const sumRes = await driveApi({ action: 'upload', name: pfx + 'Experiment summary', folderId: vFolderId,
        base64: wbBase64(buildExperimentWb(rec)), sourceMime: XLSX_MIME, targetMime: GSHEET_MIME });
      files.summary = (sumRes && sumRes.id) || null;
      // Protocol packet (rendered HTML) -> Google Doc
      let protoRes = null;
      const protoEl = document.getElementById('protocolsContent');
      if (protoEl && protoEl.innerHTML.trim()) {
        // Export only the packet pages themselves (not the website buttons/help text).
        // This is presentation-only filtering; all protocol wording/numbers remain intact.
        const pageHtml = Array.from(protoEl.querySelectorAll('.protocol-page')).map((el) => el.outerHTML).join('');
        if (pageHtml.trim()) {
          const html = '<html><head><meta charset="utf-8"></head><body style="margin:0.55in 0.65in;font-family:Arial,Calibri,sans-serif;">' + inlineProtocolColors(pageHtml) + '</body></html>';
          protoRes = await driveApi({ action: 'upload', name: pfx + 'Protocol', folderId: vFolderId,
            base64: htmlBase64(html), sourceMime: HTML_MIME, targetMime: GDOC_MIME });
        }
      }
      files.protocol = (protoRes && protoRes.id) || null;
      // Tube labels + Library record -> Google Sheets
      const labelsBuilt = buildTubeLabelsWb();
      if (labelsBuilt) {
        const labRes = await driveApi({ action: 'upload', name: pfx + 'Tube labels', folderId: vFolderId,
          base64: wbBase64(labelsBuilt.wb), sourceMime: XLSX_MIME, targetMime: GSHEET_MIME });
        if (labRes && labRes.id) files.labels = labRes.id;
      }
      const libBuilt = buildLibraryRecordWb();
      if (libBuilt) {
        const libRes = await driveApi({ action: 'upload', name: pfx + 'Library record', folderId: vFolderId,
          base64: wbBase64(libBuilt.wb), sourceMime: XLSX_MIME, targetMime: GSHEET_MIME });
        if (libRes && libRes.id) files.library = libRes.id;
      }
      // record (or update) the version; the most recent is the active one
      const entry = { version: version, folder: folderName, folderId: vFolderId, createdAt: new Date().toISOString().slice(0, 16).replace('T', ' '), files: files };
      if (makeNew) rec.materialVersions.push(entry); else rec.materialVersions[rec.materialVersions.length - 1] = entry;
      rec.currentVersion = version;
      rec.driveFiles = Object.assign({}, files);
      Store.saveExperiment(rec);
      console.log('[drive] exported v' + version, project + '/' + (rec.name || 'Experiment'));
    } catch (e) { console.warn('[drive] export error', e); }
  }

  // Write each item's reserved-across-experiments total into the inventory
  // sheet's "Reserved (experiments)" column (drives the Stock-check colouring).
  // Debounced so a burst of changes results in one write.
  let _reservedTimer = null;
  function pushReservedToSheet() {
    clearTimeout(_reservedTimer);
    _reservedTimer = setTimeout(() => {
      try {
        const st = computeInventoryState();
        const map = {};
        (st.items || []).forEach((i) => { map[i.id] = Math.round((i.reserved || 0) * 1000) / 1000; });
        fetch('/api/inventory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'setReserved', reserved: map }) })
          .then((r) => { if (!r.ok) console.warn('[inventory] reserved write-back', r.status); })
          .catch((e) => console.warn('[inventory] reserved write-back error', e));
      } catch (e) { console.warn('[inventory] reserved compute error', e); }
    }, 400);
  }

  function experimentWorkbookXlsx(id) {
    const rec = Store.getExperiment(id);
    if (!rec || !rec.snapshot) { alert('Open this experiment and Save it after building the plan, then export.'); return; }
    XLSX.writeFile(buildExperimentWb(rec), 'experiment_' + projectLabel(rec.name) + '.xlsx');
  }
  function buildExperimentWb(rec) {
    const s = rec.snapshot;
    const wb = XLSX.utils.book_new();

    const summary = [
      ['Experiment', rec.name], ['Project', rec.project || ''], ['Date', rec.date || ''], ['Planned by', rec.plannedBy || ''], ['Status', rec.status || ''],
      [], ['Samples', s.nSamples], ['Genetic pools', s.nPools], ['Modalities', (s.modalities || []).join(', ')],
      ['Arms', (s.arms || []).join(', ')], ['Estimated total ($)', s.knownTotal != null ? Math.round(s.knownTotal * 100) / 100 : '']
    ];
    if ((s.warnings || []).length) { summary.push([]); summary.push(['Notes']); s.warnings.forEach((w) => summary.push(['', w])); }
    const wsS = XLSX.utils.aoa_to_sheet(summary); wsS['!cols'] = [{ wch: 20 }, { wch: 70 }];
    XLSX.utils.book_append_sheet(wb, wsS, 'Summary');

    const cc = s.customCols || [];
    const pHeader = ['Sample ID', 'Patient ID', 'Lineage'].concat(cc, ['Genetic Pool', 'HTO', 'Loading Super-Pool']);
    const pRows = [pHeader];
    (s.batches || []).forEach((b) => b.samples.forEach((sm) => {
      pRows.push([sm.sampleId, sm.patientId, sm.lineage].concat(cc.map((c) => (sm.confounders && sm.confounders[c]) || ''), [b.pool, b.hto, b.superPool]));
    }));
    const wsP = XLSX.utils.aoa_to_sheet(pRows);
    XLSX.utils.book_append_sheet(wb, wsP, 'Pooling');

    const rHeader = ['Category', 'Reagent', 'Item ID', 'Total amount', 'Units', 'Order quantity', 'Scope', 'Est. cost ($)', 'Notes'];
    const rRows = [rHeader];
    (s.reagents || []).forEach((r) => rRows.push([r.category, r.reagent, r.itemId, r.totalAmount, r.units,
      r.quantity != null ? (r.quantity + ' ' + (r.quantityUnit || '')) : '', r.scope, r.total == null ? '' : r.total, r.note || '']));
    const wsR = XLSX.utils.aoa_to_sheet(rRows); wsR['!cols'] = [{ wch: 24 }, { wch: 32 }, { wch: 9 }, { wch: 12 }, { wch: 14 }, { wch: 22 }, { wch: 20 }, { wch: 12 }, { wch: 50 }];
    XLSX.utils.book_append_sheet(wb, wsR, 'Reagents');

    const priceHeader = ['Category', 'Item', 'Item ID', 'Qty / amount', 'Unit', 'Unit cost ($)', 'Total ($)'];
    const priceRows = [priceHeader];
    (s.lineItems || []).forEach((li) => priceRows.push([li.category, li.label, li.itemId,
      li.isReagent ? li.totalAmount : li.qty, li.isReagent ? li.units : li.unit, li.unitCost == null ? '' : li.unitCost, li.total == null ? '' : li.total]));
    priceRows.push([]); priceRows.push(['', '', '', '', '', 'TOTAL', s.knownTotal != null ? Math.round(s.knownTotal * 100) / 100 : '']);
    const wsC = XLSX.utils.aoa_to_sheet(priceRows); wsC['!cols'] = [{ wch: 24 }, { wch: 34 }, { wch: 9 }, { wch: 13 }, { wch: 12 }, { wch: 13 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, wsC, 'Pricing');

    // ---- lanes per arm from the snapshot -----------------------------------
    const lanes = { unsort: 0, asap: 0, sort: 0 };
    (s.laneBreakdown || []).forEach((l) => {
      if (l.chem === 'asap') lanes.asap += (l.lanes || 0);
      else if (l.population === 'sorted') lanes.sort += (l.lanes || 0);
      else if (l.population === 'unsorted' && l.laneChem === "5'") lanes.unsort += (l.lanes || 0);
    });
    const armVdj = {};
    (s.laneBreakdown || []).forEach((l) => { if (l.vdj) { if (l.population === 'sorted') armVdj.sort = true; else if (l.chem !== 'asap') armVdj.unsort = true; } });

    // ---- Samples tab (storage metadata + pool assignment) ------------------
    const sampHeader = ['Sample #', 'Sample ID (for experiment)', 'Pool (assigned)', 'Room', 'Freezer', 'Rack', 'Box', 'Position', 'Donor ID', 'Type', 'Source', 'Collection Date', 'Isolation Date', 'Vol (ml)', 'Lineage'].concat(cc);
    const sampRows = [['How to use: metadata about each sample + storage details, for retrieving samples on batch day.'], [], sampHeader];
    let sIx = 0;
    (s.batches || []).forEach((b) => b.samples.forEach((sm) => {
      sIx += 1;
      sampRows.push([sIx, sm.sampleId, b.pool, '', '', '', '', '', sm.patientId || '', '', '', '', '', '', sm.lineage || ''].concat(cc.map((c) => (sm.confounders && sm.confounders[c]) || '')));
    }));
    const wsSamp = XLSX.utils.aoa_to_sheet(sampRows);
    wsSamp['!cols'] = [{ wch: 8 }, { wch: 24 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 22 }, { wch: 8 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 8 }, { wch: 12 }].concat(cc.map(() => ({ wch: 14 })));
    XLSX.utils.book_append_sheet(wb, wsSamp, 'Samples');

    // ---- Cell count tab (grouped by pool; live formulas) -------------------
    // Layout: A = merged "Pool n" label, B = Sample #, C = Original ID, D = Sample ID,
    // E = Thawer, F = Pool, G = Live %, H = Live Cells/mL, I = Vol. dilute, J = Total
    // viable (=H*I), K = Cells pooled (=$I$8), L = Pool volume, M/N = unsort cells/vol,
    // O/P = ASAP cells/vol, Q = sort leftover. Design inputs live at I8/I9/I10.
    const poolMap = {};
    (s.batches || []).forEach((b) => { (poolMap[b.pool] = poolMap[b.pool] || []).push.apply(poolMap[b.pool], b.samples); });
    const poolKeys = Object.keys(poolMap);
    const spp = poolKeys.length ? Math.round(s.nSamples / poolKeys.length) : 0;
    const hasUnsortArm = lanes.unsort > 0, hasAsapArm = lanes.asap > 0, hasSortArm = lanes.sort > 0;
    const cpsDefault = s.poolContributionPerSample != null ? s.poolContributionPerSample : (s.cellsPerSample != null ? s.cellsPerSample : 1500000);
    const unsDefault = s.unsortAmt != null ? s.unsortAmt : 1200000;
    const asaDefault = s.asapAmt != null ? s.asapAmt : 1200000;
    const CPS = '$I$8', UNS = '$I$9', ASA = '$I$10';   // design-input cells (fixed positions)
    const cc2 = []; const merges = [];
    // rows 1-3: how-to + notes (B column; label merged B:H)
    cc2.push(['', 'How to use this sheet:']);
    cc2.push(['', 'Fill the bolded DESIGN INPUTS below. On batch day, enter Live %, Live Cells/mL, and the dilution volume for each sample \u2014 pooling and aliquot volumes autofill. Sort input is whatever is left in each pool after the unsort/ASAP aliquots are removed.']);
    cc2.push(['', 'Yellow cells are for you to fill in; each sample\u2019s original-ID cell is colour-coded, and pool header/total rows are shaded.']);
    cc2.push([]);
    // row 5: counts (B/C, E/F, H/I)
    cc2.push(['', '# samples', s.nSamples, '', '# pools', poolKeys.length, '', '# samples / pool', spp]);
    cc2.push([]);
    // row 7: design-inputs header (B:H); rows 8-10: labels in B (merged B:H), values in I
    cc2.push(['', 'DESIGN INPUTS (prefilled from the planner \u2014 edit if needed):']);
    cc2.push(['', 'Cells pooled per sample', '', '', '', '', '', '', cpsDefault]);
    cc2.push(['', 'Cells aliquoted from pool for unsort 5\u2032 (CITE-seq)', '', '', '', '', '', '', unsDefault]);
    cc2.push(['', 'Cells aliquoted from pool for ASAP-seq', '', '', '', '', '', '', asaDefault]);
    merges.push({ s: { r: 1, c: 1 }, e: { r: 1, c: 7 } }, { s: { r: 2, c: 1 }, e: { r: 2, c: 7 } }, { s: { r: 6, c: 1 }, e: { r: 6, c: 7 } }, { s: { r: 7, c: 1 }, e: { r: 7, c: 7 } }, { s: { r: 8, c: 1 }, e: { r: 8, c: 7 } }, { s: { r: 9, c: 1 }, e: { r: 9, c: 7 } });
    cc2.push([]); cc2.push([]); cc2.push([]);   // rows 11,12,13
    // row 14: single header row
    const hdr = ['Pool', 'Sample #', 'Original ID (cryovial)', 'Sample ID', 'Thawer', 'Pool', 'Live %', 'Live Cells/mL', 'Vol. dilute for count (mL)', 'Total viable cells', 'Cells pooled', 'Pool volume (uL)', 'Cells for unsort', 'Vol for unsort (uL)', 'Cells for ASAP', 'Vol for ASAP (uL)', 'Cells to sort (leftover)'];
    cc2.push(hdr.slice());
    const noMap = (function () { try { return sampleNoMap().byId; } catch (e) { return {}; } })();
    let nC = 0;
    poolKeys.forEach((pk) => {
      const dataRows = [];
      const startIdx = cc2.length;                 // 0-based index of first sample row
      poolMap[pk].forEach((sm) => {
        nC += 1; const r = cc2.length + 1;          // 1-based sheet row
        const sNo = (noMap[sm.sampleId] != null) ? noMap[sm.sampleId] : nC;
        dataRows.push(r);
        cc2.push([dataRows.length === 1 ? ('Pool ' + pk) : '', sNo, sm.patientId || '', sm.sampleId, '', pk, '', '', '',
          { t: 'n', f: 'H' + r + '*I' + r },        // J: total viable = Live Cells/mL * Vol dilute
          { t: 'n', f: CPS },                        // K: cells pooled = $I$8
          { t: 'n', f: 'K' + r + '/H' + r + '*1000' }, // L: pool volume = cells pooled / (cells/mL) * 1000
          '', '', '', '', '']);
      });
      const totRow = cc2.length + 1;
      // fill per-sample modality cells now that we know the pool total row
      dataRows.forEach((r) => {
        const row = cc2[r - 1];
        if (hasUnsortArm) row[12] = { t: 'n', f: UNS + '*($K' + r + '/$K$' + totRow + ')' }; // M
        if (hasAsapArm) row[14] = { t: 'n', f: ASA + '*($K' + r + '/$K$' + totRow + ')' };   // O
      });
      if (dataRows.length > 1) merges.push({ s: { r: startIdx, c: 0 }, e: { r: startIdx + dataRows.length - 1, c: 0 } });
      const firstR = dataRows[0], lastR = dataRows[dataRows.length - 1];
      const tot = ['', '', '', '', '', 'POOL ' + pk + ' TOTAL', '', '', '',
        { t: 'n', f: 'SUM(J' + firstR + ':J' + lastR + ')' },
        { t: 'n', f: 'SUM(K' + firstR + ':K' + lastR + ')' },
        { t: 'n', f: 'SUM(L' + firstR + ':L' + lastR + ')' },
        hasUnsortArm ? { t: 'n', f: 'SUM(M' + firstR + ':M' + lastR + ')' } : '',
        hasUnsortArm ? { t: 'n', f: '(M' + totRow + '/K' + totRow + ')*L' + totRow } : '',
        hasAsapArm ? { t: 'n', f: 'SUM(O' + firstR + ':O' + lastR + ')' } : '',
        hasAsapArm ? { t: 'n', f: '(O' + totRow + '/K' + totRow + ')*L' + totRow } : '',
        hasSortArm ? { t: 'n', f: 'K' + totRow + (hasUnsortArm ? '-M' + totRow : '') + (hasAsapArm ? '-O' + totRow : '') } : ''];
      cc2.push(tot);
    });
    const wsCC = XLSX.utils.aoa_to_sheet(cc2);
    wsCC['!merges'] = merges;
    wsCC['!cols'] = [{ wch: 9 }, { wch: 8 }, { wch: 22 }, { wch: 20 }, { wch: 8 }, { wch: 6 }, { wch: 8 }, { wch: 13 }, { wch: 16 }, { wch: 14 }, { wch: 12 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, wsCC, 'Cell count');

    // ---- Counts tab (Cellaca readouts entered on Record -> Cellaca counts) ----
    const cellList = (rec && rec.cellacaCountsList) || [];
    const ctRows = [['How to use: populated from the Cellaca WellLevel files uploaded on Record \u2192 Cellaca counts.'], [],
      ['Sample #', 'Sample ID', 'Tube label', 'Well', 'Count for', 'Thawer', 'Live (cells/mL)', 'Viability (%)', 'Total (cells/mL)', 'Notes']];
    const _ctNoMap = (function () { try { return sampleNoMap().byId; } catch (e) { return {}; } })();
    const _ctNo = (c) => (c.sampleId && _ctNoMap[c.sampleId] != null) ? _ctNoMap[c.sampleId] : (c.sampleNo != null ? c.sampleNo : '');
    cellList.slice().sort((a, b) => (Number(_ctNo(a)) || 0) - (Number(_ctNo(b)) || 0) || String(a.purpose || '').localeCompare(String(b.purpose || '')))
      .forEach((c) => ctRows.push([_ctNo(c), c.sampleId || '', c.tubeLabel || '', c.well || '', c.purpose || '', c.thawer || '', c.live != null ? c.live : '', c.viability != null ? c.viability : '', c.total != null ? c.total : '', c.notes || '']));
    const wsCT = XLSX.utils.aoa_to_sheet(ctRows);
    wsCT['!cols'] = [{ wch: 9 }, { wch: 20 }, { wch: 12 }, { wch: 7 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 13 }, { wch: 16 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, wsCT, 'Counts');

    // ---- 10X Library Tubes tab (naming grid, per reference) ----------------
    const lt = [['10X Chip Output Tube Strips: for GEM-RT Incubation + storage'], ['indicate how you are labeling your tube strip'], ['Modality Source', 1, 2, 3, 4, 5, 6, 7, 8]];
    const laneRow = (label, names) => { const r = [label]; for (let i = 0; i < 8; i++) r.push(names[i] || ''); lt.push(r); };
    for (let c = 0; c < Math.ceil(lanes.unsort / 8 || 0); c++) { const names = []; for (let i = 0; i < 8 && c * 8 + i < lanes.unsort; i++) names.push('U' + (c * 8 + i + 1)); laneRow("unsort 5' chip " + (c + 1), names); }
    for (let c = 0; c < Math.ceil(lanes.asap / 8 || 0); c++) { const names = []; for (let i = 0; i < 8 && c * 8 + i < lanes.asap; i++) names.push('A' + (c * 8 + i + 1)); laneRow('asap chip ' + (c + 1), names); }
    for (let c = 0; c < Math.ceil(lanes.sort / 8 || 0); c++) { const names = []; for (let i = 0; i < 8 && c * 8 + i < lanes.sort; i++) names.push('S' + (c * 8 + i + 1)); laneRow("sort 5' chip " + (c + 1), names); }
    lt.push([]); lt.push(['cDNA Tube Strips']); lt.push(['indicate how you are labeling your tube strip']); lt.push(['Modality Source', 1, 2, 3, 4, 5, 6, 7, 8, 'Note']);
    const cdnaRow = (label, names, note) => { const r = [label]; for (let i = 0; i < 8; i++) r.push(names[i] || ''); r.push(note || ''); lt.push(r); };
    for (let c = 0; c < Math.ceil(lanes.unsort / 8 || 0); c++) {
      const pp = [], sp = []; for (let i = 0; i < 8 && c * 8 + i < lanes.unsort; i++) { pp.push('U' + (c * 8 + i + 1) + '-P'); sp.push('U' + (c * 8 + i + 1) + '-S'); }
      cdnaRow("unsort 5' chip " + (c + 1), pp, 'cDNA from pellet --> GEX' + (armVdj.unsort ? '/VDJ' : '') + ' libraries');
      cdnaRow("unsort 5' chip " + (c + 1), sp, 'cDNA from supernatent --> CSP libraries');
    }
    for (let c = 0; c < Math.ceil(lanes.asap / 8 || 0); c++) { const names = []; for (let i = 0; i < 8 && c * 8 + i < lanes.asap; i++) names.push('A' + (c * 8 + i + 1)); cdnaRow('asap chip ' + (c + 1), names, ''); }
    for (let c = 0; c < Math.ceil(lanes.sort / 8 || 0); c++) {
      const pp = [], sp = []; for (let i = 0; i < 8 && c * 8 + i < lanes.sort; i++) { pp.push('S' + (c * 8 + i + 1) + '-P'); sp.push('S' + (c * 8 + i + 1) + '-S'); }
      cdnaRow("sort 5' chip " + (c + 1), pp, 'cDNA from pellet --> GEX' + (armVdj.sort ? '/VDJ' : '') + ' libraries');
      cdnaRow("sort 5' chip " + (c + 1), sp, 'cDNA from supernatent --> CSP libraries');
    }
    const wsLT = XLSX.utils.aoa_to_sheet(lt);
    wsLT['!cols'] = [{ wch: 20 }].concat(Array.from({ length: 8 }, () => ({ wch: 8 })), [{ wch: 42 }]);
    XLSX.utils.book_append_sheet(wb, wsLT, '10X Library Tubes');

    // ---- 10X Chip Layout (8-lane grid coloured like a real chip) -----------
    const cl = [['How to use this sheet:'], ['Well rows are coloured like the physical 10X chip. Fill the Tube row with the pool/super-pool loaded per lane, then print.'], []];
    const chipDiagram = (title, kit, kitDoc, chipDesc, wells, count, perChip, namer) => {
      for (let c = 0; c < Math.ceil(count / perChip || 0); c++) {
        cl.push([title]); cl.push(['Loader', '']); cl.push(['Kit', kit, kitDoc]); cl.push(['Chip', chipDesc]);
        const laneRow = ['Lane']; for (let i = 0; i < perChip; i++) laneRow.push(i + 1); laneRow.push('unused: 50% glycerol'); cl.push(laneRow);
        const tubeRow = ['Tube']; for (let i = 0; i < perChip; i++) { const g = c * perChip + i; tubeRow.push(g < count ? namer(g) : ''); } cl.push(tubeRow);
        wells.forEach((w) => { const row = [w[0]]; for (let i = 0; i < perChip; i++) row.push(''); row.push(w[1]); cl.push(row); });
        cl.push([]);
      }
    };
    chipDiagram("Unsort 5' CITEseq (5' v3)", "5' v3", 'CG000734 | Rev A', "GEM-X 5' Chip + Chromium X/iX Chip Holder (black)",
      [['3: Oil (250ul)', '250ul'], ['2: Gel beads (60ul)', '60ul'], ['1: Sample (MM + cells) (60ul)', '60ul']],
      lanes.unsort, 8, (g) => 'U' + (g + 1));
    chipDiagram('ASAPseq (ATAC v2)', 'ATAC v2', 'CG000496 | Rev B', 'Next GEM Chip H + Chromium Next GEM Chip Holder (silver)',
      [['3: Oil (40ul)', '40ul'], ['2: Gel beads (50ul)', '50ul'], ['1: Sample (MM + nuclei: 70ul)', '70ul'], ['NO FILL - GEM RECOVERY', 'DO NOT ADD']],
      lanes.asap, 8, (g) => 'A' + (g + 1));
    chipDiagram("Sort 5' scRNAseq w/ HTO (5' v3)", "5' v3", 'CG000734 | Rev A', "GEM-X 5' Chip + Chromium X/iX Chip Holder (black)",
      [['NO FILL - GEM RECOVERY', 'DO NOT ADD'], ['2: Gel beads (60ul)', '60ul'], ['1: Sample (MM + cells) (60ul)', '60ul'], ['3: Oil (250ul)', '250ul']],
      lanes.sort, 8, (g) => 'S' + (g + 1));
    const wsCL = XLSX.utils.aoa_to_sheet(cl);
    wsCL['!cols'] = [{ wch: 30 }].concat(Array.from({ length: 8 }, () => ({ wch: 7 })), [{ wch: 16 }]);
    XLSX.utils.book_append_sheet(wb, wsCL, '10X Chip Layout');

    // ---- Library indexes tab (labels + recommended indexes + kits) --------
    // Base ID {U/A/S}{lane}, -{chip} only when >1 chip (matches the tube labels).
    const bn = (letter, g) => letter + (g + 1);   // sequential across all chips (no -chip suffix)
    // Recommended index kit per library type (from the lab's 10X inventory + ASAP oligos).
    const IDX = {
      gex:     { type: 'Dual Index TT Set A', cat: '1000215', gen: 'plate' },
      csp:     { type: 'Dual Index TN Set A', cat: '1000250', gen: 'plate' },
      vdj:     { type: 'Dual Index TT Set A (VDJ plate)', cat: '1000215', gen: 'plate' },
      atac:    { type: 'Single Index N Set A', cat: '1000212', gen: 'plate' },
      asapAdt: { type: 'RPI oligos (ASAP ADT)', cat: 'OL016\u2013031', gen: 'rpi' },
      asapHto: { type: 'D7xx oligos (ASAP HTO)', cat: 'OL004\u2013015', gen: 'd7xx' }
    };
    const ctr = {};
    const idxId = (key) => {
      const n = (ctr[key] = (ctr[key] || 0) + 1) - 1;
      const gen = IDX[key].gen;
      if (gen === 'rpi') return 'RPI' + ((n % 16) + 1);                    // RPI1..RPI16, then wrap
      if (gen === 'd7xx') return 'D7' + String((n % 12) + 1).padStart(2, '0'); // D701..D712, then wrap
      const w = n % 96; return String.fromCharCode(65 + Math.floor(w / 12)) + (w % 12 + 1);  // A1..H12, then wrap
    };
    const li2 = [['How to use: recommended 10X indexes + tube labels for every library in this experiment. Print with the packet; record any index/label changes by hand.'], [],
      ['Tube label', 'Modality', 'Library type', 'Index type (kit)', 'Kit catalog #', 'Index ID', 'Index sequence', 'Notes / changes']];
    const idxRow = (label, modality, libType, key) => li2.push([label, modality, libType, IDX[key].type, IDX[key].cat, idxId(key), '', '']);
    // 5' unsort
    for (let i = 0; i < lanes.unsort; i++) idxRow(bn('U', i, 8, lanes.unsort) + '-GEX', "Unsort 5'", 'GEX', 'gex');
    for (let i = 0; i < lanes.unsort; i++) idxRow(bn('U', i, 8, lanes.unsort) + '-ADT', "Unsort 5'", 'CSP/ADT', 'csp');
    if (armVdj.unsort) for (let i = 0; i < lanes.unsort; i++) { const b = bn('U', i, 8, lanes.unsort); idxRow(b + '-TCR', "Unsort 5'", 'TCR', 'vdj'); idxRow(b + '-BCR', "Unsort 5'", 'BCR', 'vdj'); }
    // ASAP
    for (let i = 0; i < lanes.asap; i++) idxRow(bn('A', i, 8, lanes.asap) + '-ATAC', 'ASAP', 'ATAC', 'atac');
    for (let i = 0; i < lanes.asap; i++) idxRow(bn('A', i, 8, lanes.asap) + '-ADT', 'ASAP', 'CSP/ADT', 'asapAdt');
    for (let i = 0; i < lanes.asap; i++) idxRow(bn('A', i, 8, lanes.asap) + '-HTO', 'ASAP', 'HTO', 'asapHto');
    // sort 5'
    for (let i = 0; i < lanes.sort; i++) idxRow(bn('S', i, 8, lanes.sort) + '-GEX', "Sort 5'", 'GEX', 'gex');
    for (let i = 0; i < lanes.sort; i++) idxRow(bn('S', i, 8, lanes.sort) + '-ADT', "Sort 5'", 'CSP/ADT', 'csp');
    if (armVdj.sort) for (let i = 0; i < lanes.sort; i++) idxRow(bn('S', i, 8, lanes.sort) + '-TCR', "Sort 5'", 'TCR', 'vdj');
    // Kits-to-use summary + rxns-used space
    li2.push([]); li2.push(['KITS TO USE \u2014 record how many indexes/rxns you actually used, then update the planning website after the experiment.']);
    li2.push(['Index type (kit)', 'Kit catalog #', 'Indexes needed', 'Index IDs (from \u2192 to)', '# rxns actually used', 'Lot # used', 'Notes']);
    Object.keys(ctr).forEach((key) => {
      const n = ctr[key]; if (!n) return;
      // recompute first/last id for display
      const save = ctr[key]; ctr[key] = 0; const first = idxId(key); ctr[key] = n - 1; const last = idxId(key); ctr[key] = save;
      li2.push([IDX[key].type, IDX[key].cat, n, first + ' \u2192 ' + last, '', '', '']);
    });
    const wsLI = XLSX.utils.aoa_to_sheet(li2);
    wsLI['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 26 }, { wch: 13 }, { wch: 12 }, { wch: 18 }, { wch: 22 }];
    XLSX.utils.book_append_sheet(wb, wsLI, 'Library indexes');

    // ---- Sort panel + Stim plan tabs (manual design for now) ---------------
    if (hasSortArm) {
      const sp = [['Sort panel'], ['Design the sort flow panel manually for now (this tool does not yet generate it).'], [],
        ['Populations to sort (from plan): HSC, pDC, cDC, Treg'], [],
        ['Marker', 'Fluorophore', 'Clone', 'Vendor / Cat #', 'Dilution', 'Notes']];
      for (let i = 0; i < 20; i++) sp.push(['', '', '', '', '', '']);
      const wsSP = XLSX.utils.aoa_to_sheet(sp);
      wsSP['!cols'] = [{ wch: 16 }, { wch: 16 }, { wch: 12 }, { wch: 20 }, { wch: 10 }, { wch: 30 }];
      XLSX.utils.book_append_sheet(wb, wsSP, 'Sort panel');
    }
    if ((s.modalities || []).indexOf('In vitro stimulation') >= 0) {
      const stp = [['Stim plan'], ['Design the stimulation plate plan manually for now (this tool does not yet generate it).'], [],
        ['Condition', 'Stimulant', 'Concentration', 'Duration', 'Wells / plate position', 'Notes']];
      for (let i = 0; i < 20; i++) stp.push(['', '', '', '', '', '']);
      const wsST = XLSX.utils.aoa_to_sheet(stp);
      wsST['!cols'] = [{ wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 12 }, { wch: 20 }, { wch: 30 }];
      XLSX.utils.book_append_sheet(wb, wsST, 'Stim plan');
    }


    return wb;
  }

  // ---- inventory ------------------------------------------------------------
  // Convert an amount between compatible units (volume µL/mL/L or mass µg/mg/g).
  // Same/blank units or incompatible kinds -> returned unchanged (never guess).
  function invUnitKind(u) {
    const s = (u || '').toLowerCase().trim();
    if (/^(µl|ul|microl)/.test(s)) return { k: 'vol', f: 1e-6 };
    if (/^ml\b|^milli/.test(s)) return { k: 'vol', f: 1e-3 };
    if (/^l\b|^liter|^litre/.test(s)) return { k: 'vol', f: 1 };
    if (/^(µg|ug|microg)/.test(s)) return { k: 'mass', f: 1e-6 };
    if (/^mg\b/.test(s)) return { k: 'mass', f: 1e-3 };
    if (/^g\b|^gram/.test(s)) return { k: 'mass', f: 1 };
    return null;
  }
  function convToUnit(amount, fromU, toU) {
    if (amount == null) return amount;
    const a = (fromU || '').toLowerCase().trim(), b = (toU || '').toLowerCase().trim();
    if (!a || !b || a === b) return amount;
    const fa = invUnitKind(a), fb = invUnitKind(b);
    if (fa && fb && fa.k === fb.k) return amount * fa.f / fb.f;
    return amount; // incompatible or count units -> leave as-is
  }

  function computeExperimentUsage(rec) {
    const inv = {}; ((DATA && DATA.liveInventory) || []).forEach((i) => { inv[i.id] = i; });
    const usage = [];
    const s = rec.snapshot || {};
    (s.reagents || []).forEach((r) => {
      if (!r.itemId || !inv[r.itemId]) return;
      // Reserve the ACTUAL amount consumed ("Total needed"), NOT the rounded-up
      // order/purchase quantity — otherwise a tiny reagent (e.g. a few µL of
      // digitonin) would reserve a whole vial. Convert into the inventory item's
      // unit so the reservation lines up with on-hand.
      const invUnit = inv[r.itemId].unit || inv[r.itemId].usageUnit || '';
      let amt = (r.totalAmount != null) ? convToUnit(r.totalAmount, r.units, invUnit)
        : (r.quantity != null ? r.quantity : null);
      if (amt == null) return;
      usage.push({ itemId: r.itemId, itemName: inv[r.itemId].name || r.reagent, unit: invUnit || (r.units || ''), amount: amt });
    });
    (s.lineItems || []).forEach((li) => {
      if (li.category !== '10x kits' || !li.itemId || !inv[li.itemId]) return;
      if (li.qty == null) return;
      usage.push({ itemId: li.itemId, itemName: inv[li.itemId].name || li.label, unit: inv[li.itemId].unit || 'kits', amount: li.qty });
    });
    const byId = {};
    usage.forEach((u) => { if (!byId[u.itemId]) byId[u.itemId] = u; else byId[u.itemId].amount += u.amount; });
    return Object.keys(byId).map((k) => byId[k]);
  }

  function fmtQ(n) { return (Math.round((n || 0) * 100) / 100).toLocaleString(); }

  // Info about the experiment currently being designed/edited, for the
  // Scheduling tab's "scheduled experiments" list.
  function currentDesignInfo() {
    const cur = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    if (!cur) return { id: null, name: '', date: '', project: '', plannedBy: '', nSamples: null };
    let nSamples = cur.snapshot ? cur.snapshot.nSamples : null;
    if (nSamples == null) { try { nSamples = (samplesFromGrid().samples || []).length || null; } catch (e) { nSamples = null; } }
    return { id: cur.id, name: cur.name || '', date: cur.date || '', project: cur.project || '',
      plannedBy: cur.plannedBy || '', nSamples: nSamples };
  }
  window.currentDesignInfo = currentDesignInfo;

  // An experiment's role in inventory: reserving planned stock, having deducted
  // stock (completed + recorded), or idle (saved but not affecting inventory).
  function invRole(e) {
    if (!e || !e.snapshot) return 'none';
    if (e.status === 'completed' && e.inventoryApplied) return 'deducted';
    if (e.status !== 'completed' && e.reserved !== false) return 'reserved';
    return 'idle';
  }

  // Live inventory state: on-hand (start + received - used), reserved (planned
  // experiments), available (on-hand - reserved), and a reorder flag.
  function computeInventoryState() {
    const invList = (DATA && DATA.liveInventory) || [];
    const net = Store.inventoryNet();
    const exps = Store.allExperiments().filter((e) => e.snapshot);
    const reservingExps = exps.filter((e) => invRole(e) === 'reserved');
    const deductedExps = exps.filter((e) => invRole(e) === 'deducted');
    const idleExps = exps.filter((e) => invRole(e) === 'idle');
    const reserved = {}, reservedBy = {};
    reservingExps.forEach((e) => computeExperimentUsage(e).forEach((u) => {
      reserved[u.itemId] = (reserved[u.itemId] || 0) + u.amount;
      (reservedBy[u.itemId] = reservedBy[u.itemId] || []).push({ name: e.name, amount: u.amount });
    }));
    const items = invList.map((it) => {
      const pack = (it.packSize && it.packSize > 0) ? it.packSize : 1;
      const known = it.currentUnits != null;
      const onHandUnits = (known ? it.currentUnits : 0) + ((net[it.id] && net[it.id].delta) || 0);
      const res = reserved[it.id] || 0;
      const availUnits = onHandUnits - res;
      const thr = it.minStock != null ? it.minStock : 0;
      let status;
      if (!known && !net[it.id]) status = 'unknown';
      else if (availUnits <= 0) status = 'out';
      else if (thr > 0 && availUnits < thr) status = 'low';
      else status = 'ok';
      const need = Math.max(0, thr - availUnits);
      let toOrder = Math.ceil(need / pack);
      if (status === 'out' && toOrder < 1) toOrder = 1;
      if (status === 'unknown' || status === 'ok') toOrder = 0;
      return { id: it.id, name: it.name, container: it.container || '', packSize: pack,
        usageUnit: it.usageUnit || it.unit || '', hasContainers: !!(it.container && pack > 1),
        onHandUnits: onHandUnits, onHandContainers: known ? onHandUnits / pack : null,
        reserved: res, availableUnits: availUnits, availableContainers: availUnits / pack,
        threshold: thr, orderStatus: it.orderStatus || '', location: it.location || '',
        category: it.category || 'Reagents', reservedForProject: it.reservedForProject || '',
        lots: it.lots || '', expiry: it.expiry || '',
        status: status, known: known, toOrder: toOrder, reservedBy: reservedBy[it.id] || [] };
    });
    return { items: items, reservingExps: reservingExps, deductedExps: deductedExps, idleExps: idleExps,
      plannedCount: reservingExps.length, completedCount: deductedExps.length };
  }

  // Is one experiment's reagent demand covered by current inventory?
  function experimentReservation(rec, state) {
    state = state || computeInventoryState();
    const byId = {}; state.items.forEach((i) => { byId[i.id] = i; });
    const short = [];
    computeExperimentUsage(rec).forEach((u) => {
      const it = byId[u.itemId];
      if (!it || it.status === 'unknown') return;
      if (it.availableUnits < 0) {
        const deficit = -it.availableUnits;
        const cont = it.hasContainers ? ' \u2248 ' + Math.ceil(deficit / it.packSize) + ' ' + it.container : '';
        short.push(it.name + ' (short ' + fmtQ(deficit) + ' ' + it.usageUnit + cont + ')');
      }
    });
    const invIds = {}; state.items.forEach((i) => { invIds[i.id] = true; });
    const untracked = [];
    const s = rec.snapshot || {};
    (s.reagents || []).forEach((r) => { if (r.itemId && !invIds[r.itemId] && (r.quantity != null || r.totalAmount != null)) untracked.push(r.reagent || r.itemId); });
    return { needed: computeExperimentUsage(rec).length, short: short, untracked: untracked,
      completed: (rec.status === 'completed'), ok: short.length === 0 };
  }

  function inventoryBadge() {
    const btn = document.querySelector('.tab[data-top="inventory"]');
    if (!btn) return;
    let n = 0;
    try { n = computeInventoryState().items.filter((i) => i.status === 'out' || i.status === 'low').length; } catch (e) { n = 0; }
    let b = btn.querySelector('.tab-badge');
    if (n) { if (!b) { b = document.createElement('span'); b.className = 'tab-badge'; btn.appendChild(b); } b.textContent = n; }
    else if (b) b.remove();
  }

  function renderInventory() {
    const host = $('#inventoryContent'); if (!host) return;
    if (!DATA || !((DATA.liveInventory || []).length)) {
      // The /api/inventory fetch may have failed or been slow on boot — retry once on open.
      if (DATA && !DATA._invRetried) {
        DATA._invRetried = true;
        host.innerHTML = '<div class="section-head"><h2>Inventory</h2></div><p class="muted">Loading live inventory\u2026</p>';
        loadLiveInventory().then(() => renderInventory()).catch(() => renderInventory());
        return;
      }
      host.innerHTML = '<div class="section-head"><h2>Inventory</h2></div><p class="empty">Could not load the live inventory. Check that the inventory Google Sheet is shared with the service account and reachable, then reopen this tab.</p>';
      return;
    }
    const st = computeInventoryState();
    const order = st.items.filter((i) => i.status === 'out' || i.status === 'low');
    const rank = { out: 0, low: 1, ok: 2, unknown: 3 };
    const sorted = st.items.slice().sort((a, b) => (rank[a.status] - rank[b.status]) || (a.id < b.id ? -1 : 1));
    const badge = (s) => {
      const m = { out: ['Order now', 'inv-out'], low: ['Low', 'inv-low'], ok: ['In stock', 'inv-ok'], unknown: ['No stock data', 'inv-unknown'] };
      return '<span class="inv-badge ' + m[s][1] + '">' + m[s][0] + '</span>';
    };
    const fmt1 = (n) => (Math.round(n * 10) / 10).toLocaleString();
    const orderUnit = (i) => esc(i.container || i.usageUnit || 'unit');
    const orderCallout = order.length
      ? '<div class="callout warn"><strong>\u26a0 ' + order.length + ' item(s) to order:</strong><ul>' +
        order.map((i) => '<li>' + esc(i.name) + ' \u2014 order <strong>' + fmtQ(i.toOrder) + ' ' + orderUnit(i) + '</strong> (' +
          fmtQ(i.availableUnits) + ' ' + esc(i.usageUnit) + ' available' +
          (i.threshold ? ', reorder at ' + fmtQ(i.threshold) : '') + ')' +
          (i.orderStatus ? ' \u00b7 ' + esc(i.orderStatus) : '') + '</li>').join('') + '</ul></div>'
      : '<div class="callout info">All tracked items are above their reorder thresholds.</div>';
    const invRow = (i) => '<tr>' +
      '<td>' + esc(i.name) + ' <span class="who">' + esc(i.id) + '</span>' +
        ((i.category === '10X Kits' && (i.reservedForProject || i.expiry || i.lots))
          ? '<div class="who">' +
              (i.reservedForProject ? 'reserved for ' + esc(i.reservedForProject) : '') +
              (i.expiry ? (i.reservedForProject ? ' \u00b7 ' : '') + 'exp ' + esc(i.expiry) : '') +
              (i.lots ? ' \u00b7 lot ' + esc(i.lots) : '') + '</div>'
          : '') + '</td>' +
      '<td class="num">' + (i.known
        ? '<strong>' + fmtQ(i.onHandUnits) + '</strong> ' + esc(i.usageUnit) + (i.hasContainers ? '<div class="who">' + fmt1(i.onHandUnits / i.packSize) + ' ' + esc(i.container) + '</div>' : '')
        : '\u2014') + '</td>' +
      '<td class="num">' + (i.reserved ? fmtQ(i.reserved) + ' ' + esc(i.usageUnit) + (i.reservedBy && i.reservedBy.length ? '<div class="who">' + i.reservedBy.map((r) => esc(r.name)).join(', ') + '</div>' : '') : '\u2014') + '</td>' +
      '<td class="num"><strong>' + (i.status === 'unknown' ? '\u2014' : fmtQ(i.availableUnits)) + '</strong>' + (i.status === 'unknown' ? '' : ' ' + esc(i.usageUnit)) + (i.known && i.reserved > i.onHandUnits ? '<div class="who inv-overcommit">over-committed</div>' : '') + '</td>' +
      '<td class="num">' + (i.toOrder > 0 ? '<strong>' + fmtQ(i.toOrder) + '</strong> ' + orderUnit(i) : '\u2014') + '</td>' +
      '<td class="num">' + (i.threshold ? fmtQ(i.threshold) + ' ' + esc(i.usageUnit) : '\u2014') + '</td>' +
      '<td>' + badge(i.status) + '</td>' +
      '<td class="src">' + esc(i.location || i.orderStatus || '') + '</td></tr>';

    const CAT_ORDER = ['Reagents', 'Supplies', 'Oligos', 'Antibodies', '10X Kits'];
    const byCat = {};
    sorted.forEach((i) => { const c = i.category || 'Reagents'; (byCat[c] = byCat[c] || []).push(i); });
    const cats = CAT_ORDER.filter((c) => byCat[c]).concat(Object.keys(byCat).filter((c) => CAT_ORDER.indexOf(c) === -1));
    const invHead = '<thead><tr><th>Item</th><th class="num">On hand</th><th class="num">Reserved</th><th class="num">Available</th><th class="num">To order</th><th class="num">Threshold</th><th>Status</th><th>Location / order</th></tr></thead>';
    const invSections = cats.map((c) => {
      const list = byCat[c];
      const toOrderN = list.filter((i) => i.toOrder > 0).length;
      return '<details class="inv-cat"><summary><strong>' + esc(c) + '</strong> <span class="who">' + list.length + ' item' + (list.length === 1 ? '' : 's') +
        (toOrderN ? ' \u00b7 ' + toOrderN + ' to order' : '') + '</span></summary>' +
        '<table class="cost-table">' + invHead + '<tbody>' + list.map(invRow).join('') + '</tbody></table></details>';
    }).join('');
    const expMetaCols = (e) =>
      '<td class="num">' + (e.snapshot ? e.snapshot.nSamples : '\u2014') + '</td>' +
      '<td>' + esc(e.project || '\u2014') + '</td>' +
      '<td>' + esc(e.date || '\u2014') + '</td>' +
      '<td>' + esc(e.plannedBy || '\u2014') + '</td>';

    const resRows = st.reservingExps.map((e) => {
      const r = experimentReservation(e, st);
      const flag = r.needed === 0 ? '<span class="rsv rsv-none">no tracked reagents</span>'
        : (r.ok ? '<span class="rsv rsv-ok">covered</span>' : '<span class="rsv rsv-short">short</span>');
      return '<tr><td><strong>' + esc(e.name) + '</strong></td>' + expMetaCols(e) +
        '<td>' + flag + '</td><td class="exp-actions"><button class="btn tiny danger" data-inv-act="unreserve" data-id="' + e.id + '">Remove reservation</button></td></tr>';
    }).join('');
    const resTable = st.reservingExps.length
      ? '<table class="cost-table exp-table"><thead><tr><th>Experiment</th><th class="num">Samples</th><th>Project</th><th>Date</th><th>Planned by</th><th>Reserved</th><th>Action</th></tr></thead><tbody>' + resRows + '</tbody></table>'
      : '<p class="empty">No experiments are currently reserving reagents.</p>';
    const idleOpts = st.idleExps.map((e) => '<option value="' + e.id + '">' + esc(e.name) + (e.project ? ' (' + esc(e.project) + ')' : '') + '</option>').join('');
    const addReserve = st.idleExps.length
      ? '<div class="proj-bar"><label>Add experiment to reserve <select id="reserveAddSel">' + idleOpts + '</select></label><button class="btn" id="reserveAddBtn">Reserve its reagents</button></div>'
      : '<p class="muted small">To add an experiment here, save a plan on the Plan tab (it reserves automatically), or remove a reservation above to move one aside.</p>';

    const dedSorted = st.deductedExps.slice().sort((a, b) => ((a.date || a.updatedAt || '') < (b.date || b.updatedAt || '') ? 1 : -1));
    const dedRows = dedSorted.map((e) => '<tr><td><strong>' + esc(e.name) + '</strong></td>' + expMetaCols(e) +
      '<td class="exp-actions"><button class="btn tiny danger" data-inv-act="undeduct" data-id="' + e.id + '">Remove (restore stock)</button></td></tr>').join('');
    const dedTable = dedSorted.length
      ? '<table class="cost-table exp-table"><thead><tr><th>Experiment</th><th class="num">Samples</th><th>Project</th><th>Date</th><th>Planned by</th><th>Action</th></tr></thead><tbody>' + dedRows + '</tbody></table>'
      : '<p class="empty">No experiments have deducted reagents yet. Use \u201cRecord inventory\u201d on a completed experiment to draw down stock.</p>';

    // Manual stock adjustment — ad-hoc changes not tied to an experiment.
    const itemOpts = st.items.slice().sort((a, b) => (a.name < b.name ? -1 : 1)).map((i) => '<option value="' + escAttr(i.id) + '">' + esc(i.name) + ' (' + esc(i.id) + ')</option>').join('');
    const manualTx = ((Store.allTransactions && Store.allTransactions()) || []).filter((t) => !t.experimentId).slice().reverse().slice(0, 12);
    const manualRows = manualTx.map((t) => { const chg = (t.sheetDelta != null ? t.sheetDelta : t.delta) || 0;
      return '<tr><td>' + esc((t.date || '').slice(0, 10)) + '</td><td>' + esc(t.itemName || t.itemId) + '</td>'
      + '<td class="num">' + (chg > 0 ? '+' : '') + fmtQ(chg) + ' ' + esc(t.unit || '') + '</td>'
      + '<td>' + esc(t.reason || '') + '</td>'
      + '<td><button class="btn tiny" data-madj-undo="' + escAttr(t.id) + '">Undo</button></td></tr>'; }).join('');
    const manualList = manualTx.length
      ? '<table class="cost-table"><thead><tr><th>Date</th><th>Item</th><th class="num">Change</th><th>Reason</th><th></th></tr></thead><tbody>' + manualRows + '</tbody></table>'
      : '<p class="empty">No manual adjustments logged yet.</p>';
    const manualAdjust = '<h3 style="margin-top:28px">Manual stock adjustment</h3>'
      + '<p class="muted">For ad-hoc changes not tied to an experiment \u2014 a vial removed for a one-off, a spill, a recount, or newly received stock. Logged as a dated event on top of the sheet\u2019s baseline (it doesn\u2019t rewrite the sheet).</p>'
      + '<div class="proj-bar manual-adj">'
      + '<label>Item <select id="madjItem">' + itemOpts + '</select></label>'
      + '<label>Change <select id="madjDir"><option value="-1">Remove (\u2212)</option><option value="1">Add (+)</option></select></label>'
      + '<label>Amount <input type="number" id="madjAmt" min="0" step="any" style="width:88px"></label>'
      + '<label>Reason <input type="text" id="madjReason" placeholder="e.g. spill, recount, walk-up use" style="width:200px"></label>'
      + '<button class="btn" id="madjLog">Log adjustment</button></div>'
      + '<div id="madjStatus" class="muted" style="margin-top:6px"></div>'
      + '<h4 style="margin-top:14px">Recent manual adjustments</h4>' + manualList;

    host.innerHTML =
      '<div class="section-head"><h2>Inventory</h2><div class="head-actions">' +
        '<button class="btn ghost" onclick="window.print()">Print / save PDF</button></div></div>' +
      '<div class="cost-headline">' +
        '<div><span class="ch-num">' + st.items.length + '</span><span class="ch-lbl">items tracked</span></div>' +
        '<div><span class="ch-num">' + order.length + '</span><span class="ch-lbl">to order (low / out)</span></div>' +
        '<div><span class="ch-num">' + st.plannedCount + '</span><span class="ch-lbl">experiments reserving stock</span></div>' +
      '</div>' + orderCallout +
      '<p class="muted">Stock is drawn down in <strong>usage units</strong> (tubes / mL / reactions); <strong>To order</strong> is rounded up to whole <strong>containers</strong> (bag / kit / vial / bottle) using each item\u2019s pack size. On hand = starting stock + received \u2212 used (completed experiments). Reserved = demand from reserving experiments. Available = on hand \u2212 reserved. Set pack_size, container, and min_stock_threshold per item in the Live_Inventory sheet.</p>' +
      invSections +
      manualAdjust +
      '<h3 style="margin-top:28px">Reserved by experiment</h3>' +
      '<p class="muted">Planned experiments holding stock. Removing a reservation frees its reagents back to Available without deleting the experiment.</p>' +
      resTable + addReserve +
      '<h3 style="margin-top:28px">Recent reagent deductions</h3>' +
      '<p class="muted">Completed experiments that have drawn down stock (most recent first). Remove one to undo its deduction \u2014 e.g. if it was recorded by mistake \u2014 which restores the stock and moves it back to reserved.</p>' +
      dedTable;

    host.querySelectorAll('button[data-inv-act]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.id, act = b.dataset.invAct;
      const rec = Store.getExperiment(id); if (!rec) return;
      if (act === 'unreserve') { rec.reserved = false; Store.saveExperiment(rec); }
      else if (act === 'undeduct') {
        if (!confirm('Undo the reagent deduction for \u201c' + rec.name + '\u201d? This restores the stock and moves it back to reserved.')) return;
        Store.removeTransactionsForExperiment(id);
        rec.inventoryApplied = false; rec.status = 'planned'; rec.reserved = true;
        Store.saveExperiment(rec);
      }
      renderInventory(); renderManage(); pushReservedToSheet();
    }));
    const addBtn = $('#reserveAddBtn');
    if (addBtn) addBtn.addEventListener('click', () => {
      const sel = $('#reserveAddSel'); if (!sel || !sel.value) return;
      const rec = Store.getExperiment(sel.value); if (!rec) return;
      rec.reserved = true;
      if (rec.status === 'completed') { rec.status = 'planned'; rec.inventoryApplied = false; Store.removeTransactionsForExperiment(rec.id); }
      Store.saveExperiment(rec);
      renderInventory(); renderManage(); pushReservedToSheet();
    });
    const madjLog = $('#madjLog');
    if (madjLog) madjLog.addEventListener('click', () => {
      const sel = $('#madjItem'); const id = sel && sel.value; if (!id) return;
      const amt = Math.abs(Number($('#madjAmt').value) || 0);
      if (!amt) { $('#madjStatus').textContent = 'Enter an amount.'; return; }
      const dir = Number($('#madjDir').value) || -1;
      const delta = dir * amt;
      const it = st.items.find((x) => x.id === id) || {};
      const reason = ($('#madjReason').value || '').trim();
      const stEl = $('#madjStatus'); stEl.textContent = 'Updating the inventory sheet\u2026';
      madjLog.disabled = true;
      fetch('/api/inventory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'adjustOnHand', itemId: id, deltaUnits: delta }) })
        .then((r) => r.json()).then((d) => {
          madjLog.disabled = false;
          if (!d || !d.ok) { stEl.textContent = 'Could not update the sheet: ' + (d && (d.error || d.message) ? (d.error || d.message) : 'unknown error'); return; }
          // audit-trail entry only (delta 0 so it doesn't double-count — the sheet now holds the change)
          Store.addTransactions([{ itemId: id, itemName: it.name || id, unit: it.usageUnit || '', delta: 0, sheetDelta: delta,
            date: new Date().toISOString().slice(0, 10), reason: 'Manual: ' + (reason || (delta < 0 ? 'removed' : 'added')), experimentId: null }]);
          loadLiveInventory().then(() => renderInventory()).catch(() => renderInventory());
        })
        .catch((e) => { madjLog.disabled = false; stEl.textContent = 'Sheet update failed: ' + e; });
    });
    host.querySelectorAll('button[data-madj-undo]').forEach((b) => b.addEventListener('click', () => {
      const txId = b.dataset.madjUndo;
      const t = (Store.allTransactions() || []).find((x) => x.id === txId);
      const finish = () => { if (Store.removeTransaction) Store.removeTransaction(txId); loadLiveInventory().then(() => renderInventory()).catch(() => renderInventory()); };
      if (t && t.sheetDelta) {
        fetch('/api/inventory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'adjustOnHand', itemId: t.itemId, deltaUnits: -t.sheetDelta }) })
          .then(() => finish()).catch(() => finish());
      } else finish();
    }));
    inventoryBadge();
  }

  function recordInventoryUI(id) {
    const rec = Store.getExperiment(id);
    if (!rec) return;
    if (!rec.snapshot) { alert('Open and Save this experiment (after building the plan) before recording inventory usage.'); return; }
    if (!DATA || !((DATA.liveInventory || []).length)) { alert('No Live_Inventory rows found in the spreadsheet. Add items to the Live_Inventory tab (item_id, item_name, unit, current_stock) so usage can be matched.'); return; }
    const usage = computeExperimentUsage(rec);
    if (!usage.length) { alert('None of this experiment\u2019s reagents matched an item_id in Live_Inventory. Add matching item_ids to the Live_Inventory tab to track them.'); return; }
    if (rec.inventoryApplied) {
      if (!confirm('Inventory usage was already recorded for "' + rec.name + '". Re-record (replaces the previous deduction for this experiment)?')) return;
      Store.removeTransactionsForExperiment(id);
    }
    const date = rec.date || new Date().toISOString().slice(0, 10);
    const txs = usage.map((u) => ({ itemId: u.itemId, itemName: u.itemName, unit: u.unit, delta: -Math.abs(u.amount), date: date, reason: 'Experiment: ' + rec.name, experimentId: id }));
    Store.addTransactions(txs);
    rec.inventoryApplied = true; rec.status = 'completed';
    Store.saveExperiment(rec);
    const header = ['date', 'item_id', 'item_name', 'change', 'unit', 'reason', 'experiment_id'];
    const rows = [header].concat(txs.map((t) => [t.date, t.itemId, t.itemName, t.delta, t.unit, t.reason, t.experimentId]));
    const ws = XLSX.utils.aoa_to_sheet(rows); ws['!cols'] = [{ wch: 12 }, { wch: 9 }, { wch: 34 }, { wch: 9 }, { wch: 10 }, { wch: 30 }, { wch: 22 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Inventory_Transactions');
    XLSX.writeFile(wb, 'inventory_usage_' + projectLabel(rec.name) + '.xlsx');
    alert('Recorded ' + txs.length + ' inventory deduction(s) for "' + rec.name + '" and downloaded a transactions sheet to append to your Inventory_Transactions tab.');
    renderManage();
    renderInventory();
  }

  // ---- backup / restore of the whole store ----------------------------------
  function exportStoreJSON() {
    const blob = new Blob([JSON.stringify(Store.exportAll(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'singlecell-planner-experiments.json';
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }
  function importStoreJSON(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      let obj; try { obj = JSON.parse(e.target.result); } catch (err) { alert('Not a valid JSON backup: ' + err); return; }
      const mode = confirm('OK = MERGE into your current saved experiments.\nCancel = REPLACE everything with the file.') ? 'merge' : 'replace';
      const res = Store.importAll(obj, mode);
      if (!res.ok) { alert('Import failed: ' + res.reason); return; }
      refreshProjectDatalist(); renderManage();
      alert('Imported ' + res.added + ' experiment(s).');
    };
    reader.readAsText(file);
  }

  // ---- manage-projects tab render -------------------------------------------
  function refreshProjectDatalist() {
    const dl = $('#projectList');
    if (!dl) return;
    dl.innerHTML = Store.projects().names.map((p) => '<option value="' + escAttr(p) + '"></option>').join('');
  }

  function statusBadge(st) {
    const cls = st === 'completed' ? 'done' : 'planned';
    return '<span class="exp-badge ' + cls + '">' + esc(st === 'completed' ? 'completed' : 'planned') + '</span>';
  }

  function roleChipHTML(e, invState) {
    if (!e.snapshot) return '';
    const role = invRole(e);
    if (role === 'deducted') return '<span class="rsv rsv-done">\u2713 stock deducted</span>';
    if (role === 'idle') return '<span class="rsv rsv-none">not reserving</span>';
    if (role === 'reserved') {
      const rsv = experimentReservation(e, invState);
      if (rsv.needed === 0) return '<span class="rsv rsv-none">no tracked reagents</span>';
      if (rsv.ok) return '<span class="rsv rsv-ok">\u2713 reserved</span>';
      let h = '<span class="rsv rsv-short">\u26a0 short: ' + esc(rsv.short.slice(0, 3).join('; ')) + (rsv.short.length > 3 ? ' \u2026' : '') + '</span>';
      if (rsv.untracked.length) h += ' <span class="rsv rsv-note">+' + rsv.untracked.length + ' untracked</span>';
      return h;
    }
    return '';
  }

  // Read a project's saved batch plan (from the Plan project tab, localStorage).
  function readBatchPlan(project) {
    try { const s = JSON.parse(localStorage.getItem('scp:batching:v1') || '{}'); return s[project] || null; }
    catch (e) { return null; }
  }

  function renderManage() {
    const host = $('#manageContent'); if (!host) return;
    const invState = computeInventoryState();
    const exps = Store.allExperiments();
    const meta = Store.allProjects();
    const ownerOf = {}; meta.forEach((p) => { ownerOf[p.name] = p.owner || ''; });
    const byProj = {}; const unfiled = [];
    exps.forEach((e) => { const p = (e.project || '').trim(); if (!p) unfiled.push(e); else (byProj[p] = byProj[p] || []).push(e); });
    const names = {}; meta.forEach((p) => { if (p.name) names[p.name] = true; }); Object.keys(byProj).forEach((p) => { names[p] = true; });
    const projNames = Object.keys(names).sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1);

    let html = '<div class="section-head"><h2>Project manager</h2><div class="head-actions">'
      + '<button class="btn primary" id="newProjectBtn">Create project</button>'
      + '<button class="btn ghost" id="exportStoreBtn" title="Download a JSON backup">Backup (JSON)</button>'
      + '<label class="btn ghost" title="Restore from a JSON backup">Restore<input type="file" id="importStoreInput" accept=".json" hidden /></label>'
      + '</div></div><div id="pmForms"></div>';
    if (!projNames.length && !unfiled.length) {
      html += '<p class="empty">No projects yet. Click <em>Create project</em> to make one \u2014 experiments are created inside a project.</p>';
    }

    const cardFor = (pname, list, owner, isUnfiled) => {
      list = list.slice().sort((a, b) => (a.date || '') < (b.date || '') ? -1 : ((a.date || '') > (b.date || '') ? 1 : 0));
      const total = list.reduce((sm, e) => sm + ((e.snapshot && e.snapshot.knownTotal) || 0), 0);
      const expanded = !!EXPANDED_PROJECTS[pname];
      const summ = list.length
        ? list.map((e) => '<li>' + esc(e.name) + (e.date ? ' <span class="muted">\u2014 ' + esc(e.date) + '</span>' : '') + ' ' + statusBadge(e.status) + '</li>').join('')
        : '<li class="muted">No experiments yet.</li>';
      const projAbbrev = isUnfiled ? '' : (function () { const pr = Store.allProjects().find((p) => p.name === pname); return pr && pr.abbreviation ? pr.abbreviation : ''; })();
      let c = '<div class="proj-card"><div class="proj-card-head"><div><h3>' + esc(isUnfiled ? 'Unfiled experiments' : pname) + (projAbbrev ? ' <span class="proj-abbrev">' + esc(projAbbrev) + '</span>' : '') + '</h3>'
        + '<p class="muted small">' + (isUnfiled ? (list.length + ' experiment' + (list.length === 1 ? '' : 's'))
          : ('Owner: ' + esc(owner || '\u2014') + ' \u00b7 ' + list.length + ' experiment' + (list.length === 1 ? '' : 's'))) + '</p></div>'
        + '<div class="head-actions"><button class="btn tiny" data-proj-act="toggle" data-proj="' + escAttr(pname) + '">' + (expanded ? 'Hide' : 'Manage project') + '</button></div></div>'
        + (expanded ? '' : '<ul class="proj-exp-list">' + summ + '</ul>');
      if (expanded) {
        const built = list.filter((e) => e.snapshot);
        const done = list.filter((e) => e.status === 'completed');
        const totSamples = built.reduce((m, e) => m + (e.snapshot.nSamples || 0), 0);
        const totPools = built.reduce((m, e) => m + (e.snapshot.nPools || 0), 0);
        const modSet = {}; built.forEach((e) => (e.snapshot.modalities || []).forEach((m) => { modSet[m] = 1; }));
        const mods = Object.keys(modSet);
        const bp = isUnfiled ? null : readBatchPlan(pname);
        c += '<div class="proj-detail"><div class="proj-rollup">'
          + '<span class="roll"><span class="roll-n">' + list.length + '</span> experiments</span>'
          + '<span class="roll"><span class="roll-n">' + built.length + '</span> built</span>'
          + '<span class="roll"><span class="roll-n">' + done.length + '</span> completed</span>'
          + '<span class="roll"><span class="roll-n">' + totSamples + '</span> samples</span>'
          + '<span class="roll"><span class="roll-n">' + totPools + '</span> pools</span>'
          + '<span class="roll"><span class="roll-n">' + fmtMoney(total) + '</span> est. cost</span>'
          + '</div>'
          + (mods.length ? '<p class="muted small">Modalities across project: ' + mods.map(esc).join(', ') + '</p>' : '')
          + (bp ? '<p class="muted small">Batch plan: <strong>' + bp.nBatches + ' batches</strong>' + (bp.plan && bp.plan.sizes ? ' \u00b7 sizes [' + bp.plan.sizes.join(', ') + ']' : '') + ' \u00b7 <a href="#" data-proj-act="openBatch" data-proj="' + escAttr(pname) + '">view on Plan project</a></p>' : (isUnfiled ? '' : '<p class="muted small">No batch plan yet \u2014 make one on the <strong>Plan project</strong> tab.</p>'))
          + (isUnfiled ? '' : ' <span class="muted small">Owner: ' + esc(owner || '\u2014') + '</span>');
        if (!isUnfiled) {
          if (CREATE_EXP_FOR === pname) {
            c += '<div class="pm-form"><h3>New experiment in ' + esc(pname) + '</h3><div class="save-grid">'
              + '<label>Experiment name<input type="text" id="ceName" placeholder="e.g. MADI02 batch 1" /></label>'
              + '<label>Date<input type="date" id="ceDate" /></label>'
              + '<label>Planned by<input type="text" id="cePlannedBy" placeholder="e.g. Ashley" /></label>'
              + '</div><div class="row-actions"><button class="btn primary" id="ceCreate">Create experiment</button><button class="btn ghost" id="ceCancel">Cancel</button></div></div>';
          } else {
            c += '<div class="row-actions"><button class="btn primary" data-proj-act="createExp" data-proj="' + escAttr(pname) + '">+ Create experiment</button></div>';
          }
        }
        list.forEach((e) => {
          const s = e.snapshot;
          const info = s ? (s.nSamples + ' samples \u00b7 ' + s.nPools + ' pools \u00b7 est. ' + (s.knownTotal != null ? fmtMoney(s.knownTotal) : '\u2014')) : 'not built yet';
          const expOpen = !!EXPANDED_EXPERIMENTS[e.id];
          const bpE = isUnfiled ? null : bp;
          let batchFlag = '';
          if (bpE) {
            if (e.batchRef) {
              const sz = (bpE.plan && bpE.plan.sizes) ? bpE.plan.sizes[e.batchRef - 1] : null;
              const ok = s && sz != null && s.nSamples === sz;
              batchFlag = ok ? ' <span class="exp-badge batch-ok">batch ' + e.batchRef + '</span>'
                             : ' <span class="exp-badge batch-warn">batch ' + e.batchRef + ' \u2014 diverges</span>';
            } else { batchFlag = ' <span class="exp-badge batch-none">not on batch plan</span>'; }
          }
          const flags = statusBadge(e.status)
            + (s ? '' : ' <span class="exp-badge nobuild">not built</span>')
            + (e.scheduledAt ? '' : ' <span class="exp-badge unsched">not scheduled</span>')
            + ((e.actualUsage && e.actualUsage.deducted && Object.keys(e.actualUsage.deducted).length) ? ' <span class="exp-badge usage-ok">materials logged</span>' : '')
            + batchFlag;
          c += '<div class="exp-card' + (expOpen ? ' is-open' : '') + (CURRENT_EXP_ID === e.id ? ' is-active' : '') + '">'
            + '<div class="exp-card-head"><div class="exp-card-info"><strong>' + esc(e.name) + '</strong> ' + (e.experimentId ? '<span class="exp-id">' + esc(e.experimentId) + '</span> ' : '') + flags
            + '<div class="muted small">' + (e.date ? esc(e.date) + ' \u00b7 ' : '') + info + '</div></div>'
            + '<button class="btn tiny" data-exp-act="manage" data-id="' + e.id + '">' + (expOpen ? 'Hide' : 'Manage') + '</button></div>';
          if (expOpen) {
            const dsum = s ? (s.nSamples + ' samples \u00b7 ' + s.nPools + ' pools'
              + ((s.arms && s.arms.length) ? ' \u00b7 ' + s.arms.map((a) => ({ unsort5: "unsort 5'", asap3: 'ASAP', sort5: "sort 5'", flex: 'Flex' }[a] || a)).join(', ') : '')
              + ((s.modalities && s.modalities.length) ? ' \u00b7 ' + s.modalities.join(', ') : '')
              + (s.knownTotal != null ? ' \u00b7 est. ' + fmtMoney(s.knownTotal) : '')) : 'Not built yet \u2014 open in the planner and build to populate the design.';
            const usage = e.actualUsage;
            const usageSum = (usage && usage.deducted && Object.keys(usage.deducted).some((k) => usage.deducted[k]))
              ? ('Logged \u2014 ' + Object.keys(usage.deducted).filter((k) => usage.deducted[k]).length + ' kit box(es) deducted from inventory' + (usage.recordedAt ? ' (last ' + esc(usage.recordedAt.slice(0, 10)) + ')' : '') + '.')
              : 'No materials logged yet.';
            const schedSum = e.scheduledAt ? ('Scheduled to calendar \u00b7 ' + esc(String(e.scheduledAt).slice(0, 10)))
              : (e.date ? ('Date set: ' + esc(e.date) + ' \u2014 not yet pushed to the calendar.') : 'No date set.');
            const B = (act, label, extra) => '<button class="btn tiny' + (extra || '') + '" data-exp-act="' + act + '" data-id="' + e.id + '">' + label + '</button>';
            const batchSel = (bpE && bpE.plan && bpE.plan.sizes) ? '<label class="inline-date">Batch <select data-exp-batch="' + e.id + '"><option value="">none</option>' + bpE.plan.sizes.map((sz, i) => '<option value="' + (i + 1) + '"' + (e.batchRef === i + 1 ? ' selected' : '') + '>batch ' + (i + 1) + ' (' + sz + ')</option>').join('') + '</select></label>' : '';
            c += '<div class="exp-detail"><div class="exp-detail-head">' + roleChipHTML(e, invState) + '</div>'
              + '<p class="muted small">planned by ' + esc(e.plannedBy || '\u2014') + '</p>'
              // 1) Experimental design
              + '<details class="exp-sec" open><summary>Experimental design</summary>'
              + '<p class="small">' + dsum + '</p>'
              + '<div class="sec-actions">' + B('open', 'Open in planner') + B('pooling', 'Pooling strategy') + B('del', 'Delete experiment', ' danger') + '</div></details>'
              // 2) Experiment sheets
              + '<details class="exp-sec"><summary>Experiment sheets</summary>'
              + (e.driveFolderId
                  ? ('<p class="small">On Drive: <a href="https://drive.google.com/drive/folders/' + escAttr(e.driveFolderId) + '" target="_blank" rel="noopener">experiment folder</a>'
                     + (e.driveFiles && e.driveFiles.summary ? ' \u00b7 <a href="https://docs.google.com/spreadsheets/d/' + escAttr(e.driveFiles.summary) + '/edit" target="_blank" rel="noopener">Experiment summary (Sheet)</a>' : '')
                     + (e.driveFiles && e.driveFiles.labels ? ' \u00b7 <a href="https://docs.google.com/spreadsheets/d/' + escAttr(e.driveFiles.labels) + '/edit" target="_blank" rel="noopener">Tube labels (Sheet)</a>' : '')
                     + (e.driveFiles && e.driveFiles.library ? ' \u00b7 <a href="https://docs.google.com/spreadsheets/d/' + escAttr(e.driveFiles.library) + '/edit" target="_blank" rel="noopener">Library record (Sheet)</a>' : '')
                     + (e.driveFiles && e.driveFiles.protocol ? ' \u00b7 <a href="https://docs.google.com/document/d/' + escAttr(e.driveFiles.protocol) + '/edit" target="_blank" rel="noopener">Protocol (Doc)</a>' : '')
                     + '</p><p class="muted small">Open the live Drive copies above, or generate a fresh download below.</p>')
                  : '<p class="muted small">Build the experiment to create live Google Drive copies (Sheet + Doc) here. Until then, generate downloads below.</p>')
              + '<div class="sec-actions">' + B('drive', 'Export / refresh Drive copies') + B('packet', 'Experiment summary (xlsx)') + B('protocols', 'Protocols') + B('labels', 'Tube labels') + B('libRecord', 'Library record (xlsx)') + B('reagents', 'Reagent checklist') + '</div></details>'
              // 2b) Material versions
              + ((e.materialVersions && e.materialVersions.length)
                  ? ('<details class="exp-sec"><summary>Material versions (' + e.materialVersions.length + ')</summary>'
                     + '<p class="muted small">Each regenerate/export creates a new version. The most recent is used by default; switch back or delete below.</p>'
                     + '<table class="cost-table"><thead><tr><th>Version</th><th>Created</th><th>Files</th><th></th></tr></thead><tbody>'
                     + e.materialVersions.slice().reverse().map((v) => { const cur = (e.currentVersion === v.version);
                         const links = [];
                         if (v.files && v.files.summary) links.push('<a href="https://docs.google.com/spreadsheets/d/' + escAttr(v.files.summary) + '/edit" target="_blank" rel="noopener">Summary</a>');
                         if (v.files && v.files.protocol) links.push('<a href="https://docs.google.com/document/d/' + escAttr(v.files.protocol) + '/edit" target="_blank" rel="noopener">Protocol</a>');
                         if (v.files && v.files.labels) links.push('<a href="https://docs.google.com/spreadsheets/d/' + escAttr(v.files.labels) + '/edit" target="_blank" rel="noopener">Labels</a>');
                         if (v.files && v.files.library) links.push('<a href="https://docs.google.com/spreadsheets/d/' + escAttr(v.files.library) + '/edit" target="_blank" rel="noopener">Library</a>');
                         return '<tr><td>v' + v.version + (cur ? ' <span class="exp-id">current</span>' : '') + '</td><td class="who">' + esc(v.createdAt || '') + '</td><td class="small">' + (links.join(' \u00b7 ') || '\u2014') + '</td>'
                           + '<td>' + (cur ? '' : '<button class="btn tiny" data-exp-act="verUse" data-id="' + e.id + '" data-ver="' + v.version + '">Use</button> ') + '<button class="btn tiny" data-exp-act="verDel" data-id="' + e.id + '" data-ver="' + v.version + '">\u2715</button></td></tr>'; }).join('')
                     + '</tbody></table></details>')
                  : '')
              // 3) Scheduling
              + '<details class="exp-sec"><summary>Scheduling</summary>'
              + '<p class="small">' + schedSum + '</p>'
              + '<div class="sec-actions"><label class="inline-date">Date <input type="date" data-exp-date="' + e.id + '" value="' + escAttr(e.date || '') + '" /></label>' + batchSel + B('reschedule', 'Reschedule to calendar') + '</div></details>'
              // 4) Material usage
              + '<details class="exp-sec"><summary>Material usage</summary>'
              + '<p class="small">' + usageSum + '</p>'
              + '<div class="sec-actions">' + B('recordUsage', 'Record / edit material usage') + B('inv', 'Record reagent lots') + '</div></details>'
              // 5) cDNA & libraries
              + '<details class="exp-sec"><summary>cDNA &amp; libraries</summary>'
              + '<p class="muted small">Library and cDNA tubes generated for this experiment, and the shared sequencing record.</p>'
              + '<div class="sec-actions">' + B('libRecord', 'Library record (xlsx)') + B('libTubes', 'Auto-populate sequencing record') + B('libSend', '\u2192 Add to Library sheet') + '</div></details>'
              + '</div>';
          }
          c += '</div>';
        });
        c += '<div class="row-actions">'
          + (isUnfiled ? '' : '<button class="btn primary" data-proj-act="projSummaryDrive" data-proj="' + escAttr(pname) + '">Project summary \u2192 Drive</button>'
            + '<button class="btn ghost" data-proj-act="projSummaryDl" data-proj="' + escAttr(pname) + '">Download project summary</button>'
            + (function () { const pr = Store.allProjects().find((x) => x.name === pname); return (pr && pr.projectSummaryFileId) ? '<a class="btn ghost" href="https://docs.google.com/spreadsheets/d/' + escAttr(pr.projectSummaryFileId) + '/edit" target="_blank" rel="noopener">Open summary in Drive</a>' : ''; })()
            + '<button class="btn ghost" data-proj-act="projReagents" data-proj="' + escAttr(pname) + '">Export project reagents + cost</button>'
            + '<button class="btn ghost" data-proj-act="projBatches" data-proj="' + escAttr(pname) + '">Export batches + samples</button>'
            + '<button class="btn ghost danger" data-proj-act="delProj" data-proj="' + escAttr(pname) + '">Delete project</button>')
          + '</div></div>';
      }
      c += '</div>';
      return c;
    };

    projNames.forEach((pname) => { html += cardFor(pname, byProj[pname] || [], ownerOf[pname], false); });
    if (unfiled.length) html += cardFor('(unfiled)', unfiled, '', true);
    host.innerHTML = html;

    $('#exportStoreBtn').addEventListener('click', exportStoreJSON);
    $('#importStoreInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importStoreJSON(f); e.target.value = ''; });
    $('#newProjectBtn').addEventListener('click', showNewProjectForm);

    host.querySelectorAll('[data-proj-act]').forEach((b) => b.addEventListener('click', () => {
      const p = b.dataset.proj, act = b.dataset.projAct;
      if (act === 'toggle') { EXPANDED_PROJECTS[p] = !EXPANDED_PROJECTS[p]; if (!EXPANDED_PROJECTS[p] && CREATE_EXP_FOR === p) CREATE_EXP_FOR = null; renderManage(); }
      else if (act === 'createExp') { CREATE_EXP_FOR = p; EXPANDED_PROJECTS[p] = true; renderManage(); const f = $('#ceName'); if (f) f.focus(); }
      else if (act === 'projSummaryDrive') exportProjectSummaryToDrive(p);
      else if (act === 'projSummaryDl') downloadProjectSummary(p);
      else if (act === 'projReagents') projectReagentXlsx(p);
      else if (act === 'projBatches') projectBatchXlsx(p);
      else if (act === 'openBatch') { selectTop('plan', 'planproject'); }
      else if (act === 'delProj') {
        if (confirm('Delete project \u201c' + p + '\u201d? Its experiments are kept but become unfiled.')) {
          Store.deleteProject(p);
          driveApi({ action: 'trashByName', name: p }).catch(() => {});   // move the Drive project folder to trash
          Store.allExperiments().forEach((e) => { if ((e.project || '') === p) { e.project = ''; Store.saveExperiment(e); } });
          renderManage();
        }
      }
    }));

    if (CREATE_EXP_FOR) {
      const cx = $('#ceCancel'); if (cx) cx.addEventListener('click', () => { CREATE_EXP_FOR = null; renderManage(); });
      const cc = $('#ceCreate'); if (cc) cc.addEventListener('click', () => {
        const name = ($('#ceName').value || '').trim();
        if (!name) { alert('Give the experiment a name.'); return; }
        const proj = CREATE_EXP_FOR; CREATE_EXP_FOR = null;
        createExperimentUI({ name: name, project: proj, date: $('#ceDate').value || '', plannedBy: ($('#cePlannedBy').value || '').trim() });
      });
    }

    host.querySelectorAll('input[data-exp-date]').forEach((inp) => inp.addEventListener('change', () => {
      const rec = Store.getExperiment(inp.dataset.expDate); if (!rec) return;
      rec.date = inp.value || ''; Store.saveExperiment(rec); renderManage();
      if (window.Scheduling) Scheduling.render($('#schedulingContent'));
    }));

    host.querySelectorAll('select[data-exp-batch]').forEach((sel) => sel.addEventListener('change', () => {
      const rec = Store.getExperiment(sel.dataset.expBatch); if (!rec) return;
      rec.batchRef = sel.value ? Number(sel.value) : null; Store.saveExperiment(rec); renderManage();
    }));

    host.querySelectorAll('button[data-exp-act]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.id, act = b.dataset.expAct;
      if (act === 'manage') {
        const wasOpen = !!EXPANDED_EXPERIMENTS[id];
        EXPANDED_EXPERIMENTS = {};                 // single-open accordion
        if (!wasOpen) {
          EXPANDED_EXPERIMENTS[id] = true;
          CURRENT_EXP_ID = id;
          const r = Store.getExperiment(id); CURRENT_PROJECT = r ? (r.project || null) : CURRENT_PROJECT;
          updatePlanExpBar();
        }
        renderManage();
      }
      else if (act === 'open') openExperiment(id);
      else if (act === 'drive') {
        const r = Store.getExperiment(id);
        if (!r || !r.snapshot) { alert('Build the experiment first (Open in planner \u2192 build), then it can be exported to Drive.'); return; }
        if (!confirm('This will generate a NEW version of the experiment materials (summary, protocol, labels, library) in Drive. The previous version is kept. Continue?')) return;
        openExperiment(id);
        try { openExperimentProtocols(id); } catch (err) { /* protocol render optional */ }
        exportExperimentToDrive(r, { newVersion: true }).then(() => renderManage()).catch(() => renderManage());
      }
      else if (act === 'verUse') {
        const r = Store.getExperiment(id); const ver = parseInt(b.getAttribute('data-ver'), 10);
        const v = (r.materialVersions || []).filter((x) => x.version === ver)[0];
        if (v) { r.currentVersion = ver; r.driveFiles = Object.assign({}, v.files); Store.saveExperiment(r); renderManage(); }
      }
      else if (act === 'verDel') {
        const r = Store.getExperiment(id); const ver = parseInt(b.getAttribute('data-ver'), 10);
        const v = (r.materialVersions || []).filter((x) => x.version === ver)[0];
        if (v && confirm('Delete materials version v' + ver + '? This trashes its Drive folder.')) {
          r.materialVersions = (r.materialVersions || []).filter((x) => x.version !== ver);
          if (v.folderId) driveApi({ action: 'trash', id: v.folderId }).catch(() => {});
          if (r.currentVersion === ver) { const latest = r.materialVersions[r.materialVersions.length - 1]; r.currentVersion = latest ? latest.version : null; r.driveFiles = latest ? Object.assign({}, latest.files) : {}; }
          Store.saveExperiment(r); renderManage();
        }
      }
      else if (act === 'reschedule') { CURRENT_EXP_ID = id; updatePlanExpBar(); selectTop('plan', 'scheduling'); }
      else if (act === 'inv') recordInventoryUI(id);
      else if (act === 'del') { const r = Store.getExperiment(id); if (r && confirm('Delete \u201c' + r.name + '\u201d? This cannot be undone.')) { if (CURRENT_EXP_ID === id) { CURRENT_EXP_ID = null; updatePlanExpBar(); } const folder = r.driveFolderId; Store.deleteExperiment(id); if (folder) driveApi({ action: 'trash', id: folder }).catch(() => {}); pushReservedToSheet(); renderManage(); } }
      else if (act === 'packet') experimentWorkbookXlsx(id);
      else if (act === 'protocols') openExperimentProtocols(id);
      else if (act === 'labels') { openExperiment(id); generateTubeLabels(); }
      else if (act === 'libRecord') { openExperiment(id); generateLibraryRecord(); }
      else if (act === 'libSend') { openExperiment(id); sendLibraryToSheet(); }
      else if (act === 'libTubes') { openExperiment(id); sendLibraryTubesToRecord(); }
      else if (act === 'pooling') { openExperiment(id); downloadPoolingXlsx(); }
      else if (act === 'recordUsage') recordUsageUI(id);
      else if (act === 'reagents') experimentReagentChecklist(id);
    }));

    inventoryBadge();
  }

  function showNewProjectForm() {
    const box = $('#pmForms'); if (!box) return;
    box.innerHTML = '<div class="pm-form"><h3>New project</h3><div class="save-grid">'
      + '<label>Project name<input type="text" id="npName" placeholder="e.g. MADI dyads" /></label>'
      + '<label>Project ID (2&ndash;3 letters)<input type="text" id="npAbbrev" maxlength="3" placeholder="e.g. BCP" style="text-transform:uppercase" /></label>'
      + '<label>Owner<input type="text" id="npOwner" placeholder="e.g. Ashley" /></label>'
      + '</div><div class="row-actions"><button class="btn primary" id="npCreate">Create project</button><button class="btn ghost" id="npCancel">Cancel</button></div></div>';
    $('#npCancel').addEventListener('click', () => { box.innerHTML = ''; });
    $('#npCreate').addEventListener('click', () => {
      const name = ($('#npName').value || '').trim();
      if (!name) { alert('Enter a project name.'); return; }
      const abbrev = ($('#npAbbrev').value || '').trim().toUpperCase();
      if (!/^[A-Z]{2,3}$/.test(abbrev)) { alert('Enter a 2\u20133 letter Project ID (letters only), e.g. BCP.'); return; }
      if (Store.allProjects().some((p) => (p.abbreviation || '').toUpperCase() === abbrev)) { alert('Project ID \u201c' + abbrev + '\u201d is already used by another project. Choose a different one.'); return; }
      Store.saveProject({ name: name, abbreviation: abbrev, owner: ($('#npOwner').value || '').trim() });
      driveApi({ action: 'ensurePath', project: name }).catch(() => {});   // create the Drive project folder
      box.innerHTML = ''; EXPANDED_PROJECTS[name] = true; renderManage();
    });
  }

  function experimentReagentChecklist(id) {
    const rec = Store.getExperiment(id);
    if (!rec || !rec.snapshot) { alert('Build this experiment first (Open in planner \u2192 Build the plan \u2192 Save).'); return; }
    const s = rec.snapshot;
    const rows = [['\u2713', 'Category', 'Reagent', 'Item ID', 'Quantity', 'Unit']];
    (s.reagents || []).forEach((r) => rows.push(['', r.category || '', r.reagent || '', r.itemId || '', (r.quantity != null ? r.quantity : r.totalAmount), r.units || '']));
    (s.lineItems || []).filter((li) => li.category === '10x kits').forEach((li) => rows.push(['', '10x kits', li.label || '', li.itemId || '', li.qty, li.unit || 'kits']));
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 4 }, { wch: 16 }, { wch: 34 }, { wch: 9 }, { wch: 12 }, { wch: 10 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Reagent checklist');
    XLSX.writeFile(wb, 'reagent_checklist_' + projectLabel(rec.name) + '.xlsx');
  }

  // ---- helpers --------------------------------------------------------------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }
  // ---- boot -----------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initGrid();
    renderOptions();
    initPopulationBuilder();
    initPlanUI();
    loadData();
    resetPoolingPreview();

    $('#runPlan').addEventListener('click', runPlan);
    $('#loadExample').addEventListener('click', loadMadiExample);
    $('#addGridRow').addEventListener('click', () => addRow());
    $('#addGridCol').addEventListener('click', () => addColumn());
    $('#clearGrid').addEventListener('click', () => { if (!GRID_ROWS.length || confirm('Clear all samples?')) clearGrid(); });
    const blBtn = $('#batchLoadBtn');
    if (blBtn) blBtn.addEventListener('click', () => {
      const cur = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
      const proj = (cur && cur.project) ? cur.project : CURRENT_PROJECT;
      const bp = proj ? readBatchPlan(proj) : null;
      const n = Number($('#batchLoadSel').value);
      if (!bp) { alert('No batch plan found for this project. Make one on the Plan project tab.'); return; }
      if (GRID_ROWS.length && !confirm('Replace the current samples with batch ' + n + '?')) return;
      const loaded = loadBatchIntoGrid(bp, n);
      const note = $('#batchLoadNote'); if (note) note.textContent = loaded ? ('Loaded ' + loaded + ' samples from batch ' + n) : 'That batch has no samples';
    });

    $('#computePooling').addEventListener('click', () => runComputePooling(true, true));
    $('#downloadPooling').addEventListener('click', downloadPoolingXlsx);
    const tlb = $('#tubeLabelsBtn'); if (tlb) tlb.addEventListener('click', generateTubeLabels);
    $('#poolingReupload').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) handlePoolingReupload(f);
      e.target.value = '';
    });
    $('#poolingStatus').addEventListener('click', (e) => {
      if (e.target.id === 'clearPoolingOverrideInline') { POOL_OVERRIDE = null; runComputePooling(); }
    });

    // experiments / projects — hydrate from the shared Drive store first, then render
    Store.hydrateFromDrive().then((res) => {
      healExperimentBlobs();   // migrate any base64 images off records so they sync cleanly
      renderManage();
      updatePlanExpBar();
      if (typeof refreshProjectDatalist === 'function') refreshProjectDatalist();
      if (!res.ok) console.warn('[experiments] Drive store unavailable; using local cache.');
    });
    renderManage();
    updatePlanExpBar();
    updateContextBar();
    wireContextBar();
    selectTop('projects');
    // keep an open tab in sync with others' changes: re-pull when it regains focus
    let _lastSync = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - _lastSync > 5000) {
        _lastSync = Date.now();
        Store.hydrateFromDrive().then(() => { renderManage(); updatePlanExpBar(); });
      }
    });
    const sp = $('#savePlanBtn'); if (sp) sp.addEventListener('click', saveExperimentUI);
    const bp = $('#backToProjectsBtn'); if (bp) bp.addEventListener('click', () => { selectTop('projects'); });
  });
})();

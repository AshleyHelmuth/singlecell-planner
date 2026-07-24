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
  let PLAN_INPUT = 'grid'; // 'grid' (real samples) | 'counts' (planning: synthesize from counts)
  let SORT_SEL = new Set((window.Pooling && Pooling.SORT_MODEL) ? Pooling.SORT_MODEL.DEFAULT_ON : ['HSC', 'pDC', 'cDC', 'Treg']);

  // ---- Tabs -----------------------------------------------------------------
  function initTabs() {
    $$('.tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.tab').forEach((b) => { b.classList.remove('is-active'); b.setAttribute('aria-selected', 'false'); });
        $$('.panel').forEach((p) => p.classList.remove('is-active'));
        btn.classList.add('is-active'); btn.setAttribute('aria-selected', 'true');
        $('#tab-' + btn.dataset.tab).classList.add('is-active');
        if (btn.dataset.tab === 'scheduling' && window.Scheduling) Scheduling.render($('#schedulingContent'));
        if (btn.dataset.tab === 'inventory') renderInventory();
        if (btn.dataset.tab === 'projects') renderManage();
      });
    });
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
      if (kits.length || reagents.length || oligos.length || antibodies.length) {
        DATA.liveInventory = kits.concat(reagents, oligos, antibodies);
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
    host.innerHTML = M.POPULATIONS.map((p) =>
      '<button type="button" class="pop-btn' + (SORT_SEL.has(p) ? ' active' : '') + '" data-sortpop="' + p + '">' +
      esc(M.DISPLAY[p] || p) + '</button>').join('');
    host.onclick = (e) => {
      const b = e.target.closest('[data-sortpop]'); if (!b) return;
      const p = b.dataset.sortpop;
      if (SORT_SEL.has(p)) SORT_SEL.delete(p); else SORT_SEL.add(p);
      b.classList.toggle('active');
      onSelectionChange();
      if (poolingReady()) runComputePooling(false);
    };
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
  function laneOverridesFromCost(nSamples, nPools, samples) {
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
      scenField('unsortAmt', 'Unsort cells / pool (after modality split)', 1200000, { explain: 'allcells' }) +
      scenField('effUnsort', 'Unsort stain/wash efficiency', 0.85, { tag: 'A', explain: 'stainingTarget', step: 'any' }) +
      scenField('cellsLoadedPerLane', 'Cells loaded / lane (unsort & sort)', 85000, { tag: 'LAB', explain: 'cellsLoadedPerLane' }) +
      scenField('rawRecovery', 'Targeted recovery / lane, pre-QC (unsort & sort)', 45000, { tag: 'EST', explain: 'rawRecoveryPerLane' }) +
      scenField('qcRecovery', 'Targeted post-QC recovery / lane (unsort & sort)', 30000, { tag: 'EST', explain: 'qcRecoveryPerLane' }) +
      '</fieldset>';

    const asap = '<fieldset class="opt-card" data-group="asap" hidden><legend>ASAP-seq arm</legend>' +
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
      vdj: arms.some((a) => (a.libraries || []).some((l) => /VDJ/.test(l))) || arms.some((a) => a.chem === 'cite5' || a.population === 'sorted'),
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
      return `<th class="col-custom">
        <input type="text" class="col-name-input" data-col-index="${c.customIndex}" value="${escAttr(c.label)}" />
        <button type="button" class="col-remove" data-col-index="${c.customIndex}" title="Remove column">×</button>
      </th>`;
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
    POOL_OVERRIDE = null;
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
    POOL_OVERRIDE = null;
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

  function renderPoolingPreview(calc, scrollToResult) {
    const { poolRes, htoRes, usedOverride, confounderCols } = calc;
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

    $('#poolingPreview').innerHTML = `
      ${warnHTML}
      <table class="cost-table"><thead><tr><th>Pool</th><th>HTO</th><th>Super-pool</th><th class="num">Samples</th>${confHeads}</tr></thead><tbody>${rows}</tbody></table>
      ${compositionHTML}
      <div id="poolingOptionsHost"></div>
      <h3>Pipeline cell-flow (this strategy)</h3>
      <div id="pipelineFlow"></div>`;

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
          nSamples, samplesPerPool: poolRes.nPools ? Math.round(nSamples / poolRes.nPools) : nSamples,
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
    $('.tab[data-tab="workflow"]').click();
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

  function renderReagents(plan, cost) {
    LAST_COST = cost; LAST_PLAN = plan;
    const byCat = {};
    cost.lineItems.forEach((li) => { (byCat[li.category] = byCat[li.category] || []).push(li); });

    const REAGENT_CATS = ['Antibodies & staining', 'Buffers & reagents', 'Plasticware & consumables'];
    const order = ['10x kits'].concat(REAGENT_CATS, ['Sequencing']);
    const cats = order.filter((c) => byCat[c]).concat(Object.keys(byCat).filter((c) => order.indexOf(c) === -1));

    const tables = cats.map((cat) => {
      const items = byCat[cat];
      if (REAGENT_CATS.indexOf(cat) !== -1) {
        const rows = items.map((li) => `
          <tr class="${li.placeholder ? 'is-placeholder' : ''}">
            <td>${esc(li.label)}</td>
            <td class="num">${fmtAmount(li)}</td>
            <td class="num">${fmtOrderQty(li)}</td>
            <td>${esc(li.scope || '')}</td>
            <td class="num">${li.total == null ? '<span class="ph-tag">no price</span>' : fmtMoney(li.total)}</td>
            <td class="src">${li.note ? esc(li.note) : ''}</td>
          </tr>`).join('');
        return `<h3>${esc(cat)}</h3><table class="cost-table">
          <thead><tr><th>Reagent</th><th class="num">Total needed</th><th class="num">Order qty</th><th>Scope</th><th class="num">Est. cost</th><th>Notes</th></tr></thead>
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
      <h3>Lanes per load</h3>
      <table class="cost-table"><thead><tr><th>Population &middot; modality</th><th class="num">Lanes</th><th>Libraries</th><th>Basis</th></tr></thead><tbody>${laneRows}</tbody></table>
      ${tables}`;

    const eb = $('#exportReagentsBtn');
    if (eb) eb.addEventListener('click', downloadReagentXlsx);
  }

  function downloadReagentXlsx() {
    if (!LAST_COST) return;
    const cost = LAST_COST;
    const header = ['Category', 'Reagent', 'Item ID', 'Total needed', 'Units', 'Order quantity', 'Scope', 'Est. cost ($)', 'Notes / source'];
    const rows = [header];
    const REAGENT_CATS = ['Antibodies & staining', 'Buffers & reagents', 'Plasticware & consumables'];
    // reagents first (the user's focus), then kits + sequencing
    const orderedCats = REAGENT_CATS.concat(['10x kits', 'Sequencing']);
    const seen = new Set();
    const emit = (li) => {
      const isReagent = ('totalAmount' in li);
      rows.push([
        li.category || '',
        li.label || '',
        li.itemId || '',
        isReagent ? (li.totalAmount == null ? '' : li.totalAmount) : (li.qty == null ? '' : li.qty),
        isReagent ? (li.units || '') : (li.unit || ''),
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

    const prepPage = `<article class="protocol-page">
        <header class="pp-head"><span class="pp-no">Protocol 0</span><h2>Pre-experiment preparation &mdash; media &amp; buffers</h2></header>
        <p class="pp-meta"><strong>When:</strong> 1&ndash;3 days before &middot; <strong>Source:</strong> MADI02 batch protocol + CITE-seq batch protocol</p>
        ${prepProtocol(plan)}
      </article>`;

    const pages = prepPage + active.filter((id, i, a) => a.indexOf(id) === i).map((id, idx) => {
      const st = stagesById[id];
      const title = st ? st.name + ' — ' + (st.description || '') : id;
      const body = expanded[id] || placeholderProtocol(st);
      return `<article class="protocol-page">
        <header class="pp-head"><span class="pp-no">Protocol ${idx + 1}</span><h2>${esc(title)}</h2></header>
        ${st ? `<p class="pp-meta"><strong>When:</strong> ${esc(st.timeWindow || 'TBD')} · <strong>Staffing:</strong> ${esc(st.personnelRule || 'TBD')} · <strong>Source:</strong> ${esc(st.sourceDoc || '—')}</p>` : ''}
        ${body}
      </article>`;
    }).join('');

    $('#protocolsContent').innerHTML = `
      <div class="section-head"><h2>Protocol packet</h2><button class="btn primary" onclick="window.print()">Print packet</button></div>
      <p class="muted">Workflow summary first, then one page per module. Use “Print packet” → Save as PDF for a printable version (each protocol starts on a new page).</p>
      <article class="protocol-page cover">
        <header class="pp-head"><span class="pp-no">Overview</span><h2>Experiment workflow</h2></header>
        <div class="flow-holder">${Workflow.renderSampleFlow(plan)}</div>
        ${Workflow.renderWeekFlow(plan, DATA)}
      </article>
      ${pages}`;
  }

  function thawProtocol(plan) {
    const nThaw = Math.max(1, Math.ceil(plan.nSamples / 18));
    return reagentHeader('ST1', plan, { foot: 'Per-sample amounts from the Pre_GEM_Consumables Thaw column, scaled to the ' + plan.nSamples + ' samples in this plan.' }) + `
      <p><strong>Materials:</strong> ${plan.nSamples}× 15 mL pre-labeled conical tubes, ${plan.nSamples}× Thawsome adaptors, counting plates, ${plan.nPools}× FACS tubes.</p>
      <p><strong>Reagents:</strong> Complete RPMI (10 mL × ${plan.nSamples} = ${plan.nSamples * 10} mL), DNase, AOPI cell dye.</p>
      <ol>
        <li>Warm complete RPMI (37 °C); set centrifuge to room temp. Thaw DNase.</li>
        <li>Prepare RPMI + DNase (0.1 mg/mL): aliquot 10 mL into each pre-labeled 15 mL tube (~${plan.nSamples * 10} mL total; allow 20 min to warm before removing cells from LN₂).</li>
        <li>Centrifuge-thaw: invert cryovial into Thawsome on the 15 mL conical with media. Open frozen vials away from your face. Spin 10 min @ 350g, 25 °C.</li>
        <li>While spinning, prepare "RPMI-DNase-low" (50 mL RPMI + 125 µL 10 mg/mL DNase = 0.025 mg/mL) — one tube per thawer (${nThaw} thawers).</li>
        <li>Pour off supernatant, add 2 mL RPMI-DNase-low, resuspend gently. Count 20 µL with AOPI dye.</li>
        <li>Incubate 10 min @ 37 °C, then move all tubes to ice for the rest of the experiment.</li>
        <li>Export counts → use the pooling volumes (next protocol) to determine µL/sample.</li>
      </ol>
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
    const nBottles = Math.max(2, Math.ceil((plan.nSamples * 12) / 500) + 1);
    return `
      <p>Prepare media, buffers and stocks 1&ndash;3 days ahead. Filter-sterilize buffers and store at 4&nbsp;&deg;C. Make DNase stock fresh from powder and store aliquots at &minus;20&nbsp;&deg;C.</p>
      <div class="recipe-box"><h5>R10 media (thaw + wash) &mdash; ~${nBottles} &times; 500&nbsp;mL bottles</h5>
        <table><tr><th>Component</th><th>Per 500&nbsp;mL bottle</th></tr>
        <tr><td>RPMI 1640 (phenol-free if stim on pregnancy samples)</td><td class="num">440&nbsp;mL</td></tr>
        <tr><td>FBS</td><td class="num">50&nbsp;mL</td></tr>
        <tr><td>1&nbsp;M HEPES</td><td class="num">5&nbsp;mL</td></tr>
        <tr><td>100&times; pen-strep</td><td class="num">5&nbsp;mL</td></tr></table></div>
      <div class="recipe-box"><h5>CITE-seq staining / wash buffer (1&times; PBS + 2% BSA)</h5>
        <table><tr><th>Component</th><th>Amount</th></tr>
        <tr><td>BSA (from powder)</td><td class="num">10&nbsp;g / 500&nbsp;mL PBS</td></tr>
        <tr><td>1&times; PBS</td><td class="num">to 500&nbsp;mL, then 0.22&nbsp;µm filter</td></tr></table></div>
      <div class="recipe-box"><h5>FACS sort buffer (1&times; PBS + 50% FBS)</h5>
        <table><tr><th>Component</th><th>Amount</th></tr>
        <tr><td>1&times; PBS</td><td class="num">50&nbsp;mL</td></tr><tr><td>FBS</td><td class="num">50&nbsp;mL</td></tr></table></div>
      <div class="recipe-box"><h5>DNase</h5>
        <table><tr><th>Use</th><th>Prep</th></tr>
        <tr><td>Thaw media (0.1&nbsp;mg/mL)</td><td>10&nbsp;mg/mL stock into warm R10</td></tr>
        <tr><td>&ldquo;RPMI-DNase-low&rdquo; (0.025&nbsp;mg/mL)</td><td>125&nbsp;µL 10&nbsp;mg/mL stock per 50&nbsp;mL R10</td></tr></table></div>
      <p><strong>ASAP-seq buffers</strong> (make fresh, keep on ice; incubate digitonin at 65&nbsp;&deg;C 10&nbsp;min before use):</p>
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
      <p>Staining the six per-pool unsort tubes (unsort5p1&hellip;${plan.nPools}), then combining and staining the surface-protein panel. Keep everything cold; minimise washes to protect viability.</p>
      <ol>
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
      <p class="pp-source">Source: CITE-seq batch2 protocol &ldquo;Unsort 5&prime; panel staining&rdquo; + MADI02 batch1.</p>`;
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
      <p>ASAP-seq hashes and surface-stains like CITE-seq, then fixes, lightly lyses to nuclei, and transposes. Based on the CHI ASAP-seq protocol.</p>
      <ol>
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
      <p class="pp-source">Source: CHI ASAP-seq protocol (2022 + Yona&rsquo;s notes) via CITE-seq batch2; MADI02 batch1.</p>`;
  }

  // ---- Sort staining --------------------------------------------------------
  function sortStainProtocol(plan) {
    return reagentHeader('ST5', plan, { foot: 'From the Pre_GEM_Consumables Sort column. Each sort pool gets the fluorophore antibody cocktail (≈61.5&nbsp;µL) + 5&nbsp;µL of its TotalSeq-C HTO to a 200&nbsp;µL stain.' }) + `
      <p>Live/dead + surface-marker staining of the six sort pools (sort5p1&hellip;${plan.nPools}) for FACS into HSC, pDC, cDC and Treg. Work on ice with the hood lights off once L/D dye is added.</p>
      <ol>
        <li><strong>Pre-wash.</strong> Top up each remaining pool tube with 1&times; PBS (to ~40&nbsp;mL), spin 400g 5&nbsp;min 4&nbsp;&deg;C, pour off, wash once more with PBS. (Removes proteins that interfere with the L/D stain.)</li>
        <li><strong>Live/Dead.</strong> Resuspend each tube in <strong>2&nbsp;mL Zombie Red 1:1000</strong> in PBS (0.5&nbsp;µL dye/tube-equivalent; dilute 1.5&nbsp;µL stock into 1500&nbsp;µL PBS for the batch). Incubate 20&nbsp;min on ice, dark.</li>
        <li>Add 2&nbsp;mL FACS buffer, spin, then resuspend in ~123.5&nbsp;µL FACS buffer. Add <strong>10&nbsp;µL Fc block</strong>, mix, incubate 5&nbsp;min on ice.</li>
        <li><strong>Surface stain.</strong> To each pool add <strong>61.5&nbsp;µL sort Ab cocktail</strong> + <strong>5&nbsp;µL of the pool&rsquo;s TotalSeq-C HTO</strong> &rarr; 200&nbsp;µL total. Incubate 20&nbsp;min on ice, dark.</li>
        <li>Wash 2&times; with 2&nbsp;mL FACS buffer (spin 400g 5&nbsp;min 4&nbsp;&deg;C). Resuspend to ~10M cells/mL (~1&nbsp;mL); count.</li>
        <li>Pool the ${plan.nPools} hashtagged sort pools into ~2 FACS tubes; filter through the cap filter. Prepare an unstained control (ALLCELLS leukopak in 500&nbsp;µL FACS buffer, filtered).</li>
        <li><strong>Sort</strong> (70&nbsp;µm nozzle, into 50% FBS) into HSC, pDC, cDC, Treg collection tubes.</li>
        <li><strong>Post-sort:</strong> spin (save supernatant), resuspend; combine pDC+HSC into one lane; Treg and cDC can take their own lanes. Concentrate to ~77.4&nbsp;µL/lane and proceed to loading.</li>
      </ol>
      <div class="recipe-box"><h5>5&prime; sort antibody panel (per pool; &times;${plan.nPools} + controls)</h5>
        <table><tr><th>Channel</th><th>Marker</th><th>µL / pool</th></tr>
        <tr><td>staining buffer</td><td>&mdash;</td><td class="num">10</td></tr>
        <tr><td>BV785</td><td>CD19</td><td class="num">5</td></tr><tr><td>BV711</td><td>CD56</td><td class="num">5</td></tr>
        <tr><td>BV650</td><td>CD127</td><td class="num">5</td></tr><tr><td>BV605</td><td>CD4</td><td class="num">4</td></tr>
        <tr><td>BV510</td><td>CD123</td><td class="num">5</td></tr><tr><td>AF488</td><td>CD3</td><td class="num">4</td></tr>
        <tr><td>PE-Cy5</td><td>CD25</td><td class="num">5</td></tr><tr><td>PE</td><td>CD11c</td><td class="num">3.5</td></tr>
        <tr><td>APC-Cy7</td><td>CD14</td><td class="num">5</td></tr><tr><td>AF700</td><td>CD45</td><td class="num">5</td></tr>
        <tr><td>AF647</td><td>CD34</td><td class="num">5</td></tr>
        <tr><td>PE-TexasRed</td><td>L/D (Zombie Red, 1:1000)</td><td class="num">&mdash;</td></tr>
        <tr><td colspan="2"><strong>Total antibody / pool</strong></td><td class="num"><strong>61.5</strong></td></tr></table></div>
      <p class="pp-source">Source: MADI02 batch1 &amp; CITE-seq batch2 sort panels.</p>`;
  }

  // ---- Bulk RNA / TriZol ----------------------------------------------------
  function bulkProtocol(plan) {
    return reagentHeader('ST14', plan, { foot: 'Per-sample TriZol reserve set aside before pooling (100&ndash;500K cells/sample), needed for SNP demultiplexing of the pooled donors.' }) + `
      <p>Reserve 100&ndash;500K cells per sample (before pooling) for bulk RNA-seq. Work under RNA-free conditions; RNA-Away gloves; TriZol in the hood only, kept cold and dark.</p>
      <ol>
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
      <ol>
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
      <ol>
        <li>At least 30&nbsp;min before loading, thaw the master-mix reagents to RT; take the RT enzyme out only right before use. (GEM-X 5&prime; v3: thaw RT primer &mdash; stored at &minus;80&nbsp;&deg;C with the beads &mdash; RT reagent mix, and additive A.)</li>
        <li><strong>Load target:</strong> GEM-X 5&prime; v3 &mdash; 85,000 cells/lane; dilute to 85,000&nbsp;/&nbsp;77.4&nbsp;µL &asymp; 1.1&times;10⁶ cells/mL in 1&times; PBS; load 77.4&nbsp;µL/lane. (~650&nbsp;µL covers 8 lanes.)</li>
        <li>Filter through a Flowmi strainer immediately before loading.</li>
        <li>For sorted fractions, combine low-yield populations onto shared lanes (e.g. pDC+HSC on one lane; Treg and cDC on their own).</li>
        <li>After GEM generation, proceed to the RT step and library construction in the 10x protocol (GEX / V(D)J / ADT; ATAC path for ASAP).</li>
      </ol>
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
  let SELECTED_PROJECT = '__all__';
  let EXPANDED_PROJECTS = {};
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
      sortSel: sortSelList(),
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
    Store.saveExperiment(rec);
    CURRENT_EXP_ID = rec.id;
    resetPlanEditor();
    renderManage();
    updatePlanExpBar();
    $('.tab[data-tab="plan"]').click();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    flashSaveStatus('New experiment \u201c' + rec.name + '\u201d \u2014 build the plan, then Save.', true);
  }

  function updatePlanExpBar() {
    const cur = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    const lbl = $('#currentExpLabel');
    if (lbl) {
      lbl.textContent = cur ? ('Building: ' + (cur.name || 'experiment') + (cur.project ? ' \u00b7 ' + cur.project : '')) : 'No experiment selected';
      lbl.classList.toggle('is-saved', !!cur);
    }
    const hint = $('#noExpHint'); if (hint) hint.hidden = !!cur;
    const sb = $('#savePlanBtn'); if (sb) sb.disabled = !cur;
  }

  // Build a tube-label sheet (one row per physical tube) from the pooling
  // strategy + selected modalities. Columns: Tube, Line 1, Line 2, Line 3.
  function generateTubeLabels() {
    const calc = computePooling();
    if (!calc || !calc.samples.length) { alert('Add samples and compute a pooling strategy first.'); return; }
    const curRec = CURRENT_EXP_ID ? Store.getExperiment(CURRENT_EXP_ID) : null;
    const exp = (curRec && curRec.name) ? curRec.name : 'Experiment';
    const arms = buildArmInstances(SEL);
    const hasUnsort = arms.some((a) => a.population === 'unsorted' && a.chem === 'cite5');
    const hasAsap = arms.some((a) => a.chem === 'asap');
    const hasSort = arms.some((a) => a.population === 'sorted' || a.laneMode === 'perSortPop');

    // pool number per sampleId, and HTO per pool
    const poolOf = {};
    calc.poolRes.pools.forEach((pool, i) => pool.forEach((s) => { poolOf[s.sampleId] = i + 1; }));
    const htoByPool = {}; calc.htoRes.assignments.forEach((x) => { htoByPool[x.pool] = x.hto; });
    const superPoolByPool = {}; calc.htoRes.superPools.forEach((grp, sp) => grp.forEach((p) => { superPoolByPool[p] = sp; }));
    const htoNum = (i) => { const v = htoByPool[i] || ''; const m = /(\d+)/.exec(v); return m ? m[1] : (i + 1); };
    const nPools = calc.poolRes.nPools;
    const multiSP = calc.htoRes.superPools.length > 1;

    const header = ['Tube', 'Line 1', 'Line 2', 'Line 3'];
    const rows = [header];
    const add = (tube, l1, l2, l3) => rows.push([tube, l1 == null ? '' : String(l1), l2 == null ? '' : String(l2), l3 == null ? '' : String(l3)]);

    // 1) original sample tubes: Line1 = sample number, Line2 = pool number, Line3 = sample name / patient
    calc.samples.forEach((s, idx) => {
      const name = s.sampleId + (s.patientId && s.patientId !== s.sampleId ? ' / ' + s.patientId : '');
      add('Sample', idx + 1, 'pool ' + (poolOf[s.sampleId] || '?'), name);
    });

    // 2) one 50 mL tube per pool: "pool N"
    for (let i = 0; i < nPools; i++) add('Pool (50 mL)', 'pool ' + (i + 1), '50 mL pool', exp);

    // 3) FACS tubes per pool per modality branch + HTO # and type
    const facs = (label, prefix, htoType, note) => {
      for (let i = 0; i < nPools; i++) {
        add(label, prefix + (i + 1), htoType + ' HTO ' + htoNum(i), note);
      }
    };
    if (hasUnsort) facs("FACS 5' unsort", 'unsort5p', 'TotalSeq-C', '1.2M from pool');
    if (hasAsap) facs('FACS ASAP', 'asap3p', 'TotalSeq-A', '1.2M from pool');
    if (hasSort) facs("FACS 5' sort", 'sort5p', 'TotalSeq-C', 'remainder from pool');

    // 4) super-pool tubes: one per modality (per super-pool group if >1)
    const superLabel = (base) => {
      if (!multiSP) { add('Super-pool', base + ' super-pool', exp, ''); return; }
      calc.htoRes.superPools.forEach((grp, sp) => add('Super-pool', base + ' super-pool ' + (sp + 1), exp, 'pools ' + grp.map((p) => p + 1).join(',')));
    };
    if (hasUnsort) superLabel('unsort5p');
    if (hasAsap) superLabel('asap3p');
    if (hasSort) superLabel('sort5p');

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 16 }, { wch: 14 }, { wch: 20 }, { wch: 26 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Tube labels');
    XLSX.writeFile(wb, 'tube_labels_' + exp.replace(/[^A-Za-z0-9._-]+/g, '_') + '.xlsx');
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
    $('.tab[data-tab="plan"]').click();
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
    $('.tab[data-tab="protocols"]').click();
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

  // ---- per-experiment workbook (pooling + reagents + pricing + summary) ------
  // ---- Drive export ---------------------------------------------------------
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const GSHEET_MIME = 'application/vnd.google-apps.spreadsheet';
  const HTML_MIME = 'text/html';
  const GDOC_MIME = 'application/vnd.google-apps.document';

  function wbBase64(wb) { return XLSX.write(wb, { bookType: 'xlsx', type: 'base64' }); }
  function htmlBase64(html) { return btoa(unescape(encodeURIComponent(html))); }
  function driveApi(payload) {
    return fetch('/api/drive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then((r) => r.json());
  }

  // Auto-export a built experiment's artifacts to its Drive folder as native
  // Google files. Fire-and-forget from the build; logs but never blocks the UI.
  async function exportExperimentToDrive(rec) {
    try {
      if (!rec || !rec.snapshot) return;
      const project = rec.project || 'Unfiled';
      const path = await driveApi({ action: 'ensurePath', project: project, experiment: rec.name || 'Experiment' });
      if (!path || !path.ok || !path.experimentId) { console.warn('[drive] ensurePath failed', path); return; }
      if (rec.driveFolderId !== path.experimentId) {
        rec.driveFolderId = path.experimentId; rec.driveProjectId = path.projectId; Store.saveExperiment(rec);
      }
      // Experiment summary (Summary + Pooling + Reagents + Pricing) -> Google Sheet
      await driveApi({ action: 'upload', name: 'Experiment summary', folderId: path.experimentId,
        base64: wbBase64(buildExperimentWb(rec)), sourceMime: XLSX_MIME, targetMime: GSHEET_MIME });
      // Protocol packet (rendered HTML) -> Google Doc
      const protoEl = document.getElementById('protocolsContent');
      if (protoEl && protoEl.innerHTML.trim()) {
        const html = '<html><head><meta charset="utf-8"></head><body>' + protoEl.innerHTML + '</body></html>';
        await driveApi({ action: 'upload', name: 'Protocol', folderId: path.experimentId,
          base64: htmlBase64(html), sourceMime: HTML_MIME, targetMime: GDOC_MIME });
      }
      console.log('[drive] exported', project + '/' + (rec.name || 'Experiment'));
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
    const tabBtn = $('.tab[data-tab="inventory"]'); if (!tabBtn) return;
    let n = 0;
    try { n = computeInventoryState().items.filter((i) => i.status === 'out' || i.status === 'low').length; } catch (e) { n = 0; }
    let b = tabBtn.querySelector('.tab-badge');
    if (n) { if (!b) { b = document.createElement('span'); b.className = 'tab-badge'; tabBtn.appendChild(b); } b.textContent = n; }
    else if (b) b.remove();
  }

  function renderInventory() {
    const host = $('#inventoryContent'); if (!host) return;
    if (!DATA || !((DATA.liveInventory || []).length)) {
      host.innerHTML = '<div class="section-head"><h2>Inventory</h2></div><p class="empty">No Live_Inventory rows found in the spreadsheet. Add items (item_id, item_name, container, pack_size, usage_unit, current_containers, current_units, min_stock_threshold) to the Live_Inventory tab.</p>';
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
      '<td class="num">' + (i.reserved ? fmtQ(i.reserved) + ' ' + esc(i.usageUnit) : '\u2014') + '</td>' +
      '<td class="num"><strong>' + (i.status === 'unknown' ? '\u2014' : fmtQ(i.availableUnits)) + '</strong>' + (i.status === 'unknown' ? '' : ' ' + esc(i.usageUnit)) + '</td>' +
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
      return '<details class="inv-cat" open><summary><strong>' + esc(c) + '</strong> <span class="who">' + list.length + ' item' + (list.length === 1 ? '' : 's') +
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
      let c = '<div class="proj-card"><div class="proj-card-head"><div><h3>' + esc(isUnfiled ? 'Unfiled experiments' : pname) + '</h3>'
        + '<p class="muted small">' + (isUnfiled ? (list.length + ' experiment' + (list.length === 1 ? '' : 's'))
          : ('Owner: ' + esc(owner || '\u2014') + ' \u00b7 ' + list.length + ' experiment' + (list.length === 1 ? '' : 's'))) + '</p></div>'
        + '<div class="head-actions"><button class="btn tiny" data-proj-act="toggle" data-proj="' + escAttr(pname) + '">' + (expanded ? 'Hide' : 'Manage project') + '</button></div></div>'
        + (expanded ? '' : '<ul class="proj-exp-list">' + summ + '</ul>');
      if (expanded) {
        c += '<div class="proj-detail"><p class="proj-total">' + (isUnfiled ? 'Total' : 'Project total') + ' (built experiments): <strong>' + fmtMoney(total) + '</strong>'
          + (isUnfiled ? '' : ' \u00b7 Owner: ' + esc(owner || '\u2014')) + '</p>';
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
          c += '<div class="exp-detail"><div class="exp-detail-head"><strong>' + esc(e.name) + '</strong> ' + statusBadge(e.status) + ' ' + roleChipHTML(e, invState) + '</div>'
            + '<p class="muted small">' + info + ' \u00b7 planned by ' + esc(e.plannedBy || '\u2014') + '</p>'
            + '<div class="exp-detail-actions">'
            + '<label class="inline-date">Date <input type="date" data-exp-date="' + e.id + '" value="' + escAttr(e.date || '') + '" /></label>'
            + '<button class="btn tiny" data-exp-act="open" data-id="' + e.id + '">Open in planner</button>'
            + '<button class="btn tiny" data-exp-act="reschedule" data-id="' + e.id + '">Reschedule</button>'
            + '<button class="btn tiny" data-exp-act="inv" data-id="' + e.id + '">Record inventory</button>'
            + '<button class="btn tiny danger" data-exp-act="del" data-id="' + e.id + '">Delete</button></div>'
            + '<div class="exp-print"><span class="muted small">Print / save:</span> '
            + '<button class="btn tiny" data-exp-act="packet" data-id="' + e.id + '">Experiment packet</button>'
            + '<button class="btn tiny" data-exp-act="protocols" data-id="' + e.id + '">Protocols</button>'
            + '<button class="btn tiny" data-exp-act="labels" data-id="' + e.id + '">Labels</button>'
            + '<button class="btn tiny" data-exp-act="pooling" data-id="' + e.id + '">Pooling strategy</button>'
            + '<button class="btn tiny" data-exp-act="reagents" data-id="' + e.id + '">Reagent checklist</button>'
            + '</div></div>';
        });
        c += '<div class="row-actions">'
          + (isUnfiled ? '' : '<button class="btn ghost" data-proj-act="projReagents" data-proj="' + escAttr(pname) + '">Export project reagents + cost</button>'
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
      else if (act === 'projReagents') projectReagentXlsx(p);
      else if (act === 'projBatches') projectBatchXlsx(p);
      else if (act === 'delProj') {
        if (confirm('Delete project \u201c' + p + '\u201d? Its experiments are kept but become unfiled.')) {
          Store.deleteProject(p);
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

    host.querySelectorAll('button[data-exp-act]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.id, act = b.dataset.expAct;
      if (act === 'open') openExperiment(id);
      else if (act === 'reschedule') { CURRENT_EXP_ID = id; updatePlanExpBar(); $('.tab[data-tab="scheduling"]').click(); if (window.Scheduling) Scheduling.render($('#schedulingContent')); }
      else if (act === 'inv') recordInventoryUI(id);
      else if (act === 'del') { const r = Store.getExperiment(id); if (r && confirm('Delete \u201c' + r.name + '\u201d? This cannot be undone.')) { if (CURRENT_EXP_ID === id) { CURRENT_EXP_ID = null; updatePlanExpBar(); } const folder = r.driveFolderId; Store.deleteExperiment(id); if (folder) driveApi({ action: 'trash', id: folder }).catch(() => {}); pushReservedToSheet(); renderManage(); } }
      else if (act === 'packet') experimentWorkbookXlsx(id);
      else if (act === 'protocols') openExperimentProtocols(id);
      else if (act === 'labels') { openExperiment(id); generateTubeLabels(); }
      else if (act === 'pooling') { openExperiment(id); downloadPoolingXlsx(); }
      else if (act === 'reagents') experimentReagentChecklist(id);
    }));

    inventoryBadge();
  }

  function showNewProjectForm() {
    const box = $('#pmForms'); if (!box) return;
    box.innerHTML = '<div class="pm-form"><h3>New project</h3><div class="save-grid">'
      + '<label>Project name<input type="text" id="npName" placeholder="e.g. MADI dyads" /></label>'
      + '<label>Owner<input type="text" id="npOwner" placeholder="e.g. Ashley" /></label>'
      + '</div><div class="row-actions"><button class="btn primary" id="npCreate">Create project</button><button class="btn ghost" id="npCancel">Cancel</button></div></div>';
    $('#npCancel').addEventListener('click', () => { box.innerHTML = ''; });
    $('#npCreate').addEventListener('click', () => {
      const name = ($('#npName').value || '').trim();
      if (!name) { alert('Enter a project name.'); return; }
      Store.saveProject({ name: name, owner: ($('#npOwner').value || '').trim() });
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
      renderManage();
      updatePlanExpBar();
      if (typeof refreshProjectDatalist === 'function') refreshProjectDatalist();
      if (!res.ok) console.warn('[experiments] Drive store unavailable; using local cache.');
    });
    renderManage();
    updatePlanExpBar();
    // keep an open tab in sync with others' changes: re-pull when it regains focus
    let _lastSync = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - _lastSync > 5000) {
        _lastSync = Date.now();
        Store.hydrateFromDrive().then(() => { renderManage(); updatePlanExpBar(); });
      }
    });
    const sp = $('#savePlanBtn'); if (sp) sp.addEventListener('click', saveExperimentUI);
    const bp = $('#backToProjectsBtn'); if (bp) bp.addEventListener('click', () => { $('.tab[data-tab="projects"]').click(); });
  });
})();

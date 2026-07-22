/* ============================================================================
   cost.js  —  Turns (arm instances + samples + pooling) into a costed plan.
   ----------------------------------------------------------------------------
   The planner now expresses the experiment as a set of "arm instances": one
   per cell load, each produced by a (population -> modality) choice in Step 01.
   Each instance carries:
     population : unsorted | sorted | stim | bulk
     modality   : cite5 | scrna5 | flex | asap | bulkrna | bulktcrbcr
     chem       : loading chemistry key (drives cells/GEM + reads assumptions)
     laneChem   : "5'" | "3'/ATAC" | "Flex" | "bulk"  (drives which kits)
     libraries  : e.g. ['GEX','ADT','HTO'] (+ 'TCR','BCR' if V(D)J rides along)
     vdj        : true if V(D)J rides on this 5' load (NO separate lane)
     laneMode   : 'pooled' | 'perSortPop' | 'none'

   Assumptions are keyed by loading CHEMISTRY, not by arm, so cells/GEM only
   ever appears for things actually loaded onto GEMs (cite5/scrna5/flex/asap).
   V(D)J and bulk have no cells/GEM and no lanes of their own.

   Reads live from the parsed workbook; every line item is tagged with its
   source and whether it's a placeholder. Pure functions; window.CostEngine.
   ============================================================================ */

(function (root) {
  'use strict';

  // Per-loading-chemistry assumption profiles. Defaults come from the lab's
  // BCP-IDVax ordering calculations. `fields` drives both the Options UI
  // (app.js) and the fallback default used here when an option is missing.
  const CHEM_ASSUMPTIONS = {
    cite5: {
      label: "5\u2032 CITE-seq",
      fields: [
        { key: 'targetCellsPerSample', label: 'Target recovered cells / sample', def: 7500, hint: 'Cells contributed per sample toward this load\u2019s pool.' },
        { key: 'recoveryPerLane', label: 'Cells recovered / GEM (lane)', def: 30000, hint: 'Post-QC/demux cells recovered per 10x channel.' },
        { key: 'readsGEX', label: 'Reads/cell \u2014 GEX', def: 35000 },
        { key: 'readsADT', label: 'Reads/cell \u2014 ADT', def: 5000 },
        { key: 'readsHTO', label: 'Reads/cell \u2014 HTO', def: 1000 }
      ]
    },
    scrna5: {
      label: "5\u2032 scRNA-seq (hashed)",
      fields: [
        { key: 'targetCellsPerSample', label: 'Target recovered cells / sample', def: 7500, hint: 'Cells contributed per sample toward this load\u2019s pool.' },
        { key: 'recoveryPerLane', label: 'Cells recovered / GEM (lane)', def: 30000, hint: 'Post-QC/demux cells recovered per 10x channel.' },
        { key: 'readsGEX', label: 'Reads/cell \u2014 GEX', def: 35000 },
        { key: 'readsHTO', label: 'Reads/cell \u2014 HTO', def: 1000 }
      ]
    },
    flex: {
      label: 'Flex (fixed RNA profiling)',
      fields: [
        { key: 'targetCellsPerSample', label: 'Target recovered cells / sample', def: 20000, hint: 'Flex v2 max is 20,000 recovered cells per Sample Barcode (CG000834).' },
        { key: 'maxPlexPerLane', label: 'Samples / GEM well (plex)', def: 16, hint: 'Flex v2 multiplexes up to 16 samples per GEM well with Barcoding Oligo Plate Set A.' },
        { key: 'recoveryPerLane', label: 'Max cells recovered / GEM well', def: 320000, hint: 'Flex v2 max: 16 barcodes \u00d7 20,000 cells = 320,000 recovered per well (single library, CG000834). Up to 1,000,000 with 4-split SI-PCR.' },
        { key: 'cellsLoadedPerLane', label: 'Max cells loaded / GEM well', def: 464000, hint: 'Recovered \u00d7 1.45 recovery factor (CG000834): 320,000 \u00d7 1.45 \u2248 464,000 loaded per well.' },
        { key: 'readsGEX', label: 'Reads/cell \u2014 GEX', def: 20000 }
      ]
    },
    asap: {
      label: "ASAP-seq (3\u2032/ATAC)",
      fields: [
        { key: 'targetCellsPerSample', label: 'Target recovered cells / sample', def: 3000, hint: 'FACS-enriched nuclei per sample.' },
        { key: 'recoveryPerLane', label: 'Cells recovered / GEM (lane)', def: 9000, hint: 'Lower than CITE-seq \u2014 enrichment reduces load needed.' },
        { key: 'readsATAC', label: 'Reads/cell \u2014 ATAC', def: 25000 },
        { key: 'readsADT', label: 'Reads/cell \u2014 ADT', def: 5000 },
        { key: 'readsHTO', label: 'Reads/cell \u2014 HTO (added library)', def: 1000, hint: 'ASAP-seq sequences its hashtag as its own library, unlike CITE-seq.' }
      ]
    },
    vdj: {
      label: 'V(D)J (TCR/BCR) add-on',
      fields: [
        { key: 'tcrCellsPerLane', label: 'T cells / lane', def: 26000, hint: 'Subset of a 5\u2032 lane that is T cells. Rides on the 5\u2032 cDNA \u2014 no separate load or lane.' },
        { key: 'readsTCR', label: 'Reads/cell \u2014 TCR', def: 5000 },
        { key: 'bcrCellsPerLane', label: 'B cells / lane', def: 6750, hint: 'Subset of a 5\u2032 lane that is B cells.' },
        { key: 'readsBCR', label: 'Reads/cell \u2014 BCR', def: 5000 }
      ]
    },
    bulkrna: {
      label: 'Bulk RNA-seq',
      fields: [
        { key: 'readsPerSample', label: 'Reads / sample', def: 30000000, hint: 'Total reads per bulk RNA library. Per-sample, not droplet-loaded \u2014 estimate.' }
      ]
    },
    bulktcrbcr: {
      label: 'Bulk TCR/BCR',
      fields: [
        { key: 'readsPerSample', label: 'Reads / sample', def: 5000000, hint: 'Total reads per bulk immune-repertoire library \u2014 estimate.' }
      ]
    }
  };

  const POP_LABEL = { unsorted: 'Unsorted', sorted: 'Sorted', stim: 'Stim', bulk: 'Bulk' };
  function armLabel(arm) {
    return (POP_LABEL[arm.population] || arm.population) + ' \u00b7 ' +
      (CHEM_ASSUMPTIONS[arm.chem] ? CHEM_ASSUMPTIONS[arm.chem].label : arm.chem);
  }

  // Look up a chemistry-level option, falling back to its documented default.
  function chemOpt(opts, chemKey, fieldKey) {
    const fromOpts = opts.chems && opts.chems[chemKey] && opts.chems[chemKey][fieldKey];
    if (fromOpts != null && fromOpts !== '') return Number(fromOpts);
    const profile = CHEM_ASSUMPTIONS[chemKey];
    const field = profile && profile.fields.find((f) => f.key === fieldKey);
    return field ? field.def : undefined;
  }

  // Fuzzy-match a kit by keywords against Kit_Catalog (returns first hit).
  function findKit(kits, keywords) {
    const kw = keywords.map((k) => k.toLowerCase());
    return kits.find((k) => {
      const hay = (k.name + ' ' + k.category + ' ' + k.chemistry).toLowerCase();
      return kw.every((w) => hay.includes(w));
    }) || null;
  }

  function findSupply(supplies, keywords) {
    const kw = keywords.map((k) => k.toLowerCase());
    return supplies.find((s) => {
      const hay = (s.reagent + ' ' + s.appliesTo).toLowerCase();
      return kw.every((w) => hay.includes(w));
    }) || null;
  }

  function money(n) {
    if (n == null || isNaN(n)) return null;
    return Math.round(n * 100) / 100;
  }

  // Derive the legacy arm set (unsort5/asap3/sort5/flex) from arm instances,
  // used only for consumable stage-filtering (mostly placeholder quantities).
  function legacyArmSet(armInstances) {
    const s = new Set();
    armInstances.forEach((a) => {
      if (a.chem === 'cite5' || a.chem === 'scrna5') s.add(a.population === 'sorted' ? 'sort5' : 'unsort5');
      else if (a.chem === 'asap') s.add('asap3');
      else if (a.chem === 'flex') { s.add('flex'); if (a.population === 'sorted') s.add('sort5'); }
    });
    return s;
  }

  /**
   * @param {Object} data  parsed workbook (from SchemaParse.parseWorkbook)
   * @param {Object} plan  { armInstances:[...], nSamples, samples:[...] (optional,
   *                         enables cell-budget-aware lane math), nPools, superPools,
   *                         opts:{ cap, htoAvailable, sortPopulations,
   *                                chems:{ cite5:{...}, scrna5:{...}, flex:{...},
   *                                        asap:{...}, vdj:{...}, bulkrna:{...},
   *                                        bulktcrbcr:{...} } } }
   */
  function computeCost(data, plan) {
    const opts = plan.opts || {};
    const P = root.Pooling;
    const kits = data.kits || [];
    const supplies = data.supplies || [];
    const seq = data.sequencing || [];
    const armInstances = plan.armInstances || [];
    const sampleList = plan.samples || null;
    const nSamples = plan.nSamples || (sampleList ? sampleList.length : 0);

    const lineItems = [];
    const notes = [];

    // ---- Lanes per arm instance ----------------------------------------------
    const laneBreakdown = [];
    const laneByKey = {};    // arm.key -> lane count
    const cellsByKey = {};   // arm.key -> cells used for read-depth math
    let totalLanes5 = 0, totalLanes3 = 0, totalLanesFlex = 0;
    let adt5Lanes = 0, vdjLanes = 0;

    armInstances.forEach((arm) => {
      const target = chemOpt(opts, arm.chem, 'targetCellsPerSample');
      const recovery = chemOpt(opts, arm.chem, 'recoveryPerLane');
      let lanes = 0, detail = '', cellsForReads = 0;

      if (arm.chem === 'flex') {
        // Flex v2: samples are probe-barcoded and pooled up to 16 / GEM well.
        // Lane count is bounded by BOTH the 16-plex limit and the per-well cell
        // cap (16 barcodes x 20,000 = 320,000 recovered / well). Use the max.
        const maxPlex = chemOpt(opts, 'flex', 'maxPlexPerLane') || 16;
        const r = P.lanesForPooledArm(sampleList || nSamples, { targetCellsPerSample: target, recoveryPerLane: recovery });
        const lanesPlex = Math.max(1, Math.ceil(nSamples / maxPlex));
        lanes = Math.max(lanesPlex, r.lanes);
        cellsForReads = r.totalCells;
        detail = nSamples + ' samples \u00f7 ' + maxPlex + '-plex = ' + lanesPlex + ' well(s); '
               + recovery.toLocaleString() + ' cells/well cap \u2192 ' + lanes + ' Flex GEM well(s)';
        if (r.shortfall && r.shortfall.length) {
          const names = r.shortfall.slice(0, 5).map((s) => s.sampleId).join(', ') + (r.shortfall.length > 5 ? ', \u2026' : '');
          notes.push(armLabel(arm) + ': ' + r.shortfall.length + ' sample(s) below the ' + r.target + '-cell target (' + names + ').');
        }
      } else if (arm.laneMode === 'pooled') {
        // Reagent-ordering lane count: nSamples x target cells / recovery per lane.
        const r = P.lanesForPooledArm(sampleList || nSamples, { targetCellsPerSample: target, recoveryPerLane: recovery });
        lanes = r.lanes;
        cellsForReads = r.totalCells;
        detail = nSamples + ' samples \u00d7 ' + r.target + ' cells / ' + r.recovery + ' recovery per lane';
        if (r.shortfall && r.shortfall.length) {
          const names = r.shortfall.slice(0, 5).map((s) => s.sampleId).join(', ') + (r.shortfall.length > 5 ? ', \u2026' : '');
          notes.push(armLabel(arm) + ': ' + r.shortfall.length + ' sample(s) have fewer cells than the ' + r.target +
            '-cell target (' + names + ') \u2014 they contribute proportionally fewer cells/reads to this load rather than being padded to target.');
        }
      } else if (arm.laneMode === 'perSortPop') {
        // Sort arm: always one lane per sorted population (regardless of recovered cells).
        const nPops = (opts.sortDetail && opts.sortDetail.popSortedCells)
          ? Object.keys(opts.sortDetail.popSortedCells).length
          : (opts.sortPopulations || 4);
        lanes = nPops;
        cellsForReads = lanes * recovery;
        detail = lanes + ' sorted population(s) \u00d7 1 lane each';
      } else { // none (bulk)
        lanes = 0;
        cellsForReads = 0;
        detail = nSamples + ' per-sample bulk libraries (no GEM lane)';
      }

      if (arm.laneChem === "5'") { totalLanes5 += lanes; if (arm.libraries.indexOf('ADT') !== -1) adt5Lanes += lanes; if (arm.vdj) vdjLanes += lanes; }
      else if (arm.laneChem === "3'/ATAC") totalLanes3 += lanes;
      else if (arm.laneChem === 'Flex') totalLanesFlex += lanes;

      laneByKey[arm.key] = lanes;
      cellsByKey[arm.key] = cellsForReads;
      laneBreakdown.push({ key: arm.key, arm: arm.key, population: arm.population, modality: arm.modality,
        chem: arm.chem, laneChem: arm.laneChem, lanes, libraries: arm.libraries.slice(), vdj: arm.vdj,
        detail, label: armLabel(arm) });
    });

    // ---- Kit costing ----------------------------------------------------------
    function addKitLine(label, kit, unitsNeeded) {
      if (!unitsNeeded) return;
      if (!kit || kit.price == null) {
        lineItems.push({ category: '10x kits', label: label, qty: unitsNeeded, unit: 'lane-equiv',
          unitCost: null, total: null, source: kit ? ('Kit_Catalog ' + kit.id + ' (no price)') : 'not found in Kit_Catalog', placeholder: true });
        return;
      }
      const perLane = kit.reactions ? (kit.price / kit.reactions) : kit.price;
      const total = perLane * unitsNeeded;
      lineItems.push({ category: '10x kits', label: label + ' (' + kit.id + ')', qty: unitsNeeded, unit: 'lanes',
        unitCost: money(perLane), total: money(total),
        source: 'Kit_Catalog ' + kit.id + ' ($' + kit.price + ' / ' + (kit.reactions || 1) + ' rxn)', placeholder: false });
    }

    if (totalLanes5 > 0) {
      addKitLine("5' GEX core kit", findKit(kits, ["5'", 'kit', 'v3']) || findKit(kits, ["5'", 'gene expression']), totalLanes5);
      addKitLine("5' chip kit", findKit(kits, ["5'", 'chip']), totalLanes5);
      addKitLine('Library Construction Kit C', findKit(kits, ['library construction']), totalLanes5);
      addKitLine("5' Dual Index Kit (TT)", findKit(kits, ['dual index', 'tt']), totalLanes5);
      if (adt5Lanes > 0) addKitLine('Feature Barcode Kit (CITE-seq ADT)', findKit(kits, ['feature barcode']), adt5Lanes);
      if (vdjLanes > 0) {
        addKitLine('V(D)J Amplification Kit, TCR', findKit(kits, ['v(d)j', 'tcr']) || findKit(kits, ['tcr amplification']), vdjLanes);
        addKitLine('V(D)J Amplification Kit, BCR', findKit(kits, ['v(d)j', 'bcr']) || findKit(kits, ['bcr amplification']), vdjLanes);
      }
    }

    if (totalLanes3 > 0) {
      addKitLine('ATAC core kit', findKit(kits, ['atac', 'kit']), totalLanes3);
      addKitLine('ATAC chip (Chip H)', findKit(kits, ['chip h']), totalLanes3);
      addKitLine('ATAC Single Index Kit N', findKit(kits, ['single index', 'n']), totalLanes3);
    }

    if (totalLanesFlex > 0) {
      addKitLine('Flex GEX kit', findKit(kits, ['flex', 'gene expression']) || findKit(kits, ['flex', 'kit']) || findKit(kits, ['fixed rna']), totalLanesFlex);
      addKitLine('Flex chip / barcode kit', findKit(kits, ['flex', 'chip']) || findKit(kits, ['flex', 'barcode']), totalLanesFlex);
    }

    // Bulk libraries are per-sample (no lane).
    const bulkRnaArm = armInstances.find((a) => a.chem === 'bulkrna');
    if (bulkRnaArm && nSamples > 0) addKitLine('Bulk RNA library prep (per sample)', findKit(kits, ['bulk', 'rna']) || findKit(kits, ['rna', 'library']) || findKit(kits, ['stranded']), nSamples);
    const bulkImmArm = armInstances.find((a) => a.chem === 'bulktcrbcr');
    if (bulkImmArm && nSamples > 0) addKitLine('Bulk TCR/BCR library prep (per sample)', findKit(kits, ['tcr', 'library']) || findKit(kits, ['immune', 'repertoire']) || findKit(kits, ['bcr']), nSamples);

    // ---- All reagents (antibodies, buffers, tips, tubes, ...) -----------------
    // Driven by the Pre_GEM_Consumables + Post_GEM_Consumables matrices in the
    // spreadsheet. Each row gives a per-scope amount in some stage column; we
    // scale by how many samples / genetic pools / super-pools / channels the
    // active plan has, then price it from the supply catalog (or the per-stage
    // Price column, which Post_GEM carries directly).
    const supById = {};
    supplies.forEach((s) => { supById[s.id] = s; });

    const anyVdj = armInstances.some((a) => a.vdj);
    const hasStim = armInstances.some((a) => a.population === 'stim');
    const hasCite = armInstances.some((a) => a.chem === 'cite5');
    const hasAsap = armInstances.some((a) => a.chem === 'asap');
    const hasSort = armInstances.some((a) => a.population === 'sorted');
    const hasBulk = armInstances.some((a) => a.chem === 'bulkrna' || a.chem === 'bulktcrbcr');

    // ---- Per-library / channel / pool counts for consumable scaling ----------
    let chan5 = 0, chanATAC = 0, chanFlex = 0;
    let lib5GEX = 0, lib5VDJ = 0, lib5ADT = 0, libATAC = 0, libATACADT = 0, libFlex = 0;
    laneBreakdown.forEach((l) => {
      const libs = l.libraries || [];
      if (l.laneChem === "5'") {
        chan5 += l.lanes;
        if (libs.indexOf('GEX') !== -1) lib5GEX += l.lanes;
        if (libs.indexOf('ADT') !== -1) lib5ADT += l.lanes;
        if (libs.indexOf('TCR') !== -1) lib5VDJ += l.lanes;
        if (libs.indexOf('BCR') !== -1) lib5VDJ += l.lanes;
      } else if (l.laneChem === "3'/ATAC") {
        chanATAC += l.lanes;
        if (libs.indexOf('ATAC') !== -1) libATAC += l.lanes;
        if (libs.indexOf('ADT') !== -1) libATACADT += l.lanes;
      } else if (l.laneChem === 'Flex') {
        chanFlex += l.lanes;
        libFlex += l.lanes;
      }
    });
    const hasFlex = chanFlex > 0;
    const nFlexSamples = hasFlex ? nSamples : 0;
    const nFlexPools = chanFlex;

    // Is a consumables section relevant to the current plan?
    function sectionActive(section, isPost) {
      const s = (section || '').toLowerCase();
      if (!isPost) {
        if (s.indexOf('pbmc') !== -1) return nSamples > 0;
        if (s.indexOf('cite') !== -1) return hasCite;
        if (s.indexOf('asap') !== -1) return hasAsap;
        if (s.indexOf('sort') !== -1) return hasSort;
        if (s.indexOf('bulk') !== -1 || s.indexOf('trizol') !== -1) return hasBulk;
        if (s.indexOf('flex') !== -1) return hasFlex;
        return nSamples > 0;
      }
      if (s.indexOf('flex') !== -1) return hasFlex;
      if (s.indexOf('atac-adt') !== -1) return libATACADT > 0;
      if (s.indexOf('atac') !== -1) return chanATAC > 0;   // ATAC-GEM + ATAC library
      if (s.indexOf('vdj') !== -1) return lib5VDJ > 0;
      if (s.indexOf('adt') !== -1) return lib5ADT > 0;
      if (s.indexOf('gex') !== -1 || s.indexOf('gem') !== -1) return chan5 > 0;
      return true;
    }
    // Map a scaling-basis string to the plan multiplier. Order matters (check the
    // most specific tokens first so "atac-adt library" doesn't match "adt library").
    function flatMult(basis) {
      const b = (basis || '').toLowerCase();
      if (b.indexOf('flex sample') !== -1) return nFlexSamples;
      if (b.indexOf('flex pool') !== -1) return nFlexPools;
      if (b.indexOf('flex library') !== -1) return libFlex;
      if (b.indexOf('gem channel') !== -1) return b.indexOf('atac') !== -1 ? chanATAC : chan5;
      if (b.indexOf('gex library') !== -1) return lib5GEX;
      if (b.indexOf('vdj library') !== -1) return lib5VDJ;
      if (b.indexOf('atac-adt library') !== -1) return libATACADT;
      if (b.indexOf('adt library') !== -1) return lib5ADT;
      if (b.indexOf('atac library') !== -1) return libATAC;
      if (b.indexOf('super') !== -1) return 1;                 // one combined super-pool
      if (b.indexOf('genetic pool') !== -1) return plan.nPools || 0;
      if (b.indexOf('run') !== -1) return 1;
      if (b.indexOf('sample') !== -1) return nSamples;
      if (b.indexOf('pool') !== -1) return plan.nPools || 0;
      return 1;
    }

    const reagents = [];
    function classify(reagent, itemId) {
      const s = (reagent + ' ' + itemId).toLowerCase();
      if (/hashtag|hto|totalseq|cocktail|antibody|\bfc block\b|adt/.test(s)) return 'Antibodies & staining';
      if (/tip|tube|eppendorf|conical|strip|strainer|plate|flowmi|facs tube/.test(s)) return 'Plasticware & consumables';
      return 'Buffers & reagents';
    }
    // Convert an amount from one unit to another when they're the same kind
    // (volume µL/mL/L or mass µg/mg/g). Returns null if not convertible.
    function unitKindFactor(u) {
      const s = (u || '').toLowerCase();
      if (/µl|ul|microl/.test(s)) return { kind: 'vol', f: 1e-6 };
      if (/\bml\b|milll?il/.test(s)) return { kind: 'vol', f: 1e-3 };
      if (/µg|ug|microg/.test(s)) return { kind: 'mass', f: 1e-6 };
      if (/\bmg\b/.test(s)) return { kind: 'mass', f: 1e-3 };
      if (/\bl\b|liter|litre/.test(s)) return { kind: 'vol', f: 1 };
      if (/\bg\b|gram/.test(s)) return { kind: 'mass', f: 1 };
      return null;
    }
    // amount (in unit `fromU`) priced at pricePerUnit (per `perU`) -> cost
    function costFor(amount, fromU, pricePerUnit, perU) {
      if (pricePerUnit == null) return null;
      if (!perU || !fromU || perU.toLowerCase() === fromU.toLowerCase()) return pricePerUnit * amount;
      const a = unitKindFactor(fromU), b = unitKindFactor(perU);
      if (a && b && a.kind === b.kind) return pricePerUnit * (amount * a.f / b.f);
      return null; // incompatible units -> don't guess
    }
    function convertAmount(amount, fromU, toU) {
      if (!fromU || !toU || fromU.toLowerCase() === toU.toLowerCase()) return amount;
      const a = unitKindFactor(fromU), b = unitKindFactor(toU);
      if (a && b && a.kind === b.kind) return amount * a.f / b.f;
      return null;
    }

    function addFlat(sheet, isPost) {
      (sheet.items || []).forEach((it) => {
        const amt = it.amountPerUnit;
        if (amt == null) return;                          // buffer-prep headers / blank rows
        const idU = (it.itemId || '').toUpperCase();
        if (idU.charAt(0) === 'K') return;                // 10x kits are costed by the kit logic above
        if (!sectionActive(it.section, isPost)) return;   // section not in this plan
        const mult = flatMult(it.scalingBasis);
        if (!mult) return;
        const totalAmt = amt * mult;
        if (!totalAmt) return;

        const sup = supById[it.itemId] || (it.catalogKey ? supById[it.catalogKey] : null);
        const units = it.units || (sup ? sup.usageUnits : '') || '';
        let total = null, unitCost = null, haveCost = false;
        if (it.unitPrice != null) {                       // sheet's own computed $/unit (col L)
          total = it.unitPrice * totalAmt; unitCost = it.unitPrice; haveCost = true;
        } else if (sup && sup.pricePerUnit != null) {     // fall back to the supply catalog
          const c = costFor(totalAmt, units, sup.pricePerUnit, sup.priceUnit || sup.usageUnits);
          if (c != null) { total = c; unitCost = sup.pricePerUnit; haveCost = true; }
        }

        reagents.push({
          category: classify(it.item, it.itemId),
          label: it.item, reagent: it.item, itemId: it.itemId || '', units,
          scope: it.scalingBasis || (isPost ? 'per channel' : 'per batch'),
          totalAmount: totalAmt,
          unitCost: unitCost != null ? money(unitCost) : null,
          total: haveCost ? total : null,
          usageStock: sup ? sup.usageStock : null,
          stockUnits: sup ? sup.stockUnits : (it.stockUnit || ''),
          stockSize: sup ? sup.stockSize : null,
          source: sup ? ('Additional_Supply_Catalog ' + sup.id)
                      : (isPost ? 'Post_GEM_Consumables' : 'Pre_GEM_Consumables'),
          placeholder: !haveCost
        });
      });
    }

    if (data.preGem && data.preGem.items) addFlat(data.preGem, false);
    if (data.postGem && data.postGem.items) addFlat(data.postGem, true);

    // Merge rows for the same reagent used at multiple scopes (e.g. PBS at pool
    // and super-pool level), then work out an order quantity per reagent.
    // Treat count-unit synonyms (each/tube/vial/...) as the same unit when
    // merging, so an item entered with mixed count words across sections (e.g.
    // eppendorf as "each" in one section and "tube" in another) collapses into a
    // single reagent line whose Total needed = the item's full demand. This
    // keeps the reagents list aligned with the inventory reservation (which sums
    // an item across all its uses).
    function normUnit(u) {
      var s = (u || '').toLowerCase().trim();
      return /^(each|ea|tube|tubes|vial|vials|strip|strips|plate|plates|strainer|strainers|cap|caps|tip|tips|bottle|bottles|aliquot|aliquots|well|wells)$/.test(s) ? 'ct' : s;
    }
    const merged = {};
    reagents.forEach((r) => {
      const key = (r.itemId || r.reagent) + '|' + normUnit(r.units);
      if (!merged[key]) { merged[key] = Object.assign({}, r, { scopes: [r.scope] }); }
      else {
        const m = merged[key];
        m.totalAmount += r.totalAmount;
        if (r.total != null) m.total = (m.total || 0) + r.total;
        if (r.placeholder) m.placeholder = m.placeholder && r.placeholder;
        if (m.scopes.indexOf(r.scope) === -1) m.scopes.push(r.scope);
      }
    });

    const COUNT_UNITS = /(tube|tip|vial|sample|lane|strip|plate|strainer|each|hashtag)/i;
    const finalReagents = Object.keys(merged).map((k) => {
      const r = merged[k];
      const idU = (r.itemId || '').toUpperCase();
      const isHashtag = idU === 'R017' || idU === 'R018';
      const isCocktail = idU === 'R015' || idU === 'R016';
      let quantity = null, quantityUnit = '', note = '';
      if (isHashtag) {
        quantity = plan.nPools || 0; quantityUnit = 'unique hashtags';
        note = '2\u00b5L of a distinct hashtag per genetic pool (' + (idU === 'R017' ? 'TotalSeq-A / ASAP' : 'TotalSeq-C / CITE-seq') + '); one hashtag vial covers many batches.';
      } else if (isCocktail) {
        quantity = Math.round(r.totalAmount); quantityUnit = 'vials';
        note = '3 vials used per staining batch; universal-cocktail kit comes with 5 (1 kit covers a batch).';
      } else if (COUNT_UNITS.test(r.units || '')) {
        quantity = Math.ceil(r.totalAmount); quantityUnit = r.units;
      } else if (r.stockSize && r.stockUnits) {
        const amtInStock = convertAmount(r.totalAmount, r.units, r.stockUnits);
        if (amtInStock != null) { quantity = Math.ceil(amtInStock / r.stockSize); quantityUnit = 'pack' + (quantity > 1 ? 's' : '') + ' (' + r.stockSize + ' ' + r.stockUnits + ' each)'; }
      }
      r.totalAmount = Math.round(r.totalAmount * 1000) / 1000;
      r.qty = r.totalAmount; r.unit = r.units;
      r.total = r.total != null ? money(r.total) : null;
      r.quantity = quantity; r.quantityUnit = quantityUnit; r.note = note;
      r.scope = r.scopes.join(' + ');
      return r;
    });

    // fold reagent rows into the costed line items
    finalReagents.forEach((r) => lineItems.push(r));
    const reagentsOut = finalReagents;

    if (reagentsOut.length) {
      notes.push('Reagents cover the full Pre-GEM + Post-GEM consumables lists (buffers, plasticware, antibodies, QC), scaled by samples, genetic pools, one combined super-pool per staining modality, and channels.');
      notes.push('HTO hashtags are counted as 2\u00b5L of a distinct hashtag per genetic pool \u2014 TotalSeq-A for ASAP-seq, TotalSeq-C for CITE-seq; universal cocktails as 3 vials per staining batch from a 5-vial kit.');
      notes.push('Reagent costs are derived from the catalog\u2019s Price and Stock Size; a few source rows carry unit inconsistencies (e.g. DNase entered in mg though the note says \u00b5L) \u2014 correct those cells in the spreadsheet for exact costs.');
    }

    // ---- Sequencing -----------------------------------------------------------
    // reads = cells * reads/cell, per library, per arm. Each arm uses its own
    // loading chemistry's read depths; V(D)J rides on its 5' arm's lanes (its
    // own T/B-cell counts, no extra lane); bulk is per-sample.
    const seqPlat = seq.find((s) => /novaseq/i.test(s.platform)) || seq[0];
    const pricePerM = seqPlat ? seqPlat.pricePerM : null;
    let totalReads = 0;
    const readDepthNotes = [];

    armInstances.forEach((arm) => {
      const cells = cellsByKey[arm.key] || 0;
      const lanes = laneByKey[arm.key] || 0;
      arm.libraries.forEach((lib) => {
        if (lib === 'TCR' || lib === 'BCR') {
          const cpl = chemOpt(opts, 'vdj', lib === 'TCR' ? 'tcrCellsPerLane' : 'bcrCellsPerLane');
          const rpc = chemOpt(opts, 'vdj', lib === 'TCR' ? 'readsTCR' : 'readsBCR');
          if (cpl && rpc && lanes) { totalReads += lanes * cpl * rpc; readDepthNotes.push(armLabel(arm) + ' ' + lib + ' ' + rpc + '/cell (' + cpl + ' cells/lane)'); }
          return;
        }
        if (lib === 'BulkGEX' || lib === 'BulkTCR' || lib === 'BulkBCR') {
          const rps = chemOpt(opts, arm.chem, 'readsPerSample');
          if (rps && nSamples) { totalReads += rps * nSamples; readDepthNotes.push(armLabel(arm) + ' ' + lib + ' ' + rps + '/sample \u00d7 ' + nSamples); }
          return;
        }
        let rpc, tag;
        if (lib === 'GEX' || lib === 'FlexGEX') { rpc = chemOpt(opts, arm.chem, 'readsGEX'); tag = 'GEX'; }
        else if (lib === 'ADT') { rpc = chemOpt(opts, arm.chem, 'readsADT'); tag = 'ADT'; }
        else if (lib === 'ATAC') { rpc = chemOpt(opts, arm.chem, 'readsATAC'); tag = 'ATAC'; }
        else if (lib === 'HTO') { rpc = chemOpt(opts, arm.chem, 'readsHTO'); tag = 'HTO'; }
        else return;
        if (rpc == null || !cells) return;
        totalReads += cells * rpc;
        readDepthNotes.push(armLabel(arm) + ' ' + tag + ' ' + rpc + '/cell');
      });
    });

    if (pricePerM != null && totalReads > 0) {
      const seqCost = (totalReads / 1e6) * pricePerM;
      lineItems.push({ category: 'Sequencing', label: 'Sequencing (' + seqPlat.platform + ' ' + seqPlat.config + ')',
        qty: Math.round(totalReads / 1e6), unit: 'M reads', unitCost: money(pricePerM), total: money(seqCost),
        source: 'Sequencing_Pricing ' + seqPlat.id + ' \u2014 per-chemistry depth defaults, adjust in Options', placeholder: false });
      notes.push('Sequencing depth uses each load\u2019s own reads/cell defaults (' + readDepthNotes.join('; ') + '). Adjust per chemistry in Options (Step 04).');
    } else {
      lineItems.push({ category: 'Sequencing', label: 'Sequencing', qty: null, unit: '', unitCost: null, total: null,
        source: 'Sequencing_Pricing has no per-M price / no reads', placeholder: true });
    }

    // ---- Totals ---------------------------------------------------------------
    const knownTotal = lineItems.reduce((a, li) => a + (li.total || 0), 0);
    const nPlaceholders = lineItems.filter((li) => li.placeholder).length;

    return {
      lineItems,
      laneBreakdown,
      reagents: reagentsOut,
      totalLanes5,
      totalLanes3,
      totalLanesFlex,
      knownTotal: money(knownTotal),
      nPlaceholders,
      notes,
      arms: armInstances.map((a) => a.key)
    };
  }

  const api = { computeCost, CHEM_ASSUMPTIONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CostEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);

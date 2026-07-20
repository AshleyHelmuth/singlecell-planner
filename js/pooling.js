/* ============================================================================
   pooling.js  —  Genetic + HTO pooling strategy engine
   ----------------------------------------------------------------------------
   Implements the two-level pooling model described in the lab handbook and the
   MADI flowcharts:

   LEVEL 1 — Genetic pools (SNP demultiplexing)
     Samples are partitioned into "genetic pools" of at most GENETIC_POOL_CAP
     samples. Within one genetic pool, no two samples may be:
        - from the same patient (same donor, e.g. different timepoints), or
        - from genetically related patients (family members).
     This is what lets SNP-based demultiplexing separate individuals inside a
     pool, and — because a patient's repeat timepoints always land in DIFFERENT
     genetic pools — lets a later HTO layer separate the timepoints too.

   LEVEL 2 — HTO hashing
     Each genetic pool is labelled with a single, unique HTO. Pools are then
     combined into "loading super-pools" and spread across 10x channels/lanes.
     A cell's identity = HTO (which genetic pool) + SNP genotype (which person
     in that pool).

   The Level-1 partition is a bounded graph-colouring / bin-packing problem:
     - Build "lineage groups": sets of samples that are mutually incompatible
       (same patient OR related). Every member of a lineage group must land in
       a different genetic pool.
     - Minimum pools = max( largest lineage group size, ceil(total / cap) ).
     - Greedy assignment: place the largest lineage groups first, distributing
       their members across the least-full eligible pools.

   Pure functions only — no DOM, no globals. Exported for both Node (tests) and
   the browser (window.Pooling).
   ============================================================================ */

(function (root) {
  'use strict';

  /**
   * Build lineage groups via union-find over two relations:
   *   (1) same patientId   (2) explicit relatedness edges
   * @param {Array} samples  [{id, sampleId, patientId, ...}]
   * @param {Array} relatedPairs  [[sampleIdA, sampleIdB], ...] (by sampleId)
   * @returns {Map} groupRoot -> [sample, ...]
   */
  function buildLineageGroups(samples, relatedPairs) {
    const parent = {};
    const find = (x) => {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    };
    const union = (a, b) => { parent[find(a)] = find(b); };

    samples.forEach((s) => { parent[s.id] = s.id; });

    // Relation 1: same patient  (skip blank/unknown patient ids — they are
    // treated as independent, since we cannot prove a shared donor)
    const byPatient = {};
    samples.forEach((s) => {
      const p = (s.patientId || '').trim();
      if (!p) return;
      if (!byPatient[p]) byPatient[p] = [];
      byPatient[p].push(s.id);
    });
    Object.values(byPatient).forEach((ids) => {
      for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
    });

    // Relation 2: explicit related pairs (matched by sampleId)
    const idBySampleId = {};
    samples.forEach((s) => { idBySampleId[String(s.sampleId)] = s.id; });
    (relatedPairs || []).forEach((pair) => {
      const a = idBySampleId[String(pair[0])];
      const b = idBySampleId[String(pair[1])];
      if (a != null && b != null) union(a, b);
    });

    const groups = new Map();
    samples.forEach((s) => {
      const r = find(s.id);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(s);
    });
    return groups;
  }

  /**
   * Partition samples into genetic pools.
   * @param {Array} samples  each may carry `confounders: {colName: value}`
   * @param {Array} relatedPairs
   * @param {Object} opts { cap, balanceColumns:[colName,...] }
   *   balanceColumns lists confounder columns (e.g. "Timepoint", "Condition")
   *   whose values should be *spread across* pools rather than clustered —
   *   soft-optimized on top of the hard lineage/patient constraint.
   * @returns {Object} { pools:[[sample...]], nPools, minPossible, cap,
   *                      largestLineage, warnings:[], confounderReport }
   */
  function buildGeneticPools(samples, relatedPairs, opts) {
    opts = opts || {};
    const cap = opts.cap || 20;
    const balanceColumns = (opts.balanceColumns || []).filter(Boolean);
    const warnings = [];

    if (!samples.length) {
      return { pools: [], nPools: 0, minPossible: 0, cap, largestLineage: 0, warnings, confounderReport: [] };
    }

    const groups = Array.from(buildLineageGroups(samples, relatedPairs).values());
    // Sort lineage groups largest-first so the tightest constraints are placed
    // when pools are still empty.
    groups.sort((a, b) => b.length - a.length);

    const largestLineage = groups[0].length;
    const total = samples.length;
    const minByCapacity = Math.ceil(total / cap);
    let nPools = Math.max(largestLineage, minByCapacity);

    if (largestLineage > cap) {
      // Impossible to respect the cap AND keep a lineage group split; lineage
      // wins (it's a hard biological constraint) and pools exceed cap logically
      // only in count, never in composition. nPools already == largestLineage.
      warnings.push(
        'One patient/lineage has ' + largestLineage + ' samples, which forces at ' +
        'least ' + largestLineage + ' genetic pools (more than capacity would ' +
        'otherwise require). This is expected when a donor has many timepoints.'
      );
    }

    // Greedy placement into nPools bins.
    // Hard constraint: no two lineage-mates share a pool.
    // Soft constraint (tie-break): among eligible pools, prefer the one that
    // currently holds the *fewest* samples sharing this sample's value on
    // each balance column — this spreads confounders (e.g. timepoint,
    // condition) across pools instead of letting a pool become all-one-value.
    let placed = false;
    for (let attempt = 0; attempt < 200 && !placed; attempt++) {
      const pools = Array.from({ length: nPools }, () => []);
      const poolLineages = Array.from({ length: nPools }, () => new Set());
      // poolConfounderCounts[p][col][value] = count already placed in pool p
      const poolConfounderCounts = Array.from({ length: nPools }, () => ({}));
      let ok = true;

      for (const group of groups) {
        for (const sample of group) {
          const lineageKey = group[0].id; // group identity
          let target = -1;
          let bestScore = Infinity;
          for (let p = 0; p < nPools; p++) {
            if (poolLineages[p].has(lineageKey)) continue;   // hard clash, skip

            let confScore = 0;
            for (const col of balanceColumns) {
              const val = sample.confounders && sample.confounders[col];
              if (val == null || val === '') continue;
              const counts = poolConfounderCounts[p][col];
              confScore += (counts && counts[val]) || 0;
            }
            // confScore dominates (spread confounders first), pool size
            // breaks ties (keep pools roughly even otherwise).
            const score = confScore * 1000 + pools[p].length;
            if (score < bestScore) { bestScore = score; target = p; }
          }
          if (target === -1) { ok = false; break; }

          pools[target].push(sample);
          poolLineages[target].add(lineageKey);
          for (const col of balanceColumns) {
            const val = sample.confounders && sample.confounders[col];
            if (val == null || val === '') continue;
            const counts = (poolConfounderCounts[target][col] = poolConfounderCounts[target][col] || {});
            counts[val] = (counts[val] || 0) + 1;
          }
        }
        if (!ok) break;
      }

      if (ok) {
        // Success. Attach metadata and finish.
        const result = pools.filter((p) => p.length > 0);
        return {
          pools: result,
          nPools: result.length,
          minPossible: Math.max(largestLineage, minByCapacity),
          cap,
          largestLineage,
          warnings,
          confounderReport: buildConfounderReport(result, balanceColumns)
        };
      }
      nPools++; // need another pool to resolve clashes; retry
    }

    warnings.push('Could not find a valid pooling within 200 attempts — check for contradictory relatedness data.');
    return { pools: [], nPools: 0, minPossible: Math.max(largestLineage, minByCapacity), cap, largestLineage, warnings, confounderReport: [] };
  }

  /**
   * Summarize how each balance column's values are distributed across pools,
   * so the UI/export can show "Timepoint: V00 x3, V06 x3, V12 x3" per pool.
   * @returns {Array} [{ column, perPool:[{poolIndex, counts:{value:n}}] }]
   */
  function buildConfounderReport(pools, balanceColumns) {
    return (balanceColumns || []).map((col) => ({
      column: col,
      perPool: pools.map((pool, i) => {
        const counts = {};
        pool.forEach((s) => {
          const val = s.confounders && s.confounders[col];
          if (val == null || val === '') return;
          counts[val] = (counts[val] || 0) + 1;
        });
        return { poolIndex: i, counts };
      })
    }));
  }

  /**
   * How many cells each sample can actually contribute toward a per-sample
   * recovery target, and which samples fall short (e.g. small infant draws).
   * Effective contribution = min(cellsAvailable, target) when cellsAvailable
   * is known; otherwise assumed to hit the target exactly.
   * @param {Array} samples  each may carry `cellsAvailable` (number|null)
   * @param {number} targetCellsPerSample
   * @returns {Object} { totalEffective, totalTarget, shortfall:[{sampleId,cellsAvailable,target,deficit}] }
   */
  function sampleCellBudget(samples, targetCellsPerSample) {
    const target = targetCellsPerSample || 0;
    let totalEffective = 0;
    const shortfall = [];
    (samples || []).forEach((s) => {
      const avail = (s.cellsAvailable != null && s.cellsAvailable !== '' && !isNaN(s.cellsAvailable)) ? Number(s.cellsAvailable) : null;
      const eff = avail != null ? Math.min(avail, target) : target;
      totalEffective += eff;
      if (avail != null && avail < target) {
        shortfall.push({ sampleId: s.sampleId, cellsAvailable: avail, target, deficit: target - avail });
      }
    });
    return { totalEffective, totalTarget: target * (samples || []).length, shortfall };
  }

  /**
   * Assign HTOs to genetic pools and group them into loading super-pools.
   * @param {number} nPools
   * @param {Object} opts { htoAvailable }
   * @returns {Object} { assignments:[{pool, hto}], superPools:[[poolIdx...]],
   *                      htoAvailable, htoReused:boolean, warnings:[] }
   */
  function assignHTOs(nPools, opts) {
    opts = opts || {};
    const htoAvailable = opts.htoAvailable || 10;
    const warnings = [];
    const assignments = [];
    const superPools = [];

    // HTOs are unique within a super-pool but may be reused across physically
    // separate super-pools. Fill super-pools up to htoAvailable pools each.
    let poolIdx = 0;
    while (poolIdx < nPools) {
      const group = [];
      for (let h = 0; h < htoAvailable && poolIdx < nPools; h++, poolIdx++) {
        assignments.push({ pool: poolIdx, hto: 'HTO-' + (h + 1) });
        group.push(poolIdx);
      }
      superPools.push(group);
    }

    const htoReused = superPools.length > 1;
    if (htoReused) {
      warnings.push(
        nPools + ' genetic pools need HTOs but only ' + htoAvailable + ' hashtags ' +
        'are available. Pools are split into ' + superPools.length + ' separate ' +
        'loading super-pools that reuse the same hashtag set — keep these super-' +
        'pools on physically separate 10x channels so hashtags never collide.'
      );
    }

    return { assignments, superPools, htoAvailable, htoReused, warnings };
  }

  /**
   * Lane / channel count for a pooled arm.
   *   totalCells = sum of each sample's effective contribution
   *                (min(cellsAvailable, targetCellsPerSample) when known)
   *   lanes      = ceil(totalCells / recoveryPerLane)
   * recoveryPerLane is the cells-recovered-per-GEM assumption, which differs
   * by modality — e.g. CITE-seq vs ASAP-seq load very differently.
   * @param {Array|number} samplesOrN  sample objects (may carry cellsAvailable)
   *                                    or a plain sample count (legacy).
   */
  function lanesForPooledArm(samplesOrN, opts) {
    opts = opts || {};
    const target = opts.targetCellsPerSample || 4500;
    const recovery = opts.recoveryPerLane || 40000;
    let totalCells, nSamples, shortfall = [];

    if (Array.isArray(samplesOrN)) {
      const budget = sampleCellBudget(samplesOrN, target);
      totalCells = budget.totalEffective;
      shortfall = budget.shortfall;
      nSamples = samplesOrN.length;
    } else {
      nSamples = samplesOrN || 0;
      totalCells = nSamples * target;
    }

    return {
      lanes: Math.max(1, Math.ceil(totalCells / recovery)),
      totalCells,
      target,
      recovery,
      nSamples,
      shortfall
    };
  }

  /* ==========================================================================
     EXPLORE-MODE ENGINE  (ported from the Tsang multimodal calculator)
     --------------------------------------------------------------------------
     Lets you play with numbers WITHOUT sample details: pick a sample count and
     a samples-per-pool, and get pool structure, per-sample cell allocation,
     superpool math, staining/lyo, lane/chip counts, sort-population fill via
     dynamic lane assignment, and a library-by-type breakdown. All pure.
     ========================================================================== */

  // Even (balanced) split — the colleague's calcPooling. Biological constraints
  // are NOT applied here; this is the "just explore the numbers" path.
  function evenSplitPools(nSamples, samplesPerPool) {
    nSamples = Math.max(0, Math.floor(nSamples || 0));
    samplesPerPool = Math.max(1, Math.floor(samplesPerPool || 1));
    if (!nSamples) return { nPools: 0, poolSizes: [] };
    const nPools = Math.ceil(nSamples / samplesPerPool);
    const base = Math.floor(nSamples / nPools);
    const remainder = nSamples % nPools;
    const sizes = Array(nPools).fill(base);
    for (let i = 0; i < remainder; i++) sizes[i] += 1;
    return { nPools, poolSizes: sizes };
  }

  // Sort-population reference model. Frequencies are editable in the UI; these
  // are the defaults (presort = expected PBMC fraction; empirical = observed
  // sorted rate from AJ's prior run). Lineage drives which V(D)J library a lane
  // carries. Add to POPULATIONS to offer more toggles.
  const SORT_MODEL = {
    POPULATIONS: ['HSC', 'pDC', 'cDC', 'Treg', 'Trm', 'AllT', 'AllB'],
    DEFAULT_ON: ['HSC', 'pDC', 'cDC', 'Treg'],
    DISPLAY: { HSC: 'HSC', pDC: 'pDC', cDC: 'cDC', Treg: 'Treg', Trm: 'Trm', AllT: 'All T cells', AllB: 'All B cells' },
    LINEAGE: { HSC: 'none', pDC: 'none', cDC: 'none', Treg: 'T', Trm: 'T', AllT: 'T', AllB: 'B' },
    PRESORT_FREQ: { HSC: 0.0005, pDC: 0.003, cDC: 0.007, Treg: 0.03, Trm: 0.005, AllT: 0.45, AllB: 0.10 },
    // empirical falls back to presort where no observed rate exists
    EMPIRICAL_FREQ: { HSC: 0.000248, pDC: 0.000647, cDC: 0.009734, Treg: 0.010889, Trm: 0.005, AllT: 0.45, AllB: 0.10 },
    vdjLibraryFor: function (pop) {
      const l = this.LINEAGE[pop];
      return l === 'T' ? 'VDJ-TCR' : (l === 'B' ? 'VDJ-BCR' : 'none');
    }
  };

  /**
   * Dynamic sort-lane assignment (ported): populations with enough estimated
   * sorted cells to fill a lane get their own dedicated lane (capped at the
   * per-lane load); smaller populations are combined into shared lanes via
   * first-fit-decreasing bin-packing so no lane exceeds the cap. A lane's
   * library set = GEX + VDJ-TCR (if any T-lineage member) + VDJ-BCR (if any B).
   * @param {Object} popSortedCells  { popName: estimatedSortedCellCount }
   * @param {number} cellsLoadedPerLane
   * @param {Object} lineageMap  { popName: 'T'|'B'|'none' }
   * @returns {Object} { lanes:[{members:[{name,loaded}], lineages:Set, libraries}], totalLanes, libsSort }
   */
  function dynamicSortLanes(popSortedCells, cellsLoadedPerLane, lineageMap) {
    const cap = cellsLoadedPerLane || 85000;
    const lin = lineageMap || SORT_MODEL.LINEAGE;
    const pops = Object.keys(popSortedCells || {});
    const data = pops.map((name) => ({ name, sortedCells: popSortedCells[name] || 0, lineage: lin[name] || 'none' }));
    const large = data.filter((p) => p.sortedCells >= cap);
    const small = data.filter((p) => p.sortedCells < cap && p.sortedCells > 0);

    const lanes = [];
    large.forEach((p) => lanes.push({ members: [{ name: p.name, loaded: cap }], lineages: new Set([p.lineage]) }));

    const bins = [];
    [...small].sort((a, b) => b.sortedCells - a.sortedCells).forEach((p) => {
      let placed = false;
      for (const bin of bins) {
        if (bin.remaining >= p.sortedCells) {
          bin.members.push({ name: p.name, loaded: p.sortedCells });
          bin.remaining -= p.sortedCells; bin.lineages.add(p.lineage); placed = true; break;
        }
      }
      if (!placed) bins.push({ remaining: cap - p.sortedCells, members: [{ name: p.name, loaded: p.sortedCells }], lineages: new Set([p.lineage]) });
    });
    bins.forEach((bin) => lanes.push({ members: bin.members, lineages: bin.lineages }));

    lanes.forEach((lane) => {
      lane.libraries = 1 + (lane.lineages.has('T') ? 1 : 0) + (lane.lineages.has('B') ? 1 : 0);
    });
    const libsSort = lanes.reduce((s, l) => s + l.libraries, 0);
    return { lanes, totalLanes: lanes.length, libsSort };
  }

  // Sort-arm rule: ONE lane per population we sort for, regardless of recovered
  // cells (4 populations -> 4 lanes). Same return shape as dynamicSortLanes.
  function singleLanePerPop(popSortedCells, cellsLoadedPerLane, lineageMap) {
    const cap = cellsLoadedPerLane || 85000;
    const lin = lineageMap || SORT_MODEL.LINEAGE;
    const lanes = Object.keys(popSortedCells || {}).map((name) => {
      const lineage = lin[name] || 'none';
      return {
        members: [{ name, loaded: Math.min(popSortedCells[name] || 0, cap) }],
        lineages: new Set([lineage]),
        libraries: 1 + (lineage === 'T' ? 1 : 0) + (lineage === 'B' ? 1 : 0)
      };
    });
    const libsSort = lanes.reduce((s, l) => s + l.libraries, 0);
    return { lanes, totalLanes: lanes.length, libsSort };
  }

  const EXPLORE_DEFAULTS = {
    nSamples: 54, cellsPerSample: 5e6, samplesPerPool: 15,
    poolContributionPerSample: 1.5e6, allcellsPct: 1.0,
    bulkTarget: 5e5, stimPerCond: 2e5, stimN: 5,
    unsortAmt: 1.2e6, asapAmt: 1.2e6,
    stainTargetUnsort: 1.5e6, stainTargetAsap: 1.5e6, lyoCapacity: 5e5,
    cellsLoadedPerLane: 85000, rawRecoveryPerLane: 45000, qcRecoveryPerLane: 30000,
    targetRecoveryUnsortPerSample: 5000,
    targetRecoveryAsapPerLane: 10000, targetRecoveryAsapPerSample: 2650, asapPostQcPerLane: 9000, nucleiRecoveryFactor: 1.53,
    rxnPerChip: 8, rxnPerChipAsap: 8,
    stainEff: { unsort: 0.85, asap: 0.75, sort: 0.85 }, sortRecoveryEff: 1.0,
    nPeople: 3, maxSamplesPerPerson: 19,
    reads: { gex: 35000, adt: 5000, vdj: 5000, atac: 25000, hto: 1000 },
    sortPopulations: null,            // null -> SORT_MODEL.DEFAULT_ON
    populationFrequencyPresort: null, // null -> SORT_MODEL.PRESORT_FREQ
    populationFrequencyEmpirical: null,
    laneOverrides: null,              // {unsort,asap,sort} from the cost engine (target-driven)
    arms: { unsort: true, asap: true, sort: true } // which modality arms are active
  };

  /**
   * Full explore scenario. Accepts a partial cfg (merged over EXPLORE_DEFAULTS).
   * Faithful port of the colleague's runScenario, plus an `arms` gate so it can
   * reflect the modality selection, and a library-by-type pooling summary in
   * place of the old "pooling %" column.
   */
  function exploreScenario(userCfg) {
    const cfg = Object.assign({}, EXPLORE_DEFAULTS, userCfg || {});
    cfg.stainEff = Object.assign({}, EXPLORE_DEFAULTS.stainEff, (userCfg && userCfg.stainEff) || {});
    cfg.reads = Object.assign({}, EXPLORE_DEFAULTS.reads, (userCfg && userCfg.reads) || {});
    cfg.arms = Object.assign({}, EXPLORE_DEFAULTS.arms, (userCfg && userCfg.arms) || {});
    const sortPops = cfg.sortPopulations || SORT_MODEL.DEFAULT_ON;
    const presort = cfg.populationFrequencyPresort || SORT_MODEL.PRESORT_FREQ;
    const empirical = cfg.populationFrequencyEmpirical || SORT_MODEL.EMPIRICAL_FREQ;

    const { nPools, poolSizes } = evenSplitPools(cfg.nSamples, cfg.samplesPerPool);
    const perSampleNeed = cfg.poolContributionPerSample + cfg.bulkTarget + cfg.stimPerCond * cfg.stimN;
    const perSampleOk = cfg.cellsPerSample >= perSampleNeed;
    const leftoverPerSample = cfg.cellsPerSample - perSampleNeed;

    const poolFromSamples = poolSizes.map((s) => s * cfg.poolContributionPerSample);
    const totalAllcells = cfg.allcellsPct * cfg.poolContributionPerSample;
    const allcellsAddedPerPool = nPools ? totalAllcells / nPools : 0;
    const poolTotal = poolFromSamples.map((f) => f + allcellsAddedPerPool);

    const useUnsort = !!cfg.arms.unsort, useAsap = !!cfg.arms.asap, useSort = !!cfg.arms.sort;
    const unsortAmt = useUnsort ? cfg.unsortAmt : 0;
    const asapAmt = useAsap ? cfg.asapAmt : 0;
    const sortPerPool = poolTotal.map((t) => t - unsortAmt - asapAmt);
    const sortNegativeFlag = useSort && sortPerPool.some((v) => v < 0);

    // Pool-supply feasibility: can each pool actually give the fixed modality
    // takes (unsort + ASAP)? If not, the superpool numbers below are fictional
    // and the plan can't run — surfaced to the flow chart as a hard shortfall.
    const perPoolTake = unsortAmt + asapAmt;
    const poolRemainderPerPool = poolTotal.map((t) => t - perPoolTake);
    const minPoolTotal = poolTotal.length ? Math.min.apply(null, poolTotal) : 0;
    const minPoolRemainder = poolRemainderPerPool.length ? Math.min.apply(null, poolRemainderPerPool) : 0;
    const poolSupplyShortfall = (useUnsort || useAsap) && poolRemainderPerPool.some((v) => v < 0);
    const worstPoolDeficit = poolSupplyShortfall ? -minPoolRemainder : 0;

    const unsortSuperpoolRaw = nPools * unsortAmt;
    const asapSuperpoolRaw = nPools * asapAmt;
    const sortSuperpoolRaw = useSort ? sortPerPool.reduce((a, b) => a + Math.max(0, b), 0) : 0;

    const unsortStained = Math.min(unsortSuperpoolRaw, cfg.stainTargetUnsort);
    const asapStained = Math.min(asapSuperpoolRaw, cfg.stainTargetAsap);
    const unsortAvail = unsortStained * cfg.stainEff.unsort;
    const asapAvail = asapStained * cfg.stainEff.asap;
    const sortAvail = sortSuperpoolRaw * cfg.stainEff.sort;
    const unsortStainCapped = cfg.stainTargetUnsort < unsortSuperpoolRaw;
    const asapStainCapped = cfg.stainTargetAsap < asapSuperpoolRaw;
    const lyoPanelsUnsort = useUnsort ? Math.ceil(unsortStained / cfg.lyoCapacity) : 0;
    const lyoPanelsAsap = useAsap ? Math.ceil(asapStained / cfg.lyoCapacity) : 0;

    const lo = cfg.laneOverrides || {};

    // Unsort lanes: target-recovered/sample ÷ recovered/lane (or override from
    // the cost engine). NOT capped by material — material is a sufficiency check.
    const targetRecoveryUnsort = cfg.targetRecoveryUnsortPerSample * cfg.nSamples;
    const targetLanesUnsort = Math.ceil(targetRecoveryUnsort / cfg.qcRecoveryPerLane);
    const nLanesUnsort = useUnsort ? (lo.unsort != null ? lo.unsort : targetLanesUnsort) : 0;
    const cellsNeededUnsort = nLanesUnsort * cfg.cellsLoadedPerLane;
    const unsortMaterialShortfall = useUnsort && cellsNeededUnsort > unsortAvail;
    const nChipsUnsort = Math.ceil(nLanesUnsort / cfg.rxnPerChip);
    const recovUnsortQc = nLanesUnsort * cfg.qcRecoveryPerLane;

    // ASAP lanes
    const nucleiLoadedPerLane = Math.round(cfg.targetRecoveryAsapPerLane * cfg.nucleiRecoveryFactor);
    const targetRecoveryAsapTotal = cfg.targetRecoveryAsapPerSample * cfg.nSamples;
    const targetLanesAsap = Math.ceil(targetRecoveryAsapTotal / cfg.asapPostQcPerLane);
    const nLanesAsap = useAsap ? (lo.asap != null ? lo.asap : targetLanesAsap) : 0;
    const cellsNeededAsap = nLanesAsap * nucleiLoadedPerLane;
    const asapMaterialShortfall = useAsap && cellsNeededAsap > asapAvail;
    const nChipsAsap = Math.ceil(nLanesAsap / cfg.rxnPerChipAsap);
    const recovAsapQc = nLanesAsap * cfg.asapPostQcPerLane;

    // Sort populations -> dynamic lane assignment
    const popSortedCells = {}, popAvailPresort = {};
    sortPops.forEach((pop) => {
      popAvailPresort[pop] = sortAvail * (presort[pop] || 0);
      popSortedCells[pop] = sortAvail * (empirical[pop] || 0) * cfg.sortRecoveryEff;
    });
    const sortAssign = useSort ? singleLanePerPop(popSortedCells, cfg.cellsLoadedPerLane, SORT_MODEL.LINEAGE) : { lanes: [], totalLanes: 0, libsSort: 0 };
    const loadedByPop = {};
    sortAssign.lanes.forEach((lane) => lane.members.forEach((m) => { loadedByPop[m.name] = m.loaded; }));
    const sortPopTable = sortPops.map((pop) => {
      const cellsLoaded = loadedByPop[pop] || 0;
      const cellsRecoveredQcEst = cellsLoaded * (cfg.qcRecoveryPerLane / cfg.cellsLoadedPerLane);
      return {
        population: pop, display: SORT_MODEL.DISPLAY[pop] || pop,
        frequencyPresort: presort[pop] || 0, frequencyEmpirical: empirical[pop] || 0,
        cellsAvailablePresort: popAvailPresort[pop], sortedCells: popSortedCells[pop],
        cellsLoaded, cellsRecoveredQcEst, recoveredPerSample: cfg.nSamples ? cellsRecoveredQcEst / cfg.nSamples : 0,
        vdjLibrary: SORT_MODEL.vdjLibraryFor(pop)
      };
    });
    const sortGroupRows = sortAssign.lanes.map((lane, i) => ({
      name: 'Lane ' + (i + 1) + ': ' + lane.members.map((m) => m.name).join(' + '),
      members: lane.members, libraries: lane.libraries,
      hasT: lane.lineages.has('T'), hasB: lane.lineages.has('B')
    }));

    const libsUnsort = nLanesUnsort * 4; // GEX, CSP(ADT/HTO), VDJ-TCR, VDJ-BCR
    const libsAsap = nLanesAsap * 2;     // ATAC, ADT/HTO
    const libsSort = sortAssign.libsSort;
    const totalLibraries = libsUnsort + libsAsap + libsSort;

    const maxThawCapacity = cfg.nPeople * cfg.maxSamplesPerPerson;
    const thawCapacityFlag = cfg.nSamples > maxThawCapacity;

    const scenario = {
      cfg, nPools, poolSizes, perSampleNeed, perSampleOk, leftoverPerSample,
      poolFromSamples, allcellsAddedPerPool, poolTotal, sortPerPool, sortNegativeFlag,
      perPoolTake, poolRemainderPerPool, minPoolTotal, minPoolRemainder, poolSupplyShortfall, worstPoolDeficit,
      unsortSuperpoolRaw, asapSuperpoolRaw, sortSuperpoolRaw, unsortAvail, asapAvail, sortAvail,
      unsortStainCapped, asapStainCapped, unsortStained, asapStained, lyoPanelsUnsort, lyoPanelsAsap,
      targetRecoveryUnsort, nLanesUnsort, nChipsUnsort, unsortMaterialShortfall, cellsNeededUnsort, recovUnsortQc,
      recovUnsortQcPerSample: cfg.nSamples ? recovUnsortQc / cfg.nSamples : 0,
      nucleiLoadedPerLane, targetRecoveryAsapTotal, nLanesAsap, nChipsAsap, asapMaterialShortfall, cellsNeededAsap, recovAsapQc,
      recovAsapQcPerSample: cfg.nSamples ? recovAsapQc / cfg.nSamples : 0,
      sortPopTable, sortGroupRows, totalSortLanes: sortAssign.totalLanes, nChipsSort: Math.ceil(sortAssign.totalLanes / cfg.rxnPerChip),
      libsUnsort, libsAsap, libsSort, totalLibraries,
      maxThawCapacity, thawCapacityFlag, htosNeededPerModality: nPools
    };
    scenario.libraryPooling = libraryPoolingFromScenario(scenario, cfg.reads);
    return scenario;
  }

  /**
   * Library-by-type pooling — REPLACES the old "pooling %" column.
   * Real lab practice: normalize within a library type and submit ONE pooled
   * lane per type (1x GEX, 1x VDJ-TCR, 1x VDJ-BCR, 1x CSP/ADT, 1x ATAC), rather
   * than pooling every library into a single mixed submission. This returns one
   * row per library type with how many individual libraries fold into it and
   * the summed read demand (for load-balancing that one pool), NOT a % of a
   * single all-in-one pool.
   */
  function libraryPoolingFromScenario(r, reads) {
    reads = reads || EXPLORE_DEFAULTS.reads;
    // Normalize flat reads {gex,adt,vdj,atac,hto} -> per-arm form.
    const R = reads.unsort || reads.asap || reads.sort ? {
      unsort: reads.unsort || {}, asap: reads.asap || {}, sort: reads.sort || {}
    } : {
      unsort: { gex: reads.gex, adt: reads.adt, vdj: reads.vdj, hto: reads.hto },
      asap: { atac: reads.atac, adt: reads.adt, hto: reads.hto },
      sort: { gex: reads.gex, vdj: reads.vdj, hto: reads.hto }
    };
    const num = (v, d) => (v == null ? d : v);
    const rawUnsort = (r.cfg.rawRecoveryPerLane || 45000) * r.nLanesUnsort;
    const asapNuclei = (r.cfg.targetRecoveryAsapPerLane || 10000) * r.nLanesAsap;
    const rawFraction = (r.cfg.rawRecoveryPerLane || 45000) / (r.cfg.cellsLoadedPerLane || 85000);
    let sortGexRaw = 0, tRaw = 0, bRaw = 0, tLanes = 0, bLanes = 0;
    (r.sortPopTable || []).forEach((p) => {
      const rawEquiv = p.cellsLoaded * rawFraction;
      sortGexRaw += rawEquiv;
      if (p.vdjLibrary === 'VDJ-TCR') tRaw += rawEquiv;
      if (p.vdjLibrary === 'VDJ-BCR') bRaw += rawEquiv;
    });
    (r.sortGroupRows || []).forEach((g) => { if (g.hasT) tLanes += 1; if (g.hasB) bLanes += 1; });

    const byType = {};
    const add = (type, nLibs, reads) => {
      if (!byType[type]) byType[type] = { nLibraries: 0, totalReads: 0 };
      byType[type].nLibraries += nLibs; byType[type].totalReads += reads;
    };
    if (r.nLanesUnsort) {
      add('GEX', r.nLanesUnsort, rawUnsort * num(R.unsort.gex, 35000));
      add('CSP (ADT/HTO)', r.nLanesUnsort, rawUnsort * num(R.unsort.adt, 5000));
      add('VDJ-TCR', r.nLanesUnsort, rawUnsort * num(R.unsort.vdj, 5000));
      add('VDJ-BCR', r.nLanesUnsort, rawUnsort * num(R.unsort.vdj, 5000));
    }
    if (r.nLanesAsap) {
      add('ATAC', r.nLanesAsap, asapNuclei * num(R.asap.atac, 25000));
      add('ADT/HTO (ASAP)', r.nLanesAsap, asapNuclei * (num(R.asap.hto, 1000) + num(R.asap.adt, 5000)));
    }
    if (r.totalSortLanes) {
      add('GEX', r.totalSortLanes, sortGexRaw * num(R.sort.gex, 35000));
      if (tLanes) add('VDJ-TCR', tLanes, tRaw * num(R.sort.vdj, 5000));
      if (bLanes) add('VDJ-BCR', bLanes, bRaw * num(R.sort.vdj, 5000));
    }
    return Object.keys(byType).map((type) => ({
      type,
      nLibraries: byType[type].nLibraries,
      pooledSubmissions: 1,
      totalReads: byType[type].totalReads
    }));
  }

  /**
   * Alternative pooling options for the BIOLOGICAL (detail) mode. Runs
   * buildGeneticPools across a set of target samples-per-pool values, reporting
   * pool count and confounder-spread quality for each, and flags a default
   * (fewest pools with the best spread — the colleague's suggested default).
   * @returns {Array} [{ samplesPerPool, cap, nPools, spreadScore, feasible, isDefault, warnings }]
   */
  function poolingOptions(samples, relatedPairs, opts) {
    opts = opts || {};
    const balanceColumns = (opts.balanceColumns || []).filter(Boolean);
    const total = (samples || []).length;
    if (!total) return [];
    const candidates = opts.samplesPerPoolValues || [8, 10, 12, 15, 18, 20, 24];
    const seen = new Set();
    const options = [];
    candidates.forEach((spp) => {
      if (spp < 1) return;
      const res = buildGeneticPools(samples, relatedPairs, { cap: spp, balanceColumns });
      if (!res.pools.length) { options.push({ samplesPerPool: spp, cap: spp, nPools: 0, spreadScore: 0, feasible: false, warnings: res.warnings }); return; }
      const key = res.nPools;
      if (seen.has(key)) return;          // collapse caps that yield the same pool count
      seen.add(key);
      options.push({
        samplesPerPool: spp, cap: spp, nPools: res.nPools,
        spreadScore: spreadQuality(res.confounderReport),
        feasible: true, warnings: res.warnings
      });
    });
    // default = fewest pools; tie-break by best spread
    if (options.filter((o) => o.feasible).length) {
      let best = null;
      options.forEach((o) => {
        if (!o.feasible) return;
        if (!best || o.nPools < best.nPools || (o.nPools === best.nPools && o.spreadScore > best.spreadScore)) best = o;
      });
      if (best) best.isDefault = true;
    }
    return options.sort((a, b) => (a.nPools || 1e9) - (b.nPools || 1e9));
  }

  // 0..1 — higher means confounder values are more evenly spread across pools.
  function spreadQuality(confounderReport) {
    if (!confounderReport || !confounderReport.length) return 1;
    let score = 0, n = 0;
    confounderReport.forEach((c) => {
      // per value: variance of its per-pool counts (lower variance = better spread)
      const valueTotals = {};
      c.perPool.forEach((pp) => Object.keys(pp.counts).forEach((v) => { valueTotals[v] = (valueTotals[v] || 0) + pp.counts[v]; }));
      Object.keys(valueTotals).forEach((v) => {
        const counts = c.perPool.map((pp) => pp.counts[v] || 0);
        const mean = valueTotals[v] / counts.length;
        const varc = counts.reduce((s, x) => s + (x - mean) * (x - mean), 0) / counts.length;
        // normalize: spread score = 1/(1+variance)
        score += 1 / (1 + varc); n += 1;
      });
    });
    return n ? score / n : 1;
  }

  /**
   * Build a synthetic sample set from summary counts, for the "planning /
   * conceptual" input path — no real sample sheet needed. The output is shaped
   * exactly like samplesFromGrid()'s, so it flows through the SAME biological
   * pooling + cost + workflow pipeline (same-patient timepoints land in
   * different pools; related lineages kept apart; confounders spread).
   * @param {Object} cfg { nSamples, nPatients, nLineages, nTimepoints, nConditions }
   * @returns {Object} { samples, relatedPairs, balanceColumns }
   */
  function synthSamples(cfg) {
    cfg = cfg || {};
    const nSamples = Math.max(0, Math.floor(cfg.nSamples || 0));
    if (!nSamples) return { samples: [], relatedPairs: [], balanceColumns: [] };
    const nPatients = Math.min(nSamples, Math.max(1, Math.floor(cfg.nPatients || nSamples)));
    const nLineages = Math.min(nPatients, Math.max(1, Math.floor(cfg.nLineages || nPatients)));
    const nTimepoints = Math.max(1, Math.floor(cfg.nTimepoints || 1));
    const nConditions = Math.max(1, Math.floor(cfg.nConditions || 1));
    const pad = (n, w) => String(n).padStart(w, '0');

    const patientOf = [];
    for (let i = 0; i < nSamples; i++) patientOf.push(i % nPatients);
    const familyOf = [];
    for (let p = 0; p < nPatients; p++) familyOf.push(p % nLineages);
    const famSizes = {};
    familyOf.forEach((f) => { famSizes[f] = (famSizes[f] || 0) + 1; });

    const tpCount = {};
    const samples = [];
    const repSampleByPatient = {};
    for (let i = 0; i < nSamples; i++) {
      const p = patientOf[i];
      const tpIdx = (tpCount[p] || 0);
      tpCount[p] = tpIdx + 1;
      const timepoint = 'V' + pad((tpIdx % nTimepoints) + 1, 2);
      const family = familyOf[p];
      const sampleId = 'S' + pad(i + 1, 3);
      const patientId = 'P' + pad(p + 1, 2);
      const lineage = famSizes[family] > 1 ? 'L' + pad(family + 1, 2) : '';
      const confounders = { Timepoint: timepoint };
      if (nConditions > 1) confounders.Condition = 'C' + pad((i % nConditions) + 1, 2);
      samples.push({ id: i, sampleId, patientId, lineage, cellsAvailable: null, confounders });
      if (repSampleByPatient[p] == null) repSampleByPatient[p] = sampleId;
    }
    const relatedPairs = [];
    const byFamily = {};
    Object.keys(repSampleByPatient).forEach((p) => {
      const fam = familyOf[+p];
      (byFamily[fam] = byFamily[fam] || []).push(repSampleByPatient[p]);
    });
    Object.values(byFamily).forEach((reps) => { for (let i = 1; i < reps.length; i++) relatedPairs.push([reps[0], reps[i]]); });

    const balanceColumns = ['Timepoint'].concat(nConditions > 1 ? ['Condition'] : []);
    return { samples, relatedPairs, balanceColumns };
  }

  /* ==========================================================================
     FEASIBILITY HELPERS (dedicated sections in the planner)
     ========================================================================== */

  // Thaw capacity: one person thaws up to `perPerson` (19) samples in a session.
  function thawCapacity(nSamples, nPeople, perPerson) {
    perPerson = perPerson || 19;
    nPeople = Math.max(0, Math.floor(nPeople || 0));
    nSamples = Math.max(0, Math.floor(nSamples || 0));
    const maxCapacity = nPeople * perPerson;
    const ok = nSamples <= maxCapacity;
    const message = ok
      ? 'OK \u2014 within thaw capacity of ' + maxCapacity + ' (' + nPeople + ' \u00d7 ' + perPerson + ').'
      : 'FLAG: ' + nSamples + ' samples exceeds max thaw capacity of ' + maxCapacity +
        ' (' + nPeople + ' people \u00d7 ' + perPerson + '). Add a person or split across days.';
    return { maxCapacity, ok, message, perPerson, nPeople, nSamples };
  }

  /**
   * Per-sample cell allocation feasibility (matches the pipeline flowchart's
   * PER-SAMPLE SPLIT). A single pooled contribution is taken to pool (the
   * CITE/ASAP/sort split happens later, per pool); bulk RNA + stim are set aside
   * up front; the rest is leftover. A deficit means pool+bulk+stim exceed thaw.
   * @param {Object} cfg { cellsPerSample, poolContribution, bulkPerSample, stimPerSample, hasBulk, hasStim }
   */
  function perSampleAllocation(cfg) {
    cfg = cfg || {};
    const cells = Math.max(0, cfg.cellsPerSample || 0);
    const pool = Math.max(0, cfg.poolContribution || 0);
    const bulk = cfg.hasBulk === false ? 0 : Math.max(0, cfg.bulkPerSample || 0);
    const stim = cfg.hasStim === false ? 0 : Math.max(0, cfg.stimPerSample || 0);

    const items = [{ label: 'Pool contribution', amount: pool, type: 'pool' }];
    if (bulk > 0) items.push({ label: 'Bulk RNA-seq', amount: bulk, type: 'bulk' });
    if (stim > 0) items.push({ label: 'Stimulation', amount: stim, type: 'stim' });

    const committed = pool + bulk + stim;
    const leftover = cells - committed;
    const deficit = leftover < 0;
    if (!deficit) items.push({ label: 'Leftover', amount: leftover, type: 'leftover' });

    return {
      cellsPerSample: cells, items, committed, leftover, deficit, ok: !deficit,
      message: deficit
        ? 'FLAG: this plan needs ' + Math.round(committed).toLocaleString() + ' cells/sample (pool + bulk + stim) but you only have ' +
          Math.round(cells).toLocaleString() + ' \u2014 short ' + Math.round(-leftover).toLocaleString() +
          '/sample. Drop an arm, lower the pool contribution, or start with more cells.'
        : 'OK \u2014 ' + Math.round(committed).toLocaleString() + ' cells/sample committed (pool ' + Math.round(pool).toLocaleString() +
          ' + bulk ' + Math.round(bulk).toLocaleString() + ' + stim ' + Math.round(stim).toLocaleString() + '); ' +
          Math.round(leftover).toLocaleString() + '/sample leftover.'
    };
  }

  // Lyo panel staining: BioLegend universal cocktails stain up to STAIN_PER_PANEL
  // (2.0M) cells per panel of VIALS_PER_PANEL (3) vials. CITE-seq is constrained
  // to TotalSeq-C, ASAP-seq to TotalSeq-A.
  const STAIN_PER_PANEL = 2.0e6, VIALS_PER_PANEL = 3;
  const COCKTAILS = {
    cite: ['TotalSeq-C Human Universal Cocktail v1.0', 'TotalSeq-C Human Universal Cocktail v1.1'],
    asap: ['TotalSeq-A Human Universal Cocktail v1.0']
  };
  function cocktailFamilyFor(modalityKey) {
    // asap -> TotalSeq-A; any CITE/5' feature-barcode -> TotalSeq-C
    return /asap/i.test(modalityKey) ? 'asap' : 'cite';
  }
  function lyoStaining(cfg) {
    cfg = cfg || {};
    const rows = (cfg.modalities || []).map((m) => {
      const stain = Math.max(0, m.stainCells || 0);
      const panels = Math.ceil(stain / STAIN_PER_PANEL) || 0;
      const family = m.family || cocktailFamilyFor(m.key || '');
      const options = COCKTAILS[family] || COCKTAILS.cite;
      return {
        key: m.key, label: m.label, family,
        stainCells: stain, panels, vials: panels * VIALS_PER_PANEL,
        cocktail: m.cocktail || options[0], cocktailOptions: options,
        capacity: panels * STAIN_PER_PANEL
      };
    });
    return { rows, totalVials: rows.reduce((s, r) => s + r.vials, 0), stainPerPanel: STAIN_PER_PANEL, vialsPerPanel: VIALS_PER_PANEL };
  }

  const api = {
    buildLineageGroups,
    buildGeneticPools,
    buildConfounderReport,
    sampleCellBudget,
    assignHTOs,
    lanesForPooledArm,
    // explore-mode + shared engine
    evenSplitPools,
    synthSamples,
    thawCapacity,
    perSampleAllocation,
    lyoStaining,
    COCKTAILS,
    SORT_MODEL,
    dynamicSortLanes,
    singleLanePerPop,
    exploreScenario,
    libraryPoolingFromScenario,
    poolingOptions,
    spreadQuality
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Pooling = api;
})(typeof window !== 'undefined' ? window : globalThis);

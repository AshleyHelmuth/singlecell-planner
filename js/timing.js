/* timing.js — project-level library-prep timing engine (pure functions).
 * ---------------------------------------------------------------------------
 * Given a project's experiments (their arms + lane counts) and a batching
 * configuration, produce a day-by-day schedule of the cDNA + library-prep
 * steps, with per-task durations, the number of libraries flowing through each
 * task, safe-stop-aware day breaks, and per-person 8 h load flags.
 *
 * DEFAULT TIMINGS below are seeded from the lab's CITE-seq Batch-2 protocol
 * (day windows + incubations) and the 10x user guides. They are DEFAULTS meant
 * to be red-lined — every number is overridable via opts.timings. Safe-stop
 * flags are set ONLY where a 10x guide explicitly lists a "Store at ..." point.
 * ---------------------------------------------------------------------------
 */
(function (root) {
  'use strict';

  var HANDS_ON_CAP_MIN = 480;        // 8 h/person, except batch days (exempt)

  // Libraries produced per arm, per loaded lane. HTO is read through the ADT
  // library for CITE/sorted scRNA (per lab), so it is NOT its own library there.
  var ARM_LIBRARIES = {
    cite5: ['GEX', 'ADT'],                 // unsorted CITE-seq
    scrna5_sorted: ['GEX', 'ADT'],         // sorted scRNA-seq (usually + ADT)
    scrna5: ['GEX', 'HTO'],                // hashed scRNA-seq (separate HTO lib)
    asap: ['ATAC', 'ADT', 'HTO'],          // ASAP-seq
    flex: ['GEX'],                         // Flex (samples multiplexed per lane)
    vdj_tcr: ['TCR'],                      // rides on a 5' lane's cDNA
    vdj_bcr: ['BCR'],
    bulkrna: ['BulkGEX'],                  // per sample, no lane
    bulktcrbcr: ['BulkVDJ']
  };

  // Which library-prep pipeline each library type follows.
  var LIB_PIPELINE = {
    GEX: 'gex', ADT: 'adt', HTO: 'hto', TCR: 'vdj', BCR: 'vdj',
    ATAC: 'atac', BulkGEX: 'bulk', BulkVDJ: 'bulk'
  };

  // ---- DEFAULT STEP MODEL --------------------------------------------------
  // Each step: id, label, handsOnMin (base, for 1 library), perLibMin (extra
  // hands-on per additional library in the batch), incubMin (walk-away),
  // safeStopAfter (only if 10x explicitly lists a store point), maxAtOnce
  // (how many libraries one person can run in a single hands-on block).
  // pipelines map a library-prep pipeline key -> ordered steps.
  var DEFAULT_TIMINGS = {
    handsOnCapMin: HANDS_ON_CAP_MIN,

    // Batch day (one per batch). Exempt from the 8 h cap. These are the intense
    // upstream days; durations are per batch, not per library.
    batch: {
      pbmc_prep:  { label: 'Thaw · count · pool · split', handsOnMin: 180, incubMin: 0, safeStopAfter: false },
      stain_load: { label: 'Staining (CITE/ASAP/sort) → GEM load', handsOnMin: 300, incubMin: 60, safeStopAfter: false }
    },

    // cDNA generation — shared entry for GEM-based arms. Ends at the cDNA safe
    // stop (10x: purified cDNA store −20 °C up to ~1 week / 4 °C 72 h).
    cdna: {
      gem_rt_cleanup_amp: { label: 'GEM-RT → post-GEM cleanup → cDNA amplification', handsOnMin: 75, incubMin: 330, safeStopAfter: true },
      cdna_qc:            { label: 'cDNA QC (TapeStation/Qubit)', handsOnMin: 45, incubMin: 30, safeStopAfter: true }
    },

    // Library-prep pipelines. Each ends at the final-library safe stop (−20 °C).
    pipelines: {
      gex: [
        { id: 'gex_frag', label: 'Fragmentation, End Repair & A-tailing', handsOnMin: 45, incubMin: 35, safeStopAfter: false },
        { id: 'gex_lig',  label: 'Adaptor Ligation', handsOnMin: 30, incubMin: 15, safeStopAfter: false },
        { id: 'gex_pcr',  label: 'Sample Index PCR', handsOnMin: 25, incubMin: 45, safeStopAfter: false },
        { id: 'gex_spri', label: 'Double-sided SPRI cleanup + QC', handsOnMin: 45, incubMin: 20, safeStopAfter: true }
      ],
      adt: [
        { id: 'adt_pcr',  label: 'ADT/CSP Sample Index PCR', handsOnMin: 25, incubMin: 45, safeStopAfter: false },
        { id: 'adt_spri', label: 'ADT SPRI cleanup (1.2×, save sup) + QC', handsOnMin: 40, incubMin: 20, safeStopAfter: true }
      ],
      hto: [
        { id: 'hto_pcr',  label: 'HTO Sample Index PCR', handsOnMin: 25, incubMin: 45, safeStopAfter: false },
        { id: 'hto_spri', label: 'HTO SPRI cleanup + QC', handsOnMin: 40, incubMin: 20, safeStopAfter: true }
      ],
      vdj: [
        { id: 'vdj_amp',  label: 'V(D)J Amplification (from 5\u2032 cDNA)', handsOnMin: 40, incubMin: 120, safeStopAfter: true },
        { id: 'vdj_frag', label: 'V(D)J Fragmentation/ER/A-tail', handsOnMin: 45, incubMin: 35, safeStopAfter: false },
        { id: 'vdj_lig',  label: 'V(D)J Adaptor Ligation', handsOnMin: 30, incubMin: 15, safeStopAfter: false },
        { id: 'vdj_pcr',  label: 'V(D)J Sample Index PCR', handsOnMin: 25, incubMin: 45, safeStopAfter: false },
        { id: 'vdj_spri', label: 'V(D)J SPRI + QC', handsOnMin: 40, incubMin: 20, safeStopAfter: true }
      ],
      // ATAC/ASAP: transposition + GEM + pre-amp (10x explicit stop: 15 °C 18 h
      // / −20 °C 1 week), then library SI PCR + cleanup.
      atac: [
        { id: 'atac_gem', label: 'Transposition → GEM (bridge oligo) → pre-amp', handsOnMin: 90, incubMin: 150, safeStopAfter: true },
        { id: 'atac_pcr', label: 'ATAC Sample Index PCR', handsOnMin: 30, incubMin: 45, safeStopAfter: false },
        { id: 'atac_spri', label: 'ATAC SPRI cleanup + QC', handsOnMin: 45, incubMin: 20, safeStopAfter: true }
      ],
      bulk: [
        { id: 'bulk_lib', label: 'Bulk library prep (per sample)', handsOnMin: 60, incubMin: 120, safeStopAfter: true }
      ]
    }
  };

  function librariesForArm(arm) {
    var chem = arm.chem;
    // Sorted scRNA-seq carries ADT (not a separate HTO library), unlike hashed.
    if (chem === 'scrna5' && arm.population === 'sorted') chem = 'scrna5_sorted';
    var libs = ARM_LIBRARIES[chem] ? ARM_LIBRARIES[chem].slice() : ['GEX'];
    if (arm.vdj) { libs = libs.concat(ARM_LIBRARIES.vdj_tcr, ARM_LIBRARIES.vdj_bcr); }
    return libs;
  }

  // Count libraries per pipeline for a set of {arm, lanes} entries.
  function countLibraries(armLanes) {
    var byPipeline = {};   // pipeline -> library count
    var byType = {};       // library type -> count
    armLanes.forEach(function (al) {
      var lanes = al.lanes || 0;
      librariesForArm(al.arm).forEach(function (t) {
        byType[t] = (byType[t] || 0) + lanes;
        var p = LIB_PIPELINE[t] || 'gex';
        byPipeline[p] = (byPipeline[p] || 0) + lanes;
      });
    });
    return { byPipeline: byPipeline, byType: byType };
  }

  // Bundle a step into a "task" with hands-on time for N libraries. Hands-on
  // scales linearly with library count (no cap) so the user can see how big a
  // pooled prep gets and decide whether it's worth batching many at once.
  function taskFor(step, nLibs, timings) {
    return {
      id: step.id, label: step.label, libraries: nLibs,
      handsOnMin: step.handsOnMin, incubMin: step.incubMin || 0,
      safeStopAfter: !!step.safeStopAfter
    };
  }

  // Given an ordered list of tasks, bucket them into days: accumulate hands-on
  // time up to the cap; a new day starts only after a task whose safeStopAfter
  // is true (so we never break at a non-safe point). Batch days are exempt from
  // the cap. Returns [{day, exempt, tasks, handsOnMin, over}].
  function bucketDays(tasks, capMin, startDay, exemptFirst) {
    var days = [];
    var cur = { day: startDay, exempt: !!exemptFirst, tasks: [], handsOnMin: 0 };
    var lastWasSafe = true;
    tasks.forEach(function (t) {
      var wouldExceed = !cur.exempt && (cur.handsOnMin + t.handsOnMin > capMin);
      if (wouldExceed && lastWasSafe && cur.tasks.length) {
        days.push(cur);
        cur = { day: cur.day + 1, exempt: false, tasks: [], handsOnMin: 0 };
      }
      cur.tasks.push(t);
      cur.handsOnMin += t.handsOnMin;
      lastWasSafe = t.safeStopAfter;
    });
    if (cur.tasks.length) days.push(cur);
    days.forEach(function (d) {
      d.over = !d.exempt && d.handsOnMin > capMin;
      d.peopleNeeded = d.exempt ? null : Math.max(1, Math.ceil(d.handsOnMin / capMin));
    });
    return days;
  }

  // Build the ordered task list for a group of libraries (one prep campaign).
  function prepTasks(byPipeline, timings) {
    var tasks = [];
    // cDNA first (only for GEM-based pipelines that need it: gex/adt/hto/vdj/flex)
    var cdnaLibs = (byPipeline.gex || 0) + (byPipeline.adt || 0) + (byPipeline.hto || 0);
    if (cdnaLibs > 0) {
      tasks.push(taskFor(timings.cdna.gem_rt_cleanup_amp, cdnaLibs, timings));
      tasks.push(taskFor(timings.cdna.cdna_qc, cdnaLibs, timings));
    }
    ['gex', 'adt', 'hto', 'vdj', 'atac', 'bulk'].forEach(function (p) {
      var n = byPipeline[p] || 0;
      if (!n) return;
      (timings.pipelines[p] || []).forEach(function (step) { tasks.push(taskFor(step, n, timings)); });
    });
    return tasks;
  }

  /**
   * schedule(project, opts)
   * project.batches: [{ name, armLanes:[{arm:{chem,vdj}, lanes}] }]
   *   (one entry per batch day; each carries its arms + lane counts)
   * opts.config: 'perBatch' | 'pooledPrep'
   * opts.timings: overrides DEFAULT_TIMINGS (deep-ish; falls back per key)
   * returns { config, days, libraries, warnings }
   */
  function schedule(project, opts) {
    opts = opts || {};
    var timings = mergeTimings(DEFAULT_TIMINGS, opts.timings);
    var cap = timings.handsOnCapMin || HANDS_ON_CAP_MIN;
    var batches = project.batches || [];
    var config = opts.config || 'perBatch';
    var days = [];
    var warnings = [];
    var dayNum = 1;

    function batchDayTasks() {
      return [
        { id: 'pbmc_prep', label: timings.batch.pbmc_prep.label, libraries: null, handsOnMin: timings.batch.pbmc_prep.handsOnMin, incubMin: timings.batch.pbmc_prep.incubMin || 0, rounds: 1, safeStopAfter: false },
        { id: 'stain_load', label: timings.batch.stain_load.label, libraries: null, handsOnMin: timings.batch.stain_load.handsOnMin, incubMin: timings.batch.stain_load.incubMin || 0, rounds: 1, safeStopAfter: false }
      ];
    }

    if (config === 'pooledPrep') {
      // Each batch: batch day + cDNA (stop at cDNA safe point). Then ONE prep
      // campaign over the pooled libraries.
      var pooled = {};
      batches.forEach(function (b) {
        var lib = countLibraries(b.armLanes);
        Object.keys(lib.byPipeline).forEach(function (p) { pooled[p] = (pooled[p] || 0) + lib.byPipeline[p]; });
        var cdnaLibs = (lib.byPipeline.gex || 0) + (lib.byPipeline.adt || 0) + (lib.byPipeline.hto || 0);
        var bt = batchDayTasks();
        if (cdnaLibs > 0) {
          bt.push(taskFor(timings.cdna.gem_rt_cleanup_amp, cdnaLibs, timings));
          bt.push(taskFor(timings.cdna.cdna_qc, cdnaLibs, timings));
        }
        // ATAC gem/pre-amp also happens on the batch day (own safe stop)
        if (lib.byPipeline.atac) bt.push(taskFor(timings.pipelines.atac[0], lib.byPipeline.atac, timings));
        var bdays = bucketDays(bt, cap, dayNum, true); // batch day 1 exempt; overflow capped
        days = days.concat(bdays.map(function (d) { d.batch = b.name; d.phase = 'batch'; return d; }));
        dayNum = days[days.length - 1].day + 1;
      });
      // Pooled library-prep campaign (cDNA already done; skip cDNA steps here).
      var prep = [];
      ['gex', 'adt', 'hto', 'vdj', 'bulk'].forEach(function (p) {
        var n = pooled[p] || 0; if (!n) return;
        (timings.pipelines[p] || []).forEach(function (s) { prep.push(taskFor(s, n, timings)); });
      });
      // ATAC library (post gem/pre-amp) also pooled
      if (pooled.atac) { timings.pipelines.atac.slice(1).forEach(function (s) { prep.push(taskFor(s, pooled.atac, timings)); }); }
      var pdays = bucketDays(prep, cap, dayNum, false);
      days = days.concat(pdays.map(function (d) { d.batch = 'ALL (pooled)'; d.phase = 'libprep'; return d; }));
    } else {
      // perBatch: each batch runs straight through its own libraries.
      batches.forEach(function (b) {
        var lib = countLibraries(b.armLanes);
        var bt = batchDayTasks();
        var cdnaLibs = (lib.byPipeline.gex || 0) + (lib.byPipeline.adt || 0) + (lib.byPipeline.hto || 0);
        if (cdnaLibs > 0) {
          bt.push(taskFor(timings.cdna.gem_rt_cleanup_amp, cdnaLibs, timings));
          bt.push(taskFor(timings.cdna.cdna_qc, cdnaLibs, timings));
        }
        if (lib.byPipeline.atac) bt.push(taskFor(timings.pipelines.atac[0], lib.byPipeline.atac, timings));
        var bdays = bucketDays(bt, cap, dayNum, true);
        days = days.concat(bdays.map(function (d) { d.batch = b.name; d.phase = 'batch'; return d; }));
        dayNum = days[days.length - 1].day + 1;
        // library prep for this batch's libraries
        var prep = [];
        ['gex', 'adt', 'hto', 'vdj', 'bulk'].forEach(function (p) {
          var n = lib.byPipeline[p] || 0; if (!n) return;
          (timings.pipelines[p] || []).forEach(function (s) { prep.push(taskFor(s, n, timings)); });
        });
        if (lib.byPipeline.atac) { timings.pipelines.atac.slice(1).forEach(function (s) { prep.push(taskFor(s, lib.byPipeline.atac, timings)); }); }
        var pdays = bucketDays(prep, cap, dayNum, false);
        days = days.concat(pdays.map(function (d) { d.batch = b.name; d.phase = 'libprep'; return d; }));
        dayNum = days[days.length - 1].day + 1;
      });
    }

    days.forEach(function (d) {
      if (d.over) warnings.push('Day ' + d.day + (d.batch ? ' (' + d.batch + ')' : '') + ': ' + Math.round(d.handsOnMin) + ' min hands-on \u2014 needs ~' + d.peopleNeeded + ' people to stay under ' + cap + ' min each (or fewer libraries at once).');
    });

    // Project-wide library totals
    var all = {};
    batches.forEach(function (b) { var l = countLibraries(b.armLanes); Object.keys(l.byType).forEach(function (t) { all[t] = (all[t] || 0) + l.byType[t]; }); });

    return {
      config: config,
      days: days,
      totalDays: days.length,
      libPrepSessions: days.filter(function (d) { return d.phase === 'libprep'; }).length,
      libraries: all,
      warnings: warnings
    };
  }

  function mergeTimings(base, over) {
    if (!over) return base;
    var out = JSON.parse(JSON.stringify(base));
    // shallow-ish merge for the parts callers are likely to override
    if (over.handsOnCapMin != null) out.handsOnCapMin = over.handsOnCapMin;
    ['batch', 'cdna'].forEach(function (k) { if (over[k]) Object.keys(over[k]).forEach(function (s) { out[k][s] = Object.assign({}, out[k][s], over[k][s]); }); });
    if (over.pipelines) Object.keys(over.pipelines).forEach(function (p) { out.pipelines[p] = over.pipelines[p]; });
    return out;
  }

  var api = { schedule: schedule, countLibraries: countLibraries, librariesForArm: librariesForArm, DEFAULT_TIMINGS: DEFAULT_TIMINGS, ARM_LIBRARIES: ARM_LIBRARIES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Timing = api;
})(typeof window !== 'undefined' ? window : globalThis);

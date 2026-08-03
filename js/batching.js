/* batching.js — confounder-balanced batch allocation (omixer-style).
 *
 * Reimplements the core idea of the Omixer Bioconductor package: generate many
 * random assignments of samples to batches and keep the one where batch
 * membership is LEAST associated with the chosen confounding variables. For a
 * categorical confounder we use Cramér's V (batch × level), for a numeric one
 * we use eta-squared (between-batch variance / total variance); both are in
 * [0,1] where 0 = perfectly balanced. The score to minimize is the sum across
 * confounders (with an option to minimize the worst single variable instead).
 *
 * Pure and dependency-free so it runs in the browser and under node --check.
 */
(function (root) {
  'use strict';

  function isNumericField(samples, field) {
    var seen = 0, numeric = 0;
    for (var i = 0; i < samples.length; i++) {
      var v = samples[i][field];
      if (v == null || v === '') continue;
      seen++;
      if (isFinite(Number(v))) numeric++;
    }
    return seen > 0 && numeric / seen >= 0.8; // mostly-numeric => treat as numeric
  }

  // seeded PRNG (mulberry32) so results are reproducible given a seed
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rand) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // batch sizes as even as possible, summing to n
  function batchSizes(n, nBatches) {
    var base = Math.floor(n / nBatches), rem = n % nBatches, sizes = [];
    for (var b = 0; b < nBatches; b++) sizes.push(base + (b < rem ? 1 : 0));
    return sizes;
  }

  // Cramér's V between batch assignment and a categorical variable
  function cramersV(assign, values, nBatches) {
    var levels = {}, li = 0;
    values.forEach(function (v) { var k = String(v); if (!(k in levels)) levels[k] = li++; });
    var nLev = li; if (nLev < 2) return 0;
    var table = []; for (var b = 0; b < nBatches; b++) { table.push(new Array(nLev).fill(0)); }
    var rowT = new Array(nBatches).fill(0), colT = new Array(nLev).fill(0), N = 0;
    for (var i = 0; i < assign.length; i++) {
      var b2 = assign[i], l = levels[String(values[i])];
      table[b2][l]++; rowT[b2]++; colT[l]++; N++;
    }
    if (N === 0) return 0;
    var chi2 = 0;
    for (var r2 = 0; r2 < nBatches; r2++) for (var c = 0; c < nLev; c++) {
      var e = rowT[r2] * colT[c] / N;
      if (e > 0) { var d = table[r2][c] - e; chi2 += d * d / e; }
    }
    var k = Math.min(nBatches, nLev) - 1;
    return k > 0 ? Math.sqrt(chi2 / (N * k)) : 0;
  }

  // eta-squared between batch assignment and a numeric variable
  function etaSquared(assign, values, nBatches) {
    var nums = values.map(Number);
    var valid = []; for (var i = 0; i < nums.length; i++) if (isFinite(nums[i])) valid.push(i);
    if (valid.length < 2) return 0;
    var grand = 0; valid.forEach(function (i) { grand += nums[i]; }); grand /= valid.length;
    var ssTot = 0; valid.forEach(function (i) { var d = nums[i] - grand; ssTot += d * d; });
    if (ssTot === 0) return 0;
    var sum = new Array(nBatches).fill(0), cnt = new Array(nBatches).fill(0);
    valid.forEach(function (i) { sum[assign[i]] += nums[i]; cnt[assign[i]]++; });
    var ssBet = 0;
    for (var b = 0; b < nBatches; b++) if (cnt[b] > 0) { var m = sum[b] / cnt[b], dd = m - grand; ssBet += cnt[b] * dd * dd; }
    return ssBet / ssTot;
  }

  // score one assignment: per-variable association + combined
  function scoreAssignment(assign, samples, confounders, types, nBatches) {
    var per = {}, total = 0, worst = 0;
    confounders.forEach(function (f) {
      var vals = samples.map(function (s) { return s[f]; });
      var a = types[f] === 'numeric' ? etaSquared(assign, vals, nBatches) : cramersV(assign, vals, nBatches);
      per[f] = a; total += a; if (a > worst) worst = a;
    });
    return { per: per, total: total, worst: worst };
  }

  /* planBatches(samples, confounders, opts)
   *   samples: [{ <idField>, <confounder fields...> }]
   *   confounders: [fieldName, ...]
   *   opts: { nBatches, idField='sampleId', iterations=5000, seed=1,
   *           objective='sum'|'worst', samplesPerBatch (optional, overrides nBatches) }
   * returns { nBatches, sizes, assignment:{id->batch}, batches:[[id...]],
   *           balance:{ per, total, worst }, types, iterations, improvedFrom }
   */
  function planBatches(samples, spec, opts) {
    opts = opts || {};
    if (Array.isArray(spec)) spec = { balance: spec, keepTogether: [] };
    var balance = spec.balance || [];
    var keep = spec.keepTogether || [];
    var idField = opts.idField || 'sampleId';
    var n = samples.length;
    if (!n) throw new Error('no samples');
    var nBatches = opts.nBatches;
    if (!nBatches && opts.samplesPerBatch) nBatches = Math.max(1, Math.round(n / opts.samplesPerBatch));
    nBatches = Math.max(1, Math.min(nBatches || 2, n));
    var iterations = opts.iterations || 5000;
    var objective = opts.objective === 'worst' ? 'worst' : 'sum';
    var warnings = [];

    var types = {};
    balance.forEach(function (f) { types[f] = isNumericField(samples, f) ? 'numeric' : 'categorical'; });

    // atomic groups from keep-together columns (rows sharing the values stay together)
    var groups;
    if (keep.length) {
      var map = {};
      samples.forEach(function (s, i) {
        var key = keep.map(function (f) { return String(s[f]); }).join(' | ');
        (map[key] = map[key] || { key: key, members: [] }).members.push(i);
      });
      groups = Object.keys(map).map(function (k) { return map[k]; });
    } else {
      groups = samples.map(function (_, i) { return { key: String(i), members: [i] }; });
    }

    var targetSizes = batchSizes(n, nBatches);
    var maxTarget = Math.max.apply(null, targetSizes);
    groups.forEach(function (g) {
      if (g.members.length > maxTarget) warnings.push('Group "' + g.key + '" has ' + g.members.length + ' samples, larger than a batch target of ' + maxTarget + ' \u2014 it fills/overflows a batch (kept together as requested).');
    });

    var rand = rng(opts.seed || 1);
    var groupIdx = groups.map(function (_, i) { return i; });

    function packOnce(order) {
      var loads = new Array(nBatches).fill(0);
      var assign = new Array(n);
      var ordered = order.slice().sort(function (a, b) { return groups[b].members.length - groups[a].members.length; });
      ordered.forEach(function (gi) {
        var bestB = 0, bestRoom = -Infinity;
        for (var b = 0; b < nBatches; b++) { var room = targetSizes[b] - loads[b]; if (room > bestRoom) { bestRoom = room; bestB = b; } }
        groups[gi].members.forEach(function (mi) { assign[mi] = bestB; });
        loads[bestB] += groups[gi].members.length;
      });
      return assign;
    }

    var best = null, bestScore = null, firstScore = null;
    for (var it = 0; it < iterations; it++) {
      var order = shuffle(groupIdx, rand);
      var assign = packOnce(order);
      var sc = scoreAssignment(assign, samples, balance, types, nBatches);
      var metric = objective === 'worst' ? sc.worst : sc.total;
      if (it === 0) firstScore = sc;
      if (bestScore == null || metric < bestScore) { bestScore = metric; best = { assign: assign.slice(), score: sc }; }
      if (bestScore === 0 && !keep.length) break;
    }

    var assignment = {}, batches = [], sizes = new Array(nBatches).fill(0);
    for (var b2 = 0; b2 < nBatches; b2++) batches.push([]);
    samples.forEach(function (s, i) { var bb = best.assign[i]; assignment[s[idField]] = bb + 1; batches[bb].push(s[idField]); sizes[bb]++; });

    return {
      nBatches: nBatches, sizes: sizes, targetSizes: targetSizes, assignment: assignment, batches: batches,
      balance: best.score, types: types, iterations: iterations, improvedFrom: firstScore,
      groups: groups.length, keptTogether: keep, warnings: warnings
    };
  }

  // Build a human-readable balance report: per confounder, distribution across batches
  function balanceReport(samples, confounders, result, idField) {
    idField = idField || 'sampleId';
    var byId = {}; samples.forEach(function (s) { byId[s[idField]] = s; });
    var report = {};
    confounders.forEach(function (f) {
      var numeric = result.types[f] === 'numeric';
      var rows = {};
      result.batches.forEach(function (ids, b) {
        if (numeric) {
          var vals = ids.map(function (id) { return Number(byId[id][f]); }).filter(isFinite);
          var mean = vals.reduce(function (a, x) { return a + x; }, 0) / (vals.length || 1);
          rows['Batch ' + (b + 1)] = { mean: Math.round(mean * 100) / 100, n: vals.length };
        } else {
          var counts = {};
          ids.forEach(function (id) { var v = String(byId[id][f]); counts[v] = (counts[v] || 0) + 1; });
          rows['Batch ' + (b + 1)] = counts;
        }
      });
      report[f] = { type: result.types[f], association: Math.round((result.balance.per[f] || 0) * 1000) / 1000, byBatch: rows };
    });
    return report;
  }

  var api = { planBatches: planBatches, balanceReport: balanceReport };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Batching = api;
})(typeof window !== 'undefined' ? window : globalThis);

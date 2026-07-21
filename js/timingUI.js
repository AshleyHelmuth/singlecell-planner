/* timingUI.js — "Project timing planner" section on the Scheduling tab.
 * Self-contained: appends its own card to #tab-scheduling (leaving the existing
 * calendar/booking code in #schedulingContent untouched), reads saved
 * experiments from Store, and drives the pure Timing engine (js/timing.js).
 */
(function (root) {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function hm(min) { var h = Math.floor(min / 60), m = Math.round(min % 60); return (h ? h + ' h ' : '') + (m ? m + ' m' : (h ? '' : '0 m')); }

  // Map a saved experiment's laneBreakdown into engine batch input.
  function batchesForProject(projName) {
    if (!root.Store) return [];
    var exps = root.Store.experimentsInProject(projName) || [];
    var batches = [];
    exps.forEach(function (e) {
      var snap = e.snapshot;
      if (!snap || !snap.laneBreakdown) return;
      var armLanes = snap.laneBreakdown.map(function (l) {
        var chem = l.chem;
        if (chem === 'scrna5' && l.population === 'sorted') chem = 'scrna5_sorted';
        return { arm: { chem: chem, vdj: !!l.vdj }, lanes: l.lanes || 0 };
      }).filter(function (x) { return x.lanes > 0; });
      if (armLanes.length) batches.push({ name: e.name || 'Experiment', armLanes: armLanes });
    });
    return batches;
  }

  function refreshProjects(sel) {
    if (!root.Store) return;
    var names = (root.Store.projects().names || []);
    var cur = sel.value;
    sel.innerHTML = names.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('') || '<option value="">(no projects yet)</option>';
    if (names.indexOf(cur) !== -1) sel.value = cur;
  }

  function libSummary(libraries) {
    var keys = Object.keys(libraries || {});
    if (!keys.length) return 'no libraries';
    return keys.map(function (k) { return '<strong>' + libraries[k] + '</strong> ' + esc(k); }).join(' · ');
  }

  function dayCard(d) {
    var phase = d.phase === 'batch'
      ? '<span class="ptp-tag ptp-batch">Batch day</span>'
      : '<span class="ptp-tag ptp-prep">Library prep</span>';
    var load = d.exempt
      ? '<span class="who">batch day (no 8 h cap)</span>'
      : (hm(d.handsOnMin) + ' hands-on' + (d.over ? ' <span class="ptp-warn">\u26a0 needs ~' + d.peopleNeeded + ' people</span>' : ''));
    var rows = d.tasks.map(function (t) {
      return '<tr><td>' + esc(t.label) + '</td>' +
        '<td class="num">' + (t.libraries != null ? '<strong>' + t.libraries + '</strong> lib' + (t.libraries === 1 ? '' : 's') : '\u2014') + '</td>' +
        '<td class="num">' + hm(t.handsOnMin) + '</td>' +
        '<td class="num">' + (t.incubMin ? hm(t.incubMin) : '\u2014') + '</td>' +
        '<td>' + (t.safeStopAfter ? '<span class="ptp-safe">safe stop \u2714</span>' : '') + '</td></tr>';
    }).join('');
    return '<div class="ptp-day">' +
      '<div class="ptp-day-hd">' + phase + ' <strong>Day ' + d.day + '</strong> ' +
      '<span class="who">' + esc(d.batch || '') + '</span> <span class="ptp-load">' + load + '</span></div>' +
      '<table class="cost-table"><thead><tr><th>Task</th><th class="num">Libraries</th><th class="num">Hands-on</th><th class="num">Incubation</th><th>Stop</th></tr></thead><tbody>' +
      rows + '</tbody></table></div>';
  }

  function run(host, projName, config, capMin) {
    if (!root.Timing) { host.innerHTML = '<p class="empty">Timing engine not loaded.</p>'; return; }
    var batches = batchesForProject(projName);
    if (!batches.length) {
      host.innerHTML = '<div class="callout warn">No built experiments with lane counts found in project \u201c' + esc(projName) + '\u201d. Build a plan for at least one experiment (Plan \u2192 Build the plan), then it will appear here.</div>';
      return;
    }
    var opts = { config: config };
    if (capMin) opts.timings = { handsOnCapMin: capMin };
    var chosen = root.Timing.schedule({ batches: batches }, opts);
    // Also compute the other config for the comparison line.
    var other = config === 'pooledPrep' ? 'perBatch' : 'pooledPrep';
    var otherRes = root.Timing.schedule({ batches: batches }, { config: other, timings: opts.timings });

    var cmp = '<table class="cost-table"><thead><tr><th>Configuration</th><th class="num">Total days</th><th class="num">Library-prep days</th></tr></thead><tbody>' +
      '<tr' + (config === 'perBatch' ? ' class="ptp-sel"' : '') + '><td>Per-batch prep (each batch run through its own libraries)</td><td class="num">' + (config === 'perBatch' ? chosen.totalDays : otherRes.totalDays) + '</td><td class="num">' + (config === 'perBatch' ? chosen.libPrepSessions : otherRes.libPrepSessions) + '</td></tr>' +
      '<tr' + (config === 'pooledPrep' ? ' class="ptp-sel"' : '') + '><td>Pooled prep (all batches to cDNA, then one prep campaign)</td><td class="num">' + (config === 'pooledPrep' ? chosen.totalDays : otherRes.totalDays) + '</td><td class="num">' + (config === 'pooledPrep' ? chosen.libPrepSessions : otherRes.libPrepSessions) + '</td></tr>' +
      '</tbody></table>';

    var warn = chosen.warnings.length
      ? '<div class="callout warn">' + chosen.warnings.map(esc).join('<br>') + '</div>' : '';

    host.innerHTML =
      '<div class="ptp-summary">' + esc(projName) + ': <strong>' + batches.length + '</strong> batch' + (batches.length === 1 ? '' : 'es') +
      ' · libraries across the project: ' + libSummary(chosen.libraries) + '</div>' +
      cmp +
      '<p class="who">Session durations are fixed by protocol; the library count per task is shown so you can judge whether one person can handle that many within the fixed timing. Days break only at 10x-listed safe stops; batch days are exempt from the ' + (capMin || 480) + ' min/person cap.</p>' +
      warn +
      '<h4 class="ptp-h">Day-by-day \u2014 ' + (config === 'pooledPrep' ? 'pooled prep' : 'per-batch prep') + '</h4>' +
      chosen.days.map(dayCard).join('');
  }

  function mount() {
    var tab = document.getElementById('tab-scheduling');
    if (!tab || document.getElementById('projectTimingPlanner')) return;
    var sec = document.createElement('div');
    sec.id = 'projectTimingPlanner';
    sec.innerHTML =
      '<h2 class="ptp-title">Project timing planner</h2>' +
      '<p class="who">Compare how a project\u2019s batches can be run \u2014 each batch straight through its own library prep, or all batches taken to cDNA then prepped together \u2014 with a day-by-day schedule, library counts, and safe-stop-aware day breaks.</p>' +
      '<div class="ptp-controls">' +
      '<label>Project <select id="ptpProject"></select></label> ' +
      '<label>Configuration <select id="ptpConfig"><option value="perBatch">Per-batch prep</option><option value="pooledPrep">Pooled prep</option></select></label> ' +
      '<label>Hands-on cap (min/person) <input id="ptpCap" type="number" value="480" min="60" step="30" style="width:6em"></label> ' +
      '<button id="ptpRun" class="btn">Plan timing</button>' +
      '</div><div id="ptpOutput"></div>';
    tab.appendChild(sec);

    var projSel = document.getElementById('ptpProject');
    var cfgSel = document.getElementById('ptpConfig');
    var capInp = document.getElementById('ptpCap');
    var out = document.getElementById('ptpOutput');
    refreshProjects(projSel);
    projSel.addEventListener('focus', function () { refreshProjects(projSel); });
    function go() { run(out, projSel.value, cfgSel.value, Number(capInp.value) || 480); }
    document.getElementById('ptpRun').addEventListener('click', go);
    cfgSel.addEventListener('change', function () { if (out.innerHTML.trim()) go(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})(typeof window !== 'undefined' ? window : globalThis);

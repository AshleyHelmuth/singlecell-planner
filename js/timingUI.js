/* timingUI.js — "Project timing planner" on the Scheduling tab.
 * Self-contained: appends its own card to #tab-scheduling, reads saved
 * experiments from Store, drives the pure Timing engine (js/timing.js), and
 * renders a side-by-side day board of draggable task boxes connected by lines
 * per protocol flow. Layout mirrors the app's centered content width.
 */
(function (root) {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function hm(min) { var h = Math.floor(min / 60), m = Math.round(min % 60); return (h ? h + ' h ' : '') + (m ? m + ' m' : (h ? '' : '0 m')); }

  // pipeline key + colour for a task id (mirrors the workflow chart palette).
  var PIPE_COLOR = { cdna: '#12203A', gex: '#2f5c8f', adt: '#0a8f89', hto: '#8a6d1f', vdj: '#5A44D6', atac: '#2f7d53', bulk: '#a3459b', batch: '#b0611f' };
  function pipeOf(id) {
    if (id === 'pbmc_prep' || id === 'stain_load') return 'batch';
    if (id === 'gem_rt_cleanup_amp' || id === 'cdna_qc') return 'cdna';
    if (id === 'atac_gem') return 'atac';
    var p = id.split('_')[0];
    return PIPE_COLOR[p] ? p : 'gex';
  }

  function batchesForProject(projName) {
    if (!root.Store) return [];
    var exps = root.Store.experimentsInProject(projName) || [];
    var batches = [];
    exps.forEach(function (e) {
      var snap = e.snapshot; if (!snap || !snap.laneBreakdown) return;
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

  function libLine(libraries) {
    var keys = Object.keys(libraries || {});
    if (!keys.length) return 'no libraries';
    return keys.map(function (k) { return '<strong>' + libraries[k] + '</strong> ' + esc(k); }).join(' · ');
  }

  // ---- draggable day board -------------------------------------------------
  // tasks: [{uid, dayIndex, id, label, libraries, handsOnMin, incubMin,
  //          safeStopAfter, pipe, batch, phase, exemptDay}]
  var STATE = { tasks: [], nDays: 0, cap: 480 };

  function flatten(res, cap) {
    var tasks = [], uid = 0;
    res.days.forEach(function (d, di) {
      d.tasks.forEach(function (t) {
        tasks.push({
          uid: 't' + (uid++), dayIndex: di, id: t.id, label: t.label,
          libraries: t.libraries, handsOnMin: t.handsOnMin, incubMin: t.incubMin,
          safeStopAfter: t.safeStopAfter, pipe: pipeOf(t.id), batch: d.batch, phase: d.phase,
          exemptDay: !!d.exempt
        });
      });
    });
    STATE = { tasks: tasks, nDays: res.days.length, cap: cap };
  }

  function boardHTML() {
    var cols = [];
    for (var i = 0; i < STATE.nDays; i++) {
      var dayTasks = STATE.tasks.filter(function (t) { return t.dayIndex === i; });
      var boxes = dayTasks.map(function (t) {
        var c = PIPE_COLOR[t.pipe] || '#2f5c8f';
        return '<div class="ptp-box" draggable="true" data-uid="' + t.uid + '" style="border-left-color:' + c + '">' +
          '<div class="ptp-box-lbl">' + esc(t.label) + '</div>' +
          '<div class="ptp-box-meta">' + (t.libraries != null ? '<span class="ptp-libs" style="background:' + c + '">' + t.libraries + ' lib' + (t.libraries === 1 ? '' : 's') + '</span> ' : '') +
          hm(t.handsOnMin) + (t.incubMin ? ' <span class="who">+' + hm(t.incubMin) + ' incub</span>' : '') +
          (t.safeStopAfter ? ' <span class="ptp-safe">safe stop ✔</span>' : '') + '</div></div>';
      }).join('');
      cols.push('<div class="ptp-col" data-day="' + i + '"><div class="ptp-col-hd" data-dayhd="' + i + '">Day ' + (i + 1) + '</div>' +
        '<div class="ptp-col-body">' + boxes + '</div></div>');
    }
    return '<div class="ptp-board-scroll"><div class="ptp-board" id="ptpBoard">' + cols.join('') +
      '<svg class="ptp-links" id="ptpLinks"></svg></div></div>';
  }

  function recomputeHeaders() {
    for (var i = 0; i < STATE.nDays; i++) {
      var dayTasks = STATE.tasks.filter(function (t) { return t.dayIndex === i; });
      if (!dayTasks.length) continue;
      var exempt = dayTasks.some(function (t) { return t.exemptDay; });
      var phase = dayTasks.some(function (t) { return t.phase === 'batch'; }) ? 'batch' : 'libprep';
      var hands = dayTasks.reduce(function (a, t) { return a + (t.exemptDay ? 0 : t.handsOnMin); }, 0);
      var over = !exempt && hands > STATE.cap;
      var hd = document.querySelector('[data-dayhd="' + i + '"]');
      if (!hd) continue;
      hd.className = 'ptp-col-hd ' + (phase === 'batch' ? 'ptp-hd-batch' : 'ptp-hd-prep');
      hd.innerHTML = 'Day ' + (i + 1) + ' <span class="ptp-hd-tag">' + (phase === 'batch' ? 'Batch day' : 'Library prep') + '</span>' +
        '<div class="ptp-hd-load">' + (exempt ? '<span class="who">batch day · no cap</span>' : (hm(hands) + ' hands-on' + (over ? ' <span class="ptp-warn">⚠ needs ~' + Math.ceil(hands / STATE.cap) + '</span>' : ''))) + '</div>';
    }
  }

  // connectors: link consecutive tasks that share a pipe (within a batch), and
  // link cDNA QC to the first gex/adt/hto/vdj task of the same batch.
  function drawLinks() {
    var svg = document.getElementById('ptpLinks');
    var board = document.getElementById('ptpBoard');
    if (!svg || !board) return;
    var br = board.getBoundingClientRect();
    svg.setAttribute('width', board.scrollWidth);
    svg.setAttribute('height', board.scrollHeight);
    var center = {};
    STATE.tasks.forEach(function (t) {
      var el = board.querySelector('[data-uid="' + t.uid + '"]');
      if (!el) return; var r = el.getBoundingClientRect();
      center[t.uid] = { x: r.left - br.left, y: r.top - br.top, w: r.width, h: r.height, cx: r.left - br.left + r.width / 2, cy: r.top - br.top + r.height / 2 };
    });
    var lines = [];
    // group by batch
    var byBatch = {};
    STATE.tasks.forEach(function (t) { (byBatch[t.batch] = byBatch[t.batch] || []).push(t); });
    Object.keys(byBatch).forEach(function (b) {
      var arr = byBatch[b];
      // sequential within each pipe (keep original array order)
      var byPipe = {};
      arr.forEach(function (t) { (byPipe[t.pipe] = byPipe[t.pipe] || []).push(t); });
      Object.keys(byPipe).forEach(function (p) {
        var seq = byPipe[p];
        for (var i = 1; i < seq.length; i++) lines.push([seq[i - 1].uid, seq[i].uid, PIPE_COLOR[p]]);
      });
      // cDNA -> first step of each downstream pipe
      var cdna = byPipe.cdna; if (cdna && cdna.length) {
        var last = cdna[cdna.length - 1];
        ['gex', 'adt', 'hto', 'vdj'].forEach(function (p) { if (byPipe[p] && byPipe[p].length) lines.push([last.uid, byPipe[p][0].uid, PIPE_COLOR[p]]); });
      }
      // batch prep -> cDNA / atac
      var batchp = byPipe.batch; if (batchp && batchp.length) {
        var lb = batchp[batchp.length - 1];
        if (byPipe.cdna && byPipe.cdna.length) lines.push([lb.uid, byPipe.cdna[0].uid, PIPE_COLOR.cdna]);
        if (byPipe.atac && byPipe.atac.length) lines.push([lb.uid, byPipe.atac[0].uid, PIPE_COLOR.atac]);
      }
    });
    var paths = lines.map(function (ln) {
      var a = center[ln[0]], z = center[ln[1]]; if (!a || !z) return '';
      // exit right-center of a, enter left-center of z (fallback vertical if same column)
      var x1 = a.x + a.w, y1 = a.cy, x2 = z.x, y2 = z.cy;
      if (Math.abs(z.x - a.x) < 5) { x1 = a.cx; y1 = a.y + a.h; x2 = z.cx; y2 = z.y; }
      var mx = (x1 + x2) / 2;
      return '<path d="M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2 + '" fill="none" stroke="' + ln[2] + '" stroke-width="1.6" opacity="0.55"/>';
    }).join('');
    svg.innerHTML = paths;
  }

  function wireDrag() {
    var board = document.getElementById('ptpBoard');
    if (!board) return;
    var dragUid = null;
    board.addEventListener('dragstart', function (e) {
      var box = e.target.closest('.ptp-box'); if (!box) return;
      dragUid = box.getAttribute('data-uid'); e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragUid); } catch (x) {}
      box.classList.add('ptp-dragging');
    });
    board.addEventListener('dragend', function (e) { var box = e.target.closest('.ptp-box'); if (box) box.classList.remove('ptp-dragging'); });
    board.querySelectorAll('.ptp-col').forEach(function (col) {
      col.addEventListener('dragover', function (e) { e.preventDefault(); col.classList.add('ptp-col-over'); });
      col.addEventListener('dragleave', function () { col.classList.remove('ptp-col-over'); });
      col.addEventListener('drop', function (e) {
        e.preventDefault(); col.classList.remove('ptp-col-over');
        if (!dragUid) return;
        var di = Number(col.getAttribute('data-day'));
        var t = STATE.tasks.filter(function (x) { return x.uid === dragUid; })[0];
        var box = board.querySelector('[data-uid="' + dragUid + '"]');
        if (t && box) { t.dayIndex = di; col.querySelector('.ptp-col-body').appendChild(box); recomputeHeaders(); requestAnimationFrame(drawLinks); }
        dragUid = null;
      });
    });
  }

  function run(host, projName, config, capMin) {
    if (!root.Timing) { host.innerHTML = '<p class="empty">Timing engine not loaded.</p>'; return; }
    var batches = batchesForProject(projName);
    if (!batches.length) {
      host.innerHTML = '<div class="callout warn">No built experiments with lane counts found in project “' + esc(projName) + '”. Build a plan for at least one experiment (Plan → Build the plan), then it will appear here.</div>';
      return;
    }
    var cap = capMin || 480;
    var opts = { config: config, timings: { handsOnCapMin: cap } };
    var chosen = root.Timing.schedule({ batches: batches }, opts);
    var other = config === 'pooledPrep' ? 'perBatch' : 'pooledPrep';
    var otherRes = root.Timing.schedule({ batches: batches }, { config: other, timings: opts.timings });

    // per-batch library breakdown
    var perBatch = batches.map(function (b) {
      var lib = root.Timing.countLibraries(b.armLanes);
      return '<li><strong>' + esc(b.name) + '</strong>: ' + libLine(lib.byType) + '</li>';
    }).join('');

    var cmp = '<table class="cost-table"><thead><tr><th>Configuration</th><th class="num">Total days</th><th class="num">Library-prep days</th></tr></thead><tbody>' +
      '<tr' + (config === 'perBatch' ? ' class="ptp-sel"' : '') + '><td>Per-batch prep</td><td class="num">' + (config === 'perBatch' ? chosen.totalDays : otherRes.totalDays) + '</td><td class="num">' + (config === 'perBatch' ? chosen.libPrepSessions : otherRes.libPrepSessions) + '</td></tr>' +
      '<tr' + (config === 'pooledPrep' ? ' class="ptp-sel"' : '') + '><td>Pooled prep</td><td class="num">' + (config === 'pooledPrep' ? chosen.totalDays : otherRes.totalDays) + '</td><td class="num">' + (config === 'pooledPrep' ? chosen.libPrepSessions : otherRes.libPrepSessions) + '</td></tr>' +
      '</tbody></table>';

    flatten(chosen, cap);

    host.innerHTML =
      '<div class="ptp-summary">' + esc(projName) + ': <strong>' + batches.length + '</strong> batch' + (batches.length === 1 ? '' : 'es') + ' · project libraries: ' + libLine(chosen.libraries) + '</div>' +
      '<ul class="ptp-perbatch">' + perBatch + '</ul>' +
      cmp +
      '<p class="who">Drag a task box to a different day to try a layout. Boxes are coloured by protocol flow and connected by lines showing dependencies. Session durations are fixed; the library count on each box is for judging one-person feasibility. Days should only break at a “safe stop ✔”.</p>' +
      '<h4 class="ptp-h">Day board — ' + (config === 'pooledPrep' ? 'pooled prep' : 'per-batch prep') + ' <span class="who">(drag to rearrange)</span></h4>' +
      boardHTML();

    recomputeHeaders();
    wireDrag();
    requestAnimationFrame(drawLinks);
    if (!run._resizeHooked) { window.addEventListener('resize', function () { requestAnimationFrame(drawLinks); }); run._resizeHooked = true; }
  }

  function mount() {
    var tab = document.getElementById('tab-scheduling');
    if (!tab || document.getElementById('projectTimingPlanner')) return;
    var sec = document.createElement('div');
    sec.id = 'projectTimingPlanner';
    sec.innerHTML =
      '<h2 class="ptp-title">Project timing planner</h2>' +
      '<p class="who">Compare how a project’s batches can be run — each batch straight through its own library prep, or all batches taken to cDNA then prepped together — as a draggable day-by-day board.</p>' +
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

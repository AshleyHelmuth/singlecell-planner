/* batchingUI.js — "Sample batching" panel on the Project manager tab.
 * Paste a sample table, pick the ID column + confounding variables, choose how
 * many batches (or target size), and run the confounder-balanced allocation
 * (js/batching.js). Shows batch sizes, per-variable balance, and the assignment,
 * with CSV export. Self-contained: appends to #tab-projects so renderManage()'s
 * updates to #manageContent don't disturb it. Sample lists/plans are cached in
 * localStorage per project (Drive persistence is a planned follow-up).
 */
(function (root) {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  var LS_KEY = 'scp:batching:v1';

  function loadStore() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; } }
  function saveStore(o) { try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch (e) {} }

  function parseTable(text) {
    var lines = text.replace(/\r/g, '').split('\n').filter(function (l) { return l.trim() !== ''; });
    if (lines.length < 2) return null;
    var delim = (lines[0].indexOf('\t') >= 0) ? '\t' : ',';
    var headers = lines[0].split(delim).map(function (h) { return h.trim(); });
    var rows = lines.slice(1).map(function (l) {
      var cells = l.split(delim);
      var o = {}; headers.forEach(function (h, i) { o[h] = (cells[i] == null ? '' : cells[i].trim()); });
      return o;
    });
    return { headers: headers, rows: rows };
  }

  var PARSED = null, PROJECT = null;

  function refreshProjects(sel) {
    if (!root.Store) return;
    var names = (root.Store.projects().names || []);
    sel.innerHTML = names.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('') || '<option value="">(create a project first)</option>';
  }

  function renderColumnPickers(host) {
    if (!PARSED) { host.innerHTML = ''; return; }
    var h = PARSED.headers;
    host.innerHTML =
      '<div class="bx-row"><label>ID column <select id="bxId">' +
      h.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('') +
      '</select></label></div>' +
      '<div class="bx-collabels"><span class="bx-lbl">Set how each column is used:</span></div>' +
      '<div class="bx-cols">' + h.map(function (c) {
        return '<div class="bx-col"><span class="bx-colname">' + esc(c) + '</span>' +
          '<select data-bx-role="' + esc(c) + '">' +
          '<option value="ignore">Ignore</option>' +
          '<option value="balance">Balance (spread evenly)</option>' +
          '<option value="keep">Keep together (same value \u2192 same batch)</option>' +
          '</select></div>';
      }).join('') + '</div>' +
      '<div class="bx-row"><label>Batches <input id="bxN" type="number" min="1" value="2" style="width:5em"></label>' +
      ' <span class="who">or</span> <label>target samples/batch <input id="bxPer" type="number" min="1" placeholder="auto" style="width:6em"></label>' +
      ' <button id="bxRun" class="btn">Create batch plan</button></div>' +
      '<p class="who">' + PARSED.rows.length + ' samples parsed. <strong>Balance</strong> spreads a variable evenly across batches to minimize confounding; <strong>Keep together</strong> groups all rows sharing that column\u2019s value (e.g. all timepoints for one patient) into the same batch.</p>';
    host.querySelector('#bxRun').addEventListener('click', run);
  }

  var INFO = {
    total: 'Total imbalance = the sum of the association scores across all your balanced variables. 0 means batch membership is completely independent of every variable (ideal). Lower is better. Use it to compare batch-count options at a glance.',
    worst: 'Worst variable = the single largest association score among your balanced variables. Even if the total looks fine, a high worst value means one variable is poorly balanced. Lower is better.',
    cramersV: "Cramer's V (categorical variables like sex or cohort): measures how strongly a variable's categories are associated with batch assignment, from 0 (evenly spread across batches) to 1 (each category confined to its own batch). Lower = better balanced.",
    eta2: 'Eta-squared (numeric variables like age): the fraction of the variable\u2019s total variance that is explained by which batch a sample is in, from 0 (batch means all equal \u2014 balanced) to 1 (batches completely separate the values). Lower = better balanced.',
    assoc: 'Association: how related this variable is to batch assignment. For categorical variables this is Cramer\u2019s V; for numeric variables it is eta-squared. In both, 0 = perfectly balanced and 1 = fully confounded with batch.'
  };
  function infoTip(key, label) {
    return '<span class="bx-info" data-bxinfo="' + key + '" title="' + esc(INFO[key]) + '" role="button" tabindex="0">' + label + ' \u24d8</span>';
  }

  var STATE = null; // { samples, cols, balance, keep, cmp }

  function run() {
    var out = document.getElementById('bxOutput');
    if (!PARSED || !root.Batching) { out.innerHTML = '<div class="callout warn">Parse a sample table first.</div>'; return; }
    var idField = document.getElementById('bxId').value;
    var balance = [], keep = [];
    Array.prototype.slice.call(document.querySelectorAll('[data-bx-role]')).forEach(function (sel) {
      var col = sel.getAttribute('data-bx-role');
      if (sel.value === 'balance') balance.push(col);
      else if (sel.value === 'keep') keep.push(col);
    });
    if (!balance.length && !keep.length) { out.innerHTML = '<div class="callout warn">Set at least one column to Balance or Keep together.</div>'; return; }
    var nB = Number(document.getElementById('bxN').value) || null;
    var per = Number(document.getElementById('bxPer').value) || null;
    var cols = balance.concat(keep);
    var samples = PARSED.rows.map(function (r) { var o = { sampleId: r[idField] }; cols.forEach(function (f) { o[f] = r[f]; }); return o; }).filter(function (s) { return s.sampleId; });
    var cmp;
    try {
      cmp = root.Batching.compareBatchCounts(samples, { balance: balance, keepTogether: keep }, { nBatches: nB, samplesPerBatch: per, idField: 'sampleId', iterations: 5000, seed: 12345, span: 1 });
    } catch (e) { out.innerHTML = '<div class="callout warn">' + esc(e.message) + '</div>'; return; }
    STATE = { samples: samples, cols: cols, balance: balance, keep: keep, cmp: cmp };

    var best = cmp.options.reduce(function (a, b) { return b.total < a.total ? b : a; });
    var maxTotal = Math.max.apply(null, cmp.options.map(function (o) { return o.total; })) || 1;

    var rows = cmp.options.map(function (o) {
      var pct = Math.round((o.total / maxTotal) * 100);
      var badge = (o.nBatches === cmp.target ? '<span class="bx-badge bx-tgt">your pick</span>' : '') + (o === best ? '<span class="bx-badge bx-best">best balance</span>' : '');
      return '<tr class="bx-opt' + (o.nBatches === cmp.target ? ' bx-opt-target' : '') + '" data-nb="' + o.nBatches + '">' +
        '<td class="num"><strong>' + o.nBatches + '</strong> ' + badge + '</td>' +
        '<td class="num">' + o.avgSize + '</td>' +
        '<td>[' + o.sizes.join(', ') + ']</td>' +
        '<td><div class="bx-bar"><div class="bx-bar-fill" style="width:' + pct + '%"></div><span class="bx-bar-num">' + o.total.toFixed(3) + '</span></div></td>' +
        '<td class="num">' + o.worst.toFixed(3) + '</td>' +
        (o.warnings && o.warnings.length ? '<td>\u26a0</td>' : '<td></td>') + '</tr>';
    }).join('');

    out.innerHTML =
      '<h4 class="bx-h">Compare batch counts</h4>' +
      '<p class="who">Lower ' + infoTip('total', 'total imbalance') + ' is better. Your pick and the best-balancing option are marked; click a row to see its detail.</p>' +
      '<table class="cost-table bx-cmp"><thead><tr><th class="num">Batches</th><th class="num">Avg size</th><th>Sizes</th><th>' + infoTip('total', 'Total imbalance') + '</th><th class="num">' + infoTip('worst', 'Worst') + '</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div id="bxInfoBox" class="bx-infobox" hidden></div>' +
      '<div id="bxDetail"></div>';

    out.querySelectorAll('.bx-opt').forEach(function (tr) { tr.addEventListener('click', function () { renderDetail(Number(tr.getAttribute('data-nb'))); }); });
    out.querySelectorAll('[data-bxinfo]').forEach(function (el) {
      el.addEventListener('click', function (e) { e.stopPropagation(); showInfo(el.getAttribute('data-bxinfo')); });
    });
    renderDetail(cmp.target);
  }

  function showInfo(key) {
    var box = document.getElementById('bxInfoBox'); if (!box) return;
    box.hidden = false; box.innerHTML = '<strong>' + key.replace('cramersV', "Cramer's V").replace('eta2', 'Eta-squared').replace('assoc', 'Association').replace('total', 'Total imbalance').replace('worst', 'Worst variable') + ':</strong> ' + esc(INFO[key] || '');
  }

  function renderDetail(nb) {
    var d = document.getElementById('bxDetail'); if (!d || !STATE) return;
    var opt = STATE.cmp.options.filter(function (o) { return o.nBatches === nb; })[0]; if (!opt) return;
    var res = opt.result, samples = STATE.samples, cols = STATE.cols, balance = STATE.balance, keep = STATE.keep;
    d.querySelectorAll && document.querySelectorAll('.bx-opt').forEach(function (tr) { tr.classList.toggle('bx-opt-sel', Number(tr.getAttribute('data-nb')) === nb); });
    var rep = balance.length ? root.Batching.balanceReport(samples, balance, res, 'sampleId') : {};
    var DOT = ' \u00b7 ';
    var balRows = balance.map(function (f) {
      var r = rep[f]; var cells;
      if (r.type === 'numeric') cells = Object.keys(r.byBatch).map(function (b) { return b + ': mean ' + r.byBatch[b].mean + ' (n=' + r.byBatch[b].n + ')'; }).join(DOT);
      else cells = Object.keys(r.byBatch).map(function (b) { return b + ': ' + Object.keys(r.byBatch[b]).map(function (lv) { return lv + '=' + r.byBatch[b][lv]; }).join(', '); }).join(DOT);
      var statInfo = r.type === 'numeric' ? 'eta2' : 'cramersV';
      return '<tr><td>' + esc(f) + '</td><td>' + r.type + ' <span class="bx-info" data-bxinfo="' + statInfo + '" title="' + esc(INFO[statInfo]) + '" role="button" tabindex="0">\u24d8</span></td><td class="num">' + r.association.toFixed(3) + '</td><td>' + esc(cells) + '</td></tr>';
    }).join('');
    // simple stacked size visual
    var totalN = res.sizes.reduce(function (a, x) { return a + x; }, 0) || 1;
    var sizeBar = '<div class="bx-sizes">' + res.sizes.map(function (sz, i) { return '<div class="bx-seg" style="width:' + (sz / totalN * 100) + '%" title="Batch ' + (i + 1) + ': ' + sz + '">' + sz + '</div>'; }).join('') + '</div>';
    var assignRows = samples.map(function (s) { return '<tr><td>' + esc(s.sampleId) + '</td><td class="num">' + res.assignment[s.sampleId] + '</td>' + cols.map(function (f) { return '<td>' + esc(s[f]) + '</td>'; }).join('') + '</tr>'; }).join('');

    d.innerHTML =
      '<h4 class="bx-h">Detail \u2014 ' + nb + ' batches</h4>' +
      (keep.length ? '<p class="who">Kept together by <strong>' + keep.map(esc).join(', ') + '</strong> (' + res.groups + ' groups).</p>' : '') +
      sizeBar +
      (res.warnings && res.warnings.length ? '<div class="callout warn">' + res.warnings.map(esc).join('<br>') + '</div>' : '') +
      (balance.length ? '<table class="cost-table"><thead><tr><th>Balanced variable</th><th>Type</th><th class="num">' + infoTip('assoc', 'Association') + '</th><th>Distribution across batches</th></tr></thead><tbody>' + balRows + '</tbody></table>' : '') +
      '<div class="bx-row"><button id="bxCsv" class="btn ghost">Download assignment CSV</button> <button id="bxSave" class="btn ghost">Save to project</button></div>' +
      '<details class="bx-details"><summary>Sample assignment (' + samples.length + ')</summary>' +
      '<table class="cost-table"><thead><tr><th>Sample</th><th class="num">Batch</th>' + cols.map(function (f) { return '<th>' + esc(f) + '</th>'; }).join('') + '</tr></thead><tbody>' + assignRows + '</tbody></table></details>';

    d.querySelectorAll('[data-bxinfo]').forEach(function (el) { el.addEventListener('click', function (e) { e.stopPropagation(); showInfo(el.getAttribute('data-bxinfo')); }); });
    document.getElementById('bxCsv').addEventListener('click', function () {
      var head = ['sampleId', 'batch'].concat(cols).join(',');
      var body = samples.map(function (s) { return [s.sampleId, res.assignment[s.sampleId]].concat(cols.map(function (f) { return s[f]; })).join(','); }).join('\n');
      var blob = new Blob([head + '\n' + body], { type: 'text/csv' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'batch_plan_' + (PROJECT || 'project') + '_' + nb + 'batches.csv'; a.click();
    });
    document.getElementById('bxSave').addEventListener('click', function () {
      var store = loadStore(); store[PROJECT || '(unfiled)'] = { samples: PARSED.rows, idField: document.getElementById('bxId').value, balance: balance, keepTogether: keep, nBatches: nb, plan: { assignment: res.assignment, sizes: res.sizes, balance: res.balance } };
      saveStore(store); document.getElementById('bxSave').textContent = 'Saved \u2713';
    });
  }

  function mount() {
    var host = document.getElementById('planProjectContent') || document.getElementById('tab-planproject');
    if (!host || document.getElementById('sampleBatching')) return;
    var noProj = (root.Store && (root.Store.projects().names || []).length === 0);
    var sec = document.createElement('div');
    sec.id = 'sampleBatching';
    sec.innerHTML =
      '<h2 class="bx-title">Plan project \u2014 sample batching</h2>' +
      '<p class="who">Plan confounder-balanced batches for a whole project before assigning samples to experiments. Paste your sample table (CSV or tab-separated, with a header row), choose the ID column and how each column is used, and set the number of batches.</p>' +
      '<div id="bxNoProj" class="callout warn"' + (noProj ? '' : ' hidden') + '>Select or create a project on the <strong>Project manager</strong> tab before planning batches.</div>' +
      '<div class="bx-row"><label>Project <select id="bxProject"></select></label></div>' +
      '<textarea id="bxPaste" rows="6" placeholder="sampleId,patientId,sex,age,cohort\n1234-d1-001,1234,F,42,A\n..." style="width:100%;font-family:monospace;font-size:12px"></textarea>' +
      '<div class="bx-row"><button id="bxParse" class="btn">Parse samples</button></div>' +
      '<div id="bxCols"></div><div id="bxOutput"></div>';
    host.appendChild(sec);
    var projSel = document.getElementById('bxProject');
    refreshProjects(projSel); PROJECT = projSel.value;
    if (PROJECT && root.setActiveProject) root.setActiveProject(PROJECT);
    projSel.addEventListener('focus', function () { refreshProjects(projSel); });
    projSel.addEventListener('change', function () { PROJECT = projSel.value; if (root.setActiveProject) root.setActiveProject(PROJECT); });
    document.getElementById('bxParse').addEventListener('click', function () {
      PARSED = parseTable(document.getElementById('bxPaste').value);
      if (!PARSED) { document.getElementById('bxCols').innerHTML = '<div class="callout warn">Need a header row plus at least one sample row.</div>'; return; }
      renderColumnPickers(document.getElementById('bxCols'));
      document.getElementById('bxOutput').innerHTML = '';
    });
    // refresh the no-project prompt whenever the tab is shown
    var tabBtn = document.querySelector('[data-tab="planproject"]');
    if (tabBtn) tabBtn.addEventListener('click', function () {
      var np = document.getElementById('bxNoProj');
      if (np) np.hidden = !(root.Store && (root.Store.projects().names || []).length === 0);
      refreshProjects(projSel);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})(typeof window !== 'undefined' ? window : globalThis);

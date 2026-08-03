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
    var res;
    try {
      res = root.Batching.planBatches(samples, { balance: balance, keepTogether: keep }, { nBatches: nB, samplesPerBatch: per, idField: 'sampleId', iterations: 6000, seed: 12345 });
    } catch (e) { out.innerHTML = '<div class="callout warn">' + esc(e.message) + '</div>'; return; }
    var rep = balance.length ? root.Batching.balanceReport(samples, balance, res, 'sampleId') : {};
    var DOT = ' \u00b7 ';
    var balRows = balance.map(function (f) {
      var r = rep[f]; var cells;
      if (r.type === 'numeric') cells = Object.keys(r.byBatch).map(function (b) { return b + ': mean ' + r.byBatch[b].mean + ' (n=' + r.byBatch[b].n + ')'; }).join(DOT);
      else cells = Object.keys(r.byBatch).map(function (b) { return b + ': ' + Object.keys(r.byBatch[b]).map(function (lv) { return lv + '=' + r.byBatch[b][lv]; }).join(', '); }).join(DOT);
      return '<tr><td>' + esc(f) + '</td><td>' + r.type + '</td><td class="num">' + r.association.toFixed(3) + '</td><td>' + esc(cells) + '</td></tr>';
    }).join('');
    var assignRows = samples.map(function (s) { return '<tr><td>' + esc(s.sampleId) + '</td><td class="num">' + res.assignment[s.sampleId] + '</td>' + cols.map(function (f) { return '<td>' + esc(s[f]) + '</td>'; }).join('') + '</tr>'; }).join('');
    out.innerHTML =
      '<div class="bx-summary"><strong>' + res.nBatches + '</strong> batches, sizes [' + res.sizes.join(', ') + ']' +
      (keep.length ? ' \u00b7 kept together by: <strong>' + keep.map(esc).join(', ') + '</strong> (' + res.groups + ' groups)' : '') + '. ' +
      (balance.length ? 'Balance imbalance <strong>' + res.balance.total.toFixed(3) + '</strong> (0 = perfect); random start ' + res.improvedFrom.total.toFixed(3) + '.' : '') + '</div>' +
      (res.warnings && res.warnings.length ? '<div class="callout warn">' + res.warnings.map(esc).join('<br>') + '</div>' : '') +
      (balance.length ? '<table class="cost-table"><thead><tr><th>Balanced variable</th><th>Type</th><th class="num">Association</th><th>Distribution across batches</th></tr></thead><tbody>' + balRows + '</tbody></table>' : '') +
      '<div class="bx-row"><button id="bxCsv" class="btn ghost">Download assignment CSV</button> <button id="bxSave" class="btn ghost">Save to project</button></div>' +
      '<details class="bx-details"><summary>Sample assignment (' + samples.length + ')</summary>' +
      '<table class="cost-table"><thead><tr><th>Sample</th><th class="num">Batch</th>' + cols.map(function (f) { return '<th>' + esc(f) + '</th>'; }).join('') + '</tr></thead><tbody>' + assignRows + '</tbody></table></details>';
    document.getElementById('bxCsv').addEventListener('click', function () {
      var head = ['sampleId', 'batch'].concat(cols).join(',');
      var body = samples.map(function (s) { return [s.sampleId, res.assignment[s.sampleId]].concat(cols.map(function (f) { return s[f]; })).join(','); }).join('\n');
      var blob = new Blob([head + '\n' + body], { type: 'text/csv' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'batch_plan_' + (PROJECT || 'project') + '.csv'; a.click();
    });
    document.getElementById('bxSave').addEventListener('click', function () {
      var store = loadStore(); store[PROJECT || '(unfiled)'] = { samples: PARSED.rows, idField: idField, balance: balance, keepTogether: keep, plan: { assignment: res.assignment, sizes: res.sizes, balance: res.balance } };
      saveStore(store); document.getElementById('bxSave').textContent = 'Saved \u2713';
    });
  }

  function mount() {
    var tab = document.getElementById('tab-projects');
    if (!tab || document.getElementById('sampleBatching')) return;
    var sec = document.createElement('div');
    sec.id = 'sampleBatching'; sec.className = 'wrap';
    sec.innerHTML =
      '<h2 class="bx-title">Sample batching</h2>' +
      '<p class="who">Plan confounder-balanced batches for a whole project before assigning samples to experiments. Paste your sample table (CSV or tab-separated, with a header row), choose the ID column and the variables to balance, and set the number of batches.</p>' +
      '<div class="bx-row"><label>Project <select id="bxProject"></select></label></div>' +
      '<textarea id="bxPaste" rows="6" placeholder="sampleId,sex,age,cohort\n1234-d1-001,F,42,A\n..." style="width:100%;font-family:monospace;font-size:12px"></textarea>' +
      '<div class="bx-row"><button id="bxParse" class="btn">Parse samples</button></div>' +
      '<div id="bxCols"></div><div id="bxOutput"></div>';
    tab.appendChild(sec);
    var projSel = document.getElementById('bxProject');
    refreshProjects(projSel); PROJECT = projSel.value;
    projSel.addEventListener('focus', function () { refreshProjects(projSel); });
    projSel.addEventListener('change', function () { PROJECT = projSel.value; });
    document.getElementById('bxParse').addEventListener('click', function () {
      PARSED = parseTable(document.getElementById('bxPaste').value);
      if (!PARSED) { document.getElementById('bxCols').innerHTML = '<div class="callout warn">Need a header row plus at least one sample row.</div>'; return; }
      renderColumnPickers(document.getElementById('bxCols'));
      document.getElementById('bxOutput').innerHTML = '';
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})(typeof window !== 'undefined' ? window : globalThis);

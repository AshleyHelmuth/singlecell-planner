/* ============================================================================
   workflow.js  —  Generates the experiment workflow visuals.
     renderSampleFlow(plan)  -> SVG string (samples -> pools -> arms -> lanes)
     renderPersonnelPlan(plan, data) -> HTML string (swimlane by person/phase)
   Modeled on Pipeline_Flowcharts_AA.pdf (MADI batch flow + Person 1/2/3 grid).
   Pure string builders; exported as window.Workflow.
   ============================================================================ */

(function (root) {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Distinct-ish hues for pools (HSL wheel).
  function poolColor(i, n) {
    const hue = Math.round((i * 360) / Math.max(n, 1));
    return 'hsl(' + hue + ' 62% 47%)';
  }

  const ARM_LABELS = {
    unsort5: { title: "Unsort 5' (CITE-seq)", stain: 'Fc block → TotalSeq-C HTO → TotalSeq-C lyo panel', cells: '~1.2M cells/pool' },
    asap3:   { title: "ASAP-seq (3'/ATAC)", stain: 'Fc block → TotalSeq-A HTO → TotalSeq-A lyo panel → nuclei/Tn5', cells: '~1.2M cells/pool' },
    sort5:   { title: "Sort 5'", stain: 'L/D stain → Fc block → HTO → fluor sort Ab panel → FACS', cells: 'rest of cells (~11M/pool)' },
    flex:    { title: 'Flex (fixed)', stain: 'Fixation → probe hybridization → barcoding', cells: 'per-sample fixed' },
    stim:    { title: 'In vitro stim', stain: 'Reserve cells → stimulate → (later Flex/scRNAseq)', cells: '~200k cells/sample' }
  };

  // Format a raw cell count compactly: 5000000 -> "5M", 1500000 -> "1.5M", 200000 -> "200k".
  function fmtCells(n) {
    if (n == null || isNaN(n)) return '?';
    if (Math.abs(n) >= 1e6) { const v = n / 1e6; return (Number.isInteger(v) ? v : v.toFixed(1)) + 'M'; }
    if (Math.abs(n) >= 1e3) return Math.round(n / 1e3) + 'k';
    return String(Math.round(n));
  }

  const LIB_LABEL = {
    GEX: 'GEX', ADT: 'ADT', HTO: 'HTO', ATAC: 'ATAC',
    TCR: 'V(D)J TCR', BCR: 'V(D)J BCR', FlexGEX: 'Flex GEX',
    BulkGEX: 'Bulk RNA', BulkTCR: 'Bulk TCR', BulkBCR: 'Bulk BCR'
  };

  /**
   * Cell-accounting flow: samples -> per-sample split (pooling / stim / bulk) ->
   * genetic pools -> per-modality super-pools -> loading channels -> libraries.
   * Cell-count assumptions come from the Cell_Flow_Assumptions sheet (plan.cellFlow);
   * channel counts + libraries come from the cost engine's per-load lane breakdown.
   *
   * Cell model (from the MADI protocol):
   *  - Each sample contributes a FIXED amount to pooling (default 1.5M) regardless of
   *    how many cells it had, plus a fixed bulk reserve (500k, 100k floor) and a stim
   *    reserve (200k). Leftover beyond these is banked, not used.
   *  - Each genetic pool is split by taking a FIXED amount per non-sort droplet load
   *    (default 1.2M/pool for unsort & ASAP); the sorted load takes the REMAINDER.
   *
   * @param {Object} plan { nSamples, nPools, pools, cap, laneBreakdown,
   *   cellFlow:{start,pooling,bulk,bulkLow,stim,poolLoad,allcells} }
   */
  function renderSampleFlow(plan) {
    const CF = Object.assign({ start: 5000000, pooling: 1500000, bulk: 500000, bulkLow: 100000,
      stim: 200000, poolLoad: 1200000, panelStain: 1500000, atLoad: 1200000, allcells: 0.25 }, plan.cellFlow || {});
    const S = plan.nSamples || 0;
    const nP = Math.max(1, plan.nPools || 1);
    const lb = (plan.laneBreakdown || []).slice();

    // Columns = each library-producing load, grouped by upstream source.
    const cols = lb.map((l) => {
      let source = 'pool';
      if (l.population === 'stim') source = 'stim';
      else if (l.population === 'bulk') source = 'bulk';
      return { l, source, isSort: l.population === 'sorted' };
    });
    const pooledCols = cols.filter((c) => c.source === 'pool');
    const stimCols = cols.filter((c) => c.source === 'stim');
    const bulkCols = cols.filter((c) => c.source === 'bulk');
    const ordered = pooledCols.concat(stimCols, bulkCols);
    const n = Math.max(1, ordered.length);

    const hasPooled = pooledCols.length > 0;
    const hasStim = stimCols.length > 0;
    const hasBulk = bulkCols.length > 0;

    // ---- Per-sample fixed takes ----------------------------------------------
    const committedPer = (hasPooled ? CF.pooling : 0) + (hasBulk ? CF.bulk : 0) + (hasStim ? CF.stim : 0);
    const bankedPer = Math.max(0, CF.start - committedPer);
    const sampleOk = committedPer <= CF.start;

    // ---- Genetic pool totals + per-pool split --------------------------------
    const allcellsMult = 1 + (CF.allcells || 0);
    const poolingTotal = hasPooled ? S * CF.pooling * allcellsMult : 0; // incl. ALLCELLS control
    const avgPoolTotal = poolingTotal / nP;
    const fixedCols = pooledCols.filter((c) => !c.isSort);   // unsort / ASAP: fixed take per pool
    const sortCols = pooledCols.filter((c) => c.isSort);     // sorted: takes the remainder
    const fixedTakenPerPool = fixedCols.length * CF.poolLoad;
    const remainderPerPool = Math.max(0, avgPoolTotal - fixedTakenPerPool);
    const sortTakePerPool = sortCols.length ? remainderPerPool / sortCols.length : 0;
    const poolOk = avgPoolTotal >= fixedTakenPerPool + (sortCols.length ? 1 : 0); // pool covers fixed takes (+ >0 for sort)

    // super-pool cells available per modality (across all pools)
    const superOf = (c) => {
      if (c.source === 'stim') return CF.stim * S;
      if (c.source === 'bulk') return CF.bulk * S;
      return (c.isSort ? sortTakePerPool : CF.poolLoad) * nP;
    };
    // per-pool take shown on each modality box
    const perPoolOf = (c) => (c.isSort ? sortTakePerPool : CF.poolLoad);

    // ---- Layout --------------------------------------------------------------
    const pad = 26, colSlot = 214, colW = colSlot - 22;
    const contentW = n * colSlot;
    const W = Math.max(780, pad * 2 + contentW);
    const offset = pad + Math.max(0, (W - 2 * pad - contentW) / 2);
    const xOf = (i) => offset + i * colSlot;
    const cOf = (i) => xOf(i) + colW / 2;

    const y = { lblSamples: 34, samples: 50, lblSrc: 138, src: 154, lblPools: 258, pools: 274,
      lblHash: 372, hash: 408, lblChan: 524, chan: 538, lblLib: 608, lib: 622 };
    const hashH = 94;
    // library box height depends on the fullest column
    let maxLibLines = 1;
    ordered.forEach((c) => { maxLibLines = Math.max(maxLibLines, c.l.libraries.length); });
    const libH = 30 + maxLibLines * 15;
    const H = y.lib + libH + 34;

    const P = [];
    P.push('<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" class="flow-svg" role="img" aria-label="Cell flow and pooling diagram">');
    P.push('<defs><marker id="cfArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">' +
      '<path d="M0,0 L6,3 L0,6 Z" fill="#9aa7b8"/></marker></defs>');
    P.push('<style>' +
      '.flow-svg text{font-family:ui-sans-serif,system-ui,sans-serif;fill:#12203A}' +
      '.flbl{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;fill:#5A6a80}' +
      '.fbox{fill:#fff;stroke:#DCE1E8;stroke-width:1.2}' +
      '.ftitle{font-size:12.5px;font-weight:700}' +
      '.fdata{font-family:ui-monospace,Menlo,monospace;font-size:11px;fill:#1c2c46}' +
      '.fbig{font-family:ui-monospace,Menlo,monospace;font-size:15px;font-weight:700;fill:#0a8f89}' +
      '.fmuted{font-size:10px;fill:#66768c}' +
      '.farm{font-size:11.5px;font-weight:700;fill:#fff}' +
      '.fok{font-size:10px;font-weight:700;fill:#0a8f89}' +
      '.fwarn{font-size:10px;font-weight:700;fill:#b26a00}' +
      '</style>');
    const line = (x1, y1, x2, y2, arrow) => P.push('<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 +
      '" stroke="#9aa7b8" stroke-width="1.4"' + (arrow ? ' marker-end="url(#cfArrow)"' : '') + '/>');
    const badge = (x, yy, ok, txt) => P.push('<text class="' + (ok ? 'fok' : 'fwarn') + '" x="' + x + '" y="' + yy + '">' +
      (ok ? '\u2713 ' : '\u26a0 ') + esc(txt) + '</text>');

    // ---- Samples node --------------------------------------------------------
    P.push('<text class="flbl" x="' + offset + '" y="' + y.lblSamples + '">Samples</text>');
    P.push('<rect class="fbox" x="' + offset + '" y="' + y.samples + '" width="' + contentW + '" height="52" rx="9" fill="#12203A" stroke="#12203A"/>');
    P.push('<text class="ftitle" x="' + (offset + contentW / 2) + '" y="' + (y.samples + 22) + '" text-anchor="middle" fill="#fff">' +
      esc(S) + ' samples \u00d7 ' + fmtCells(CF.start) + ' cells/sample</text>');
    P.push('<text class="fdata" x="' + (offset + contentW / 2) + '" y="' + (y.samples + 40) + '" text-anchor="middle" fill="#cdd6e2">= ' +
      fmtCells(S * CF.start) + ' cells total \u00b7 thawed &amp; counted</text>');

    // ---- Source split (fixed per-sample takes) -------------------------------
    P.push('<text class="flbl" x="' + offset + '" y="' + y.lblSrc + '">Split each sample \u2014 fixed takes (banked: ' + fmtCells(bankedPer) + '/sample)</text>');
    const groupSpan = (arr) => { const first = ordered.indexOf(arr[0]); const last = ordered.indexOf(arr[arr.length - 1]);
      return { x: xOf(first), w: xOf(last) + colW - xOf(first) }; };

    const sources = [];
    if (hasPooled) sources.push({ arr: pooledCols, title: 'Genetic pooling', per: CF.pooling,
      total: S * CF.pooling, sub: 'fixed / sample', ok: sampleOk, okTxt: sampleOk ? 'used regardless of count' : 'over ' + fmtCells(CF.start) + '/sample' });
    if (hasStim) sources.push({ arr: stimCols, title: 'Stimulation', per: CF.stim,
      total: S * CF.stim, sub: 'saved / sample', ok: sampleOk, okTxt: 'extra reserve' });
    if (hasBulk) sources.push({ arr: bulkCols, title: 'Bulk RNA-seq', per: CF.bulk,
      total: S * CF.bulk, sub: '\u2265' + fmtCells(CF.bulkLow) + ' for low', ok: sampleOk, okTxt: 'Trizol reserve (SNP demux)' });

    sources.forEach((s) => {
      const g = groupSpan(s.arr);
      P.push('<rect class="fbox" x="' + g.x + '" y="' + y.src + '" width="' + g.w + '" height="70" rx="8" fill="#f6f9fc"/>');
      const cx = g.x + g.w / 2;
      P.push('<text class="ftitle" x="' + cx + '" y="' + (y.src + 19) + '" text-anchor="middle">' + esc(s.title) + '</text>');
      P.push('<text class="fbig" x="' + cx + '" y="' + (y.src + 40) + '" text-anchor="middle">' + fmtCells(s.per) + '/sample</text>');
      P.push('<text class="fmuted" x="' + cx + '" y="' + (y.src + 53) + '" text-anchor="middle">' + esc(s.sub) + ' \u00b7 ' + fmtCells(s.total) + ' total</text>');
      P.push('<text class="' + (s.ok ? 'fok' : 'fwarn') + '" x="' + cx + '" y="' + (y.src + 65) + '" text-anchor="middle">' +
        (s.ok ? '\u2713 ' : '\u26a0 ') + esc(s.okTxt) + '</text>');
      line(offset + contentW / 2, y.samples + 52, cx, y.src, true);
    });

    // ---- Genetic pools (pooling branch only) ---------------------------------
    if (hasPooled) {
      const g = groupSpan(pooledCols);
      P.push('<text class="flbl" x="' + g.x + '" y="' + y.lblPools + '">Genetic pools (\u2264' + esc(plan.cap || 20) + '/pool \u00b7 no related/same-patient' + ((CF.allcells || 0) > 0 ? ' \u00b7 +' + Math.round(CF.allcells * 100) + '% ALLCELLS' : '') + ')</text>');
      const gap = 10;
      const pw = Math.min(128, (g.w - (nP + 1) * gap) / nP);
      const poolCx = g.x + g.w / 2;
      line(poolCx, y.src + 70, poolCx, y.pools - 6, false);
      for (let i = 0; i < nP; i++) {
        const px = g.x + gap + i * (pw + gap);
        const col = poolColor(i, nP);
        const size = plan.pools && plan.pools[i] ? plan.pools[i].length : '?';
        const thisPoolCells = plan.pools && plan.pools[i] ? plan.pools[i].length * CF.pooling * allcellsMult : avgPoolTotal;
        P.push('<rect x="' + px + '" y="' + y.pools + '" width="' + pw + '" height="56" rx="7" fill="' + col + '" opacity="0.14" stroke="' + col + '" stroke-width="1.4"/>');
        P.push('<text class="ftitle" x="' + (px + pw / 2) + '" y="' + (y.pools + 21) + '" text-anchor="middle" fill="' + col + '">Pool ' + (i + 1) + '</text>');
        P.push('<text class="fdata" x="' + (px + pw / 2) + '" y="' + (y.pools + 37) + '" text-anchor="middle">' + esc(size) + ' samples</text>');
        P.push('<text class="fmuted" x="' + (px + pw / 2) + '" y="' + (y.pools + 50) + '" text-anchor="middle">\u2248' + fmtCells(thisPoolCells) + '</text>');
      }
      // note about the split step
      const splitNote = 'Each pool \u2192 ' + fmtCells(CF.poolLoad) + '/pool to each of ' + fixedCols.length + ' non-sort load' + (fixedCols.length === 1 ? '' : 's') +
        (sortCols.length ? '; sort takes the remainder (\u2248' + fmtCells(sortTakePerPool) + '/pool)' : '') + ' \u00b7 SNP + 1 hashtag/pool';
      P.push('<text class="' + (poolOk ? 'fok' : 'fwarn') + '" x="' + g.x + '" y="' + (y.pools + 72) + '">' + (poolOk ? '\u2713 ' : '\u26a0 ') + esc(splitNote) + '</text>');
    }

    // ---- Per-column: stain & pool -> channels -> libraries --------------------
    P.push('<text class="flbl" x="' + offset + '" y="' + y.lblHash + '">Stain (HTO \u2192 panel) &amp; pool \u2192 cells at load</text>');
    P.push('<text class="flbl" x="' + offset + '" y="' + y.lblChan + '">Load / transposition \u2192 channels</text>');
    P.push('<text class="flbl" x="' + offset + '" y="' + y.lblLib + '">Libraries</text>');

    const htoReagent = (chem) => (chem === 'cite5' ? 'HTO TotalSeq-C' : chem === 'asap' ? 'HTO TotalSeq-A' : chem === 'scrna5' ? 'HTO (hashing)' : 'hashing');
    const hasPanel = (chem) => chem === 'cite5' || chem === 'asap';

    ordered.forEach((c, i) => {
      const x = xOf(i), cx = cOf(i);
      const L = c.l;
      const channels = L.lanes || 0;
      const isBulk = c.source === 'bulk';
      const isATAC = L.chem === 'asap';

      // arm header strip on top of the stain box
      P.push('<rect x="' + x + '" y="' + (y.hash - 22) + '" width="' + colW + '" height="20" rx="5" fill="#5A44D6"/>');
      wrapSvg(P, L.label + (L.vdj ? ' + V(D)J' : ''), cx, y.hash - 8, colW - 8, 'farm', 'middle');

      if (isBulk) {
        // bulk bypasses pooling / hashing / GEM load
        const tallH = (y.chan + 50) - y.hash;
        P.push('<rect class="fbox" x="' + x + '" y="' + y.hash + '" width="' + colW + '" height="' + tallH + '" rx="8" fill="#faf7f0" stroke="#e7d9bd"/>');
        wrapSvg(P, 'Per-sample Trizol \u2014 no pool, stain, or GEM load', cx, y.hash + 30, colW - 16, 'fdata', 'middle');
        P.push('<text class="fmuted" x="' + cx + '" y="' + (y.hash + 50) + '" text-anchor="middle">' + fmtCells(CF.bulk) + '/sample \u00d7 ' + esc(S) + '</text>');
        P.push('<text class="fmuted" x="' + cx + '" y="' + (y.hash + tallH - 14) + '" text-anchor="middle">1 library / sample</text>');
        line(cx, y.hash + tallH, cx, y.lib, true);
      } else {
        const superCells = superOf(c);
        const perPool = perPoolOf(c);
        P.push('<rect class="fbox" x="' + x + '" y="' + y.hash + '" width="' + colW + '" height="' + hashH + '" rx="8" fill="#f2fbfa" stroke="#bfeae7"/>');

        if (c.source === 'stim') {
          P.push('<text class="fbig" x="' + cx + '" y="' + (y.hash + 24) + '" text-anchor="middle">' + fmtCells(superCells) + ' cells</text>');
          P.push('<text class="fmuted" x="' + cx + '" y="' + (y.hash + 42) + '" text-anchor="middle">' + fmtCells(CF.stim) + '/sample \u00d7 ' + esc(S) + '</text>');
          P.push('<text class="fmuted" x="' + cx + '" y="' + (y.hash + 58) + '" text-anchor="middle">stimulated aliquot</text>');
          badge(x + 10, y.hash + 82, true, '\u2192 ' + fmtCells(CF.atLoad) + ' at load');
        } else if (c.isSort) {
          P.push('<text class="fbig" x="' + cx + '" y="' + (y.hash + 24) + '" text-anchor="middle">' + fmtCells(superCells) + ' cells</text>');
          P.push('<text class="fmuted" x="' + cx + '" y="' + (y.hash + 42) + '" text-anchor="middle">\u2248' + fmtCells(perPool) + ' (rest)/pool \u00d7 ' + nP + '</text>');
          P.push('<text class="fmuted" x="' + cx + '" y="' + (y.hash + 58) + '" text-anchor="middle">FACS enrichment \u2192 sort</text>');
          badge(x + 10, y.hash + 82, poolOk, 'remainder of pool');
        } else {
          // unsort / ASAP / hashed droplet: HTO stain per pool -> combine -> panel subsample -> load
          P.push('<text class="fbig" x="' + cx + '" y="' + (y.hash + 22) + '" text-anchor="middle">' + fmtCells(superCells) + ' pooled</text>');
          P.push('<text class="fmuted" x="' + cx + '" y="' + (y.hash + 38) + '" text-anchor="middle">' + fmtCells(perPool) + '/pool \u00d7 ' + nP + ' \u00b7 ' + esc(htoReagent(L.chem)) + '</text>');
          if (hasPanel(L.chem)) {
            P.push('<text class="fmuted" x="' + cx + '" y="' + (y.hash + 54) + '" text-anchor="middle">\u2192 take ' + fmtCells(CF.panelStain) + ', panel stain</text>');
          } else {
            P.push('<text class="fmuted" x="' + cx + '" y="' + (y.hash + 54) + '" text-anchor="middle">\u2192 subsample for load</text>');
          }
          badge(x + 10, y.hash + 82, poolOk, '\u2192 ~' + fmtCells(CF.atLoad) + ' at load');
        }

        // channels
        P.push('<rect class="fbox" x="' + x + '" y="' + y.chan + '" width="' + colW + '" height="50" rx="8" fill="#fff" stroke="#5A44D6"/>');
        P.push('<text class="fbig" x="' + cx + '" y="' + (y.chan + 24) + '" text-anchor="middle">' + esc(channels) + ' channel' + (channels === 1 ? '' : 's') + '</text>');
        P.push('<text class="fmuted" x="' + cx + '" y="' + (y.chan + 40) + '" text-anchor="middle">' + (isATAC ? 'ATAC transposition' : 'GEM generation') + '</text>');

        line(cx, y.hash + hashH, cx, y.chan, true);
        line(cx, y.chan + 50, cx, y.lib, true);
      }

      // libraries
      P.push('<rect class="fbox" x="' + x + '" y="' + y.lib + '" width="' + colW + '" height="' + libH + '" rx="8"/>');
      const perLibCount = isBulk ? S : channels;
      L.libraries.forEach((lib, li) => {
        P.push('<text class="fdata" x="' + (x + 10) + '" y="' + (y.lib + 20 + li * 15) + '">' +
          esc(perLibCount) + ' \u00d7 ' + esc(LIB_LABEL[lib] || lib) + '</text>');
      });
      const totalLibs = perLibCount * L.libraries.length;
      P.push('<text class="fmuted" x="' + (x + 10) + '" y="' + (y.lib + libH - 8) + '">= ' + esc(totalLibs) + ' librar' + (totalLibs === 1 ? 'y' : 'ies') + '</text>');

      // connect source box -> this column's first box
      if (c.source === 'pool') {
        const g = groupSpan(pooledCols);
        line(g.x + g.w / 2, y.pools + 78, cx, y.hash - 22, true);
      } else if (c.source === 'stim') {
        const g = groupSpan(stimCols);
        line(g.x + g.w / 2, y.src + 70, cx, y.hash - 22, true);
      } else {
        const g = groupSpan(bulkCols);
        line(g.x + g.w / 2, y.src + 70, cx, y.hash - 22, true);
      }
    });

    P.push('</svg>');
    return P.join('');
  }

  // Center-anchored one-line SVG text with naive truncation to fit width.
  function wrapSvg(parts, text, cx, yy, maxW, cls, anchor) {
    const approx = Math.max(4, Math.floor(maxW / 6.0));
    let t = String(text);
    if (t.length > approx) t = t.slice(0, approx - 1) + '\u2026';
    parts.push('<text class="' + cls + '" x="' + cx + '" y="' + yy + '" text-anchor="' + (anchor || 'start') + '">' + esc(t) + '</text>');
  }

  // naive word-wrap into <text> tspans
  function wrapText(parts, text, x, y, maxW, cls, lh) {
    const words = String(text).split(' ');
    const approx = Math.max(1, Math.floor(maxW / 6.2));
    let line = '', lineN = 0;
    const flush = () => { if (line) { parts.push('<text class="' + cls + '" x="' + x + '" y="' + (y + lineN * lh) + '">' + esc(line.trim()) + '</text>'); lineN++; line = ''; } };
    words.forEach((w) => { if ((line + ' ' + w).length > approx) flush(); line += ' ' + w; });
    flush();
  }

  /**
   * Personnel plan (swimlane), modeled on flowchart Person 1/2/3 grid.
   * Assigns real names from Personnel_Roster where available, else Person N.
   */
  function renderPersonnelPlan(plan, data) {
    const roster = (data.personnel || []).filter((p) => p.active);
    const arms = plan.arms.filter((a) => ['unsort5', 'asap3', 'sort5', 'flex', 'stim'].includes(a));

    // Phases (rows) and which arm/task each person covers (columns).
    // Default 3-worker model from handbook: thaw(3) -> parallel staining -> GEM -> library.
    const nThaw = Math.max(1, Math.ceil(plan.nSamples / 18));
    const workerName = (i) => (roster[i] ? roster[i].name.replace(/^Example:\s*/, '') : 'Person ' + (i + 1));

    // Build task lists per phase
    const stainTasks = [];
    if (plan.arms.includes('unsort5')) stainTasks.push("Unsort 5' CITE-seq stain (HTO → TotalSeq-C panel)");
    if (plan.arms.includes('asap3')) stainTasks.push("3' ASAP-seq stain (HTO → TotalSeq-A panel) + nuclei/Tn5");
    if (plan.arms.includes('sort5')) stainTasks.push("Sort 5' stain (L/D → HTO → sort Ab panel) + FACS");
    if (plan.modalities.includes('In vitro stimulation')) stainTasks.push('Stim setup (reserve cells, stimulate)');
    if (plan.modalities.includes('Flex (fixed RNA profiling)')) stainTasks.push('Flex fixation + probe hybridization');
    const bulk = plan.modalities.includes('Bulk RNA') || plan.includeBulk;

    const gemTasks = [];
    if (plan.lanesByArm.unsort5) gemTasks.push("5' GEM generation: " + plan.lanesByArm.unsort5 + ' lanes (pool spread)');
    if (plan.lanesByArm.sort5) gemTasks.push("5' GEM generation: " + plan.lanesByArm.sort5 + ' lanes (1/population)');
    if (plan.lanesByArm.asap3) gemTasks.push("3' GEM generation: " + plan.lanesByArm.asap3 + ' lanes (pool spread)');

    const libTasks = [];
    if (plan.lanesByArm.unsort5) libTasks.push('Library prep: GEX' + (plan.arms.includes('unsort5') ? ' + ADT' : '') + (plan.modalities.includes('VDJ (TCR/BCR)') ? ' + TCR + BCR' : '') + ' / lane');
    if (plan.lanesByArm.sort5) libTasks.push('Library prep: GEX + ADT / sorted lane');
    if (plan.lanesByArm.asap3) libTasks.push('Library prep: ATAC + ADT / lane');
    if (bulk) libTasks.push('Bulk library prep: 1 library / sample (' + plan.nSamples + ')');

    const rows = [
      { phase: 'Day −30 to −1 · Prep', tasks: ['Batch & pool design, order reagents, book hoods/sorter/calendar, label tubes, make buffers'] },
      { phase: 'Day 0 · 7–10am · Thaw & pool', tasks: [nThaw + ' worker(s) thaw ~18 samples each in parallel → count → pool into ' + plan.nPools + ' genetic pools → split into arms'] },
      { phase: 'Day 0 · 10am–1pm · Stain', tasks: stainTasks.length ? stainTasks : ['(no staining arms selected)'] },
      { phase: 'Day 0 · 1–5pm · GEM load', tasks: gemTasks.length ? gemTasks : ['(no GEM lanes)'] },
      { phase: 'Days 1–5 · Libraries', tasks: libTasks.length ? libTasks : ['(no libraries)'] },
      { phase: 'After QC · Sequencing', tasks: ['Submit pooled libraries to YCGA (iLAB) — confirm grant with lab manager'] }
    ];

    let html = '<table class="pers-table"><thead><tr><th>Phase</th><th>Tasks &amp; assignments</th></tr></thead><tbody>';
    rows.forEach((r) => {
      html += '<tr><th scope="row">' + esc(r.phase) + '</th><td><ul>';
      r.tasks.forEach((t, i) => {
        // round-robin assign tasks to workers for staining/gem/lib phases
        let who = '';
        if (/Stain|GEM|Library|Bulk/.test(r.phase) && r.tasks.length > 1) who = '<span class="who">' + esc(workerName(i % Math.max(roster.length, 3))) + '</span> ';
        html += '<li>' + who + esc(t) + '</li>';
      });
      html += '</ul></td></tr>';
    });
    html += '</tbody></table>';

    if (!roster.length) {
      html += '<p class="ph-note">Using generic "Person 1/2/3" labels — fill in Personnel_Roster in the spreadsheet to assign real names automatically.</p>';
    }
    return html;
  }

  /* ==========================================================================
     Week grid  —  the Monday–Friday / Person-swimlane view from slide 4 of
     Pipeline_Flowcharts_AA.pdf. One column per person/track, one row per day.
     Which tracks appear is driven entirely by the selected modalities (plan.arms
     + plan.modalities), so ticking/unticking a modality adds or removes both a
     column and that track's row of tasks.
     ========================================================================== */

  const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

  // One 5-day task template per 10x assay arm. {lanes} is substituted with the
  // lane count for that arm from plan.lanesByArm.
  const TRACK_DEFS = {
    unsort5: {
      label: "5' CITE-seq (unsort)", short: 'Unsort 5\u2019', color: '#5A44D6',
      days: [
        'Thaw & pool (all) \u2192 stain: Fc block \u2192 TotalSeq-C HTO \u2192 TotalSeq-C lyo panel',
        'Batch day: load 10x \u2014 5\u2019 GEM, {lanes} lane(s) (pool spread across all)',
        'CITE-seq bead cleanup + cDNA amplification',
        'Unsort CITE-seq libraries: GEX + VDJ (TCR/BCR) + ADT',
        'QC libraries \u2192 pool for sequencing'
      ]
    },
    sort5: {
      label: 'Sort 5\u2019 (FACS-sorted populations)', short: 'Sort 5\u2019', color: '#7C5CFC',
      days: [
        'Thaw & pool (all) \u2192 stain: L/D \u2192 Fc block \u2192 HTO \u2192 fluor sort Ab panel',
        'Batch day: flow-sort rare populations \u2192 5\u2019 GEM load, {lanes} lane(s) (1 per population)',
        'Sort 5\u2019 bead cleanup + cDNA amplification',
        'Sort 5\u2019 libraries: GEX + VDJ (e.g. TCR, Treg lane)',
        'QC libraries \u2192 pool for sequencing'
      ]
    },
    asap3: {
      label: '3\u2019 ASAP-seq', short: 'ASAP-seq', color: '#F2994A',
      days: [
        'Thaw & pool (all) \u2192 stain: Fc block \u2192 TotalSeq-A HTO \u2192 TotalSeq-A lyo panel',
        'Batch day: fix/perm/transpose/barcode \u2192 ATAC GEM load, {lanes} lane(s)',
        'ASAP-seq cleanup',
        'ASAP + ASAP-CSP libraries',
        'QC libraries \u2192 pool for sequencing'
      ]
    },
    flex: {
      label: 'Flex (fixed RNA + protein)', short: 'Flex', color: '#6E4FF9',
      days: [
        'Thaw & pool (all) \u2192 formaldehyde fixation',
        'Flex probe hybridization',
        'Flex barcoding + pooling (up to 384-plex)',
        'Batch day: Flex GEM load, {lanes} lane(s)',
        'Flex bead cleanup + Flex libraries'
      ]
    }
  };

  function fillLanes(text, lanes) {
    return text.replace('{lanes}', lanes == null ? '?' : String(lanes));
  }

  /**
   * Build the list of tracks (rows/people) for this plan: one per active 10x
   * assay arm, plus a support track for Bulk RNA and/or in-vitro stim if those
   * modalities are selected (they ride along on Day 0 but don't need their own
   * GEM lane track).
   */
  function buildTracks(plan) {
    const tracks = [];
    plan.arms.forEach((arm) => {
      const def = TRACK_DEFS[arm];
      if (!def) return;
      tracks.push({
        key: arm, label: def.label, color: def.color,
        days: def.days.map((d) => fillLanes(d, plan.lanesByArm && plan.lanesByArm[arm]))
      });
    });

    const wantsBulk = plan.includeBulk || plan.modalities.includes('Bulk RNA');
    const wantsStim = plan.modalities.includes('In vitro stimulation');
    if (wantsBulk || wantsStim) {
      const days = ['', '', '', '', ''];
      const bits = [];
      if (wantsBulk) bits.push('Reserve cells (500k/sample) & TriZol RNA isolation');
      if (wantsStim) bits.push('Reserve cells (~200k/sample/stim) & set up stimulation conditions');
      days[0] = bits.join(' + ');
      if (wantsBulk) days[2] = 'Bulk library prep: 1 library / sample (' + plan.nSamples + ' total)';
      if (wantsStim) days[3] = 'Harvest stim timepoints \u2192 reserve for later scRNA-seq w/ HTOs';
      tracks.push({ key: 'support', label: 'Bulk RNA-seq / stim (support)', color: '#5A6A80', days });
    }
    return tracks;
  }

  /**
   * Assign a person to each track: prefer someone from Personnel_Roster whose
   * trained_stage_ids cover this track's protocol stage, otherwise round-robin
   * through the active roster, otherwise a generic "Person N" label.
   */
  const TRACK_STAGE_ID = { unsort5: 'ST3', asap3: 'ST4', sort5: 'ST5', flex: 'ST12', support: 'ST13' };
  function assignPeople(tracks, data) {
    const roster = ((data && data.personnel) || []).filter((p) => p.active);
    const used = new Set();
    let cursor = 0;
    return tracks.map((t) => {
      const stageId = TRACK_STAGE_ID[t.key];
      let person = roster.find((p) => !used.has(p.id) && stageId && p.trainedStages.includes(stageId));
      if (!person) {
        while (cursor < roster.length && used.has(roster[cursor].id)) cursor++;
        person = roster[cursor];
      }
      if (person) used.add(person.id);
      return person ? person.name.replace(/^Example:\s*/, '') : null;
    });
  }

  function slidePersonColor(i) {
    const colors = ['#CDEFF8', '#DDF2D6', '#F2C8EB', '#F7DED2', '#DDE6FA', '#FFF0C8'];
    return colors[i % colors.length];
  }

  function slidePersonStroke(i) {
    const colors = ['#1D5F78', '#4D7E3B', '#8B3F7F', '#95644D', '#405E94', '#927119'];
    return colors[i % colors.length];
  }

  function hasMod(plan, name) {
    return plan.modalities && plan.modalities.includes(name);
  }

  function armLanes(plan, arm) {
    return (plan.lanesByArm && plan.lanesByArm[arm]) || '?';
  }

  function pluralLane(n) {
    return String(n) === '1' || n === 1 ? 'lane' : 'lanes';
  }

  function slideShortName(name, fallback) {
    if (!name) return fallback;
    return String(name).replace(/^Example:\s*/, '');
  }

  function buildSlideBranches(plan) {
    const branches = [];
    const wantsCite = hasMod(plan, 'CITEseq');
    const wantsVDJ = hasMod(plan, 'VDJ (TCR/BCR)');
    const wantsSc = hasMod(plan, 'scRNAseq');
    const wantsBulk = plan.includeBulk || hasMod(plan, 'Bulk RNA');
    const wantsStim = hasMod(plan, 'In vitro stimulation');
    const wantsFlex = hasMod(plan, 'Flex (fixed RNA profiling)') || (plan.arms || []).includes('flex');
    const wantsSort = (plan.arms || []).includes('sort5');
    const wantsASAP = (plan.arms || []).includes('asap3');
    const wantsUnsort = (plan.arms || []).includes('unsort5');

    if (wantsUnsort) {
      const label = wantsCite ? "Unsort 5' CITEseq" : (wantsVDJ ? "Unsort 5' scRNA/VDJ" : "Unsort 5' scRNAseq");
      const libs = ['Unsort GEX library'];
      if (wantsVDJ) libs.push('Unsort VDJ-TCR library', 'Unsort VDJ-BCR library');
      if (wantsCite) libs.push('Unsort CSP library');
      branches.push({
        key: 'unsort5', stageId: 'ST3', label, tasks: [
          { day: 1, slot: 0, text: label + ' stain' + (wantsCite ? ' (HTO + TotalSeq-C panel)' : '') },
          { day: 1, slot: 2, text: "5' GEM chip load: " + armLanes(plan, 'unsort5') + ' ' + pluralLane(armLanes(plan, 'unsort5')) },
          { day: 2, slot: 0, wide: true, text: "Unsort 5' bead cleanup + cDNA amp\nOutput: GEX" + (wantsVDJ ? '/VDJ' : '') + ' cDNA' + (wantsCite ? ' + CSP cDNA' : '') },
          { day: 4, slot: 0, parallel: libs }
        ]
      });
    }

    if (wantsASAP) {
      branches.push({
        key: 'asap3', stageId: 'ST4', label: 'ASAP-seq', tasks: [
          { day: 1, slot: 0, text: 'ASAP-seq stain\n(HTO + TotalSeq-A panel)' },
          { day: 1, slot: 1, text: 'ASAP fix/perm/transpose/barcode' },
          { day: 1, slot: 2, text: 'ATAC GEM chip load: ' + armLanes(plan, 'asap3') + ' ' + pluralLane(armLanes(plan, 'asap3')) },
          { day: 2, slot: 0, wide: true, text: 'ASAP bead cleanup\nOutput: ATAC + CSP cDNA' },
          { day: 3, slot: 0, text: 'ASAP library' },
          { day: 3, slot: 1, text: 'ASAP CSP library' }
        ]
      });
    }

    if (wantsSort) {
      const libs = ['Sort GEX library'];
      if (wantsVDJ) libs.push('Sort VDJ-TCR library\n(Treg lane)');
      branches.push({
        key: 'sort5', stageId: 'ST5', label: "Sort 5'", tasks: [
          { day: 1, slot: 0, text: "Sort 5' stain\n(L/D + HTO + sort Ab panel)" },
          { day: 1, slot: 1, text: 'Flow sort: HSC, pDC, cDC, Treg' },
          { day: 1, slot: 2, text: "5' GEM chip load: " + armLanes(plan, 'sort5') + ' ' + pluralLane(armLanes(plan, 'sort5')) },
          { day: 2, slot: 0, wide: true, text: "Sort 5' bead cleanup + cDNA amp\nOutput: GEX cDNA" + (wantsVDJ ? ' + VDJ cDNA' : '') },
          { day: 4, slot: 0, parallel: libs }
        ]
      });
    }

    if (wantsBulk) {
      branches.push({
        key: 'bulk', stageId: 'ST14', label: 'Bulk RNAseq', tasks: [
          { day: 1, slot: 0, text: 'Bulk RNAseq\nTrizol isolation' },
          { day: 2, slot: 0, wide: true, text: 'Bulk library prep\nOutput: ' + plan.nSamples + ' libraries (1 per sample)' }
        ]
      });
    }

    if (wantsStim || wantsFlex) {
      const flexLanes = armLanes(plan, 'flex');
      const tasks = [];
      if (wantsStim) tasks.push({ day: 1, slot: 0, text: 'Stim: unstim + stims/timepoints' });
      tasks.push({ day: 1, slot: wantsStim ? 1 : 0, text: 'Formaldehyde fix' });
      tasks.push({ day: 2, slot: 0, wide: true, text: 'Flex probe hybridization' });
      tasks.push({ day: 3, slot: 0, text: 'Flex barcode + pooling' });
      tasks.push({ day: 3, slot: 1, text: 'Flex GEM chip load: ' + flexLanes + ' ' + pluralLane(flexLanes) });
      tasks.push({ day: 3, slot: 2, text: 'Flex bead cleanup' });
      tasks.push({ day: 4, slot: 0, text: 'Flex library' });
      branches.push({ key: 'flex', stageId: 'ST12', label: wantsStim ? 'Stim + Flex output' : 'Flex', tasks });
    }

    if (!branches.length && (wantsSc || (plan.modalities || []).length)) {
      branches.push({ key: 'fallback', stageId: 'ST6', label: 'Selected workflow', tasks: [
        { day: 1, slot: 0, text: 'Process selected modalities' },
        { day: 2, slot: 0, text: 'Cleanup / cDNA amp' },
        { day: 4, slot: 0, text: 'Library prep' }
      ]});
    }

    return branches;
  }

  function assignSlidePeople(branches, data) {
    const roster = ((data && data.personnel) || []).filter((p) => p.active);
    const has = (key) => branches.some((b) => b.key === key);
    const roleDefs = [];
    if (has('unsort5')) roleDefs.push({ key: 'unsort', stageId: 'ST3' });
    if (has('asap3') || has('sort5')) roleDefs.push({ key: 'assay', stageId: has('asap3') ? 'ST4' : 'ST5' });
    if (has('bulk')) roleDefs.push({ key: 'support', stageId: 'ST14' });
    if (has('flex')) roleDefs.push({ key: 'flex', stageId: 'ST12' });
    if (!roleDefs.length) roleDefs.push({ key: 'general', stageId: 'ST6' });

    const used = new Set();
    let cursor = 0;
    const people = roleDefs.map((role, i) => {
      let person = roster.find((p) => !used.has(p.id) && role.stageId && Array.isArray(p.trainedStages) && p.trainedStages.includes(role.stageId));
      if (!person) {
        while (cursor < roster.length && used.has(roster[cursor].id)) cursor++;
        person = roster[cursor];
      }
      if (person) used.add(person.id);
      return {
        label: 'Person ' + (i + 1),
        name: slideShortName(person && person.name, 'Person ' + (i + 1)),
        color: slidePersonColor(i),
        stroke: slidePersonStroke(i),
        roleKey: role.key
      };
    });

    const roleIndexForBranch = (b) => {
      let key = 'general';
      if (b.key === 'unsort5') key = 'unsort';
      else if (b.key === 'asap3' || b.key === 'sort5') key = 'assay';
      else if (b.key === 'bulk') key = 'support';
      else if (b.key === 'flex') key = 'flex';
      const idx = people.findIndex((p) => p.roleKey === key);
      return idx >= 0 ? idx : 0;
    };

    return { people, branchRole: branches.map(roleIndexForBranch) };
  }

  function daySubheads(plan) {
    const heads = [
      ['Experiment prep day'],
      ['Batch day'],
      [], [], []
    ];
    if ((plan.arms || []).includes('unsort5')) {
      heads[2].push('CITEseq cleanup'); heads[4].push('Unsort CITEseq libraries');
    }
    if ((plan.arms || []).includes('asap3')) {
      heads[2].push('ASAPseq cleanup'); heads[3].push('ASAP libraries');
    }
    if ((plan.arms || []).includes('sort5')) {
      heads[2].push("Sort 5' cleanup"); heads[4].push("Sort 5' libraries");
    }
    if (hasMod(plan, 'In vitro stimulation') || hasMod(plan, 'Flex (fixed RNA profiling)') || (plan.arms || []).includes('flex')) {
      heads[2].push('Flex prep pt. 1'); heads[3].push('Flex prep pt. 2'); heads[4].push('Flex libraries');
    }
    if (plan.includeBulk || hasMod(plan, 'Bulk RNA')) heads[2].push('Bulk library prep');
    return heads.map((h) => h.length ? h : ['']);
  }

  function taskSlotsForDay(day, dayW) {
    if (day === 1) return [168, 258, 343].map((x) => Math.min(x, dayW - 86));
    if (day === 3) return [18, 88, 154];
    if (day === 4) return [18, 74, 130, 186];
    return [18, 92, 166];
  }

  function taskBoxSize(task, day, dayW) {
    if (task.wide) return { w: dayW - 34, h: 58 };
    if (task.parallel) return { w: dayW - 34, h: 58 };
    if (day === 1) return { w: task.slot === 2 ? 74 : 82, h: 58 };
    if (day === 3) return { w: 62, h: 58 };
    if (day === 4) return { w: 54, h: 58 };
    return { w: 82, h: 58 };
  }

  function svgLines(parts, text, x, y, maxW, cls, lh, maxLines) {
    const clean = String(text == null ? '' : text).replace(/\n/g, ' ');
    const words = clean.split(/\s+/).filter(Boolean);
    const approx = Math.max(1, Math.floor(maxW / 5.4));
    const lines = [];
    let line = '';
    words.forEach((w) => {
      if ((line + ' ' + w).trim().length > approx && line) {
        lines.push(line.trim());
        line = w;
      } else {
        line = (line + ' ' + w).trim();
      }
    });
    if (line) lines.push(line.trim());
    const clipped = maxLines && lines.length > maxLines;
    const show = maxLines ? lines.slice(0, maxLines) : lines;
    if (clipped && show.length) show[show.length - 1] = show[show.length - 1].replace(/[\s.,;:]+$/, '') + '...';
    show.forEach((ln, i) => parts.push('<text class="' + cls + '" x="' + x + '" y="' + (y + i * lh) + '">' + esc(ln) + '</text>'));
    return show.length;
  }

  function drawTaskBox(parts, box, person) {
    const fill = person ? person.color : '#E9EEF5';
    const stroke = person ? person.stroke : '#12203A';
    parts.push('<rect x="' + box.x + '" y="' + box.y + '" width="' + box.w + '" height="' + box.h + '" rx="9" fill="' + fill + '" stroke="#0E1C2F" stroke-width="1.8"/>');
    parts.push('<rect x="' + (box.x + 2) + '" y="' + (box.y + 2) + '" width="4" height="' + (box.h - 4) + '" rx="2" fill="' + stroke + '" opacity="0.34"/>');
    svgLines(parts, box.text, box.x + 10, box.y + 18, box.w - 18, 'sftask', 12, Math.floor((box.h - 14) / 12));
  }

  function drawPrepText(parts, x, y, w, h) {
    const bullets = [
      '(further in advance) ensure stock of reagents, HTOs, Ab cocktails, consumables and 10x kits; arrange timing with personnel and sorting',
      'Prepare + label tubes: thawing tubes, pooling FACS tubes, Bulk RNAseq Trizol tubes',
      'Prepare reagents: fresh DNase I, staining buffer (PBS + 2% BSA)',
      'Stock BSCs/fume hood with pipette tips; prepare sheath fluid for flow/sorting'
    ];
    let yy = y;
    bullets.forEach((b) => {
      parts.push('<text class="sfprep" x="' + x + '" y="' + yy + '">\u2022</text>');
      const used = svgLines(parts, b, x + 14, yy, w - 16, 'sfprep', 13, 5);
      yy += Math.max(1, used) * 13 + 8;
    });
  }

  function line(parts, x1, y1, x2, y2, marker) {
    parts.push('<line class="sfline" x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '"' + (marker ? ' marker-end="url(#sfArrow)"' : '') + '/>');
  }

  function elbow(parts, x1, y1, x2, y2) {
    const mid = Math.min(x2 - 14, x1 + 28);
    if (Math.abs(y1 - y2) < 3) {
      line(parts, x1, y1, x2, y2, true);
    } else {
      parts.push('<path class="sfline" d="M ' + x1 + ' ' + y1 + ' L ' + mid + ' ' + y1 + ' L ' + mid + ' ' + y2 + ' L ' + x2 + ' ' + y2 + '" marker-end="url(#sfArrow)"/>');
    }
  }

  function boxMid(box) { return { x: box.x + box.w / 2, y: box.y + box.h / 2 }; }

  function drawParallelTerminal(parts, task, dayX, y, dayW, person) {
    const labels = task.parallel;
    const gap = 8;
    const n = labels.length;
    const w = Math.max(46, Math.min(64, (dayW - 36 - gap * (n - 1)) / n));
    const boxes = labels.map((txt, i) => ({ x: dayX + 18 + i * (w + gap), y, w, h: 58, text: txt }));
    boxes.forEach((b) => drawTaskBox(parts, b, person));
    return boxes;
  }

  /**
   * Renders the Monday-Friday workflow as a connected flowchart, closely modeled
   * on slide 4 of the source deck: day columns, a prep column, colored person
   * assignments, shared thaw/pooling, then adaptive modality branches.
   */
  function renderWeekFlow(plan, data) {
    const branches = buildSlideBranches(plan);
    if (!branches.length) {
      return '<p class="empty">Select at least one modality in Step 1 to generate a day-by-day flowchart.</p>';
    }
    const roleAssignments = assignSlidePeople(branches, data);
    const people = roleAssignments.people;
    const nThaw = Math.max(1, Math.ceil(plan.nSamples / 18));
    const dayNames = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
    const widths = [190, 430, 175, 205, 250];
    const pad = 28;
    const gap = 0;
    const gridX = pad;
    const gridY = 116;
    const headerH = 54;
    const rowGap = 86;
    const taskH = 58;
    const contentTop = gridY + headerH + 22;
    const firstBranchY = contentTop + 78;
    const gridH = headerH + 132 + branches.length * rowGap + 34;
    const gridW = widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1);
    const W = gridX + gridW + pad;
    const H = gridY + gridH + 42;

    const colX = (d) => gridX + widths.slice(0, d).reduce((a, b) => a + b, 0) + d * gap;
    const heads = daySubheads(plan);
    const parts = [];

    parts.push('<div class="flow-holder aa-flow-holder"><svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" class="aa-workflow-svg" role="img" aria-label="Adaptive day-by-day workflow flowchart">');
    parts.push('<defs><marker id="sfArrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#111"/></marker></defs>');
    parts.push('<style>' +
      '.aa-workflow-svg text{font-family:Arial,Helvetica,sans-serif;fill:#111}' +
      '.sftitle{font-size:48px;font-weight:300}' +
      '.sfday{font-size:16px;font-weight:700;fill:#C01824}' +
      '.sfsub{font-size:13px;font-style:italic;fill:#111}' +
      '.sftask{font-size:10.5px;font-weight:600;fill:#111}' +
      '.sfprep{font-size:12px;font-style:italic;fill:#111}' +
      '.sfline{stroke:#111;stroke-width:1.8;fill:none}' +
      '.sflegend{font-size:14px;fill:#111}' +
      '.sflegendname{font-size:14px;font-weight:600;fill:#111}' +
      '.sfsmall{font-size:11px;fill:#C01824;font-weight:700}' +
      '</style>');

    // Title + person legend
    parts.push('<text class="sftitle" x="' + (gridX + 54) + '" y="78">Workflow</text>');
    const legW = 96;
    const legH = 26;
    const legGap = 10;
    const legendX = Math.max(gridX + 520, W - pad - people.length * legW - (people.length - 1) * legGap);
    const legendY = 18;
    people.forEach((p, i) => {
      const x = legendX + i * (legW + legGap);
      parts.push('<rect x="' + x + '" y="' + legendY + '" width="' + legW + '" height="' + legH + '" fill="' + p.color + '"/>');
      parts.push('<rect x="' + x + '" y="' + (legendY + legH + 8) + '" width="' + legW + '" height="' + legH + '" fill="' + p.color + '" opacity="0.82"/>');
      parts.push('<text class="sflegend" x="' + (x + legW / 2) + '" y="' + (legendY + 18) + '" text-anchor="middle">' + esc(p.label) + '</text>');
      parts.push('<text class="sflegendname" x="' + (x + legW / 2) + '" y="' + (legendY + legH + 26) + '" text-anchor="middle">' + esc(p.name) + '</text>');
    });

    // Day columns and headers
    for (let d = 0; d < 5; d++) {
      const x = colX(d);
      parts.push('<rect x="' + x + '" y="' + gridY + '" width="' + widths[d] + '" height="' + gridH + '" fill="#fff" stroke="#111" stroke-width="2"/>');
      parts.push('<text class="sfday" x="' + (x + widths[d] / 2) + '" y="' + (gridY + 20) + '" text-anchor="middle">' + dayNames[d] + '</text>');
      const lines = heads[d];
      lines.forEach((h, j) => {
        const yy = gridY + 27 + j * 19;
        parts.push('<rect x="' + (x + 1) + '" y="' + yy + '" width="' + (widths[d] - 2) + '" height="18" fill="#E5E5E5"/>');
        if (h) parts.push('<text class="sfsub" x="' + (x + widths[d] / 2) + '" y="' + (yy + 13) + '" text-anchor="middle">' + esc(h) + '</text>');
      });
    }

    // Monday prep text
    drawPrepText(parts, colX(0) + 18, gridY + 92, widths[0] - 32, gridH - 112);

    // Shared Tuesday thaw/pool boxes.
    const tueX = colX(1);
    const branchCenterY = firstBranchY + ((branches.length - 1) * rowGap) / 2 + taskH / 2;
    const thawBox = { x: tueX + 16, y: branchCenterY - 64, w: 58, h: 58, text: 'Cell thawing' };
    const poolBox = { x: tueX + 86, y: branchCenterY - 64, w: 64, h: 58, text: 'Cell pooling' };
    drawTaskBox(parts, thawBox, people[0]);
    drawTaskBox(parts, poolBox, people[Math.min(1, people.length - 1)] || people[0]);
    line(parts, thawBox.x + thawBox.w, thawBox.y + thawBox.h / 2, poolBox.x, poolBox.y + poolBox.h / 2, true);
    parts.push('<text class="sfsmall" x="' + (thawBox.x - 8) + '" y="' + (thawBox.y + thawBox.h + 18) + '">~' + esc(plan.nSamples) + ' samples; ' + esc(plan.nPools) + ' pools; ' + esc(nThaw) + ' thaw station' + (nThaw === 1 ? '' : 's') + '</text>');

    // Branch task boxes and arrows.
    branches.forEach((b, i) => {
      const person = people[roleAssignments.branchRole[i]] || people[i] || people[0];
      const y = firstBranchY + i * rowGap;
      const boxes = [];
      const slots = {};
      b.tasks.forEach((task) => {
        const d = task.day;
        const xDay = colX(d);
        const slotXs = taskSlotsForDay(d, widths[d]);
        const sz = taskBoxSize(task, d, widths[d]);
        if (task.parallel) {
          const groupBoxes = drawParallelTerminal(parts, task, xDay, y, widths[d], person);
          boxes.push({ group: groupBoxes, first: groupBoxes[0] });
        } else {
          const slot = task.slot || 0;
          const x = xDay + (slotXs[slot] || slotXs[0]);
          const box = { x, y, w: sz.w, h: sz.h, text: task.text };
          drawTaskBox(parts, box, person);
          boxes.push(box);
          slots[d + ':' + slot] = box;
        }
      });

      // fan-out from shared pooling to first branch box
      const first = boxes[0].first || boxes[0];
      elbow(parts, poolBox.x + poolBox.w, poolBox.y + poolBox.h / 2, first.x, first.y + first.h / 2);

      // arrows across that branch, group terminals receive a single incoming line
      for (let j = 0; j < boxes.length - 1; j++) {
        const a = boxes[j].first || boxes[j];
        const next = boxes[j + 1].first || boxes[j + 1];
        elbow(parts, a.x + a.w, a.y + a.h / 2, next.x, next.y + next.h / 2);
      }
    });

    parts.push('</svg></div>');
    parts.push('<p class="ph-note">Flowchart generated from the selected modalities: ' + branches.map((b) => esc(b.label)).join(', ') + '. Add or remove modalities in Step 1 and rebuild the plan to update the day-by-day branches, library boxes, lane counts, and personnel legend.</p>');
    return parts.join('');
  }

  function stripTags(s) { return String(s).replace(/<[^>]+>/g, ''); }

  /* ==========================================================================
     EXPLORE-MODE VIEWS (driven by Pooling.exploreScenario)
     ========================================================================== */
  const fmtN = (n) => Math.round(n || 0).toLocaleString();

  function statRow(label, val, color) {
    return '<div class="ex-stat"><span>' + esc(label) + '</span><span class="ex-val"' +
      (color ? ' style="color:' + color + '"' : '') + '>' + val + '</span></div>';
  }

  // per-sample cell allocation stacked bar
  function renderPerSampleAllocation(sc) {
    const c = sc.cfg;
    const stim = c.stimPerCond * c.stimN;
    const total = c.poolContributionPerSample + c.bulkTarget + stim;
    const input = c.cellsPerSample;
    const denom = Math.max(total, input) || 1;
    const seg = (w, col) => '<span style="display:inline-block;height:14px;width:' + (w) + '%;background:' + col + '"></span>';
    const pctPool = c.poolContributionPerSample / denom * 100;
    const pctBulk = c.bulkTarget / denom * 100;
    const pctStim = stim / denom * 100;
    const pctLeft = Math.max(0, (input - total) / denom * 100);
    const pctDef = Math.max(0, (total - input) / denom * 100);
    return '<div class="ex-panel"><h4>Per-sample cell allocation</h4>' +
      '<div style="border-radius:6px;overflow:hidden;display:flex;margin:6px 0 10px">' +
      seg(pctPool, '#33257A') + seg(pctBulk, '#9A84FB') + seg(pctStim, '#5A44D6') +
      seg(pctLeft, '#cfd6cf') + seg(pctDef, '#ab3939') + '</div>' +
      '<div class="ex-legend">' +
      '<span><i style="background:#33257A"></i>Pool ' + fmtN(c.poolContributionPerSample) + '</span>' +
      '<span><i style="background:#9A84FB"></i>Bulk ' + fmtN(c.bulkTarget) + '</span>' +
      '<span><i style="background:#5A44D6"></i>Stim ' + c.stimN + '×' + fmtN(c.stimPerCond) + '</span>' +
      '<span><i style="background:#cfd6cf"></i>Leftover ' + fmtN(Math.max(0, input - total)) + '</span>' +
      (total > input ? '<span><i style="background:#ab3939"></i>Deficit ' + fmtN(total - input) + '</span>' : '') +
      '</div>' +
      statRow('Total needed / sample', fmtN(total) + ' (pool + bulk + stim)') +
      statRow('Input cells / sample', fmtN(input)) +
      statRow('Leftover / deficit', (input >= total ? '+' + fmtN(input - total) : '−' + fmtN(total - input)), input >= total ? '#2f7d53' : '#ab3939') +
      '</div>';
  }

  // pool-size comparison table (recomputes scenario at each samples/pool)
  function renderPoolComparison(sc, computeAt) {
    const options = [9, 12, 15, 18, 20];
    const rows = options.map((sp) => {
      const rr = computeAt(sp);
      const active = sp === sc.cfg.samplesPerPool ? ' class="ex-active"' : '';
      return '<tr' + active + '><td>' + sp + '</td><td>' + rr.nPools + '</td>' +
        '<td>' + rr.nLanesUnsort + '</td><td>' + rr.nChipsUnsort + '</td>' +
        '<td>' + rr.nLanesAsap + '</td><td>' + rr.nChipsAsap + '</td>' +
        '<td>' + rr.totalSortLanes + '</td><td>' + rr.nChipsSort + '</td>' +
        '<td>' + fmtN(rr.totalLibraries) + '</td></tr>';
    }).join('');
    return '<div class="ex-panel"><h4>Pool-size comparison</h4><table class="ex-table"><thead><tr>' +
      '<th>Samples/pool</th><th>Pools</th><th>Unsort lanes</th><th>chips</th>' +
      '<th>ASAP lanes</th><th>chips</th><th>Sort lanes</th><th>chips</th><th>Total libs</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p class="ph-note">Unsort/ASAP lanes are driven by total samples × per-sample target, not by how samples group into pools — they stay flat across rows unless you hit the staining-material ceiling. Samples/pool changes pool count and the material ceiling.</p></div>';
  }

  function armCard(kind, title, kit, sc) {
    let rows = '', flag = '';
    if (kind === 'unsort') {
      rows = statRow('Lanes / chips', sc.nLanesUnsort + ' / ' + sc.nChipsUnsort) +
        statRow('Recovered (batch)', fmtN(sc.recovUnsortQc)) +
        statRow('Recovered / sample', fmtN(sc.recovUnsortQcPerSample)) +
        statRow('Libraries (GEX, CSP, VDJ-TCR, VDJ-BCR)', sc.libsUnsort);
      if (sc.unsortMaterialShortfall) flag = 'Stained material can’t hit this target — raise pool take / staining target or lower target.';
    } else if (kind === 'asap') {
      rows = statRow('Lanes / chips', sc.nLanesAsap + ' / ' + sc.nChipsAsap) +
        statRow('Nuclei loaded / lane', fmtN(sc.nucleiLoadedPerLane)) +
        statRow('Recovered (batch)', fmtN(sc.recovAsapQc)) +
        statRow('Recovered / sample', fmtN(sc.recovAsapQcPerSample)) +
        statRow('Libraries (ATAC + ADT/HTO)', sc.libsAsap);
      if (sc.asapMaterialShortfall) flag = 'Stained material can’t hit this target — raise pool take / staining target or lower target.';
    } else {
      rows = statRow('Lanes / chips', sc.totalSortLanes + ' / ' + sc.nChipsSort) +
        statRow('Libraries (dynamic per lane)', sc.libsSort) +
        statRow('Populations', (sc.sortPopTable || []).map((p) => p.display).join(', ') || '—');
      if (sc.sortNegativeFlag) flag = 'Not enough cells left per pool for the sort arm after unsort + ASAP takes.';
    }
    return '<div class="ex-arm ex-arm-' + kind + '"><div class="ex-arm-head">' + esc(title) +
      '<span class="ex-kit">' + esc(kit) + '</span></div><div class="ex-arm-body">' + rows +
      (flag ? '<div class="ex-flag">FLAG: ' + esc(flag) + '</div>' : '') + '</div></div>';
  }

  // sort per-population fill detail
  function renderSortFill(sc) {
    if (!sc.sortPopTable || !sc.sortPopTable.length) return '';
    const rows = sc.sortPopTable.map((p) =>
      '<tr><td>' + esc(p.display) + '</td><td>' + (p.frequencyEmpirical) + '</td>' +
      '<td>' + fmtN(p.sortedCells) + '</td><td>' + fmtN(p.cellsLoaded) + '</td>' +
      '<td>' + fmtN(p.cellsRecoveredQcEst) + '</td><td>' + fmtN(p.recoveredPerSample) + '</td>' +
      '<td>' + (p.vdjLibrary === 'none' ? '—' : p.vdjLibrary) + '</td></tr>').join('');
    const lanes = sc.sortGroupRows.map((g) => '<li>' + esc(g.name) + ' <span class="muted">(' + g.libraries + ' libs)</span></li>').join('');
    return '<div class="ex-panel"><h4>Sort arm · per-population fill</h4><table class="ex-table"><thead><tr>' +
      '<th>Population</th><th>Empirical freq</th><th>Est. sorted</th><th>Loaded</th><th>Recovered (QC)</th><th>/sample</th><th>V(D)J</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="ex-lanes"><strong>Dynamic lane assignment:</strong><ul>' + lanes + '</ul></div>' +
      '<p class="ph-note">Frequencies are EMPIRICAL (calibrated from a prior sort run) where available, else expected PBMC fraction. Populations with enough cells get a dedicated lane (capped at load); smaller ones are bin-packed into shared lanes.</p></div>';
  }

  // library-by-type pooling — REPLACES the old "pooling %" column
  function renderLibraryPooling(sc) {
    const rows = (sc.libraryPooling || []).map((r) =>
      '<tr><td>' + esc(r.type) + '</td><td>' + r.nLibraries + '</td><td>' + r.pooledSubmissions + '</td>' +
      '<td>' + fmtN(r.totalReads / 1e6) + ' M</td></tr>').join('');
    return '<div class="ex-panel"><h4>Library pooling &amp; sequencing submission</h4><table class="ex-table"><thead><tr>' +
      '<th>Library type</th><th># libraries</th><th>Pooled submissions</th><th>Summed read demand</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p class="ph-note">Lab convention: pool <strong>within</strong> a library type and submit <strong>one pooled lane per type</strong> (1× GEX, 1× VDJ-TCR, 1× VDJ-BCR, 1× CSP/ADT, 1× ATAC) — not everything into a single mixed pool. Normalize each library to equal molarity, then combine equal-molar volumes proportional to each library’s read demand. The exact route (YCGA vs Biohub) may differ — treat the read-demand column as guidance for balancing within each type’s pool.</p></div>';
  }

  // Full explore view. computeAt(spp) -> scenario recomputed at that samples/pool.
  function renderExplore(sc, computeAt) {
    const c = sc.cfg;
    const thaw = sc.thawCapacityFlag
      ? '<div class="ex-flag">FLAG: ' + c.nSamples + ' samples exceeds thaw capacity of ' + fmtN(sc.maxThawCapacity) + ' (' + c.nPeople + ' × ' + c.maxSamplesPerPerson + '). Add a person or split across days.</div>'
      : '<div class="ex-ok">Within thaw capacity of ' + fmtN(sc.maxThawCapacity) + '.</div>';
    const header = '<div class="ex-panel"><h4>Batch overview</h4>' +
      statRow('Samples', c.nSamples) + statRow('Samples / pool (target)', c.samplesPerPool) +
      statRow('Genetic pools', sc.nPools + ' (' + sc.poolSizes.join(', ') + ')') +
      statRow('HTOs needed / modality', sc.htosNeededPerModality) +
      statRow('Total libraries', sc.totalLibraries) + thaw + '</div>';
    const arms = '<div class="ex-arms">' +
      (c.arms.unsort ? armCard('unsort', "Unsorted 5' CITE-seq", "GEM-X 5' v3 + Feature Barcode", sc) : '') +
      (c.arms.asap ? armCard('asap', 'ASAP-seq', '10x Next GEM ATAC v2, Chip H', sc) : '') +
      (c.arms.sort ? armCard('sort', "Sorted 5' scRNA-seq", "GEM-X 5' v3 · dynamic lanes", sc) : '') +
      '</div>';
    return '<div class="explore-view">' + header +
      renderPerSampleAllocation(sc) +
      '<div class="section-sub">Modality arms (at selected pool size)</div>' + arms +
      (c.arms.sort ? renderSortFill(sc) : '') +
      renderLibraryPooling(sc) +
      '</div>';
  }

  // Alternative biological-pooling options (detail mode)
  function renderPoolingOptions(options) {
    if (!options || !options.length) return '';
    const rows = options.map((o) => {
      const cls = o.isDefault ? ' class="ex-active"' : '';
      const badge = o.isDefault ? ' <span class="ex-badge">default</span>' : '';
      return '<tr' + cls + '><td>' + o.samplesPerPool + badge + '</td>' +
        '<td>' + (o.feasible ? o.nPools : '—') + '</td>' +
        '<td>' + (o.feasible ? (Math.round(o.spreadScore * 100) + '%') : 'infeasible') + '</td>' +
        '<td>' + (o.feasible ? '<button type="button" class="btn ghost btn-xs" data-choose-spp="' + o.samplesPerPool + '">use</button>' : '') + '</td></tr>';
    }).join('');
    return '<div class="ex-panel"><h4>Alternative pooling options</h4><table class="ex-table"><thead><tr>' +
      '<th>Max samples/pool</th><th>Genetic pools</th><th>Confounder spread <button type="button" class="info-i" data-explain="confounderSpread">i</button></th><th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p class="ph-note">All options respect the hard biological rule (no two same-patient or related samples share a pool) and spread your flagged confounders across pools. The <strong>default</strong> minimizes the number of pools while keeping the best confounder spread. Pick a different row to trade fewer pools for tighter spread or vice-versa.</p></div>';
  }

  // Pipeline flowchart (matches the uploaded cell-flow diagram): thaw -> per-sample
  // split -> pool formation -> modality split -> per-arm superpool -> GEM loading
  // -> recovered. Built from a computed exploreScenario.
  function renderPipelineFlow(sc) {
    if (!sc) return '';
    const c = sc.cfg;
    const box = (title, lines, cls) =>
      '<div class="pf-box ' + (cls || '') + '"><div class="pf-hd">' + esc(title) + '</div><div class="pf-body">' +
      lines.map((l) => '<div class="pf-line">' + l + '</div>').join('') + '</div></div>';
    const kv = (k, v, colour) => '<span class="pf-k"' + (colour ? ' style="color:' + colour + '"' : '') + '>' + esc(k) + '</span> ' + v;
    const stim = c.stimPerCond * c.stimN;
    const poolN = sc.poolSizes && sc.poolSizes.length ? sc.poolSizes[0] : Math.round((c.nSamples || 0) / (sc.nPools || 1));
    const sortRem = (sc.sortPerPool && sc.sortPerPool.length) ? sc.sortPerPool[0] : 0;

    // ---- feasibility: can the pipeline actually run with these cell numbers? ----
    const problems = [], fixes = [];
    if (sc.perSampleOk === false)
      problems.push('Per-sample allocation is over budget \u2014 each sample needs ' + fmtN(sc.perSampleNeed) +
        ' cells (pool + bulk + stim) but only ' + fmtN(c.cellsPerSample) + ' are available at thaw.');
    if (sc.poolSupplyShortfall)
      problems.push('Each pool holds ~' + fmtN(sc.minPoolTotal) + ' cells, but the per-pool takes (' +
        [c.arms.unsort ? 'unsort ' + fmtN(c.unsortAmt) : '', c.arms.asap ? 'ASAP ' + fmtN(c.asapAmt) : ''].filter(Boolean).join(' + ') +
        ') need ' + fmtN(sc.perPoolTake) + ' \u2014 short by ' + fmtN(sc.worstPoolDeficit) + ' per pool' +
        (c.arms.sort ? ', leaving nothing for the sort remainder' : '') + '.');
    if (sc.unsortMaterialShortfall)
      problems.push('Unsort: only ' + fmtN(sc.unsortAvail) + ' stained cells available, but ' + fmtN(sc.cellsNeededUnsort) + ' are needed to load every lane.');
    if (sc.asapMaterialShortfall)
      problems.push('ASAP: only ' + fmtN(sc.asapAvail) + ' stained cells available, but ' + fmtN(sc.cellsNeededAsap) + ' are needed to load every lane.');
    if (problems.length) {
      if (sc.poolSupplyShortfall || sc.perSampleOk === false) {
        fixes.push('Raise cells/sample at thaw (Step 02) or the pool contribution / sample (Step 04).');
        fixes.push('Lower the per-pool take for unsort / ASAP (Step 03 assumptions).');
        fixes.push('Drop a modality arm (Step 01) so each pool is split fewer ways.');
        fixes.push('Put more samples per pool so each pool starts with more cells (Step 06 options).');
      }
      if (sc.unsortMaterialShortfall || sc.asapMaterialShortfall) {
        fixes.push('Increase the cells-to-stain target (Step 05) for the short arm.');
        fixes.push('Lower reads / lanes for that arm (Step 07), or raise its per-pool take.');
      }
    }
    const banner = problems.length
      ? '<div class="callout warn pf-banner"><strong>\u26a0 This plan can\u2019t run as configured</strong><ul>' +
        problems.map((p) => '<li>' + p + '</li>').join('') + '</ul><strong>How to fix \u2014 try one of:</strong><ul>' +
        fixes.map((f) => '<li>' + f + '</li>').join('') + '</ul></div>'
      : '';

    const top =
      box('THAW & COUNT (per sample)', [fmtN(c.cellsPerSample) + ' cells/sample']) +
      '<div class="pf-arrow"></div>' +
      box('PER-SAMPLE SPLIT (thaw \u2192 allocation)', [
        kv('Pool:', fmtN(c.poolContributionPerSample), '#33257A'),
        kv('Bulk RNA-seq:', fmtN(c.bulkTarget), '#9A84FB'),
        kv('Stim (' + c.stimN + ' \u00d7 ' + fmtN(c.stimPerCond) + '):', fmtN(stim), '#5A44D6'),
        kv('Leftover:', fmtN(sc.leftoverPerSample), '#7a7a7a')
      ]) +
      '<div class="pf-arrow"></div>' +
      box('POOL FORMATION (per pool, +ALLCELLS)', [
        poolN + ' samples \u00d7 ' + fmtN(c.poolContributionPerSample) + ' = ' + fmtN(poolN * c.poolContributionPerSample),
        '+ ALLCELLS ' + fmtN(sc.allcellsAddedPerPool),
        '<strong>= ' + fmtN(poolN * c.poolContributionPerSample + sc.allcellsAddedPerPool) + ' per pool</strong>'
      ]) +
      '<div class="pf-arrow"></div>' +
      box('MODALITY SPLIT (per pool)', [
        (c.arms.unsort ? kv('Unsort:', fmtN(c.unsortAmt), '#33257A') + '&nbsp;&nbsp; ' : '') +
        (c.arms.asap ? kv('ASAP:', fmtN(c.asapAmt), '#5A44D6') : ''),
        c.arms.sort ? kv('Sort (remainder):', (sortRem < 0 ? '<span class="pf-flag">' + fmtN(sortRem) + '</span>' : fmtN(sortRem)), '#9A84FB') : '',
        (sc.poolSupplyShortfall ? '<span class="pf-flag">\u26a0 pool too small \u2014 short ' + fmtN(sc.worstPoolDeficit) + '/pool</span>' : '')
      ].filter(Boolean), sc.poolSupplyShortfall ? 'pf-box-error' : '');

    const cols = [];
    if (c.arms.unsort) {
      cols.push('<div class="pf-col">' +
        box('UNSORT SUPERPOOL', [
          sc.nPools + ' pools \u00d7 ' + fmtN(c.unsortAmt),
          '= ' + fmtN(sc.unsortSuperpoolRaw) + ' raw',
          fmtN(sc.unsortStained) + ' lyo stained',
          '\u00d7 ' + c.stainEff.unsort + ' efficiency',
          '<strong>= ' + fmtN(sc.unsortAvail) + ' avail.</strong>',
          (sc.poolSupplyShortfall
            ? '<span class="pf-flag">\u26a0 pool can\u2019t supply this take</span>'
            : sc.unsortMaterialShortfall
              ? '<span class="pf-flag">\u26a0 need ' + fmtN(sc.cellsNeededUnsort) + ' to load</span>'
              : '<span class="pf-ok">\u2713 covers ' + fmtN(sc.cellsNeededUnsort) + ' to load</span>')
        ], 'pf-teal') + '<div class="pf-arrow"></div>' +
        box('GEM LOADING (per lane)', [
          fmtN(c.cellsLoadedPerLane) + '/lane loaded',
          fmtN(c.qcRecoveryPerLane) + '/lane recovered',
          '\u00d7 ' + sc.nLanesUnsort + ' lanes (' + sc.nChipsUnsort + ' chips)',
          '= ' + fmtN(sc.recovUnsortQc) + ' total'
        ], 'pf-teal') + '<div class="pf-arrow"></div>' +
        box('RECOVERED', [fmtN(sc.recovUnsortQc) + ' cells total', '<strong>' + fmtN(sc.recovUnsortQcPerSample) + ' / sample</strong>'], 'pf-teal-solid') +
        '</div>');
    }
    if (c.arms.asap) {
      cols.push('<div class="pf-col">' +
        box('ASAP SUPERPOOL', [
          sc.nPools + ' pools \u00d7 ' + fmtN(c.asapAmt),
          '= ' + fmtN(sc.asapSuperpoolRaw) + ' raw',
          fmtN(sc.asapStained) + ' lyo stained',
          '\u00d7 ' + c.stainEff.asap + ' efficiency',
          '<strong>= ' + fmtN(sc.asapAvail) + ' avail.</strong>',
          (sc.poolSupplyShortfall
            ? '<span class="pf-flag">\u26a0 pool can\u2019t supply this take</span>'
            : sc.asapMaterialShortfall
              ? '<span class="pf-flag">\u26a0 need ' + fmtN(sc.cellsNeededAsap) + ' to load</span>'
              : '<span class="pf-ok">\u2713 covers ' + fmtN(sc.cellsNeededAsap) + ' to load</span>')
        ], 'pf-purple') + '<div class="pf-arrow"></div>' +
        box('GEM LOADING (per lane)', [
          fmtN(sc.nucleiLoadedPerLane) + '/lane loaded',
          fmtN(c.asapPostQcPerLane) + '/lane recovered',
          '\u00d7 ' + sc.nLanesAsap + ' lanes (' + sc.nChipsAsap + ' chips)',
          '= ' + fmtN(sc.recovAsapQc) + ' total'
        ], 'pf-purple') + '<div class="pf-arrow"></div>' +
        box('RECOVERED', [fmtN(sc.recovAsapQc) + ' nuclei total', '<strong>' + fmtN(sc.recovAsapQcPerSample) + ' / sample</strong>'], 'pf-purple-solid') +
        '</div>');
    }
    if (c.arms.sort) {
      const sortRecovered = (sc.sortPopTable || []).reduce((s, p) => s + p.cellsRecoveredQcEst, 0);
      const laneLines = (sc.sortGroupRows || []).slice(0, 4).map((g, i) => 'L' + (i + 1) + ': ' + esc(g.members.map((m) => m.name).join(' + ')));
      const extra = Math.max(0, sc.totalSortLanes - laneLines.length);
      if (extra) laneLines.push('+' + extra + ' more');
      laneLines.push(sc.totalSortLanes + ' lanes (' + sc.nChipsSort + ' chip' + (sc.nChipsSort === 1 ? '' : 's') + ')');
      cols.push('<div class="pf-col">' +
        box('SORT SUPERPOOL', [
          sc.nPools + ' pools (remainder)',
          '= ' + fmtN(sc.sortSuperpoolRaw) + ' raw',
          '\u00d7 ' + c.stainEff.sort + ' efficiency',
          '<strong>= ' + fmtN(sc.sortAvail) + ' avail.</strong>'
        ], 'pf-orange') + '<div class="pf-arrow"></div>' +
        box('SORT LANES (1 / population)', laneLines, 'pf-orange') + '<div class="pf-arrow"></div>' +
        box('RECOVERED', [fmtN(sortRecovered) + ' cells total', '<strong>' + fmtN(c.nSamples ? sortRecovered / c.nSamples : 0) + ' / sample</strong>'], 'pf-orange-solid') +
        '</div>');
    }

    return '<div class="pf' + (problems.length ? ' pf-infeasible' : '') + '">' + banner + '<div class="pf-top">' + top + '</div><div class="pf-cols">' + cols.join('') + '</div></div>';
  }

  const api = { renderSampleFlow, renderPersonnelPlan, renderWeekFlow, poolColor,
    renderExplore, renderPoolComparison, renderPerSampleAllocation, renderSortFill,
    renderLibraryPooling, renderPoolingOptions, renderPipelineFlow };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Workflow = api;
})(typeof window !== 'undefined' ? window : globalThis);

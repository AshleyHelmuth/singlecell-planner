/* scheduling.js — Scheduling tab: experiment-day calendar + equipment booking.
   Static-site constraints: we can DISPLAY Google calendars (multiple overlaid in
   one embed) but cannot WRITE events without the Calendar API + OAuth. So booking
   here produces one-click "add to <equipment> calendar" links (targeting the
   correct calendar via the &src= param) plus a downloadable .ics. */
(function (root) {
  'use strict';

  var TZ = 'America/New_York';

  // Equipment -> its Google group calendar id, display colour, and default
  // booking window (editable per experiment). Date defaults to the experiment day.
  var EQUIPMENT = [
    { name: 'BSC1', cal: 'fe7836fa02ee2dbf37165fb6342df868b6878766c4212182925d5296cdddec52@group.calendar.google.com', color: '#1f7a7a', start: '07:00', end: '13:00' },
    { name: 'BSC2', cal: 'fa259394976287b42162f6bae0794beb7fd80178cdd1f075f2383f76f3eb9525@group.calendar.google.com', color: '#2f7d53', start: '07:00', end: '13:00' },
    { name: 'Chemical Hood', cal: '1761540d25c59e44726fa9780cd8d35d889f4505525802b9133708d636655c13@group.calendar.google.com', color: '#8a6d1f', start: '07:00', end: '17:00' },
    { name: 'Centrifuge', cal: 'e6a9fe5cdee1eee46fe8f31ef6fd3495da881305b390862b5cdf017c17357a5d@group.calendar.google.com', color: '#b0611f', start: '07:00', end: '17:00' },
    { name: 'Sony Sorter', cal: '1ad41eb20eb6b5f546119f6eb8da207d1274599276bcc224e8141325afc4346b@group.calendar.google.com', color: '#6b4fa3', start: '09:00', end: '16:00' },
    { name: 'Chromium X', cal: 'f6113753a09a8128a9612bdda61e105c93221f89fffa2ce38c8f74631b950ed0@group.calendar.google.com', color: '#2f5c8f', start: '10:00', end: '17:00' },
    { name: 'Tapestation', cal: '1d8a15eb34be699ed8d28d9b3304dbcbc835e1fad452fb156b958cb21751f935@group.calendar.google.com', color: '#ab3939', start: '13:00', end: '17:00' },
    { name: 'Thermocycler', cal: 'ac9d4e86a5b292de20497a7961f70875cc0ed4f206f65543a45f164e852c019c@group.calendar.google.com', color: '#5b6570', start: '10:00', end: '19:00' }
  ];

  var DAY_KEY = 'scp:dayBookings:v1'; // manual experiment-day bookings [{date,name}]
  var EQUIP_KEY = 'scp:equipBookings:v1'; // [{date,equip,start,end,title}]
  var viewYear, viewMonth;           // month currently shown
  var selectedDay = null;            // YYYY-MM-DD chosen for equipment booking

  function ls() { try { return root.localStorage; } catch (e) { return null; } }
  function readDays() { try { return JSON.parse(ls().getItem(DAY_KEY)) || []; } catch (e) { return []; } }
  function writeDays(a) { try { ls().setItem(DAY_KEY, JSON.stringify(a)); } catch (e) {} }
  function readEquip() { try { return JSON.parse(ls().getItem(EQUIP_KEY)) || []; } catch (e) { return []; } }
  function writeEquip(a) { try { ls().setItem(EQUIP_KEY, JSON.stringify(a)); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function iso(y, m, d) { return y + '-' + pad(m + 1) + '-' + pad(d); }

  // Equipment booked here (recorded locally), keyed by date -> [equip names].
  function bookedByDate() {
    var m = {};
    readEquip().forEach(function (b) { (m[b.date] = m[b.date] || []).push(b.equip); });
    return m;
  }

  // Every scheduled experiment: saved experiments with a date + manual day
  // bookings + the experiment currently being designed. Keyed/sorted by date.
  function scheduledRows() {
    var byDate = {};
    if (root.Store && root.Store.allExperiments) {
      root.Store.allExperiments().forEach(function (e) {
        if (!e.date) return;
        byDate[e.date] = { name: e.name || '(experiment)', project: e.project || '', plannedBy: e.plannedBy || '',
          nSamples: (e.snapshot ? e.snapshot.nSamples : null), id: e.id, source: 'experiment' };
      });
    }
    readDays().forEach(function (b) { if (!byDate[b.date]) byDate[b.date] = { name: b.name, project: '', plannedBy: '', nSamples: null, source: 'manual' }; });
    var cd = (root.currentDesignInfo && root.currentDesignInfo()) || null;
    if (cd && (cd.name || cd.date)) {
      var here = cd.date && byDate[cd.date] && (byDate[cd.date].id === cd.id || byDate[cd.date].name === cd.name);
      if (here) { byDate[cd.date].current = true; }
      else {
        var key = cd.date || '__design__';
        byDate[key] = { name: cd.name || '(current design)', project: cd.project || '', plannedBy: cd.plannedBy || '',
          nSamples: cd.nSamples, source: 'design', current: true, noDate: !cd.date };
      }
    }
    return Object.keys(byDate).map(function (k) { var r = byDate[k]; r.date = r.noDate ? '' : k; return r; })
      .sort(function (a, b) { return (a.date || '9999') < (b.date || '9999') ? -1 : ((a.date || '9999') > (b.date || '9999') ? 1 : 0); });
  }

  function renderScheduledList() {
    var host = document.getElementById('scheduledList');
    if (!host) return;
    var rows = scheduledRows();
    var booked = bookedByDate();
    var total = EQUIPMENT.length;
    if (!rows.length) { host.innerHTML = '<p class="empty">No experiments scheduled yet. Set an experiment date on the Plan \u2192 Save step, or book a day below.</p>'; return; }
    var body = rows.map(function (r) {
      var bk = r.date ? (booked[r.date] || []) : [];
      var bkCell = !r.date ? '<span class="rsv rsv-none">no date set</span>'
        : (bk.length ? '<span class="rsv rsv-ok">' + bk.length + ' / ' + total + ' booked</span> <span class="muted small">' + esc(bk.join(', ')) + '</span>'
          : '<span class="rsv rsv-short">not booked</span>');
      return '<tr' + (r.current ? ' class="sched-current"' : '') + '>' +
        '<td><strong>' + esc(r.name) + '</strong>' + (r.current ? ' <span class="rsv rsv-note">currently designing</span>' : '') + '</td>' +
        '<td class="num">' + (r.nSamples != null ? r.nSamples : '\u2014') + '</td>' +
        '<td>' + esc(r.project || '\u2014') + '</td>' +
        '<td>' + esc(r.date || '\u2014') + '</td>' +
        '<td>' + esc(r.plannedBy || '\u2014') + '</td>' +
        '<td>' + bkCell + '</td></tr>';
    }).join('');
    host.innerHTML = '<table class="cost-table exp-table"><thead><tr><th>Experiment</th><th class="num">Samples</th><th>Project</th><th>Date</th><th>Planned by</th><th>Equipment booked</th></tr></thead><tbody>' + body + '</tbody></table>';
  }

  // All day bookings: saved experiments (Store) + manual day bookings, keyed by date.
  function bookingsByDate() {
    var map = {};
    if (root.Store && root.Store.allExperiments) {
      root.Store.allExperiments().forEach(function (e) {
        if (e.date) map[e.date] = { name: e.name || '(experiment)', source: 'experiment', id: e.id };
      });
    }
    readDays().forEach(function (b) { if (!map[b.date]) map[b.date] = { name: b.name, source: 'manual' }; });
    return map;
  }

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function renderExpCalendar() {
    var host = document.getElementById('expCalendar');
    if (!host) return;
    var map = bookingsByDate();
    var first = new Date(viewYear, viewMonth, 1);
    var startDow = first.getDay();
    var daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    var todayIso = (function () { var t = new Date(); return iso(t.getFullYear(), t.getMonth(), t.getDate()); })();

    var cells = '';
    ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].forEach(function (d) { cells += '<div class="cal-dow">' + d + '</div>'; });
    for (var i = 0; i < startDow; i++) cells += '<div class="cal-cell cal-empty"></div>';
    for (var d = 1; d <= daysInMonth; d++) {
      var date = iso(viewYear, viewMonth, d);
      var b = map[date];
      var cls = 'cal-cell' + (b ? ' cal-booked' : ' cal-free') + (date === todayIso ? ' cal-today' : '') + (date === selectedDay ? ' cal-selected' : '');
      cells += '<div class="' + cls + '" data-date="' + date + '">' +
        '<span class="cal-num">' + d + '</span>' +
        (b ? '<span class="cal-label" title="' + esc(b.name) + '">' + esc(b.name) + '</span>' : '') +
        '</div>';
    }
    host.innerHTML =
      '<div class="cal-head">' +
      '<button type="button" class="btn ghost cal-nav" data-nav="-1">\u2039</button>' +
      '<span class="cal-title">' + MONTHS[viewMonth] + ' ' + viewYear + '</span>' +
      '<button type="button" class="btn ghost cal-nav" data-nav="1">\u203a</button>' +
      '</div>' +
      '<div class="cal-grid">' + cells + '</div>' +
      '<p class="muted cal-hint">Click a free day to book an experiment (one per day). Click a booked day to view/clear. Saved experiments (with a date) appear automatically.</p>';
  }

  function onCalClick(e) {
    var nav = e.target.closest('[data-nav]');
    if (nav) {
      viewMonth += Number(nav.dataset.nav);
      if (viewMonth < 0) { viewMonth = 11; viewYear--; }
      if (viewMonth > 11) { viewMonth = 0; viewYear++; }
      renderExpCalendar();
      return;
    }
    var cell = e.target.closest('.cal-cell[data-date]');
    if (!cell) return;
    var date = cell.dataset.date;
    var map = bookingsByDate();
    if (map[date]) {
      var b = map[date];
      if (b.source === 'experiment') {
        alert('"' + b.name + '" is scheduled on ' + date + ' (from a saved experiment). Change its date in the Plan \u2192 Save step.');
      } else if (confirm('"' + b.name + '" is booked on ' + date + '. Remove this booking?')) {
        writeDays(readDays().filter(function (x) { return x.date !== date; }));
        renderExpCalendar();
        renderScheduledList();
      }
      selectedDay = date; syncBookingDate(); renderExpCalendar();
      return;
    }
    var name = prompt('Book an experiment on ' + date + '\nExperiment name:');
    if (name == null) return;
    name = name.trim(); if (!name) return;
    var days = readDays(); days.push({ date: date, name: name }); writeDays(days);
    selectedDay = date; syncBookingDate();
    renderExpCalendar();
    renderScheduledList();
  }

  function syncBookingDate() {
    if (!selectedDay) return;
    document.querySelectorAll('.equip-date').forEach(function (inp) { if (!inp.value) inp.value = selectedDay; });
  }

  function mergedEmbedUrl() {
    var params = EQUIPMENT.map(function (e) {
      return 'src=' + encodeURIComponent(e.cal) + '&color=' + encodeURIComponent(e.color);
    }).join('&');
    return 'https://calendar.google.com/calendar/embed?' + params +
      '&ctz=' + encodeURIComponent(TZ) + '&mode=WEEK&showTitle=0&showPrint=0&showCalendars=1';
  }

  function gcalLink(calId, title, date, startT, endT) {
    var d = date.replace(/-/g, '');
    var s = d + 'T' + startT.replace(':', '') + '00';
    var e = d + 'T' + endT.replace(':', '') + '00';
    var p = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: s + '/' + e, ctz: TZ, src: calId });
    return 'https://calendar.google.com/calendar/render?' + p.toString();
  }

  function icsFor(list) {
    var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//singlecell-planner//scheduling//EN', 'CALSCALE:GREGORIAN'];
    list.forEach(function (b) {
      var d = b.date.replace(/-/g, '');
      lines.push('BEGIN:VEVENT',
        'UID:' + Math.random().toString(36).slice(2) + '@scp',
        'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, ''),
        'SUMMARY:' + b.title + ' \u2014 ' + b.equip,
        'DTSTART:' + d + 'T' + b.start.replace(':', '') + '00',
        'DTEND:' + d + 'T' + b.end.replace(':', '') + '00',
        'END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  function renderEquipTable() {
    var host = document.getElementById('equipTable');
    if (!host) return;
    var rows = EQUIPMENT.map(function (e, i) {
      return '<tr>' +
        '<td><label class="equip-inc"><input type="checkbox" class="equip-check" data-i="' + i + '" /> <span class="equip-swatch" style="background:' + e.color + '"></span>' + esc(e.name) + '</label></td>' +
        '<td><input type="date" class="equip-date" data-i="' + i + '" value="' + (selectedDay || '') + '" /></td>' +
        '<td><input type="time" class="equip-start" data-i="' + i + '" value="' + (e.start || '09:00') + '" /></td>' +
        '<td><input type="time" class="equip-end" data-i="' + i + '" value="' + (e.end || '11:00') + '" /></td>' +
        '</tr>';
    }).join('');
    host.innerHTML =
      '<table class="sched-table"><thead><tr><th>Equipment</th><th>Date</th><th>Start</th><th>End</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="row-actions"><button type="button" id="bookEquipBtn" class="btn primary">Book selected equipment</button>' +
      '<button type="button" id="selectAllEquip" class="btn ghost">Select all</button></div>' +
      '<div id="equipBookOutput"></div>';
  }

  function bookEquipment() {
    var out = document.getElementById('equipBookOutput');
    var checks = Array.prototype.slice.call(document.querySelectorAll('.equip-check:checked'));
    if (!checks.length) { out.innerHTML = '<p class="feas-flag feas-msg">Select at least one piece of equipment first.</p>'; return; }
    var title = (selectedDay && bookingsByDate()[selectedDay]) ? bookingsByDate()[selectedDay].name : 'Equipment booking';
    var bookings = [];
    var bad = [];
    checks.forEach(function (c) {
      var i = Number(c.dataset.i);
      var date = (document.querySelector('.equip-date[data-i="' + i + '"]') || {}).value;
      var start = (document.querySelector('.equip-start[data-i="' + i + '"]') || {}).value;
      var end = (document.querySelector('.equip-end[data-i="' + i + '"]') || {}).value;
      if (!date || !start || !end || end <= start) { bad.push(EQUIPMENT[i].name); return; }
      bookings.push({ equip: EQUIPMENT[i].name, cal: EQUIPMENT[i].cal, date: date, start: start, end: end, title: title });
    });
    if (!bookings.length) { out.innerHTML = '<p class="feas-flag feas-msg">Set a valid date and time block (end after start) for the selected equipment.</p>'; return; }

    // Record locally so the "Scheduled experiments" list shows booking status
    // (replace any prior booking for the same date + instrument).
    var kept = readEquip().filter(function (x) { return !bookings.some(function (b) { return b.date === x.date && b.equip === x.equip; }); });
    bookings.forEach(function (b) { kept.push({ date: b.date, equip: b.equip, start: b.start, end: b.end, title: b.title }); });
    writeEquip(kept);
    renderScheduledList();

    // One-click booking via the Cloudflare function at /api/book (shared
    // service account writes straight to each equipment calendar). Falls back
    // to manual add-to-calendar links if the backend isn't configured.
    out.innerHTML =
      (bad.length ? '<p class="feas-flag feas-msg">Skipped (invalid times): ' + esc(bad.join(', ')) + '</p>' : '') +
      '<div class="callout info">Booking to lab calendars\u2026</div>';

    Promise.all(bookings.map(function (b) {
      return fetch('/api/book', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ equip: b.equip, date: b.date, start: b.start, end: b.end, title: b.title })
      }).then(function (r) {
        return r.json().then(
          function (j) { return { b: b, http: r.status, ok: (r.ok && j && j.ok), j: j }; },
          function () { return { b: b, http: r.status, ok: false, j: { error: 'bad_response' } }; }
        );
      }).catch(function (err) {
        return { b: b, http: 0, ok: false, j: { error: 'network', message: String(err) } };
      });
    })).then(function (results) { renderBookingResults(results, bad, bookings); });
  }

  function renderBookingResults(results, bad, bookings) {
    var out = document.getElementById('equipBookOutput');
    if (!out) return;
    var anyOk = results.some(function (x) { return x.ok; });
    var notConfigured = results.some(function (x) {
      return x.http === 503 || x.http === 404 || (x.j && x.j.error === 'not_configured');
    });

    var items = results.map(function (x) {
      if (x.ok) {
        return '<li class="rsv rsv-ok">\u2713 ' + esc(x.b.equip) + ' \u2014 ' + esc(x.b.date) + ' ' +
          esc(x.b.start) + '\u2013' + esc(x.b.end) +
          (x.j && x.j.htmlLink ? ' <a href="' + x.j.htmlLink + '" target="_blank" rel="noopener">view</a>' : '') + '</li>';
      }
      var detail = (x.j && x.j.detail && x.j.detail.error && x.j.detail.error.message) ? ': ' + esc(x.j.detail.error.message) : '';
      var why = (x.j && (x.j.error || x.j.message)) ? ' (' + esc(x.j.error || x.j.message) + detail + ')' : '';
      return '<li class="rsv rsv-short">\u2717 ' + esc(x.b.equip) + why + '</li>';
    }).join('');

    // Manual fallback (pre-filled add-to-calendar links + .ics) — always kept.
    var links = bookings.map(function (b) {
      return '<li><a href="' + gcalLink(b.cal, b.title, b.date, b.start, b.end) + '" target="_blank" rel="noopener">' +
        esc(b.equip) + '</a> \u2014 ' + esc(b.date) + ' ' + esc(b.start) + '\u2013' + esc(b.end) + '</li>';
    }).join('');
    var ics = icsFor(bookings);
    var icsUrl = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));

    out.innerHTML =
      (bad.length ? '<p class="feas-flag feas-msg">Skipped (invalid times): ' + esc(bad.join(', ')) + '</p>' : '') +
      (notConfigured
        ? '<div class="callout warn"><strong>One-click booking isn\u2019t live yet.</strong> The <code>/api/book</code> backend or its <code>GOOGLE_SA_KEY</code> secret isn\u2019t set, so nothing was written to Google. Use the manual links below, or finish the Cloudflare + service-account setup.</div>'
        : (anyOk
          ? '<div class="callout info"><strong>Booked to lab calendars.</strong> Events were created on the equipment calendars by the shared service account.</div>'
          : '<div class="callout warn"><strong>Booking failed.</strong> Per-item reasons below \u2014 you can still use the manual links.</div>')) +
      '<ul class="book-status">' + items + '</ul>' +
      '<details class="book-fallback"><summary>Manual add-to-calendar links / .ics (fallback)</summary>' +
      '<ol class="book-links">' + links + '</ol>' +
      '<p><a class="btn ghost" href="' + icsUrl + '" download="equipment-bookings.ics">Download all as .ics</a></p></details>';
  }

  function render(container) {
    if (!container) container = document.getElementById('schedulingContent');
    if (!container) return;
    if (viewYear == null) { var t = new Date(); viewYear = t.getFullYear(); viewMonth = t.getMonth(); }
    container.innerHTML =
      '<div class="wrap sched">' +
      '<h2>Scheduling</h2>' +
      '<section class="sched-block">' +
      '<h3>Project timing planner</h3>' +
      '<p class="muted">Plan a whole project\u2019s library prep. Each experiment with a built plan is a \u201cbatch.\u201d Compare running each batch straight through vs. taking all batches to cDNA then prepping libraries together \u2014 see the day-by-day schedule, hands-on time and library count per task, 10x safe stops, and where one person\u2019s 8 h day is exceeded.</p>' +
      '<div id="projectPlanner"></div>' +
      '</section>' +
      '<h3>Scheduled experiments</h3>' +
      '<p class="muted">Everything with an experiment date, plus the experiment you\u2019re currently designing (highlighted). The last column shows whether that day\u2019s equipment has been booked here yet.</p>' +
      '<div id="scheduledList"></div>' +
      '</section>' +
      '<section class="sched-block">' +
      '<h3>Experiment day</h3>' +
      '<p class="muted">One experiment per day. Booked days are greyed and labeled; saved experiments appear automatically.</p>' +
      '<div id="expCalendar" class="exp-cal"></div>' +
      '</section>' +
      '<section class="sched-block">' +
      '<h3>Equipment</h3>' +
      '<p class="muted">Each instrument starts with its usual time block \u2014 change any of them before booking. The date defaults to the experiment day selected above. (Tapestation\u2019s default is a placeholder; adjust to suit.)</p>' +
      '<div id="equipTable"></div>' +
      '</section>' +
      '<section class="sched-block">' +
      '<h3>All equipment calendars (single view)</h3>' +
      '<p class="muted">Every instrument calendar overlaid in one embed. Colours match the equipment list above.</p>' +
      '<iframe class="merged-cal" src="' + mergedEmbedUrl() + '" style="border:0" width="100%" height="640" frameborder="0" scrolling="no"></iframe>' +
      '</section>' +
      '</div>';

    renderExpCalendar();
    renderEquipTable();
    renderScheduledList();
    renderProjectPlanner();

    var cal = document.getElementById('expCalendar');
    if (cal) cal.addEventListener('click', onCalClick);
    container.addEventListener('click', function (e) {
      if (e.target.id === 'bookEquipBtn') bookEquipment();
      if (e.target.id === 'selectAllEquip') { document.querySelectorAll('.equip-check').forEach(function (c) { c.checked = true; }); }
    });
  }

  // ---- Project timing planner ----------------------------------------------
  var plannerProject = '', plannerConfig = 'perBatch';
  function labelFor(c) { return c === 'perBatch' ? 'per-batch' : 'pooled prep'; }
  function fmtMin(m) { m = Math.round(m || 0); var h = Math.floor(m / 60), mm = m % 60; return (h ? h + 'h ' : '') + ((mm || !h) ? mm + 'm' : '').trim() || '0m'; }

  function projectBatches(project) {
    var exps = (root.Store ? root.Store.allExperiments() : []).filter(function (e) {
      return (e.project || '') === project && e.snapshot && e.snapshot.laneBreakdown && e.snapshot.laneBreakdown.length;
    });
    return exps.map(function (e) {
      return {
        name: e.name,
        armLanes: e.snapshot.laneBreakdown.filter(function (l) { return l.lanes > 0; }).map(function (l) {
          return { arm: { chem: l.chem, population: l.population, vdj: l.vdj }, lanes: l.lanes };
        })
      };
    }).filter(function (b) { return b.armLanes.length; });
  }

  function wirePlanner() {
    var ps = document.getElementById('plannerProjectSel');
    if (ps) ps.onchange = function () { plannerProject = ps.value; renderProjectPlanner(); };
    var cs = document.getElementById('plannerConfigSel');
    if (cs) cs.onchange = function () { plannerConfig = cs.value; renderProjectPlanner(); };
  }

  function renderProjectPlanner() {
    var host = document.getElementById('projectPlanner');
    if (!host) return;
    if (!root.Timing) { host.innerHTML = '<p class="empty">Timing engine not loaded.</p>'; return; }
    var projects = (root.Store && root.Store.projects) ? (root.Store.projects().names || []) : [];
    if (!plannerProject && projects.length) plannerProject = projects[0];
    var projOpts = projects.map(function (p) { return '<option' + (p === plannerProject ? ' selected' : '') + '>' + esc(p) + '</option>'; }).join('');
    var controls = '<div class="proj-bar">' +
      '<label>Project <select id="plannerProjectSel">' + (projOpts || '<option value="">(no projects)</option>') + '</select></label>' +
      '<label style="margin-left:16px">Configuration <select id="plannerConfigSel">' +
      '<option value="perBatch"' + (plannerConfig === 'perBatch' ? ' selected' : '') + '>Per-batch (each straight through)</option>' +
      '<option value="pooledPrep"' + (plannerConfig === 'pooledPrep' ? ' selected' : '') + '>Pooled prep (all to cDNA, then one prep)</option>' +
      '</select></label></div>';
    if (!plannerProject) { host.innerHTML = controls + '<p class="empty">Create a project and build plans for its experiments first.</p>'; wirePlanner(); return; }
    var batches = projectBatches(plannerProject);
    if (!batches.length) {
      host.innerHTML = controls + '<p class="empty">No experiments in \u201c' + esc(plannerProject) + '\u201d have a built plan with lane counts yet. Build &amp; save a plan for each (re-save older experiments so lane data is captured), then they appear here as batches.</p>';
      wirePlanner(); return;
    }
    var project = { batches: batches };
    var chosen = root.Timing.schedule(project, { config: plannerConfig });
    var other = root.Timing.schedule(project, { config: plannerConfig === 'perBatch' ? 'pooledPrep' : 'perBatch' });
    var totalLibs = Object.keys(chosen.libraries).reduce(function (a, k) { return a + chosen.libraries[k]; }, 0);
    var cmp = '<div class="cost-headline">' +
      '<div><span class="ch-num">' + batches.length + '</span><span class="ch-lbl">experiments (batches)</span></div>' +
      '<div><span class="ch-num">' + chosen.totalDays + '</span><span class="ch-lbl">total days</span></div>' +
      '<div><span class="ch-num">' + chosen.libPrepSessions + '</span><span class="ch-lbl">library-prep days</span></div>' +
      '<div><span class="ch-num">' + totalLibs + '</span><span class="ch-lbl">total libraries</span></div>' +
      '</div>';
    var libsum = 'Libraries by type: ' + (Object.keys(chosen.libraries).length ? Object.keys(chosen.libraries).map(function (k) { return '<strong>' + chosen.libraries[k] + '</strong> ' + esc(k); }).join(' \u00b7 ') : '\u2014');
    var altNote = '<p class="muted">Alternative (' + labelFor(plannerConfig === 'perBatch' ? 'pooledPrep' : 'perBatch') + '): <strong>' + other.totalDays + '</strong> days, <strong>' + other.libPrepSessions + '</strong> library-prep day(s).</p>';
    var dayHtml = chosen.days.map(function (d) {
      var tasks = d.tasks.map(function (t) {
        return '<tr><td>' + esc(t.label) + '</td>' +
          '<td class="num">' + (t.libraries != null ? t.libraries : '\u2014') + '</td>' +
          '<td class="num">' + fmtMin(t.handsOnMin) + '</td>' +
          '<td class="num">' + (t.incubMin ? fmtMin(t.incubMin) : '\u2014') + '</td>' +
          '<td>' + (t.safeStopAfter ? '<span class="rsv rsv-ok">safe stop</span>' : '') + '</td></tr>';
      }).join('');
      return '<div class="planner-day' + (d.over ? ' day-over' : '') + '">' +
        '<h4 style="margin:14px 0 6px">Day ' + d.day + ' \u2014 ' + esc(d.batch || '') +
        ' <span class="who">' + (d.phase === 'batch' ? 'batch day (exempt from 8 h cap)' : 'library prep') +
        ' \u00b7 hands-on ' + fmtMin(d.handsOnMin) + (d.over ? '  \u26a0 over 8 h' : '') + '</span></h4>' +
        '<table class="cost-table"><thead><tr><th>Task</th><th class="num">Libraries</th><th class="num">Hands-on</th><th class="num">Incubation</th><th>Stop</th></tr></thead><tbody>' + tasks + '</tbody></table></div>';
    }).join('');
    var warn = chosen.warnings.length ? '<div class="callout warn"><strong>\u26a0 Timing flags:</strong><ul>' + chosen.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>' : '';
    host.innerHTML = controls + cmp + '<p class="muted">' + libsum + '</p>' + altNote + warn + dayHtml +
      '<p class="muted small">Hands-on time scales with the number of libraries in each step (no cap \u2014 so you can see how big a pooled prep gets); days break only at 10x safe stops; batch days are exempt from the 8 h/person limit. Timings are the lab defaults \u2014 ask Claude to change any. Assumes one person working sequentially; splitting steps across people is the next addition.</p>';
    wirePlanner();
  }

  root.Scheduling = { render: render, EQUIPMENT: EQUIPMENT, mergedEmbedUrl: mergedEmbedUrl, scheduledRows: scheduledRows, bookedByDate: bookedByDate };
})(typeof window !== 'undefined' ? window : this);

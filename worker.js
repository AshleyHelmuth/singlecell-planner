/* worker.js — Cloudflare Worker (static assets + API)
 * ---------------------------------------------------------------------------
 * Serves the Single-Cell Planner static site AND handles one-click equipment
 * booking to Google Calendar via a SERVICE ACCOUNT (single shared identity).
 *
 * Deploy as a "Worker with static assets" (see wrangler.toml). The site files
 * (index.html, css/, js/, data/, assets/) are the static assets; this script
 * intercepts POST/GET /api/book and passes everything else to the assets.
 *
 * ── One-time setup you must do (also in CALENDAR_SETUP.md) ─────────────────
 *  1. Google Cloud: create a project, enable the "Google Calendar API".
 *  2. Create a Service Account; create a JSON key; download it.
 *  3. Share EACH equipment calendar with the service account's email
 *     (permission: "Make changes to events"). 
 *  4. In this Worker → Settings → Variables and Secrets, add a SECRET named
 *     GOOGLE_SA_KEY whose value is the ENTIRE JSON key file contents.
 *  5. Re-deploy. The key is read only at runtime; it never ships to browsers.
 * ---------------------------------------------------------------------------
 */

// Allow-list: equipment name -> its Google calendar id. Must match scheduling.js.
const CALENDARS = {
  'BSC1': 'fe7836fa02ee2dbf37165fb6342df868b6878766c4212182925d5296cdddec52@group.calendar.google.com',
  'BSC2': 'fa259394976287b42162f6bae0794beb7fd80178cdd1f075f2383f76f3eb9525@group.calendar.google.com',
  'Chemical Hood': '1761540d25c59e44726fa9780cd8d35d889f4505525802b9133708d636655c13@group.calendar.google.com',
  'Centrifuge': 'e6a9fe5cdee1eee46fe8f31ef6fd3495da881305b390862b5cdf017c17357a5d@group.calendar.google.com',
  'Sony Sorter': '1ad41eb20eb6b5f546119f6eb8da207d1274599276bcc224e8141325afc4346b@group.calendar.google.com',
  'Chromium X': 'f6113753a09a8128a9612bdda61e105c93221f89fffa2ce38c8f74631b950ed0@group.calendar.google.com',
  'Tapestation': '1d8a15eb34be699ed8d28d9b3304dbcbc835e1fad452fb156b958cb21751f935@group.calendar.google.com',
  'Thermocycler': 'ac9d4e86a5b292de20497a7961f70875cc0ed4f206f65543a45f164e852c019c@group.calendar.google.com'
};

// Lab time zone (Yale / Hamden, CT). Change if your calendars use another zone.
const TIME_ZONE = 'America/New_York';

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function b64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlStr(s) { return b64url(new TextEncoder().encode(s)); }

function pemToBuf(pem) {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function getAccessToken(clientEmail, privateKeyPem, scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: clientEmail,
    scope: scope || 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const unsigned = b64urlStr(JSON.stringify(header)) + '.' + b64urlStr(JSON.stringify(claim));
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToBuf(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = unsigned + '.' + b64url(new Uint8Array(sig));

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('token exchange failed: ' + JSON.stringify(data));
  return data.access_token;
}

async function handleBook(request, env) {
  if (!env.GOOGLE_SA_KEY) {
    return json({ error: 'not_configured', message: 'GOOGLE_SA_KEY secret is not set on this Worker.' }, 503);
  }
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad_json' }, 400); }

  const equip = body.equip;
  const date = body.date;
  const start = body.start;
  const end = body.end;
  const title = (body.title || ('Booked: ' + equip)).toString().slice(0, 200);

  const calId = CALENDARS[equip];
  if (!calId) return json({ error: 'unknown_equipment', equip: equip }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || end <= start) {
    return json({ error: 'bad_datetime' }, 400);
  }

  let sa;
  try { sa = JSON.parse(env.GOOGLE_SA_KEY); } catch (e) { return json({ error: 'bad_sa_key' }, 500); }

  const token = await getAccessToken(sa.client_email, sa.private_key);
  const event = {
    summary: title,
    description: 'Booked via Single-Cell Planner',
    start: { dateTime: date + 'T' + start + ':00', timeZone: TIME_ZONE },
    end: { dateTime: date + 'T' + end + ':00', timeZone: TIME_ZONE }
  };
  const r = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(calId) + '/events',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    }
  );
  const outBody = await r.json();
  if (!r.ok) return json({ error: 'calendar_api', status: r.status, detail: outBody }, 502);
  return json({ ok: true, equip: equip, id: outBody.id, htmlLink: outBody.htmlLink });
}

function handleHealth(env) {
  return json({
    ok: true,
    endpoint: '/api/book',
    configured: !!env.GOOGLE_SA_KEY,
    equipment: Object.keys(CALENDARS)
  });
}

/* ===========================================================================
 * INVENTORY  —  live read/write of the Google Sheet (service account).
 * GET  /api/inventory                 -> { kits, reagents, lots }
 * POST /api/inventory {action:'setStock', itemId, onHand}
 * POST /api/inventory {action:'recordLots', rows:[{experiment,project,itemId,
 *                       item,lot,expiry,qtyUsed,recordedBy,date}]}
 *   recordLots appends to the "Lots Used" tab AND deducts qtyUsed from stock.
 * Setup: enable the Google Sheets API on the same Cloud project; share the
 * Sheet with the service-account email as Editor; set INVENTORY_SHEET_ID var.
 * =========================================================================== */
const SHEET_TABS = { kits: '10X Kits_Condensed', reagents: 'Reagents & Supplies', oligos: 'Oligos', antibodies: 'Antibodies', lots: 'Lots Used' };
const ID_HEADER = { '10X Kits_Condensed': 'Catalog #', 'Reagents & Supplies': 'item_id', 'Oligos': 'item_id', 'Antibodies': 'item_id' };
const ONHAND_HEADER = { '10X Kits_Condensed': 'On hand (kits)', 'Reagents & Supplies': 'On hand (units)', 'Oligos': 'On hand (units)', 'Antibodies': 'On hand (units)' };
const RESERVED_HEADER = 'Reserved (experiments)';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function colLetter(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function qtab(t) { return "'" + t.replace(/'/g, "''") + "'"; }

async function sheetsBatchGet(token, sheetId, tabs) {
  const q = tabs.map((t) => 'ranges=' + encodeURIComponent(qtab(t))).join('&');
  const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '/values:batchGet?' + q,
    { headers: { Authorization: 'Bearer ' + token } });
  const d = await r.json();
  if (!r.ok) throw new Error('sheets read failed: ' + JSON.stringify(d));
  return d.valueRanges || [];
}
async function sheetsUpdateCell(token, sheetId, range, value) {
  const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '/values/' + encodeURIComponent(range) + '?valueInputOption=USER_ENTERED',
    { method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [[value]] }) });
  const d = await r.json();
  if (!r.ok) throw new Error('sheets update failed: ' + JSON.stringify(d));
  return d;
}
async function sheetsUpdateValues(token, sheetId, range, values2D) {
  const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '/values/' + encodeURIComponent(range) + '?valueInputOption=USER_ENTERED',
    { method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: values2D }) });
  const d = await r.json();
  if (!r.ok) throw new Error('sheets values update failed: ' + JSON.stringify(d));
  return d;
}
async function sheetsAppend(token, sheetId, tab, values) {
  const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '/values/' + encodeURIComponent(qtab(tab) + '!A1') + ':append?valueInputOption=USER_ENTERED&insertDataOption=OVERWRITE',
    { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: values }) });
  const d = await r.json();
  if (!r.ok) throw new Error('sheets append failed: ' + JSON.stringify(d));
  return d;
}
function rowsToObjects(values) {
  if (!values || !values.length) return { headers: [], items: [] };
  const headers = values[0].map((h) => String(h == null ? '' : h).trim());
  const items = values.slice(1).map((row, i) => {
    const o = { __row: i + 2 };
    headers.forEach((h, ci) => { o[h] = (row[ci] !== undefined && row[ci] !== null) ? row[ci] : ''; });
    return o;
  });
  return { headers: headers, items: items };
}
// Find an item by id -> its tab, row, on-hand column & value. Kits are excluded:
// they are formula-driven in _Condensed and adjusted per-box via deductKitBoxes,
// so on-hand writes must never target the kits tab.
async function findItem(token, sheetId, itemId) {
  const want = String(itemId).trim();
  for (const tab of [SHEET_TABS.reagents, SHEET_TABS.oligos, SHEET_TABS.antibodies]) {
    const vr = await sheetsBatchGet(token, sheetId, [tab]);
    const { headers, items } = rowsToObjects(vr[0] ? vr[0].values : []);
    const idH = ID_HEADER[tab], ohH = ONHAND_HEADER[tab];
    const ohCol = headers.indexOf(ohH);
    const it = items.find((o) => String(o[idH]).trim() === want);
    if (it && ohCol >= 0) return { tab: tab, row: it.__row, ohCol: ohCol + 1, current: Number(it[ohH]) || 0 };
  }
  return null;
}

async function invToken(env) {
  const sa = JSON.parse(env.GOOGLE_SA_KEY);
  return getAccessToken(sa.client_email, sa.private_key, SHEETS_SCOPE);
}

async function handleInventoryGet(env) {
  try {
    if (!env.GOOGLE_SA_KEY) return json({ error: 'not_configured', message: 'GOOGLE_SA_KEY not set' }, 503);
    if (!env.INVENTORY_SHEET_ID) return json({ error: 'no_sheet', message: 'INVENTORY_SHEET_ID not set' }, 503);
    const token = await invToken(env);
    const vr = await sheetsBatchGet(token, env.INVENTORY_SHEET_ID, [SHEET_TABS.kits, SHEET_TABS.reagents, SHEET_TABS.oligos, SHEET_TABS.antibodies, SHEET_TABS.lots]);
    return json({
      ok: true, configured: true,
      kits: rowsToObjects(vr[0] ? vr[0].values : []).items,
      reagents: rowsToObjects(vr[1] ? vr[1].values : []).items,
      oligos: rowsToObjects(vr[2] ? vr[2].values : []).items,
      antibodies: rowsToObjects(vr[3] ? vr[3].values : []).items,
      lots: rowsToObjects(vr[4] ? vr[4].values : []).items
    });
  } catch (e) { return json({ error: 'exception', message: (e && e.message) || String(e) }, 500); }
}

async function handleInventoryPost(request, env) {
  try {
    if (!env.GOOGLE_SA_KEY) return json({ error: 'not_configured' }, 503);
    if (!env.INVENTORY_SHEET_ID) return json({ error: 'no_sheet' }, 503);
    let body; try { body = await request.json(); } catch (e) { return json({ error: 'bad_json' }, 400); }
    const id = env.INVENTORY_SHEET_ID;
    const token = await invToken(env);

    if (body.action === 'setStock') {
      const found = await findItem(token, id, body.itemId);
      if (!found) return json({ error: 'item_not_found', itemId: body.itemId }, 404);
      await sheetsUpdateCell(token, id, qtab(found.tab) + '!' + colLetter(found.ohCol) + found.row, Number(body.onHand));
      return json({ ok: true, itemId: body.itemId, onHand: Number(body.onHand) });
    }

    if (body.action === 'recordLots') {
      const rows = Array.isArray(body.rows) ? body.rows : [];
      const today = new Date().toISOString().slice(0, 10);
      const appendVals = rows.map((r) => [
        r.date || today, r.experiment || '', r.project || '', r.itemId || '',
        r.item || '', r.lot || '', r.expiry || '', (r.qtyUsed != null ? r.qtyUsed : ''), r.recordedBy || ''
      ]);
      if (appendVals.length) await sheetsAppend(token, id, SHEET_TABS.lots, appendVals);
      const deductions = [];
      for (const r of rows) {
        const found = await findItem(token, id, r.itemId);
        if (found) {
          const nv = found.current - (Number(r.qtyUsed) || 0);
          await sheetsUpdateCell(token, id, qtab(found.tab) + '!' + colLetter(found.ohCol) + found.row, nv);
          deductions.push({ itemId: r.itemId, newOnHand: nv });
        } else {
          deductions.push({ itemId: r.itemId, error: 'not_found' });
        }
      }
      return json({ ok: true, recorded: appendVals.length, deductions: deductions });
    }

    if (body.action === 'deductKitBoxes') {
      // Deduct rxns / index wells from specific boxes in 10X Kits_All (by Kit ID).
      // body.items = [{ kitId, rxnsUsed, indexesUsed }]. Writes remaining (col D)
      // and Indexes Used (col F); the _Condensed rollup updates via its formulas.
      const items = Array.isArray(body.items) ? body.items : [];
      const ALL_TAB = '10X Kits_All';
      const vr = await sheetsBatchGet(token, id, [ALL_TAB]);
      const values = (vr[0] && vr[0].values) ? vr[0].values : [];
      if (!values.length) return json({ error: 'no_all_tab' }, 409);
      const headers = values[0].map((h) => String(h == null ? '' : h).trim());
      const kidCol = headers.indexOf('Kit ID');
      const remCol = headers.indexOf('Rxns/Indexes Remaining');
      const usedCol = headers.indexOf('Indexes Used');
      const descCol = headers.indexOf('Description');
      if (kidCol < 0 || remCol < 0) return json({ error: 'missing_columns', headers }, 409);
      const results = [];
      for (const it of items) {
        const want = String(it.kitId || '').trim();
        if (!want) continue;
        let rowIdx = -1;
        for (let r = 1; r < values.length; r++) { if (String((values[r] || [])[kidCol] || '').trim() === want) { rowIdx = r; break; } }
        if (rowIdx < 0) { results.push({ kitId: want, error: 'not_found' }); continue; }
        const row = values[rowIdx];
        // one number = rxns / lanes / index wells used (may be negative for a correction)
        const usedAmt = (it.used != null) ? (Number(it.used) || 0) : ((Number(it.rxnsUsed) || 0) + (Number(it.indexesUsed) || 0));
        const curRem = Number(row[remCol]) || 0;
        const newRem = curRem - usedAmt;
        await sheetsUpdateCell(token, id, qtab(ALL_TAB) + '!' + colLetter(remCol + 1) + (rowIdx + 1), newRem);
        // for index kits, also track cumulative wells consumed in "Indexes Used"
        if (usedCol >= 0 && descCol >= 0 && /index/i.test(String(row[descCol] || ''))) {
          const curUsed = Number(row[usedCol]) || 0;
          await sheetsUpdateCell(token, id, qtab(ALL_TAB) + '!' + colLetter(usedCol + 1) + (rowIdx + 1), curUsed + usedAmt);
        }
        results.push({ kitId: want, newRemaining: newRem });
      }
      return json({ ok: true, results: results });
    }

    if (body.action === 'setReserved') {
      // Write the "Reserved (experiments)" column for each stock tab in one call.
      // body.reserved is a map { itemId: amount }. Items not in the map get 0,
      // so stale reservations are cleared.
      const map = body.reserved || {};
      let total = 0;
      for (const tab of [SHEET_TABS.kits, SHEET_TABS.reagents, SHEET_TABS.oligos, SHEET_TABS.antibodies]) {
        const vr = await sheetsBatchGet(token, id, [tab]);
        const values = vr[0] ? vr[0].values : [];
        if (!values || !values.length) continue;
        const headers = values[0].map((h) => String(h == null ? '' : h).trim());
        const idCol = headers.indexOf(ID_HEADER[tab]);
        const resCol = headers.indexOf(RESERVED_HEADER);
        if (idCol < 0 || resCol < 0) continue;
        const colVals = [];
        for (let r = 1; r < values.length; r++) {
          const row = values[r] || [];
          const iid = String(row[idCol] == null ? '' : row[idCol]).trim();
          colVals.push([(iid && map[iid] != null) ? map[iid] : 0]);
        }
        if (colVals.length) {
          const col = colLetter(resCol + 1);
          await sheetsUpdateValues(token, id, qtab(tab) + '!' + col + '2:' + col + (colVals.length + 1), colVals);
          total += colVals.length;
        }
      }
      return json({ ok: true, rowsWritten: total });
    }

    return json({ error: 'unknown_action', action: body.action }, 400);
  } catch (e) { return json({ error: 'exception', message: (e && e.message) || String(e) }, 500); }
}

/* ===========================================================================
 * EXPERIMENTS  —  shared experiment store in a Google Sheet (source of truth).
 * GET  /api/experiments                     -> { experiments:[...], projects:[...] }
 * POST /api/experiments {action:'upsert', record:{...}}   (writes only that row)
 * POST /api/experiments {action:'delete', id}             (moves row to Trash)
 * POST /api/experiments {action:'saveProject', project:{name,owner,notes}}
 * Reads env.GOOGLE_SA_KEY (reused) + env.EXPERIMENTS_SHEET_ID.
 * Surgical: upsert/delete find the one row by id and rewrite only that row.
 * =========================================================================== */
const EXP_TAB = 'Experiments', EXP_TRASH = 'Trash', PROJ_TAB = 'Projects';
const EXP_META = 11;          // id..Updated (human-readable columns)
const EXP_CHUNK = 12;         // JSON chunk columns (12 x 45k = ~540k chars capacity)
const EXP_WIDTH = EXP_META + EXP_CHUNK; // 18 -> column R
const CHUNK_SIZE = 45000;     // safely under the 50,000-char/cell Sheets limit

function chunkJson(str) {
  const out = [];
  for (let i = 0; i < str.length; i += CHUNK_SIZE) out.push(str.slice(i, i + CHUNK_SIZE));
  while (out.length < EXP_CHUNK) out.push('');
  return out.slice(0, EXP_CHUNK);
}

// Field -> possible header names (so the sheet's column order/labels drive placement)
const EXP_FIELD_HEADERS = {
  id: ['id'],
  project: ['Project', 'project'],
  abbreviation: ['Project_Abbreviation', 'Abbreviation'],
  name: ['Experiment', 'name', 'Name'],
  experimentId: ['Experiment_ID', 'Experiment ID'],
  status: ['Status', 'status'],
  nSamples: ['Samples', '#samples', 'nSamples', '# samples'],
  nPools: ['Pools', '#pools', 'nPools', '# pools'],
  arms: ['Arms', 'arms'],
  mods: ['Modalities', 'mods', 'Modality'],
  knownTotal: ['Est. cost ($)', 'Est cost', 'Cost', 'knownTotal'],
  createdAt: ['Created', 'createdAt'],
  updatedAt: ['Updated', 'updatedAt'],
  json: ['record_json', '_data', 'json', 'JSON']
};
function mapExpCols(headers) {
  const h = (headers || []).map((x) => String(x == null ? '' : x).trim());
  const idx = {};
  for (const f in EXP_FIELD_HEADERS) {
    idx[f] = -1;
    for (const name of EXP_FIELD_HEADERS[f]) { const i = h.indexOf(name); if (i >= 0) { idx[f] = i; break; } }
  }
  return { idx: idx, headerWidth: h.length };
}

// Build a full row placing each field at its header-matched column; JSON chunks
// start at the record_json column (or right after the meta block if absent).
function buildExpRow(rec, abbreviation, headers, existingRow) {
  const s = rec.snapshot || {};
  const arms = Array.isArray(s.arms) ? s.arms.join(', ') : '';
  const mods = Array.isArray(s.modalities) ? s.modalities.join(', ') : '';
  const m = mapExpCols(headers);
  const idx = m.idx;
  const jsonCol = idx.json >= 0 ? idx.json : (m.headerWidth || EXP_META);
  const chunks = chunkJson(JSON.stringify(rec));
  let width = Math.max(m.headerWidth, jsonCol + chunks.length);
  for (const f in idx) if (idx[f] >= 0) width = Math.max(width, idx[f] + 1);
  const row = new Array(width).fill('');
  if (existingRow) for (let c = 0; c < width; c++) row[c] = existingRow[c] != null ? existingRow[c] : '';
  const set = (f, v) => { if (idx[f] >= 0) row[idx[f]] = v; };
  set('id', rec.id || ''); set('project', rec.project || ''); set('abbreviation', abbreviation || '');
  set('name', rec.name || ''); set('experimentId', rec.experimentId || ''); set('status', rec.status || '');
  set('nSamples', s.nSamples != null ? s.nSamples : ''); set('nPools', s.nPools != null ? s.nPools : '');
  set('arms', arms); set('mods', mods); set('knownTotal', s.knownTotal != null ? s.knownTotal : '');
  set('createdAt', rec.createdAt || ''); set('updatedAt', rec.updatedAt || '');
  for (let i = 0; i < chunks.length; i++) row[jsonCol + i] = chunks[i];
  return { row: row, jsonCol: jsonCol, width: width };
}
// Extract the stored JSON from a row: prefer the record_json column, fall back
// to the legacy fixed block for rows written before the header-aware change.
function extractExpJson(row, headers) {
  const m = mapExpCols(headers);
  const jsonCol = m.idx.json >= 0 ? m.idx.json : EXP_META;
  let jsonStr = row.slice(jsonCol).join('');
  if (!jsonStr) jsonStr = row.slice(EXP_META, EXP_WIDTH).join('');
  if (jsonStr && jsonStr[0] !== '{') { const legacy = row.slice(EXP_META, EXP_WIDTH).join(''); if (legacy && legacy[0] === '{') jsonStr = legacy; }
  return jsonStr;
}

function expRow(rec) {
  const s = rec.snapshot || {};
  const arms = Array.isArray(s.arms) ? s.arms.join(', ') : '';
  const mods = Array.isArray(s.modalities) ? s.modalities.join(', ') : '';
  const meta = [
    rec.id || '', rec.project || '', rec.name || '', rec.status || '',
    (s.nSamples != null ? s.nSamples : ''), (s.nPools != null ? s.nPools : ''),
    arms, mods, (s.knownTotal != null ? s.knownTotal : ''),
    rec.createdAt || '', rec.updatedAt || ''
  ];
  return meta.concat(chunkJson(JSON.stringify(rec))).concat([rec.experimentId || '']);
}

async function sheetsUpdateRow(token, sheetId, rangeA1, valuesRow) {
  const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '/values/' + encodeURIComponent(rangeA1) + '?valueInputOption=USER_ENTERED',
    { method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [valuesRow] }) });
  const d = await r.json();
  if (!r.ok) throw new Error('sheets row update failed: ' + JSON.stringify(d));
  return d;
}

/* ===========================================================================
 * LIBRARY SEQUENCING RECORD — append library rows to the shared record sheet.
 * POST /api/library { rows: [[Project, Experiment, Experiment_ID, Library Type,
 *   # of Libraries, Indexing Scheme, Storage Location, Requested Depth,
 *   Service Provider, Sent Date, Status, Flow Cell ID, Data Storage Location], ...],
 *   experimentId, replace? }
 * Uses the service account; the record sheet must be shared with it as editor.
 * ========================================================================= */
const LIBRARY_TAB = 'Summary';
async function handleLibraryPost(request, env) {
  try {
    if (!env.GOOGLE_SA_KEY) return json({ error: 'not_configured', message: 'GOOGLE_SA_KEY not set' }, 503);
    if (!env.LIBRARY_RECORD_SHEET_ID) return json({ error: 'no_sheet', message: 'LIBRARY_RECORD_SHEET_ID not set' }, 503);
    const body = await request.json();
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return json({ error: 'no_rows' }, 400);
    const token = await invToken(env);
    const id = env.LIBRARY_RECORD_SHEET_ID;
    // Optional: remove existing rows for this experiment (by Experiment_ID in col C) before appending.
    if (body.replace && body.experimentId) {
      const vr = await sheetsBatchGet(token, id, [LIBRARY_TAB]);
      const values = vr[0] ? vr[0].values : [];
      if (values && values.length > 1) {
        const kept = [values[0]];
        for (let r = 1; r < values.length; r++) {
          const row = values[r] || [];
          if (String(row[2] || '').trim() !== String(body.experimentId).trim()) kept.push(row);
        }
        // rewrite the whole tab (header + kept rows), clearing removed ones
        const width = Math.max.apply(null, kept.map((r) => r.length).concat([13]));
        const norm = kept.map((r) => { const c = r.slice(); while (c.length < width) c.push(''); return c; });
        // clear then write
        const lastCol = colLetter(width);
        await sheetsUpdateValues(token, id, qtab(LIBRARY_TAB) + '!A1:' + lastCol + values.length, norm.concat(
          new Array(Math.max(0, values.length - norm.length)).fill(null).map(() => new Array(width).fill(''))
        ));
      }
    }
    await sheetsAppend(token, id, LIBRARY_TAB, rows);
    return json({ ok: true, appended: rows.length });
  } catch (e) { return json({ error: 'exception', message: (e && e.message) || String(e) }, 500); }
}

async function handleExperimentsGet(env) {
  try {
    if (!env.GOOGLE_SA_KEY) return json({ error: 'not_configured' }, 503);
    if (!env.EXPERIMENTS_SHEET_ID) return json({ error: 'no_sheet', message: 'EXPERIMENTS_SHEET_ID not set' }, 503);
    const token = await invToken(env);
    const vr = await sheetsBatchGet(token, env.EXPERIMENTS_SHEET_ID, [EXP_TAB, PROJ_TAB]);
    const rows = (vr[0] && vr[0].values) ? vr[0].values : [];
    const headers = rows[0] || [];
    const im = mapExpCols(headers);
    const idCol = im.idx.id >= 0 ? im.idx.id : 0;
    const experiments = [];
    for (let r = 1; r < rows.length; r++) {           // row 0 is the header
      const row = rows[r] || [];
      const idCell = String(row[idCol] || '').trim();
      if (!idCell || idCell.toLowerCase() === 'id') continue;   // skip blanks and stray header rows
      const jsonStr = extractExpJson(row, headers);
      if (!jsonStr) continue;
      try { experiments.push(JSON.parse(jsonStr)); } catch (e) { /* skip malformed */ }
    }
    const projects = rowsToObjects(vr[1] ? vr[1].values : []).items
      .filter((p) => p['name'])
      .map((p) => ({ name: p['name'], abbreviation: p['Project_Abbreviation'] || '', owner: p['Owner'] || '', notes: p['Notes'] || '', createdAt: p['Created'] || '', updatedAt: p['Updated'] || '' }));
    return json({ ok: true, configured: true, experiments: experiments, projects: projects });
  } catch (e) { return json({ error: 'exception', message: (e && e.message) || String(e) }, 500); }
}

async function findRowById(token, sheetId, tab, id) {
  const vr = await sheetsBatchGet(token, sheetId, [tab]);
  const rows = (vr[0] && vr[0].values) ? vr[0].values : [];
  // Match on column A (the id is always written to col A by expRow), so this
  // works regardless of how the sheet's header columns are ordered/labeled.
  const target = String(id).trim();
  for (let r = 0; r < rows.length; r++) {
    const idCell = String((rows[r] || [])[0] || '').trim();
    if (idCell && idCell.toLowerCase() !== 'id' && idCell === target) return r + 1;
  }
  return null;
}

async function handleExperimentsPost(request, env) {
  try {
    if (!env.GOOGLE_SA_KEY) return json({ error: 'not_configured' }, 503);
    if (!env.EXPERIMENTS_SHEET_ID) return json({ error: 'no_sheet' }, 503);
    let body; try { body = await request.json(); } catch (e) { return json({ error: 'bad_json' }, 400); }
    const id = env.EXPERIMENTS_SHEET_ID;
    const token = await invToken(env);

    if (body.action === 'upsert') {
      const rec = body.record;
      if (!rec || !rec.id) return json({ error: 'missing_record_or_id' }, 400);
      const vr = await sheetsBatchGet(token, id, [EXP_TAB, PROJ_TAB]);
      const rows = (vr[0] && vr[0].values) ? vr[0].values : [];
      const headers = rows[0] || [];
      const im = mapExpCols(headers);
      const idCol = im.idx.id >= 0 ? im.idx.id : 0;
      // find the header row (the row whose id-column cell reads "id")
      let hdr = -1;
      for (let r = 0; r < rows.length; r++) { if (String((rows[r] || [])[idCol] || '').trim().toLowerCase() === 'id') { hdr = r; break; } }
      if (hdr < 0) {
        return json({ error: 'no_header', message: 'Experiments tab is missing its "id" header. Restore the header row and retry.' }, 409);
      }
      // look up the project's abbreviation from the Projects tab
      let abbreviation = '';
      const pRows = (vr[1] && vr[1].values) ? vr[1].values : [];
      if (pRows.length) {
        const { items } = rowsToObjects(pRows);
        const p = items.find((o) => String(o['name'] != null ? o['name'] : o['Name']).trim() === String(rec.project || '').trim());
        if (p) abbreviation = p['Project_Abbreviation'] || p['Abbreviation'] || '';
      }
      let target = -1, firstEmpty = -1;
      for (let r = hdr + 1; r < rows.length; r++) {
        const cell = String((rows[r] || [])[idCol] || '').trim();
        if (cell === String(rec.id).trim()) { target = r + 1; break; }
        if (!cell && firstEmpty < 0) firstEmpty = r + 1;
      }
      if (target < 0) target = (firstEmpty > 0) ? firstEmpty : (rows.length + 1);
      const existing = target > 0 && rows[target - 1] ? rows[target - 1] : null;
      const built = buildExpRow(rec, abbreviation, headers, existing);
      await sheetsUpdateRow(token, id, qtab(EXP_TAB) + '!A' + target + ':' + colLetter(built.width) + target, built.row);
      return json({ ok: true, wrote: rec.id, row: target, columns: im.idx });
    }

    if (body.action === 'delete') {
      if (!body.id) return json({ error: 'missing_id' }, 400);
      const vr = await sheetsBatchGet(token, id, [EXP_TAB]);
      const rows = (vr[0] && vr[0].values) ? vr[0].values : [];
      const headers = rows[0] || [];
      const im = mapExpCols(headers);
      const idCol = im.idx.id >= 0 ? im.idx.id : 0;
      let rowIdx = -1, found = null;
      for (let r = 1; r < rows.length; r++) {
        const idCell = String((rows[r] || [])[idCol] || '').trim();
        if (idCell && idCell.toLowerCase() !== 'id' && idCell === String(body.id).trim()) { rowIdx = r + 1; found = rows[r]; break; }
      }
      if (!found) return json({ ok: true, deleted: body.id, note: 'not found (already gone)' });
      const jsonStr = extractExpJson(found, headers);
      const nameCol = im.idx.name >= 0 ? im.idx.name : 2, projCol = im.idx.project >= 0 ? im.idx.project : 1, statCol = im.idx.status >= 0 ? im.idx.status : 3;
      const trashRow = [found[idCol] || '', found[projCol] || '', found[nameCol] || '', found[statCol] || '', new Date().toISOString()].concat(chunkJson(jsonStr));
      await sheetsAppend(token, id, EXP_TRASH, [trashRow]);
      const width = Math.max(found.length, headers.length, EXP_WIDTH + 1);
      const blank = new Array(width).fill('');
      await sheetsUpdateRow(token, id, qtab(EXP_TAB) + '!A' + rowIdx + ':' + colLetter(width) + rowIdx, blank);
      return json({ ok: true, deleted: body.id, trashed: true });
    }

    if (body.action === 'saveProject') {
      const p = body.project || {};
      if (!p.name) return json({ error: 'missing_name' }, 400);
      const now = new Date().toISOString();
      const vr = await sheetsBatchGet(token, id, [PROJ_TAB]);
      const values = vr[0] ? vr[0].values : [];
      const headers = (values[0] || []).map((h) => String(h == null ? '' : h).trim());
      // map each field to the column with the matching header (robust to column order/additions)
      const colOf = (names) => { for (const n of names) { const i = headers.indexOf(n); if (i >= 0) return i; } return -1; };
      const idx = {
        name: colOf(['name', 'Name']),
        abbrev: colOf(['Project_Abbreviation', 'Abbreviation', 'Project ID']),
        owner: colOf(['Owner', 'owner']),
        created: colOf(['Created', 'created']),
        updated: colOf(['Updated', 'updated']),
        notes: colOf(['Notes', 'notes'])
      };
      if (idx.name < 0) return json({ error: 'no_name_column', headers }, 409);
      const { items } = rowsToObjects(values);
      const it = items.find((o) => String(o['name'] != null ? o['name'] : o['Name']).trim() === String(p.name).trim());
      const width = headers.length || 6;
      // start from the existing row (preserve any columns we don't manage) or a blank row
      const row = new Array(width).fill('');
      if (it) { const existing = values[it.__row - 1] || []; for (let c = 0; c < width; c++) row[c] = existing[c] != null ? existing[c] : ''; }
      const set = (i, v) => { if (i >= 0 && i < width) row[i] = v; };
      set(idx.name, p.name);
      set(idx.abbrev, p.abbreviation || '');
      set(idx.owner, p.owner || '');
      set(idx.created, (it && idx.created >= 0 && row[idx.created]) ? row[idx.created] : now);
      set(idx.updated, now);
      set(idx.notes, p.notes || '');
      const lastCol = colLetter(width);
      if (it) await sheetsUpdateRow(token, id, qtab(PROJ_TAB) + '!A' + it.__row + ':' + lastCol + it.__row, row);
      else await sheetsAppend(token, id, PROJ_TAB, [row]);
      return json({ ok: true, project: p.name, wroteColumns: idx });
    }

    if (body.action === 'deleteProject') {
      if (!body.name) return json({ error: 'missing_name' }, 400);
      const vr = await sheetsBatchGet(token, id, [PROJ_TAB]);
      const { items } = rowsToObjects(vr[0] ? vr[0].values : []);
      const it = items.find((o) => String(o['name']).trim() === String(body.name).trim());
      if (it) await sheetsUpdateRow(token, id, qtab(PROJ_TAB) + '!A' + it.__row + ':F' + it.__row, ['', '', '', '', '', '']);
      return json({ ok: true, deletedProject: body.name });
    }

    return json({ error: 'unknown_action', action: body.action }, 400);
  } catch (e) { return json({ error: 'exception', message: (e && e.message) || String(e) }, 500); }
}

/* ===========================================================================
 * DRIVE  —  per-experiment folders + files in Google Drive (service account).
 * GET  /api/drive                                  -> health
 * POST /api/drive {action:'ensurePath', project, experiment?}
 *      -> finds/creates <parent>/<project>[/<experiment>], returns folder ids
 * POST /api/drive {action:'upload', name, folderId, base64, sourceMime, targetMime}
 *      -> uploads a file into folderId, converting to a Google-native type
 *         (targetMime = google-apps.spreadsheet / .document); replaces if the
 *         same name already exists in that folder.
 * POST /api/drive {action:'trash', id}   -> moves the item to a _Trash folder
 * Needs the Drive API enabled, the parent folder shared with the service
 * account (Editor), and env.DRIVE_PARENT_FOLDER_ID.
 * =========================================================================== */
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const G_FOLDER = 'application/vnd.google-apps.folder';

// Drive files must be owned by an account with storage quota. A service account
// has none, so Drive calls authenticate as the Annex account via an OAuth
// refresh token (client id/secret + refresh token -> short-lived access token).
async function driveToken(env) {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET || !env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    throw new Error('drive_oauth_not_configured');
  }
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: env.GOOGLE_OAUTH_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('drive token refresh failed: ' + JSON.stringify(data));
  return data.access_token;
}
function qEsc(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

async function driveFind(token, q) {
  const url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) +
    '&fields=files(id,name,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true';
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const d = await r.json();
  if (!r.ok) throw new Error('drive find: ' + JSON.stringify(d));
  return d.files || [];
}
async function driveEnsureFolder(token, name, parentId) {
  const q = "mimeType='" + G_FOLDER + "' and name='" + qEsc(name) + "' and '" + parentId + "' in parents and trashed=false";
  const found = await driveFind(token, q);
  if (found.length) return found[0].id;
  const r = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true',
    { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, mimeType: G_FOLDER, parents: [parentId] }) });
  const d = await r.json();
  if (!r.ok) throw new Error('drive create folder: ' + JSON.stringify(d));
  return d.id;
}
function b64ToBytes(b64) {
  const bin = atob(b64); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
// Apply clean formatting to a converted Google Sheet: frozen bold header row,
// auto-sized columns, and subtle alternating-row banding (best-effort).
async function formatSpreadsheet(token, ssId) {
  const base = 'https://sheets.googleapis.com/v4/spreadsheets/' + ssId;
  const hdrs = { Authorization: 'Bearer ' + token };
  const meta = await (await fetch(base + '?fields=sheets(properties(sheetId,title,gridProperties(columnCount)))', { headers: hdrs })).json();
  if (!meta || !meta.sheets) return;
  // fetch values so we can detect chip-well rows and note-first tabs
  const ranges = meta.sheets.map((s) => "'" + String(s.properties.title).replace(/'/g, "''") + "'");
  const vurl = base + '/values:batchGet?' + ranges.map((r) => 'ranges=' + encodeURIComponent(r)).join('&');
  let valueRanges = [];
  try { const vr = await (await fetch(vurl, { headers: hdrs })).json(); valueRanges = vr.valueRanges || []; } catch (e) { /* values optional */ }
  const RGB = (r, g, b) => ({ red: r, green: g, blue: b });
  const CHIP = { oil5: RGB(0.85, 0.27, 0.24), oilA: RGB(0.98, 0.67, 0.09), sample: RGB(0.70, 0.62, 0.76), beads: RGB(0.27, 0.71, 0.90), nofill: RGB(0.55, 0.58, 0.62) };
  const wline = { style: 'SOLID', color: RGB(1, 1, 1) };
  const reqs = [];
  const bandTabs = [];
  meta.sheets.forEach((sh, si) => {
    const sid = sh.properties.sheetId;
    const cols = (sh.properties.gridProperties && sh.properties.gridProperties.columnCount) || 12;
    const title = String(sh.properties.title);
    const vals = (valueRanges[si] && valueRanges[si].values) || [];
    reqs.push({ autoResizeDimensions: { dimensions: { sheetId: sid, dimension: 'COLUMNS', startIndex: 0, endIndex: cols } } });
    if (title === '10X Chip Layout') {
      let mode = '5';
      vals.forEach((row, r) => {
        const a = String((row && row[0]) || '');
        if (/asapseq/i.test(a)) mode = 'asap';
        else if (/citeseq|scrnaseq/i.test(a)) mode = '5';
        if (/citeseq|asapseq|scrnaseq/i.test(a)) {
          reqs.push({ repeatCell: { range: { sheetId: sid, startRowIndex: r, endRowIndex: r + 1, startColumnIndex: 0, endColumnIndex: cols }, cell: { userEnteredFormat: { backgroundColor: RGB(0.20, 0.25, 0.32), textFormat: { bold: true, foregroundColor: RGB(1, 1, 1) } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } });
          return;
        }
        let col = null;
        if (/oil/i.test(a)) col = (mode === 'asap') ? CHIP.oilA : CHIP.oil5;
        else if (/sample/i.test(a)) col = CHIP.sample;
        else if (/gel bead/i.test(a)) col = CHIP.beads;
        else if (/no fill/i.test(a)) col = CHIP.nofill;
        if (col) reqs.push({ repeatCell: { range: { sheetId: sid, startRowIndex: r, endRowIndex: r + 1, startColumnIndex: 1, endColumnIndex: 9 }, cell: { userEnteredFormat: { backgroundColor: col, borders: { top: wline, bottom: wline, left: wline, right: wline }, horizontalAlignment: 'CENTER' } }, fields: 'userEnteredFormat(backgroundColor,borders,horizontalAlignment)' } });
      });
      return; // no generic header/banding on the chip layout
    }
    // generic tabs: dark bold header on row 1 only if row 1 is a real header (not a "How to use" note)
    const a1 = String((vals[0] && vals[0][0]) || '');
    if (!/^how to use/i.test(a1)) {
      reqs.push({ updateSheetProperties: { properties: { sheetId: sid, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } });
      reqs.push({ repeatCell: { range: { sheetId: sid, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { backgroundColor: RGB(0.122, 0.227, 0.372), verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP', textFormat: { bold: true, foregroundColor: RGB(1, 1, 1) } } }, fields: 'userEnteredFormat(backgroundColor,verticalAlignment,wrapStrategy,textFormat)' } });
      bandTabs.push(sid);
    }
  });
  await fetch(base + ':batchUpdate', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: reqs }) });
  // banding is best-effort + only on generic real-header tabs (fails harmlessly if a band already exists)
  if (bandTabs.length) {
    try {
      const bands = bandTabs.map((sid) => ({ addBanding: { bandedRange: { range: { sheetId: sid, startRowIndex: 1 }, rowProperties: { firstBandColor: RGB(1, 1, 1), secondBandColor: RGB(0.949, 0.965, 0.980) } } } }));
      await fetch(base + ':batchUpdate', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: bands }) });
    } catch (e) { /* banding optional */ }
  }
}

async function driveUpload(token, name, folderId, base64, sourceMime, targetMime) {
  const q = "name='" + qEsc(name) + "' and '" + folderId + "' in parents and trashed=false";
  const existing = await driveFind(token, q);
  const meta = { name: name };
  if (targetMime) meta.mimeType = targetMime;
  if (!existing.length) meta.parents = [folderId];
  const boundary = 'scpBoundary' + Date.now();
  const enc = new TextEncoder();
  const pre = enc.encode('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(meta) + '\r\n--' + boundary + '\r\nContent-Type: ' + sourceMime + '\r\n\r\n');
  const media = b64ToBytes(base64);
  const post = enc.encode('\r\n--' + boundary + '--');
  const body = new Uint8Array(pre.length + media.length + post.length);
  body.set(pre, 0); body.set(media, pre.length); body.set(post, pre.length + media.length);
  const isUpdate = existing.length > 0;
  const url = isUpdate
    ? 'https://www.googleapis.com/upload/drive/v3/files/' + existing[0].id + '?uploadType=multipart&supportsAllDrives=true'
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true';
  const r = await fetch(url, { method: isUpdate ? 'PATCH' : 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + boundary }, body: body });
  const d = await r.json();
  if (!r.ok) throw new Error('drive upload: ' + JSON.stringify(d));
  return d;
}
async function driveTrash(token, parentId, itemId) {
  const trashFolder = await driveEnsureFolder(token, '_Trash', parentId);
  const cur = await fetch('https://www.googleapis.com/drive/v3/files/' + itemId + '?fields=parents&supportsAllDrives=true', { headers: { Authorization: 'Bearer ' + token } });
  const cd = await cur.json();
  const prev = (cd.parents || []).join(',');
  const r = await fetch('https://www.googleapis.com/drive/v3/files/' + itemId + '?addParents=' + trashFolder +
    (prev ? '&removeParents=' + prev : '') + '&supportsAllDrives=true',
    { method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}' });
  const d = await r.json();
  if (!r.ok) throw new Error('drive trash: ' + JSON.stringify(d));
  return d;
}

function handleDriveGet(env) {
  return json({
    ok: true, endpoint: '/api/drive',
    configured: !!(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REFRESH_TOKEN),
    parentSet: !!env.DRIVE_PARENT_FOLDER_ID
  });
}
async function handleDrivePost(request, env) {
  try {
    if (!(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REFRESH_TOKEN)) {
      return json({ error: 'not_configured', message: 'Drive OAuth credentials not set (GOOGLE_OAUTH_CLIENT_ID / _SECRET / _REFRESH_TOKEN).' }, 503);
    }
    if (!env.DRIVE_PARENT_FOLDER_ID) return json({ error: 'no_parent', message: 'DRIVE_PARENT_FOLDER_ID not set' }, 503);
    let body; try { body = await request.json(); } catch (e) { return json({ error: 'bad_json' }, 400); }
    const parent = env.DRIVE_PARENT_FOLDER_ID;
    const projectsParent = env.DRIVE_PROJECTS_FOLDER_ID || parent;   // project folders nest here
    const token = await driveToken(env);

    if (body.action === 'ensurePath') {
      if (!body.project) return json({ error: 'missing_project' }, 400);
      const projectId = await driveEnsureFolder(token, body.project, projectsParent);
      let experimentId = null;
      if (body.experiment) experimentId = await driveEnsureFolder(token, body.experiment, projectId);
      return json({ ok: true, projectId: projectId, experimentId: experimentId });
    }
    if (body.action === 'upload') {
      if (!body.name || !body.folderId || !body.base64 || !body.sourceMime) return json({ error: 'missing_fields' }, 400);
      const d = await driveUpload(token, body.name, body.folderId, body.base64, body.sourceMime, body.targetMime || null);
      if (d && d.id && /spreadsheet/i.test(body.targetMime || '')) { try { await formatSpreadsheet(token, d.id); } catch (e) { /* formatting best-effort */ } }
      return json({ ok: true, id: d.id, name: d.name });
    }
    if (body.action === 'trash') {
      if (!body.id) return json({ error: 'missing_id' }, 400);
      await driveTrash(token, parent, body.id);
      return json({ ok: true, trashed: body.id });
    }
    if (body.action === 'trashByName') {
      // find a project folder by name under the Projects folder and move it to _Trash (no create)
      if (!body.name) return json({ error: 'missing_name' }, 400);
      const q = "mimeType='" + G_FOLDER + "' and name='" + qEsc(body.name) + "' and '" + projectsParent + "' in parents and trashed=false";
      const found = await driveFind(token, q);
      if (!found.length) return json({ ok: true, note: 'folder not found', name: body.name });
      await driveTrash(token, projectsParent, found[0].id);
      return json({ ok: true, trashed: found[0].id, name: body.name });
    }
    return json({ error: 'unknown_action', action: body.action }, 400);
  } catch (e) { return json({ error: 'exception', message: (e && e.message) || String(e) }, 500); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/book') {
      if (request.method === 'POST') return handleBook(request, env);
      if (request.method === 'GET') return handleHealth(env);
      return json({ error: 'method_not_allowed' }, 405);
    }
    if (url.pathname === '/api/inventory') {
      if (request.method === 'GET') return handleInventoryGet(env);
      if (request.method === 'POST') return handleInventoryPost(request, env);
      return json({ error: 'method_not_allowed' }, 405);
    }
    if (url.pathname === '/api/experiments') {
      if (request.method === 'GET') return handleExperimentsGet(env);
      if (request.method === 'POST') return handleExperimentsPost(request, env);
      return json({ error: 'method_not_allowed' }, 405);
    }
    if (url.pathname === '/api/library') {
      if (request.method === 'POST') return handleLibraryPost(request, env);
      return json({ error: 'method_not_allowed' }, 405);
    }
    if (url.pathname === '/api/drive') {
      if (request.method === 'GET') return handleDriveGet(env);
      if (request.method === 'POST') return handleDrivePost(request, env);
      return json({ error: 'method_not_allowed' }, 405);
    }
    // Any non-API path: serve the static site files.
    return env.ASSETS.fetch(request);
  }
};

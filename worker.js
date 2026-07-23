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
const SHEET_TABS = { kits: '10X Kits', reagents: 'Reagents & Supplies', lots: 'Lots Used' };
const ID_HEADER = { '10X Kits': 'Catalog #', 'Reagents & Supplies': 'item_id' };
const ONHAND_HEADER = { '10X Kits': 'On hand (kits)', 'Reagents & Supplies': 'On hand (units)' };
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
// Find an item (kit or reagent) by id -> its tab, row, on-hand column & value.
async function findItem(token, sheetId, itemId) {
  const want = String(itemId).trim();
  for (const tab of [SHEET_TABS.kits, SHEET_TABS.reagents]) {
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
    const vr = await sheetsBatchGet(token, env.INVENTORY_SHEET_ID, [SHEET_TABS.kits, SHEET_TABS.reagents, SHEET_TABS.lots]);
    return json({
      ok: true, configured: true,
      kits: rowsToObjects(vr[0] ? vr[0].values : []).items,
      reagents: rowsToObjects(vr[1] ? vr[1].values : []).items,
      lots: rowsToObjects(vr[2] ? vr[2].values : []).items
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
  return meta.concat(chunkJson(JSON.stringify(rec)));
}

async function sheetsUpdateRow(token, sheetId, rangeA1, valuesRow) {
  const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '/values/' + encodeURIComponent(rangeA1) + '?valueInputOption=USER_ENTERED',
    { method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [valuesRow] }) });
  const d = await r.json();
  if (!r.ok) throw new Error('sheets row update failed: ' + JSON.stringify(d));
  return d;
}

async function handleExperimentsGet(env) {
  try {
    if (!env.GOOGLE_SA_KEY) return json({ error: 'not_configured' }, 503);
    if (!env.EXPERIMENTS_SHEET_ID) return json({ error: 'no_sheet', message: 'EXPERIMENTS_SHEET_ID not set' }, 503);
    const token = await invToken(env);
    const vr = await sheetsBatchGet(token, env.EXPERIMENTS_SHEET_ID, [EXP_TAB, PROJ_TAB]);
    const rows = (vr[0] && vr[0].values) ? vr[0].values : [];
    const experiments = [];
    for (let r = 0; r < rows.length; r++) {           // find data rows by content, not position
      const row = rows[r] || [];
      const idCell = String(row[0] || '').trim();
      if (!idCell || idCell.toLowerCase() === 'id') continue;   // skip blanks and the header row
      const jsonStr = row.slice(EXP_META, EXP_WIDTH).join('');
      if (!jsonStr) continue;
      try { experiments.push(JSON.parse(jsonStr)); } catch (e) { /* skip malformed */ }
    }
    const projects = rowsToObjects(vr[1] ? vr[1].values : []).items
      .filter((p) => p['name'])
      .map((p) => ({ name: p['name'], owner: p['Owner'] || '', notes: p['Notes'] || '', createdAt: p['Created'] || '', updatedAt: p['Updated'] || '' }));
    return json({ ok: true, configured: true, experiments: experiments, projects: projects });
  } catch (e) { return json({ error: 'exception', message: (e && e.message) || String(e) }, 500); }
}

async function findRowById(token, sheetId, tab, id) {
  const vr = await sheetsBatchGet(token, sheetId, [tab]);
  const { items } = rowsToObjects(vr[0] ? vr[0].values : []);
  const it = items.find((o) => String(o['id']).trim() === String(id).trim());
  return it ? it.__row : null;
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
      const row = expRow(rec);
      const vr = await sheetsBatchGet(token, id, [EXP_TAB]);
      const rows = (vr[0] && vr[0].values) ? vr[0].values : [];
      let hdr = -1;
      for (let r = 0; r < rows.length; r++) { if (String((rows[r] || [])[0] || '').trim().toLowerCase() === 'id') { hdr = r; break; } }
      if (hdr < 0) {
        return json({ error: 'no_header', message: 'Experiments tab is missing its "id" header in column A. Refusing to write so the sheet is not clobbered. Restore the header row (id | Project | Experiment | ...) and retry.' }, 409);
      }
      let target = -1, firstEmpty = -1;
      for (let r = (hdr >= 0 ? hdr + 1 : 0); r < rows.length; r++) {
        const cell = String((rows[r] || [])[0] || '').trim();
        if (cell === String(rec.id).trim()) { target = r + 1; break; }
        if (!cell && firstEmpty < 0) firstEmpty = r + 1;
      }
      if (target < 0) target = (firstEmpty > 0) ? firstEmpty : (rows.length + 1);
      await sheetsUpdateRow(token, id, qtab(EXP_TAB) + '!A' + target + ':' + colLetter(EXP_WIDTH) + target, row);
      return json({ ok: true, wrote: rec.id, row: target });
    }

    if (body.action === 'delete') {
      if (!body.id) return json({ error: 'missing_id' }, 400);
      const vr = await sheetsBatchGet(token, id, [EXP_TAB]);
      const rows = (vr[0] && vr[0].values) ? vr[0].values : [];
      let rowIdx = -1, found = null;
      for (let r = 0; r < rows.length; r++) {
        const idCell = String((rows[r] || [])[0] || '').trim();
        if (idCell && idCell.toLowerCase() !== 'id' && idCell === String(body.id).trim()) { rowIdx = r + 1; found = rows[r]; break; }
      }
      if (!found) return json({ ok: true, deleted: body.id, note: 'not found (already gone)' });
      const jsonStr = found.slice(EXP_META, EXP_WIDTH).join('');
      // move to Trash (id, project, name, status, deletedAt, + JSON chunks), then clear the source row
      const trashRow = [found[0], found[1], found[2], found[3], new Date().toISOString()].concat(chunkJson(jsonStr));
      await sheetsAppend(token, id, EXP_TRASH, [trashRow]);
      const blank = new Array(EXP_WIDTH).fill('');
      await sheetsUpdateRow(token, id, qtab(EXP_TAB) + '!A' + rowIdx + ':' + colLetter(EXP_WIDTH) + rowIdx, blank);
      return json({ ok: true, deleted: body.id, trashed: true });
    }

    if (body.action === 'saveProject') {
      const p = body.project || {};
      if (!p.name) return json({ error: 'missing_name' }, 400);
      const now = new Date().toISOString();
      const vr = await sheetsBatchGet(token, id, [PROJ_TAB]);
      const { items } = rowsToObjects(vr[0] ? vr[0].values : []);
      const it = items.find((o) => String(o['name']).trim() === String(p.name).trim());
      const rowVals = [p.name, p.owner || '', (it ? it['Created'] : now) || now, now, p.notes || ''];
      if (it) await sheetsUpdateRow(token, id, qtab(PROJ_TAB) + '!A' + it.__row + ':E' + it.__row, rowVals);
      else await sheetsAppend(token, id, PROJ_TAB, [rowVals]);
      return json({ ok: true, project: p.name });
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

async function driveToken(env) {
  const sa = JSON.parse(env.GOOGLE_SA_KEY);
  return getAccessToken(sa.client_email, sa.private_key, DRIVE_SCOPE);
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
  return json({ ok: true, endpoint: '/api/drive', configured: !!env.GOOGLE_SA_KEY, parentSet: !!env.DRIVE_PARENT_FOLDER_ID });
}
async function handleDrivePost(request, env) {
  try {
    if (!env.GOOGLE_SA_KEY) return json({ error: 'not_configured' }, 503);
    if (!env.DRIVE_PARENT_FOLDER_ID) return json({ error: 'no_parent', message: 'DRIVE_PARENT_FOLDER_ID not set' }, 503);
    let body; try { body = await request.json(); } catch (e) { return json({ error: 'bad_json' }, 400); }
    const parent = env.DRIVE_PARENT_FOLDER_ID;
    const token = await driveToken(env);

    if (body.action === 'ensurePath') {
      if (!body.project) return json({ error: 'missing_project' }, 400);
      const projectId = await driveEnsureFolder(token, body.project, parent);
      let experimentId = null;
      if (body.experiment) experimentId = await driveEnsureFolder(token, body.experiment, projectId);
      return json({ ok: true, projectId: projectId, experimentId: experimentId });
    }
    if (body.action === 'upload') {
      if (!body.name || !body.folderId || !body.base64 || !body.sourceMime) return json({ error: 'missing_fields' }, 400);
      const d = await driveUpload(token, body.name, body.folderId, body.base64, body.sourceMime, body.targetMime || null);
      return json({ ok: true, id: d.id, name: d.name });
    }
    if (body.action === 'trash') {
      if (!body.id) return json({ error: 'missing_id' }, 400);
      await driveTrash(token, parent, body.id);
      return json({ ok: true, trashed: body.id });
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
    if (url.pathname === '/api/drive') {
      if (request.method === 'GET') return handleDriveGet(env);
      if (request.method === 'POST') return handleDrivePost(request, env);
      return json({ error: 'method_not_allowed' }, 405);
    }
    // Any non-API path: serve the static site files.
    return env.ASSETS.fetch(request);
  }
};

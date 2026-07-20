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

async function getAccessToken(clientEmail, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/calendar',
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/book') {
      if (request.method === 'POST') return handleBook(request, env);
      if (request.method === 'GET') return handleHealth(env);
      return json({ error: 'method_not_allowed' }, 405);
    }
    // Any non-API path: serve the static site files.
    return env.ASSETS.fetch(request);
  }
};

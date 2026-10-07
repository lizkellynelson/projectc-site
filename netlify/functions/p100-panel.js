// p100-panel.js — Netlify serverless function
// -------------------------------------------------------
// Powers projectc.com/100/panel, the private home for the Project C 100
// advisory panel. The page itself is a public file with no private content;
// everything private comes from this function, and only for a valid key.
//
//   GET /.netlify/functions/p100-panel?k=PRIVATE_KEY
//
// Where the data lives: the "Project C 100 · Panel HQ" Google Sheet
// (TOP 100 LIST folder in Liz's Drive). Liz edits it directly:
//   Panelists  A:H  name, first name, affiliation, email, status, role, key, link
//   Timeline   A:G  start, end, date label, what, who (Panel/Team), details, done
//   Settings   A:B  key / value pairs (welcome note, call times and links, ...)
//
// Access rules:
//   - The key must match a row in Panelists.
//   - status "yes" gets in. "invited" gets a friendly "not active yet".
//     Anything else (e.g. "no") is treated as an unknown key.
//   - role "chair" (Liz) also sees Team steps and everyone's status and links.
//
// Changes to the Sheet show up on the page within about a minute (cache below).
//
// Env vars (already set for p100-nominate.js):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY
// The service account has view-only access to the Panel HQ sheet.

const crypto = require('crypto');

const SHEET_ID = '1VB6Pgad_FufiksCE0hmTSCu2G1yQoXM70zC-Dh72-qg';
const CACHE_MS = 60 * 1000;

const SETTING_KEYS = [
  'welcome_note', 'one_pager_url', 'category_call', 'category_call_link',
  'settle_call', 'settle_call_link', 'ballot_status', 'launch_label',
  'rubric_url',
];

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
    body: JSON.stringify(body),
  };
}

// —— Rate limiting on failed keys (per warm instance; a speed bump) ——
const misses = new Map();
const MISS_WINDOW = 10 * 60 * 1000;
const MISS_MAX = 12;

function tooManyMisses(ip) {
  const r = misses.get(ip);
  if (!r || Date.now() - r.start > MISS_WINDOW) return false;
  return r.count >= MISS_MAX;
}
function recordMiss(ip) {
  const now = Date.now();
  const r = misses.get(ip);
  if (!r || now - r.start > MISS_WINDOW) misses.set(ip, { start: now, count: 1 });
  else r.count++;
}

// —— Google auth (service account, signed JWT; no extra packages) ——
let cachedToken = null;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function googleToken() {
  if (cachedToken && cachedToken.exp - 60 > Date.now() / 1000) return cachedToken.token;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !key) throw new Error('Google service account env vars not set');
  key = key.replace(/\\n/g, '\n').replace(/^"|"$/g, '');

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signature = crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(key);
  const jwt = `${header}.${claim}.${b64url(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    signal: AbortSignal.timeout(5000),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) throw new Error(`Google token error ${res.status} ${d.error || ''}`);
  cachedToken = { token: d.access_token, exp: now + (d.expires_in || 3600) };
  return cachedToken.token;
}

// —— Read the Sheet (cached) ——
let cache = null; // { at, data }

async function readSheet() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const token = await googleToken();
  const ranges = ['Panelists!A2:H200', 'Timeline!A2:G200', 'Settings!A2:B50']
    .map((r) => 'ranges=' + encodeURIComponent(r)).join('&');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchGet?${ranges}&valueRenderOption=FORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(7000) });
  if (!res.ok) throw new Error(`Sheets read ${res.status}`);
  const d = await res.json();
  const [p, t, s] = (d.valueRanges || []).map((v) => v.values || []);
  const data = { panelists: parsePanelists(p || []), timeline: parseTimeline(t || []), settings: parseSettings(s || []) };
  cache = { at: Date.now(), data };
  return data;
}

const cell = (row, i) => (row[i] == null ? '' : String(row[i]).trim());

function parsePanelists(rows) {
  return rows.map((r) => ({
    name: cell(r, 0),
    first: cell(r, 1) || cell(r, 0).split(' ')[0],
    affiliation: cell(r, 2),
    status: cell(r, 4).toLowerCase(),
    role: cell(r, 5).toLowerCase() || 'panelist',
    key: cell(r, 6),
    link: cell(r, 7),
  })).filter((p) => p.name && p.key);
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function parseTimeline(rows) {
  return rows.map((r) => {
    const start = cell(r, 0);
    const end = cell(r, 1);
    return {
      start: ISO.test(start) ? start : '',
      end: ISO.test(end) ? end : '',
      label: cell(r, 2),
      what: cell(r, 3),
      who: /team/i.test(cell(r, 4)) ? 'Team' : 'Panel',
      details: cell(r, 5),
      done: /^(yes|y|done|x|true)$/i.test(cell(r, 6)),
    };
  }).filter((t) => t.what);
}

function parseSettings(rows) {
  const out = {};
  for (const r of rows) {
    const k = cell(r, 0);
    if (SETTING_KEYS.includes(k)) out[k] = cell(r, 1);
  }
  return out;
}

function keyMatches(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const safeUrl = (u) => (/^https:\/\//i.test(u || '') ? u : '');

// —— Handler ——
exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method_not_allowed' });

  const ip = String((event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'])) || 'unknown').split(',')[0].trim();
  if (tooManyMisses(ip)) return json(429, { error: 'too_many_tries' });

  const k = String((event.queryStringParameters && event.queryStringParameters.k) || '').trim();
  if (k.length < 16 || k.length > 64 || !/^[A-Za-z0-9_-]+$/.test(k)) {
    recordMiss(ip);
    return json(404, { error: 'not_found' });
  }

  let data;
  try {
    data = await readSheet();
  } catch (err) {
    console.error('p100-panel: sheet read failed', err && err.message);
    // A short, non-sensitive reason code helps diagnose setup problems.
    const m = String(err && err.message || '');
    const reason = /env vars not set/.test(m) ? 'config' : /token error/.test(m) ? 'auth' : (m.match(/Sheets read (\d+)/) || [])[1] || 'other';
    return json(503, { error: 'unavailable', reason });
  }

  const me = data.panelists.find((p) => keyMatches(p.key, k));
  if (!me || !['yes', 'invited'].includes(me.status) && me.role !== 'chair') {
    recordMiss(ip);
    return json(404, { error: 'not_found' });
  }
  if (me.status === 'invited' && me.role !== 'chair') {
    return json(200, { pending: true, me: { first: me.first } });
  }

  const isChair = me.role === 'chair';
  const s = data.settings;

  const body = {
    me: { name: me.name, first: me.first, role: me.role },
    roster: data.panelists
      .filter((p) => p.status === 'yes' && p.role !== 'chair')
      .map((p) => ({ name: p.name, affiliation: p.affiliation })),
    timeline: data.timeline.filter((t) => isChair || t.who === 'Panel'),
    settings: {
      welcome_note: s.welcome_note || '',
      one_pager_url: safeUrl(s.one_pager_url),
      rubric_url: safeUrl(s.rubric_url),
      category_call: s.category_call || '',
      category_call_link: safeUrl(s.category_call_link),
      settle_call: s.settle_call || '',
      settle_call_link: safeUrl(s.settle_call_link),
      ballot_status: (s.ballot_status || 'closed').toLowerCase(),
      launch_label: s.launch_label || 'January 2027',
    },
  };

  if (isChair) {
    body.chair = {
      panelists: data.panelists
        .filter((p) => p.role !== 'chair')
        .map((p) => ({ name: p.name, status: p.status || '—', link: p.link })),
    };
  }

  return json(200, body);
};

// Exposed for local tests only.
exports._test = { parseTimeline, parsePanelists, parseSettings, keyMatches };

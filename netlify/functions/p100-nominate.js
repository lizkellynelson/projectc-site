// p100-nominate.js — Netlify serverless function
// -------------------------------------------------------
// Powers projectc.com/100, the open call for the Project C 100:
// Creators to Watch, 2027. One endpoint, two modes:
//
//   mode: "nominate"  (the nomination form)
//     1. Validate everything on the server (required fields, URL and email
//        formats, the 1,500-character cap on "why", the honeypot and the
//        3-second time check).
//     2. Save the full submission to Netlify Blobs FIRST (store
//        "p100-nominations", key = submission ID), so nothing is lost if
//        Google Sheets has a bad day.
//     3. If the nominator ticked the newsletter box, add them to beehiiv.
//        Never reactivates someone who unsubscribed. A beehiiv failure never
//        fails the nomination.
//     4. Append one row (columns A to W) to the "Project C 100 – Nominations
//        2027" Google Sheet.
//     5. Return success if the nomination is safely stored in at least one
//        place (Blobs or the Sheet). Only when both fail does the page show
//        the error message.
//
//   mode: "subscribe" (the "Want to see who makes the cut?" box)
//     beehiiv only, no Sheet row. Works before and after the close date.
//
// How P100 subscribers are marked in beehiiv (no tags, by design):
//   utm_campaign  = whatever the partner link carried, or "p100-call"
//   utm_content   = "p100-nominator" (form checkbox) or "p100-subscribe" (box)
//   referring_site = "projectc.com/100"
// Filter on utm_campaign = p100-call (or utm_content) in beehiiv to find them.
//
// Env vars:
//   BEEHIIV_API_KEY                 (already set for the Going Solo waitlist)
//   GOOGLE_SERVICE_ACCOUNT_EMAIL    (new)
//   GOOGLE_PRIVATE_KEY              (new; paste the whole key, \n escapes are fine)
//   P100_CLOSES_AT                  (optional override, ISO time. Default below.)
//
// Nominations close Friday, Nov. 13, 2026, 11:59:59 p.m. ET
// (= 2026-11-14T04:59:59Z, after daylight saving time ends).

const crypto = require('crypto');

const PUBLICATION_ID = 'pub_e067ba51-b52d-4f16-9459-58681134dfb6';
const BEEHIIV_BASE = 'https://api.beehiiv.com/v2';
const SHEET_ID = '1v5-19zPvTsigQLoigW-MfzAQN-C9TutkYD-JnYnajVY';
const BLOB_STORE = 'p100-nominations';
const DEFAULT_CLOSES_AT = '2026-11-14T04:59:59Z';
const MIN_FILL_MS = 3000;
const WHY_MAX = 1500;

const PLATFORMS = [
  'Newsletter', 'TikTok', 'YouTube', 'Instagram', 'Podcast',
  'X / Threads / Bluesky', 'LinkedIn', 'WhatsApp or Telegram', 'Print',
  'Website or blog', 'Other',
];
const HEARD_FROM = [
  'Project C newsletter', "Liz's social posts", 'Another newsletter or outlet',
  'A friend or colleague', 'Other',
];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function closesAt() {
  const t = Date.parse(process.env.P100_CLOSES_AT || DEFAULT_CLOSES_AT);
  return Number.isFinite(t) ? t : Date.parse(DEFAULT_CLOSES_AT);
}

// —— Rate limiting (per warm function instance; a speed bump, not a wall) ——
const rateLimits = new Map();
const RATE_WINDOW = 10 * 60 * 1000;
const RATE_MAX = 25; // people nominate several creators in a row, so keep it roomy

function rateOk(ip) {
  const now = Date.now();
  const r = rateLimits.get(ip);
  if (!r || now - r.start > RATE_WINDOW) { rateLimits.set(ip, { start: now, count: 1 }); return true; }
  if (r.count >= RATE_MAX) return false;
  r.count++;
  return true;
}

// —— Cleaning and validation ——

// Text that starts with = + - or @ can be read as a formula by Sheets or Excel.
// Strip those characters (and any whitespace mixed in) from the front.
function defang(s) {
  return s.replace(/^[\s=+\-@]+/, '');
}

function clean(v, max) {
  if (typeof v !== 'string') return '';
  return defang(v.replace(/\r\n?/g, '\n').trim()).slice(0, max);
}

function isEmail(s) {
  return typeof s === 'string' && s.length < 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// Accepts "substack.com/foo" as well as "https://substack.com/foo".
function normalizeUrl(raw) {
  let s = clean(raw, 600);
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function validateNomination(p) {
  const errors = {};
  const out = {};

  out.nominee_name = clean(p.nominee_name, 200);
  out.work_name = clean(p.work_name, 300);
  out.coverage = clean(p.coverage, 300);
  out.location = clean(p.location, 200);
  out.other_links = clean(p.other_links, 2000);
  out.nominator_name = clean(p.nominator_name, 200);
  out.heard_from_outlet = clean(p.heard_from_outlet, 200);

  const whyRaw = typeof p.why === 'string' ? p.why.replace(/\r\n?/g, '\n').trim() : '';
  if (whyRaw.length > WHY_MAX) errors.why = `Please keep this under ${WHY_MAX.toLocaleString('en-US')} characters.`;
  out.why = defang(whyRaw).slice(0, WHY_MAX);

  for (const k of ['nominee_name', 'work_name', 'coverage', 'location', 'why', 'nominator_name']) {
    if (!out[k] && !errors[k]) errors[k] = 'This one is required.';
  }

  const primary = normalizeUrl(p.primary_link);
  if (!primary) errors.primary_link = primary === null ? 'That link doesn’t look right.' : 'This one is required.';
  out.primary_link = primary || '';

  const example = normalizeUrl(p.example_link);
  if (example === null) errors.example_link = 'That link doesn’t look right.';
  out.example_link = example || '';

  const platforms = Array.isArray(p.platforms) ? p.platforms.filter((x) => PLATFORMS.includes(x)) : [];
  if (!platforms.length) errors.platforms = 'Pick at least one.';
  out.platforms = PLATFORMS.filter((x) => platforms.includes(x)).join(', ');

  out.self_nomination = p.self_nomination === 'Yes' || p.self_nomination === 'No' ? p.self_nomination : '';
  if (!out.self_nomination) errors.self_nomination = 'Please choose yes or no.';

  const nomineeEmail = clean(p.nominee_email, 254).toLowerCase();
  if (nomineeEmail && !isEmail(nomineeEmail)) errors.nominee_email = 'That email doesn’t look right.';
  out.nominee_email = nomineeEmail;

  const nominatorEmail = clean(p.nominator_email, 254).toLowerCase();
  if (!isEmail(nominatorEmail)) errors.nominator_email = nominatorEmail ? 'That email doesn’t look right.' : 'This one is required.';
  out.nominator_email = nominatorEmail;

  out.heard_from = HEARD_FROM.includes(p.heard_from) ? p.heard_from : '';
  if (!out.heard_from) errors.heard_from = 'Please pick one.';
  if (out.heard_from !== 'Another newsletter or outlet') out.heard_from_outlet = '';

  out.newsletter_opt_in = p.newsletter_opt_in === true || p.newsletter_opt_in === 'yes';

  return { out, errors };
}

function tracking(p) {
  return {
    utm_source: clean(p.utm_source, 120),
    utm_medium: clean(p.utm_medium, 120),
    utm_campaign: clean(p.utm_campaign, 120),
    referrer: clean(p.referrer, 500),
  };
}

// —— beehiiv ——
// Returns one of: subscribed, already_subscribed, previously_unsubscribed, failed
async function addToBeehiiv(email, t, content) {
  const key = process.env.BEEHIIV_API_KEY;
  if (!key) { console.error('p100: BEEHIIV_API_KEY not set'); return 'failed'; }
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const base = `${BEEHIIV_BASE}/publications/${PUBLICATION_ID}/subscriptions`;

  try {
    // 1. Look them up first, so existing readers are reported accurately and
    //    people who unsubscribed are left alone.
    const look = await fetch(`${base}/by_email/${encodeURIComponent(email)}`, {
      headers, signal: AbortSignal.timeout(5000),
    });
    if (look.ok) {
      const d = await look.json().catch(() => ({}));
      const status = d && d.data && d.data.status;
      if (status === 'inactive') return 'previously_unsubscribed';
      if (status) return 'already_subscribed';
    } else if (look.status !== 404) {
      console.warn('p100: beehiiv lookup returned', look.status);
      // fall through and try the create; reactivate_existing:false keeps it safe
    }

    // 2. Create.
    const res = await fetch(base, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(6000),
      body: JSON.stringify({
        email,
        reactivate_existing: false,
        send_welcome_email: true,
        utm_source: t.utm_source || 'projectc.com',
        utm_medium: t.utm_medium || 'website',
        utm_campaign: t.utm_campaign || 'p100-call',
        utm_content: content,
        referring_site: 'projectc.com/100',
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('p100: beehiiv create failed', res.status, body.slice(0, 300));
      return 'failed';
    }
    const d = await res.json().catch(() => ({}));
    if (d && d.data && d.data.status === 'inactive') return 'previously_unsubscribed';
    return 'subscribed';
  } catch (err) {
    console.error('p100: beehiiv error', err && err.message);
    return 'failed';
  }
}

// —— Google Sheets (service account, signed JWT; no extra packages) ——
let cachedToken = null; // { token, exp }

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
    scope: 'https://www.googleapis.com/auth/spreadsheets',
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
  if (!res.ok || !d.access_token) throw new Error(`Google token error ${res.status} ${JSON.stringify(d).slice(0, 200)}`);
  cachedToken = { token: d.access_token, exp: now + (d.expires_in || 3600) };
  return cachedToken.token;
}

async function appendRow(row) {
  const token = await googleToken();
  // "A1:W1" with no tab name targets the first tab, so renaming it won't break anything.
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent('A1:W1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
    signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Sheets append ${res.status} ${body.slice(0, 300)}`);
  }
}

// —— Netlify Blobs ——
async function blobStore(event) {
  const { connectLambda, getStore } = require('@netlify/blobs');
  connectLambda(event);
  return getStore(BLOB_STORE);
}

// —— Handler ——
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let p;
  try { p = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request.' }); }

  const ip = (event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'])) || 'unknown';
  if (!rateOk(String(ip).split(',')[0].trim())) {
    return json(429, { error: 'Too many submissions in a short time. Please wait a few minutes and try again.' });
  }

  // Honeypot: a field real people never see. Pretend it worked so bots learn nothing.
  if (typeof p.website === 'string' && p.website.trim() !== '') {
    console.warn('p100: honeypot tripped');
    return json(200, { ok: true });
  }

  const t = tracking(p);

  // ——— Subscribe-only box ———
  if (p.mode === 'subscribe') {
    const email = clean(p.email, 254).toLowerCase();
    if (!isEmail(email)) return json(400, { error: 'Please enter a valid email address.', fields: { email: 'That email doesn’t look right.' } });
    const status = await addToBeehiiv(email, t, 'p100-subscribe');
    if (status === 'failed') return json(502, { error: 'Something went wrong on our end. Please try again.' });
    return json(200, { ok: true, status });
  }

  // ——— Nomination ———
  if (Date.now() > closesAt()) {
    return json(410, { closed: true, error: 'Nominations are closed.' });
  }

  const elapsed = Number(p.elapsed_ms);
  if (!Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) {
    console.warn('p100: time check failed', elapsed);
    return json(400, { error: 'That was faster than a person can fill out the form. Please try again.' });
  }

  const { out, errors } = validateNomination(p);
  if (Object.keys(errors).length) {
    return json(400, { error: 'A few fields need another look.', fields: errors });
  }

  const id = crypto.randomUUID();
  const submittedAt = new Date().toISOString();
  const record = { submitted_at: submittedAt, submission_id: id, ...out, ...t, beehiiv_status: 'pending', sheet_status: 'pending' };

  // 1. Backup first.
  let store = null;
  let blobOk = false;
  try {
    store = await blobStore(event);
    await store.setJSON(id, record);
    blobOk = true;
  } catch (err) {
    console.error('p100: blob write failed', err && err.message);
  }

  // 2. beehiiv (only if they opted in).
  record.beehiiv_status = out.newsletter_opt_in
    ? await addToBeehiiv(out.nominator_email, t, 'p100-nominator')
    : 'not_opted_in';

  // 3. The Sheet. Order must match columns A to W exactly.
  const row = [
    submittedAt, id, out.nominee_name, out.work_name, out.primary_link, out.other_links,
    out.platforms, out.coverage, out.location, out.why, out.example_link, out.self_nomination,
    out.nominee_email, out.nominator_name, out.nominator_email, out.heard_from, out.heard_from_outlet,
    out.newsletter_opt_in ? 'yes' : 'no', record.beehiiv_status,
    t.utm_source, t.utm_medium, t.utm_campaign, t.referrer,
  ];
  let sheetOk = false;
  try {
    await appendRow(row);
    sheetOk = true;
    record.sheet_status = 'ok';
  } catch (err) {
    record.sheet_status = 'failed';
    console.error('p100: sheet append failed', err && err.message);
  }

  // 4. Update the backup with how it went (best effort). Any record with
  //    sheet_status "failed" still needs to be copied into the Sheet.
  if (store) {
    try { await store.setJSON(id, record); } catch (err) { console.error('p100: blob update failed', err && err.message); }
  }

  if (!blobOk && !sheetOk) {
    return json(500, { error: 'save_failed' });
  }
  console.log(`p100: nomination ${id} saved (blob:${blobOk} sheet:${sheetOk} beehiiv:${record.beehiiv_status})`);
  return json(200, { ok: true, id });
};

// Exposed for local tests only.
exports._test = { validateNomination, normalizeUrl, defang, closesAt };

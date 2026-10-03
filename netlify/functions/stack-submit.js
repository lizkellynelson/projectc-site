// stack-submit.js — Netlify serverless function
// ----------------------------------------------------
// Powers the Project C Stack survey (stack-survey.html).
//
// How it works (same pattern as directory-submit.js):
//   1. Check the submitted email against `memberships` (status = 'active').
//      Membership is the only credential. No password, no token.
//   2. Upsert one row per member into `stack_survey`, keyed by lower(email).
//      Submitting again overwrites the same row, so members can update
//      their stack whenever they switch tools.
//   3. Free-text answers are stored as typed. The public Stack page will
//      only ever show aggregate counts, plus names next to picks when the
//      member checked "show my name" (show_name = true).
//
// Env vars required (already exist for the other community functions):
//   SUPABASE_COMMUNITY_URL
//   SUPABASE_COMMUNITY_SECRET_KEY

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_COMMUNITY_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_COMMUNITY_SECRET_KEY;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Kept in sync by hand with STACK in stack-survey.html. Only these category
// keys are accepted. Tool names inside a category are NOT restricted to the
// checkbox list, because the page lets people add their own ("Add a tool"),
// and those write-ins are exactly what we want to learn about.
const CATEGORY_KEYS = [
  'home', 'audience', 'website', 'payments', 'sponsors', 'production',
  'design', 'writing', 'ai', 'social', 'analytics', 'money', 'organized',
];
const FORMAT_OPTIONS = [
  'Newsletter', 'Video', 'Podcast', 'Social-first posts', 'Website or blog',
  'Live streams', 'Events', 'Something else',
];
const SPEND_OPTIONS = [
  'Under $25', '$25 to $100', '$100 to $250', '$250 to $500', 'More than $500', 'Not sure',
];

const MAX_TOOLS_PER_CATEGORY = 30;
const MAX_TOOL_NAME = 80;

// —— Rate limiting ——
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 8;

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimits.get(ip);
  if (!record || now - record.windowStart > RATE_LIMIT_WINDOW) {
    rateLimits.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  if (record.count >= RATE_LIMIT_MAX) return false;
  record.count++;
  return true;
}

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length < 254;
}

function cleanString(s, maxLen) {
  if (typeof s !== 'string') return '';
  return s.trim().slice(0, maxLen);
}

function cleanTools(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of CATEGORY_KEYS) {
    const list = raw[key];
    if (!Array.isArray(list)) continue;
    const seen = new Set();
    const cleaned = [];
    for (const item of list) {
      const name = cleanString(item, MAX_TOOL_NAME);
      if (!name) continue;
      const k = name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      cleaned.push(name);
      if (cleaned.length >= MAX_TOOLS_PER_CATEGORY) break;
    }
    if (cleaned.length) out[key] = cleaned;
  }
  return out;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error('stack-submit: missing SUPABASE_COMMUNITY_URL / SUPABASE_COMMUNITY_SECRET_KEY');
    return json(500, { error: 'The survey is not fully configured yet. Please try again later.' });
  }

  const clientIp = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
  if (!checkRateLimit(clientIp)) {
    return json(429, { error: 'Too many submissions from this address. Please wait a bit and try again.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (_) {
    return json(400, { error: 'Could not read form data.' });
  }

  const email = cleanString(payload.email, 254).toLowerCase();
  const displayName = cleanString(payload.displayName, 200);
  const brandName = cleanString(payload.brandName, 200) || null;
  const formats = Array.isArray(payload.formats)
    ? [...new Set(payload.formats.map((f) => cleanString(f, 60)))].filter((f) => FORMAT_OPTIONS.includes(f))
    : [];
  const tools = cleanTools(payload.tools);
  const gear = cleanString(payload.gear, 1000) || null;
  const cantLiveWithout = cleanString(payload.cantLiveWithout, 1000) || null;
  const regret = cleanString(payload.regret, 1000) || null;
  const monthlySpend = SPEND_OPTIONS.includes(payload.monthlySpend) ? payload.monthlySpend : null;
  const showName = payload.showName === true;
  const spotlight = payload.spotlight === true;

  if (!isValidEmail(email)) return json(400, { error: 'Please enter a valid email address.' });
  if (!displayName) return json(400, { error: 'Please enter your name.' });
  if (Object.keys(tools).length === 0) {
    return json(400, { error: 'Check at least one tool you use so your answers count.' });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

    const { data: membership, error: membershipErr } = await supabase
      .from('memberships')
      .select('id, status')
      .ilike('email', email)
      .eq('status', 'active')
      .limit(1);

    if (membershipErr) {
      console.error('stack-submit membership lookup error:', membershipErr);
      return json(500, { error: 'Could not check your membership right now. Please try again in a moment.' });
    }
    if (!membership || membership.length === 0) {
      return json(200, {
        ok: false,
        reason: 'not_found',
        error:
          "We couldn't find an active Project C membership for that email. Try the address you joined with, or email liz@projectc.com and we'll sort it out.",
      });
    }

    const row = {
      membership_id: membership[0].id,
      email,
      display_name: displayName,
      brand_name: brandName,
      formats,
      tools,
      gear,
      cant_live_without: cantLiveWithout,
      regret,
      monthly_spend: monthlySpend,
      show_name: showName,
      spotlight,
    };

    const { error: upsertErr } = await supabase.from('stack_survey').upsert(row, { onConflict: 'email' });
    if (upsertErr) {
      console.error('stack-submit upsert error:', upsertErr);
      return json(500, { error: "We couldn't save your answers just now. Please try again in a moment." });
    }

    return json(200, { ok: true });
  } catch (err) {
    console.error('stack-submit error:', err);
    return json(500, { error: 'Something went wrong. Please try again in a moment.' });
  }
};

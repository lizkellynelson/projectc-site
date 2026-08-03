// directory-lookup.js — Netlify serverless function
// --------------------------------------------------
// Fixes the "editing means starting over blank" complaint: directory-submit.html
// is a single reusable form with no login, so returning to it never knew who
// you were or what you'd already submitted. This endpoint lets the page look
// up an existing listing by email BEFORE the member starts typing, so it can
// pre-fill the form instead of handing back a blank page.
//
// Same trust model as directory-submit.js: the email has to match an active
// Project C membership before anything is returned, so this can't be used to
// fish for arbitrary members' data. Called via POST (email in the body, not
// a query string) to keep the address out of server/proxy logs.
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

// Looser than directory-submit's limit since this fires once per email blur
// while someone's just filling out the form, not once per full submission.
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 20;

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

// Only what the form needs to re-populate itself. No membership_id, no
// status, no agreement_accepted_at — this isn't an admin view.
const ENTRY_COLUMNS = [
  'display_name',
  'brand_name',
  'blurb',
  'topics',
  'photo_url',
  'website_url',
  'instagram_url',
  'tiktok_url',
  'youtube_url',
  'x_url',
  'linkedin_url',
  'substack_url',
  'other_label',
  'other_url',
].join(', ');

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
    console.error('directory-lookup: missing SUPABASE_COMMUNITY_URL / SUPABASE_COMMUNITY_SECRET_KEY');
    return json(500, { error: 'Lookup is not available right now.' });
  }

  const clientIp =
    event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
  if (!checkRateLimit(clientIp)) {
    return json(429, { error: 'Too many lookups from this address. Please wait a bit and try again.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (_) {
    return json(400, { error: 'Could not read request.' });
  }

  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!isValidEmail(email)) {
    return json(400, { error: 'Please enter a valid email address.' });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { persistSession: false },
    });

    // Same gate as directory-submit.js: active membership required before
    // anything is looked up or returned.
    const { data: membership, error: membershipErr } = await supabase
      .from('memberships')
      .select('id')
      .ilike('email', email)
      .eq('status', 'active')
      .limit(1);

    if (membershipErr) {
      console.error('directory-lookup membership lookup error:', membershipErr);
      return json(500, { error: 'Could not check your membership right now.' });
    }
    if (!membership || membership.length === 0) {
      return json(200, {
        ok: true,
        member: false,
        error:
          "We couldn't find an active Project C membership for that email. Try the address you joined with, or email liz@projectc.biz and we'll sort it out.",
      });
    }

    const { data: entry, error: entryErr } = await supabase
      .from('member_directory')
      .select(ENTRY_COLUMNS)
      .eq('email', email)
      .limit(1);

    if (entryErr) {
      console.error('directory-lookup entry lookup error:', entryErr);
      return json(500, { error: 'Could not load your existing listing right now.' });
    }

    if (entry && entry.length > 0) {
      return json(200, { ok: true, member: true, found: true, entry: entry[0] });
    }
    return json(200, { ok: true, member: true, found: false });
  } catch (err) {
    console.error('directory-lookup error:', err);
    return json(500, { error: 'Something went wrong. Please try again in a moment.' });
  }
};

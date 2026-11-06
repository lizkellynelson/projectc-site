// event-signup.js — Netlify serverless function
// -------------------------------------------------------
// "Be the first to know" email lists for event pages.
// First use: projectc.com/covering-washington (event slug below).
//
// Saves one row per person per event in the Supabase table
// public.event_signups (projectc-community project). Signing up twice
// is harmless: the second time is treated as a success and changes nothing.
//
// Spam guards: a hidden honeypot field, a 2-second minimum fill time and
// a small per-instance rate limit. Unknown event slugs are rejected so the
// endpoint can't be used to fill the table with junk lists.
//
// Env vars (already set for the community backend):
//   SUPABASE_COMMUNITY_URL, SUPABASE_COMMUNITY_SECRET_KEY
//
// To pull the list: Supabase → Table editor → event_signups,
// filter event = covering-washington-2027, export CSV.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_COMMUNITY_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_COMMUNITY_SECRET_KEY;

// Add a slug here to open a list for a new event page.
const EVENTS = new Set(['covering-washington-2027']);
const MIN_FILL_MS = 2000;

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

function isValidEmail(s) {
  return typeof s === 'string' && s.length < 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function clip(v, n = 120) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null;
}

// Per warm instance: a speed bump, not a wall.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 8;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error('event-signup: Supabase env vars not set');
    return json(500, { error: 'Signups are not working right now. Please email info@projectc.com.' });
  }

  let p;
  try { p = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request.' }); }

  // Honeypot or too-fast submit: pretend it worked, save nothing.
  if (p.website || (Number(p.elapsed) > 0 && Number(p.elapsed) < MIN_FILL_MS)) return json(200, { ok: true });

  const ip = event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'unknown';
  if (rateLimited(ip)) return json(429, { error: 'Too many tries. Give it a few minutes and try again.' });

  const slug = clip(p.event, 80);
  if (!slug || !EVENTS.has(slug)) return json(400, { error: 'Unknown event.' });

  const email = (p.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) return json(400, { error: 'Please enter a valid email address.' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
  const { error } = await supabase.from('event_signups').upsert(
    {
      event: slug,
      email,
      source: clip(p.source, 200),
      utm_source: clip(p.utm_source),
      utm_medium: clip(p.utm_medium),
      utm_campaign: clip(p.utm_campaign),
    },
    { onConflict: 'event,email', ignoreDuplicates: true }
  );

  if (error) {
    console.error('event-signup: insert failed', error);
    return json(500, { error: 'Something went wrong. Please try again or email info@projectc.com.' });
  }

  console.log(`event-signup: ${slug} signup saved`);
  return json(200, { ok: true });
};

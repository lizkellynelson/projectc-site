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
// Newsletter opt-in (Nov 2026): if the person ticks "Also send me the Project C
// newsletter", they're added to beehiiv the same way the P100 form does it:
// look up first, never reactivate someone who unsubscribed, and a beehiiv
// failure never fails the signup. The result is saved in newsletter_status.
// Env: BEEHIIV_API_KEY (already set).
//
// To pull the list: Supabase → Table editor → event_signups,
// filter event = covering-washington-2027, export CSV.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_COMMUNITY_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_COMMUNITY_SECRET_KEY;

// Add a slug here to open a list for a new event page.
const EVENTS = new Set(['covering-washington-2027']);
const MIN_FILL_MS = 2000;

const PUBLICATION_ID = 'pub_e067ba51-b52d-4f16-9459-58681134dfb6';
const BEEHIIV_BASE = 'https://api.beehiiv.com/v2';

// Returns one of: subscribed, already_subscribed, previously_unsubscribed, failed
async function addToBeehiiv(email, slug, t) {
  const key = process.env.BEEHIIV_API_KEY;
  if (!key) { console.error('event-signup: BEEHIIV_API_KEY not set'); return 'failed'; }
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const base = `${BEEHIIV_BASE}/publications/${PUBLICATION_ID}/subscriptions`;
  try {
    const look = await fetch(`${base}/by_email/${encodeURIComponent(email)}`, { headers, signal: AbortSignal.timeout(5000) });
    if (look.ok) {
      const d = await look.json().catch(() => ({}));
      const status = d && d.data && d.data.status;
      if (status === 'inactive') return 'previously_unsubscribed';
      if (status) return 'already_subscribed';
    } else if (look.status !== 404) {
      console.warn('event-signup: beehiiv lookup returned', look.status);
    }
    const res = await fetch(base, {
      method: 'POST', headers, signal: AbortSignal.timeout(6000),
      body: JSON.stringify({
        email,
        reactivate_existing: false,
        send_welcome_email: true,
        utm_source: t.utm_source || 'projectc.com',
        utm_medium: t.utm_medium || 'website',
        utm_campaign: t.utm_campaign || slug,
        utm_content: 'event-updates-optin',
        referring_site: 'projectc.com/' + slug.replace(/-\d{4}$/, ''),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('event-signup: beehiiv create failed', res.status, body.slice(0, 300));
      return 'failed';
    }
    const d = await res.json().catch(() => ({}));
    if (d && d.data && d.data.status === 'inactive') return 'previously_unsubscribed';
    return 'subscribed';
  } catch (err) {
    console.error('event-signup: beehiiv error', err && err.message);
    return 'failed';
  }
}

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
    return json(500, { error: 'Signups are not working right now. Please email coveringwashington@projectc.com.' });
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
    return json(500, { error: 'Something went wrong. Please try again or email coveringwashington@projectc.com.' });
  }

  const wantsNewsletter = p.newsletter === true || p.newsletter === 'yes';
  if (wantsNewsletter) {
    const status = await addToBeehiiv(email, slug, {
      utm_source: clip(p.utm_source), utm_medium: clip(p.utm_medium), utm_campaign: clip(p.utm_campaign),
    });
    const { error: upErr } = await supabase.from('event_signups')
      .update({ newsletter_opt_in: true, newsletter_status: status })
      .eq('event', slug).eq('email', email);
    if (upErr) console.error('event-signup: newsletter flag update failed', upErr.message);
    console.log(`event-signup: ${slug} newsletter opt-in -> ${status}`);
  }

  console.log(`event-signup: ${slug} signup saved`);
  return json(200, { ok: true });
};

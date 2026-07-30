// directory-list.js — Netlify serverless function
// --------------------------------------------------
// Public read endpoint for the Member Directory (directory.html). No auth —
// anyone can call this, same as any other public page data. Returns every
// published row from `member_directory` as JSON; the page does the search
// and topic filtering client-side (245-ish rows is nothing to filter in the
// browser, and it keeps the interaction instant with no round trip per
// keystroke).
//
// Cached in memory for 5 minutes per warm function instance, same pattern
// members-auth.js uses for the Luma events feed, so a burst of page views
// doesn't hammer Supabase.
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
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { at: 0, data: null };

// Only the fields the public page actually renders — email and
// membership_id never leave this function.
const PUBLIC_COLUMNS = [
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
  'updated_at',
].join(', ');

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error('directory-list: missing SUPABASE_COMMUNITY_URL / SUPABASE_COMMUNITY_SECRET_KEY');
    return json(500, { error: 'The directory is not fully configured yet.' });
  }

  const now = Date.now();
  if (cache.data && now - cache.at < CACHE_TTL_MS) {
    return json(200, { ok: true, members: cache.data, cached: true });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { persistSession: false },
    });

    const { data, error } = await supabase
      .from('member_directory')
      .select(PUBLIC_COLUMNS)
      .eq('status', 'published');

    if (error) {
      console.error('directory-list supabase error:', error);
      return json(500, { error: 'Could not load the directory right now.' });
    }

    // Alphabetical by last name, matching the convention set on the
    // Muslim Creator Showcase page and the Atlas creator-card sort order.
    const sorted = (data || []).slice().sort((a, b) => {
      const lastName = (n) => (n || '').trim().split(/\s+/).slice(-1)[0].toLowerCase();
      return lastName(a.display_name).localeCompare(lastName(b.display_name));
    });

    cache = { at: now, data: sorted };
    return json(200, { ok: true, members: sorted, cached: false });
  } catch (err) {
    console.error('directory-list error:', err);
    return json(500, { error: 'Could not load the directory right now.' });
  }
};

// directory-submit.js — Netlify serverless function
// ----------------------------------------------------
// Powers the self-serve submission form (directory-submit.html) for the
// public Member Directory (directory.html).
//
// How it works:
//   1. Take the submitted email, check it against `memberships` (status =
//      'active') — the exact same check members-auth.js does for login.
//      This is the only gate: no password, no token, membership itself is
//      the credential (matches the pattern Liz already approved for the
//      Replay Room).
//   2. If the email matches an active member, upsert their listing into
//      `member_directory`, keyed by lower(email). Submitting again (to fix
//      a typo, swap a link, update a blurb) just overwrites the same row.
//   3. New rows default to status = 'published' — they show up on the
//      public directory immediately. If something inappropriate ever comes
//      through, Liz can flip that one row to 'hidden' directly in the
//      Supabase table editor, no deploy needed.
//
// Env vars required (already exist for the other community functions):
//   SUPABASE_COMMUNITY_URL
//   SUPABASE_COMMUNITY_SECRET_KEY

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_COMMUNITY_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_COMMUNITY_SECRET_KEY;

const PHOTO_BUCKET = 'directory-photos';
const MAX_PHOTO_BYTES = 4 * 1024 * 1024; // 4MB decoded — directory-submit.html resizes client-side well under this
const ALLOWED_PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Kept in sync by hand with the checkbox list in directory-submit.html.
// Free-form topic tags are intentionally not allowed — a fixed list keeps
// the filter chips on the public page meaningful instead of turning into
// 245 slightly-different phrasings of the same handful of beats.
const TOPIC_OPTIONS = [
  'Politics & Policy',
  'Culture & Identity',
  'Local News',
  'Business & Money',
  'Food & Lifestyle',
  'Health & Wellness',
  'Sports',
  'Climate & Environment',
  'Media & Trust',
  'Immigration',
  'LGBTQ+',
  'Parenting & Family',
  'Entertainment & TV',
  'International',
];

// —— Rate limiting (anti-spam / anti-typo-loop) ——
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX = 8; // generous — a member fixing a typo a few times shouldn't get blocked

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

// Only accept http(s) URLs; anything else (javascript:, mailto:, garbage
// text typed into a link field) is dropped rather than saved.
function cleanUrl(s, maxLen) {
  const val = cleanString(s, maxLen);
  if (!val) return null;
  try {
    const u = new URL(val);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch (_) {
    return null;
  }
}

function cleanTopics(raw) {
  if (!Array.isArray(raw)) return [];
  const deduped = [...new Set(raw.map((t) => cleanString(t, 60)))].filter((t) =>
    TOPIC_OPTIONS.includes(t)
  );
  return deduped.slice(0, 3);
}

// Parses the data URL directory-submit.html sends (it always resizes and
// re-encodes as JPEG client-side before upload, but this is validated
// server-side too rather than trusted blindly). Returns { buffer, ext,
// contentType } or null if the input is missing/malformed/too big/wrong type.
function parsePhotoDataUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(raw);
  if (!match) return null;
  const contentType = match[1].toLowerCase();
  const ext = ALLOWED_PHOTO_TYPES[contentType];
  if (!ext) return null;
  let buffer;
  try {
    buffer = Buffer.from(match[2], 'base64');
  } catch (_) {
    return null;
  }
  if (buffer.length === 0 || buffer.length > MAX_PHOTO_BYTES) return null;
  return { buffer, ext, contentType };
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
    console.error('directory-submit: missing SUPABASE_COMMUNITY_URL / SUPABASE_COMMUNITY_SECRET_KEY');
    return json(500, { error: 'The directory form is not fully configured yet. Please try again later.' });
  }

  const clientIp =
    event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
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
  const blurb = cleanString(payload.blurb, 400);
  const topics = cleanTopics(payload.topics);

  const websiteUrl = cleanUrl(payload.website, 500);
  const instagramUrl = cleanUrl(payload.instagram, 500);
  const tiktokUrl = cleanUrl(payload.tiktok, 500);
  const youtubeUrl = cleanUrl(payload.youtube, 500);
  const xUrl = cleanUrl(payload.x, 500);
  const linkedinUrl = cleanUrl(payload.linkedin, 500);
  const substackUrl = cleanUrl(payload.substack, 500);
  const otherLabel = cleanString(payload.otherLabel, 60) || null;
  const otherUrl = cleanUrl(payload.otherUrl, 500);
  const agreement = payload.agreement === true;
  const photo = parsePhotoDataUrl(payload.photoDataUrl);
  // photoDataUrl being present-but-unparseable (wrong type, too big, corrupt)
  // is treated as a validation error rather than silently dropped, so the
  // member finds out immediately instead of getting a listing with no photo
  // and no explanation.
  const photoProvided = typeof payload.photoDataUrl === 'string' && payload.photoDataUrl.length > 0;

  if (!isValidEmail(email)) {
    return json(400, { error: 'Please enter a valid email address.' });
  }
  if (!displayName) {
    return json(400, { error: 'Please enter your name.' });
  }
  if (!blurb) {
    return json(400, { error: 'Please add a short blurb about your work.' });
  }
  const hasAnyLink =
    websiteUrl || instagramUrl || tiktokUrl || youtubeUrl || xUrl || linkedinUrl || substackUrl || (otherLabel && otherUrl);
  if (!hasAnyLink) {
    return json(400, { error: 'Please add at least one link so readers can follow your work.' });
  }
  if (!agreement) {
    return json(400, { error: 'Please check the box agreeing this can be used on the website and in marketing materials.' });
  }
  if (photoProvided && !photo) {
    return json(400, { error: "That photo didn't come through right. Try a smaller JPEG or PNG, or leave it blank." });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { persistSession: false },
    });

    // Same membership check as members-auth.js: active status only. This is
    // the entire gate — no separate login step for this form.
    const { data: membership, error: membershipErr } = await supabase
      .from('memberships')
      .select('id, name, email, status')
      .ilike('email', email)
      .eq('status', 'active')
      .limit(1);

    if (membershipErr) {
      console.error('directory-submit membership lookup error:', membershipErr);
      return json(500, { error: 'Could not check your membership right now. Please try again in a moment.' });
    }
    if (!membership || membership.length === 0) {
      return json(200, {
        ok: false,
        reason: 'not_found',
        error:
          "We couldn't find an active Project C membership for that email. Try the address you joined with, or email liz@projectc.biz and we'll sort it out.",
      });
    }

    // Upload the photo (if any) before writing the row, so a storage hiccup
    // never leaves a row pointing at a photo that doesn't exist. Path is
    // keyed by membership id, and upsert:true means resubmitting with a new
    // photo simply overwrites the old file at the same path.
    let photoUrl;
    if (photo) {
      const path = `${membership[0].id}.${photo.ext}`;
      const { error: uploadErr } = await supabase.storage
        .from(PHOTO_BUCKET)
        .upload(path, photo.buffer, { contentType: photo.contentType, upsert: true });

      if (uploadErr) {
        console.error('directory-submit photo upload error:', uploadErr);
        return json(500, { error: "We couldn't save your photo just now. Please try again, or submit without one for now." });
      }
      const { data: pub } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path);
      photoUrl = pub && pub.publicUrl ? pub.publicUrl : null;
    }

    const row = {
      membership_id: membership[0].id,
      email,
      display_name: displayName,
      brand_name: brandName,
      blurb,
      topics,
      website_url: websiteUrl,
      instagram_url: instagramUrl,
      tiktok_url: tiktokUrl,
      youtube_url: youtubeUrl,
      x_url: xUrl,
      linkedin_url: linkedinUrl,
      substack_url: substackUrl,
      other_label: otherLabel,
      other_url: otherUrl,
      status: 'published',
      agreement_accepted_at: new Date().toISOString(),
    };
    // Only touch photo_url if a new photo came in this submission — an
    // explicit `undefined` key is dropped by JS object literals, so a
    // member updating just their blurb (no new photo) keeps whatever photo
    // is already on file instead of it being wiped out.
    if (photoUrl !== undefined) row.photo_url = photoUrl;

    const { error: upsertErr } = await supabase
      .from('member_directory')
      .upsert(row, { onConflict: 'email' });

    if (upsertErr) {
      console.error('directory-submit upsert error:', upsertErr);
      return json(500, { error: "We couldn't save your listing just now. Please try again in a moment." });
    }

    return json(200, { ok: true });
  } catch (err) {
    console.error('directory-submit error:', err);
    return json(500, { error: 'Something went wrong. Please try again in a moment.' });
  }
};

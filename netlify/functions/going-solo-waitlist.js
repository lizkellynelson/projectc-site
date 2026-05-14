// going-solo-waitlist.js — Netlify serverless function
// -------------------------------------------------------
// Accepts a waitlist signup from the Going Solo page,
// subscribes the person to the Project C Beehiiv publication,
// and adds them to the "Going Solo Waitlist" manual segment
// (seg_576fbaa7-2414-4e79-bcee-6388a0a783f0).
//
// Required env vars:
//   BEEHIIV_API_KEY   — API key from beehiiv Settings → API
//
// Hardcoded constants (no reason to make these env vars):
//   PUBLICATION_ID    — pub_e067ba51-b52d-4f16-9459-58681134dfb6
//   SEGMENT_ID        — seg_576fbaa7-2414-4e79-bcee-6388a0a783f0

const PUBLICATION_ID = 'pub_e067ba51-b52d-4f16-9459-58681134dfb6';
const SEGMENT_ID     = 'seg_576fbaa7-2414-4e79-bcee-6388a0a783f0';
const BEEHIIV_BASE   = 'https://api.beehiiv.com/v2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length < 254;
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const apiKey = process.env.BEEHIIV_API_KEY;
  if (!apiKey) {
    console.error('going-solo-waitlist: BEEHIIV_API_KEY not set');
    return jsonResponse(500, { error: 'Waitlist is not configured. Please email info@projectc.biz.' });
  }

  // Parse body
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid request.' });
  }

  const email = (payload.email || '').trim().toLowerCase();
  const name  = (payload.name  || '').trim().slice(0, 200);

  if (!isValidEmail(email)) {
    return jsonResponse(400, { error: 'Please enter a valid email address.' });
  }

  const authHeader = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  // ── Step 1: Create or update the Beehiiv subscription ──
  let subscriptionId;
  try {
    const subBody = {
      email,
      reactivate_existing: true,
      send_welcome_email: false,
      utm_source: 'going-solo-waitlist',
      utm_medium: 'website',
      utm_campaign: 'going-solo-page',
    };

    // Beehiiv doesn't have a top-level "name" field on subscriptions,
    // but we can pass it as a custom field if one is set up, or just
    // skip it — the segment email to them will come from Liz manually.
    const subRes = await fetch(
      `${BEEHIIV_BASE}/publications/${PUBLICATION_ID}/subscriptions`,
      { method: 'POST', headers: authHeader, body: JSON.stringify(subBody) }
    );

    const subData = await subRes.json();

    if (!subRes.ok) {
      console.error('Beehiiv subscription error:', subRes.status, subData);
      return jsonResponse(500, { error: 'Something went wrong — please try again or email info@projectc.biz.' });
    }

    subscriptionId = subData?.data?.id;
    console.log(`going-solo-waitlist: subscribed ${email} → ${subscriptionId}`);
  } catch (err) {
    console.error('Beehiiv subscription fetch error:', err);
    return jsonResponse(500, { error: 'Something went wrong — please try again or email info@projectc.biz.' });
  }

  // ── Step 2: Add to the Going Solo Waitlist segment ──
  // Manual segments in Beehiiv accept a list of subscription IDs.
  // If the subscription already existed, they may already be in the
  // segment — this call is idempotent so it's safe to repeat.
  if (subscriptionId) {
    try {
      const segRes = await fetch(
        `${BEEHIIV_BASE}/publications/${PUBLICATION_ID}/segments/${SEGMENT_ID}/subscriptions`,
        {
          method: 'POST',
          headers: authHeader,
          body: JSON.stringify({ subscription_ids: [subscriptionId] }),
        }
      );

      if (!segRes.ok) {
        // Log but don't fail — the subscription itself succeeded,
        // so the person is in Beehiiv and tagged via UTM. Liz can
        // add them to the segment manually if needed.
        const segData = await segRes.json().catch(() => ({}));
        console.warn('going-solo-waitlist: segment add failed (non-fatal):', segRes.status, segData);
      } else {
        console.log(`going-solo-waitlist: added ${subscriptionId} to Going Solo Waitlist segment`);
      }
    } catch (err) {
      console.warn('going-solo-waitlist: segment fetch error (non-fatal):', err);
    }
  }

  return jsonResponse(200, { ok: true });
};

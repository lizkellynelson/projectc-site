// coaching-waitlist.js — Netlify serverless function
// -------------------------------------------------------
// Accepts a waitlist signup from the Coaching page (Nov 2026: Blair paused
// new coaching clients until January 2027).
//
// What it does:
//   1. Subscribes the person to the Project C beehiiv publication
//      (no welcome email, UTM-tagged as coaching-waitlist).
//   2. Applies the "coaching waitlist" subscriber tag, which feeds the
//      dynamic "Coaching Waitlist" segment
//      (seg_95e716af-61f4-450c-9387-230ffc94cca2).
//   3. Emails Blair and Liz a heads-up with the person's name, email and
//      what they said they're working on.
//
// Required env vars (both already set on Netlify for other functions):
//   BEEHIIV_API_KEY
//   RESEND_API_KEY
//
// Steps 2 and 3 are non-fatal: if either fails, the signup still counts
// because the person is in beehiiv with utm_source=coaching-waitlist.

const PUBLICATION_ID = 'pub_e067ba51-b52d-4f16-9459-58681134dfb6';
const WAITLIST_TAG   = 'coaching waitlist';
const BEEHIIV_BASE   = 'https://api.beehiiv.com/v2';

const NOTIFY_TO  = ['blair@idamedia.co', 'liz@projectc.com'];
const FROM_EMAIL = 'Project C <community@projectc.biz>';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const FRIENDLY_ERROR = 'Something went wrong. Please try again or email info@projectc.com.';

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const apiKey = process.env.BEEHIIV_API_KEY;
  if (!apiKey) {
    console.error('coaching-waitlist: BEEHIIV_API_KEY not set');
    return jsonResponse(500, { error: 'The waitlist is not configured yet. Please email info@projectc.com.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid request.' });
  }

  // Honeypot: real people never fill the hidden "website" field.
  if (payload.website) {
    return jsonResponse(200, { ok: true });
  }

  const email = (payload.email || '').trim().toLowerCase();
  const name  = (payload.name  || '').trim().slice(0, 200);
  const note  = (payload.note  || '').trim().slice(0, 1500);

  if (!isValidEmail(email)) {
    return jsonResponse(400, { error: 'Please enter a valid email address.' });
  }

  const authHeader = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  // ── Step 1: create or reactivate the beehiiv subscription ──
  let subscriptionId;
  try {
    const subRes = await fetch(`${BEEHIIV_BASE}/publications/${PUBLICATION_ID}/subscriptions`, {
      method: 'POST',
      headers: authHeader,
      body: JSON.stringify({
        email,
        reactivate_existing: true,
        send_welcome_email: false,
        utm_source: 'coaching-waitlist',
        utm_medium: 'website',
        utm_campaign: 'coaching-page',
      }),
    });
    const subData = await subRes.json().catch(() => ({}));
    if (!subRes.ok) {
      console.error('coaching-waitlist: beehiiv subscription error', subRes.status, subData);
      return jsonResponse(500, { error: FRIENDLY_ERROR });
    }
    subscriptionId = subData?.data?.id;
    console.log(`coaching-waitlist: subscribed ${email} -> ${subscriptionId}`);
  } catch (err) {
    console.error('coaching-waitlist: beehiiv subscription fetch error', err);
    return jsonResponse(500, { error: FRIENDLY_ERROR });
  }

  // ── Step 2: tag them so they land in the Coaching Waitlist segment ──
  if (subscriptionId) {
    try {
      const tagRes = await fetch(
        `${BEEHIIV_BASE}/publications/${PUBLICATION_ID}/subscriptions/${subscriptionId}/tags`,
        { method: 'POST', headers: authHeader, body: JSON.stringify({ tags: [WAITLIST_TAG] }) }
      );
      if (!tagRes.ok) {
        const tagData = await tagRes.json().catch(() => ({}));
        console.warn('coaching-waitlist: tag add failed (non-fatal)', tagRes.status, tagData);
      }
    } catch (err) {
      console.warn('coaching-waitlist: tag fetch error (non-fatal)', err);
    }
  }

  // ── Step 3: give Blair and Liz a heads-up ──
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    const who = name || email;
    const text = [
      `${who} just joined the coaching waitlist on projectc.com/coaching.`,
      '',
      `Name: ${name || '(not given)'}`,
      `Email: ${email}`,
      `What they're working on: ${note || '(not given)'}`,
      '',
      'They are tagged "coaching waitlist" in beehiiv and show up in the Coaching Waitlist segment.',
    ].join('\n');
    const html = `<p><strong>${escapeHtml(who)}</strong> just joined the coaching waitlist on projectc.com/coaching.</p>
<p><strong>Name:</strong> ${escapeHtml(name || '(not given)')}<br>
<strong>Email:</strong> <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>
<p><strong>What they're working on:</strong><br>${escapeHtml(note || '(not given)').replace(/\n/g, '<br>')}</p>
<p style="color:#666;font-size:13px;">They're tagged "coaching waitlist" in beehiiv and show up in the Coaching Waitlist segment.</p>`;
    try {
      const mailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: NOTIFY_TO,
          reply_to: email,
          subject: `Coaching waitlist: ${who}`,
          text,
          html,
        }),
      });
      if (!mailRes.ok) {
        const mailData = await mailRes.json().catch(() => ({}));
        console.warn('coaching-waitlist: notify email failed (non-fatal)', mailRes.status, mailData);
      }
    } catch (err) {
      console.warn('coaching-waitlist: notify email error (non-fatal)', err);
    }
  }

  return jsonResponse(200, { ok: true });
};

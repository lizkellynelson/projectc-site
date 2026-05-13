// community-setup-intent.js — Netlify serverless function
// ---------------------------------------------------------
// Called when the /community page loads. Creates a Stripe SetupIntent that
// the browser uses to securely vault a card without charging it. The
// returned client_secret is handed to Stripe Elements in the browser so the
// applicant can enter their card details directly with Stripe (PCI scope
// never touches our server). When the form is finally submitted, we take
// the resulting setup_intent_id and attach the card to a freshly-created
// Stripe customer in community-submit.js.

const Stripe = require('stripe');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// —— Simple in-memory rate limit (resets on cold start) ——
// Cheap spam protection: one applicant shouldn't need more than a handful
// of setup intents while filling out the form.
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
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

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  // Accept GET or POST — GET for simple page-load calls, POST if we ever
  // want to pass intent metadata from the browser.
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  if (!STRIPE_SECRET_KEY || !STRIPE_PUBLISHABLE_KEY) {
    console.error('community-setup-intent: missing Stripe env vars');
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Payments are not configured yet.' }),
    };
  }

  const clientIp =
    event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
  if (!checkRateLimit(clientIp)) {
    return {
      statusCode: 429,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Too many requests. Please slow down.' }),
    };
  }

  try {
    const stripe = Stripe(STRIPE_SECRET_KEY);

    // We create the SetupIntent without a customer attached. The customer
    // gets created in community-submit.js after we know who is applying
    // (name + email). At that point we attach the saved payment_method to
    // the new customer and set it as the default.
    const setupIntent = await stripe.setupIntents.create({
      payment_method_types: ['card'],
      usage: 'off_session',
      metadata: {
        source: 'community_application',
      },
    });

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientSecret: setupIntent.client_secret,
        publishableKey: STRIPE_PUBLISHABLE_KEY,
        setupIntentId: setupIntent.id,
      }),
    };
  } catch (err) {
    console.error('community-setup-intent error:', err);
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Could not prepare the payment form. Please try again in a moment.',
      }),
    };
  }
};

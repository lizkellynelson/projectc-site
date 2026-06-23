// community-validate-promo.js — Netlify serverless function
// ---------------------------------------------------------
// Looks up a typed promo code against Stripe in real time and reports
// whether it's valid, plus a short human-readable summary of the discount
// ("3 months free", "20% off for 3 months", "Free forever").
//
// This is used for two things:
//   1. Live feedback on the /community form as the applicant types, so they
//      see a green "✓ applied" or a red "not valid" before they submit.
//   2. (Indirectly) it documents the exact same lookup logic that
//      community-submit.js re-runs server-side at submission, so we never
//      trust the browser — the code is always re-validated before it's saved.
//
// Design note: we intentionally do NOT keep a hardcoded list of codes.
// Every code lives in Stripe. Whatever active promotion codes exist in the
// Project C Stripe account will validate here automatically — no code
// change needed when Liz adds or retires a promo.

const Stripe = require('stripe');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// —— Simple in-memory rate limit (resets on cold start) ——
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 30;

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

// —— Money formatting for amount-off coupons ——
function formatAmount(amountOff, currency) {
  const value = (amountOff || 0) / 100;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: (currency || 'usd').toUpperCase(),
    }).format(value);
  } catch (_) {
    return `$${value.toFixed(2)}`;
  }
}

// —— Turn a Stripe coupon into plain English ——
// Handles the two coupon shapes Project C uses (percent_off and amount_off)
// across all three Stripe durations (once / repeating / forever), and
// renders the "100% off" cases as the friendlier "free".
function describeCoupon(coupon) {
  if (!coupon) return 'Discount';

  const isFull =
    coupon.percent_off === 100 || coupon.percent_off === 100.0;

  let magnitude;
  if (coupon.percent_off != null) {
    magnitude = isFull ? 'Free' : `${coupon.percent_off}% off`;
  } else if (coupon.amount_off != null) {
    magnitude = `${formatAmount(coupon.amount_off, coupon.currency)} off`;
  } else {
    magnitude = 'Discount';
  }

  let window = '';
  if (coupon.duration === 'forever') {
    window = ' forever';
  } else if (coupon.duration === 'once') {
    window = ' on your first payment';
  } else if (coupon.duration === 'repeating' && coupon.duration_in_months) {
    const m = coupon.duration_in_months;
    window = ` for ${m} month${m === 1 ? '' : 's'}`;
  }

  // "Free for 3 months" reads better as "3 months free"
  if (isFull && coupon.duration === 'repeating' && coupon.duration_in_months) {
    const m = coupon.duration_in_months;
    return `${m} month${m === 1 ? '' : 's'} free`;
  }
  if (isFull && coupon.duration === 'forever') {
    return 'Free forever';
  }

  return `${magnitude}${window}`;
}

// —— Shared lookup, reused (conceptually) by community-submit.js ——
// Returns { valid, promotionCodeId, code, summary, reason }.
async function lookupPromo(stripe, rawCode) {
  const code = String(rawCode || '').trim();
  if (!code) return { valid: false, reason: 'empty' };

  // Stripe's promotion `code` filter is case-sensitive, but customer-facing
  // codes are case-insensitive at redemption. Try the code as typed first,
  // then an uppercase fallback so "tca20forthree" and "TCA20FORTHREE" both
  // resolve to the same promotion code.
  const attempts = [code];
  const upper = code.toUpperCase();
  if (upper !== code) attempts.push(upper);

  for (const candidate of attempts) {
    const list = await stripe.promotionCodes.list({
      code: candidate,
      active: true,
      limit: 1,
    });
    const promo = list.data[0];
    if (!promo) continue;

    // Resolve the underlying coupon. Stripe has moved the coupon reference
    // around across API versions: it can be a top-level object, a top-level
    // id string, or nested under `promotion.coupon`. We avoid relying on
    // expand (which throws on versions where the field can't be expanded)
    // and just retrieve the coupon by id when we only have a reference.
    let coupon = null;
    if (promo.coupon && typeof promo.coupon === 'object') {
      coupon = promo.coupon;
    } else {
      const couponId =
        (typeof promo.coupon === 'string' && promo.coupon) ||
        (promo.promotion && promo.promotion.coupon) ||
        null;
      if (couponId) {
        coupon = await stripe.coupons.retrieve(couponId);
      }
    }

    // active:true already filters expired / exhausted promotion codes, but
    // double-check the underlying coupon is still redeemable.
    if (coupon && coupon.valid === false) {
      return { valid: false, reason: 'expired' };
    }

    return {
      valid: true,
      promotionCodeId: promo.id,
      code: promo.code,
      summary: describeCoupon(coupon),
    };
  }

  return { valid: false, reason: 'not_found' };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }
  if (!STRIPE_SECRET_KEY) {
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

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (_) {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not read request.' }),
    };
  }

  const code = String(payload.code || '').trim().slice(0, 100);
  if (!code) {
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ valid: false }),
    };
  }

  try {
    const stripe = Stripe(STRIPE_SECRET_KEY);
    const result = await lookupPromo(stripe, code);

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(
        result.valid
          ? { valid: true, code: result.code, summary: result.summary }
          : { valid: false }
      ),
    };
  } catch (err) {
    console.error('community-validate-promo error:', err);
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not check that code right now.' }),
    };
  }
};

// Exported so community-submit.js can reuse the exact same logic.
module.exports.lookupPromo = lookupPromo;
module.exports.describeCoupon = describeCoupon;

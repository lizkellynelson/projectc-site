// community-submit.js — Netlify serverless function
// ---------------------------------------------------
// Handles the main community application submission. Takes the form data
// from the browser, validates it, vaults the applicant's card via Stripe
// (unless they're applying with a valid cohort code, in which case no
// payment is needed), and inserts a pending_review row into the
// `applications` table in Supabase.
//
// Two application paths:
//
//   1. PAID: applicant selects a tier (solo/org × monthly/yearly) and
//      Stripe Elements has already confirmed a SetupIntent in the browser.
//      We take the confirmed setupIntentId, pull the vaulted payment
//      method, create a Stripe customer for the applicant, attach the
//      payment method, and save the three IDs on the application row. No
//      charge happens yet — the actual subscription is created later in
//      the approval function.
//
//   2. COHORT: applicant submits a valid cohort invite code. We look up
//      the cohort, verify it's active, not expired, and has seats left,
//      and insert the application with tier='cohort'. No Stripe calls.
//      Seat count is incremented later on approval to avoid spam filling
//      the cohort.
//
// All applications land as status='pending_review'. Humans (Liz / Blair)
// approve or reject in a separate flow.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

// —— Env vars ——
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_COMMUNITY_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_COMMUNITY_SECRET_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_REVIEW_CHANNEL_ID = process.env.SLACK_REVIEW_CHANNEL_ID;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// —— Rate limiting (anti-spam) ——
// Tighter than setup-intent — one IP shouldn't submit more than a few
// applications in a ten-minute window.
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX = 5;

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

// —— Validation helpers ——
const VALID_TIERS = [
  'solo_monthly',
  'solo_yearly',
  'org_monthly',
  'org_yearly',
  'cohort',
];

function normalizeTier(raw) {
  if (!raw) return null;
  // Browser form uses hyphens (solo-monthly); DB check constraint uses
  // underscores (solo_monthly). Also accepts 'team-*' as an alias for
  // 'org-*' in case we rename later without a migration.
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
    .replace(/^team_/, 'org_');
}

function isValidEmail(s) {
  return (
    typeof s === 'string' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) &&
    s.length < 254
  );
}

function cleanString(s, maxLen) {
  if (typeof s !== 'string') return '';
  return s.trim().slice(0, maxLen);
}

function fail(statusCode, message) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: message }),
  };
}

// —— Slack notification helper ——
// Posts a formatted card with Approve / Reject buttons to the review
// channel via the Slack Web API (bot token). Interactive buttons are
// handled by community-slack-action.js. Failures here are logged but
// never surfaced to the applicant.
function escapeSlackText(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function humanTierLabel(tier, cohortRow) {
  if (tier === 'cohort') {
    return cohortRow && cohortRow.name
      ? `Cohort — ${cohortRow.name}`
      : 'Cohort';
  }
  const map = {
    solo_monthly: 'Solo — Monthly ($39)',
    solo_yearly: 'Solo — Yearly ($399)',
    org_monthly: 'Organizational — Monthly ($59)',
    org_yearly: 'Organizational — Yearly ($650)',
  };
  return map[tier] || tier;
}

async function postNewApplicationToSlack({
  applicationId,
  name,
  email,
  workUrl,
  about,
  tier,
  cohortRow,
}) {
  if (!SLACK_BOT_TOKEN || !SLACK_REVIEW_CHANNEL_ID) {
    console.warn('SLACK_BOT_TOKEN or SLACK_REVIEW_CHANNEL_ID not set — skipping Slack alert');
    return;
  }

  const aboutTrimmed =
    about.length > 1200 ? about.slice(0, 1200) + '…' : about;

  const tierLabel = humanTierLabel(tier, cohortRow);

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: 'New community application',
        emoji: false,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Name*\n${escapeSlackText(name)}` },
        { type: 'mrkdwn', text: `*Email*\n${escapeSlackText(email)}` },
        { type: 'mrkdwn', text: `*Tier*\n${escapeSlackText(tierLabel)}` },
        { type: 'mrkdwn', text: `*Work*\n<${workUrl}|${escapeSlackText(workUrl)}>` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*About*\n${escapeSlackText(aboutTrimmed)}`,
      },
    },
    {
      type: 'actions',
      block_id: 'review_actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve', emoji: false },
          style: 'primary',
          action_id: 'approve_application',
          value: applicationId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Reject', emoji: false },
          style: 'danger',
          action_id: 'reject_application',
          value: applicationId,
          confirm: {
            title: { type: 'plain_text', text: 'Reject this applicant?' },
            text: { type: 'plain_text', text: 'This will open a form for the rejection reason.' },
            confirm: { type: 'plain_text', text: 'Continue' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Application \`${applicationId}\``,
        },
      ],
    },
  ];

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: SLACK_REVIEW_CHANNEL_ID,
        text: `New community application from ${name} (${email})`,
        blocks,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error(`Slack chat.postMessage failed: ${data.error}`);
    }
  } catch (err) {
    console.error('Slack postMessage error:', err);
  }
}

// —— Main handler ——
exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return fail(405, 'Method not allowed');
  }

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !STRIPE_SECRET_KEY) {
    console.error('community-submit: missing required env vars');
    return fail(500, 'The application form is not fully configured. Please try again later.');
  }

  // Rate limit by IP
  const clientIp =
    event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
  if (!checkRateLimit(clientIp)) {
    return fail(429, 'Too many submissions from this address. Please wait a bit and try again.');
  }

  // Parse body
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    return fail(400, 'Could not read form data.');
  }

  // Normalize + validate form fields
  const name       = cleanString(payload.fullName, 200);
  const email      = cleanString(payload.email, 254).toLowerCase();
  const workUrl    = cleanString(payload.workLink, 500);
  const about      = cleanString(payload.aboutYou, 5000);
  const rawTier    = payload.tier;
  const cohortCode = cleanString(payload.cohortCode, 100).toUpperCase() || null;
  const agree      = payload.agree === true;
  const setupIntentId = cleanString(payload.setupIntentId, 200) || null;

  if (!name) return fail(400, 'Please enter your name.');
  if (!isValidEmail(email)) return fail(400, 'Please enter a valid email address.');
  if (!workUrl) return fail(400, 'Please share a link to your work.');
  if (!about) return fail(400, "Please tell us a bit about what you're building.");
  if (!agree) return fail(400, 'You need to agree to the community guidelines before submitting.');

  let tier = normalizeTier(rawTier);
  if (!VALID_TIERS.includes(tier)) {
    return fail(400, 'Please choose a membership tier.');
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { persistSession: false },
  });
  const stripe = Stripe(STRIPE_SECRET_KEY);

  // —— COHORT PATH: free membership, no Stripe interaction ——
  let cohortRow = null;
  if (cohortCode) {
    const { data, error } = await supabase
      .from('cohorts')
      .select(
        'id, name, seat_limit, seats_used, code_expires_at, cohort_ends_at, active, auto_approve'
      )
      .eq('invite_code', cohortCode)
      .maybeSingle();

    if (error) {
      console.error('Cohort lookup error:', error);
      return fail(500, "We couldn't verify that cohort code. Please try again in a moment.");
    }
    if (!data || !data.active) {
      return fail(400, "That cohort code doesn't look right. Double-check it with whoever invited you.");
    }
    if (new Date(data.code_expires_at) < new Date()) {
      return fail(400, 'That cohort code has expired. Reach out to your partner contact for a fresh one.');
    }
    if (data.seat_limit !== null && data.seats_used >= data.seat_limit) {
      return fail(400, 'That cohort is full. Reach out to your partner contact.');
    }
    cohortRow = data;

    // Override whatever tier they selected — cohort code always wins.
    // This is intentional so cohort applicants don't accidentally pay.
    tier = 'cohort';
  }

  // —— PAID PATH: vault the card via Stripe ——
  let stripeCustomerId = null;
  let stripePaymentMethodId = null;
  let confirmedSetupIntentId = null;

  if (tier !== 'cohort') {
    if (!setupIntentId) {
      return fail(400, 'Payment details are missing. Please re-enter your card and try again.');
    }

    try {
      // Confirm the SetupIntent the browser just ran through Stripe Elements.
      const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);

      if (setupIntent.status !== 'succeeded') {
        return fail(400, "We couldn't confirm your card. Please try entering it again.");
      }
      if (!setupIntent.payment_method) {
        return fail(400, 'No card was attached. Please re-enter your payment details.');
      }

      stripePaymentMethodId = setupIntent.payment_method;
      confirmedSetupIntentId = setupIntent.id;

      // Create a Stripe customer for this applicant. If they're ultimately
      // rejected we'll clean this up in the rejection flow; for now, we
      // need a customer to attach the vaulted card to.
      const customer = await stripe.customers.create({
        email,
        name,
        metadata: {
          source: 'community_application',
          tier,
        },
      });
      stripeCustomerId = customer.id;

      // Attach the vaulted payment method and make it the default so any
      // future invoice (created on approval) uses it automatically.
      await stripe.paymentMethods.attach(stripePaymentMethodId, {
        customer: stripeCustomerId,
      });
      await stripe.customers.update(stripeCustomerId, {
        invoice_settings: { default_payment_method: stripePaymentMethodId },
      });
    } catch (err) {
      console.error('Stripe vault error:', err);
      return fail(500, 'Something went wrong saving your payment details. No charge was made. Please try again.');
    }
  }

  // —— Insert the application row ——
  const insertRow = {
    name,
    email,
    work_url: workUrl,
    about,
    tier,
    cohort_code: cohortCode,
    cohort_id: cohortRow ? cohortRow.id : null,
    stripe_customer_id: stripeCustomerId,
    stripe_payment_method_id: stripePaymentMethodId,
    stripe_setup_intent_id: confirmedSetupIntentId,
    status: 'pending_review',
    agreement_accepted_at: new Date().toISOString(),
    source: 'community_page',
    user_agent: event.headers['user-agent'] || null,
  };

  const { data: inserted, error: insertErr } = await supabase
    .from('applications')
    .insert(insertRow)
    .select('id')
    .single();

  if (insertErr) {
    console.error('Application insert error:', insertErr);
    // The Stripe customer (if created) is left in place for manual cleanup
    // rather than trying to unwind a partial state.
    return fail(
      500,
      "We saved your card but couldn't save your application. Please email liz@projectc.biz and we'll sort it out."
    );
  }

  // Ping the review channel. Awaited so the serverless runtime doesn't
  // terminate before the webhook call completes, but wrapped internally in
  // try/catch so Slack being down never breaks submission for the applicant.
  await postNewApplicationToSlack({
    applicationId: inserted.id,
    name,
    email,
    workUrl,
    about,
    tier,
    cohortRow,
  });

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok: true,
      applicationId: inserted.id,
      tier,
      isCohort: tier === 'cohort',
    }),
  };
};

// stripe-webhook.js — Netlify serverless function
// -----------------------------------------------
// Keeps the memberships table in sync with Stripe when a member changes
// something in the Stripe Customer Portal (or Liz changes it in the Stripe
// dashboard). Before Sept 2026 there was no webhook at all, so this is the
// first thing that writes Stripe changes back to Supabase.
//
// Events handled:
//   customer.subscription.updated
//     - member scheduled a cancellation  -> canceled_at, membership_ends_at,
//       cancellation_reason set; status STAYS 'active' until the paid period
//       ends (Liz's policy: paid members keep access through what they paid).
//     - member un-canceled               -> those three fields cleared.
//     - always                           -> current_period_end, price, tier.
//   customer.subscription.deleted
//     - the subscription actually ended (period ran out, or payments failed)
//       -> status 'expired'. The Replay Room login stops working. Liz gets an
//       email so she can remove them from Slack (there's no Slack job yet).
//   invoice.paid
//     - refreshes current_period_end so the renewal date is always right.
//   customer.updated
//     - if the email on the Stripe customer changed, Liz gets a heads-up.
//       Login email is never changed automatically.
//
// Every event id is recorded in stripe_events first, so a replayed or
// duplicate delivery is a no-op. If processing throws, the record is
// removed and we return 500 so Stripe retries.
//
// Env vars:
//   STRIPE_SECRET_KEY, SUPABASE_COMMUNITY_URL, SUPABASE_COMMUNITY_SECRET_KEY,
//   RESEND_API_KEY (all already set on Netlify)
//   STRIPE_WEBHOOK_SECRET   <-- NEW. The whsec_... signing secret Stripe shows
//                               when the webhook endpoint is created.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL = process.env.SUPABASE_COMMUNITY_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_COMMUNITY_SECRET_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const LIZ_EMAIL = 'liz@projectc.biz';
const TZ = 'America/New_York';

// Price -> tier. Includes the older pre-2026 prices that some members are
// still on. Unknown prices leave the tier alone.
const PRICE_TIERS = {
  price_1TLPHoBrD2t02jnp7ZR518Dv: 'solo_monthly', // Solo $39/mo
  price_1TLPIMBrD2t02jnp4fTB0xiy: 'solo_yearly',  // Solo $399/yr
  price_1TLPKWBrD2t02jnpMnyCsysn: 'org_monthly',  // Org $59/mo
  price_1TLPKnBrD2t02jnpoItXTchO: 'org_yearly',   // Org $650/yr
  price_1S32vgBrD2t02jnp9EMjBT18: 'solo_monthly', // older Solo $39/mo
  price_1SpDXhBrD2t02jnp1V3AtvWC: 'solo_yearly',  // older Solo $399/yr
  price_1S61BmBrD2t02jnpmJRKqL2q: 'solo_yearly',  // older Solo $399/yr
  price_1SpDX1BrD2t02jnpez5B4q8G: 'org_monthly',  // older Org $59/mo
  price_1SpDX1BrD2t02jnp7cfMNdtg: 'org_yearly',   // older Org $650/yr
};

const REASON_WORDS = {
  too_expensive: 'Too expensive',
  unused: 'Not using it enough',
  switched_service: 'Switched to something else',
  missing_features: 'Missing something they needed',
  customer_service: 'Customer service',
  low_quality: 'Quality',
  too_complex: 'Too complicated',
  other: 'Other',
  payment_failed: 'Card payments failed',
  payment_disputed: 'Payment disputed',
  cancellation_requested: 'Canceled',
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------
const toIso = (unix) => (unix ? new Date(unix * 1000).toISOString() : null);

// Stripe moved current_period_end from the subscription to its items in
// newer API versions. Read whichever is present.
function periodEnd(sub) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  return toIso(sub.current_period_end || (item && item.current_period_end));
}

function priceId(sub) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  return (item && item.price && item.price.id) || null;
}

// A subscription is "on its way out" if it's set to cancel at period end, or
// has a specific cancel_at date (newer portal behavior).
function isCanceling(sub) {
  return !!(sub.cancel_at_period_end || sub.cancel_at) && sub.status !== 'canceled';
}

function cancelReason(sub) {
  const d = sub.cancellation_details || {};
  const parts = [];
  if (d.feedback) parts.push(REASON_WORDS[d.feedback] || d.feedback);
  if (d.comment) parts.push(`"${String(d.comment).slice(0, 500)}"`);
  if (!parts.length && d.reason && d.reason !== 'cancellation_requested') {
    parts.push(REASON_WORDS[d.reason] || d.reason);
  }
  return parts.length ? parts.join(': ') : null;
}

// Given the current row and the subscription, decide what to write.
// Returns { patch, change } where change is 'canceled' | 'uncanceled' | null.
function planSubscriptionUpdate(row, sub) {
  const patch = {};
  let change = null;

  const pe = periodEnd(sub);
  if (pe) patch.current_period_end = pe;

  const pid = priceId(sub);
  if (pid) {
    patch.stripe_price_id = pid;
    if (PRICE_TIERS[pid] && row.tier !== 'cohort') patch.tier = PRICE_TIERS[pid];
  }

  if (isCanceling(sub)) {
    const endsAt = toIso(sub.cancel_at) || pe;
    patch.membership_ends_at = endsAt;
    if (!row.canceled_at) {
      patch.canceled_at = toIso(sub.canceled_at) || new Date().toISOString();
      change = 'canceled';
    }
    const reason = cancelReason(sub);
    if (reason) patch.cancellation_reason = reason;
  } else if (row.canceled_at && row.status === 'active' && sub.status !== 'canceled') {
    // Member changed their mind before the period ended.
    patch.canceled_at = null;
    patch.membership_ends_at = null;
    patch.cancellation_reason = null;
    change = 'uncanceled';
  }

  return { patch, change };
}

function planSubscriptionDeleted(row, sub) {
  const endedAt = toIso(sub.ended_at) || new Date().toISOString();
  const patch = {
    status: 'expired',
    membership_ends_at: row.membership_ends_at && Date.parse(row.membership_ends_at) <= Date.now()
      ? row.membership_ends_at
      : endedAt,
    canceled_at: row.canceled_at || toIso(sub.canceled_at) || endedAt,
  };
  if (!row.cancellation_reason) {
    const reason = cancelReason(sub);
    if (reason) patch.cancellation_reason = reason;
  }
  return patch;
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------
function fmtDate(iso) {
  return iso
    ? new Date(iso).toLocaleDateString('en-US', { timeZone: TZ, month: 'long', day: 'numeric', year: 'numeric' })
    : 'unknown date';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function tellLiz(subject, lines) {
  if (!RESEND_API_KEY) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Project C <community@projectc.biz>',
        to: [LIZ_EMAIL],
        subject,
        html: `<div style="font-family:Inter,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1a1410;">${lines
          .map((l) => `<p style="margin:0 0 10px;">${l}</p>`).join('')}<p style="margin:16px 0 0;font-size:12px;color:#6b5f57;">Sent automatically by the Project C site when Stripe reported a change.</p></div>`,
      }),
    });
    if (!res.ok) console.error('stripe-webhook: Resend status', res.status);
  } catch (err) {
    console.error('stripe-webhook: could not email Liz', err && err.message);
  }
}

async function findRow(supabase, sub) {
  const cols = 'id, name, email, tier, status, canceled_at, membership_ends_at, cancellation_reason, stripe_subscription_id';
  let { data, error } = await supabase.from('memberships').select(cols)
    .eq('stripe_subscription_id', sub.id).limit(1);
  if (error) throw error;
  if (data && data.length) return data[0];
  const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer && sub.customer.id;
  if (!customer) return null;
  ({ data, error } = await supabase.from('memberships').select(cols)
    .eq('stripe_customer_id', customer).order('created_at', { ascending: false }).limit(1));
  if (error) throw error;
  return data && data.length ? data[0] : null;
}

// ---------------------------------------------------------------------------
// Event handlers. Each returns a short outcome string for stripe_events.
// ---------------------------------------------------------------------------
async function onSubscriptionUpdated(supabase, sub) {
  const row = await findRow(supabase, sub);
  if (!row) return 'no matching member';
  const { patch, change } = planSubscriptionUpdate(row, sub);
  if (!row.stripe_subscription_id) patch.stripe_subscription_id = sub.id;
  const { error } = await supabase.from('memberships').update(patch).eq('id', row.id);
  if (error) throw error;

  if (change === 'canceled') {
    await tellLiz(`${row.name || row.email} canceled their membership`, [
      `<strong>${esc(row.name)}</strong> (${esc(row.email)}) canceled in the billing portal.`,
      `They keep full access, including Slack, through <strong>${fmtDate(patch.membership_ends_at)}</strong>. Nothing to do until then.`,
      patch.cancellation_reason ? `Reason they gave: ${esc(patch.cancellation_reason)}` : 'They didn’t give a reason.',
    ]);
  } else if (change === 'uncanceled') {
    await tellLiz(`${row.name || row.email} un-canceled`, [
      `<strong>${esc(row.name)}</strong> (${esc(row.email)}) changed their mind and turned renewal back on. They’re staying.`,
    ]);
  }
  return change ? `updated (${change})` : 'updated';
}

async function onSubscriptionDeleted(supabase, sub) {
  const row = await findRow(supabase, sub);
  if (!row) return 'no matching member';
  if (row.status === 'expired') return 'already expired';
  const patch = planSubscriptionDeleted(row, sub);
  const { error } = await supabase.from('memberships').update(patch).eq('id', row.id);
  if (error) throw error;
  const why = (sub.cancellation_details && sub.cancellation_details.reason) === 'payment_failed'
    ? 'Their card payments failed and Stripe ran out of retries.'
    : 'Their paid period ran out after they canceled.';
  await tellLiz(`Membership ended: ${row.name || row.email}`, [
    `<strong>${esc(row.name)}</strong> (${esc(row.email)}) is no longer a paying member as of ${fmtDate(patch.membership_ends_at)}.`,
    why,
    'The Replay Room login has stopped working for them. <strong>Please remove them from Slack.</strong>',
  ]);
  return 'expired';
}

async function onInvoicePaid(supabase, stripe, invoice) {
  const subId = invoice.subscription
    || (invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription);
  if (!subId) return 'not a subscription invoice';
  const sub = await stripe.subscriptions.retrieve(typeof subId === 'string' ? subId : subId.id);
  const row = await findRow(supabase, sub);
  if (!row) return 'no matching member';
  const patch = { current_period_end: periodEnd(sub) };
  const pid = priceId(sub);
  if (pid) patch.stripe_price_id = pid;
  const { error } = await supabase.from('memberships').update(patch).eq('id', row.id);
  if (error) throw error;
  return 'period refreshed';
}

async function onCustomerUpdated(supabase, customer, previous) {
  if (!previous || !('email' in previous)) return 'ignored (no email change)';
  const { data } = await supabase.from('memberships').select('name, email')
    .eq('stripe_customer_id', customer.id).limit(1);
  const row = data && data[0];
  await tellLiz('A member’s billing email changed', [
    `The billing email for <strong>${esc(row ? row.name : customer.name)}</strong> changed in Stripe from ${esc(previous.email)} to <strong>${esc(customer.email)}</strong>.`,
    row ? `Their site login email is still ${esc(row.email)}. If they want to log in with the new one, update it in Supabase (memberships table).` : 'This customer isn’t linked to a membership row.',
  ]);
  return 'emailed Liz';
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET || !SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error('stripe-webhook: missing env vars');
    return { statusCode: 500, body: 'Not configured' };
  }

  const stripe = Stripe(STRIPE_SECRET_KEY);
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : event.body || '';

  let evt;
  try {
    evt = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('stripe-webhook: bad signature');
    return { statusCode: 400, body: 'Bad signature' };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

  // Idempotency: claim the event id. A duplicate insert means we've seen it.
  const { error: claimErr } = await supabase.from('stripe_events').insert({ id: evt.id, type: evt.type });
  if (claimErr) {
    if (claimErr.code === '23505') return { statusCode: 200, body: 'duplicate' };
    console.error('stripe-webhook: could not record event', claimErr.message);
    return { statusCode: 500, body: 'db error' };
  }

  try {
    const obj = evt.data.object;
    let outcome = 'ignored';
    switch (evt.type) {
      case 'customer.subscription.updated':
        outcome = await onSubscriptionUpdated(supabase, obj); break;
      case 'customer.subscription.deleted':
        outcome = await onSubscriptionDeleted(supabase, obj); break;
      case 'invoice.paid':
        outcome = await onInvoicePaid(supabase, stripe, obj); break;
      case 'customer.updated':
        outcome = await onCustomerUpdated(supabase, obj, evt.data.previous_attributes); break;
      default:
        break;
    }
    await supabase.from('stripe_events').update({ outcome }).eq('id', evt.id);
    return { statusCode: 200, body: outcome };
  } catch (err) {
    // Release the claim so Stripe's retry gets processed.
    console.error(`stripe-webhook: ${evt.type} ${evt.id} failed:`, err && err.message);
    await supabase.from('stripe_events').delete().eq('id', evt.id);
    return { statusCode: 500, body: 'processing error' };
  }
};

exports._test = { planSubscriptionUpdate, planSubscriptionDeleted, periodEnd, isCanceling, cancelReason };

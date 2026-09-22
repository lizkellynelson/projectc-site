// members-billing.js — Netlify serverless function
// ------------------------------------------------
// Powers the "Your membership" panel in the Replay Room (members.html) and
// the one-time billing link page (billing.html). Three actions:
//
//   1. action: "status"     (JSON POST, needs Replay Room token)
//      Returns the member's plan and status in plain words, read from our
//      own memberships row. No Stripe call.
//
//   2. action: "send_link"  (JSON POST, needs Replay Room token)
//      Emails the member a one-time link to their billing page. The Replay
//      Room login is email-only (anyone who knows an address can get in),
//      so billing needs one more proof: that you can read that inbox.
//      Link is good for 15 minutes and works once.
//
//   3. action: "open"       (form POST from billing.html)
//      Spends the one-time link, creates a Stripe Customer Portal session
//      for that member, and 303-redirects the browser to it.
//
// Security notes:
// - The Stripe customer id is only ever read server-side from Supabase.
//   It never goes to the browser, into a URL, or into a log line.
// - The emailed link token lives in the URL #fragment on billing.html, so
//   it is never sent to any server log. Only its sha256 hash is stored.
// - billing.html makes the member click a button (a form POST) before the
//   token is spent, so email link scanners that pre-open links can't burn it.
//
// Env vars (all but the last already exist on Netlify):
//   SUPABASE_COMMUNITY_URL, SUPABASE_COMMUNITY_SECRET_KEY
//   MEMBERS_SESSION_SECRET   (same secret members-auth.js signs tokens with)
//   STRIPE_SECRET_KEY
//   RESEND_API_KEY
//   SITE_URL                 optional, defaults to https://projectc.com

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');

const SUPABASE_URL = process.env.SUPABASE_COMMUNITY_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_COMMUNITY_SECRET_KEY;
const SESSION_SECRET = process.env.MEMBERS_SESSION_SECRET;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SITE_URL = (process.env.SITE_URL || 'https://projectc.com').replace(/\/+$/, '');

// Stripe Customer Portal configurations (set up Sept 22, 2026).
// Named explicitly so a new default configuration in the Stripe dashboard
// can never change what members see by surprise.
const PORTAL_CONFIG_SOLO = 'bpc_1S37jJBrD2t02jnpiTNwhGVG'; // solo: monthly <-> yearly
const PORTAL_CONFIG_ORG = 'bpc_1UIVJYBrD2t02jnpnS1gHW4t';  // org: monthly <-> yearly
// Members still inside a promo discount (e.g. FREEPROJECTC's free year) get a
// portal with plan switching OFF. Otherwise switching to yearly mid-promo would
// run a full year's invoice through the discount. Created Sept 22, 2026.
const PORTAL_CONFIG_PROMO = 'bpc_1UIWTTBrD2t02jnp4aJ56YXn';
const PAID_TIERS = ['solo_monthly', 'solo_yearly', 'org_monthly', 'org_yearly'];

const LINK_TTL_MS = 15 * 60 * 1000;
const LINKS_PER_WINDOW = 3; // per member, per 15 minutes
const LIZ_EMAIL = 'liz@projectc.biz';
const TZ = 'America/New_York';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ---------------------------------------------------------------------------
// Plain-words plan names
// ---------------------------------------------------------------------------
const PLAN_LABELS = {
  solo_monthly: ['Solo membership', 'Billed monthly at $39'],
  solo_yearly: ['Solo membership', 'Billed yearly at $399'],
  org_monthly: ['Organizational membership', 'Two seats, billed monthly at $59'],
  org_yearly: ['Organizational membership', 'Two seats, billed yearly at $650'],
  cohort: ['Partner cohort membership', null],
  legacy: ['Founding membership', null],
  comp: ['Complimentary membership', null],
};

function planLabel(tier) {
  return PLAN_LABELS[tier] || ['Project C membership', null];
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone: TZ, month: 'long', day: 'numeric', year: 'numeric',
  });
}

function maskEmail(email) {
  const [user, domain] = String(email).split('@');
  if (!domain) return email;
  const shown = user.length <= 2 ? user[0] : user.slice(0, 2);
  return `${shown}${'•'.repeat(Math.max(2, Math.min(6, user.length - shown.length)))}@${domain}`;
}

// Builds the member-facing summary. Kept here (not in the page) so the copy
// lives in one place and the page stays dumb.
function discountActive(row) {
  return !!(row.discount_ends_at && Date.parse(row.discount_ends_at) > Date.now());
}

function summarize(row, cohort) {
  const hasBilling = !!row.stripe_customer_id;
  const paid = PAID_TIERS.includes(row.tier);
  const now = Date.now();
  const out = {
    plan: planLabel(row.tier)[0],
    billing: planLabel(row.tier)[1],
    status: 'Active.',
    note: null,
    // Only paid members see a promo tag. Comp and legacy rows use
    // promo_summary for internal notes, which should never reach the page.
    promo: paid ? (row.promo_summary || null) : null,
    canManageBilling: hasBilling && row.status === 'active',
    contact: null,
  };

  if (row.status === 'expired' || row.status === 'canceled') {
    out.status = `Your membership ended${row.membership_ends_at ? ' on ' + fmtDate(row.membership_ends_at) : ''}.`;
    out.note = 'We’d love to have you back. You can reapply any time at projectc.com/community.';
    out.canManageBilling = false;
    out.promo = null;
    return out;
  }

  const pct = Number(row.discount_percent_off) || 0;
  if (row.tier === 'cohort') {
    const via = cohort ? (cohort.partner || cohort.name) : null;
    out.status = row.membership_ends_at
      ? `Free through ${fmtDate(row.membership_ends_at)}${via ? ` via ${via}` : ''}.`
      : `Free${via ? ` via ${via}` : ''}.`;
  } else if (row.canceled_at && row.membership_ends_at && Date.parse(row.membership_ends_at) > now) {
    out.status = `You’ve canceled. You keep everything through ${fmtDate(row.membership_ends_at)}.`;
    if (hasBilling) out.note = 'Changed your mind? You can renew from Manage billing before then.';
  } else if (paid && discountActive(row) && pct >= 100) {
    // e.g. FREEPROJECTC: card is on file but nothing is charged until the free period ends.
    const after = out.billing ? out.billing.replace(/^Billed/, 'billed') : null;
    out.status = `Free through ${fmtDate(row.discount_ends_at)} with your promo code.${after ? ` After that, ${after}.` : ''}`;
    out.billing = null;
    out.promo = null;
  } else if (paid && discountActive(row) && pct > 0) {
    out.status = `Active. ${pct}% off through ${fmtDate(row.discount_ends_at)}.` +
      (row.current_period_end ? ` Next renewal on ${fmtDate(row.current_period_end)}.` : '');
    out.promo = null;
  } else if (hasBilling && row.current_period_end) {
    out.status = `Active. Next renewal on ${fmtDate(row.current_period_end)}.`;
  }

  if (!out.canManageBilling) {
    out.contact = 'Questions about your membership? Just email Liz at liz@projectc.com.';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Same token format as members-auth.js (base64url(payload).hmac).
function verifyMemberToken(token) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return null;
  const expected = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
    );
    if (!payload.e || !payload.x || Date.now() > payload.x) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function redirect(location) {
  return { statusCode: 303, headers: { Location: location, 'Cache-Control': 'no-store' }, body: '' };
}

// In-memory per-IP limiter (resets on cold start). The per-member limit on
// emailed links is enforced in the database instead, so it survives restarts.
const hits = new Map();
function ipAllowed(ip, max = 12, windowMs = 60 * 1000) {
  const now = Date.now();
  const r = hits.get(ip);
  if (!r || now - r.start > windowMs) { hits.set(ip, { start: now, n: 1 }); return true; }
  if (r.n >= max) return false;
  r.n++;
  return true;
}

function db() {
  return createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
}

async function findMembership(supabase, email) {
  const { data, error } = await supabase
    .from('memberships')
    .select('id, name, email, tier, status, cohort_id, stripe_customer_id, membership_ends_at, canceled_at, current_period_end, promo_summary, discount_ends_at, discount_percent_off')
    .ilike('email', email)
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) throw error;
  if (!data || !data.length) return null;
  // Prefer an active row if someone has more than one.
  return data.find((r) => r.status === 'active') || data[0];
}

function billingEmailHtml(firstName, link) {
  const hi = firstName ? `Hi ${firstName},` : 'Hi,';
  return `<!doctype html><html><body style="margin:0;background:#F4F2EA;font-family:Inter,Helvetica,Arial,sans-serif;color:#1a1410;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F2EA;padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:2px solid #1a1410;">
<tr><td style="padding:0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td height="6" style="background:#00AEEF;font-size:0;line-height:0;">&nbsp;</td><td height="6" style="background:#EC008C;font-size:0;line-height:0;">&nbsp;</td><td height="6" style="background:#FFE800;font-size:0;line-height:0;">&nbsp;</td><td height="6" style="background:#FE6B41;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>
<tr><td style="padding:28px 28px 8px;">
<p style="margin:0 0 4px;font-family:'JetBrains Mono',Menlo,monospace;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#B74D2F;">Project C / Membership</p>
<h1 style="margin:0 0 18px;font-family:Anton,Impact,'Arial Narrow',sans-serif;font-weight:400;font-size:30px;line-height:1.05;text-transform:uppercase;">Your billing link</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.55;">${hi}</p>
<p style="margin:0 0 22px;font-size:16px;line-height:1.55;">Here’s your link to your Project C billing page. That’s where you update your card and grab receipts. You can also switch between monthly and yearly, or cancel.</p>
<p style="margin:0 0 22px;"><a href="${link}" style="display:inline-block;background:#1a1410;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;letter-spacing:.06em;text-transform:uppercase;padding:14px 22px;border:2px solid #1a1410;">Open my billing page</a></p>
<p style="margin:0 0 22px;font-size:14px;line-height:1.55;color:#4a3f38;">The link works once and expires in 15 minutes. If it runs out, just click Manage billing in the Replay Room again.</p>
<p style="margin:0 0 26px;font-size:14px;line-height:1.55;color:#4a3f38;">Didn’t ask for this? You can ignore it. Nothing changes unless someone opens the link from your inbox.</p>
</td></tr>
<tr><td style="padding:14px 28px;border-top:2px solid #1a1410;font-family:'JetBrains Mono',Menlo,monospace;font-size:12px;color:#4a3f38;">Questions? Just reply or email liz@projectc.com.</td></tr>
</table></td></tr></table></body></html>`;
}

async function sendEmail({ to, subject, html, replyTo }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Project C <community@projectc.biz>',
      to: [to],
      reply_to: replyTo || LIZ_EMAIL,
      subject,
      html,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error('Resend failed: ' + (data.error && data.error.message || res.status));
  return data;
}

function parseBody(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : event.body || '';
  const type = String(event.headers['content-type'] || event.headers['Content-Type'] || '');
  if (type.includes('application/x-www-form-urlencoded')) {
    return { form: true, data: Object.fromEntries(new URLSearchParams(raw)) };
  }
  try {
    return { form: false, data: JSON.parse(raw || '{}') };
  } catch (_) {
    return { form: false, data: null };
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !SESSION_SECRET || !STRIPE_SECRET_KEY || !RESEND_API_KEY) {
    console.error('members-billing: missing env vars',
      { supabase: !!SUPABASE_URL && !!SUPABASE_SECRET_KEY, session: !!SESSION_SECRET, stripe: !!STRIPE_SECRET_KEY, resend: !!RESEND_API_KEY });
    return json(500, { error: 'Billing isn’t set up yet. Email liz@projectc.com and she’ll sort it out.' });
  }

  const ip = String(event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown').split(',')[0].trim();
  const { form, data } = parseBody(event);
  const failPage = (code) => redirect(`${SITE_URL}/billing.html#error=${code}`);

  if (!ipAllowed(ip)) {
    return form ? failPage('busy') : json(429, { error: 'Too many tries. Give it a minute and try again.' });
  }
  if (!data) return json(400, { error: 'Could not read request.' });

  const supabase = db();

  // ---- action: open (form POST from billing.html) ----
  if (data.action === 'open') {
    const raw = String(data.t || '');
    if (!/^[A-Za-z0-9_-]{32,64}$/.test(raw)) return failPage('invalid');
    try {
      // Spend the link atomically: only one request can flip used_at.
      const { data: spent, error } = await supabase
        .from('billing_links')
        .update({ used_at: new Date().toISOString() })
        .eq('token_hash', sha256(raw))
        .is('used_at', null)
        .gt('expires_at', new Date().toISOString())
        .select('membership_id');
      if (error) throw error;
      if (!spent || !spent.length) return failPage('expired');

      const { data: rows, error: mErr } = await supabase
        .from('memberships')
        .select('id, tier, status, stripe_customer_id, discount_ends_at')
        .eq('id', spent[0].membership_id)
        .limit(1);
      if (mErr) throw mErr;
      const row = rows && rows[0];
      if (!row || !row.stripe_customer_id || row.status !== 'active') return failPage('nobilling');

      const stripe = Stripe(STRIPE_SECRET_KEY);
      const session = await stripe.billingPortal.sessions.create({
        customer: row.stripe_customer_id,
        configuration: (discountActive(row) && PORTAL_CONFIG_PROMO)
          ? PORTAL_CONFIG_PROMO
          : String(row.tier || '').startsWith('org_') ? PORTAL_CONFIG_ORG : PORTAL_CONFIG_SOLO,
        return_url: `${SITE_URL}/members.html#membership`,
      });
      return redirect(session.url);
    } catch (err) {
      console.error('members-billing open failed:', err && err.message);
      return failPage('error');
    }
  }

  // Everything else needs a Replay Room session.
  const session = verifyMemberToken(data.token);
  if (!session) return json(401, { error: 'expired' });
  const email = String(session.e).toLowerCase();

  try {
    const row = await findMembership(supabase, email);

    // ---- action: status ----
    if (data.action === 'status') {
      if (!row) return json(200, { ok: true, membership: null }); // team allowlist, etc.
      let cohort = null;
      if (row.tier === 'cohort' && row.cohort_id) {
        const { data: c } = await supabase.from('cohorts').select('name, partner').eq('id', row.cohort_id).limit(1);
        cohort = c && c[0];
      }
      return json(200, { ok: true, membership: summarize(row, cohort) });
    }

    // ---- action: send_link ----
    if (data.action === 'send_link') {
      if (!row || !row.stripe_customer_id || row.status !== 'active') {
        return json(200, { ok: false, reason: 'no_billing',
          message: 'We don’t have card billing on file for you. Just email Liz at liz@projectc.com.' });
      }

      const since = new Date(Date.now() - LINK_TTL_MS).toISOString();
      const { count, error: cErr } = await supabase
        .from('billing_links')
        .select('id', { count: 'exact', head: true })
        .eq('membership_id', row.id)
        .gte('created_at', since);
      if (cErr) throw cErr;
      if ((count || 0) >= LINKS_PER_WINDOW) {
        return json(200, { ok: false, reason: 'too_many',
          message: 'We’ve sent a few links already. Check your inbox (and spam), or try again in 15 minutes.' });
      }

      const raw = b64url(crypto.randomBytes(32));
      const { error: iErr } = await supabase.from('billing_links').insert({
        token_hash: sha256(raw),
        membership_id: row.id,
        expires_at: new Date(Date.now() + LINK_TTL_MS).toISOString(),
      });
      if (iErr) throw iErr;

      const firstName = String(row.name || '').split(' ')[0];
      await sendEmail({
        to: row.email,
        subject: 'Your Project C billing link',
        html: billingEmailHtml(firstName, `${SITE_URL}/billing.html#t=${raw}`),
      });
      return json(200, { ok: true, sentTo: maskEmail(row.email) });
    }

    return json(400, { error: 'Unknown action.' });
  } catch (err) {
    console.error('members-billing error:', err && err.message);
    return json(500, { error: 'Something went wrong on our end. Try again, or email liz@projectc.com.' });
  }
};

// Exposed for tests only.
exports._test = { summarize, maskEmail, fmtDate };

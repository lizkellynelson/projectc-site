// members-auth.js — Netlify serverless function
// ----------------------------------------------
// Powers the members-only page (members.html). Two jobs:
//
//   1. action: "login"   — takes an email, checks it against the memberships
//      table in Supabase (the same table community-submit.js writes to).
//      If the member is active, returns a signed session token (30 days).
//
//   2. action: "content" — takes a token, verifies the signature and expiry,
//      and returns the members-only content (event replays + resources).
//
// Design notes:
// - The replay links live HERE, server-side, not in members.html. A static
//   page can't hide anything in its source; a function can. Nobody gets the
//   links without a valid token.
// - No passwords. Membership is the credential. When a membership expires
//   in Supabase (webhook flips status), access ends on next login. Existing
//   tokens age out within 30 days.
// - Token = base64url(payload).hmacSha256(payload). Stateless, no new table.
//
// Env vars required (first two already exist for the community functions):
//   SUPABASE_COMMUNITY_URL
//   SUPABASE_COMMUNITY_SECRET_KEY
//   MEMBERS_SESSION_SECRET   <-- NEW. Any long random string (32+ chars).

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_COMMUNITY_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_COMMUNITY_SECRET_KEY;
const SESSION_SECRET = process.env.MEMBERS_SESSION_SECRET;

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ---------------------------------------------------------------------------
// MEMBERS-ONLY CONTENT
// Sourced from the Event Replays tab in the #lobby Slack channel.
// Two shapes:
//   { type: 'series', title, date, description, sessions: [{ title, date, links }] }
//   { type: 'single', title, date, guest?, description, passcode?, links }
// To add a new replay: add an object to the top of the right array,
// commit, push. Netlify redeploys automatically.
// ---------------------------------------------------------------------------
const MEMBER_CONTENT = {
  note:
    'Everything here is for Project C members only. Please don’t share these links outside the community.',
  series: [
    {
      title: 'Step Forward on Sponsorships',
      date: 'June & July 2026',
      description:
        'A three-part series with Emily and April on landing sponsors: research your prospects, position your pitch, then price and close the deal.',
      sessions: [
        {
          title: 'Session 1',
          date: 'June 23, 2026',
          links: [
            {
              label: 'Watch the recording',
              url: 'https://us06web.zoom.us/rec/share/Q3aqqRdZ7pMifYiREQ2ESS8ZtcBTgljJJK8MYISUwxIwzcLvMk6xuL2mPL-URt1y.nkvH9kMj_41yjTWq',
            },
            {
              label: 'Slides',
              url: 'https://project-c-hub.slack.com/files/U08EABKF2N6/F0BCSC6NCHH/_1__step_forward_on_sponsorships__1_.pdf',
            },
          ],
        },
        {
          title: 'Session 2',
          date: 'July 1, 2026',
          links: [
            {
              label: 'Watch the recording',
              url: 'https://us06web.zoom.us/rec/share/daDn3x4cr197DtgC3fEz2dpP35ErmTs51EJEMoUiOEyNMH5YG8DrTEMoHXprIDoN.CTwMb6CM958NdXis',
            },
            {
              label: 'Slides',
              url: 'https://project-c-hub.slack.com/files/U08EABKF2N6/F0BEA75HXRV/_2__step_forward_on_sponsorships.pdf',
            },
          ],
        },
        {
          title: 'Session 3: Building the Sponsorship',
          date: 'July 8, 2026',
          links: [
            {
              label: 'Watch the recording',
              url: 'https://us06web.zoom.us/rec/share/2hCjh1groc9zXfdbtX9cM3FDntH8SdeN-DKyYyxTCgYFxGdRAQsb1ujf1XtlXIWn.kXEIl_L22ysPInHF',
            },
            {
              label: 'Slides',
              url: 'https://project-c-hub.slack.com/files/U08EABKF2N6/F0BG5HJPH7W/_3__step_forward_on_sponsorships.pdf',
            },
          ],
        },
      ],
    },
    {
      title: 'Building with beehiiv',
      date: 'March & April 2026',
      description:
        'A three-part series with Ryan Gilbert on getting more out of beehiiv: monetization and audience growth, analytics and retention, and the website builder.',
      sessions: [
        {
          title: 'Monetization & Audience',
          date: 'March 19, 2026',
          links: [
            {
              label: 'Watch the recording',
              url: 'https://us06web.zoom.us/rec/share/pPmtsqbGgIRhWcDOCv_afdyI7TpuCJHDwwJSO2ULIYV5xSm3lB64t9B5j9rRabX-.vf3pqL1eDoek1gqe?startTime=1773939885000',
            },
          ],
        },
        {
          title: 'Analytics & Audience Retention',
          date: 'March 26, 2026',
          links: [
            {
              label: 'Watch the recording',
              url: 'https://us06web.zoom.us/rec/share/dLEHtuvELNsbCTGzbVX3Xx-x-Dt79lVSxOAWv1VrW5PA9LaKK8_4I3OVtAkKaKTU.UBZKi8Bk10rFxe4v',
            },
          ],
        },
        {
          title: 'Website Builder',
          date: 'April 9, 2026',
          links: [
            {
              label: 'Watch the recording',
              url: 'https://us06web.zoom.us/rec/share/Xg58CuK_xs7JbYOKW7aRl8MfSoeEUwc1dMUrYEofw1PGsT6p-KnB1lAa5beFItLX.gLglY0c2gafNHLtg',
            },
          ],
        },
      ],
    },
    {
      title: 'NYT Philanthropy Series',
      date: 'January to March 2026',
      description:
        'Three sessions with The New York Times philanthropic partnerships team, covering the full arc of grant funding: getting started, making the ask, and managing the money once it lands.',
      sessions: [
        {
          title: 'Part 1: Getting Started With Grants',
          date: 'January 2026',
          links: [
            {
              label: 'Watch the recording',
              url: 'https://us06web.zoom.us/rec/share/WCCAAhQHzjmDxQulV-5hg9CXRM_Z1RwQYKNO3MQHC8vevDqDvG3hOyq9TMfJzt1p.jyGY9g6imqC4adnq',
            },
            {
              label: 'Slides',
              url: 'https://project-c-hub.slack.com/files/U08DVM8FLR5/F0A7E5EU43Z/project_c_presentation__1__philanthropy_for_content_creators.pdf',
            },
          ],
        },
        {
          title: 'Part 2: Making the Ask',
          date: 'February 2026',
          links: [
            {
              label: 'Watch the recording',
              url: 'https://us06web.zoom.us/rec/share/l5Yl15xczhYePJUdesX7aEcpkEyMsHXPGSYdysfTXcCbgcIgr9AZmGr03joFjnXz.Lss6ko1N64D3gfET',
            },
            {
              label: 'Slides',
              url: 'https://project-c-hub.slack.com/files/U08DVM8FLR5/F0ADP4QGQCU/project_c_presentation__2__philanthropy_for_content_creators.pdf',
            },
            {
              label: 'Proposal one-pager template',
              url: 'https://project-c-hub.slack.com/files/U08DVM8FLR5/F0ADYE5PDRP/nick_swyter_philanthropic_partnerships_proposal_template.docx',
            },
          ],
        },
        {
          title: 'Part 3: Managing a Grant-Funded Project',
          date: 'March 2026',
          links: [
            {
              label: 'Watch the recording',
              url: 'https://us06web.zoom.us/rec/share/XlMRdiYOdrVUBsf5aDSkALrnQQjvWoQ3RoctJ6VTsAckaQf23Ap892JqaY33Rq2H.tgW9nAVSMyoXcmeS',
            },
          ],
        },
      ],
    },
  ],
  replays: [
    {
      title: 'Editory Video Tool Demo',
      date: 'June 10, 2026',
      guest: 'David Rodin',
      description:
        'A walkthrough of Editory and how it fits an independent journalist’s workflow.',
      links: [
        {
          label: 'Watch the recording',
          url: 'https://us06web.zoom.us/rec/share/CeR2GxufCMFnv6j6y9Y8BaJDZV3CL3VYScqS-Jj1Xro6J-ENY0bE6yLHaC79CZn5.4YHdiwU57w3F775S',
        },
      ],
    },
    {
      title: 'Fact-Checking for Creators',
      date: 'March 25, 2026',
      guest: 'Rose Thomas Bannister & Anna Pujol-Mazzini',
      description:
        'Practical fact-checking workflows for solo journalists without a research desk.',
      links: [
        {
          label: 'Watch the recording',
          url: 'https://us06web.zoom.us/rec/share/455Ic9N20YlY56HlrhkLBkqR9VzwRYzoPppavTj-G0GlsBjtqmU-4G0-ePNKkNri.rCJg_oHnB2WzhZ06',
        },
      ],
    },
    {
      title: 'Writing for Transparency & Trust',
      date: 'February 2026',
      guest: 'Andy Dehnart',
      description:
        'Best practices for earning reader trust, grounded in journalistic craft and updated for 2026 audiences.',
      links: [
        {
          label: 'Watch the recording',
          url: 'https://us06web.zoom.us/rec/share/zIIeFTK1ny4SuaIMybpUQnWRiL2ZYQXBIsEZ4ddl5kuHdUURh7z83oIiM2aFBYVx.yBHDULYHhTdR8cxJ',
        },
      ],
    },
    {
      title: 'Introducing the Independent Journalism Atlas',
      date: 'January 2026',
      guest: 'Liz, Justin & Ryan',
      description:
        'An introduction to the Independent Journalism Atlas and where it goes next.',
      links: [
        {
          label: 'Watch the recording',
          url: 'https://us06web.zoom.us/rec/share/qTptM1BxgOJ4Rzyy30Geea8utUQS6wHj7f17KcU2VdGpKWWRwzPLy3J23l9xAOeD.1O3f5-6aYkGyVm5E',
        },
      ],
    },
    {
      title: 'Media Training for Creators',
      date: 'October 8, 2025',
      guest: 'Savannah Stephens (The Washington Post)',
      description:
        'A live media training session with practical interview technique. Includes transcript.',
      passcode: '0j.I#d&C',
      links: [
        {
          label: 'Watch the recording',
          url: 'https://us06web.zoom.us/rec/share/0RNxm4kN1h41hmg9XHuqnaGuyoYzmILoMv6zszgRvnZULLdZBMeNDt2qiNcppGbK.LeKHQ-0Ef231MndT?startTime=1759939325000',
        },
        {
          label: 'Savannah’s slides',
          url: 'https://docs.google.com/presentation/d/1ZzU8Ujd68sFsi37AIvejq1bR6ectlEWKIV4rrjezVyQ/edit?usp=sharing',
        },
      ],
    },
  ],
  offers: [
    {
      title: 'Editory',
      code: 'PROJECTC',
      summary: '2 months free, then 20% off',
      description:
        'David Rodin’s social video tool built for journalists. The code gets you 2 months free and 20% off after that, and David hosts weekly office hours for members. Project C takes no cut of any payments.',
      url: 'https://editory.news/',
      linkLabel: 'Go to editory.news',
    },
  ],
  resources: [
    {
      title: 'Media Kit Builder',
      description:
        'Build a polished media kit in minutes. Fill in your numbers and get a shareable page for sponsors and partners.',
      url: 'https://projectc.biz/media-kit-builder/',
      image: 'members-thumb-mediakit.jpg',
    },
    {
      title: 'Press Credential Generator',
      description:
        'Generate a Project C press credential with your name and outlet, ready to print or save.',
      url: 'https://projectc.biz/credential-generator.html',
      image: 'members-thumb-credential.jpg',
    },
    {
      title: 'Philanthropic partnerships proposal template',
      description:
        'A one-pager for pitching funders, courtesy of Nick Swyter at the NYT.',
      url: 'https://project-c-hub.slack.com/files/U08DVM8FLR5/F0ADYE5PDRP/nick_swyter_philanthropic_partnerships_proposal_template.docx',
      image: 'members-thumb-template.jpg',
    },
  ],
};

// ---------------------------------------------------------------------------
// UPCOMING EVENTS — pulled live from the public Project C Luma calendar
// (luma.com/projectc). Cached in memory for 30 minutes so we don't hammer
// Luma on every page view.
// ---------------------------------------------------------------------------
const LUMA_ICS_URL =
  'https://api.lu.ma/ics/get?entity=calendar&id=cal-cR9Ql53NiCX82Iw';

let eventsCache = { at: 0, data: null };

async function getUpcomingEvents() {
  const now = Date.now();
  if (eventsCache.data && now - eventsCache.at < 30 * 60 * 1000) {
    return eventsCache.data;
  }
  const res = await fetch(LUMA_ICS_URL);
  if (!res.ok) throw new Error('Luma feed returned ' + res.status);
  const text = await res.text();

  // Unfold wrapped ICS lines (continuations start with a space or tab)
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const events = [];
  const blocks = unfolded.split('BEGIN:VEVENT').slice(1);

  for (const block of blocks) {
    const field = (key) => {
      const m = block.match(new RegExp('^' + key + '[^:\\n]*:(.*)$', 'm'));
      return m ? m[1].trim() : '';
    };
    const dt = field('DTSTART');
    const iso = dt.replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/,
      '$1-$2-$3T$4:$5:$6Z'
    );
    const start = Date.parse(iso);
    if (!start || start < now) continue; // past events live in the replays list

    const summary = field('SUMMARY').replace(/\\([,;])/g, '$1');
    const desc = field('DESCRIPTION');
    const urlMatch = desc.match(/https:\/\/luma\.com\/[A-Za-z0-9-]+/);
    const hostMatch = desc.match(/Hosted by ([^\\]+)/);

    events.push({
      title: summary,
      start: iso,
      url: urlMatch ? urlMatch[0] : 'https://luma.com/projectc',
      host: hostMatch ? hostMatch[1].trim() : '',
    });
  }

  events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const data = events.slice(0, 4);
  eventsCache = { at: now, data };
  return data;
}

// —— Simple in-memory rate limit (resets on cold start) ——
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10; // login attempts are cheap to abuse; keep this low

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

// —— Token helpers ——
function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function sign(payloadStr) {
  return b64url(
    crypto.createHmac('sha256', SESSION_SECRET).update(payloadStr).digest()
  );
}

function makeToken(email) {
  const payload = JSON.stringify({ e: email, x: Date.now() + TOKEN_TTL_MS });
  const encoded = b64url(payload);
  return `${encoded}.${sign(encoded)}`;
}

function verifyToken(token) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return null;
  const expected = sign(encoded);
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
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !SESSION_SECRET) {
    console.error(
      'members-auth: missing env vars.',
      'SUPABASE_COMMUNITY_URL:', !!SUPABASE_URL,
      'SUPABASE_COMMUNITY_SECRET_KEY:', !!SUPABASE_SECRET_KEY,
      'MEMBERS_SESSION_SECRET:', !!SESSION_SECRET
    );
    return json(500, { error: 'Members area is not configured yet.' });
  }

  const clientIp =
    event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
  if (!checkRateLimit(clientIp)) {
    return json(429, { error: 'Too many attempts. Please wait a minute and try again.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (_) {
    return json(400, { error: 'Could not read request.' });
  }

  // ---- action: content ----
  if (payload.action === 'content') {
    const session = verifyToken(payload.token);
    if (!session) {
      return json(401, { error: 'expired' });
    }
    return json(200, { ok: true, content: MEMBER_CONTENT });
  }

  // ---- action: events (upcoming, from Luma) ----
  if (payload.action === 'events') {
    const session = verifyToken(payload.token);
    if (!session) {
      return json(401, { error: 'expired' });
    }
    try {
      const events = await getUpcomingEvents();
      return json(200, { ok: true, events });
    } catch (err) {
      // Never let a Luma hiccup break the page; the strip just hides itself.
      console.error('members-auth luma error:', err);
      return json(200, { ok: true, events: [] });
    }
  }

  // ---- action: login (default) ----
  const email = String(payload.email || '').trim().toLowerCase().slice(0, 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(200, { ok: false, reason: 'invalid_email' });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { persistSession: false },
    });

    // Status stays 'active' through a member's paid period even after they
    // cancel (webhook flips it to 'expired' when the period ends), so
    // checking status = 'active' matches Liz's access policy exactly.
    const { data, error } = await supabase
      .from('memberships')
      .select('id, name, email, status')
      .ilike('email', email)
      .eq('status', 'active')
      .limit(1);

    if (error) {
      console.error('members-auth supabase error:', error);
      return json(500, { error: 'Could not check membership right now.' });
    }

    if (!data || data.length === 0) {
      return json(200, { ok: false, reason: 'not_found' });
    }

    const firstName = String(data[0].name || '').split(' ')[0] || '';
    return json(200, { ok: true, token: makeToken(email), firstName });
  } catch (err) {
    console.error('members-auth error:', err);
    return json(500, { error: 'Could not check membership right now.' });
  }
};

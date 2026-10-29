// cohort-hub.js — Netlify serverless function
// ---------------------------------------------
// Powers the cohort hub page (tiktok-cohort.html). Everything the page
// reads or writes goes through here. The data lives in the hub_* tables
// in the projectc-community Supabase project.
//
// HOW PEOPLE GET IN
//   Only people on the roster (hub_people, status 'active') can sign in.
//   1. action "request_code": they type their email, we email a 6-digit
//      code (good for 15 minutes).
//   2. action "verify_code": they type the code, we hand back a signed
//      session token. The page keeps it in localStorage.
//   Or, from the welcome email: action "magic" trades a signed one-click
//   link (good for 14 days) for a session token. Same result.
//   Sessions never outlive the program's access_ends_at, and every request
//   re-checks the roster, so setting someone to 'removed' locks them out
//   right away.
//
// ROLES
//   creator  sees the hub, submits videos, checks off tasks
//   partner  (TikTok) also sees the progress table, names and handles only
//   staff    (Project C) sees the table with emails, plus the tools:
//            add/remove people, review submissions, edit weeks, send
//            welcome emails, pull attendance from Zoom
//
// ZOOM
//   Each creator is registered for the recurring cohort meeting and gets a
//   personal join link. That happens when staff add them through the page,
//   or the first time anyone loads the hub without a link yet (so rows
//   added straight into Supabase work too). Attendance is pulled by
//   cohort-hub-scheduled.js after each session.
//
// ENV VARS (all but the Zoom ones already exist for other functions)
//   SUPABASE_COMMUNITY_URL, SUPABASE_COMMUNITY_SECRET_KEY
//   MEMBERS_SESSION_SECRET  (reused; tokens are signed with a derived key)
//   RESEND_API_KEY
//   ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET
//   COHORT_FROM_EMAIL (optional, defaults to community@projectc.biz)

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_COMMUNITY_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_COMMUNITY_SECRET_KEY;
const BASE_SECRET = process.env.MEMBERS_SESSION_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.COHORT_FROM_EMAIL || 'Project C <community@projectc.biz>';

const DEFAULT_PROGRAM = 'tiktok-q4-2026';
const SITE = 'https://projectc.com';
const PAGE_PATHS = { 'tiktok-q4-2026': '/tiktok-cohort' };

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAGIC_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 5;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function json(statusCode, body) {
  return { statusCode, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function db() {
  return createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
}

function hubKey() {
  // Derived key so hub tokens can never be confused with members-page tokens.
  return crypto.createHmac('sha256', BASE_SECRET).update('cohort-hub-v1').digest();
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signToken(payload) {
  const encoded = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', hubKey()).update(encoded).digest());
  return `${encoded}.${sig}`;
}

function readToken(token, kind) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return null;
  const expected = b64url(crypto.createHmac('sha256', hubKey()).update(encoded).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    if (p.k !== kind || !p.pid || !p.x || Date.now() > p.x) return null;
    return p;
  } catch (_) {
    return null;
  }
}

function hashCode(email, code) {
  return crypto.createHmac('sha256', hubKey()).update(`${email}:${code}`).digest('hex');
}

function cleanEmail(v) {
  return String(v || '').trim().toLowerCase().slice(0, 254);
}

function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pageUrl(slug) {
  return SITE + (PAGE_PATHS[slug] || '/tiktok-cohort');
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

// Accept tiktok.com links only (full links and the short vm./vt. share links).
function cleanVideoUrl(v) {
  const s = String(v || '').trim();
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  if (!(host === 'tiktok.com' || host.endsWith('.tiktok.com'))) return null;
  u.protocol = 'https:';
  return u.toString().slice(0, 500);
}

// Very light per-instance rate limit (resets on cold start).
const hits = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const r = hits.get(key);
  if (!r || now - r.t > windowMs) { hits.set(key, { t: now, n: 1 }); return false; }
  r.n += 1;
  return r.n > max;
}

// ---------------------------------------------------------------------------
// Email (Resend)
// ---------------------------------------------------------------------------
async function sendEmail({ to, subject, html, text }) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY missing');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], reply_to: 'liz@projectc.com', subject, html, text }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error('Resend: ' + JSON.stringify(data.error || data));
  return data;
}

// Resend's batch endpoint takes up to 100 emails in one request, which keeps big sends
// (85 welcome emails, Monday reminders) inside Netlify's time limit and Resend's rate limit.
async function sendEmailBatch(list) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY missing');
  const results = [];
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const res = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(chunk.map(({ to, subject, html, text }) => ({ from: FROM_EMAIL, to: [to], reply_to: 'liz@projectc.com', subject, html, text }))),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error('Resend batch: ' + JSON.stringify(data.error || data));
    results.push(...(data.data || []));
    if (i + 100 < list.length) await new Promise((r) => setTimeout(r, 600));
  }
  return results;
}

function emailShell(inner) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#ffffff;">
<div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:Inter,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#15171A;line-height:1.55;font-size:15px;">
  <div style="height:6px;background:linear-gradient(90deg,#00AEEF 0 25%,#EC008C 25% 50%,#FFE800 50% 75%,#15171A 75% 100%);margin-bottom:28px;"></div>
  ${inner}
  <div style="border-top:2px solid #15171A;margin-top:32px;padding-top:12px;font-size:12px;color:#5b5d60;">
    Project C &middot; building the future of independent creator journalism &middot; <a href="https://projectc.com" style="color:#B74D2F;">projectc.com</a>
  </div>
</div></body></html>`;
}

function codeEmail(name, code, programName) {
  const hi = firstName(name) ? `Hi ${esc(firstName(name))},` : 'Hi,';
  return {
    subject: `${code} is your sign-in code`,
    text: `${hi}\n\nYour sign-in code for the ${programName} hub is ${code}. It works for 15 minutes.\n\nIf you didn't ask for this, you can ignore this email.`,
    html: emailShell(`
      <p style="margin:0 0 16px;">${hi}</p>
      <p style="margin:0 0 16px;">Here is your sign-in code for the ${esc(programName)} hub. It works for 15 minutes.</p>
      <div style="font-family:Anton,Impact,sans-serif;font-size:44px;letter-spacing:10px;border:2px solid #15171A;padding:14px 18px;display:inline-block;margin:4px 0 20px;">${code}</div>
      <p style="margin:0;color:#5b5d60;font-size:13px;">If you didn't ask for this, you can ignore this email.</p>`),
  };
}

function fmtET(iso, opts) {
  return new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', ...opts });
}

function welcomeEmail(person, program, weeks, magicUrl) {
  const s = program.settings || {};
  const first = firstName(person.name);
  const w1 = weeks[0];
  const firstDay = w1 ? fmtET(w1.session_at, { weekday: 'long', month: 'long', day: 'numeric' }) : '';
  const prepDue = w1 && w1.due_at ? fmtET(w1.due_at, { weekday: 'long', month: 'short', day: 'numeric' }) + ' at ' + fmtET(w1.due_at, { hour: 'numeric', minute: '2-digit' }) + ' ET' : '';
  const hubUrl = pageUrl(program.slug);
  const welcomeLine = s.brandName ? `Welcome to ${s.brandName}, TikTok x Project C's News Creator Cohort!` : `Welcome to the ${program.name}!`;
  const rows = weeks.map((w) => `
      <tr>
        <td style="padding:8px 10px 8px 0;border-bottom:1px solid #e3e4e6;white-space:nowrap;font-weight:700;vertical-align:top;">${esc(fmtET(w.session_at, { weekday: 'short', month: 'short', day: 'numeric' }))}</td>
        <td style="padding:8px 0;border-bottom:1px solid #e3e4e6;vertical-align:top;">${esc(w.title)}</td>
      </tr>`).join('');
  const btn = (href, label) => `<a href="${esc(href)}" style="display:inline-block;background:#15171A;color:#ffffff;text-decoration:none;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:13px;padding:14px 22px;border:2px solid #15171A;">${label}</a>`;
  const zoomHtml = person.zoom_join_url
    ? `<p style="margin:0 0 8px;">Your personal Zoom link works for all five sessions. It's tied to you, so please don't share it.</p>
       <p style="margin:0 0 20px;"><a href="${esc(person.zoom_join_url)}" style="color:#B74D2F;word-break:break-all;">${esc(person.zoom_join_url)}</a></p>`
    : `<p style="margin:0 0 20px;">Your personal Zoom link is waiting for you on the hub.</p>`;
  const h5Line = s.h5Url
    ? `If you'd like to get it done early, you can <a href="${esc(s.h5Url)}" style="color:#B74D2F;">sign the terms now</a>.`
    : '';
  const fmtDay = (iso) => fmtET(iso, { weekday: 'long', month: 'short', day: 'numeric' });
  const fmtDue = (iso) => fmtDay(iso) + ' at ' + fmtET(iso, { hour: 'numeric', minute: '2-digit' }) + ' ET';
  const now = Date.now();
  // Creators added after session 1 has started get a version that points at the next session
  // and this week's homework instead of the pre-session-1 to-dos.
  const late = !!(w1 && now > Date.parse(w1.session_at) + 60 * 60000);
  const next = weeks.find((w) => Date.parse(w.session_at) + 60 * 60000 > now);
  const dueNow = weeks.find((w) => w.due_at && w.assignment && Date.parse(w.due_at) > now);
  const brandOrName = s.brandName ? `TikTok's ${s.brandName} News Creator Program` : program.name;
  let subject, introText, introHtml, boxTitle, items;
  if (!late) {
    subject = s.brandName
      ? `You're in: ${brandOrName} Starts ${w1 ? fmtDay(w1.session_at) : 'Soon'}`
      : `You're in: ${program.name} starts ${w1 ? fmtDay(w1.session_at) : 'soon'}`;
    introText = `${welcomeLine} We kick off ${firstDay} at 2:30 PM ET on Zoom.`;
    introHtml = `${esc(welcomeLine)} We kick off <strong>${esc(firstDay)} at 2:30 PM ET</strong> on Zoom.`;
    boxTitle = 'Before the first session';
    items = [
      { t: `Have your TikTok account ready. We'll sign the program terms together in the app during session 1.${s.h5Url ? ' To do it early, sign here: ' + s.h5Url : ''}`,
        h: `<strong>Have your TikTok account ready.</strong> We'll sign the program terms together in the app during session 1. ${h5Line}` },
      { t: `Share two TikTok creators who do news well, and tell us why. Submit them on your hub by ${prepDue}. We'll talk through some of your picks in session 1.`,
        h: `<strong>Share two TikTok creators who do news well, and tell us why.</strong> Submit them on your hub by ${esc(prepDue)}. We'll talk through some of your picks in session 1.` },
    ];
  } else {
    const nextDay = next ? fmtDay(next.session_at) : '';
    subject = `You're in: ${brandOrName}${next ? `, Next Session ${nextDay}` : ''}`;
    introText = `${welcomeLine} We're glad you're joining us. We meet Wednesdays at 2:30 PM ET on Zoom${next ? `, and the next session is ${nextDay}` : ''}. Replays of earlier sessions are on your hub.`;
    introHtml = `${esc(welcomeLine)} We're glad you're joining us. We meet Wednesdays at 2:30 PM ET on Zoom${next ? `, and the next session is <strong>${esc(nextDay)}</strong>` : ''}. Replays of earlier sessions are on your hub.`;
    boxTitle = 'To get started';
    items = [
      { t: `Sign the program terms in the TikTok app.${s.h5Url ? ' Sign here: ' + s.h5Url : ''}`,
        h: `<strong>Sign the program terms in the TikTok app.</strong>${s.h5Url ? ` <a href="${esc(s.h5Url)}" style="color:#B74D2F;">Sign them here</a>.` : ''}` },
    ];
    if (dueNow) items.push({
      t: `This week's homework: ${dueNow.assignment} Turn it in on your hub by ${fmtDue(dueNow.due_at)}.`,
      h: `<strong>This week's homework:</strong> ${esc(dueNow.assignment)} Turn it in on your hub by ${esc(fmtDue(dueNow.due_at))}.` });
  }
  return {
    // settings.brandName ("Inform the Feed") is the program name creators know from TikTok's invitations.
    subject,
    text: `Hi ${first},

${introText}

Everything for the program lives on one page, your Cohort Hub: your Zoom link, each week's homework, the schedule, replays and updates from us and TikTok. Open it here (this link signs you in):
${magicUrl}

${boxTitle}:

${items.map((it, i) => (i + 1) + '. ' + it.t).join('\n\n')}

${person.zoom_join_url ? 'Your personal Zoom link (works for all five sessions, please don\'t share it):\n' + person.zoom_join_url + '\n\n' : ''}How each week works: Homework is due Tuesdays at 12 PM ET. We send a reminder Monday morning, and we meet Wednesdays at 2:30 PM ET.

${weeks.map((w) => fmtET(w.session_at, { weekday: 'short', month: 'short', day: 'numeric' }) + '  ' + w.title).join('\n')}

After the sign-in link expires, go to ${hubUrl} and sign in with this email address. We'll send you a code.

Questions or trouble getting in? Email info@projectc.com and we'll sort it out.

See you Wednesday,
Liz Kelly Nelson
Project C`,
    html: emailShell(`
      <p style="margin:0 0 16px;">Hi ${esc(first)},</p>
      <p style="margin:0 0 16px;">${introHtml}</p>
      <p style="margin:0 0 20px;">Everything for the program lives on one page, your Cohort Hub: your Zoom link, each week's homework, the schedule, replays and updates from us and TikTok.</p>
      <p style="margin:0 0 28px;">${btn(magicUrl, 'Open your hub')}</p>
      <div style="border:2px solid #15171A;padding:18px 20px;margin:0 0 24px;">
        <p style="margin:0 0 12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;font-size:12px;">${esc(boxTitle)}</p>
        ${items.map((it, i) => `<p style="margin:0 0 ${i === items.length - 1 ? 0 : 12}px;">${i + 1}. ${it.h}</p>`).join('')}
      </div>
      ${zoomHtml}
      <p style="margin:0 0 6px;font-weight:700;">How each week works</p>
      <p style="margin:0 0 20px;">Homework is due Tuesdays at 12 PM ET. We send a reminder Monday morning, and we meet Wednesdays at 2:30 PM ET.</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;margin:0 0 20px;">${rows}</table>
      <p style="margin:0 0 20px;font-size:13px;color:#5b5d60;">The button above signs you in for the next two weeks. After that, go to <a href="${esc(hubUrl)}" style="color:#B74D2F;">${esc(hubUrl.replace('https://', ''))}</a> and sign in with this email address. We'll send you a code.</p>
      <p style="margin:0 0 20px;font-size:13px;color:#5b5d60;">Questions or trouble getting in? Email <a href="mailto:info@projectc.com" style="color:#B74D2F;">info@projectc.com</a> and we'll sort it out.</p>
      <p style="margin:0 0 4px;">See you Wednesday,</p>
      <p style="margin:0;">Liz Kelly Nelson<br><span style="color:#5b5d60;">Project C</span></p>`),
  };
}

// ---------------------------------------------------------------------------
// Cohort emails written in Tools (recaps, reminders)
// ---------------------------------------------------------------------------
// Staff write these in a light plain-text format so nobody has to touch HTML:
//   ## Heading                     a small all-caps section label
//   - item                         bullet list (consecutive lines)
//   **bold**, [link text](https://...), bare https:// links
//   [button: Label](https://...)   a black button, on its own line
// And these fill in per person:
//   {first}       first name
//   {hub_link}    one-click sign-in link to their hub
//   {qa_link}     same, but opens the Q&A tab
//   {homework}    on its own line: this week's homework with a button, or a thank-you if they've turned it in
//   {zoom}        on its own line: their personal Zoom link
const EMAIL_LINK = 'color:#B74D2F;';
function inlineHtml(s) {
  let out = esc(s);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, t, u) => `<a href="${u}" style="${EMAIL_LINK}">${t}</a>`);
  // Bare links that aren't already inside an href.
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<.,;:!?)'"])/g, (m, pre, u) => `${pre}<a href="${u}" style="${EMAIL_LINK}word-break:break-all;">${u}</a>`);
  return out;
}
function inlineText(s) {
  return String(s).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)');
}
function emailButton(href, label) {
  return `<a href="${esc(href)}" style="display:inline-block;background:#15171A;color:#ffffff;text-decoration:none;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:13px;padding:14px 22px;border:2px solid #15171A;">${esc(label)}</a>`;
}

// Turns the staff-written body into { html, text } for one person. blocks maps
// {homework} / {zoom} to ready-made { html, text } pieces.
function renderMarkup(body, vars, blocks) {
  const fill = (s) => s.replace(/\{(first|hub_link|qa_link)\}/g, (m, k) => vars[k] || '');
  const chunks = String(body || '').replace(/\r\n/g, '\n').split(/\n\s*\n/);
  const html = [];
  const text = [];
  for (const raw of chunks) {
    const lines = raw.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
    if (!lines.length) continue;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      const block = line.match(/^\{(homework|zoom)\}$/);
      if (block) {
        const b = blocks[block[1]];
        if (b) { html.push(b.html); text.push(b.text); }
        i++; continue;
      }
      const btn = fill(line).match(/^\[button:\s*([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/i);
      if (btn) {
        html.push(`<p style="margin:0 0 22px;">${emailButton(btn[2], btn[1].trim())}</p>`);
        text.push(`${btn[1].trim()}: ${btn[2]}`);
        i++; continue;
      }
      if (/^##\s+/.test(line)) {
        const h = fill(line.replace(/^##\s+/, ''));
        html.push(`<p style="margin:26px 0 8px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;font-size:12px;border-top:2px solid #15171A;padding-top:12px;">${inlineHtml(h)}</p>`);
        text.push(h.toUpperCase());
        i++; continue;
      }
      if (/^[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) { items.push(fill(lines[i].trim().replace(/^[-*]\s+/, ''))); i++; }
        html.push(`<ul style="margin:0 0 16px;padding-left:20px;">${items.map((it) => `<li style="margin:0 0 8px;">${inlineHtml(it)}</li>`).join('')}</ul>`);
        text.push(items.map((it) => '- ' + inlineText(it)).join('\n'));
        continue;
      }
      // Paragraph: this line plus any following plain lines in the same chunk.
      const para = [fill(line)];
      i++;
      while (i < lines.length && !/^(##\s+|[-*]\s+|\{(homework|zoom)\}$|\[button:)/i.test(lines[i].trim())) { para.push(fill(lines[i].trim())); i++; }
      html.push(`<p style="margin:0 0 16px;">${para.map(inlineHtml).join('<br>')}</p>`);
      text.push(para.map(inlineText).join('\n'));
    }
  }
  return { html: html.join('\n'), text: text.join('\n\n') };
}

// One cohort email for one person. `subs` is the set of week ids they've turned in.
function cohortEmail(draft, person, program, weeks, subs, magicUrl, copyNote) {
  const now = Date.now();
  const due = weeks.find((w) => w.due_at && w.assignment && Date.parse(w.due_at) > now);
  const fmtDue = (iso) => fmtET(iso, { weekday: 'long', month: 'short', day: 'numeric' }) + ' at ' + fmtET(iso, { hour: 'numeric', minute: '2-digit' }) + ' ET';
  const hubLink = magicUrl;
  const qaLink = magicUrl.includes('#') ? magicUrl + '&go=qa' : magicUrl + '#go=qa';
  const blocks = {};
  if (due) {
    const done = subs.has(due.id);
    blocks.homework = done
      ? { html: `<div style="border:2px solid #15171A;padding:16px 18px;margin:0 0 22px;background:#F4F6F5;"><p style="margin:0;"><strong>Week ${due.week_number} homework: you're all set.</strong> Thanks for turning it in. You can still change it on your hub until ${esc(fmtDue(due.due_at))}.</p></div>`,
          text: `Week ${due.week_number} homework: you're all set. Thanks for turning it in. You can still change it on your hub until ${fmtDue(due.due_at)}.` }
      : { html: `<div style="border:2px solid #15171A;padding:16px 18px;margin:0 0 22px;"><p style="margin:0 0 6px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;font-size:12px;">Week ${due.week_number} homework &middot; due ${esc(fmtDue(due.due_at))}</p><p style="margin:0 0 14px;">${esc(due.assignment)}</p>${emailButton(hubLink + (hubLink.includes('#') ? '&go=homework' : '#go=homework'), 'Turn it in')}</div>`,
          text: `WEEK ${due.week_number} HOMEWORK, due ${fmtDue(due.due_at)}\n${due.assignment}\nTurn it in: ${hubLink}` };
  }
  blocks.zoom = person.zoom_join_url
    ? { html: `<p style="margin:0 0 16px;">Your personal Zoom link works for every session. It's tied to you, so please don't share it:<br><a href="${esc(person.zoom_join_url)}" style="${EMAIL_LINK}word-break:break-all;">${esc(person.zoom_join_url)}</a></p>`,
        text: `Your personal Zoom link works for every session (please don't share it):\n${person.zoom_join_url}` }
    : { html: `<p style="margin:0 0 16px;">Your personal Zoom link is on your hub.</p>`, text: 'Your personal Zoom link is on your hub.' };
  const vars = { first: firstName(person.name), hub_link: hubLink, qa_link: qaLink };
  const r = renderMarkup(draft.body, vars, blocks);
  const subject = String(draft.subject || '').replace(/\{first\}/g, vars.first);
  const footHtml = `<p style="margin:24px 0 0;font-size:13px;color:#5b5d60;">Questions or trouble getting in? Email <a href="mailto:info@projectc.com" style="${EMAIL_LINK}">info@projectc.com</a> and we'll sort it out.</p>`;
  return {
    subject,
    html: emailShell((copyNote ? `<div style="background:#FFE800;border:2px solid #15171A;padding:12px 14px;margin:0 0 22px;font-size:13px;line-height:1.5;">${esc(copyNote)}</div>` : '') + r.html + footHtml),
    text: (copyNote ? copyNote + '\n\n----\n\n' : '') + r.text + '\n\nQuestions or trouble getting in? Email info@projectc.com and we\'ll sort it out.',
  };
}

function shapeDraft(d) {
  return { id: d.id, subject: d.subject, body: d.body, updatedAt: d.updatedAt, createdAt: d.createdAt, sentAt: d.sentAt || null, sentCount: d.sentCount || 0, sentBy: d.sentBy || null, sending: !!d.sending, failed: d.failed || [], copies: d.copies || [] };
}

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------
let zoomTokenCache = { token: null, exp: 0 };

async function zoomToken() {
  const { ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET } = process.env;
  if (!ZOOM_ACCOUNT_ID || !ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET) throw new Error('Zoom credentials missing');
  if (zoomTokenCache.token && Date.now() < zoomTokenCache.exp - 60000) return zoomTokenCache.token;
  const basic = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(ZOOM_ACCOUNT_ID)}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}` },
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error('Zoom token: ' + JSON.stringify(data));
  zoomTokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return data.access_token;
}

async function zoomRegister(meetingId, person) {
  const token = await zoomToken();
  const parts = String(person.name || '').trim().split(/\s+/);
  const first = parts.shift() || person.email.split('@')[0];
  const last = parts.join(' ') || '-';
  const res = await fetch(`https://api.zoom.us/v2/meetings/${meetingId}/registrants`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: person.email, first_name: first.slice(0, 64), last_name: last.slice(0, 64), auto_approve: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.join_url) throw new Error('Zoom register: ' + res.status + ' ' + JSON.stringify(data));
  return { registrant_id: data.registrant_id || data.id || null, join_url: data.join_url };
}

async function zoomCancel(meetingId, person) {
  if (!person.zoom_registrant_id) return;
  const token = await zoomToken();
  const res = await fetch(`https://api.zoom.us/v2/meetings/${meetingId}/registrants/status`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'cancel', registrants: [{ id: person.zoom_registrant_id, email: person.email }] }),
  });
  if (!res.ok && res.status !== 204) {
    const t = await res.text();
    throw new Error('Zoom cancel: ' + res.status + ' ' + t);
  }
}

async function ensureZoomLink(supabase, program, person) {
  if (person.zoom_join_url || !program.zoom_meeting_id || person.status !== 'active') return person;
  try {
    const z = await zoomRegister(program.zoom_meeting_id, person);
    await supabase.from('hub_people').update({ zoom_join_url: z.join_url, zoom_registrant_id: z.registrant_id }).eq('id', person.id);
    return { ...person, zoom_join_url: z.join_url, zoom_registrant_id: z.registrant_id };
  } catch (err) {
    console.error('cohort-hub zoom register failed for', person.email, err.message);
    return person;
  }
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadProgram(supabase, slug) {
  const { data, error } = await supabase.from('hub_programs').select('*').eq('slug', slug || DEFAULT_PROGRAM).maybeSingle();
  if (error) throw error;
  return data;
}

async function loadSession(supabase, token) {
  const t = readToken(token, 's');
  if (!t) return { error: 'expired' };
  const { data: person, error } = await supabase.from('hub_people').select('*').eq('id', t.pid).maybeSingle();
  if (error) throw error;
  if (!person || person.status !== 'active') return { error: 'expired' };
  const { data: program } = await supabase.from('hub_programs').select('*').eq('id', person.program_id).maybeSingle();
  if (!program) return { error: 'expired' };
  if (person.role === 'creator' && Date.now() > Date.parse(program.access_ends_at)) return { error: 'closed' };
  return { person, program };
}

function sessionTokenFor(person, program) {
  const cap = person.role === 'creator' ? Date.parse(program.access_ends_at) : Infinity;
  return signToken({ k: 's', pid: person.id, x: Math.min(Date.now() + SESSION_TTL_MS, cap) });
}

function publicPerson(p) {
  return { id: p.id, name: p.name, firstName: firstName(p.name), email: p.email, tiktokHandle: p.tiktok_handle, role: p.role, consented: !!p.consent_at, zoomJoinUrl: p.zoom_join_url };
}

function publicProgram(program) {
  const s = program.settings || {};
  return {
    slug: program.slug, name: program.name, partner: program.partner,
    startsOn: program.starts_on, endsOn: program.ends_on, accessEndsAt: program.access_ends_at,
    kicker: s.kicker, welcome: s.welcome, commitment: s.commitment || [], whatItCanLeadTo: s.whatItCanLeadTo,
    consentText: s.consentText, sessionTime: s.sessionTime, slackUrl: s.slackUrl, h5Url: s.h5Url,
    incentives: s.incentives, contacts: s.contacts || [], resources: s.resources || [],
    todos: s.todos || [], rhythm: s.rhythm || [],
    completionMin: s.completionMin || null,
    updates: (s.updates || []).slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
    qa: sortQa(s.qa || []),
  };
}

// Q&A: newest session first, then the order they were added.
function sortQa(list) {
  return list.slice().sort((a, b) => (b.week || 0) - (a.week || 0) || (a.order || 0) - (b.order || 0) || Date.parse(a.at) - Date.parse(b.at))
    .map((x) => ({ id: x.id, week: x.week, q: x.q, a: x.a, at: x.at }));
}

async function loadWeeks(supabase, programId) {
  const { data: weeks, error } = await supabase.from('hub_weeks').select('*').eq('program_id', programId).order('week_number');
  if (error) throw error;
  const ids = weeks.map((w) => w.id);
  const { data: items } = ids.length
    ? await supabase.from('hub_checklist_items').select('*').in('week_id', ids).order('position')
    : { data: [] };
  return weeks.map((w) => ({ ...w, items: (items || []).filter((i) => i.week_id === w.id) }));
}

function shapeWeek(w, mine) {
  return {
    id: w.id, number: w.week_number, kind: w.kind || 'video', sessionAt: w.session_at, title: w.title, presenters: w.presenters, guests: w.guests,
    summary: w.summary, assignment: w.assignment, dueAt: w.due_at, replayUrl: w.replay_url, slidesUrl: w.slides_url,
    resources: w.resources || [],
    items: w.items.map((i) => ({ id: i.id, label: i.label, link: i.link_url, kind: i.kind, done: !!(mine && mine.done.has(i.id)) })),
    submission: mine && mine.subs.get(w.id) ? shapeSub(mine.subs.get(w.id), w) : null,
    attendedMinutes: mine && mine.att.has(w.id) ? mine.att.get(w.id) : null,
  };
}

function shapeSub(s, w) {
  return { id: s.id, url: s.video_url, links: s.links || [], note: s.note, submittedAt: s.submitted_at, late: !!(w.due_at && Date.parse(s.submitted_at) > Date.parse(w.due_at)), critiquePick: s.critique_pick, featured: s.featured, reviewerNote: s.reviewer_note };
}

async function loadMine(supabase, personId, weekIds) {
  const [done, subs, att] = await Promise.all([
    supabase.from('hub_checklist_done').select('item_id').eq('person_id', personId),
    supabase.from('hub_submissions').select('*').eq('person_id', personId),
    supabase.from('hub_attendance').select('week_id, minutes').eq('person_id', personId),
  ]);
  return {
    done: new Set((done.data || []).map((d) => d.item_id)),
    subs: new Map((subs.data || []).filter((s) => weekIds.includes(s.week_id)).map((s) => [s.week_id, s])),
    att: new Map((att.data || []).map((a) => [a.week_id, a.minutes])),
  };
}

async function progressTable(supabase, program, weeks, viewerRole) {
  const { data: people } = await supabase.from('hub_people').select('*').eq('program_id', program.id).eq('role', 'creator').order('name');
  const ids = (people || []).map((p) => p.id);
  const weekIds = weeks.map((w) => w.id);
  const itemIds = weeks.flatMap((w) => w.items.map((i) => i.id));
  const [subs, done, att] = ids.length
    ? await Promise.all([
        supabase.from('hub_submissions').select('*').in('person_id', ids),
        itemIds.length ? supabase.from('hub_checklist_done').select('person_id, item_id').in('person_id', ids) : { data: [] },
        supabase.from('hub_attendance').select('person_id, week_id, minutes').in('person_id', ids),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }];
  const itemWeek = new Map(weeks.flatMap((w) => w.items.map((i) => [i.id, w.id])));
  return (people || []).map((p) => {
    const row = {
      id: p.id, name: p.name, tiktokHandle: p.tiktok_handle, status: p.status,
      consented: !!p.consent_at, lastLoginAt: p.last_login_at, weeks: {},
    };
    if (viewerRole === 'staff') {
      row.email = p.email;
      row.welcomeSent = !!p.welcome_sent_at;
      row.zoomLinked = !!p.zoom_join_url;
      row.dateAdded = p.date_added || (p.added_at ? p.added_at.slice(0, 10) : null);
      row.roleLabel = p.role_label;
      row.employer = p.employer;
    }
    for (const w of weeks) {
      const s = (subs.data || []).find((x) => x.person_id === p.id && x.week_id === w.id);
      const doneCount = (done.data || []).filter((d) => d.person_id === p.id && itemWeek.get(d.item_id) === w.id).length;
      const a = (att.data || []).find((x) => x.person_id === p.id && x.week_id === w.id);
      row.weeks[w.id] = {
        submission: s ? shapeSub(s, w) : null,
        checklist: { done: doneCount, total: w.items.length },
        attendedMinutes: a ? a.minutes : null,
      };
    }
    return row;
  }).filter((r) => r.status === 'active' || viewerRole === 'staff');
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !BASE_SECRET) {
    console.error('cohort-hub: missing env vars');
    return json(500, { error: 'The hub is not configured yet.' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (_) { return json(400, { error: 'Could not read request.' }); }
  const ip = event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'unknown';
  if (rateLimited('ip:' + ip, 120, 60000)) return json(429, { error: 'Too many requests. Wait a minute and try again.' });

  const supabase = db();
  const action = body.action;

  try {
    // ---------------- sign in ----------------
    if (action === 'request_code') {
      const email = cleanEmail(body.email);
      if (!isEmail(email)) return json(200, { ok: false, reason: 'invalid_email' });
      if (rateLimited('code:' + email, 3, 60000)) return json(429, { error: 'Give it a minute before asking for another code.' });
      const program = await loadProgram(supabase, body.program);
      if (!program) return json(200, { ok: false, reason: 'not_found' });
      const { data: person } = await supabase.from('hub_people').select('*').eq('program_id', program.id).eq('email', email).eq('status', 'active').maybeSingle();
      if (!person) return json(200, { ok: false, reason: 'not_found' });
      if (person.role === 'creator' && Date.now() > Date.parse(program.access_ends_at)) return json(200, { ok: false, reason: 'closed' });
      const since = new Date(Date.now() - 3600000).toISOString();
      const { count } = await supabase.from('hub_login_codes').select('id', { count: 'exact', head: true }).eq('program_id', program.id).eq('email', email).gte('created_at', since);
      if ((count || 0) >= MAX_CODES_PER_HOUR) return json(429, { error: 'That’s a lot of codes. Use the newest one in your inbox, or try again in an hour.' });
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      await supabase.from('hub_login_codes').insert({ program_id: program.id, email, code_hash: hashCode(email, code), expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString() });
      const m = codeEmail(person.name, code, program.name);
      await sendEmail({ to: email, ...m });
      return json(200, { ok: true });
    }

    if (action === 'verify_code') {
      const email = cleanEmail(body.email);
      const code = String(body.code || '').replace(/\D/g, '');
      if (!isEmail(email) || code.length !== 6) return json(200, { ok: false, reason: 'bad_code' });
      const program = await loadProgram(supabase, body.program);
      if (!program) return json(200, { ok: false, reason: 'bad_code' });
      const { data: rows } = await supabase.from('hub_login_codes').select('*').eq('program_id', program.id).eq('email', email).is('used_at', null).order('created_at', { ascending: false }).limit(1);
      const row = rows && rows[0];
      if (!row || Date.now() > Date.parse(row.expires_at)) return json(200, { ok: false, reason: 'expired_code' });
      if (row.attempts >= MAX_CODE_ATTEMPTS) return json(200, { ok: false, reason: 'too_many' });
      const good = crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(hashCode(email, code)));
      if (!good) {
        await supabase.from('hub_login_codes').update({ attempts: row.attempts + 1 }).eq('id', row.id);
        return json(200, { ok: false, reason: row.attempts + 1 >= MAX_CODE_ATTEMPTS ? 'too_many' : 'bad_code' });
      }
      await supabase.from('hub_login_codes').update({ used_at: new Date().toISOString() }).eq('id', row.id);
      const { data: person } = await supabase.from('hub_people').select('*').eq('program_id', program.id).eq('email', email).eq('status', 'active').maybeSingle();
      if (!person) return json(200, { ok: false, reason: 'not_found' });
      await supabase.from('hub_people').update({ last_login_at: new Date().toISOString() }).eq('id', person.id);
      return json(200, { ok: true, token: sessionTokenFor(person, program) });
    }

    if (action === 'magic') {
      const t = readToken(body.link, 'm');
      if (!t) return json(200, { ok: false, reason: 'link_expired' });
      const { data: person } = await supabase.from('hub_people').select('*').eq('id', t.pid).eq('status', 'active').maybeSingle();
      if (!person) return json(200, { ok: false, reason: 'link_expired' });
      const { data: program } = await supabase.from('hub_programs').select('*').eq('id', person.program_id).maybeSingle();
      if (person.role === 'creator' && Date.now() > Date.parse(program.access_ends_at)) return json(200, { ok: false, reason: 'closed' });
      await supabase.from('hub_people').update({ last_login_at: new Date().toISOString() }).eq('id', person.id);
      return json(200, { ok: true, token: sessionTokenFor(person, program) });
    }

    // ---------------- everything below needs a session ----------------
    const sess = await loadSession(supabase, body.token);
    if (sess.error) return json(401, { error: sess.error });
    let { person, program } = sess;
    const isStaff = person.role === 'staff';
    const canSeeTable = person.role === 'staff' || person.role === 'partner';

    if (action === 'hub') {
      if (person.role !== 'staff' || !/^liz@/i.test(person.email)) person = await ensureZoomLink(supabase, program, person);
      const weeks = await loadWeeks(supabase, program.id);
      const mine = await loadMine(supabase, person.id, weeks.map((w) => w.id));
      // Featured videos: whatever staff have starred, newest week first.
      const { data: feat } = await supabase.from('hub_submissions')
        .select('video_url, week_id, hub_people!hub_submissions_person_id_fkey!inner(name, tiktok_handle, program_id, status)')
        .eq('featured', true).eq('hub_people.program_id', program.id).eq('hub_people.status', 'active');
      const weekNo = new Map(weeks.map((w) => [w.id, w.week_number]));
      const featured = (feat || [])
        .map((f) => ({ url: f.video_url, week: weekNo.get(f.week_id), name: f.hub_people.name, tiktokHandle: f.hub_people.tiktok_handle }))
        .sort((a, b) => b.week - a.week)
        .slice(0, 6);
      return json(200, {
        ok: true,
        me: publicPerson(person),
        program: publicProgram(program),
        weeks: weeks.map((w) => shapeWeek(w, mine)),
        featured,
        emails: person.role === 'staff' ? ((program.settings || {}).emails || []).map(shapeDraft).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)) : undefined,
        now: new Date().toISOString(),
      });
    }

    if (action === 'consent') {
      if (!person.consent_at) await supabase.from('hub_people').update({ consent_at: new Date().toISOString() }).eq('id', person.id);
      return json(200, { ok: true });
    }

    if (action === 'check') {
      const { data: item } = await supabase.from('hub_checklist_items').select('id, week_id, hub_weeks!inner(program_id)').eq('id', body.itemId).maybeSingle();
      if (!item || item.hub_weeks.program_id !== program.id) return json(404, { error: 'Not found' });
      if (body.done) await supabase.from('hub_checklist_done').upsert({ person_id: person.id, item_id: item.id });
      else await supabase.from('hub_checklist_done').delete().eq('person_id', person.id).eq('item_id', item.id);
      return json(200, { ok: true });
    }

    if (action === 'submit') {
      if (person.role !== 'creator' && !isStaff) return json(403, { error: 'Only creators turn in homework.' });
      const { data: week } = await supabase.from('hub_weeks').select('*').eq('id', body.weekId).eq('program_id', program.id).maybeSingle();
      if (!week) return json(404, { error: 'Not found' });
      let url = null;
      let links = [];
      let note = String(body.note || '').trim().slice(0, 2000) || null;
      if ((week.kind || 'video') === 'links') {
        links = (Array.isArray(body.links) ? body.links : []).map(cleanVideoUrl).filter(Boolean).slice(0, 3);
        if (!links.length) return json(200, { ok: false, reason: 'bad_links' });
        if (!note) return json(200, { ok: false, reason: 'need_why' });
        url = links[0];
      } else {
        url = cleanVideoUrl(body.url);
        if (!url) return json(200, { ok: false, reason: 'bad_url' });
      }
      const { data: existing } = await supabase.from('hub_submissions').select('id').eq('person_id', person.id).eq('week_id', week.id).maybeSingle();
      const nowIso = new Date().toISOString();
      const { data: saved, error } = existing
        ? await supabase.from('hub_submissions').update({ video_url: url, links, note, updated_at: nowIso }).eq('id', existing.id).select().single()
        : await supabase.from('hub_submissions').insert({ person_id: person.id, week_id: week.id, video_url: url, links, note }).select().single();
      if (error) throw error;
      // Tick the week's "submit" checklist item automatically.
      const { data: submitItems } = await supabase.from('hub_checklist_items').select('id').eq('week_id', week.id).eq('kind', 'submit');
      if (submitItems && submitItems.length) {
        await supabase.from('hub_checklist_done').upsert(submitItems.map((i) => ({ person_id: person.id, item_id: i.id })));
      }
      return json(200, { ok: true, submission: shapeSub(saved, week) });
    }

    // ---------------- partner + staff ----------------
    if (action === 'progress') {
      if (!canSeeTable) return json(403, { error: 'Not allowed' });
      const weeks = await loadWeeks(supabase, program.id);
      const rows = await progressTable(supabase, program, weeks, person.role);
      return json(200, { ok: true, weeks: weeks.map((w) => ({ id: w.id, number: w.week_number, title: w.title, dueAt: w.due_at, sessionAt: w.session_at, items: w.items.length, hasAssignment: !!w.assignment, kind: w.kind || 'video', attendancePulled: !!w.attendance_pulled_at })), rows });
    }

    // ---------------- staff only ----------------
    if (!isStaff) return json(403, { error: 'Not allowed' });

    if (action === 'roster_add') {
      const email = cleanEmail(body.email);
      const name = String(body.name || '').trim().slice(0, 120);
      const handle = String(body.tiktokHandle || '').trim().replace(/^@+/, '').slice(0, 60) || null;
      const role = ['creator', 'staff', 'partner'].includes(body.role) ? body.role : 'creator';
      if (!isEmail(email) || !name) return json(200, { ok: false, reason: 'missing' });
      const { data: existing } = await supabase.from('hub_people').select('*').eq('program_id', program.id).eq('email', email).maybeSingle();
      let row;
      if (existing) {
        const { data } = await supabase.from('hub_people').update({ name, tiktok_handle: handle || existing.tiktok_handle, role, status: 'active' }).eq('id', existing.id).select().single();
        row = data;
      } else {
        const { data, error } = await supabase.from('hub_people').insert({ program_id: program.id, email, name, tiktok_handle: handle, role, date_added: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) }).select().single();
        if (error) throw error;
        row = data;
      }
      if (row.role === 'creator') row = await ensureZoomLink(supabase, program, row);
      return json(200, { ok: true, person: { id: row.id, name: row.name, email: row.email, zoomLinked: !!row.zoom_join_url } });
    }

    if (action === 'roster_remove') {
      const { data: target } = await supabase.from('hub_people').select('*').eq('id', body.personId).eq('program_id', program.id).maybeSingle();
      if (!target) return json(404, { error: 'Not found' });
      if (target.id === person.id) return json(200, { ok: false, reason: 'self' });
      await supabase.from('hub_people').update({ status: 'removed' }).eq('id', target.id);
      try { await zoomCancel(program.zoom_meeting_id, target); } catch (e) { console.error(e.message); }
      return json(200, { ok: true });
    }

    if (action === 'roster_restore') {
      await supabase.from('hub_people').update({ status: 'active', zoom_join_url: null, zoom_registrant_id: null }).eq('id', body.personId).eq('program_id', program.id);
      const { data: target } = await supabase.from('hub_people').select('*').eq('id', body.personId).maybeSingle();
      if (target) await ensureZoomLink(supabase, program, target);
      return json(200, { ok: true });
    }

    if (action === 'review_queue') {
      // Everything Liz and Blair need to review one week's homework.
      const { data: week } = await supabase.from('hub_weeks').select('*').eq('id', body.weekId).eq('program_id', program.id).maybeSingle();
      if (!week) return json(404, { error: 'Not found' });
      const { data: subs } = await supabase.from('hub_submissions')
        .select('*, hub_people!hub_submissions_person_id_fkey!inner(id, name, tiktok_handle, status, program_id)')
        .eq('week_id', week.id).eq('hub_people.program_id', program.id);
      const live = (subs || []).filter((x) => x.hub_people.status === 'active');
      const ids = live.map((x) => x.id);
      const { data: reviews } = ids.length ? await supabase.from('hub_reviews').select('*').in('submission_id', ids) : { data: [] };
      const { data: staff } = await supabase.from('hub_people').select('id, name').eq('program_id', program.id).eq('role', 'staff').eq('status', 'active');
      const staffName = new Map((staff || []).map((p) => [p.id, firstName(p.name)]));
      const { count: creators } = await supabase.from('hub_people').select('id', { count: 'exact', head: true }).eq('program_id', program.id).eq('role', 'creator').eq('status', 'active');
      return json(200, {
        ok: true,
        meId: person.id,
        creators: creators || 0,
        week: { id: week.id, number: week.week_number, kind: week.kind || 'video', title: week.title, dueAt: week.due_at, assignment: week.assignment },
        reviewers: (staff || []).map((p) => ({ id: p.id, name: firstName(p.name) })),
        items: live.map((x) => ({
          ...shapeSub(x, week),
          creator: { id: x.hub_people.id, name: x.hub_people.name, tiktokHandle: x.hub_people.tiktok_handle },
          reviews: (reviews || []).filter((r) => r.submission_id === x.id).map((r) => ({ reviewerId: r.reviewer_id, name: staffName.get(r.reviewer_id) || 'Staff', vote: r.vote, note: r.note, updatedAt: r.updated_at })),
        })).sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt)),
      });
    }

    if (action === 'review_vote') {
      const { data: sub } = await supabase.from('hub_submissions').select('id, hub_people!hub_submissions_person_id_fkey!inner(program_id)').eq('id', body.submissionId).maybeSingle();
      if (!sub || sub.hub_people.program_id !== program.id) return json(404, { error: 'Not found' });
      const { data: existing } = await supabase.from('hub_reviews').select('*').eq('submission_id', sub.id).eq('reviewer_id', person.id).maybeSingle();
      const row = {
        submission_id: sub.id,
        reviewer_id: person.id,
        vote: typeof body.vote === 'boolean' ? body.vote : !!(existing && existing.vote),
        note: typeof body.note === 'string' ? (body.note.trim().slice(0, 4000) || null) : (existing ? existing.note : null),
        updated_at: new Date().toISOString(),
      };
      await supabase.from('hub_reviews').upsert(row);
      return json(200, { ok: true });
    }

    if (action === 'review') {
      const patch = {};
      if (typeof body.critiquePick === 'boolean') patch.critique_pick = body.critiquePick;
      if (typeof body.featured === 'boolean') patch.featured = body.featured;
      if (typeof body.reviewerNote === 'string') patch.reviewer_note = body.reviewerNote.slice(0, 2000) || null;
      const { data: sub } = await supabase.from('hub_submissions').select('id, hub_people!hub_submissions_person_id_fkey!inner(program_id)').eq('id', body.submissionId).maybeSingle();
      if (!sub || sub.hub_people.program_id !== program.id) return json(404, { error: 'Not found' });
      await supabase.from('hub_submissions').update(patch).eq('id', sub.id);
      return json(200, { ok: true });
    }

    if (action === 'week_update') {
      const allowed = ['title', 'presenters', 'guests', 'summary', 'assignment', 'replay_url', 'slides_url'];
      const patch = {};
      for (const k of allowed) if (typeof body.fields?.[k] === 'string') patch[k] = body.fields[k].trim().slice(0, 4000) || null;
      if (!Object.keys(patch).length) return json(200, { ok: false, reason: 'nothing' });
      await supabase.from('hub_weeks').update(patch).eq('id', body.weekId).eq('program_id', program.id);
      return json(200, { ok: true });
    }

    if (action === 'send_welcome') {
      // Sends to everyone (creators) who hasn't had one yet, or to one person if personId is given.
      let q = supabase.from('hub_people').select('*').eq('program_id', program.id).eq('status', 'active').eq('role', 'creator');
      q = body.personId ? q.eq('id', body.personId) : q.is('welcome_sent_at', null);
      const { data: targets } = await q;
      const weeks = await loadWeeks(supabase, program.id);
      const ready = [];
      for (let t of targets || []) {
        t = await ensureZoomLink(supabase, program, t);
        const link = signToken({ k: 'm', pid: t.id, x: Math.min(Date.now() + MAGIC_TTL_MS, Date.parse(program.access_ends_at)) });
        ready.push({ person: t, msg: { to: t.email, ...welcomeEmail(t, program, weeks, `${pageUrl(program.slug)}#signin=${link}`) } });
      }
      if (!ready.length) return json(200, { ok: true, sent: 0, failed: [] });
      try {
        await sendEmailBatch(ready.map((r) => r.msg));
      } catch (e) {
        console.error('welcome batch failed', e.message);
        return json(200, { ok: true, sent: 0, failed: ready.map((r) => r.person.email) });
      }
      await supabase.from('hub_people').update({ welcome_sent_at: new Date().toISOString() }).in('id', ready.map((r) => r.person.id));
      return json(200, { ok: true, sent: ready.length, failed: [] });
    }

    if (action === 'post_todo' || action === 'delete_todo') {
      // Pinned to-dos at the top of every creator's hub: [{ id, text, note, due, linkUrl, linkLabel }].
      const { data: fresh } = await supabase.from('hub_programs').select('settings').eq('id', program.id).single();
      const settings = fresh.settings || {};
      let todos = Array.isArray(settings.todos) ? settings.todos : [];
      if (action === 'post_todo') {
        const text = String(body.text || '').trim().slice(0, 200);
        if (!text) return json(200, { ok: false, reason: 'empty' });
        let linkUrl = String(body.linkUrl || '').trim().slice(0, 1000) || null;
        if (linkUrl && !/^https?:\/\//i.test(linkUrl)) linkUrl = null;
        const due = body.due && !Number.isNaN(Date.parse(body.due)) ? new Date(body.due).toISOString() : null;
        todos.push({ id: crypto.randomUUID(), text, note: String(body.note || '').trim().slice(0, 600) || null, due, linkUrl, linkLabel: String(body.linkLabel || '').trim().slice(0, 60) || null });
      } else {
        todos = todos.filter((t) => t.id !== body.todoId);
      }
      await supabase.from('hub_programs').update({ settings: { ...settings, todos } }).eq('id', program.id);
      return json(200, { ok: true, todos });
    }

    if (action === 'send_welcome_test') {
      // Sends the creator welcome email to the staff member who pressed the button, so it can be checked first.
      const weeks = await loadWeeks(supabase, program.id);
      const link = signToken({ k: 'm', pid: person.id, x: Date.now() + MAGIC_TTL_MS });
      const sample = { ...person, zoom_join_url: person.zoom_join_url || 'https://us06web.zoom.us/w/82615123795?tk=EACH-CREATOR-GETS-THEIR-OWN-LINK' };
      const m = welcomeEmail(sample, program, weeks, `${pageUrl(program.slug)}#signin=${link}`);
      await sendEmail({ to: person.email, subject: '[Test] ' + m.subject, html: m.html, text: m.text });
      return json(200, { ok: true, to: person.email });
    }

    if (action === 'post_update' || action === 'delete_update') {
      // Updates live in hub_programs.settings.updates as [{ id, at, title, body, by }].
      const { data: fresh } = await supabase.from('hub_programs').select('settings').eq('id', program.id).single();
      const settings = fresh.settings || {};
      let updates = Array.isArray(settings.updates) ? settings.updates : [];
      if (action === 'post_update') {
        const title = String(body.title || '').trim().slice(0, 140);
        const text = String(body.body || '').trim().slice(0, 4000);
        if (!title && !text) return json(200, { ok: false, reason: 'empty' });
        updates.push({ id: crypto.randomUUID(), at: new Date().toISOString(), title, body: text, by: firstName(person.name) });
      } else {
        updates = updates.filter((u) => u.id !== body.updateId);
      }
      await supabase.from('hub_programs').update({ settings: { ...settings, updates } }).eq('id', program.id);
      return json(200, { ok: true, updates: updates.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) });
    }

    if (action === 'qa_save' || action === 'qa_delete') {
      // Q&A lives in hub_programs.settings.qa as [{ id, week, q, a, order, at }].
      const { data: fresh } = await supabase.from('hub_programs').select('settings').eq('id', program.id).single();
      const settings = fresh.settings || {};
      let qa = Array.isArray(settings.qa) ? settings.qa : [];
      if (action === 'qa_save') {
        const q = String(body.q || '').trim().slice(0, 300);
        const a = String(body.a || '').trim().slice(0, 8000);
        const week = parseInt(body.week, 10) || null;
        if (!q || !a) return json(200, { ok: false, reason: 'empty' });
        const existing = body.id ? qa.find((x) => x.id === body.id) : null;
        if (existing) Object.assign(existing, { q, a, week, editedAt: new Date().toISOString() });
        else qa.push({ id: crypto.randomUUID().slice(0, 8), week, q, a, order: qa.filter((x) => x.week === week).length, at: new Date().toISOString(), by: firstName(person.name) });
      } else {
        qa = qa.filter((x) => x.id !== body.id);
      }
      await supabase.from('hub_programs').update({ settings: { ...settings, qa } }).eq('id', program.id);
      return json(200, { ok: true, qa: sortQa(qa) });
    }

    // ---------------- cohort emails (draft, preview, test, send) ----------------
    if (['email_save', 'email_delete', 'email_preview', 'email_test', 'email_send'].includes(action)) {
      const { data: fresh } = await supabase.from('hub_programs').select('settings').eq('id', program.id).single();
      const settings = fresh.settings || {};
      let emails = Array.isArray(settings.emails) ? settings.emails : [];
      // Re-read before writing so a send that takes a few seconds can't undo an update or Q&A posted meanwhile.
      const saveAll = async (list) => {
        const { data: now2 } = await supabase.from('hub_programs').select('settings').eq('id', program.id).single();
        await supabase.from('hub_programs').update({ settings: { ...(now2.settings || {}), emails: list } }).eq('id', program.id);
      };
      const list = () => emails.map(shapeDraft).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

      if (action === 'email_save') {
        const subject = String(body.subject || '').trim().slice(0, 200);
        const text = String(body.body || '').slice(0, 20000);
        if (!subject || !text.trim()) return json(200, { ok: false, reason: 'empty' });
        const nowIso = new Date().toISOString();
        let d = body.id ? emails.find((x) => x.id === body.id) : null;
        if (d && (d.sentAt || d.sending)) return json(200, { ok: false, reason: 'already_sent' });
        if (d) Object.assign(d, { subject, body: text, updatedAt: nowIso, editedBy: firstName(person.name) });
        else { d = { id: crypto.randomUUID(), subject, body: text, createdAt: nowIso, updatedAt: nowIso, createdBy: firstName(person.name) }; emails.push(d); }
        await saveAll(emails);
        return json(200, { ok: true, id: d.id, emails: list() });
      }

      const d = emails.find((x) => x.id === body.id);
      if (!d) return json(404, { error: 'That draft is gone. Reload the page.' });

      if (action === 'email_delete') {
        if (d.sentAt) return json(200, { ok: false, reason: 'already_sent' });
        emails = emails.filter((x) => x.id !== d.id);
        await saveAll(emails);
        return json(200, { ok: true, emails: list() });
      }

      const weeks = await loadWeeks(supabase, program.id);
      const subsFor = async (ids) => {
        const { data } = ids.length ? await supabase.from('hub_submissions').select('person_id, week_id').in('person_id', ids) : { data: [] };
        const m = new Map();
        for (const s of data || []) { if (!m.has(s.person_id)) m.set(s.person_id, new Set()); m.get(s.person_id).add(s.week_id); }
        return m;
      };
      const magicFor = (p) => `${pageUrl(program.slug)}#signin=${signToken({ k: 'm', pid: p.id, x: Math.min(Date.now() + MAGIC_TTL_MS, Date.parse(program.access_ends_at)) })}`;
      const { data: creators } = await supabase.from('hub_people').select('*').eq('program_id', program.id).eq('role', 'creator').eq('status', 'active');
      const roster = creators || [];

      if (action === 'email_preview') {
        // Two versions so staff can see both homework states: someone who hasn't turned in
        // this week's homework, and someone who has (if anyone has yet).
        const due = weeks.find((w) => w.due_at && w.assignment && Date.parse(w.due_at) > Date.now());
        const subs = await subsFor(roster.map((p) => p.id));
        const turnedIn = due ? roster.filter((p) => (subs.get(p.id) || new Set()).has(due.id)) : [];
        const notYet = due ? roster.filter((p) => !(subs.get(p.id) || new Set()).has(due.id)) : roster;
        const pick = (arr) => arr.find((p) => p.zoom_join_url) || arr[0];
        const samples = [];
        const a = pick(notYet); if (a) samples.push({ label: due ? "Hasn't turned in week " + due.week_number + ' yet (' + notYet.length + ')' : 'Everyone', person: a });
        const b = pick(turnedIn); if (b) samples.push({ label: 'Already turned in week ' + due.week_number + ' (' + turnedIn.length + ')', person: b });
        const out = samples.map((s) => {
          const m = cohortEmail(d, s.person, program, weeks, subs.get(s.person.id) || new Set(), `${pageUrl(program.slug)}#signin=PREVIEW`);
          return { label: s.label, name: s.person.name, subject: m.subject, html: m.html };
        });
        const { data: partners } = await supabase.from('hub_people').select('name').eq('program_id', program.id).eq('role', 'partner').eq('status', 'active');
        return json(200, { ok: true, recipients: roster.length, copiesTo: (partners || []).map((p) => p.name), previews: out });
      }

      if (action === 'email_test') {
        const subs = await subsFor([person.id]);
        const sample = { ...person, zoom_join_url: person.zoom_join_url || 'https://us06web.zoom.us/w/82615123795?tk=EACH-CREATOR-GETS-THEIR-OWN-LINK' };
        const m = cohortEmail(d, sample, program, weeks, subs.get(person.id) || new Set(), magicFor(person));
        await sendEmail({ to: person.email, subject: '[Test] ' + m.subject, html: m.html, text: m.text });
        return json(200, { ok: true, to: person.email });
      }

      if (action === 'email_send') {
        // Goes once, to every active creator. The page asks twice before calling this,
        // and the count it showed has to match what we'd send now.
        if (d.sentAt) return json(200, { ok: false, reason: 'already_sent', sentAt: d.sentAt });
        if (d.sending && Date.now() - Date.parse(d.sendingAt) < 10 * 60000) return json(200, { ok: false, reason: 'sending' });
        if (parseInt(body.expect, 10) !== roster.length) return json(200, { ok: false, reason: 'count_changed', recipients: roster.length });
        d.sending = true; d.sendingAt = new Date().toISOString();
        await saveAll(emails);
        const subs = await subsFor(roster.map((p) => p.id));
        const msgs = roster.map((p) => ({ to: p.email, ...cohortEmail(d, p, program, weeks, subs.get(p.id) || new Set(), magicFor(p)) }));
        // Send in chunks of 100 and keep track, so a failure partway through never leads to a double send.
        let sent = 0;
        let failed = [];
        for (let i = 0; i < msgs.length; i += 100) {
          const chunk = msgs.slice(i, i + 100);
          try {
            await sendEmailBatch(chunk);
            sent += chunk.length;
          } catch (e) {
            console.error('cohort email send failed', e.message);
            failed = msgs.slice(i).map((m) => m.to);
            break;
          }
        }
        if (!sent) {
          d.sending = false;
          await saveAll(emails);
          return json(200, { ok: false, reason: 'send_failed' });
        }
        // One copy for each TikTok partner on the roster, so they see what went out.
        // It uses a stand-in Zoom link and the partner's own sign-in link, never a creator's.
        let copies = [];
        try {
          const { data: partners } = await supabase.from('hub_people').select('*').eq('program_id', program.id).eq('role', 'partner').eq('status', 'active');
          const when = fmtET(new Date().toISOString(), { weekday: 'short', month: 'short', day: 'numeric' }) + ' at ' + fmtET(new Date().toISOString(), { hour: 'numeric', minute: '2-digit' }) + ' ET';
          const note = `Copy for the TikTok team: this went to ${sent} creators on ${when}. Each creator's version has their own name, personal Zoom link and one-click sign-in link. Creators who had already turned in this week's homework saw a thank-you in place of the homework box.`;
          const pm = (partners || []).map((p) => {
            const m = cohortEmail(d, { name: p.name, zoom_join_url: 'https://us06web.zoom.us/w/82615123795?tk=EACH-CREATOR-GETS-THEIR-OWN-LINK' }, program, weeks, new Set(), magicFor(p), note);
            return { to: p.email, subject: '[TikTok copy] ' + m.subject, html: m.html, text: m.text };
          });
          if (pm.length) { await sendEmailBatch(pm); copies = pm.map((m) => m.to); }
        } catch (e) { console.error('partner copies failed', e.message); }
        Object.assign(d, { sending: false, sentAt: new Date().toISOString(), sentCount: sent, sentBy: firstName(person.name), failed, copies });
        await saveAll(emails);
        return json(200, { ok: true, sent, failed, copies, emails: list() });
      }
    }

    if (action === 'pull_attendance') {
      const { pullAttendanceForWeek } = require('./cohort-hub-scheduled.js');
      const result = await pullAttendanceForWeek(supabase, program, body.weekId);
      return json(200, { ok: true, ...result });
    }

    return json(400, { error: 'Unknown action' });
  } catch (err) {
    console.error('cohort-hub error:', action, err);
    return json(500, { error: 'Something went wrong on our end. Try again in a minute.' });
  }
};

// Exposed for the scheduled function.
module.exports.internals = { cohortEmail, renderMarkup, db, loadProgram, loadWeeks, ensureZoomLink, zoomToken, sendEmail, sendEmailBatch, welcomeEmail, signToken, MAGIC_TTL_MS, emailShell, esc, firstName, fmtET, pageUrl };

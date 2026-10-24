// cohort-hub-scheduled.js — Netlify scheduled function (hourly, see netlify.toml)
// -------------------------------------------------------------------------
// Three chores for the cohort hub, each safe to run again and again:
//
//   1. ZOOM LINKS. Any active creator on a live program who doesn't have a
//      personal Zoom join link yet gets registered for the cohort meeting.
//
//   2. ATTENDANCE. Once a session has been over for about half an hour, pull
//      Zoom's participant report for that day and record minutes attended per
//      person (matched by their Zoom registration, then email, then name).
//      Retries for two days in case Zoom's report is slow, then stops.
//      Staff can also re-pull a week from the hub page.
//
//   3. DEADLINE REMINDERS. At the 10 AM Eastern run, anyone who hasn't
//      turned in homework due in the next 24 to 48 hours
//      gets one short reminder. hub_reminders_sent makes sure nobody gets
//      the same reminder twice.

const hub = require('./cohort-hub.js');

function I() { return hub.internals; }

function encodeUuid(uuid) {
  // Zoom wants meeting UUIDs that start with "/" or contain "//" double-encoded.
  return uuid.startsWith('/') || uuid.includes('//') ? encodeURIComponent(encodeURIComponent(uuid)) : encodeURIComponent(uuid);
}

async function zoomGet(path) {
  const token = await I().zoomToken();
  const res = await fetch('https://api.zoom.us/v2' + path, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Zoom GET ${path}: ${res.status} ${JSON.stringify(data)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function participantsFor(uuid) {
  const out = [];
  let next = '';
  for (let i = 0; i < 10; i++) {
    const q = `?page_size=300${next ? '&next_page_token=' + encodeURIComponent(next) : ''}`;
    let data;
    try {
      data = await zoomGet(`/report/meetings/${encodeUuid(uuid)}/participants${q}`);
    } catch (e) {
      // Fall back to the past-meeting endpoint if the report isn't ready or allowed.
      data = await zoomGet(`/past_meetings/${encodeUuid(uuid)}/participants${q}`);
    }
    out.push(...(data.participants || []));
    next = data.next_page_token;
    if (!next) break;
  }
  return out;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function pullAttendanceForWeek(supabase, program, weekId) {
  const { data: week } = await supabase.from('hub_weeks').select('*').eq('id', weekId).eq('program_id', program.id).maybeSingle();
  if (!week) return { matched: 0, unmatched: [], note: 'week not found' };
  if (!program.zoom_meeting_id) return { matched: 0, unmatched: [], note: 'no zoom meeting on this program' };

  const inst = await zoomGet(`/past_meetings/${program.zoom_meeting_id}/instances`);
  const sessionMs = Date.parse(week.session_at);
  const uuids = (inst.meetings || [])
    .filter((m) => Math.abs(Date.parse(m.start_time) - sessionMs) < 3 * 3600 * 1000)
    .map((m) => m.uuid);
  if (!uuids.length) return { matched: 0, unmatched: [], note: 'no Zoom recording of this session yet' };

  const { data: people } = await supabase.from('hub_people').select('id, name, email, zoom_registrant_id, role').eq('program_id', program.id);
  const byReg = new Map(people.filter((p) => p.zoom_registrant_id).map((p) => [p.zoom_registrant_id, p]));
  const byEmail = new Map(people.map((p) => [p.email, p]));
  const byName = new Map(people.map((p) => [norm(p.name), p]));

  const totals = new Map(); // person id -> { seconds, first }
  const unmatched = new Set();
  for (const uuid of uuids) {
    const parts = await participantsFor(uuid);
    for (const pt of parts) {
      const who = (pt.registrant_id && byReg.get(pt.registrant_id))
        || (pt.user_email && byEmail.get(norm(pt.user_email)))
        || byName.get(norm(pt.name));
      if (!who) { if (pt.name) unmatched.add(pt.name); continue; }
      if (who.role !== 'creator') continue;
      const t = totals.get(who.id) || { seconds: 0, first: null };
      t.seconds += Number(pt.duration) || 0;
      if (pt.join_time && (!t.first || pt.join_time < t.first)) t.first = pt.join_time;
      totals.set(who.id, t);
    }
  }

  const rows = [...totals.entries()].map(([pid, t]) => ({
    person_id: pid, week_id: week.id, minutes: Math.round(t.seconds / 60), first_join_at: t.first, source: 'zoom',
  }));
  if (rows.length) await supabase.from('hub_attendance').upsert(rows);
  await supabase.from('hub_weeks').update({ attendance_pulled_at: new Date().toISOString() }).eq('id', week.id);
  return { matched: rows.length, unmatched: [...unmatched].slice(0, 50) };
}

function reminderEmail(person, program, week) {
  const { esc, emailShell, firstName, fmtET, pageUrl } = I();
  const due = fmtET(week.due_at, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const url = pageUrl(program.slug);
  return {
    subject: `Reminder: your week ${week.week_number} homework is due ${fmtET(week.due_at, { weekday: 'long' })} at noon ET`,
    text: `Hi ${firstName(person.name)},\n\nQuick reminder: your week ${week.week_number} homework is due ${due} Eastern.\n\n${week.assignment || ''}\n\nTurn it in on your hub: ${url}\n\nQuestions or trouble getting in? Email info@projectc.com.\n\nLiz, Project C`,
    html: emailShell(`
      <p style="margin:0 0 16px;">Hi ${esc(firstName(person.name))},</p>
      <p style="margin:0 0 16px;">Quick reminder: your week ${week.week_number} homework is due <strong>${esc(due)} Eastern</strong>.</p>
      ${week.assignment ? `<p style="margin:0 0 20px;border-left:4px solid #FE6B41;padding-left:12px;">${esc(week.assignment)}</p>` : ''}
      <p style="margin:0 0 24px;">Turn it in on your hub. It takes a minute.</p>
      <p style="margin:0 0 24px;"><a href="${esc(url)}" style="display:inline-block;background:#15171A;color:#ffffff;text-decoration:none;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:13px;padding:14px 22px;">Turn in your homework</a></p>
      <p style="margin:0 0 20px;font-size:13px;color:#5b5d60;">Questions or trouble getting in? Email <a href="mailto:info@projectc.com" style="color:#B74D2F;">info@projectc.com</a>.</p>
      <p style="margin:0;">Liz<br><span style="color:#5b5d60;">Project C</span></p>`),
  };
}

async function run() {
  const { db, loadWeeks, ensureZoomLink, sendEmailBatch } = I();
  const supabase = db();
  const now = Date.now();
  const log = [];

  const { data: programs } = await supabase.from('hub_programs').select('*');
  for (const program of programs || []) {
    const opens = Date.parse(program.starts_on) - 30 * 86400000;
    if (now < opens || now > Date.parse(program.access_ends_at)) continue;

    // 1. Zoom links
    // TikTok partners and Project C staff get personal links too (except Liz, who hosts).
    // Team first, so their links are ready for the calendar invites.
    const { data: missingAll } = await supabase.from('hub_people').select('*').eq('program_id', program.id)
      .eq('status', 'active').in('role', ['creator', 'partner', 'staff']).is('zoom_join_url', null).order('role', { ascending: false }).limit(40);
    const missing = (missingAll || []).filter((p) => !(p.role === 'staff' && /^liz@/i.test(p.email))).slice(0, 25);
    for (const p of missing || []) await ensureZoomLink(supabase, program, p);
    if (missing && missing.length) log.push(`${program.slug}: zoom links attempted for ${missing.length}`);

    const weeks = await loadWeeks(supabase, program.id);

    // 1b. Automatic welcome emails (settings.autoWelcome). Anyone added to the roster who
    // hasn't had a welcome yet gets one, until the final session ends.
    const lastSession = weeks.length ? Date.parse(weeks[weeks.length - 1].session_at) + 60 * 60000 : 0;
    if ((program.settings || {}).autoWelcome && now < lastSession) {
      const { welcomeEmail, signToken, MAGIC_TTL_MS, pageUrl } = I();
      const { data: unwelcomed } = await supabase.from('hub_people').select('*').eq('program_id', program.id)
        .eq('status', 'active').eq('role', 'creator').is('welcome_sent_at', null).limit(90);
      if (unwelcomed && unwelcomed.length) {
        const ready = [];
        for (let t of unwelcomed) {
          t = await ensureZoomLink(supabase, program, t);
          const link = signToken({ k: 'm', pid: t.id, x: Math.min(Date.now() + MAGIC_TTL_MS, Date.parse(program.access_ends_at)) });
          ready.push({ id: t.id, msg: { to: t.email, ...welcomeEmail(t, program, weeks, `${pageUrl(program.slug)}#signin=${link}`) } });
        }
        try {
          await sendEmailBatch(ready.map((r) => r.msg));
          await supabase.from('hub_people').update({ welcome_sent_at: new Date().toISOString() }).in('id', ready.map((r) => r.id));
          log.push(`${program.slug}: auto-welcomed ${ready.length}`);
        } catch (e) {
          log.push(`${program.slug}: auto-welcome failed (${e.message.slice(0, 120)})`);
        }
      }
    }

    // 2. Attendance
    for (const w of weeks) {
      const ended = Date.parse(w.session_at) + 90 * 60000;
      if (w.attendance_pulled_at || now < ended || now > ended + 2 * 86400000) continue;
      try {
        const r = await pullAttendanceForWeek(supabase, program, w.id);
        log.push(`${program.slug} week ${w.week_number}: attendance ${r.matched} matched, ${r.unmatched.length} unmatched ${r.note || ''}`);
      } catch (e) {
        log.push(`${program.slug} week ${w.week_number}: attendance not ready (${e.message.slice(0, 120)})`);
      }
    }

    // 3. Reminders, once a day at the 10 AM Eastern run
    const hourET = Number(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
    if (hourET !== 10) continue;
    for (const w of weeks) {
      if (!w.due_at || !w.assignment) continue;
      const until = Date.parse(w.due_at) - now;
      if (until < 24 * 3600000 || until > 48 * 3600000) continue;
      const { data: creators } = await supabase.from('hub_people').select('*').eq('program_id', program.id).eq('status', 'active').eq('role', 'creator');
      const { data: subs } = await supabase.from('hub_submissions').select('person_id').eq('week_id', w.id);
      const { data: sent } = await supabase.from('hub_reminders_sent').select('person_id').eq('week_id', w.id).eq('kind', 'due');
      const skip = new Set([...(subs || []).map((s) => s.person_id), ...(sent || []).map((s) => s.person_id)]);
      const due = (creators || []).filter((c) => !skip.has(c.id));
      let n = 0;
      if (due.length) {
        try {
          await sendEmailBatch(due.map((c) => ({ to: c.email, ...reminderEmail(c, program, w) })));
          await supabase.from('hub_reminders_sent').insert(due.map((c) => ({ person_id: c.id, week_id: w.id, kind: 'due' })));
          n = due.length;
        } catch (e) {
          console.error('reminder batch failed', e.message);
        }
      }
      log.push(`${program.slug} week ${w.week_number}: ${n} reminders sent`);
    }
  }
  return log;
}

exports.handler = async () => {
  try {
    const log = await run();
    console.log('cohort-hub-scheduled:', log.join(' | ') || 'nothing to do');
    return { statusCode: 200, body: 'ok' };
  } catch (e) {
    console.error('cohort-hub-scheduled error:', e);
    return { statusCode: 500, body: 'error' };
  }
};

module.exports.pullAttendanceForWeek = pullAttendanceForWeek;

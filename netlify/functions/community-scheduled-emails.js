// community-scheduled-emails.js — Netlify scheduled function
// -----------------------------------------------------------
// Runs daily at 2pm UTC (10am Eastern) via the cron schedule in
// netlify.toml. Handles three lifecycle emails:
//
//   1. DAY-3 FOLLOW-UP — sent ~3 days after a member is approved.
//      A warm nudge to join Slack, introduce themselves, and explore.
//
//   2. COHORT 2-WEEK REMINDER — sent ~2 weeks before a cohort
//      membership expires. Heads-up that their free period is ending,
//      with an option to convert to paid.
//
//   3. COHORT 3-DAY REMINDER — sent ~3 days before expiration.
//      Final nudge with a direct link to rejoin as a paid member.
//
// Idempotency: each membership row has timestamp columns
// (day3_email_sent_at, cohort_reminder_2w_sent_at, cohort_reminder_3d_sent_at)
// that gate whether a given email has already been sent. The function
// queries for rows where the timestamp is null AND the timing window
// is right, sends the email, and stamps the column. Even if the function
// runs twice in one day, no one gets a duplicate.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL        = process.env.SUPABASE_COMMUNITY_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_COMMUNITY_SECRET_KEY;
const RESEND_API_KEY      = process.env.RESEND_API_KEY;
const SLACK_COMMUNITY_INVITE_LINK = process.env.SLACK_COMMUNITY_INVITE_LINK;

// —— Email helper ——
async function sendEmail({ to, subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Project C <community@projectc.biz>',
      to: [to],
      subject,
      html,
    }),
  });
  const data = await res.json();
  if (data.error) console.error(`Resend error for ${to}:`, data.error);
  return data;
}

// —— Email templates ——
function buildDay3EmailHtml(name) {
  const firstName = name.split(/\s+/)[0];
  const slackLine = SLACK_COMMUNITY_INVITE_LINK
    ? `<p><strong>Jump into Slack</strong> if you haven't yet: <a href="${SLACK_COMMUNITY_INVITE_LINK}">${SLACK_COMMUNITY_INVITE_LINK}</a>. Start by dropping a quick intro in #introductions — who you are, what you're building, and one thing you're wrestling with right now. People here love to help.</p>`
    : '';

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Inter, -apple-system, sans-serif; color: #360A05; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 2rem;">
  <div style="background: linear-gradient(135deg, #FE6B41, #E09AC2); height: 4px; border-radius: 2px; margin-bottom: 2rem;"></div>

  <h1 style="font-family: Anton, Impact, sans-serif; font-size: 1.5rem; margin-bottom: 0.5rem;">Hey ${firstName} — how's it going?</h1>

  <p>You joined Project C a few days ago and I wanted to check in. Here are a few things that'll help you get the most out of your membership:</p>

  ${slackLine}

  <p><strong>Check out #wins-and-launches.</strong> It's one of my favorite channels — members share what's working, and it's a great way to see the range of what people in this community are building.</p>

  <p><strong>Don't be shy about asking for help.</strong> One of the things I hear most from members is that they wish they'd posted their question sooner. Whether it's pricing strategy, tech stack decisions, dealing with a tricky source, or just "is this idea any good?" — this group has seen it all.</p>

  <p><strong>Office hours are open.</strong> If you want to talk something through live, our coaching sessions and office hours are there for exactly that. Keep an eye on #events for the next one.</p>

  <p>Reply to this email anytime if you need anything. I read every one.</p>

  <p style="margin-top: 2rem;">— Liz</p>

  <div style="background: linear-gradient(135deg, #FE6B41, #E09AC2); height: 4px; border-radius: 2px; margin-top: 2rem;"></div>
  <p style="font-size: 0.75rem; color: #666; margin-top: 1rem;">Project C · projectc.biz</p>
</body>
</html>`.trim();
}

function buildCohort2WeekReminderHtml(name, endsAt) {
  const firstName = name.split(/\s+/)[0];
  const endDate = new Date(endsAt).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Inter, -apple-system, sans-serif; color: #360A05; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 2rem;">
  <div style="background: linear-gradient(135deg, #FE6B41, #E09AC2); height: 4px; border-radius: 2px; margin-bottom: 2rem;"></div>

  <h1 style="font-family: Anton, Impact, sans-serif; font-size: 1.5rem; margin-bottom: 0.5rem;">Heads up, ${firstName}</h1>

  <p>Your Project C cohort membership wraps up on <strong>${endDate}</strong> — that's about two weeks from now.</p>

  <p>I hope you've gotten a lot out of being part of this community. If you'd like to keep going, you can convert to a paid membership and nothing changes — same Slack, same people, same access. No interruption.</p>

  <p><a href="https://projectc.biz/community" style="display: inline-block; background: #FE6B41; color: white; text-decoration: none; padding: 0.75rem 1.5rem; border-radius: 8px; font-weight: 600; margin: 0.5rem 0;">Continue my membership &rarr;</a></p>

  <p>If now's not the right time, no worries at all. Your access will remain active through ${endDate}, and you're always welcome to come back later.</p>

  <p>Questions? Just reply to this email.</p>

  <p style="margin-top: 2rem;">— Liz</p>

  <div style="background: linear-gradient(135deg, #FE6B41, #E09AC2); height: 4px; border-radius: 2px; margin-top: 2rem;"></div>
  <p style="font-size: 0.75rem; color: #666; margin-top: 1rem;">Project C · projectc.biz</p>
</body>
</html>`.trim();
}

function buildCohort3DayReminderHtml(name, endsAt) {
  const firstName = name.split(/\s+/)[0];
  const endDate = new Date(endsAt).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Inter, -apple-system, sans-serif; color: #360A05; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 2rem;">
  <div style="background: linear-gradient(135deg, #FE6B41, #E09AC2); height: 4px; border-radius: 2px; margin-bottom: 2rem;"></div>

  <h1 style="font-family: Anton, Impact, sans-serif; font-size: 1.5rem; margin-bottom: 0.5rem;">${firstName}, your cohort access ends in 3 days</h1>

  <p>Just a quick reminder — your cohort membership expires on <strong>${endDate}</strong>. After that, you'll lose access to the Slack community and member resources.</p>

  <p>If you want to stay, it takes about 60 seconds to convert to a paid membership:</p>

  <p><a href="https://projectc.biz/community" style="display: inline-block; background: #FE6B41; color: white; text-decoration: none; padding: 0.75rem 1.5rem; border-radius: 8px; font-weight: 600; margin: 0.5rem 0;">Keep my membership &rarr;</a></p>

  <p>Either way, it's been great having you here. Thank you for being part of this.</p>

  <p style="margin-top: 2rem;">— Liz</p>

  <div style="background: linear-gradient(135deg, #FE6B41, #E09AC2); height: 4px; border-radius: 2px; margin-top: 2rem;"></div>
  <p style="font-size: 0.75rem; color: #666; margin-top: 1rem;">Project C · projectc.biz</p>
</body>
</html>`.trim();
}

// ======================================================================
// MAIN HANDLER
// ======================================================================
exports.handler = async (event) => {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !RESEND_API_KEY) {
    console.error('scheduled-emails: missing env vars');
    return { statusCode: 500 };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { persistSession: false },
  });

  const now = new Date();
  let totalSent = 0;

  // ——————————————————————————————————————————————
  // 1. DAY-3 FOLLOW-UP
  // ——————————————————————————————————————————————
  // Find active memberships where:
  //   - welcome_email_sent_at IS set (they got the welcome)
  //   - day3_email_sent_at IS NULL (haven't gotten the day-3 yet)
  //   - membership_starts_at is between 3 and 10 days ago
  //     (the 10-day upper bound prevents sending to very old members
  //      if the function was down or just deployed)
  try {
    const threeDaysAgo = new Date(now);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const tenDaysAgo = new Date(now);
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);

    const { data: day3Members, error } = await supabase
      .from('memberships')
      .select('id, name, email, membership_starts_at')
      .eq('status', 'active')
      .not('welcome_email_sent_at', 'is', null)
      .is('day3_email_sent_at', null)
      .lte('membership_starts_at', threeDaysAgo.toISOString())
      .gte('membership_starts_at', tenDaysAgo.toISOString())
      .limit(50);

    if (error) {
      console.error('Day-3 query error:', error);
    } else if (day3Members && day3Members.length > 0) {
      console.log(`Day-3 follow-up: ${day3Members.length} member(s) to email`);

      for (const member of day3Members) {
        try {
          await sendEmail({
            to: member.email,
            subject: "A few tips to get the most out of Project C",
            html: buildDay3EmailHtml(member.name),
          });

          await supabase
            .from('memberships')
            .update({ day3_email_sent_at: now.toISOString() })
            .eq('id', member.id);

          totalSent++;
        } catch (err) {
          console.error(`Day-3 email failed for ${member.email}:`, err);
        }
      }
    }
  } catch (err) {
    console.error('Day-3 block error:', err);
  }

  // ——————————————————————————————————————————————
  // 2. COHORT 2-WEEK REMINDER
  // ——————————————————————————————————————————————
  // Find cohort memberships where:
  //   - tier = 'cohort'
  //   - membership_ends_at is between now and 14 days from now
  //   - cohort_reminder_2w_sent_at IS NULL
  try {
    const fourteenDaysFromNow = new Date(now);
    fourteenDaysFromNow.setDate(fourteenDaysFromNow.getDate() + 14);

    const { data: cohort2wMembers, error } = await supabase
      .from('memberships')
      .select('id, name, email, membership_ends_at')
      .eq('status', 'active')
      .eq('tier', 'cohort')
      .is('cohort_reminder_2w_sent_at', null)
      .gte('membership_ends_at', now.toISOString())
      .lte('membership_ends_at', fourteenDaysFromNow.toISOString())
      .limit(50);

    if (error) {
      console.error('Cohort 2-week query error:', error);
    } else if (cohort2wMembers && cohort2wMembers.length > 0) {
      console.log(`Cohort 2-week reminder: ${cohort2wMembers.length} member(s) to email`);

      for (const member of cohort2wMembers) {
        try {
          await sendEmail({
            to: member.email,
            subject: 'Your Project C cohort membership is wrapping up soon',
            html: buildCohort2WeekReminderHtml(member.name, member.membership_ends_at),
          });

          await supabase
            .from('memberships')
            .update({ cohort_reminder_2w_sent_at: now.toISOString() })
            .eq('id', member.id);

          totalSent++;
        } catch (err) {
          console.error(`Cohort 2w email failed for ${member.email}:`, err);
        }
      }
    }
  } catch (err) {
    console.error('Cohort 2-week block error:', err);
  }

  // ——————————————————————————————————————————————
  // 3. COHORT 3-DAY REMINDER
  // ——————————————————————————————————————————————
  try {
    const threeDaysFromNow = new Date(now);
    threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);

    const { data: cohort3dMembers, error } = await supabase
      .from('memberships')
      .select('id, name, email, membership_ends_at')
      .eq('status', 'active')
      .eq('tier', 'cohort')
      .is('cohort_reminder_3d_sent_at', null)
      .gte('membership_ends_at', now.toISOString())
      .lte('membership_ends_at', threeDaysFromNow.toISOString())
      .limit(50);

    if (error) {
      console.error('Cohort 3-day query error:', error);
    } else if (cohort3dMembers && cohort3dMembers.length > 0) {
      console.log(`Cohort 3-day reminder: ${cohort3dMembers.length} member(s) to email`);

      for (const member of cohort3dMembers) {
        try {
          await sendEmail({
            to: member.email,
            subject: 'Your Project C access ends in 3 days',
            html: buildCohort3DayReminderHtml(member.name, member.membership_ends_at),
          });

          await supabase
            .from('memberships')
            .update({ cohort_reminder_3d_sent_at: now.toISOString() })
            .eq('id', member.id);

          totalSent++;
        } catch (err) {
          console.error(`Cohort 3d email failed for ${member.email}:`, err);
        }
      }
    }
  } catch (err) {
    console.error('Cohort 3-day block error:', err);
  }

  console.log(`Scheduled emails done. Sent ${totalSent} email(s).`);
  return { statusCode: 200 };
};

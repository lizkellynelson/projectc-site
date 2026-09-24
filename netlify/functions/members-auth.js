// members-auth.js — Netlify serverless function
// ----------------------------------------------
// Powers the members-only page (members.html). Two jobs:
//
//   1. action: "login"   — takes an email, checks it against the memberships
//      table in Supabase (the same table community-submit.js writes to).
//      If the member is active, returns a signed session token (30 days).
//
//   2. action: "content" — takes a token, verifies the signature and expiry,
//      and returns the members-only content (event replays, resources,
//      and the Legal Office Hours notes).
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
  // -------------------------------------------------------------------------
  // LEGAL OFFICE HOURS — monthly session with attorney Julian Sarafian.
  // No recordings are posted (privacy of the people asking). Instead each
  // month gets a "What We Learned" note: anonymized guidance, structured
  // as questions so the archive can be searched across months later.
  // To add a month: add a note object to the TOP of `notes`. The next-
  // session card on the members page fills itself from the Luma calendar
  // (any event whose title contains "Legal Office Hours").
  // Rendered by legal-office-hours.html and the members page.
  // -------------------------------------------------------------------------
  legalOfficeHours: {
    title: 'Legal Office Hours',
    cadence: 'One hour a month. Open questions, group format.',
    counsel: {
      name: 'Julian Sarafian',
      firm: 'For Creators By Creators PC',
      email: 'julian@forcreatorsbycreators.co',
      url: 'https://forcreatorsbycreators.co',
      bio: 'Julian is an attorney who represents content creators and entrepreneurs. He is licensed in California.',
    },
    whyNoRecording:
      'Unlike most Project C monthly sessions, we don’t post the recordings, out of respect for the privacy of the people asking the questions. Instead we share the best of what Julian covered, with the names and specifics stripped out and the guidance that applies to anyone running an independent journalism business kept in.',
    // Shown on every note, top and bottom. Wording is Julian's; keep it intact.
    disclaimer:
      'This is general educational information, not legal advice, and reading it doesn’t create an attorney-client relationship with Julian. If you’re facing one of these situations for real, talk to a lawyer about your specifics. Laws change, and each note reflects the law as of the date it was written. Julian is California licensed only.',
    houseRule:
      'Keep these notes inside the Project C community. Julian is generous with his time, and keeping these conversations among members is what lets him speak freely.',
    comingSoon:
      'Julian is putting together three annotated contract templates for us: an NDA, a contractor agreement and a brand sponsorship deal. They’ll be posted here when they’re ready.',
    notes: [
      {
        slug: '2026-09',
        month: 'September 2026',
        sessionDate: 'September 18, 2026',
        asOf: 'September 2026',
        title: 'What We Learned',
        topics: 'Release forms, defamation risk, what an LLC does and doesn’t cover, indemnification clauses, and who owns the work.',
        intro:
          'Each month, attorney Julian Sarafian joins the Project C Community to answer questions about the legal side of our work. Here is the best of what he covered in September.',
        shortVersion: [
          { lead: 'Get consent in writing.', text: 'A release can be short and cover just the one project. What you don’t want is nothing in writing at all.' },
          { lead: 'Always disclose when a business gives you something of value and you talk about that business.', text: 'It’s the thing the FTC actually goes after.' },
          { lead: 'On a tough story, your process is your protection.', text: 'Multiple sources, a real attempt to reach the subject, and a line-by-line record of where every fact came from.' },
          { lead: 'Don’t count on your LLC to protect you from a defamation claim.', text: 'It’s still worth having for contracts, business dealings and keeping your finances clean.' },
          { lead: 'When working with a news organization, read the indemnification clause before you sign.', text: 'Look at what triggers it and ask for a dollar cap. Know going in that a lot of publishers won’t budge.' },
          { lead: 'Know who owns what.', text: 'If you pay someone to make something, you should own it. If someone pays you, try to keep ownership and license it to them. Either way, get it in writing.' },
        ],
        questions: [
          {
            q: 'Do I really need release forms for the people I interview and film?',
            tags: ['releases', 'consent', 'video', 'minors'],
            situation:
              'You shoot video or record audio, some of it ends up on social media, and you’re wondering whether someone agreeing to talk to you is consent enough.',
            said: [
              'If the content is going to make money, getting a release signed is always a very good idea. Part of the reason is practical: it heads off the person who comes back later saying you’re making money and they want some of it. How much it matters depends on the setting. For a sit-down interview, Julian called it critical. For filming people out in public it matters less, because nobody has an expectation of privacy in a public space, though he still thinks a release is best practice unless you’re just shooting a crowd walking by.',
              'The release doesn’t have to be elaborate. It can say that for this project and these recordings, you’re allowed to use the material, and that’s basically it. If you don’t have a formal release but you have the person’s consent in writing somewhere else, that’s good too. The thing to avoid is having nothing in writing.',
              'On what counts as “monetized”: if you’ve opted into a platform’s creator fund, it counts, even if you’re earning $20. And the more traditional the outlet, the more they’ll expect paperwork. Film and TV distributors will want to see releases, and you could run into trouble with them if you don’t have them.',
              'For kids, you need a parent’s consent, period. The legal standard isn’t higher, the only difference is who signs. But the court of public opinion is much harsher on anyone who looks like they’re exploiting a child, so be more careful for that reason.',
            ],
            todo: [
              'Keep a short, project-specific release on hand and use it for every sit-down interview.',
              'If a release isn’t practical, get consent in an email or a text. Something in writing.',
              'Send the release well ahead of the interview so it’s not an awkward moment on the day.',
              'For anyone under 18, get a parent’s signature.',
            ],
          },
          {
            q: 'I’m about to publish a story that makes someone look bad. How worried should I be about getting sued?',
            tags: ['defamation', 'libel', 'anti-SLAPP', 'insurance', 'investigations'],
            situation:
              'You’ve got a well-sourced investigation into a private person or business, the subject isn’t cooperating, and you’re wondering whether a vaguer version of the story would be safer.',
            said: [
              'Anyone in America can sue over anything. Whether they have a real claim is a different question, and it mostly comes down to how careful you were. As he described it, a defamation claim needs a lot of things to line up: you published something false, you should have known it was false if you’d done a reasonable investigation, it’s provably false, and it caused damages. At minimum you’d have to have been negligent, and in some states, including New York, the bar for stories on matters of public concern is even higher than negligence. (The bar is higher for public figures, and being rich doesn’t by itself make someone a public figure.)',
              'Reasonable investigation doesn’t mean going to the ends of the earth. It means a good-faith effort to find out what’s true. Reaching out to the subject is part of that, and if they ignore you, that doesn’t change whether you’ve done your part.',
              'On vague versus detailed: that’s a risk call only you can make. The more specific claims you make about specific people, the more openings there are for a claim. Publish nothing and you have no risk and no impact. It’s a balance with your own comfort level.',
              'He offered one way to lower the temperature: defamation is about statements presented as fact, not opinions. Two cautions, though. First, repeating a source’s accusation, even as a clearly attributed quote, is still you publishing it, so attribution by itself is not a legal shield; what actually helps is grounding any harsh claim in verified facts you lay out for the reader, and reporting fairly and accurately on official records and proceedings. Second, labeling something as opinion only protects genuine opinion, meaning your interpretation of true facts you have disclosed, not a factual accusation dressed up as one.',
              'Where you live matters too. Some states, including New York and California, have what are called anti-SLAPP laws. As Julian described them, they let you get a meritless defamation suit thrown out early and make the person who sued pay your legal fees. That puts you in a position of strength and deters people from suing in the first place. He’s seen lawyers defend these cases and collect their fee only when they win.',
              'On media liability insurance: big newsrooms carry it for their journalists, and independents are slowly starting to look at it. It’s not yet clear how much protection you really get, so talk to an insurance broker and have them confirm that defamation claims are covered. Be ready for it to be expensive.',
            ],
            todo: [
              'Go through the piece line by line and note where each fact came from and where the backup lives. If it’s ever litigated, that record is what gets argued over.',
              'Reach out to the subject and keep a record of every attempt.',
              'Where a claim is harsh, show your work: lay out the verified facts it rests on, and keep your interpretation clearly separate from accusation.',
              'Find out whether your state has an anti-SLAPP law.',
              'Ask a broker about media liability coverage before you need it.',
            ],
          },
          {
            q: 'Doesn’t my LLC protect me?',
            tags: ['LLC', 'liability', 'business structure', 'defamation'],
            situation:
              'You set up an LLC, and you’ve assumed it stands between you and a lawsuit over something you publish.',
            said: [
              'Not for defamation, as far as he knows. It’s not clear how an LLC would protect you there and he wouldn’t count on it, because the speaker is inherently a person. If you personally wrote and published it, you can expect to be named personally. (He noted it may be different when a company publishes something in its own name with no individual byline.)',
              'What an LLC is good for is contract disputes, business dealings and protecting your assets. He does recommend running your newsletter and related work through one. The more you funnel through the business entity, the cleaner things are. If you already have an LLC under another name, you can rename it, it just costs a bit of money.',
            ],
            todo: [
              'Run your publishing business through an LLC for the contract and business protection.',
              'Check with your accountant on the tax side.',
              'Don’t treat the LLC as your defamation plan. Your reporting process and possibly insurance are that.',
            ],
          },
          {
            q: 'My freelance contract says I indemnify the publication. What does that mean, and can I push back?',
            tags: ['indemnification', 'contracts', 'freelance', 'negotiation'],
            situation:
              'An outlet’s contract has you promise the work is original, accurate and legally sound, and says you’ll cover their costs if a claim comes out of you breaking one of those promises.',
            said: [
              'These clauses are pretty standard and a lot of places won’t negotiate them at all, so don’t feel guilty if you signed one. The publisher’s logic is that they aren’t going to check every fact line by line, so if they get sued over something that turns out to be untrue, they want you on the hook for the legal fees and damages. It’s often take it or leave it.',
              'The two things he looks at are the triggers and the cap. What exactly sets the clause off? A narrow trigger, like gross negligence only, may never come into play. A broad one that covers any breach of any promise in the contract is a bigger exposure. And is there a dollar limit? In the brand-deal contracts he mostly works on, he usually pushes to cap it, often at the amount of the fee. He was upfront that investigative work for a publication is a bit different, and that he’s had less direct exposure to how newspapers handle these.',
              'If you’ve signed and you’re having second thoughts, you can always reopen the conversation, especially before the piece runs. He’d expect most publishers to act as good-faith business partners.',
            ],
            todo: [
              'Before you sign, find the indemnification clause and read what triggers it.',
              'Ask for a cap. Expect a no, and ask anyway.',
              'If you’ve already signed and it’s nagging at you, raise it with your editor before the piece runs.',
            ],
          },
          {
            q: 'Who owns my notes, my recordings and the story itself once it’s published?',
            tags: ['work for hire', 'copyright', 'IP', 'podcasts', 'contracts'],
            situation:
              'Your contract is work for hire, the outlet owns the piece, and now you’re thinking about a podcast or another project built on the same reporting.',
            said: [
              'If a contract is drafted in the outlet’s favor, the language will say the piece becomes their property. The main practical effect is that you can’t take that piece and publish it somewhere else without their OK. He doubts any outlet would try to stop you from talking about your own story or promoting it.',
              'Notes, recordings and the underlying story are where it gets murky, and he said the ambiguity is real. A verbal “those are yours” is worth getting into the contract. The way he handles it is a carve-out: work for hire for this specific piece, but you reserve your rights to the general story, the relationships, the idea broadly, and the right to talk about it.',
              'On reusing the reporting in a podcast, his test is how much the new project is built around the old one. A show that touches on the story among other things doesn’t worry him much. A whole series built entirely around that one piece is different, and there he’d get clearance from the outlet first.',
            ],
            todo: [
              'Get ownership of your notes, recordings and the underlying story written into the contract. Don’t rely on a verbal assurance.',
              'Ask to reserve the right to discuss and build on the story later (a book, a talk, a show).',
              'If a follow-on project is built squarely on the published piece, get the outlet’s sign-off in writing before you produce it.',
            ],
          },
          {
            q: 'I’m partnering with another outlet or a brand. Who should own what we make?',
            tags: ['partnerships', 'sponsorships', 'licensing', 'contractors', 'IP'],
            situation:
              'You’re looking at a co-production with another publication, or a sponsorship, or you’re hiring a contractor, and you want to know what to prioritize in the contract.',
            said: [
              'His rule of thumb is that he wants you to have your cake and eat it too. If you pay someone to make something for you (a video editor, a web designer, a logo maker), you need to own that work outright. If someone pays you, you should still own it, and give them a license. Whether you actually get that second one is a negotiation. It’s easier when the content lives on your own channels, harder when it’s made for theirs, and with the biggest outlets, good luck. It also cuts both ways: your contractor may want to keep their own rights too.',
              'A license is how you keep ownership and still give the other side what they need. Something like: you can use this on your channels for twelve months, on these platforms, and you can put ad dollars behind it.',
              'For a true partnership, such as a co-branded podcast, his first thought is joint ownership. The other side will probably assume it’s theirs because it carries their brand. He wouldn’t come in aggressively demanding all of it, because that invites pushback and may make them invest less. And if they hold firm on owning it, that’s OK, as long as there are guardrails. If you hand everything over with nothing spelled out, you don’t know how it’ll be used, for how long, or whether they’ll make money from it again without paying you.',
              'One reassuring note: telling your story on someone else’s podcast doesn’t hand them the story. What they own is that specific recording. Nobody can say you told it on their show once so now you can’t go get a book deal. The caution is that the closer a project looks like the thing you might want to make on your own down the line, the more carefully you should protect your rights before you start.',
            ],
            todo: [
              'When you hire anyone to make something, make sure the contract says you own it.',
              'When you’re the one being paid, start from keeping ownership and offering a license with a time limit and named platforms.',
              'In a partnership, aim for joint ownership.',
              'If they insist on owning it, get the guardrails in writing: how they can use it, for how long, how it makes money, and what your cut is and when you get paid.',
            ],
          },
        ],
        whoToCall: {
          intro: 'A lawyer isn’t the only call to make, and Julian pointed to a few others along the way.',
          rows: [
            { issue: 'Whether a media liability policy would cover a defamation claim', who: 'An insurance broker, before you need the coverage' },
            { issue: 'Sole proprietor vs. LLC, and how each is taxed', who: 'Your accountant (or a lawyer, if you want to get it formed)' },
            { issue: 'Negotiating an indemnification cap, a work-for-hire carve-out, or the terms of a partnership', who: 'A lawyer who does contract work for creators' },
            { issue: 'A one-page interview release, or a source log for a big story', who: 'You can handle these yourself' },
          ],
        },
      },
    ],
  },
  series: [
    {
      title: 'Step Forward on Sponsorships',
      date: 'June & July 2026',
      description:
        'A three-part series with media advisors Emily Dresslar and April Hinkle on landing sponsors: research your prospects, position your pitch, then price and close the deal.',
      sessions: [
        {
          title: 'The Partnership Approach',
          date: 'June 24, 2026',
          links: [
            {
              label: 'Watch the recording',
              url: 'https://us06web.zoom.us/rec/share/Q3aqqRdZ7pMifYiREQ2ESS8ZtcBTgljJJK8MYISUwxIwzcLvMk6xuL2mPL-URt1y.nkvH9kMj_41yjTWq',
            },
            {
              label: 'Slides',
              url: '/slides/sponsorships-session-1.pdf',
            },
          ],
        },
        {
          title: 'Identifying the Right Partners',
          date: 'July 1, 2026',
          links: [
            {
              label: 'Watch the recording',
              url: 'https://us06web.zoom.us/rec/share/daDn3x4cr197DtgC3fEz2dpP35ErmTs51EJEMoUiOEyNMH5YG8DrTEMoHXprIDoN.CTwMb6CM958NdXis',
            },
            {
              label: 'Slides',
              url: '/slides/sponsorships-session-2.pdf',
            },
          ],
        },
        {
          title: 'Building the Sponsorship',
          date: 'July 8, 2026',
          links: [
            {
              label: 'Watch the recording',
              url: 'https://us06web.zoom.us/rec/share/2hCjh1groc9zXfdbtX9cM3FDntH8SdeN-DKyYyxTCgYFxGdRAQsb1ujf1XtlXIWn.kXEIl_L22ysPInHF',
            },
            {
              label: 'Slides',
              url: '/slides/sponsorships-session-3.pdf',
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
          title: 'Getting Started With Grants',
          date: 'January 2026',
          links: [
            {
              label: 'Watch the recording',
              url: 'https://us06web.zoom.us/rec/share/WCCAAhQHzjmDxQulV-5hg9CXRM_Z1RwQYKNO3MQHC8vevDqDvG3hOyq9TMfJzt1p.jyGY9g6imqC4adnq',
            },
            {
              label: 'Slides',
              url: '/slides/philanthropy-part-1.pdf',
            },
          ],
        },
        {
          title: 'Making the Ask',
          date: 'February 2026',
          links: [
            {
              label: 'Watch the recording',
              url: 'https://us06web.zoom.us/rec/share/l5Yl15xczhYePJUdesX7aEcpkEyMsHXPGSYdysfTXcCbgcIgr9AZmGr03joFjnXz.Lss6ko1N64D3gfET',
            },
            {
              label: 'Slides',
              url: '/slides/philanthropy-part-2.pdf',
            },
            {
              label: 'Proposal one-pager template',
              url: '/slides/philanthropy-proposal-template.docx',
            },
          ],
        },
        {
          title: 'Managing a Grant-Funded Project',
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
      title: 'Values That Speak: Your Core Values Story',
      date: 'September 9, 2026',
      guest: 'Megan Finnerty',
      description:
        'The third session in Megan\'s storytelling series. Name the values that drive your work, then build a true, first-person story around each one: who you are, what you do, why it matters, and the moment that taught you the value in the first place. You leave with the raw material for a keynote or a TED-style talk, one story per core value. The worksheet walks you through the exercise step by step.',
      links: [
        {
          label: 'Watch the recording',
          url: 'https://us06web.zoom.us/rec/share/QkSpJSd5MrGPrJZ3JBvi4kZES4vvj98MadJ3JIsapK395naTYQTWVh7XQCzTMbHV.7_g5R9w_w-mKr1Vi',
        },
        {
          label: 'Worksheet',
          url: '/slides/core-values-story-worksheet.pdf',
        },
      ],
    },
    {
      title: 'Cracking PACER: Tips for Telling Stories with Federal Court Records',
      date: 'September 3, 2026',
      guest: 'Seamus Hughes',
      description:
        'The Court Watch founder walks through how he mines the federal docket for stories. He covers when to use PACER versus CourtListener, how to pull district-level ECF reports by charge or date, why searching by lawyer beats searching by defendant, and how to set up alerts so new filings come to you. Every link and search recipe from the session is on his tip sheet.',
      youtube: 'ajHUKzotVSE',
      links: [
        {
          label: 'Tip sheet',
          url: '/slides/court-watch-tip-sheet.pdf',
        },
      ],
    },
    {
      title: 'Work Origin Story',
      date: 'August 5, 2026',
      guest: 'Megan Finnerty',
      description:
        'Why you do what you do. A storytelling exercise for finding the narrative arc in your own career — the problem that pulled you in, the moment help or inspiration arrived, and what it taught you about your values.',
      links: [
        {
          label: 'Watch the recording',
          url: 'https://us06web.zoom.us/rec/share/4bH8PS7BP-BUu-S9uBCT2wwjgFjovcAd5BbZ-HMHTbg5tcG1Vdy7_1vFq6PfsA8w.bXYIsEmN_MaAXcfC',
        },
        {
          label: 'Worksheet',
          url: '/slides/work-origin-story-worksheet.pdf',
        },
      ],
    },
    {
      title: 'Small Talk & Sparking Curiosity',
      date: 'July 29, 2026',
      guest: 'Megan Finnerty',
      description:
        'No pitches, no elevators. A hands-on exercise for using small talk to spark real interest in others through shared values — build a 90-second narrative about what you do and why it matters.',
      links: [
        {
          label: 'Watch the recording',
          url: 'https://us06web.zoom.us/rec/share/A1Z8xKG32KFRxvP04f06clilISxwa9gPUSvXKfj80EzZUszmw4-1qlNzBXaVtsWa.u8W3ym_KHc5Iw1vW',
        },
        {
          label: 'Worksheet',
          url: '/slides/small-talk-sparking-curiosity-worksheet.pdf',
        },
      ],
    },
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
          url: '/slides/media-training.pdf',
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
      title: 'Build Your Analytics Guru',
      description:
        'A field guide to auditing your own analytics, payments and membership plumbing. Fifteen checks, five phases, with a checklist that remembers where you left off.',
      url: 'https://projectc.com/analytics-guru',
      image: 'members-art-analytics.jpg',
    },
    {
      title: 'Media Kit Builder',
      description:
        'Build a polished media kit in minutes. Fill in your numbers and get a shareable page for sponsors and partners.',
      url: 'https://projectc.com/media-kit-builder/',
      image: 'members-thumb-mediakit.jpg',
    },
    {
      title: 'Press Credential Generator',
      description:
        'Generate a Project C press credential with your name and outlet, ready to print or save.',
      url: 'https://projectc.com/credential-generator.html',
      image: 'members-thumb-credential.jpg',
    },
    {
      title: 'Tip Sheet: Effective Presentations',
      description:
        'A one-sheet on presenting well, from prep to delivery. Useful any time you have the mic, the camera, or the room.',
      url: '/slides/presentation-tips.pdf',
      image: 'members-art-tipsheet.jpg',
    },
    {
      title: 'Pitch Slam Exercise',
      description:
        'A fill-in-the-blanks workout for honing your project pitch, with examples and inspiration. Open the doc and make your own copy.',
      url: 'https://docs.google.com/document/d/1hga78KqeDKcVUcLuxWC35lkpauk9T3xosqSLIZGeQEA/edit',
      image: 'members-art-pitchslam.jpg',
    },
    {
      title: 'Chicago Creator Journalism Toolkit',
      description:
        'Practical business resources for independent creators, built with Press Forward Chicago and The Independent Journalism Atlas. Chicago-flavored but useful anywhere.',
      url: 'https://www.cct.org/wp-content/uploads/2026/06/Chicago-Creator-Journalism-Toolkit-Press-Forward-Chicago-and-The-Independent-Journalism-Atlas.pdf',
      image: 'members-thumb-chicago.jpg',
    },
    {
      title: 'Philanthropic partnerships proposal template',
      description:
        'A one-pager for pitching funders, courtesy of Nick Swyter at the NYT. Downloads as a Word doc you can adapt.',
      url: '/slides/philanthropy-proposal-template.docx',
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
  const data = events.slice(0, 12); // the page picks what it needs from these
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

  // Team allowlist — folks who run Project C and aren't in the memberships
  // table. Add teammates here (lowercase) as needed.
  const TEAM_EMAILS = {
    'liz@projectc.biz': 'Liz',
    'blair@idamedia.co': 'Blair',
    'annaloy04@gmail.com': 'Anna',
    'aprilbrumleyhinkle@gmail.com': 'April',
    'edresslar@gmail.com': 'Emily',
  };
  if (TEAM_EMAILS[email]) {
    return json(200, { ok: true, token: makeToken(email), firstName: TEAM_EMAILS[email] });
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

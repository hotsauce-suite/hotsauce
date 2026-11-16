// The demo's saved links (docs/PLAN-links-demo.md): articles with reading progress, highlights and
// notes, an arXiv paper with its PDF in Files, a bioRxiv paper without one, a PDF added from a
// computer, a link an AI tool saved, and two archived reads. Every page is written for the demo;
// the addresses use reserved .example domains so nothing points at a real article.

import type { LinkHighlight, LinkPaper, LinkSource, ReadingPlace } from '../api/links'
import { textPdf } from './fileSeed'

export interface SeedLink {
  n: number
  space: 'team' | 'ada'
  url: string
  title: string
  site: string
  description: string
  summary: string
  tags: string[]
  archived?: boolean
  savedBy: string
  daysAgo: number
  source: LinkSource
  status?: 'waiting' | 'ready'
  body: string
  /** The copy "Get the page" brings back, for a link that is waiting. */
  later?: string
  paper?: LinkPaper
  /** A PDF kept in Files with this link. */
  pdf?: { name: string; title: string; lines: string[] }
  /** The demo member's own place in it. */
  reading?: Omit<ReadingPlace, 'updated'> & { daysAgo: number }
  highlights?: Array<Omit<LinkHighlight, 'id' | 'name' | 'at' | 'block'> & { daysAgo: number }>
}

const WEEKLY_REVIEW = `Every team says it wants a weekly review. Most stop after three weeks. The reviews that survive have one thing in common: they are short, they happen at the same time, and they end with something written down.

## Start with what changed

Open last week's notes before anything else. Read the three things you said you would do, and mark each one done, moved or dropped. Dropping is allowed. A list that only grows is a list nobody trusts.

## Keep it to thirty minutes

A review that runs long becomes a planning meeting, and planning meetings get skipped. Set a timer. If a topic needs more than five minutes, write its name on a list and give it its own meeting.

## Write the review where the work lives

Notes in a private notebook disappear. Put the review in the same place as your docs and tasks, so the next person can find it without asking. The best weekly review is one a new teammate can read on their first day and understand what the team cares about.

## End with three things

Not ten. Three things the team will do before the next review, each with one name next to it. Everything else can wait a week.

## Make skipping visible

If the review doesn't happen, say so in the notes: "Skipped, launch week." A gap with a reason is fine. A silent gap is how the habit dies.`

const DECISIONS = `Six months from now, someone will ask why the team chose the tool, the vendor or the deadline it chose. If the answer lives only in someone's head, it is already gone.

## A decision record is short

Write the date, what was decided, who decided, and the two or three reasons that mattered. Add what you considered and turned down. That is the part people forget, and the part future readers need most.

## Write it the same day

Memory rewrites itself quickly. A decision written down the same afternoon is accurate; one written down a month later is a story.

## Link it from the work

A decision that sits in its own folder is rarely read. Link it from the doc, the task or the meeting note that it changed, so people meet it when they need it.`

const PAPER_BODY = `## Abstract

Small teams spend a large share of their week in meetings, yet the notes from those meetings are often incomplete, late or never written. We studied 41 teams over twelve weeks as they moved from hand-written minutes to notes drafted from a transcript and the attendees' own jottings. Teams using drafted notes shared them a median of 4 minutes after the call instead of 2.3 days, and action items were more often assigned to a named person (78% against 52%). Attendees edited 61% of drafted notes before sharing, mostly to remove detail rather than add it.

## 1. Introduction

Meeting notes serve two readers: the people who were there, who want a reminder of what they agreed, and the people who were not, who want to know what changed. Hand-written minutes rarely serve either well, because the person writing them is also trying to take part.

## 2. Method

We recruited teams of three to twelve people from research labs, small companies and non-profits. Each team used its usual meeting tool for four weeks, then drafted notes for eight weeks. We measured time to share, the share of action items with an owner, and how much attendees edited the draft.

## 3. Results

The largest change was speed. Notes that once arrived days later were shared before the attendees had left the call. Edits were small and mostly cut detail: people wanted shorter notes than the draft gave them.

## 4. Discussion

Drafted notes work best when the attendee's own jottings steer them. Teams that wrote even three short lines during a call got notes they edited less. We recommend tools keep the attendee in charge of what the notes say.`

const FREEZER_ABSTRACT =
  'Shared freezers in core facilities hold samples from many groups, and a single failure can lose months of work. We describe a shared freezer log, kept as a plain document with an alarm contact for each unit, adopted across nine core facilities. Over eighteen months, recorded sample loss fell from 14 incidents to 3, and the median time from alarm to response fell from 47 to 11 minutes. The log costs nothing to run and needs no new hardware.'

const FREEZER_BODY = `## Introduction

Ultra-low freezers fail more often than most labs expect, and the alarm is only useful if someone who can act on it hears it. In shared facilities, nobody is sure whose job that is.

## What we changed

Each freezer got one page in a shared document: what is inside, by shelf; who to call, in order; and the last three alarms with what happened. The page is reviewed at the facility's monthly meeting.

## Results

Most of the improvement came from the call list. When the first person on the list was named and reachable, alarms were answered in minutes.

## Discussion

The log needs no new hardware and costs nothing to run. Its weak point is the call list going stale, so we tie its review to a meeting that already happens.`

const QUESTIONNAIRE_LINES = [
  'Vendor security questionnaire: summary of answers',
  '',
  'Data: documents stay on our own server; backups go to our own storage bucket.',
  'Sign-in: Google accounts for staff, emailed codes for invited guests.',
  'Access: each person sees the team space and their own private space.',
  'History: every change is a git commit with its author and time.',
  'AI: notes are drafted with our own API key; nothing is used for training.',
  'Incidents: we tell affected customers within 72 hours.',
]

const QUESTIONNAIRE_BODY = QUESTIONNAIRE_LINES.slice(2).join('\n\n')

const ONBOARDING = `The first week sets how a new teammate feels about the next year. Calm onboarding is less about a perfect checklist and more about removing surprises.

## Before day one

Send the schedule for the first week, the name of a buddy, and one doc worth reading. Nothing else.

## Day one

Accounts work before they arrive. Lunch is with the team. The first task is small and real, and it ships by Friday.`

const TIDY_DOCS = `Docs rot quietly. Nobody decides to let them go stale; they just stop being touched. Five habits keep them useful.

## 1. One home per fact

If the same fact lives in two docs, one of them is wrong. Pick a home and link to it.

## 2. Date the top

A line that says when the doc was last checked tells readers how far to trust it.

## 3. Archive, don't delete

Move finished docs to an archive folder. Search still finds them, and the main list stays short.

## 4. Name docs for the question they answer

"How we ship a release" beats "Release process v3".

## 5. Review one folder a week

Ten minutes, one folder, at the weekly review. It adds up.`

const TWO_PIZZA = `Small teams move faster, but the reason is not the headcount. It is the number of conversations. Five people have ten pairs to keep in sync; ten people have forty-five.

## What to do about it

Write more down, so fewer of those conversations have to happen live.`

export function seedLinks(people: { ada: string; priya: string; sam: string }): SeedLink[] {
  return [
    {
      n: 1,
      space: 'team',
      url: 'https://fieldnotes.example/weekly-review',
      title: 'How to run a weekly review that actually sticks',
      site: 'Field Notes',
      description: 'Short, same time every week, and written down where the work lives.',
      summary:
        'Weekly reviews survive when they are short, start from last week’s notes, live beside the work, and end with three owned actions.',
      tags: ['process', 'writing'],
      savedBy: people.priya,
      daysAgo: 2,
      source: 'extension',
      body: WEEKLY_REVIEW,
      reading: { anchor: 4, percent: 38, furthest: 42, daysAgo: 1 },
      highlights: [
        {
          by: people.priya,
          quote: 'A list that only grows is a list nobody trusts.',
          note: 'This is our Tasks inbox right now.',
          daysAgo: 2,
        },
        {
          by: people.ada,
          quote:
            'The best weekly review is one a new teammate can read on their first day and understand what the team cares about.',
          note: 'Let’s move our Friday review into a team doc.',
          daysAgo: 1,
        },
        {
          by: people.ada,
          quote:
            'Three things the team will do before the next review, each with one name next to it.',
          daysAgo: 1,
        },
      ],
    },
    {
      n: 2,
      space: 'team',
      url: 'https://arxiv.example/abs/2611.04217',
      title: 'Meeting notes that write themselves: a field study of drafted minutes in small teams',
      site: '',
      description: '',
      summary: '',
      tags: ['meetings', 'research'],
      savedBy: people.sam,
      daysAgo: 3,
      source: 'extension',
      body: PAPER_BODY,
      paper: {
        server: 'arxiv',
        id: '2611.04217',
        version: 2,
        authors: [
          'Mira Castellanos',
          'Tomas Lindqvist',
          'Aiko Hayashi',
          'Daniel Osei',
          'Ruth Abara',
        ],
        published: '2026-11-03',
        doi: '10.48550/arXiv.2611.04217',
        abstract:
          'We studied 41 teams over twelve weeks as they moved from hand-written minutes to notes drafted from a transcript and the attendees’ own jottings. Drafted notes were shared a median of 4 minutes after the call instead of 2.3 days, and more action items had a named owner.',
      },
      pdf: {
        name: 'Meeting notes that write themselves (arXiv 2611.04217v2).pdf',
        title: 'Meeting notes that write themselves',
        lines: [
          'A field study of drafted minutes in small teams',
          'Mira Castellanos, Tomas Lindqvist, Aiko Hayashi, Daniel Osei, Ruth Abara',
          '',
          'Abstract',
          'We studied 41 teams over twelve weeks as they moved from hand-written',
          'minutes to notes drafted from a transcript and the attendees jottings.',
          'Drafted notes were shared a median of 4 minutes after the call.',
        ],
      },
      reading: { anchor: 1, percent: 12, furthest: 12, daysAgo: 2 },
      highlights: [
        {
          by: people.sam,
          quote:
            'Attendees edited 61% of drafted notes before sharing, mostly to remove detail rather than add it.',
          note: 'Matches what we see: people want shorter notes.',
          daysAgo: 3,
        },
      ],
    },
    {
      n: 3,
      space: 'ada',
      url: 'https://operators.example/write-decisions-down',
      title: 'Why we write decisions down',
      site: 'The Operator’s Notebook',
      description: 'A decision record is short, written the same day, and linked from the work.',
      summary:
        'Record the date, the decision, who made it, the reasons and the options turned down, on the same day, linked from the work it changed.',
      tags: ['writing'],
      savedBy: people.ada,
      daysAgo: 1,
      source: 'share',
      body: DECISIONS,
      reading: { anchor: 6, percent: 100, furthest: 100, daysAgo: 0 },
      highlights: [
        {
          by: people.ada,
          quote: 'That is the part people forget, and the part future readers need most.',
          note: 'Add an “Options we turned down” heading to our decision template.',
          daysAgo: 0,
        },
      ],
    },
    {
      n: 4,
      space: 'team',
      url: 'https://biorxiv.example/content/10.1101/2026.10.28.618244v1',
      title: 'A shared freezer log cuts sample loss in core facilities',
      site: '',
      description: '',
      summary: '',
      tags: ['lab'],
      savedBy: people.priya,
      daysAgo: 5,
      source: 'web',
      // bioRxiv gives servers its text but not its PDF, so "Add the PDF" shows (help/links).
      body: FREEZER_BODY,
      paper: {
        server: 'biorxiv',
        id: '2026.10.28.618244',
        version: 1,
        authors: ['Grace Whitfield', 'Samuel Adeyemi', 'Lena Brandt'],
        published: '2026-10-30',
        doi: '10.1101/2026.10.28.618244',
        abstract: FREEZER_ABSTRACT,
      },
    },
    {
      n: 5,
      space: 'ada',
      url: '',
      title: 'Vendor security questionnaire',
      site: '',
      description: '',
      summary:
        'How we answer the usual security questions: where data lives, sign-in, access and AI.',
      tags: ['security'],
      savedBy: people.ada,
      daysAgo: 4,
      source: 'web',
      body: QUESTIONNAIRE_BODY,
      pdf: {
        name: 'Vendor security questionnaire.pdf',
        title: 'Vendor security questionnaire',
        lines: QUESTIONNAIRE_LINES,
      },
    },
    {
      n: 6,
      space: 'ada',
      url: 'https://smallteams.example/tidy-docs',
      title: 'Five habits that keep a small team’s docs tidy',
      site: 'smallteams.example',
      description: '',
      summary: '',
      tags: ['writing'],
      savedBy: people.ada,
      daysAgo: 6,
      source: 'mcp',
      status: 'waiting',
      body: '',
      later: TIDY_DOCS,
    },
    {
      n: 7,
      space: 'team',
      url: 'https://peopleops.example/calm-onboarding',
      title: 'A field guide to calm onboarding',
      site: 'People Ops Weekly',
      description: 'Remove surprises from a new teammate’s first week.',
      summary:
        'Send the first week’s schedule, a buddy and one doc; make accounts work before day one.',
      tags: ['process'],
      archived: true,
      savedBy: people.sam,
      daysAgo: 12,
      source: 'extension',
      body: ONBOARDING,
      reading: { anchor: 4, percent: 100, furthest: 100, daysAgo: 10 },
    },
    {
      n: 8,
      space: 'ada',
      url: 'https://operators.example/two-pizza-revisited',
      title: 'The two-pizza rule, revisited',
      site: 'The Operator’s Notebook',
      description: '',
      summary: 'Small teams are fast because they have fewer conversations to keep in sync.',
      tags: [],
      archived: true,
      savedBy: people.ada,
      daysAgo: 20,
      source: 'web',
      body: TWO_PIZZA,
      reading: { anchor: 2, percent: 100, furthest: 100, daysAgo: 19 },
    },
  ]
}

/** What a link saved in the demo reads, since the demo can't visit pages. */
export function demoCopy(url: string): string {
  return `The live demo doesn’t visit web pages, so this is a stand-in for the page at ${url}.

On your own Hotsauce, you’d read a clean copy of it here, with the clutter taken out. Select some words to highlight them and add a note.

Hotsauce remembers where you stopped, so the next time you open this link it picks up where you left off.`
}

export { textPdf }

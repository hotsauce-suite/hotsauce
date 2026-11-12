// Three past meetings across two days, each with a transcript, raw notes and `ai_ranges`:
// two in the member's personal space, one shared to the team.

import { meetingPaths } from '@hearth/format'
import type { Author } from '../api/types'
import {
  ACME_KICKOFF_EVENT,
  aiRangesFor,
  type MeetingFile,
  meetingNoteText,
  transcriptText,
} from './fakeMeetings'
import type { FakeRepo } from './fakeRepo'

interface SeedMeeting {
  id: string
  title: string
  daysAgo: number
  hour: number
  minute: number
  durationMin: number
  template: string
  attendees: string[]
  calendarEventId?: string
  rawNotes: string
  body: string
  transcript: Array<{ at: number; speaker: string; text: string }>
}

const ACME_KICKOFF: SeedMeeting = {
  id: '01JA3B7K2N8X4P6Q9R0S5T1ACM',
  title: 'Acme kickoff',
  daysAgo: 1,
  hour: 10,
  minute: 0,
  durationMin: 32,
  template: 'customer-call',
  attendees: ['Ada Lovelace <ada@example.test>', 'Dana Lee <dana@acme.com>'],
  calendarEventId: ACME_KICKOFF_EVENT,
  rawNotes: 'SSO before rollout\npricing ok if annual\n- [ ] Ada: send pricing one-pager (Fri)\n',
  body: `# Acme kickoff

## Summary
- Dana walked through Acme’s rollout plan for the assay kits across three sites.
- SSO is the gating item for their IT team; pricing works in principle.

## Their situation
SSO before rollout
- Acme runs Okta and won’t onboard any tool without SAML.
- Three sites and about 40 bench scientists, starting in Boston.

## Needs and objections
pricing ok if annual
- Dana asked for annual billing with an exit after a 60-day pilot.
- Reagent lead times in December are a worry.

## Next steps
- Send the pricing one-pager and the SSO roadmap.

## Action items
- [ ] Ada: send pricing one-pager (Fri)
- [ ] Dana: intro to their ops lead
`,
  transcript: [
    {
      at: 4,
      speaker: 'Me',
      text: 'Thanks for making time, Dana. Shall we start with the rollout?',
    },
    { at: 11, speaker: 'Them', text: 'Sure. We’d need SSO before rolling out to the other sites.' },
    { at: 25, speaker: 'Me', text: 'Understood. Is that SAML through Okta?' },
    { at: 31, speaker: 'Them', text: 'Yes, Okta. IT won’t onboard anything without it.' },
    {
      at: 62,
      speaker: 'Them',
      text: 'On pricing, annual works if we can exit after a 60-day pilot.',
    },
    { at: 75, speaker: 'Me', text: 'That’s fair. I’ll send the pricing one-pager by Friday.' },
    { at: 100, speaker: 'Them', text: 'I’ll intro you to our ops lead about reagent lead times.' },
  ],
}

const PRIYA_ONE_ON_ONE: SeedMeeting = {
  id: '01JA3B7K2N8X4P6Q9R0S5T1PRI',
  title: 'Priya 1:1',
  daysAgo: 1,
  hour: 15,
  minute: 30,
  durationMin: 25,
  template: 'one-on-one',
  attendees: ['Ada Lovelace <ada@example.test>', 'Priya Natarajan <priya@example.test>'],
  rawNotes: 'hiring: second assay scientist\nfeedback on onboarding doc\n',
  body: `# Priya 1:1

## Check-in
- Priya is settling into the pilot work; the lab move is done.

## Topics
hiring: second assay scientist
- Priya wants the role posted this week, with a work sample in the loop.
feedback on onboarding doc
- The onboarding doc needs a section on reagent ordering.

## Feedback
- Standups run long; keep them to 15 minutes.

## Action items
- [ ] Priya: draft the assay scientist posting (Wed)
- [ ] Ada: add reagent ordering to the onboarding doc
`,
  transcript: [
    { at: 3, speaker: 'Me', text: 'How’s the lab move going?' },
    { at: 9, speaker: 'Them', text: 'Done, finally. The pilot work is picking up.' },
    { at: 40, speaker: 'Them', text: 'We should post the second assay scientist role this week.' },
    { at: 58, speaker: 'Me', text: 'Agreed. Let’s keep a work sample in the loop.' },
    { at: 90, speaker: 'Them', text: 'The onboarding doc doesn’t say how to order reagents.' },
    { at: 120, speaker: 'Them', text: 'And standups run long. Fifteen minutes would be better.' },
  ],
}

const PILOT_DEBRIEF: SeedMeeting = {
  id: '01JA3B7K2N8X4P6Q9R0S5T1PIL',
  title: 'Pilot debrief',
  daysAgo: 2,
  hour: 11,
  minute: 0,
  durationMin: 41,
  template: 'general',
  attendees: [
    'Ada Lovelace <ada@example.test>',
    'Sam Okafor <sam@example.test>',
    'Priya Natarajan <priya@example.test>',
    'Lena Brooks <lena@northwind.bio>',
  ],
  rawNotes: 'Northwind pilot: 2 of 3 assays passed\nneed better sample tracking\n',
  body: `# Pilot debrief

## Summary
- Northwind’s pilot is mostly on track: two of three assays met the spec.

## Discussion
Northwind pilot: 2 of 3 assays passed
- The third assay failed on sample contamination, not the kit itself.
need better sample tracking
- Sam proposed barcode labels for every sample tube.

## Decisions
- Rerun the third assay next week with barcoded tubes.

## Action items
- [ ] Sam: order barcode labels
- [ ] Priya: schedule the rerun with Northwind
`,
  transcript: [
    { at: 6, speaker: 'Them', text: 'Two of the three assays met the spec on the first run.' },
    { at: 21, speaker: 'Me', text: 'What happened with the third?' },
    { at: 30, speaker: 'Them', text: 'Sample contamination. The kit itself looked fine.' },
    { at: 55, speaker: 'Them', text: 'We could put barcode labels on every sample tube.' },
    { at: 80, speaker: 'Me', text: 'Let’s rerun the third assay next week with barcoded tubes.' },
  ],
}

function writeMeeting(repo: FakeRepo, space: string, m: SeedMeeting, author: Author): void {
  const date = new Date()
  date.setDate(date.getDate() - m.daysAgo)
  date.setHours(m.hour, m.minute, 0, 0)
  const { note, transcript } = meetingPaths(date, m.title)
  const file: MeetingFile = {
    id: m.id,
    title: m.title,
    date,
    durationMin: m.durationMin,
    attendees: m.attendees,
    template: m.template,
    ...(m.calendarEventId ? { calendarEventId: m.calendarEventId } : {}),
    transcriptName: transcript.slice(transcript.lastIndexOf('/') + 1),
    aiRanges: aiRangesFor(m.body, m.rawNotes),
    body: m.body,
  }
  repo.space(space).commit(
    new Map([
      [note, meetingNoteText(file)],
      [transcript, transcriptText(m.title, m.transcript)],
      [`.hearth/meetings/raw/${m.id}.md`, m.rawNotes],
    ]),
    author,
    `meetings: capture "${m.title}"`,
    { date: new Date(date.getTime() + m.durationMin * 60_000) },
  )
}

export function seedTeamMeetings(repo: FakeRepo, author: Author): void {
  writeMeeting(repo, 'team', PILOT_DEBRIEF, author)
}

export function seedPersonalMeetings(repo: FakeRepo, space: string, author: Author): void {
  writeMeeting(repo, space, ACME_KICKOFF, author)
  writeMeeting(repo, space, PRIYA_ONE_ON_ONE, author)
}

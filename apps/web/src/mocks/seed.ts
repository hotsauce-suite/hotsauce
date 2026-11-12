import type { Author } from '../api/types'
import type { FakeRepo, FakeUser } from './fakeRepo'
import longHandbook from './fixtures/long.md?raw'
import { seedPersonalMeetings, seedTeamMeetings } from './meetingSeed'

export const PRIYA: Author = { name: 'Priya Natarajan', email: 'priya@example.test' }
export const SAM: Author = { name: 'Sam Okafor', email: 'sam@example.test' }
export const ADA: Author = { name: 'Ada Lovelace', email: 'ada@example.test' }

/** The line in the conflict demo that the armed outside edit also changes. */
export const CONFLICT_DEMO_LINE = 'Standup is at 9:30, cameras optional.'

const SKETCH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240" viewBox="0 0 640 240">
<defs><radialGradient id="g" cx="50%" cy="85%" r="70%"><stop offset="0" stop-color="#f2a65a"/><stop offset="0.45" stop-color="#d4471f"/><stop offset="1" stop-color="#2a221d"/></radialGradient></defs>
<rect width="640" height="240" fill="url(#g)"/>
<path d="M320 52c38 44 58 74 58 108a58 58 0 0 1-116 0c0-22 10-38 24-54 4 18 12 28 24 32-6-30 0-58 10-86z" fill="#fbf3e6" opacity=".92"/>
</svg>`

const WELCOME = `---
id: 01JA2Z8Q4M7V3K9R5T1XWYB6CD
title: Welcome to Hearth Docs
created: 2026-10-01T09:00:00Z
tags: [guide]
---

# Welcome to Hearth Docs

Every doc here is a **plain markdown file** in Git. Edit it here, in *Obsidian*, or with an agent, and it stays in sync.

## What you can do

- Write with live preview: headings, **bold**, *italic*, ~~strike~~ and \`inline code\`.
- Link docs with \`[[\`, which writes a standard link like [the Q4 plan](plans/q4-plan.md).
- Paste an image and it lands in \`assets/\`.

## This week

- [x] Move new memos out of Google Docs
- [ ] Try the reading view
- [ ] Star the docs you open every day

> [!note] Saving
> Hearth commits after a short pause, when you leave a doc, or when you choose **Save version**.

![Hearth sketch](../assets/2026/10/hearth-sketch-01JA2Z.svg)

| Shortcut | Does |
| --- | --- |
| Cmd-K | Search everything |
| Cmd-B | Bold |
| Cmd-I | Italic |

\`\`\`ts
export function greet(name: string): string {
  return \`Welcome, \${name}\`
}
\`\`\`
`

const Q4_V1 = `---
id: 01JA2Z8Q4M7V3K9R5T1XWYB6Q4
title: Q4 plan
created: 2026-09-12T14:03:00Z
tags: [planning]
---

# Q4 plan

## Goals

- Ship Hearth Docs to the whole team.
- Close two pilot customers.

## Budget

Hold spend flat until the pilots sign.
`

const Q4_V2 = Q4_V1.replace(
  '- Close two pilot customers.',
  '- Close two pilot customers.\n- Hire a second assay scientist.',
)

const Q4_V3 = `${Q4_V2.replace('Hold spend flat until the pilots sign.', 'Hold spend flat until the pilots sign; revisit on **Nov 15**.')}
## Risks

- Reagent lead times slip past December.
- We underestimate onboarding for the pilots.
`

const HIRING = `---
id: 01JA2Z8Q4M7V3K9R5T1XWYB6HR
title: Hiring plan
---

# Hiring plan

## Roles

1. Assay scientist (Q4)
2. Operations lead (Q1)

## Process

Two interviews, one work sample, references last.
`

const ARCHITECTURE = `# Architecture notes

The server is one Hono process. Git is the source of truth; SQLite is a cache.

\`\`\`sql
select path, title from files where space = 'team' order by mtime desc limit 20;
\`\`\`

See the [onboarding guide](onboarding.md) for local setup.
`

const ONBOARDING = `# Onboarding

- [ ] Get a example.test Google account
- [ ] Sign in to Hearth
- [ ] Read the [welcome doc](../welcome.md)
`

const CONFLICT_DEMO = `# Team rituals

How we meet, and why.

## Weekly

Planning happens on Mondays.
${CONFLICT_DEMO_LINE}
Demos are on Fridays.

## Quarterly

Offsite in the first week of the quarter.
`

function seedTeam(repo: FakeRepo): void {
  const team = repo.space('team')
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)
  const q4 = 'docs/plans/q4-plan.md'

  team.commit(
    new Map<string, string | null>([
      ['README.md', '# Team\n\nShared space for Acme.\n'],
      ['docs/welcome.md', WELCOME],
      ['docs/eng/architecture-notes.md', ARCHITECTURE],
      ['docs/eng/onboarding.md', ONBOARDING],
      ['docs/team-rituals.md', CONFLICT_DEMO],
      ['docs/reference/operating-handbook.md', longHandbook],
      ['docs/archive/.gitkeep', ''],
    ]),
    SAM,
    'docs: seed team space',
    { date: daysAgo(9) },
  )
  team.binaries.set('assets/2026/10/hearth-sketch-01JA2Z.svg', {
    bytes: SKETCH_SVG,
    type: 'image/svg+xml',
  })
  team.commit(new Map([[q4, Q4_V1]]), ADA, 'docs: create "Q4 plan"', { date: daysAgo(6) })
  team.commit(new Map([[q4, Q4_V2]]), PRIYA, 'docs: edit "Q4 plan"', { date: daysAgo(4) })
  team.commit(new Map([['docs/plans/hiring.md', HIRING]]), SAM, 'docs: create "Hiring plan"', {
    date: daysAgo(3),
  })
  team.commit(new Map([[q4, Q4_V3]]), ADA, 'docs: edit "Q4 plan"', {
    label: 'Board draft',
    date: daysAgo(1),
  })

  seedTeamMeetings(repo, ADA)

  // A conflict left by an earlier save, so the banner and resolver show on open.
  repo.addConflict(
    'team',
    'docs/plans/hiring.md',
    HIRING.replace('Two interviews, one work sample', 'Three interviews, one paid work sample'),
  )

  // The next save of the rituals doc races a teammate's edit of the standup line.
  repo.armOutsideEdit('team', 'docs/team-rituals.md', {
    author: PRIYA,
    apply: (content) => content.replace(CONFLICT_DEMO_LINE, 'Standup is at 9:45, cameras on.'),
  })
}

export function seedPersonal(repo: FakeRepo, user: FakeUser): void {
  if (repo.spaces.has(user.handle)) return
  const space = repo.space(user.handle)
  const author = { name: user.name, email: user.email }
  space.commit(
    new Map<string, string | null>([
      ['README.md', `# ${user.name}\n\nPersonal space.\n`],
      ['docs/scratch.md', '# Scratch\n\nQuick notes that are not ready for the team.\n'],
      [
        'docs/ideas/reading-list.md',
        '# Reading list\n\n- [ ] *The Design of Everyday Things*\n- [ ] *Working in Public*\n',
      ],
    ]),
    author,
    'docs: seed personal space',
  )
  seedPersonalMeetings(repo, user.handle, author)
}

export function seed(repo: FakeRepo): void {
  seedTeam(repo)
}

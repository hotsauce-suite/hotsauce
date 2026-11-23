// Sample files for the demo's Files app: a chart, a checklist, interview notes, a survey export,
// a one-page PDF and a logo, all generated here so the previews show real bytes.

import { PILOT_CHART_PNG_BASE64 } from './fixtures/pilotChart'

export interface SeedFile {
  folder: string
  name: string
  bytes: Uint8Array
  /** The text a preview or search reads; empty when there is none. */
  text: string
  by: string
  daysAgo: number
  shared?: boolean
}

const encoder = new TextEncoder()

function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** A one-page PDF of plain text lines (Helvetica, ASCII only), with a correct xref table. */
export function textPdf(title: string, lines: string[]): Uint8Array {
  return pagesPdf([{ title, lines }])
}

/** A PDF with a page per entry, each a title and plain text lines (Helvetica, ASCII only). */
export function pagesPdf(pages: Array<{ title: string; lines: string[] }>): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`)
  const font = 3 + pages.length * 2
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  ]
  for (const [i, page] of pages.entries()) {
    const content = [
      'BT',
      '/F1 22 Tf',
      '72 740 Td',
      `(${esc(page.title)}) Tj`,
      '/F1 12 Tf',
      '0 -36 Td',
      ...page.lines.flatMap((line) => [`(${esc(line)}) Tj`, '0 -18 Td']),
      'ET',
    ].join('\n')
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    )
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const at of offsets) pdf += `${String(at).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return encoder.encode(pdf)
}

/** Three pages for PDF tools in the demo: split it, turn a page, redact the names. */
const AGREEMENT = [
  {
    title: 'Pilot agreement: Acme and Hotsauce',
    lines: [
      'Between Acme Ltd (contact: Dana Lee, dana.lee@acme.example) and the Hotsauce team.',
      'The pilot runs for 60 days across the Leeds, Austin and Pune sites.',
      'Each site names one lead; the leads meet every Monday at 9:00.',
    ],
  },
  {
    title: 'Scope and success measures',
    lines: [
      'In scope: Docs, Meetings, Tasks and Files for every site team.',
      'Success: 80% of standups noted in Hotsauce by week 4.',
      'Budget code ACME-7731, approved by Dana Lee.',
    ],
  },
  {
    title: 'Signatures',
    lines: ['Dana Lee, Acme Ltd', '', 'Ada Lovelace, for the Hotsauce team'],
  },
]

const ONE_PAGER_LINES = [
  'What: a 60-day pilot of Hotsauce with Acme across three sites.',
  'Who: Dana Lee (Acme) with Ada Lovelace, Priya Natarajan and Sam Okafor.',
  '',
  'Goals',
  '- Every site team runs its weekly standup notes in Hotsauce Docs.',
  '- Meeting notes and action items land in Tasks without copy-paste.',
  '- 40 active people by the end of week 8.',
  '',
  'Timeline',
  '- Week 0: SAML sign-in through Okta, admin walkthrough.',
  '- Weeks 1-2: North site goes live.',
  '- Weeks 3-4: Harbor and Valley sites go live.',
  '- Week 8: pilot review and rollout decision.',
  '',
  'Success looks like',
  '- Sign-ups growing every week, and fewer status meetings.',
  '- A yes from Dana on the annual plan.',
]

const CHECKLIST = `# Pilot launch checklist

## Before day one
- [x] Okta SAML app set up and tested with Dana
- [x] Team space created with the pilot folders
- [ ] Welcome email drafted (Priya)
- [ ] Office hours booked for weeks 1 and 2 (Sam)

## Launch day
- [ ] Walkthrough for the North site leads
- [ ] Post the feedback form in the pilot channel
- [ ] Check sign-ups at the end of the day

## Week one
- [ ] Review the first round of feedback
- [ ] Fix anything blocking the Harbor site
`

const INTERVIEW_NOTES = `Site interviews, pilot week 2
Interviewer: Priya Natarajan

North site (ops lead)
- Standup notes used to live in three different chat threads.
- Likes that a meeting's action items show up as tasks straight away.
- Wants a shared view of open tasks per site.

Harbor site (team lead)
- Onboarding took ten minutes once SAML was in place.
- Asked whether old docs can be imported from their shared drive.
- Mobile use is higher than we expected: mostly reading on the floor.

Valley site (coordinator)
- Not started yet; waiting on two laptops.
- Main worry is people falling back to email.

Follow-ups
- Sam: write up the import path for old docs.
- Ada: share the sign-up chart in Thursday's review.
`

const SURVEY_CSV = `site,role,weekly_users,rating
North,Ops lead,18,5
North,Coordinator,18,4
Harbor,Team lead,21,4
Harbor,Technician,21,5
Valley,Coordinator,9,3
`

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
<rect width="256" height="256" rx="56" fill="#c63d19"/>
<path d="M128 44c30 34 46 58 46 86a46 46 0 0 1-92 0c0-18 8-30 19-43 3 14 9 22 19 25-5-24 0-46 8-68z" fill="#fbf3e6"/>
</svg>
`

export function seedFileContents(people: { ada: string; priya: string; sam: string }): SeedFile[] {
  return [
    {
      folder: 'Pilot launch',
      name: 'Pilot sign-ups by week.png',
      bytes: base64Bytes(PILOT_CHART_PNG_BASE64),
      text: '',
      by: people.ada,
      daysAgo: 0.2,
    },
    {
      folder: 'Pilot launch',
      name: 'Launch checklist.md',
      bytes: encoder.encode(CHECKLIST),
      text: CHECKLIST,
      by: people.priya,
      daysAgo: 1,
    },
    {
      folder: 'Pilot launch',
      name: 'Acme pilot one-pager.pdf',
      bytes: textPdf('Acme pilot one-pager', ONE_PAGER_LINES),
      text: ['Acme pilot one-pager', ...ONE_PAGER_LINES].join('\n'),
      by: people.ada,
      daysAgo: 3,
      shared: true,
    },
    {
      folder: 'Pilot launch',
      name: 'Acme pilot agreement.pdf',
      bytes: pagesPdf(AGREEMENT),
      text: AGREEMENT.flatMap((p) => [p.title, ...p.lines]).join('\n'),
      by: people.ada,
      daysAgo: 5,
    },
    {
      folder: 'Research',
      name: 'Site interviews - week 2.txt',
      bytes: encoder.encode(INTERVIEW_NOTES),
      text: INTERVIEW_NOTES,
      by: people.priya,
      daysAgo: 2,
    },
    {
      folder: 'Research',
      name: 'Pilot survey export.csv',
      bytes: encoder.encode(SURVEY_CSV),
      text: SURVEY_CSV,
      by: people.sam,
      daysAgo: 4,
    },
    {
      folder: '',
      name: 'Hotsauce logo.svg',
      bytes: encoder.encode(LOGO_SVG),
      text: '',
      by: people.sam,
      daysAgo: 9,
    },
  ]
}

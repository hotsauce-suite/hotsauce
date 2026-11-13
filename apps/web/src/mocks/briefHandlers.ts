// MSW routes for `/api/brief` (ARCHITECTURE §13.3), in memory. The "brief" is built from the
// member's meetings in the fake repo, so the page shows something real-looking in dev.

import { type AnyHandler, delay, HttpResponse, http } from 'msw'
import type { AgentBrief, BriefState } from '../api/brief'
import type { FakeUser } from './fakeRepo'

const SECTIONS = [
  'Overview',
  'Current priorities',
  'Projects',
  'People',
  'Glossary',
  'Communication style',
  'Habits',
  'Identity and role',
  'What changed',
]

export class FakeBriefs {
  readonly #state = new Map<string, BriefState>()

  get(email: string): BriefState {
    return this.#state.get(email) ?? { brief: null, notes: '' }
  }

  write(user: FakeUser, meetings: number): AgentBrief {
    const notes = this.get(user.email).notes
    const body = [
      `## Overview\n\n- You are ${user.name}, running pilots and customer onboarding at Acme. Most of your week is customer calls and the Q4 plan.${notes ? ` You said: ${notes.split('\n')[0]}` : ''}`,
      '## Current priorities\n\n- Close the Acme pilot: send the pricing one-pager by Friday and answer their SSO questions.\n- Hire a second assay scientist; Priya drafts the posting Wednesday.\n- Rerun the Northwind pilot after the barcode label mix-up.',
      '## People\n\n- **Dana Lee**, Acme ops: wants annual billing with a 60-day exit.\n- **Priya Natarajan**, your lab lead: owns hiring and reagent orders.\n- **Sam Okafor**: runs pilot logistics and the budget.',
      '## Glossary\n\n- **Kit**: the assay kit shipped to each pilot site.\n- **Rerun**: repeating a pilot batch after a failed run.',
      '## Communication style\n\n- Short answers first, detail after. Bullet points over paragraphs.',
    ].join('\n\n')
    const brief: AgentBrief = {
      space: user.handle,
      path: '.hearth/brief/brief.md',
      body,
      generated: new Date().toISOString(),
      model: 'fake',
      meetings,
      tasks: 0,
    }
    this.#state.set(user.email, { brief, notes })
    return brief
  }

  setNotes(email: string, notes: string): void {
    this.#state.set(email, { ...this.get(email), notes })
  }
}

export function briefHandlers(deps: {
  briefs: FakeBriefs
  latencyMs: number
  principal: (request: Request) => FakeUser | Response
  meetingCount: (user: FakeUser) => number
}): AnyHandler[] {
  const { briefs, principal } = deps
  const wait = () => (deps.latencyMs > 0 ? delay(deps.latencyMs) : Promise.resolve())
  return [
    http.get('/api/brief', async ({ request }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      await wait()
      return HttpResponse.json(briefs.get(user.email))
    }),
    http.post('/api/brief/refresh', async ({ request }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      await wait()
      const meetings = deps.meetingCount(user)
      if (meetings === 0) return HttpResponse.json({ status: 'empty', ...briefs.get(user.email) })
      briefs.write(user, meetings)
      return HttpResponse.json({ status: 'written', ...briefs.get(user.email) })
    }),
    http.put('/api/brief/notes', async ({ request }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      const { text } = (await request.json()) as { text: string }
      briefs.setNotes(user.email, text)
      return new HttpResponse(null, { status: 204 })
    }),
  ]
}

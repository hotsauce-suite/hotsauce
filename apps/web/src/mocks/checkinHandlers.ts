// MSW routes for `/api/checkins` (ARCHITECTURE §24.4): one check-in whose round is open now, and
// `/api/dictation/transcribe` answering with fixed words.

import { type AnyHandler, HttpResponse, http } from 'msw'
import type { CheckinAnswer, CheckinInput, CheckinView } from '../api/checkins'
import type { FakeUser } from './fakeRepo'

export const DICTATED_WORDS = 'Finish the freezer quote'

export function checkinHandlers(opts: {
  principal: (request: Request) => FakeUser | Response
}): AnyHandler[] {
  const today = new Date().toISOString().slice(0, 10)
  let seq = 0
  const nextId = () => `01JCHECKIN${String(++seq).padStart(16, '0')}`
  const checkins = new Map<string, Omit<CheckinView, 'canManage' | 'current'>>()
  const seed = (input: CheckinInput) => {
    const id = nextId()
    checkins.set(id, {
      id,
      ...input,
      tz: 'UTC',
      schedule: input.days.includes('mon') ? 'Mondays at 9 AM' : 'Fridays at 3 PM',
      blobOid: `blob-${id}`,
      createdBy: 'ada@example.test',
      asked: [
        { email: 'ada@example.test', name: 'Ada Lovelace' },
        { email: 'grace@example.test', name: 'Grace Hopper' },
      ],
      rounds: [{ date: today, answers: [], summary: null }],
    })
    return id
  }
  seed({
    title: 'What will you get done this week?',
    days: ['mon'],
    time: '09:00',
    room: null,
    skip: [],
    paused: false,
  })

  const view = (c: Omit<CheckinView, 'canManage' | 'current'>, user: FakeUser): CheckinView => {
    const round = c.rounds[0]
    const rounds = c.rounds.map((r) => ({
      ...r,
      answers: r.answers.map((a) => ({ ...a, mine: a.email === user.email })),
    }))
    return {
      ...c,
      rounds,
      canManage: user.email.startsWith('ada@'),
      current: round
        ? {
            date: round.date,
            answered: round.answers.some((a) => a.email === user.email),
            answers: round.answers.length,
          }
        : null,
    }
  }

  const withUser =
    (
      fn: (
        user: FakeUser,
        request: Request,
        params: Record<string, unknown>,
      ) => Response | Promise<Response>,
    ) =>
    async ({ request, params }: { request: Request; params: Record<string, unknown> }) => {
      const user = opts.principal(request)
      if (user instanceof Response) return user
      return fn(user, request, params)
    }
  const missing = () =>
    HttpResponse.json(
      { error: { code: 'not_found', message: 'No such check-in' } },
      { status: 404 },
    )

  return [
    http.get(
      '/api/checkins',
      withUser((user) =>
        HttpResponse.json({
          checkins: [...checkins.values()].map((c) => {
            const { rounds: _r, asked: _a, blobOid: _b, createdBy: _c, ...item } = view(c, user)
            return item
          }),
          canManage: user.email.startsWith('ada@'),
        }),
      ),
    ),
    http.get(
      '/api/checkins/due',
      withUser((user) =>
        HttpResponse.json({
          due: [...checkins.values()]
            .map((c) => view(c, user))
            .filter((c) => !c.paused && c.current && !c.current.answered)
            .map((c) => ({
              id: c.id,
              title: c.title,
              date: c.current?.date,
              opensAt: new Date().toISOString(),
            })),
        }),
      ),
    ),
    http.post(
      '/api/checkins',
      withUser(async (user, request) => {
        const id = seed((await request.json()) as CheckinInput)
        const c = checkins.get(id)
        return c ? HttpResponse.json(view(c, user)) : missing()
      }),
    ),
    http.get(
      '/api/checkins/:id',
      withUser((user, _r, params) => {
        const c = checkins.get(String(params.id))
        return c ? HttpResponse.json(view(c, user)) : missing()
      }),
    ),
    http.put(
      '/api/checkins/:id',
      withUser(async (user, request, params) => {
        const c = checkins.get(String(params.id))
        if (!c) return missing()
        const { blobOid: _b, ...input } = (await request.json()) as CheckinInput & {
          blobOid: string
        }
        Object.assign(c, input, { blobOid: `${c.blobOid}+` })
        return HttpResponse.json(view(c, user))
      }),
    ),
    http.delete(
      '/api/checkins/:id',
      withUser((_u, _r, params) => {
        checkins.delete(String(params.id))
        return new HttpResponse(null, { status: 204 })
      }),
    ),
    http.post(
      '/api/checkins/:id/answers',
      withUser(async (user, request, params) => {
        const c = checkins.get(String(params.id))
        const round = c?.rounds[0]
        if (!c || !round) return missing()
        const { text } = (await request.json()) as { text: string }
        const now = new Date().toISOString()
        let answer = round.answers.find((a) => a.email === user.email)
        if (answer) Object.assign(answer, { text, edited: now })
        else {
          answer = {
            id: nextId(),
            date: round.date,
            name: user.name,
            email: user.email,
            submitted: now,
            edited: null,
            text,
            replies: [],
            mine: true,
            path: `checkins/${c.id}/${round.date}/x.md`,
          } satisfies CheckinAnswer
          round.answers.push(answer)
        }
        return HttpResponse.json(answer)
      }),
    ),
    http.post(
      '/api/checkins/:id/answers/:answer/replies',
      withUser(async (user, request, params) => {
        const c = checkins.get(String(params.id))
        const answer = c?.rounds.flatMap((r) => r.answers).find((a) => a.id === params.answer)
        if (!answer) return missing()
        const { text } = (await request.json()) as { text: string }
        answer.replies.push({
          id: nextId(),
          by: user.email,
          name: user.name,
          at: new Date().toISOString(),
          text,
        })
        return HttpResponse.json(answer)
      }),
    ),
    http.post(
      '/api/dictation/transcribe',
      withUser(() => HttpResponse.json({ text: DICTATED_WORDS })),
    ),
  ]
}

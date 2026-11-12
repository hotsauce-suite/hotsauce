// MSW routes for `/api/dictation` (ARCHITECTURE §9.2): devices and word lists, in memory.

import { type AnyHandler, HttpResponse, http } from 'msw'
import type { DictationDevice } from '../api/dictation'
import type { FakeUser } from './fakeRepo'

const TEAM_SEED = ['Acme', 'Hearth', 'Ember', 'Granola', 'Clerk', 'Deepgram', 'Anthropic', 'Claude']

export function dictationHandlers(opts: {
  principal: (request: Request) => FakeUser | Response
}): AnyHandler[] {
  const devices = new Map<string, Array<DictationDevice & { revoked?: boolean }>>()
  const words = new Map<string, string[]>([['team', [...TEAM_SEED]]])
  let next = 1

  const authed =
    (
      resolve: (args: {
        request: Request
        user: FakeUser
        params: Record<string, unknown>
      }) => Response | Promise<Response>,
    ) =>
    ({ request, params }: { request: Request; params: Record<string, unknown> }) => {
      const user = opts.principal(request)
      if (user instanceof Response) return user
      return resolve({ request, user, params })
    }

  const live = (email: string) => (devices.get(email) ?? []).filter((d) => !d.revoked)

  return [
    // The server's build includes the Mac app.
    http.head('/downloads/HearthDictate.dmg', () => new HttpResponse(null, { status: 200 })),
    http.get(
      '/api/dictation/devices',
      authed(({ user }) =>
        HttpResponse.json(
          live(user.email).map(({ id, name, createdAt, lastUsedAt }) => ({
            id,
            name,
            createdAt,
            lastUsedAt,
          })),
        ),
      ),
    ),
    http.post(
      '/api/dictation/devices',
      authed(async ({ request, user }) => {
        const { name } = (await request.json()) as { name: string }
        const device = {
          id: `dev${next++}`,
          name,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
        }
        devices.set(user.email, [device, ...(devices.get(user.email) ?? [])])
        return HttpResponse.json({ ...device, token: `hdt_mock${device.id}` }, { status: 201 })
      }),
    ),
    http.delete(
      '/api/dictation/devices/:id',
      authed(({ user, params }) => {
        const device = live(user.email).find((d) => d.id === params.id)
        if (!device)
          return HttpResponse.json(
            { error: { code: 'not_found', message: 'No such device' } },
            { status: 404 },
          )
        device.revoked = true
        return new HttpResponse(null, { status: 204 })
      }),
    ),
    http.get(
      '/api/dictation/words',
      authed(({ user }) =>
        HttpResponse.json({ mine: words.get(user.email) ?? [], team: words.get('team') ?? [] }),
      ),
    ),
    http.put(
      '/api/dictation/words',
      authed(async ({ request, user }) => {
        const body = (await request.json()) as { scope: 'mine' | 'team'; words: string[] }
        const seen = new Set<string>()
        const list = body.words
          .map((w) => w.trim())
          .filter((w) => w !== '' && !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase()))
        words.set(body.scope === 'team' ? 'team' : user.email, list)
        return HttpResponse.json({ scope: body.scope, words: list })
      }),
    ),
  ]
}

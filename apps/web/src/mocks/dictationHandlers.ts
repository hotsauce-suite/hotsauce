// MSW routes for `/api/dictation` (ARCHITECTURE §9.2): devices, word lists and models, in memory.

import { type AnyHandler, HttpResponse, http } from 'msw'
import type { CleanupChoice, DictationDevice, SpeechChoice } from '../api/dictation'
import type { FakeUser } from './fakeRepo'

const TEAM_SEED = [
  'Acme',
  'Hotsauce',
  'Ember',
  'Granola',
  'Clerk',
  'Deepgram',
  'Anthropic',
  'Claude',
]

/** The newest Mac app, as a server publishes it at /downloads/mac-app.json. */
export const MOCK_MAC_APP = { version: '0.26.0', build: '1300', reportsVersion: true }

export function dictationHandlers(opts: {
  principal: (request: Request) => FakeUser | Response
}): AnyHandler[] {
  const devices = new Map<string, Array<DictationDevice & { revoked?: boolean }>>()
  const words = new Map<string, string[]>([['team', [...TEAM_SEED]]])
  // "Also heard as" spellings, by list then word (docs/PLAN-dictate-punctuation-and-fixes.md).
  const heard = new Map<string, Record<string, string[]>>([['team', { Ember: ['Amber'] }]])
  const cleanup = new Map<string, CleanupChoice>()
  const speech = new Map<string, SpeechChoice>()
  let next = 1
  // What a Hotsauce server with Deepgram and Anthropic keys answers (docs/PLAN-dictate-models.md).
  const settingsOf = (email: string) => ({
    speech: speech.get(email) ?? 'online',
    cleanup: cleanup.get(email) ?? 'fast',
    cleanupAvailable: true,
    models: {
      speech: 'Deepgram Nova-3',
      offline: 'Apple, on the Mac',
      fast: 'Claude Haiku 5.5',
      careful: 'Claude Sonnet 5.5',
    },
  })

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
    http.head('/downloads/Hotsauce.dmg', () => new HttpResponse(null, { status: 200 })),
    // What the newest Mac app is (docs/PLAN-mac-version-and-whats-new.md, M2).
    http.get('/downloads/mac-app.json', () => HttpResponse.json(MOCK_MAC_APP)),
    http.get(
      '/api/dictation/devices',
      authed(({ user }) =>
        HttpResponse.json(
          live(user.email).map(({ id, name, createdAt, lastUsedAt, appVersion }) => ({
            id,
            name,
            createdAt,
            lastUsedAt,
            appVersion: appVersion ?? null,
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
      '/api/dictation/settings',
      authed(({ user }) => HttpResponse.json(settingsOf(user.email))),
    ),
    http.put(
      '/api/dictation/settings',
      authed(async ({ request, user }) => {
        const body = (await request.json()) as { cleanup?: CleanupChoice; speech?: SpeechChoice }
        const okCleanup =
          body.cleanup === undefined || ['fast', 'careful', 'off'].includes(body.cleanup)
        const okSpeech = body.speech === undefined || ['online', 'device'].includes(body.speech)
        if (!okCleanup || !okSpeech || (!body.cleanup && !body.speech))
          return HttpResponse.json(
            { error: { code: 'bad_request', message: 'Pick a speech or cleanup choice' } },
            { status: 400 },
          )
        if (body.cleanup) cleanup.set(user.email, body.cleanup)
        if (body.speech) speech.set(user.email, body.speech)
        return HttpResponse.json(settingsOf(user.email))
      }),
    ),
    http.get(
      '/api/dictation/words',
      authed(({ user }) =>
        HttpResponse.json({
          mine: words.get(user.email) ?? [],
          team: words.get('team') ?? [],
          heardAs: { mine: heard.get(user.email) ?? {}, team: heard.get('team') ?? {} },
        }),
      ),
    ),
    http.put(
      '/api/dictation/words/heard-as',
      authed(async ({ request, user }) => {
        const body = (await request.json()) as {
          scope: 'mine' | 'team'
          word: string
          heard: string[]
        }
        const key = body.scope === 'team' ? 'team' : user.email
        const seen = new Set<string>([body.word.toLowerCase()])
        const list = body.heard
          .map((w) => w.trim())
          .filter((w) => w !== '' && !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase()))
        const lists = { ...(heard.get(key) ?? {}) }
        if (list.length) lists[body.word] = list
        else delete lists[body.word]
        heard.set(key, lists)
        return HttpResponse.json({ scope: body.scope, word: body.word, heard: list })
      }),
    ),
    http.put(
      '/api/dictation/words',
      authed(async ({ request, user }) => {
        const body = (await request.json()) as { scope: 'mine' | 'team'; words: string[] }
        const seen = new Set<string>()
        const list = body.words
          .map((w) => w.trim())
          .filter((w) => w !== '' && !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase()))
        const key = body.scope === 'team' ? 'team' : user.email
        words.set(key, list)
        // A removed word's spellings go with it, as on the server.
        heard.set(
          key,
          Object.fromEntries(
            Object.entries(heard.get(key) ?? {}).filter(([w]) => list.includes(w)),
          ),
        )
        return HttpResponse.json({ scope: body.scope, words: list })
      }),
    ),
  ]
}

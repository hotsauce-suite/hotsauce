// MSW routes for `/api/themes` (docs/PLAN-ai-themes.md): the live demo answers a description with
// one of the sample themes its words pick (R11), and keeps saved themes in memory per visitor.

import { MAX_THEMES, type SavedTheme, sampleThemeFor, type Theme } from '@hotsauce/format'
import { type AnyHandler, delay, HttpResponse, http } from 'msw'
import type { FakeUser } from './fakeRepo'

export function themeHandlers(opts: {
  principal: (request: Request) => FakeUser | Response
  latencyMs: number
}): AnyHandler[] {
  const themes = new Map<string, SavedTheme[]>()
  let seq = 0
  const nextId = () => `01JTHEME${String(++seq).padStart(18, '0')}`
  const mine = (email: string) => {
    let list = themes.get(email)
    if (!list) {
      list = []
      themes.set(email, list)
    }
    return list
  }
  return [
    http.get('/api/themes', ({ request }) => {
      const user = opts.principal(request)
      if (user instanceof Response) return user
      return HttpResponse.json({ themes: mine(user.email), canGenerate: true })
    }),

    http.post('/api/themes/generate', async ({ request }) => {
      const user = opts.principal(request)
      if (user instanceof Response) return user
      const { prompt, base } = (await request.json()) as { prompt: string; base?: Theme }
      // Long enough to see "Designing…", as a real model takes a few seconds.
      await delay(Math.max(opts.latencyMs, 600))
      return HttpResponse.json({ theme: sampleThemeFor(prompt, base) })
    }),

    http.post('/api/themes', async ({ request }) => {
      const user = opts.principal(request)
      if (user instanceof Response) return user
      const body = (await request.json()) as { name: string; prompt: string; theme: Theme }
      const list = mine(user.email)
      if (list.length >= MAX_THEMES) {
        return HttpResponse.json(
          {
            error: {
              code: 'conflict',
              message: `You have ${MAX_THEMES} themes, the most there can be. Delete one to keep this.`,
            },
          },
          { status: 409 },
        )
      }
      const saved: SavedTheme = {
        id: nextId(),
        name: body.name,
        prompt: body.prompt,
        theme: { ...body.theme, name: body.name },
        createdAt: new Date().toISOString(),
      }
      list.unshift(saved)
      return HttpResponse.json({ theme: saved })
    }),

    http.patch('/api/themes/:id', async ({ request, params }) => {
      const user = opts.principal(request)
      if (user instanceof Response) return user
      const { name } = (await request.json()) as { name: string }
      const t = mine(user.email).find((x) => x.id === params.id)
      if (!t) return HttpResponse.json({ error: { code: 'not_found' } }, { status: 404 })
      t.name = name
      return HttpResponse.json({ ok: true })
    }),

    http.delete('/api/themes/:id', ({ request, params }) => {
      const user = opts.principal(request)
      if (user instanceof Response) return user
      const list = mine(user.email)
      const i = list.findIndex((x) => x.id === params.id)
      if (i < 0) return HttpResponse.json({ error: { code: 'not_found' } }, { status: 404 })
      list.splice(i, 1)
      return HttpResponse.json({ ok: true })
    }),
  ]
}

// `/api/breaks` for the demo and tests (docs/PLAN-breaks.md B13): each member's screen-break
// settings, for as long as the page is open, validated as the server does.

import {
  type BreakSettings,
  BreakSettingsError,
  defaultBreakSettings,
  parseBreakSettings,
} from '@hotsauce/format'
import { type AnyHandler, HttpResponse, http } from 'msw'

export function breakHandlers(): AnyHandler[] {
  const saved = new Map<string, BreakSettings>()
  const who = (request: Request) => request.headers.get('x-hearth-dev-user') ?? 'me'
  return [
    http.get('/api/breaks', ({ request }) => {
      const s = saved.get(who(request))
      return HttpResponse.json({ settings: s ?? defaultBreakSettings(), saved: s !== undefined })
    }),
    http.put('/api/breaks', async ({ request }) => {
      const body = (await request.json()) as { settings?: unknown }
      try {
        const settings = parseBreakSettings(body.settings)
        saved.set(who(request), settings)
        return HttpResponse.json({ settings, saved: true })
      } catch (err) {
        if (!(err instanceof BreakSettingsError)) throw err
        return HttpResponse.json(
          { error: { code: 'bad_request', message: err.message } },
          { status: 400 },
        )
      }
    }),
  ]
}

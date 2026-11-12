// MSW routes for booking links (ARCHITECTURE §19): links in memory, slots from the real
// `openSlots` against an empty calendar, and bookings that take their slot.

import { BookingFrontmatter, openSlots, rulesOf } from '@hearth/format'
import { type AnyHandler, HttpResponse, http } from 'msw'
import type { BookingInput, BookingLink } from '../api/booking'

const HANDLE = 'ada'

export function bookingHandlers(opts: { ready?: boolean } = {}): AnyHandler[] {
  const links = new Map<string, BookingLink>()
  const taken: Array<{ start: string; end: string }> = []
  let version = 0
  const err = (status: number, code: string, message: string) =>
    HttpResponse.json({ error: { code, message } }, { status })
  const fm = (l: BookingLink) =>
    BookingFrontmatter.parse({
      title: l.title,
      minutes: l.minutes,
      tz: l.tz,
      hours: l.hours,
      buffer_before: l.bufferBefore,
      buffer_after: l.bufferAfter,
      notice_minutes: l.noticeMinutes,
      horizon_days: l.horizonDays,
      daily_cap: l.dailyCap,
      questions: l.questions,
      active: l.active,
    })
  return [
    http.get('/api/booking', () =>
      HttpResponse.json({
        ready: opts.ready ?? true,
        missing: (opts.ready ?? true) ? null : 'scope',
        canTakeBookings: true,
        handle: HANDLE,
        links: [...links.values()],
      }),
    ),
    http.put('/api/booking/:slug', async ({ params, request }) => {
      const slug = String(params.slug)
      const input = (await request.json()) as BookingInput
      const existing = links.get(slug)
      if ((existing?.blobOid ?? null) !== input.blobOid) {
        return err(409, 'conflict', `You already have a link named ${slug}`)
      }
      const link: BookingLink = { ...input, slug, blobOid: `v${++version}` }
      links.set(slug, link)
      return HttpResponse.json(link)
    }),
    http.delete('/api/booking/:slug', ({ params }) => {
      links.delete(String(params.slug))
      return new HttpResponse(null, { status: 204 })
    }),
    http.get('/api/book/:handle/:slug', ({ params, request }) => {
      const link = links.get(String(params.slug))
      if (params.handle !== HANDLE || !link?.active) {
        return err(404, 'not_found', 'This booking link does not exist')
      }
      const url = new URL(request.url)
      const slots = openSlots(rulesOf(fm(link)), taken, {
        now: new Date(),
        from: url.searchParams.get('from') ?? new Date().toISOString(),
        to: url.searchParams.get('to') ?? new Date(Date.now() + 7 * 86_400_000).toISOString(),
      })
      return HttpResponse.json({
        title: link.title,
        minutes: link.minutes,
        description: link.description,
        ownerName: 'Ada Lovelace',
        questions: link.questions,
        slots,
        robotCheck: { kind: 'dev' },
        canTakeBookings: true,
      })
    }),
    http.post('/api/book/:handle/:slug', async ({ params, request }) => {
      const link = links.get(String(params.slug))
      if (!link) return err(404, 'not_found', 'This booking link does not exist')
      const body = (await request.json()) as { start: string; token: string }
      if (body.token !== 'dev-pass')
        return err(403, 'forbidden', "Couldn't confirm you're a person")
      if (taken.some((t) => t.start === body.start)) {
        return err(409, 'conflict', 'That time was just taken. Pick another one.')
      }
      const end = new Date(Date.parse(body.start) + link.minutes * 60_000).toISOString()
      taken.push({ start: body.start, end })
      return HttpResponse.json({
        start: body.start,
        end,
        meetLink: 'https://meet.google.com/abc-defg-hij',
      })
    }),
  ]
}

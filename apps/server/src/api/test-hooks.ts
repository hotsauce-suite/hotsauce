import { Hono } from 'hono'
import { z } from 'zod'
import { HearthError } from '../errors.js'
import type { AppDeps, AppEnv } from './env.js'
import { valid } from './validate.js'

/**
 * Hooks for the e2e suite (ARCHITECTURE §7.8), mounted only when NODE_ENV=test: change the
 * in-memory Google behind the calendar sync, sync now, and read or trigger reminder pushes.
 */
export function testRoutes(deps: AppDeps) {
  const { fakeGoogle, calendarSync, recordedPushes, reminders } = deps.meetings
  const google = () => {
    if (!fakeGoogle) throw new HearthError('not_found', 'No fake Google on this server')
    return fakeGoogle
  }
  return new Hono<AppEnv>()
    .basePath('/test')
    .post(
      '/calendar/move',
      valid('json', z.object({ id: z.string().min(1), minutes: z.number().int() })),
      (c) => {
        const { id, minutes } = c.req.valid('json')
        google().move(c.get('principal').email, id, minutes)
        return c.json({ ok: true })
      },
    )
    .post(
      '/calendar/add',
      valid(
        'json',
        z.object({
          id: z.string().min(1),
          title: z.string().min(1),
          startsInSeconds: z.number().int(),
          minutes: z.number().int().positive().default(30),
          meetLink: z.string().url().optional(),
        }),
      ),
      (c) => {
        const { email } = c.get('principal')
        const body = c.req.valid('json')
        const start = Date.now() + body.startsInSeconds * 1000
        google().put(email, {
          id: body.id,
          status: 'confirmed',
          summary: body.title,
          start: { dateTime: new Date(start).toISOString() },
          end: { dateTime: new Date(start + body.minutes * 60_000).toISOString() },
          attendees: [
            { email, self: true, responseStatus: 'accepted' },
            { email: 'jo@bolt.example', displayName: 'Jo Park' },
          ],
          ...(body.meetLink ? { hangoutLink: body.meetLink } : {}),
        })
        return c.json({ ok: true })
      },
    )
    .post('/calendar/cancel', valid('json', z.object({ id: z.string().min(1) })), (c) => {
      google().cancel(c.get('principal').email, c.req.valid('json').id)
      return c.json({ ok: true })
    })
    .post('/calendar/sync', async (c) => {
      await calendarSync?.sync(c.get('principal'))
      return c.json({ ok: true })
    })
    .get('/pushes', (c) => {
      if (!recordedPushes) throw new HearthError('not_found', 'Pushes are not recorded')
      return c.json(recordedPushes.sent)
    })
    .post('/reminders/tick', async (c) => {
      if (!reminders) throw new HearthError('not_found', 'Reminders are off')
      await reminders.tick()
      await deps.tasks.reminders?.tick()
      return c.json({ ok: true })
    })
    .post(
      '/feedback/:number/ask',
      valid('param', z.object({ number: z.coerce.number().int().positive() })),
      valid('json', z.object({ question: z.string().min(1) })),
      (c) => {
        // Send feedback: the team asks the member a question, as the daily review would.
        const tracker = deps.feedback.memoryTracker
        if (!tracker) throw new HearthError('not_found', 'No in-memory feedback on this server')
        tracker.ask(c.req.valid('param').number, c.req.valid('json').question)
        deps.feedback.forgetCache()
        return c.json({ ok: true })
      },
    )
}

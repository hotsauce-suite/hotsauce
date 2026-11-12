import { Hono } from 'hono'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { HearthError } from '../errors.js'
import {
  completeActionItem,
  deleteMeeting,
  enhanceNote,
  GranolaMeeting,
  importGranola,
  KeptAudioSchema,
  keptAudioKey,
  keptAudioPath,
  listActionItems,
  listMeetings,
  MAX_IMPORT_MEETINGS,
  nameSpeakers,
  previousInSeries,
} from '../meetings/index.js'
import { PushSubscriptionSchema } from '../meetings/reminders/index.js'
import type { AppDeps, AppEnv } from './env.js'
import { afterCommit, writablePath } from './save.js'
import { sessionOnly, viaFor } from './tokens.js'
import { PathParam, valid } from './validate.js'

const SessionId = z.object({ id: z.string().min(1) })

/** ARCHITECTURE §7.2. Session routes are the owner's alone (403 for anyone else). */
export function meetingRoutes(deps: AppDeps) {
  const { git, spaces, meetings } = deps
  const { sessions } = meetings

  const assertAccess = (principal: AppEnv['Variables']['principal'], space: string) => {
    if (!spaces.canAccess(principal, space)) {
      throw new HearthError('forbidden', `You don't have access to the space "${space}"`)
    }
  }

  return (
    new Hono<AppEnv>()
      .basePath('/meetings')
      .get('/settings', (c) =>
        c.json({
          keepAudio: { available: sessions.canKeepAudio, byDefault: sessions.keepsAudioByDefault },
        }),
      )
      /** A meeting's kept audio, one track as WAV, for anyone who can see the space it's in. */
      .get(
        '/audio',
        valid(
          'query',
          z.object({
            space: z.string().min(1),
            id: z.string().regex(/^[0-9A-Z]{26}$/),
            track: z.enum(['me', 'them']),
          }),
        ),
        async (c) => {
          const { space, id, track } = c.req.valid('query')
          assertAccess(c.get('principal'), space)
          const store = meetings.audioStore
          if (!store) throw new HearthError('not_found', 'Kept audio isn’t set up on this server')
          const { content } = await git.readFile(space, keptAudioPath(id))
          const pointer = KeptAudioSchema.safeParse(parseYaml(content))
          const kept = pointer.success ? pointer.data : null
          const key = keptAudioKey(space, id, track)
          // A pointer for another meeting, or naming another key, was not written by Hearth.
          if (kept?.id !== id || kept.tracks[track]?.key !== key) {
            throw new HearthError('not_found', `No ${track} audio kept for ${id}`)
          }
          if (kept.store !== store.kind) {
            throw new HearthError('not_found', `This audio is in ${kept.store} storage`)
          }
          const object = await store.get(key)
          if (!object) throw new HearthError('not_found', `${key} is missing from the audio store`)
          return c.body(object.body, 200, {
            'Content-Type': 'audio/wav',
            'Content-Length': String(object.size),
            'Content-Disposition': `attachment; filename="${id}-${track}.wav"`,
            'Cache-Control': 'private, max-age=3600',
          })
        },
      )
      /** Meeting reminders by web push (PRD §6.1): the key to subscribe with, and (un)subscribing. */
      .get('/reminders', (c) => c.json({ publicKey: meetings.vapidPublicKey }))
      .post(
        '/reminders',
        valid('json', z.object({ subscription: PushSubscriptionSchema })),
        async (c) => {
          sessionOnly(c.get('principal'))
          if (!meetings.reminders) {
            throw new HearthError('bad_request', 'Meeting reminders aren’t set up on this server')
          }
          await meetings.reminderStore.subscribe(
            c.get('principal'),
            c.req.valid('json').subscription,
          )
          return c.body(null, 204)
        },
      )
      .delete('/reminders', valid('json', z.object({ endpoint: z.string().url() })), async (c) => {
        sessionOnly(c.get('principal'))
        await meetings.reminderStore.unsubscribe(
          c.req.valid('json').endpoint,
          c.get('principal').email,
        )
        return c.body(null, 204)
      })
      .get('/templates', async (c) => {
        const templates = await meetings.templates.listTemplates(c.get('principal'))
        return c.json(
          templates.map(({ id, name, description, source }) => ({ id, name, description, source })),
        )
      })
      .get(
        '/',
        valid(
          'query',
          z.object({
            space: z.string().optional(),
            from: z.string().optional(),
            to: z.string().optional(),
            person: z.string().optional(),
            company: z.string().optional(),
            folder: z.string().optional(),
          }),
        ),
        async (c) => {
          const principal = c.get('principal')
          const { space, ...filters } = c.req.valid('query')
          if (space) assertAccess(principal, space)
          const names = space ? [space] : (await spaces.visibleSpaces(principal)).map((s) => s.name)
          return c.json(listMeetings(deps.index, names, filters))
        },
      )
      .post(
        '/sessions',
        valid(
          'json',
          z.object({
            title: z.string().max(200).optional(),
            template: z.string().min(1).optional(),
            calendarEventId: z.string().min(1).optional(),
            /** The Google Meet call it records, so a resumed capture can find its tab. */
            meetCode: z
              .string()
              .regex(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/)
              .optional(),
            /** The owner's IANA time zone; the note is dated in it. */
            tz: z.string().min(1).optional(),
          }),
        ),
        async (c) => {
          const body = c.req.valid('json')
          const session = await sessions.create(c.get('principal'), withoutUndefined(body))
          // Taking notes enrols the member for the nightly agent brief (ARCHITECTURE §13.2).
          await deps.briefs
            .touch(c.get('principal'), body.tz)
            .catch((err: unknown) => console.error(`brief: couldn't enrol a member: ${err}`))
          return c.json(session)
        },
      )
      .get('/sessions', (c) => c.json(sessions.list(c.get('principal'))))
      .get('/sessions/:id', valid('param', SessionId), (c) =>
        c.json(sessions.get(c.req.valid('param').id, c.get('principal'))),
      )
      .put(
        '/sessions/:id/notes',
        valid('param', SessionId),
        valid('json', z.object({ text: z.string() })),
        async (c) => {
          const { id } = c.req.valid('param')
          sessions.get(id, c.get('principal'))
          await sessions.setRawNotes(id, c.req.valid('json').text)
          return c.body(null, 204)
        },
      )
      .put(
        '/sessions/:id/keep-audio',
        valid('param', SessionId),
        valid('json', z.object({ keep: z.boolean() })),
        async (c) => {
          const { id } = c.req.valid('param')
          sessions.get(id, c.get('principal'))
          return c.json(await sessions.setKeepAudio(id, c.req.valid('json').keep))
        },
      )
      .post('/sessions/:id/pause', valid('param', SessionId), async (c) => {
        const { id } = c.req.valid('param')
        sessions.get(id, c.get('principal'))
        return c.json(await sessions.pause(id))
      })
      .post('/sessions/:id/resume', valid('param', SessionId), async (c) => {
        const { id } = c.req.valid('param')
        sessions.get(id, c.get('principal'))
        return c.json(await sessions.resume(id))
      })
      .post(
        '/sessions/:id/stop',
        valid('param', SessionId),
        valid(
          'json',
          z.object({
            keepAudio: z.boolean().optional(),
            /** The raw notes as last typed; they replace what the session holds. */
            notes: z.string().optional(),
          }),
        ),
        async (c) => {
          const { id } = c.req.valid('param')
          sessions.get(id, c.get('principal'))
          const saved = await sessions.stop(id, withoutUndefined(c.req.valid('json')))
          return c.json(saved)
        },
      )
      .get('/action-items', async (c) => {
        const principal = c.get('principal')
        const visible = await spaces.visibleSpaces(principal)
        return c.json(await listActionItems({ index: deps.index, git }, principal, visible))
      })
      .post(
        '/action-items/done',
        valid(
          'json',
          z.object({
            space: z.string().min(1),
            path: PathParam,
            line: z.number().int().min(1),
            text: z.string().trim().min(1).max(2000),
          }),
        ),
        async (c) => {
          const principal = c.get('principal')
          const body = c.req.valid('json')
          assertAccess(principal, body.space)
          const path = writablePath(body.path)
          await completeActionItem(
            { git, afterCommit: (space, p, commit) => afterCommit(deps, space, p, commit) },
            principal,
            { ...body, path },
          )
          return c.json({ ok: true })
        },
      )
      .post(
        '/enhance',
        valid(
          'json',
          z.object({
            space: z.string().min(1),
            path: PathParam,
            template: z.string().min(1).optional(),
            /** Replace edits made since the last enhance. */
            force: z.boolean().optional(),
          }),
        ),
        async (c) => {
          const principal = c.get('principal')
          const body = c.req.valid('json')
          assertAccess(principal, body.space)
          const path = writablePath(body.path)
          const result = await enhanceNote(
            {
              git,
              templates: meetings.templates,
              enhancer: meetings.enhancer,
              calendar: meetings.calendar,
              previousInSeries: (principal, note) =>
                previousInSeries({ index: deps.index, git, spaces }, principal, note),
              afterCommit: (space, path, commit) => afterCommit(deps, space, path, commit),
              transcriptSettled: (id) => meetings.sessions.cleanupSettled(id),
            },
            principal,
            { ...body, path },
          )
          return c.json(result)
        },
      )
      /** Past meetings from Granola's CSV export, into the member's personal space (§7.12). */
      .post(
        '/import/granola',
        valid(
          'json',
          z.object({
            meetings: z.array(GranolaMeeting).min(1).max(MAX_IMPORT_MEETINGS),
            tz: z.string().min(1).max(100),
          }),
        ),
        async (c) => {
          const principal = sessionOnly(c.get('principal'))
          const result = await importGranola(
            {
              git,
              index: deps.index,
              spaces,
              afterCommit: (space) => deps.syncer.afterHeadChanged(space),
            },
            principal,
            c.req.valid('json').meetings,
            c.req.valid('json').tz,
          )
          return c.json(result)
        },
      )
      /** Names speakers ("Speaker 1" → "Priya Shah") in a meeting's transcript and note. */
      .post(
        '/speakers',
        valid(
          'json',
          z.object({
            space: z.string().min(1),
            path: PathParam,
            names: z
              .record(z.string().min(1).max(80), z.string().max(200))
              .refine((n) => Object.keys(n).length > 0 && Object.keys(n).length <= 20, {
                message: 'Name between 1 and 20 speakers',
              }),
            transcriptBlobOid: z
              .string()
              .regex(/^[0-9a-f]{40}$/)
              .optional(),
          }),
        ),
        async (c) => {
          const principal = c.get('principal')
          const body = c.req.valid('json')
          assertAccess(principal, body.space)
          const path = writablePath(body.path)
          const result = await nameSpeakers(
            {
              git,
              afterCommit: (space, p, commit) => afterCommit(deps, space, p, commit),
              transcriptBusy: (id) => meetings.sessions.cleanupRunning(id),
            },
            principal,
            { ...body, path },
          )
          return c.json(result)
        },
      )
      /** A meeting note and its transcript, raw notes and kept audio, for anyone who can edit it. */
      .post(
        '/delete',
        valid(
          'json',
          z.object({
            space: z.string().min(1),
            path: PathParam,
            /** The note as the member saw it; a note changed since is refused (409). */
            blobOid: z
              .string()
              .regex(/^[0-9a-f]{40}$/)
              .optional(),
          }),
        ),
        async (c) => {
          const principal = c.get('principal')
          const body = c.req.valid('json')
          assertAccess(principal, body.space)
          const result = await deleteMeeting(
            {
              git,
              audioStore: meetings.audioStore,
              sessions,
              writablePath,
              afterCommit: (space, p, commit) => afterCommit(deps, space, p, commit),
            },
            principal,
            { ...body, via: viaFor(principal) },
          )
          return c.json(result)
        },
      )
      .post(
        '/chat',
        valid(
          'json',
          z.object({
            question: z.string().trim().min(1).max(4000),
            scope: z
              .object({
                space: z.string().min(1).optional(),
                meetingPath: PathParam.optional(),
                folder: z.string().optional(),
                person: z.string().optional(),
                company: z.string().optional(),
              })
              .default({}),
          }),
        ),
        async (c) => {
          const { question, scope } = c.req.valid('json')
          const { answer, citations } = await meetings.chat.ask(c.get('principal'), {
            question,
            scope: withoutUndefined(scope),
          })
          return c.json({ answer, citations })
        },
      )
  )
}

/** Drops absent keys, for options typed with exactOptionalPropertyTypes. */
function withoutUndefined<T extends Record<string, unknown>>(
  obj: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>
  }
}

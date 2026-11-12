import { TaskSource } from '@hearth/format'
import { Hono } from 'hono'
import { z } from 'zod'
import { DICTATION_MIME_TYPES } from '../dictation/index.js'
import { HearthError } from '../errors.js'
import { MAX_TASK_LIST } from '../tasks/index.js'
import type { AppDeps, AppEnv } from './env.js'
import { sessionOnly, viaFor } from './tokens.js'
import { PathParam, valid } from './validate.js'

const Title = z.string().trim().min(1).max(500)
const Zone = z.string().min(1).max(100)
const Label = z.string().trim().min(1).max(100)

/** The fields of a task a client can set; `null` clears one. */
const TaskFields = {
  title: Title,
  notes: z.string().max(100_000).optional(),
  priority: z.number().int().min(1).max(4).optional(),
  due: z.string().max(20).nullable().optional(),
  recur: z.string().max(200).nullable().optional(),
  project: z.string().max(200).nullable().optional(),
  labels: z.array(Label).max(50).optional(),
  assignee: z.string().max(320).nullable().optional(),
  order: z.number().finite().nullable().optional(),
  source: TaskSource.optional(),
}

const Params = z.object({ space: z.string().min(1), id: z.string().min(1) })

const Bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')

const ListQuery = z.object({
  status: z.enum(['open', 'done', 'all']).optional(),
  mine: Bool.optional(),
  project: z.string().optional(),
  space: z.string().min(1).optional(),
  due_before: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  due_after: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  done_since: z.string().min(1).optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_TASK_LIST).optional(),
})

/** Hearth Tasks (ARCHITECTURE §12.3). Space access is checked by the service (403). */
export function taskRoutes(deps: Pick<AppDeps, 'tasks'>) {
  const { service, ramble, todoist } = deps.tasks
  return new Hono<AppEnv>()
    .basePath('/tasks')
    .get('/', valid('query', ListQuery), async (c) => {
      const q = c.req.valid('query')
      const tasks = await service.list(c.get('principal'), {
        status: q.status,
        mine: q.mine,
        project: q.project,
        space: q.space,
        dueBefore: q.due_before,
        dueAfter: q.due_after,
        doneSince: q.done_since,
        q: q.q,
        limit: q.limit,
      })
      return c.json({ tasks })
    })
    .get('/projects', async (c) => c.json(await service.projects(c.get('principal'))))
    .get('/people', (c) => c.json(service.people(c.get('principal'))))
    .get(
      '/from-meetings',
      valid('query', z.object({ space: z.string().min(1).optional(), path: PathParam.optional() })),
      async (c) => {
        const { space, path } = c.req.valid('query')
        const only = space && path ? { space, path } : undefined
        return c.json(await service.fromMeetings(c.get('principal'), only))
      },
    )
    .post(
      '/',
      valid(
        'json',
        z.object({ ...TaskFields, tz: Zone.optional(), space: z.string().min(1).optional() }),
      ),
      async (c) => {
        const principal = c.get('principal')
        const task = await service.create(principal, c.req.valid('json'), viaFor(principal))
        return c.json(task, 201)
      },
    )
    .post(
      '/quick',
      valid(
        'json',
        z.object({
          text: z.string().trim().min(1).max(2000),
          tz: Zone,
          space: z.string().min(1).optional(),
          project: z.string().max(200).optional(),
          source: TaskSource.optional(),
        }),
      ),
      async (c) => {
        const principal = c.get('principal')
        const task = await service.quickAdd(principal, c.req.valid('json'), viaFor(principal))
        return c.json(task, 201)
      },
    )
    .post('/ramble', valid('query', z.object({ tz: Zone.default('UTC') })), async (c) => {
      const mimeType =
        (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
      if (!(DICTATION_MIME_TYPES as readonly string[]).includes(mimeType)) {
        throw new HearthError(
          'bad_request',
          'Send the audio as audio/webm, audio/mp4 or audio/wav',
          {
            status: 415,
          },
        )
      }
      const audio = new Uint8Array(await c.req.arrayBuffer())
      const result = await ramble.ramble(c.get('principal'), {
        audio,
        mimeType: mimeType.includes('wav') ? 'audio/wav' : mimeType,
        tz: c.req.valid('query').tz,
      })
      c.header('Cache-Control', 'no-store')
      return c.json(result)
    })
    .post(
      '/import/todoist',
      valid(
        'json',
        z.union([
          z.object({ token: z.string().trim().min(1).max(200), tz: Zone.optional() }),
          z.object({
            csv: z.string().min(1),
            projectName: z.string().trim().min(1).max(200),
            tz: Zone.optional(),
          }),
        ]),
      ),
      async (c) => {
        const principal = sessionOnly(c.get('principal'))
        return c.json(await todoist.import(principal, c.req.valid('json')))
      },
    )
    .get('/:space/:id', valid('param', Params), async (c) => {
      const { space, id } = c.req.valid('param')
      return c.json(await service.get(c.get('principal'), space, id))
    })
    .patch(
      '/:space/:id',
      valid('param', Params),
      valid(
        'json',
        z.object({
          ...TaskFields,
          title: Title.optional(),
          tz: Zone.optional(),
          baseBlobOid: z.string().min(1).optional(),
        }),
      ),
      async (c) => {
        const principal = c.get('principal')
        const { space, id } = c.req.valid('param')
        const { tz, baseBlobOid, ...patch } = c.req.valid('json')
        const task = await service.update(principal, space, id, patch, viaFor(principal), {
          tz,
          baseBlobOid,
        })
        return c.json(task)
      },
    )
    .post(
      '/:space/:id/complete',
      valid('param', Params),
      valid('json', z.object({ tz: Zone })),
      async (c) => {
        const principal = c.get('principal')
        const { space, id } = c.req.valid('param')
        const { tz } = c.req.valid('json')
        return c.json(await service.complete(principal, space, id, { tz }, viaFor(principal)))
      },
    )
    .post('/:space/:id/reopen', valid('param', Params), async (c) => {
      const principal = c.get('principal')
      const { space, id } = c.req.valid('param')
      return c.json(await service.reopen(principal, space, id, viaFor(principal)))
    })
    .post(
      '/:space/:id/move',
      valid('param', Params),
      valid('json', z.object({ toSpace: z.string().min(1) })),
      async (c) => {
        const principal = c.get('principal')
        const { space, id } = c.req.valid('param')
        const { toSpace } = c.req.valid('json')
        return c.json(await service.move(principal, space, id, toSpace, viaFor(principal)))
      },
    )
    .delete('/:space/:id', valid('param', Params), async (c) => {
      const principal = c.get('principal')
      const { space, id } = c.req.valid('param')
      await service.remove(principal, space, id, viaFor(principal))
      return c.body(null, 204)
    })
}

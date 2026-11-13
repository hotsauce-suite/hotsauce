import { FORM_ACCESS, MAX_ANSWER_FILE_BYTES, MAX_ANSWER_FILES } from '@hearth/format'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { createMiddleware } from 'hono/factory'
import { z } from 'zod'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import type { UploadedFile } from '../forms/index.js'
import { clientIp } from './booking.js'
import type { AppDeps, AppEnv } from './env.js'
import { viaFor } from './tokens.js'
import { valid } from './validate.js'

/** The fill page's API: `authenticate` lets it through with or without a session. */
export const FORM_FILL_PREFIX = '/api/form/'

const Space = z.string().min(1).max(100)
const Params = z.object({ space: Space, id: z.string().min(1).max(40) })

const FormInput = z.object({
  title: z.string().max(200),
  description: z.string().max(5000),
  // Checked in full by the format's schema in the service.
  questions: z.array(z.unknown()).max(100),
  access: z.enum(FORM_ACCESS),
  open: z.boolean(),
  room: z.string().max(40).nullable(),
  blobOid: z.string().min(1).max(64),
})

const adminOnly = (p: Principal) => {
  if (!p.isAdmin || p.via) throw new HearthError('forbidden', 'Only an admin can change chat rooms')
}

/** Building forms and reading their answers (ARCHITECTURE §21.4); spaces are checked in the service. */
export function formRoutes(deps: Pick<AppDeps, 'forms' | 'chatRooms'>) {
  const { forms, chatRooms } = deps
  return (
    new Hono<AppEnv>()
      .get('/forms', (c) =>
        c.json({ forms: forms.list(c.get('principal')), canSummarize: forms.canSummarize }),
      )
      .post(
        '/forms',
        valid('json', z.object({ space: Space, title: z.string().max(200) })),
        async (c) => {
          const { space, title } = c.req.valid('json')
          const p = c.get('principal')
          return c.json(await forms.create(p, space, title, viaFor(p)))
        },
      )
      .get('/forms/:space/:id', valid('param', Params), async (c) => {
        const { space, id } = c.req.valid('param')
        return c.json(await forms.get(c.get('principal'), space, id))
      })
      .put('/forms/:space/:id', valid('param', Params), valid('json', FormInput), async (c) => {
        const { space, id } = c.req.valid('param')
        const p = c.get('principal')
        return c.json(await forms.save(p, space, id, c.req.valid('json'), viaFor(p)))
      })
      .delete('/forms/:space/:id', valid('param', Params), async (c) => {
        const { space, id } = c.req.valid('param')
        const p = c.get('principal')
        await forms.remove(p, space, id, viaFor(p))
        return c.body(null, 204)
      })
      .get('/forms/:space/:id/answers', valid('param', Params), (c) => {
        const { space, id } = c.req.valid('param')
        return c.json({ answers: forms.answers(c.get('principal'), space, id) })
      })
      .get('/forms/:space/:id/csv', valid('param', Params), async (c) => {
        const { space, id } = c.req.valid('param')
        const { title, csv } = await forms.csv(c.get('principal'), space, id)
        const name = `${title.replace(/[^\w .-]+/g, '').trim() || 'answers'}.csv`
        return c.body(`﻿${csv}`, 200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${name}"`,
          'Cache-Control': 'private, no-store',
        })
      })
      .delete(
        '/forms/:space/:id/answers/:answer',
        valid('param', Params.extend({ answer: z.string().min(1).max(40) })),
        async (c) => {
          const { space, id, answer } = c.req.valid('param')
          const p = c.get('principal')
          await forms.removeAnswer(p, space, id, answer, viaFor(p))
          return c.body(null, 204)
        },
      )
      .post('/forms/:space/:id/summary', valid('param', Params), async (c) => {
        const { space, id } = c.req.valid('param')
        return c.json(await forms.summarize(c.get('principal'), space, id))
      })
      // Chat rooms new answers can go to (§21.5): any member picks one; only an admin adds them.
      .get('/chat-rooms', (c) => {
        const p = c.get('principal')
        const canManage = p.isAdmin && !p.via
        const rooms = chatRooms.list().map((r) => (canManage ? r : { id: r.id, name: r.name }))
        return c.json({ rooms, canManage })
      })
      .post(
        '/chat-rooms',
        valid('json', z.object({ name: z.string().max(80), url: z.string().max(2000) })),
        async (c) => {
          adminOnly(c.get('principal'))
          const { name, url } = c.req.valid('json')
          return c.json(await chatRooms.add(name, url))
        },
      )
      .delete(
        '/chat-rooms/:id',
        valid('param', z.object({ id: z.string().min(1).max(40) })),
        (c) => {
          adminOnly(c.get('principal'))
          chatRooms.remove(c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
  )
}

// Three files of 10 MB, the answers and multipart overhead.
const limitAnswerBody = bodyLimit({
  maxSize: MAX_ANSWER_FILES * MAX_ANSWER_FILE_BYTES + 512 * 1024,
  onError: () => {
    throw new HearthError(
      'bad_request',
      'That’s too much to send at once (files are 10 MB at most)',
      {
        status: 413,
      },
    )
  },
})

// A form without file questions: its answers are text, at most a few hundred KB.
const limitTextAnswerBody = bodyLimit({
  maxSize: 512 * 1024,
  onError: () => {
    throw new HearthError('bad_request', 'That’s too much to send at once', { status: 413 })
  },
})

const Payload = z.object({
  answers: z.record(z.string().max(16), z.unknown()).default({}),
  token: z.string().max(4096).default(''),
})

/** The fill page (ARCHITECTURE §21.3): a session when there is one; the service decides. */
export function formFillRoutes(deps: Pick<AppDeps, 'forms'>) {
  const { forms } = deps
  const link = valid('param', z.object({ link: z.string().min(1).max(64) }))
  // Before a byte of the body is read: the link, who may answer, an open form, the limits; and a
  // form without file questions takes no uploads (so no big body).
  const precheck = createMiddleware<AppEnv>(async (c, next) => {
    const principal = (c.get('principal') as Principal | undefined) ?? null
    const { files } = await forms.precheck(
      c.req.param('link') ?? '',
      principal,
      clientIp((n) => c.req.header(n)),
    )
    return (files ? limitAnswerBody : limitTextAnswerBody)(c, next)
  })
  return new Hono<AppEnv>()
    .get('/form/:link', link, async (c) => {
      const principal = (c.get('principal') as Principal | undefined) ?? null
      c.header('Cache-Control', 'private, no-store')
      return c.json(
        await forms.fillPage(
          c.req.valid('param').link,
          principal,
          clientIp((n) => c.req.header(n)),
        ),
      )
    })
    .post('/form/:link', link, precheck, async (c) => {
      const principal = (c.get('principal') as Principal | undefined) ?? null
      const type = c.req.header('content-type') ?? ''
      let payloadRaw: unknown
      const files: UploadedFile[] = []
      if (type.startsWith('multipart/form-data')) {
        const body = await c.req.parseBody({ all: true })
        const p = body.payload
        payloadRaw = typeof p === 'string' ? safeJson(p) : null
        for (const [key, value] of Object.entries(body)) {
          if (!key.startsWith('file:')) continue
          for (const f of Array.isArray(value) ? value : [value]) {
            if (typeof f === 'string') continue
            if (files.length >= MAX_ANSWER_FILES) {
              throw new HearthError('bad_request', `At most ${MAX_ANSWER_FILES} files`)
            }
            if (f.size > MAX_ANSWER_FILE_BYTES) {
              throw new HearthError('bad_request', 'Each file is at most 10 MB', { status: 413 })
            }
            files.push({
              question: key.slice('file:'.length),
              name: f.name,
              type: f.type,
              bytes: new Uint8Array(await f.arrayBuffer()),
            })
          }
        }
      } else {
        payloadRaw = await c.req.json().catch(() => null)
      }
      const payload = Payload.safeParse(payloadRaw)
      if (!payload.success) throw new HearthError('bad_request', 'The answers couldn’t be read')
      return c.json(
        await forms.submit(c.req.valid('param').link, principal, {
          answers: payload.data.answers,
          token: payload.data.token,
          files,
          ip: clientIp((n) => c.req.header(n)),
        }),
      )
    })
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

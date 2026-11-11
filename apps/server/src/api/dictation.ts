import { Hono } from 'hono'
import { z } from 'zod'
import { DICTATION_MIME_TYPES, MAX_WORD_LENGTH, MAX_WORDS_PER_LIST } from '../dictation/index.js'
import { HearthError } from '../errors.js'
import type { AppDeps, AppEnv } from './env.js'
import { valid } from './validate.js'

const WordList = z
  .array(
    z
      .string()
      .max(MAX_WORD_LENGTH)
      .refine((w) => !/[\r\n<>]/.test(w), 'a word has no line breaks or angle brackets'),
  )
  .max(MAX_WORDS_PER_LIST)

const TranscribeQuery = z.object({
  mode: z.enum(['clean', 'literal']).default('clean'),
  app_name: z.string().max(200).optional(),
  app_bundle: z.string().max(200).optional(),
  language: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/)
    .optional(),
})

/**
 * Hearth Dictate (ARCHITECTURE §9.2). `transcribe`, `GET` and `PUT words` and `DELETE devices/self`
 * also take a device token (the middleware allows it there only); the other device routes need a session.
 */
export function dictationRoutes(deps: AppDeps) {
  const { dictation } = deps
  const { store } = dictation
  return new Hono<AppEnv>()
    .basePath('/dictation')
    .post('/transcribe', valid('query', TranscribeQuery), async (c) => {
      const query = c.req.valid('query')
      const mimeType =
        (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
      if (!(DICTATION_MIME_TYPES as readonly string[]).includes(mimeType)) {
        throw new HearthError(
          'bad_request',
          'Send the audio as audio/wav, audio/mp4 or audio/webm',
          {
            status: 415,
          },
        )
      }
      const audio = new Uint8Array(await c.req.arrayBuffer())
      const result = await dictation.dictate(c.get('principal'), {
        audio,
        mimeType: mimeType.includes('wav') ? 'audio/wav' : mimeType,
        mode: query.mode,
        appName: query.app_name,
        appBundle: query.app_bundle,
        language: query.language,
      })
      c.header('Cache-Control', 'no-store')
      return c.json(result)
    })
    .get('/words', (c) => {
      const { userId, email } = c.get('principal')
      // `account` lets a Mac show whose Hearth it is connecting to.
      return c.json({ mine: store.words(userId), team: store.words('team'), account: email })
    })
    .put(
      '/words',
      valid(
        'json',
        z.union([
          // The whole list (the web page), or edits applied to the list as it is now (the Mac).
          z.object({ scope: z.enum(['mine', 'team']), words: WordList }),
          // Strict, so a bad `words` list is refused rather than read as an empty edit.
          z.strictObject({
            scope: z.enum(['mine', 'team']),
            add: WordList.optional(),
            remove: WordList.optional(),
          }),
        ]),
      ),
      (c) => {
        const body = c.req.valid('json')
        const { userId, email } = c.get('principal')
        const scope = body.scope === 'team' ? 'team' : userId
        const saved =
          'words' in body ? store.setWords(scope, body.words) : store.editWords(scope, body)
        // The team list shapes everyone's dictations: note who changed it (never the words).
        if (body.scope === 'team') {
          console.log(
            `dictation team words edited by ${email}${c.get('deviceId') ? ` (device ${c.get('deviceId')})` : ''}`,
          )
        }
        return c.json({ scope: body.scope, words: saved })
      },
    )
    .get('/devices', (c) => {
      const devices = store.listDevices(c.get('principal').userId)
      return c.json(
        devices.map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt })),
      )
    })
    .post('/devices', valid('json', z.object({ name: z.string().trim().min(1).max(80) })), (c) => {
      const principal = c.get('principal')
      const { device, token } = store.createDevice(principal, c.req.valid('json').name)
      c.header('Cache-Control', 'no-store')
      return c.json(
        { id: device.id, name: device.name, createdAt: device.createdAt, lastUsedAt: null, token },
        201,
      )
    })
    .delete('/devices/:id', (c) => {
      // `self` is the calling device, for a Mac that disconnects or reconnects itself.
      const id = c.req.param('id') === 'self' ? c.get('deviceId') : c.req.param('id')
      if (!id) throw new HearthError('bad_request', 'Only a connected Mac can disconnect itself')
      store.revokeDevice(c.get('principal').userId, id)
      return c.body(null, 204)
    })
}

import { Hono } from 'hono'
import { z } from 'zod'
import {
  CLEANUP_CHOICES,
  DICTATION_MIME_TYPES,
  MAX_HEARD_AS_PER_WORD,
  MAX_WORD_LENGTH,
  MAX_WORDS_PER_LIST,
  SEND_KEYS,
  SOUND_THEMES,
  SPEECH_CHOICES,
} from '../dictation/index.js'
import { HotsauceError } from '../errors.js'
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

// A long dictation is a few thousand words; anything far longer isn't one.
const MAX_CLEAN_TEXT = 40_000

const CleanBody = z.strictObject({
  text: z.string().max(MAX_CLEAN_TEXT),
  mode: z.enum(['clean', 'literal']).default('clean'),
  app_name: z.string().max(200).optional(),
  app_bundle: z.string().max(200).optional(),
  language: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/)
    .optional(),
})

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
 * Hotsauce Dictate (ARCHITECTURE §9.2). `transcribe`, `GET` and `PUT words` and `DELETE devices/self`
 * also take a device token (the middleware allows it there only); the other device routes need a session.
 */
export function dictationRoutes(deps: AppDeps) {
  const { dictation } = deps
  const { store } = dictation
  return (
    new Hono<AppEnv>()
      .basePath('/dictation')
      .post('/transcribe', valid('query', TranscribeQuery), async (c) => {
        const query = c.req.valid('query')
        const mimeType =
          (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
        if (!(DICTATION_MIME_TYPES as readonly string[]).includes(mimeType)) {
          throw new HotsauceError(
            'bad_request',
            'Send the audio as audio/wav, audio/mp4 or audio/webm',
            {
              status: 415,
            },
          )
        }
        // A Mac must keep this member's audio to itself (R8); the browser's own dictation may send it.
        if (c.get('deviceId')) dictation.refuseMacAudio(c.get('principal'))
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
      // Text the Mac heard itself, tidied the same way (docs/PLAN-dictate-models.md, R8).
      .post('/clean', valid('json', CleanBody), async (c) => {
        const body = c.req.valid('json')
        const result = await dictation.cleanText(c.get('principal'), {
          text: body.text,
          mode: body.mode,
          appName: body.app_name,
          appBundle: body.app_bundle,
          language: body.language,
        })
        c.header('Cache-Control', 'no-store')
        return c.json(result)
      })
      // The models in use and the member's choices (docs/PLAN-dictate-models.md, R1, R2, R7).
      .get('/settings', (c) => c.json(dictation.settings(c.get('principal').userId)))
      .put(
        '/settings',
        valid(
          'json',
          z
            .strictObject({
              cleanup: z.enum(CLEANUP_CHOICES).optional(),
              speech: z.enum(SPEECH_CHOICES).optional(),
              sendKey: z.enum(SEND_KEYS).optional(),
              sounds: z.enum(SOUND_THEMES).optional(),
            })
            .refine(
              (b) => b.cleanup || b.speech || b.sendKey || b.sounds,
              'Send cleanup, speech, sendKey or sounds',
            ),
        ),
        (c) => {
          const { userId } = c.get('principal')
          const body = c.req.valid('json')
          if (body.cleanup) store.setCleanupChoice(userId, body.cleanup)
          if (body.speech) store.setSpeechChoice(userId, body.speech)
          if (body.sendKey) store.setSendKey(userId, body.sendKey)
          if (body.sounds) store.setSoundTheme(userId, body.sounds)
          return c.json(dictation.settings(userId))
        },
      )
      .get('/words', (c) => {
        const { userId, email } = c.get('principal')
        // `account` lets a Mac show whose Hotsauce it is connecting to.
        return c.json({
          mine: store.words(userId),
          team: store.words('team'),
          heardAs: { mine: store.heardAs(userId), team: store.heardAs('team') },
          // Flat, the member's first: what the Mac applies when it writes a dictation up alone (H6).
          fixes: dictation.fixes(userId),
          account: email,
        })
      })
      .put(
        '/words/heard-as',
        valid(
          'json',
          z.strictObject({
            scope: z.enum(['mine', 'team']),
            word: z.string().trim().min(1).max(MAX_WORD_LENGTH),
            heard: WordList.max(MAX_HEARD_AS_PER_WORD * 2),
          }),
        ),
        (c) => {
          const body = c.req.valid('json')
          const { userId, email } = c.get('principal')
          const heard = store.setHeardAs(
            body.scope === 'team' ? 'team' : userId,
            body.word,
            body.heard,
          )
          if (body.scope === 'team') {
            console.log(
              `dictation team words edited by ${email}${c.get('deviceId') ? ` (device ${c.get('deviceId')})` : ''}`,
            )
          }
          return c.json({ scope: body.scope, word: body.word, heard })
        },
      )
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
          devices.map(({ id, name, createdAt, lastUsedAt, appVersion }) => ({
            id,
            name,
            createdAt,
            lastUsedAt,
            appVersion,
          })),
        )
      })
      .post(
        '/devices',
        valid('json', z.object({ name: z.string().trim().min(1).max(80) })),
        (c) => {
          const principal = c.get('principal')
          const { device, token } = store.createDevice(principal, c.req.valid('json').name)
          c.header('Cache-Control', 'no-store')
          return c.json(
            {
              id: device.id,
              name: device.name,
              createdAt: device.createdAt,
              lastUsedAt: null,
              appVersion: null,
              token,
            },
            201,
          )
        },
      )
      .delete('/devices/:id', (c) => {
        // `self` is the calling device, for a Mac that disconnects or reconnects itself.
        const id = c.req.param('id') === 'self' ? c.get('deviceId') : c.req.param('id')
        if (!id)
          throw new HotsauceError('bad_request', 'Only a connected Mac can disconnect itself')
        store.revokeDevice(c.get('principal').userId, id)
        return c.body(null, 204)
      })
  )
}

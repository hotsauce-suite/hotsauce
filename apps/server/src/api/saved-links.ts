import {
  findLinkUrl,
  LINK_SOURCES,
  MAX_HIGHLIGHT_NOTE,
  MAX_HIGHLIGHT_QUOTE,
  MAX_LINK_URL,
} from '@hotsauce/format'
import { Hono } from 'hono'
import { z } from 'zod'
import { HotsauceError } from '../errors.js'
import { MAX_ANCHOR, MAX_HIGHLIGHT_LIST, MAX_LINK_LIST } from '../links/index.js'
import type { AppDeps, AppEnv } from './env.js'
import { sessionOnly, viaFor } from './tokens.js'
import { valid } from './validate.js'

/** A page copy past this is refused outright; the service sets aside any over 2 MB. */
const MAX_PAGE_CHARS = 4 * 1024 * 1024
const Tag = z.string().trim().min(1).max(100)
const Params = z.object({ space: z.string().min(1), id: z.string().min(1) })
const HighlightParams = Params.extend({ hid: z.string().min(1).max(40) })
const HighlightBody = z.object({
  // A little over the kept length: white space in a selection collapses.
  quote: z
    .string()
    .min(1)
    .max(MAX_HIGHLIGHT_QUOTE * 2),
  prefix: z.string().max(200).optional(),
  suffix: z.string().max(200).optional(),
  block: z.number().int().min(0).max(MAX_ANCHOR).optional(),
  note: z.string().max(MAX_HIGHLIGHT_NOTE).optional(),
})

const ListQuery = z.object({
  view: z.enum(['unread', 'archive', 'all']).optional(),
  tag: z.string().max(100).optional(),
  space: z.string().min(1).optional(),
  q: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LINK_LIST).optional(),
})

const SaveBody = z.object({
  url: z
    .string()
    .max(MAX_LINK_URL * 2)
    .optional(),
  /** A shared text with the link inside it (Android's share sheet puts it here). */
  text: z.string().max(10_000).optional(),
  title: z.string().max(1000).optional(),
  tags: z.array(Tag).max(20).optional(),
  space: z.string().min(1).optional(),
  source: z.enum(LINK_SOURCES).optional(),
  /** The page as the member's browser shows it; over 2 MB the server fetches instead. */
  page: z.object({ html: z.string().max(MAX_PAGE_CHARS) }).optional(),
})

/** Saved links (ARCHITECTURE §23.4). Space access is checked by the service (403). */
export function linkRoutes(deps: Pick<AppDeps, 'links'>) {
  const service = deps.links
  return new Hono<AppEnv>()
    .basePath('/links')
    .get('/', valid('query', ListQuery), async (c) => {
      return c.json({ links: await service.list(c.get('principal'), c.req.valid('query')) })
    })
    .get('/tags', async (c) => c.json(await service.tags(c.get('principal'))))
    .get(
      '/highlights',
      valid(
        'query',
        z.object({
          q: z.string().max(500).optional(),
          limit: z.coerce.number().int().min(1).max(MAX_HIGHLIGHT_LIST).optional(),
        }),
      ),
      async (c) =>
        c.json({ highlights: await service.highlights(c.get('principal'), c.req.valid('query')) }),
    )
    .post('/', valid('json', SaveBody), async (c) => {
      const principal = c.get('principal')
      const body = c.req.valid('json')
      const url =
        (body.url?.trim() ? (findLinkUrl(body.url) ?? body.url.trim()) : null) ??
        findLinkUrl(body.text ?? '') ??
        findLinkUrl(body.title ?? '')
      if (!url) throw new HotsauceError('bad_request', 'There’s no web link in what was shared')
      const saved = await service.save(
        principal,
        {
          url,
          title: body.title,
          tags: body.tags,
          space: body.space,
          // An access token is what AI tools and scripts use (the connector too), so a save made
          // with one waits for the member like save_link (docs/PLAN-links-ai-saves.md R8).
          source: principal.via?.kind === 'token' ? 'mcp' : body.source,
          page: body.page,
        },
        viaFor(principal),
      )
      return c.json(saved, saved.existing ? 200 : 201)
    })
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
          title: z.string().max(1000).optional(),
          tags: z.array(Tag).max(20).optional(),
          archived: z.boolean().optional(),
        }),
      ),
      async (c) => {
        const principal = c.get('principal')
        const { space, id } = c.req.valid('param')
        return c.json(
          await service.update(principal, space, id, c.req.valid('json'), viaFor(principal)),
        )
      },
    )
    .put(
      '/:space/:id/reading',
      valid('param', Params),
      valid(
        'json',
        z.object({
          anchor: z.number().int().min(0).max(MAX_ANCHOR),
          percent: z.number().min(0).max(100),
        }),
      ),
      async (c) => {
        const { space, id } = c.req.valid('param')
        await service.setReading(c.get('principal'), space, id, c.req.valid('json'))
        return c.body(null, 204)
      },
    )
    .post('/:space/:id/refetch', valid('param', Params), async (c) => {
      // "Get the page" is the member asking; an access token can't ask for them (R8).
      const principal = sessionOnly(c.get('principal'))
      const { space, id } = c.req.valid('param')
      return c.json(await service.refetch(principal, space, id, viaFor(principal)))
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
    .post(
      '/:space/:id/highlights',
      valid('param', Params),
      valid('json', HighlightBody),
      async (c) => {
        // Highlights are made in the app: AI tools read them but can't write (R8).
        const principal = sessionOnly(c.get('principal'))
        const { space, id } = c.req.valid('param')
        return c.json(
          await service.addHighlight(principal, space, id, c.req.valid('json'), viaFor(principal)),
          201,
        )
      },
    )
    .post('/:space/:id/highlights/doc', valid('param', Params), async (c) => {
      // Highlights are made in the app: AI tools read them but can't write (R8).
      const principal = sessionOnly(c.get('principal'))
      const { space, id } = c.req.valid('param')
      return c.json(await service.copyHighlightsToDoc(principal, space, id, viaFor(principal)), 201)
    })
    .patch(
      '/:space/:id/highlights/:hid',
      valid('param', HighlightParams),
      valid('json', z.object({ note: z.string().max(MAX_HIGHLIGHT_NOTE) })),
      async (c) => {
        // Highlights are made in the app: AI tools read them but can't write (R8).
        const principal = sessionOnly(c.get('principal'))
        const { space, id, hid } = c.req.valid('param')
        const { note } = c.req.valid('json')
        return c.json(
          await service.noteHighlight(principal, space, id, hid, note, viaFor(principal)),
        )
      },
    )
    .delete('/:space/:id/highlights/:hid', valid('param', HighlightParams), async (c) => {
      // Highlights are made in the app: AI tools read them but can't write (R8).
      const principal = sessionOnly(c.get('principal'))
      const { space, id, hid } = c.req.valid('param')
      await service.removeHighlight(principal, space, id, hid, viaFor(principal))
      return c.body(null, 204)
    })
    .delete('/:space/:id', valid('param', Params), async (c) => {
      const principal = c.get('principal')
      const { space, id } = c.req.valid('param')
      await service.remove(principal, space, id, viaFor(principal))
      return c.body(null, 204)
    })
}

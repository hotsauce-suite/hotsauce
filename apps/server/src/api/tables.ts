import { MAX_TABLE_COLUMNS, MAX_TABLE_ROWS } from '@hearth/format'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { HearthError } from '../errors.js'
import type { AppDeps, AppEnv } from './env.js'
import { viaFor } from './tokens.js'
import { valid } from './validate.js'

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024

const Space = z.string().min(1).max(100)
const Params = z.object({ space: Space, id: z.string().min(1).max(40) })
// Sizes are checked in full by the format (`tableProblem`) in the service.
const Cells = z.array(z.array(z.string().max(10_000)).max(MAX_TABLE_COLUMNS)).max(MAX_TABLE_ROWS)

const TableInput = z.object({
  title: z.string().max(200),
  columns: z.array(z.unknown()).max(MAX_TABLE_COLUMNS),
  cells: Cells,
  blobOid: z.string().min(1).max(64),
})

const NewTable = z.object({
  space: Space,
  title: z.string().max(200).default(''),
  cells: Cells.optional(),
  /** Copy a form's answers in (ARCHITECTURE §22.6). */
  fromForm: z.object({ space: Space, id: z.string().min(1).max(40) }).optional(),
})

const fileName = (title: string, ext: string) =>
  `${title.replace(/[^\w .-]+/g, '').trim() || 'table'}.${ext}`

/** Hearth Tables (ARCHITECTURE §22.3); spaces are checked in the service. */
export function tableRoutes(deps: Pick<AppDeps, 'tables' | 'forms'>) {
  const { tables, forms } = deps
  return (
    new Hono<AppEnv>()
      .get('/tables', (c) => c.json({ tables: tables.list(c.get('principal')) }))
      .post('/tables', valid('json', NewTable), async (c) => {
        const { space, title, cells, fromForm } = c.req.valid('json')
        const p = c.get('principal')
        const view = fromForm
          ? await tables.fromForm(p, space, fromForm, viaFor(p))
          : await tables.create(p, space, { title, ...(cells ? { cells } : {}) }, viaFor(p))
        return c.json(view)
      })
      .post(
        '/tables/import',
        bodyLimit({
          maxSize: MAX_IMPORT_BYTES + 64 * 1024,
          onError: () => {
            throw new HearthError('bad_request', 'Import files are 5 MB at most', { status: 413 })
          },
        }),
        async (c) => {
          const body = await c.req.parseBody()
          const file = body.file
          const space = typeof body.space === 'string' ? body.space : ''
          if (!(file instanceof File)) {
            throw new HearthError('bad_request', 'Send the file as multipart form field "file"')
          }
          if (!space) throw new HearthError('bad_request', 'Say which space the table goes in')
          if (file.size > MAX_IMPORT_BYTES) {
            throw new HearthError('bad_request', 'Import files are 5 MB at most', { status: 413 })
          }
          const p = c.get('principal')
          const bytes = new Uint8Array(await file.arrayBuffer())
          return c.json(await tables.importFile(p, space, file.name, bytes, viaFor(p)))
        },
      )
      .get('/tables/:space/:id', valid('param', Params), async (c) => {
        const { space, id } = c.req.valid('param')
        return c.json(await tables.get(c.get('principal'), space, id))
      })
      .put('/tables/:space/:id', valid('param', Params), valid('json', TableInput), async (c) => {
        const { space, id } = c.req.valid('param')
        const p = c.get('principal')
        return c.json(await tables.save(p, space, id, c.req.valid('json'), viaFor(p)))
      })
      .delete('/tables/:space/:id', valid('param', Params), async (c) => {
        const { space, id } = c.req.valid('param')
        const p = c.get('principal')
        await tables.remove(p, space, id, viaFor(p))
        return c.body(null, 204)
      })
      .get('/tables/:space/:id/csv', valid('param', Params), async (c) => {
        const { space, id } = c.req.valid('param')
        const { title, csv } = await tables.csv(c.get('principal'), space, id)
        return c.body(`﻿${csv}`, 200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${fileName(title, 'csv')}"`,
          'Cache-Control': 'private, no-store',
        })
      })
      .get('/tables/:space/:id/xlsx', valid('param', Params), async (c) => {
        const { space, id } = c.req.valid('param')
        const { title, bytes } = await tables.xlsx(c.get('principal'), space, id)
        return c.body(new Uint8Array(bytes), 200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${fileName(title, 'xlsx')}"`,
          'Cache-Control': 'private, no-store',
        })
      })
      // A form's answers as a live, read-only table (§22.6).
      .get('/forms/:space/:id/table', valid('param', Params), async (c) => {
        const { space, id } = c.req.valid('param')
        return c.json(await forms.answerTable(c.get('principal'), space, id))
      })
  )
}

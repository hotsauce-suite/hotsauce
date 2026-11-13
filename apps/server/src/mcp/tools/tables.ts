import { columnName } from '@hearth/format'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { AppDeps } from '../../api/env.js'
import type { Principal } from '../../auth/index.js'
import { mcpVia, READ_ONLY, runTool } from '../result.js'

export type TableToolDeps = Pick<AppDeps, 'tables' | 'config'>

const Space = z.string().min(1).describe('A space name from list_spaces, e.g. "team"')
const Id = z.string().min(1).max(40).describe('The table id from list_tables or create_table')
const Row = z.array(z.string().max(10_000)).max(52)

/**
 * Hearth Tables (ARCHITECTURE §22.7): spreadsheets with Excel-style formulas, kept as CSV in Git.
 * Claude reads values (formulas worked out) and writes cells by A1 address.
 */
export function registerTableTools(server: McpServer, deps: TableToolDeps, principal: Principal) {
  const { tables } = deps
  const base = deps.config.PUBLIC_URL.replace(/\/+$/, '')
  const tableUrl = (space: string, id: string) =>
    `${base}/tables/${encodeURIComponent(space)}/${encodeURIComponent(id)}`
  const via = mcpVia(principal)
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const

  server.registerTool(
    'list_tables',
    {
      title: 'List tables',
      description:
        'Tables (spreadsheets) in the spaces you can see, most recently changed first. Pass q to match a title.',
      inputSchema: { space: Space.optional(), q: z.string().optional() },
      annotations: READ_ONLY,
    },
    ({ space, q }) =>
      runTool(async () => {
        const words = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
        return tables
          .list(principal)
          .filter((t) => !space || t.space === space)
          .filter((t) => words.every((w) => t.title.toLowerCase().includes(w)))
          .map((t) => ({ ...t, url: tableUrl(t.space, t.id) }))
      }),
  )

  server.registerTool(
    'read_table',
    {
      title: 'Read a table',
      description:
        'A table\'s cells as rows (row 1 is the header row), each cell\'s value with formulas worked out, plus formulas: every cell holding a formula by A1 address (e.g. {"D5": "=SUM(D2:D4)"}). Columns are A, B, C… Pass blobOid to update_table to make sure nobody changed it in between.',
      inputSchema: { space: Space, id: Id },
      annotations: READ_ONLY,
    },
    ({ space, id }) =>
      runTool(async () => {
        const t = await tables.values(principal, space, id)
        const formulas: Record<string, string> = {}
        t.cells.forEach((row, r) => {
          row.forEach((cell, c) => {
            if (cell.startsWith('=')) formulas[`${columnName(c)}${r + 1}`] = cell
          })
        })
        return {
          space: t.space,
          id: t.id,
          title: t.title,
          url: tableUrl(t.space, t.id),
          columns: t.columns.map((col, i) => ({
            letter: columnName(i),
            name: t.cells[0]?.[i] ?? '',
            ...col,
          })),
          rows: t.values,
          formulas,
          blobOid: t.blobOid,
          updated: t.updated,
          updatedBy: t.updatedBy,
        }
      }),
  )

  server.registerTool(
    'update_table',
    {
      title: 'Change cells in a table',
      description:
        'Sets cells by A1 address and/or adds rows at the bottom. A value starting "=" is a formula (Excel syntax, e.g. "=SUM(B2:B9)"); an empty string clears a cell. Read the table first. Returns the table with values worked out.',
      inputSchema: {
        space: Space,
        id: Id,
        set: z
          .record(z.string().regex(/^\$?[A-Za-z]{1,2}\$?\d{1,4}$/), z.string().max(10_000))
          .optional()
          .describe('Cell address → what to type there, e.g. {"B3": "42", "D3": "=B3*C3"}'),
        append: z
          .array(Row)
          .max(1000)
          .optional()
          .describe('Rows to add after the last row, left to right'),
        blobOid: z
          .string()
          .optional()
          .describe('The blobOid from read_table; refused if the table changed since'),
      },
      annotations: write,
    },
    ({ space, id, set, append, blobOid }) =>
      runTool(async () => {
        await tables.edit(principal, space, id, { set, append, blobOid }, via)
        const t = await tables.values(principal, space, id)
        return {
          id: t.id,
          title: t.title,
          url: tableUrl(space, id),
          rows: t.values,
          blobOid: t.blobOid,
        }
      }),
  )

  server.registerTool(
    'create_table',
    {
      title: 'Create a table',
      description:
        'Makes a new table. rows[0] is the header row (column names); later rows are data. Values starting "=" are formulas. Returns its id and link.',
      inputSchema: {
        space: Space.optional().describe('Default "team"'),
        title: z.string().min(1).max(200),
        rows: z.array(Row).max(5001).optional(),
      },
      annotations: write,
    },
    ({ space, title, rows }) =>
      runTool(async () => {
        const t = await tables.create(
          principal,
          space ?? 'team',
          { title, ...(rows ? { cells: rows } : {}) },
          via,
        )
        return {
          space: t.space,
          id: t.id,
          title: t.title,
          url: tableUrl(t.space, t.id),
          blobOid: t.blobOid,
        }
      }),
  )
}

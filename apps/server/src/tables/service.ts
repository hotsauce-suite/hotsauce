// Hearth Tables (ARCHITECTURE §22): a table is `tables/<id>.md` in a space, its cells a CSV block
// under YAML frontmatter. Members edit in the grid (the browser runs IronCalc); Claude reads and
// writes through MCP; the server works out formulas with the same engine. Written fresh.

import {
  type Column,
  fitColumns,
  isTableId,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  normalizeCells,
  parseA1,
  parseCsv,
  parseTableFile,
  SPACE_LAYOUT,
  TableFormatError,
  TableFrontmatter,
  tableFile,
  tablePath,
  tableProblem,
} from '@hearth/format'
import { ulid } from 'ulid'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import type { Forms } from '../forms/index.js'
import {
  type Author,
  type Change,
  formatCommitMessage,
  type GitStore,
  withVia,
} from '../git/index.js'
import type { Index } from '../index/index.js'
import type { SpaceService } from '../spaces/index.js'
import type { Syncer } from '../sync/index.js'
import { evaluateCells } from './engine.js'
import { readXlsx, writeXlsx, XlsxError } from './xlsx.js'

export interface TableSummary {
  space: string
  id: string
  title: string
  updated: string | null
  updatedBy: string | null
}

export interface TableView extends TableSummary {
  columns: Column[]
  /** Raw inputs, row 1 (the header row) first; every row the same width. */
  cells: string[][]
  created: string | null
  createdBy: string | null
  blobOid: string
}

export interface TableInput {
  title: string
  columns: unknown[]
  cells: string[][]
  blobOid: string
}

/** Cell edits by address (`B3` → what to type there) and rows to add at the bottom. */
export interface CellEdits {
  set?: Record<string, string> | undefined
  append?: string[][] | undefined
  /** The version read; a different one is a 409. Without it the edit applies to the latest. */
  blobOid?: string | undefined
}

export interface NewTable {
  title: string
  cells?: string[][]
  columns?: Column[]
}

export interface TablesDeps {
  git: Pick<GitStore, 'readFile' | 'commit'>
  index: Pick<Index, 'listFiles' | 'listSpaces'>
  spaces: Pick<SpaceService, 'canAccess'>
  syncer: Pick<Syncer, 'afterHeadChanged'>
  forms: Pick<Forms, 'answerTable'>
  now?: () => Date
}

export class Tables {
  readonly #deps: TablesDeps
  readonly #now: () => Date

  constructor(deps: TablesDeps) {
    this.#deps = deps
    this.#now = deps.now ?? (() => new Date())
  }

  /** Tables in every space the member can open, most recently changed first. */
  list(principal: Principal): TableSummary[] {
    const out: TableSummary[] = []
    for (const { name } of this.#deps.index.listSpaces()) {
      if (!this.#deps.spaces.canAccess(principal, name)) continue
      for (const row of this.#deps.index.listFiles({ space: name, kind: 'table' })) {
        const fm = TableFrontmatter.safeParse(row.frontmatter ?? {})
        if (fm.success && row.path === tablePath(fm.data.id)) out.push(summary(name, fm.data))
      }
    }
    return out.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''))
  }

  async create(
    principal: Principal,
    space: string,
    input: NewTable,
    via?: string,
  ): Promise<TableView> {
    this.#assertAccess(principal, space)
    const title = cleanTitle(input.title) || 'Untitled table'
    const cells = normalizeCells(input.cells ?? DEFAULT_CELLS)
    const width = cells[0]?.length ?? 1
    const columns = fitColumns(input.columns ?? [], width)
    const problem = tableProblem(columns, cells)
    if (problem) throw new HearthError('bad_request', problem)
    const id = ulid()
    const now = this.#iso()
    const fm = TableFrontmatter.parse({
      id,
      type: 'table',
      title,
      columns,
      created: now,
      created_by: principal.email,
      updated: now,
      updated_by: principal.email,
    })
    await this.#commit(space, principal, {
      changes: [{ path: tablePath(id), content: tableFile(fm, cells) }],
      verb: 'create',
      title,
      via,
      unchanged: { path: tablePath(id), blobOid: null },
    })
    return this.get(principal, space, id)
  }

  /** A new table from a .csv or .xlsx file (the first sheet). */
  async importFile(
    principal: Principal,
    space: string,
    name: string,
    bytes: Uint8Array,
    via?: string,
  ): Promise<TableView> {
    this.#assertAccess(principal, space)
    const lower = name.toLowerCase()
    let cells: string[][]
    if (lower.endsWith('.xlsx')) {
      try {
        cells = readXlsx(bytes)
      } catch (err) {
        if (err instanceof XlsxError) throw new HearthError('bad_request', err.message)
        throw err
      }
    } else if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) {
      const text = new TextDecoder().decode(bytes)
      cells = lower.endsWith('.tsv')
        ? text.split(/\r?\n/).map((l) => l.split('\t'))
        : parseCsv(text)
    } else {
      throw new HearthError('bad_request', 'Import a .csv or .xlsx file')
    }
    // Checked before the cells are squared up: a file of commas and blank lines mustn't make
    // the server build a grid of millions of empty cells.
    if (cells.length > MAX_TABLE_ROWS) {
      throw new HearthError('bad_request', `A table can have ${MAX_TABLE_ROWS - 1} rows at most`)
    }
    cells = cells.map(trimRow)
    if (cells.some((r) => r.length > MAX_TABLE_COLUMNS)) {
      throw new HearthError('bad_request', `A table can have ${MAX_TABLE_COLUMNS} columns at most`)
    }
    const title = name.replace(/\.[^.]+$/, '')
    return this.create(principal, space, { title, cells }, via)
  }

  /** A new table holding a form's answers as they are now. */
  async fromForm(
    principal: Principal,
    space: string,
    form: { space: string; id: string },
    via?: string,
  ): Promise<TableView> {
    const { title, columns, cells } = await this.#deps.forms.answerTable(
      principal,
      form.space,
      form.id,
    )
    // answerTable already turned any answer starting `=` into text.
    return this.create(principal, space, { title: `${title} answers`, columns, cells }, via)
  }

  async get(principal: Principal, space: string, id: string): Promise<TableView> {
    this.#assertAccess(principal, space)
    const { fm, cells, blobOid } = await this.#read(space, id)
    return view(space, fm, cells, blobOid)
  }

  /** Saves the whole table; `blobOid` is the version edited, and a different one is a 409. */
  async save(
    principal: Principal,
    space: string,
    id: string,
    input: TableInput,
    via?: string,
  ): Promise<TableView> {
    this.#assertAccess(principal, space)
    const { fm } = await this.#read(space, id)
    const cells = normalizeCells(input.cells)
    const parsedColumns = TableFrontmatter.shape.columns.safeParse(input.columns)
    if (!parsedColumns.success) throw new HearthError('bad_request', 'Those columns can’t be saved')
    const columns = fitColumns(parsedColumns.data, cells[0]?.length ?? 1)
    const title = cleanTitle(input.title)
    if (!title) throw new HearthError('bad_request', 'A table needs a name')
    await this.#write(principal, space, fm, { title, columns, cells }, input.blobOid, 'edit', via)
    return this.get(principal, space, id)
  }

  /** Sets cells by address and adds rows at the bottom (MCP `update_table`). */
  async edit(
    principal: Principal,
    space: string,
    id: string,
    edits: CellEdits,
    via?: string,
  ): Promise<TableView> {
    this.#assertAccess(principal, space)
    const { fm, cells, blobOid } = await this.#read(space, id)
    if (edits.blobOid && edits.blobOid !== blobOid) throw stale()
    const grid = cells.map((r) => [...r])
    const put = (row: number, column: number, value: string) => {
      while (grid.length <= row) grid.push([])
      const line = grid[row] as string[]
      while (line.length <= column) line.push('')
      line[column] = value
    }
    for (const [address, value] of Object.entries(edits.set ?? {})) {
      const at = parseA1(address)
      if (!at) throw new HearthError('bad_request', `"${address}" isn’t a cell address like B3`)
      put(at.row, at.column, String(value))
    }
    let last = grid.length
    while (last > 1 && (grid[last - 1] ?? []).every((c) => c === '')) last--
    for (const row of edits.append ?? []) {
      for (const [c, value] of row.entries()) put(last, c, String(value))
      last++
    }
    const next = normalizeCells(grid)
    const columns = fitColumns(fm.columns, next[0]?.length ?? 1)
    await this.#write(
      principal,
      space,
      fm,
      { title: fm.title, columns, cells: next },
      blobOid,
      'edit',
      via,
    )
    return this.get(principal, space, id)
  }

  /** Moves the table to the space's trash. */
  async remove(principal: Principal, space: string, id: string, via?: string): Promise<void> {
    this.#assertAccess(principal, space)
    const { fm, content, blobOid } = await this.#read(space, id)
    const trash = `${SPACE_LAYOUT.trash}/${this.#iso().slice(0, 10)}-${id.slice(-8)}`
    await this.#commit(space, principal, {
      changes: [
        { path: `${trash}/${tablePath(id)}`, content },
        { path: tablePath(id), content: null },
      ],
      verb: 'delete',
      title: fm.title,
      via,
      unchanged: { path: tablePath(id), blobOid },
    })
  }

  /** The table with every formula worked out. */
  async values(
    principal: Principal,
    space: string,
    id: string,
  ): Promise<TableView & { values: string[][] }> {
    const table = await this.get(principal, space, id)
    return { ...table, values: evaluateCells(table.cells) }
  }

  async csv(
    principal: Principal,
    space: string,
    id: string,
  ): Promise<{ title: string; csv: string }> {
    const { title, values } = await this.values(principal, space, id)
    const lines = values.map((row) =>
      row
        .map((v) => {
          const safe = /^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? `'${v}` : v
          return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
        })
        .join(','),
    )
    return { title, csv: `${lines.join('\r\n')}\r\n` }
  }

  async xlsx(
    principal: Principal,
    space: string,
    id: string,
  ): Promise<{ title: string; bytes: Uint8Array }> {
    const { title, cells, values } = await this.values(principal, space, id)
    return { title, bytes: writeXlsx(title, cells, values) }
  }

  // ── internals ─────────────────────────────────────────────────────────

  async #write(
    principal: Principal,
    space: string,
    fm: TableFrontmatter,
    next: { title: string; columns: Column[]; cells: string[][] },
    blobOid: string,
    verb: string,
    via: string | undefined,
  ) {
    const problem = tableProblem(next.columns, next.cells)
    if (problem) throw new HearthError('bad_request', problem)
    const updated = TableFrontmatter.parse({
      ...fm,
      title: next.title,
      columns: next.columns,
      updated: this.#iso(),
      updated_by: principal.email,
    })
    await this.#commit(space, principal, {
      changes: [{ path: tablePath(fm.id), content: tableFile(updated, next.cells) }],
      verb,
      title: next.title,
      via,
      unchanged: { path: tablePath(fm.id), blobOid },
    })
  }

  async #read(space: string, id: string) {
    if (!isTableId(id)) throw notFound()
    const file = await this.#deps.git.readFile(space, tablePath(id)).catch((err) => {
      throw err instanceof HearthError && err.code === 'not_found' ? notFound() : err
    })
    try {
      const { fm, cells } = parseTableFile(file.content)
      if (fm.id !== id) throw new TableFormatError('id')
      return { fm, cells, content: file.content, blobOid: file.blobOid }
    } catch (err) {
      if (!(err instanceof TableFormatError)) throw err
      throw new HearthError('conflict', 'This table’s file can’t be read; fix it in Git')
    }
  }

  async #commit(
    space: string,
    author: Author,
    args: {
      changes: Change[]
      verb: string
      title: string
      via: string | undefined
      unchanged: { path: string; blobOid: string | null }
    },
  ): Promise<void> {
    const result = await this.#deps.git
      .commit(space, {
        changes: args.changes,
        author,
        message: withVia(
          formatCommitMessage({
            app: 'tables',
            verb: args.verb,
            title: args.title.replace(/"/g, "'"),
          }),
          args.via,
        ),
        unchanged: args.unchanged,
      })
      .catch((err) => {
        throw err instanceof HearthError && err.code === 'conflict' ? stale() : err
      })
    if (result.status === 'conflict') throw stale()
    await this.#deps.syncer.afterHeadChanged(space)
  }

  #assertAccess(principal: Principal, space: string) {
    if (!this.#deps.spaces.canAccess(principal, space)) {
      throw new HearthError('forbidden', `You don't have access to the space "${space}"`)
    }
  }

  #iso(): string {
    return this.#now()
      .toISOString()
      .replace(/\.\d+Z$/, 'Z')
  }
}

const DEFAULT_CELLS = [['Name', 'Notes']]

/** A row without its trailing empty cells (spreadsheets often export a row of commas). */
function trimRow(row: string[]): string[] {
  let end = row.length
  while (end > 0 && row[end - 1] === '') end--
  return end === row.length ? row : row.slice(0, end)
}

const cleanTitle = (title: string) => title.replace(/\s+/g, ' ').trim().slice(0, 200)

function summary(space: string, fm: TableFrontmatter): TableSummary {
  return {
    space,
    id: fm.id,
    title: fm.title,
    updated: fm.updated ?? null,
    updatedBy: fm.updated_by ?? null,
  }
}

function view(space: string, fm: TableFrontmatter, cells: string[][], blobOid: string): TableView {
  return {
    ...summary(space, fm),
    columns: fitColumns(fm.columns, cells[0]?.length ?? 1),
    cells,
    created: fm.created ?? null,
    createdBy: fm.created_by ?? null,
    blobOid,
  }
}

const notFound = () => new HearthError('not_found', 'No such table')
const stale = () =>
  new HearthError('conflict', 'Someone changed this table at the same time; reload to see it')

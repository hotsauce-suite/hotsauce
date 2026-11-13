// biome-ignore-all lint/a11y/useSemanticElements: an ARIA grid (a spreadsheet), not a data table
// biome-ignore-all lint/a11y/useFocusableInteractive: the grid takes focus; its cells are parts of it
// biome-ignore-all lint/a11y/noStaticElementInteractions: the mouse selects rows; the keyboard does it from the grid
// biome-ignore-all lint/suspicious/noArrayIndexKey: a column's index is what identifies it
import {
  COLUMN_TYPES,
  type Column,
  type ColumnType,
  columnName,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  shiftFormula,
} from '@hearth/format'
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Icon } from '../../components/Icon'
import { isFormula, type Sheet } from './sheet'
import {
  type Filter,
  isTicked,
  linkHref,
  parseClipboard,
  type Sort,
  toClipboard,
  viewRows,
} from './view'

// The table grid (ARCHITECTURE §22.8). Rows are drawn only near the scroll position, so a
// 5,000-row table scrolls as easily as a small one. Row 0 is the header row: it holds the column
// names and stays at the top. Sorting and filtering change what's on screen, never the file.

export const TYPE_LABEL: Record<ColumnType, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  checkbox: 'Checkbox',
  choice: 'Choice',
  person: 'Person',
  link: 'Link',
}

const ROW_H = 32
const LETTERS_H = 28
const NUMBERS_W = 48
const DEFAULT_W = 160
const OVERSCAN = 12
/** Empty rows below the data to type into. */
const SPARE_ROWS = 20

export type Change = { row: number; column: number; input: string }
export type Structure =
  | { kind: 'insertRows'; at: number; count: number }
  | { kind: 'deleteRows'; at: number; count: number }
  | { kind: 'insertColumns'; at: number; count: number }
  | { kind: 'deleteColumns'; at: number; count: number }

interface Pos {
  /** Row on screen: 0 is the header row. */
  vr: number
  c: number
}

type Menu =
  | { kind: 'column'; c: number; x: number; y: number }
  | { kind: 'cell'; vr: number; c: number; x: number; y: number }

/** What this grid last copied, so pasting it back keeps formulas and moves their references. */
let lastCopy: { text: string; inputs: string[][]; rows: number[]; column: number } | null = null

export function Grid({
  sheet,
  version,
  columns,
  readOnly = false,
  people = [],
  onChange,
  onStructure,
  onColumns,
  onUndo,
  onRedo,
}: {
  sheet: Sheet
  /** Bumped by the parent whenever the sheet changes, so the grid redraws. */
  version: number
  columns: Column[]
  readOnly?: boolean
  /** Emails offered in person columns. */
  people?: string[]
  onChange?: (changes: Change[]) => void
  onStructure?: (op: Structure) => void
  onColumns?: (columns: Column[]) => void
  onUndo?: () => void
  onRedo?: () => void
}) {
  const [sel, setSel] = useState<Pos>({ vr: 1, c: 0 })
  const [anchor, setAnchor] = useState<Pos>({ vr: 1, c: 0 })
  const [editing, setEditing] = useState<{ pos: Pos; value: string } | null>(null)
  const [sort, setSort] = useState<Sort | null>(null)
  const [filters, setFilters] = useState<Filter[]>([])
  const [menu, setMenu] = useState<Menu | null>(null)
  const [scroll, setScroll] = useState({ top: 0, height: 600 })
  const [widths, setWidths] = useState<Record<number, number>>({})
  const box = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is how the sheet's changes reach the grid
  const order = useMemo(
    () => viewRows(sheet.rows, (r, c) => sheet.value(r, c), sort, filters),
    [sheet, version, sort, filters],
  )
  const width = Math.min(MAX_TABLE_COLUMNS, Math.max(sheet.width + (readOnly ? 0 : 1), 6))
  const shownRows = 1 + order.length + (readOnly || filters.length ? 0 : SPARE_ROWS)
  const modelRow = (vr: number) =>
    vr === 0
      ? 0
      : vr <= order.length
        ? (order[vr - 1] as number)
        : sheet.rows + (vr - order.length - 1)
  const colW = (c: number) => widths[c] ?? columns[c]?.width ?? DEFAULT_W
  const typeOf = (c: number): ColumnType => columns[c]?.type ?? 'text'
  const lefts = [NUMBERS_W]
  for (let c = 0; c < width; c++) lefts.push((lefts[c] as number) + colW(c))
  const totalW = lefts[width] as number

  useEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setScroll({ top: el.scrollTop, height: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const up = () => {
      dragging.current = false
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  const first = Math.max(1, Math.floor(scroll.top / ROW_H) - OVERSCAN)
  const last = Math.min(shownRows - 1, Math.ceil((scroll.top + scroll.height) / ROW_H) + OVERSCAN)

  const range = {
    r0: Math.min(sel.vr, anchor.vr),
    r1: Math.max(sel.vr, anchor.vr),
    c0: Math.min(sel.c, anchor.c),
    c1: Math.max(sel.c, anchor.c),
  }
  const inRange = (vr: number, c: number) =>
    vr >= range.r0 && vr <= range.r1 && c >= range.c0 && c <= range.c1

  const focusGrid = () => box.current?.focus({ preventScroll: true })

  const scrollInto = (p: Pos) => {
    const el = box.current
    if (!el) return
    const top = p.vr === 0 ? 0 : LETTERS_H + ROW_H + (p.vr - 1) * ROW_H
    const sticky = LETTERS_H + ROW_H
    if (p.vr > 0 && top < el.scrollTop + sticky) el.scrollTop = top - sticky
    else if (top + ROW_H > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + ROW_H - el.clientHeight
    }
    const left = lefts[p.c] as number
    const right = lefts[p.c + 1] as number
    if (left - NUMBERS_W < el.scrollLeft) el.scrollLeft = left - NUMBERS_W
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth
  }

  const move = (p: Pos, extend = false) => {
    const next = {
      vr: Math.max(0, Math.min(shownRows - 1, p.vr)),
      c: Math.max(0, Math.min(width - 1, p.c)),
    }
    setSel(next)
    if (!extend) setAnchor(next)
    scrollInto(next)
  }

  const commit = (pos: Pos, value: string) => {
    setEditing(null)
    const row = modelRow(pos.vr)
    if (readOnly || row >= MAX_TABLE_ROWS || sheet.input(row, pos.c) === value) return
    onChange?.([{ row, column: pos.c, input: value }])
  }

  const startEdit = (pos: Pos, initial?: string) => {
    if (readOnly) return
    const type = typeOf(pos.c)
    const current = sheet.input(modelRow(pos.vr), pos.c)
    if (type === 'checkbox' && pos.vr > 0 && initial === undefined) {
      onChange?.([
        { row: modelRow(pos.vr), column: pos.c, input: isTicked(current) ? 'FALSE' : 'TRUE' },
      ])
      return
    }
    setEditing({ pos, value: initial ?? current })
  }

  const clearRange = () => {
    if (readOnly) return
    const changes: Change[] = []
    for (let vr = range.r0; vr <= range.r1; vr++) {
      const row = modelRow(vr)
      if (row >= sheet.rows) continue
      for (let c = range.c0; c <= range.c1; c++) {
        if (sheet.input(row, c) !== '') changes.push({ row, column: c, input: '' })
      }
    }
    if (changes.length) onChange?.(changes)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing || menu) return
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) onRedo?.()
      else onUndo?.()
      return
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      onRedo?.()
      return
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      setAnchor({ vr: 0, c: 0 })
      setSel({ vr: shownRows - 1, c: width - 1 })
      return
    }
    if (mod) return
    const step: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    }
    const d = step[e.key]
    if (d) {
      e.preventDefault()
      move({ vr: sel.vr + d[0], c: sel.c + d[1] }, e.shiftKey)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      move({ vr: sel.vr, c: sel.c + (e.shiftKey ? -1 : 1) })
    } else if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault()
      startEdit(sel)
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      clearRange()
    } else if (e.key === ' ' && typeOf(sel.c) === 'checkbox' && sel.vr > 0) {
      e.preventDefault()
      startEdit(sel)
    } else if (e.key.length === 1 && !e.altKey) {
      e.preventDefault()
      startEdit(sel, e.key)
    }
  }

  const copy = (e: ClipboardEvent<HTMLDivElement>, cut: boolean) => {
    if (editing) return
    e.preventDefault()
    const rows: number[] = []
    const inputs: string[][] = []
    const values: string[][] = []
    for (let vr = range.r0; vr <= range.r1; vr++) {
      const row = modelRow(vr)
      rows.push(row)
      const ins: string[] = []
      const vals: string[] = []
      for (let c = range.c0; c <= range.c1; c++) {
        ins.push(sheet.input(row, c))
        vals.push(sheet.value(row, c))
      }
      inputs.push(ins)
      values.push(vals)
    }
    const text = toClipboard(values)
    e.clipboardData.setData('text/plain', text)
    lastCopy = { text, inputs, rows, column: range.c0 }
    if (cut) clearRange()
  }

  const paste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (editing || readOnly) return
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    const ours = lastCopy?.text === text ? lastCopy : null
    const block = ours ? ours.inputs : parseClipboard(text)
    const changes: Change[] = []
    block.forEach((line, i) => {
      const row = modelRow(range.r0 + i)
      if (row >= MAX_TABLE_ROWS) return
      line.forEach((input, j) => {
        const column = range.c0 + j
        if (column >= MAX_TABLE_COLUMNS) return
        let value = input
        if (ours && isFormula(input)) {
          const from = ours.rows[i] as number
          value = `=${shiftFormula(input.slice(1), row - from, column - (ours.column + j))}`
        }
        changes.push({ row, column, input: value })
      })
    })
    if (changes.length) onChange?.(changes)
    const lastPos = { vr: range.r0 + block.length - 1, c: range.c0 + (block[0]?.length ?? 1) - 1 }
    setAnchor({ vr: range.r0, c: range.c0 })
    setSel({ vr: Math.min(shownRows - 1, lastPos.vr), c: Math.min(width - 1, lastPos.c) })
  }

  const cellMouseDown = (e: MouseEvent, pos: Pos) => {
    if (e.button !== 0) return
    if (editing && (editing.pos.vr !== pos.vr || editing.pos.c !== pos.c)) {
      commit(editing.pos, editing.value)
    }
    dragging.current = true
    move(pos, e.shiftKey)
    setMenu(null)
  }

  const contextMenu = (e: MouseEvent, pos: Pos) => {
    if (readOnly) return
    e.preventDefault()
    if (!inRange(pos.vr, pos.c)) move(pos)
    setMenu({ kind: 'cell', vr: pos.vr, c: pos.c, x: e.clientX, y: e.clientY })
  }

  const startResize = (e: MouseEvent, c: number) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = colW(c)
    let w = startW
    const onMove = (ev: globalThis.MouseEvent) => {
      w = Math.max(40, Math.min(800, startW + ev.clientX - startX))
      setWidths((m) => ({ ...m, [c]: w }))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (w !== startW && !readOnly) {
        const next = columns.map((col) => ({ ...col }))
        while (next.length <= c) next.push({ type: 'text' })
        next[c] = { ...(next[c] as Column), width: Math.round(w) }
        onColumns?.(next)
      }
      setWidths((m) => {
        const { [c]: _gone, ...rest } = m
        return rest
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const selRow = modelRow(sel.vr)
  const selInput = sheet.input(selRow, sel.c)

  const renderCell = (vr: number, c: number) => {
    const row = modelRow(vr)
    const isEditing = editing?.pos.vr === vr && editing.pos.c === c
    const selected = sel.vr === vr && sel.c === c
    const type = vr === 0 ? 'text' : typeOf(c)
    const value = row < sheet.rows ? sheet.value(row, c) : ''
    const isError = /^#[A-Z/0!?]+[!?]?$/.test(value) && isFormula(sheet.input(row, c))
    return (
      <div
        key={c}
        role="gridcell"
        aria-selected={selected}
        data-cell={`${columnName(c)}${row + 1}`}
        className={`absolute top-0 h-full truncate border-r border-b border-ash/70 px-2 leading-[31px] ${
          vr === 0 ? 'bg-paper-sunk font-semibold text-ink' : 'text-ink'
        } ${inRange(vr, c) && !selected ? 'bg-ember-wash/60' : ''} ${
          type === 'number' && !isEditing ? 'text-right tabular-nums' : ''
        } ${isError ? 'text-ember-strong' : ''}`}
        style={{ left: (lefts[c] as number) - NUMBERS_W, width: colW(c) }}
        onMouseDown={(e) => cellMouseDown(e, { vr, c })}
        onMouseEnter={() => {
          if (dragging.current) setSel({ vr, c })
        }}
        onDoubleClick={() => startEdit({ vr, c })}
        onContextMenu={(e) => contextMenu(e, { vr, c })}
      >
        {isEditing ? (
          <CellEditor
            type={type}
            column={columns[c]}
            value={editing.value}
            people={people}
            onChange={(v) => setEditing({ pos: { vr, c }, value: v })}
            onDone={(how, v) => {
              if (how === 'cancel') setEditing(null)
              else commit({ vr, c }, v)
              focusGrid()
              if (how === 'down') move({ vr: vr + 1, c })
              if (how === 'right') move({ vr, c: c + 1 })
              if (how === 'left') move({ vr, c: c - 1 })
            }}
          />
        ) : (
          <CellValue type={type} value={value} />
        )}
        {selected && !isEditing ? (
          <span className="pointer-events-none absolute inset-0 border-2 border-ember" />
        ) : null}
      </div>
    )
  }

  const rowView = (vr: number) => {
    const row = modelRow(vr)
    return (
      <div
        key={vr}
        role="row"
        className={vr === 0 ? 'sticky z-10 flex' : 'absolute left-0 flex'}
        style={
          vr === 0
            ? { top: LETTERS_H, height: ROW_H, width: totalW }
            : { top: (vr - 1) * ROW_H, height: ROW_H, width: totalW }
        }
      >
        <div
          className={`sticky left-0 z-[1] flex shrink-0 items-center justify-end border-r border-b border-ash/70 pr-2 text-xs tabular-nums ${
            vr >= range.r0 && vr <= range.r1
              ? 'bg-ember-wash text-ink'
              : 'bg-paper-sunk text-ink-faint'
          }`}
          style={{ width: NUMBERS_W }}
          onMouseDown={(e) => {
            if (e.button !== 0) return
            setAnchor({ vr: e.shiftKey ? anchor.vr : vr, c: 0 })
            setSel({ vr, c: width - 1 })
          }}
          onContextMenu={(e) => contextMenu(e, { vr, c: sel.c })}
        >
          {row + 1}
        </div>
        <div className="relative h-full" style={{ width: totalW - NUMBERS_W }}>
          {Array.from({ length: width }, (_, c) => renderCell(vr, c))}
        </div>
      </div>
    )
  }

  const clearView = () => {
    setSort(null)
    setFilters([])
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-ash/70 bg-paper px-2 py-1.5">
        <span
          className="w-14 shrink-0 rounded bg-paper-sunk px-2 py-1 text-center font-mono text-xs text-ink-soft"
          data-testid="cell-address"
        >
          {columnName(sel.c)}
          {selRow + 1}
        </span>
        <span className="font-mono text-sm text-ink-faint italic">fx</span>
        <input
          aria-label="Cell contents"
          data-testid="formula-bar"
          className="h-8 min-w-0 flex-1 rounded-md border border-ash bg-paper-raised px-2 font-mono text-sm text-ink focus:border-ember focus:outline-none"
          value={
            editing && editing.pos.vr === sel.vr && editing.pos.c === sel.c
              ? editing.value
              : selInput
          }
          readOnly={readOnly}
          onFocus={() => {
            if (!readOnly && !editing) setEditing({ pos: sel, value: selInput })
          }}
          onChange={(e) => setEditing({ pos: sel, value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (editing) commit(editing.pos, editing.value)
              focusGrid()
              move({ vr: sel.vr + 1, c: sel.c })
            } else if (e.key === 'Escape') {
              setEditing(null)
              focusGrid()
            }
          }}
          onBlur={() => {
            if (editing && editing.pos.vr === sel.vr && editing.pos.c === sel.c) {
              commit(editing.pos, editing.value)
            }
          }}
        />
        {sort || filters.length ? (
          <button
            type="button"
            className="shrink-0 rounded-full bg-ember-wash px-3 py-1 text-xs text-ink hover:bg-ember/20"
            onClick={clearView}
            data-testid="clear-view"
          >
            {[sort ? 'Sorted' : '', filters.length ? 'Filtered' : ''].filter(Boolean).join(', ')} ·
            Show all
          </button>
        ) : null}
      </div>
      <div
        ref={box}
        role="grid"
        tabIndex={0}
        aria-label="Table"
        aria-readonly={readOnly}
        data-testid="table-grid"
        className="relative min-h-0 flex-1 overflow-auto bg-paper-raised text-sm outline-none"
        onScroll={(e) =>
          setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })
        }
        onKeyDown={onKeyDown}
        onCopy={(e) => copy(e, false)}
        onCut={(e) => copy(e, true)}
        onPaste={paste}
      >
        <div style={{ width: totalW, height: LETTERS_H + shownRows * ROW_H }}>
          <div className="sticky top-0 z-20 flex" style={{ height: LETTERS_H, width: totalW }}>
            <div
              className="sticky left-0 z-[1] shrink-0 border-r border-b border-ash/70 bg-paper-sunk"
              style={{ width: NUMBERS_W }}
            />
            {Array.from({ length: width }, (_, c) => (
              <div
                key={c}
                className={`group relative flex shrink-0 items-center justify-center gap-1 border-r border-b border-ash/70 text-xs ${
                  c >= range.c0 && c <= range.c1
                    ? 'bg-ember-wash text-ink'
                    : 'bg-paper-sunk text-ink-faint'
                }`}
                style={{ width: colW(c) }}
              >
                <button
                  type="button"
                  className="flex h-full flex-1 items-center justify-center gap-1 hover:text-ink"
                  data-testid={`column-${columnName(c)}`}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect()
                    setMenu({ kind: 'column', c, x: r.left, y: r.bottom })
                  }}
                >
                  {columnName(c)}
                  {sort?.column === c ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                  {filters.some((f) => f.column === c) ? ' ⏷' : ''}
                  {columns[c] && columns[c].type !== 'text' ? (
                    <span className="text-[10px] text-ink-faint">
                      · {TYPE_LABEL[columns[c].type]}
                    </span>
                  ) : null}
                </button>
                {readOnly ? null : (
                  <span
                    aria-hidden="true"
                    className="absolute top-0 right-[-3px] z-[2] h-full w-1.5 cursor-col-resize hover:bg-ember/40"
                    onMouseDown={(e) => startResize(e, c)}
                  />
                )}
              </div>
            ))}
          </div>
          {rowView(0)}
          <div className="relative" style={{ height: (shownRows - 1) * ROW_H, width: totalW }}>
            {Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => rowView(first + i))}
          </div>
        </div>
        {filters.length && order.length === 0 ? (
          <p className="sticky left-0 p-4 text-sm text-ink-faint">No rows match the filter.</p>
        ) : null}
      </div>
      {menu ? (
        <MenuLayer onClose={() => setMenu(null)} x={menu.x} y={menu.y}>
          {menu.kind === 'column' ? (
            <ColumnMenu
              c={menu.c}
              name={sheet.input(0, menu.c)}
              column={columns[menu.c] ?? { type: 'text' }}
              readOnly={readOnly}
              sort={sort}
              filter={filters.find((f) => f.column === menu.c)?.text ?? ''}
              canInsert={sheet.width < MAX_TABLE_COLUMNS}
              onName={(name) => onChange?.([{ row: 0, column: menu.c, input: name }])}
              onColumn={(col) => {
                const next = columns.map((x) => ({ ...x }))
                while (next.length <= menu.c) next.push({ type: 'text' })
                next[menu.c] = col
                onColumns?.(next)
              }}
              onSort={(dir) => {
                setSort(dir ? { column: menu.c, dir } : null)
                setMenu(null)
              }}
              onFilter={(text) =>
                setFilters((fs) => [
                  ...fs.filter((f) => f.column !== menu.c),
                  ...(text.trim() ? [{ column: menu.c, text }] : []),
                ])
              }
              onStructure={(op) => {
                clearView()
                onStructure?.(op)
                setMenu(null)
              }}
            />
          ) : (
            <CellMenu
              row={modelRow(menu.vr)}
              column={menu.c}
              rows={range.r1 - range.r0 + 1}
              columns={range.c1 - range.c0 + 1}
              firstRow={modelRow(range.r0)}
              firstColumn={range.c0}
              sorted={Boolean(sort || filters.length)}
              onStructure={(op) => {
                clearView()
                onStructure?.(op)
                setMenu(null)
              }}
            />
          )}
        </MenuLayer>
      ) : null}
    </div>
  )
}

/** A cell's value, drawn by its column type. */
function CellValue({ type, value }: { type: ColumnType; value: string }) {
  if (value === '') return null
  if (type === 'checkbox') {
    return (
      <span
        role="img"
        className="flex h-full items-center justify-center"
        aria-label={isTicked(value) ? 'Ticked' : 'Not ticked'}
      >
        <span
          className={`inline-flex size-4 items-center justify-center rounded border text-[11px] ${
            isTicked(value) ? 'border-ember bg-ember text-paper-raised' : 'border-ash-strong'
          }`}
        >
          {isTicked(value) ? '✓' : ''}
        </span>
      </span>
    )
  }
  if (type === 'number' && /^-?\d+(\.\d+)?$/.test(value)) {
    // Plain numbers get thousands separators on screen; the cell keeps what was typed.
    const [whole = '', frac] = value.split('.')
    const grouped = Number(whole).toLocaleString('en-US')
    return <>{frac === undefined ? grouped : `${grouped}.${frac}`}</>
  }
  if (type === 'choice') {
    return <span className="rounded-full bg-paper-sunk px-2 py-0.5 text-xs">{value}</span>
  }
  const href = linkHref(value, type)
  if (href && (type === 'link' || type === 'person')) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-ember-strong underline decoration-ember/40 underline-offset-2"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {value}
      </a>
    )
  }
  return <>{value}</>
}

type Done = 'stay' | 'down' | 'right' | 'left' | 'cancel'

/** The editor inside a cell: a text box, or a picker for choice, date and person columns. */
function CellEditor({
  type,
  column,
  value,
  people,
  onChange,
  onDone,
}: {
  type: ColumnType
  column: Column | undefined
  value: string
  people: string[]
  onChange: (v: string) => void
  onDone: (how: Done, value: string) => void
}) {
  const ref = useRef<HTMLInputElement & HTMLSelectElement>(null)
  const done = useRef(false)
  useEffect(() => {
    const el: HTMLElement | null = ref.current
    el?.focus()
    if (el instanceof HTMLInputElement && el.type === 'text') {
      el.setSelectionRange(el.value.length, el.value.length)
    }
  }, [])
  const finish = (how: Done, v = value) => {
    if (done.current) return
    done.current = true
    onDone(how, v)
  }
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.altKey) {
      e.preventDefault()
      finish(e.shiftKey ? 'stay' : 'down')
    } else if (e.key === 'Tab') {
      e.preventDefault()
      finish(e.shiftKey ? 'left' : 'right')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish('cancel')
    }
    e.stopPropagation()
  }
  const cls =
    'absolute inset-0 z-10 h-full w-full border-2 border-ember bg-paper-raised px-2 text-sm text-ink outline-none'
  if (type === 'choice' && !value.startsWith('=')) {
    const options = column?.options ?? []
    return (
      <select
        ref={ref}
        aria-label="Choose"
        className={cls}
        value={options.includes(value) ? value : ''}
        onChange={(e) => finish('stay', e.target.value)}
        onBlur={() => finish('stay')}
        onKeyDown={keys}
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  }
  const list = type === 'person' ? 'table-people' : undefined
  return (
    <>
      <input
        ref={ref}
        aria-label="Edit cell"
        data-testid="cell-editor"
        type={
          type === 'date' &&
          !value.startsWith('=') &&
          (value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value))
            ? 'date'
            : 'text'
        }
        list={list}
        className={cls}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => finish('stay')}
        onKeyDown={keys}
      />
      {list ? (
        <datalist id={list}>
          {people.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      ) : null}
    </>
  )
}

function MenuLayer({
  x,
  y,
  onClose,
  children,
}: {
  x: number
  y: number
  onClose: () => void
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    })
  }, [x, y])
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <>
      <button
        type="button"
        aria-label="Close menu"
        className="fixed inset-0 z-40 cursor-default"
        onClick={onClose}
      />
      <div
        ref={ref}
        role="menu"
        className="fixed z-50 w-64 rounded-xl border border-ash bg-paper-raised p-1.5 text-sm shadow-lg"
        style={{ left: pos.x, top: pos.y }}
      >
        {children}
      </div>
    </>
  )
}

const menuBase =
  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-paper-sunk disabled:opacity-40'
const menuItem = `${menuBase} text-ink`
const menuDanger = `${menuBase} text-ember-strong`

function ColumnMenu({
  c,
  name,
  column,
  readOnly,
  sort,
  filter,
  canInsert,
  onName,
  onColumn,
  onSort,
  onFilter,
  onStructure,
}: {
  c: number
  name: string
  column: Column
  readOnly: boolean
  sort: Sort | null
  filter: string
  canInsert: boolean
  onName: (name: string) => void
  onColumn: (column: Column) => void
  onSort: (dir: 'asc' | 'desc' | null) => void
  onFilter: (text: string) => void
  onStructure: (op: Structure) => void
}) {
  const [draftName, setDraftName] = useState(name)
  const [options, setOptions] = useState((column.options ?? []).join('\n'))
  const field =
    'h-8 w-full rounded-md border border-ash bg-paper px-2 text-sm text-ink focus:border-ember focus:outline-none'
  return (
    <div className="flex flex-col gap-1" data-testid="column-menu">
      {readOnly ? null : (
        <div className="flex flex-col gap-2 px-1.5 pt-1 pb-2">
          <label className="text-xs text-ink-faint">
            Column {columnName(c)} name
            <input
              className={`${field} mt-1`}
              value={draftName}
              data-testid="column-name"
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={() => draftName !== name && onName(draftName)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && draftName !== name) onName(draftName)
              }}
            />
          </label>
          <label className="text-xs text-ink-faint">
            Type
            <select
              className={`${field} mt-1`}
              value={column.type}
              data-testid="column-type"
              onChange={(e) => {
                const type = e.target.value as ColumnType
                const { options: _o, ...rest } = column
                onColumn(
                  type === 'choice'
                    ? { ...rest, type, options: column.options ?? [] }
                    : { ...rest, type },
                )
              }}
            >
              {COLUMN_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          {column.type === 'choice' ? (
            <label className="text-xs text-ink-faint">
              Options, one per line
              <textarea
                className={`${field} mt-1 h-24 py-1`}
                value={options}
                data-testid="column-options"
                onChange={(e) => setOptions(e.target.value)}
                onBlur={() => {
                  const list = [
                    ...new Map(
                      options
                        .split('\n')
                        .map((o) => o.trim())
                        .filter(Boolean)
                        .map((o) => [o.toLowerCase(), o.slice(0, 200)]),
                    ).values(),
                  ].slice(0, 50)
                  onColumn({ ...column, options: list })
                }}
              />
            </label>
          ) : null}
        </div>
      )}
      <div className="border-t border-ash/70 pt-1">
        <button
          type="button"
          role="menuitem"
          className={menuItem}
          onClick={() => onSort('asc')}
          data-testid="sort-asc"
        >
          <Icon name="sliders" className="size-4 text-ink-faint" />
          Sort A → Z, 1 → 9
        </button>
        <button
          type="button"
          role="menuitem"
          className={menuItem}
          onClick={() => onSort('desc')}
          data-testid="sort-desc"
        >
          <Icon name="sliders" className="size-4 text-ink-faint" />
          Sort Z → A, 9 → 1
        </button>
        {sort?.column === c ? (
          <button type="button" role="menuitem" className={menuItem} onClick={() => onSort(null)}>
            Stop sorting
          </button>
        ) : null}
        <label className="block px-2.5 pt-1.5 pb-1 text-xs text-ink-faint">
          Show rows containing
          <input
            className={`${field} mt-1`}
            defaultValue={filter}
            placeholder="Anything"
            data-testid="column-filter"
            onChange={(e) => onFilter(e.target.value)}
          />
        </label>
      </div>
      {readOnly ? null : (
        <div className="border-t border-ash/70 pt-1">
          <button
            type="button"
            role="menuitem"
            className={menuItem}
            disabled={!canInsert}
            onClick={() => onStructure({ kind: 'insertColumns', at: c, count: 1 })}
          >
            Insert a column to the left
          </button>
          <button
            type="button"
            role="menuitem"
            className={menuItem}
            disabled={!canInsert}
            onClick={() => onStructure({ kind: 'insertColumns', at: c + 1, count: 1 })}
          >
            Insert a column to the right
          </button>
          <button
            type="button"
            role="menuitem"
            className={menuDanger}
            data-testid="delete-column"
            onClick={() => onStructure({ kind: 'deleteColumns', at: c, count: 1 })}
          >
            Delete column {columnName(c)}
          </button>
        </div>
      )}
    </div>
  )
}

function CellMenu({
  row,
  column,
  rows,
  columns,
  firstRow,
  firstColumn,
  sorted,
  onStructure,
}: {
  row: number
  column: number
  rows: number
  columns: number
  firstRow: number
  firstColumn: number
  sorted: boolean
  onStructure: (op: Structure) => void
}) {
  const many = (n: number, one: string, more: string) => (n === 1 ? one : `${n} ${more}`)
  return (
    <div className="flex flex-col" data-testid="cell-menu">
      {sorted ? (
        <p className="px-2.5 pb-1 text-xs text-ink-faint">
          Adding or deleting rows shows all rows again.
        </p>
      ) : null}
      <button
        type="button"
        role="menuitem"
        className={menuItem}
        disabled={row === 0}
        onClick={() => onStructure({ kind: 'insertRows', at: row, count: 1 })}
      >
        Insert a row above
      </button>
      <button
        type="button"
        role="menuitem"
        className={menuItem}
        onClick={() => onStructure({ kind: 'insertRows', at: row + 1, count: 1 })}
      >
        Insert a row below
      </button>
      <button
        type="button"
        role="menuitem"
        className={menuDanger}
        disabled={row === 0 || (!sorted && firstRow === 0)}
        data-testid="delete-row"
        onClick={() =>
          onStructure({ kind: 'deleteRows', at: sorted ? row : firstRow, count: sorted ? 1 : rows })
        }
      >
        Delete {many(rows, 'this row', 'rows')}
      </button>
      <div className="my-1 border-t border-ash/70" />
      <button
        type="button"
        role="menuitem"
        className={menuItem}
        onClick={() => onStructure({ kind: 'insertColumns', at: column, count: 1 })}
      >
        Insert a column to the left
      </button>
      <button
        type="button"
        role="menuitem"
        className={menuDanger}
        onClick={() => onStructure({ kind: 'deleteColumns', at: firstColumn, count: columns })}
      >
        Delete {many(columns, 'this column', 'columns')}
      </button>
    </div>
  )
}

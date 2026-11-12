import { describe, expect, it } from 'vitest'
import {
  columnName,
  fitColumns,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  normalizeCells,
  parseA1,
  parseCsv,
  parseTableFile,
  plainText,
  safeCsvValue,
  shiftFormula,
  TableFormatError,
  type TableFrontmatter,
  tableFile,
  tablePathId,
  tableProblem,
  writeCsv,
} from './tables.js'

const ID = '01JD0000000000000000000000'

describe('CSV', () => {
  it('reads quotes, doubled quotes, commas and newlines in cells, CRLF and a BOM', () => {
    const text = '﻿Name,Note\r\n"Smith, J","said ""hi""\nthen left"\r\nB,\n'
    expect(parseCsv(text)).toEqual([
      ['Name', 'Note'],
      ['Smith, J', 'said "hi"\nthen left'],
      ['B', ''],
    ])
  })

  it('round-trips through writeCsv', () => {
    const rows = [
      ['a', 'b,c', 'd"e'],
      ['line\nbreak', ' padded ', '=SUM(A1:A2)'],
      ['', '', ''],
    ]
    expect(parseCsv(writeCsv(rows))).toEqual(rows)
  })

  it('quotes only when needed, with LF between rows', () => {
    expect(
      writeCsv([
        ['a', 'b c'],
        ['x,y', '1'],
      ]),
    ).toBe('a,b c\n"x,y",1')
  })

  it('guards values a spreadsheet would run', () => {
    expect(safeCsvValue('=1+1')).toBe("'=1+1")
    expect(safeCsvValue('@x')).toBe("'@x")
    expect(safeCsvValue('-3')).toBe("'-3")
    expect(safeCsvValue('plain')).toBe('plain')
  })
})

describe('shape', () => {
  it('pads rows and drops trailing empty rows and columns', () => {
    expect(normalizeCells([['a', 'b', ''], ['c'], ['', '', '']])).toEqual([
      ['a', 'b'],
      ['c', ''],
    ])
    expect(normalizeCells([])).toEqual([['']])
  })

  it('fits columns to a width', () => {
    expect(fitColumns([{ type: 'number' }], 3)).toEqual([
      { type: 'number' },
      { type: 'text' },
      { type: 'text' },
    ])
    expect(fitColumns([{ type: 'number' }, { type: 'date' }], 1)).toEqual([{ type: 'number' }])
  })

  it('refuses too many rows, columns, long cells and repeated options', () => {
    expect(tableProblem([], [['a']])).toBeNull()
    const rows = Array.from({ length: MAX_TABLE_ROWS + 1 }, () => ['x'])
    expect(tableProblem([], rows)).toMatch(/rows at most/)
    expect(tableProblem([], [Array.from({ length: MAX_TABLE_COLUMNS + 1 }, () => 'x')])).toMatch(
      /columns at most/,
    )
    expect(tableProblem([], [['x'.repeat(10_001)]])).toMatch(/too long/)
    expect(tableProblem([{ type: 'choice', options: ['A', 'a'] }], [['x']])).toMatch(/option twice/)
  })
})

describe('the table file', () => {
  const fm: TableFrontmatter = {
    id: ID,
    type: 'table',
    title: 'Vendors',
    columns: [{ type: 'text' }, { type: 'number' }],
    keep_me: 'yes',
  }

  it('round-trips frontmatter (unknown keys kept) and cells', () => {
    const cells = [
      ['Name', 'Price'],
      ['Acme, Inc', '12'],
      ['Total', '=SUM(B2:B2)'],
    ]
    const file = tableFile(fm, cells)
    expect(file).toContain('```csv\nName,Price\n"Acme, Inc",12\nTotal,=SUM(B2:B2)\n```\n')
    const back = parseTableFile(file)
    expect(back.cells).toEqual(cells)
    expect(back.fm.title).toBe('Vendors')
    expect(back.fm.keep_me).toBe('yes')
    expect(back.fm.columns).toEqual([{ type: 'text' }, { type: 'number' }])
  })

  it('uses a longer fence when a cell holds backticks', () => {
    const cells = [['code'], ['```\nnot the end']]
    const file = tableFile(fm, cells)
    expect(file).toContain('````csv')
    expect(parseTableFile(file).cells).toEqual(cells)
  })

  it('treats an unknown column type as text, and a missing block as one empty cell', () => {
    const file = `---\nid: ${ID}\ntype: table\ntitle: T\ncolumns:\n  - type: wobbly\n---\n`
    const back = parseTableFile(file)
    expect(back.fm.columns).toEqual([{ type: 'text' }])
    expect(back.cells).toEqual([['']])
  })

  it('throws on a file that is not a table', () => {
    expect(() => parseTableFile('---\ntype: form\n---\n')).toThrow(TableFormatError)
  })
})

describe('paths and addresses', () => {
  it('knows a table path', () => {
    expect(tablePathId(`tables/${ID}.md`)).toBe(ID)
    expect(tablePathId(`tables/x/${ID}.md`)).toBeNull()
    expect(tablePathId('docs/a.md')).toBeNull()
  })

  it('names columns and reads A1 addresses', () => {
    expect([0, 25, 26, 51].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ'])
    expect(parseA1('B3')).toEqual({ row: 2, column: 1 })
    expect(parseA1('$AA$10')).toEqual({ row: 9, column: 26 })
    expect(parseA1('A0')).toBeNull()
    expect(parseA1('B')).toBeNull()
  })
})

describe('formulas', () => {
  it('moves only relative references in a copied formula', () => {
    expect(shiftFormula('SUM(A1:B2)+$C$1+LOG10(A1)&"A1"', 1, 1)).toBe(
      'SUM(B2:C3)+$C$1+LOG10(B2)&"A1"',
    )
    expect(shiftFormula('A1', -1, 0)).toBe('#REF!')
  })

  it('shows a plain cell without its leading apostrophe', () => {
    expect(plainText("'=x")).toBe('=x')
    expect(plainText('007')).toBe('007')
  })
})

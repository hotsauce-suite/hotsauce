import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { evaluateCells } from './engine.js'
import { readXlsx, writeXlsx, XlsxError } from './xlsx.js'

describe('formulas on the server', () => {
  it('works out formulas and shows errors', () => {
    const cells = [
      ['Item', 'Price', 'Qty', 'Total'],
      ['Tips', '3', '4', '=B2*C2'],
      ['Gloves', '2.5', '10', '=B3*C3'],
      ['', '', '', '=SUM(D2:D3)'],
      ['Bad', '', '', '=1/0'],
    ]
    const values = evaluateCells(cells)
    expect(values[1]?.[3]).toBe('12')
    expect(values[3]?.[3]).toBe('37')
    expect(values[4]?.[3]).toBe('#DIV/0!')
    expect(values[0]?.[0]).toBe('Item')
  })
})

describe('.xlsx', () => {
  it('round-trips text, numbers, dates and formulas', () => {
    const cells = [
      ['Name', 'When', 'Cost', 'Double'],
      ['A & <B>', '2026-11-12', '1.5', '=C2*2'],
      ['"quoted"', '', '-3', '=CONCAT(A2,"!")'],
    ]
    const bytes = writeXlsx('Vendors / 2026', cells, evaluateCells(cells))
    const parts = unzipSync(bytes)
    expect(strFromU8(parts['xl/workbook.xml'] as Uint8Array)).toContain('name="Vendors   2026"')
    expect(strFromU8(parts['xl/worksheets/sheet1.xml'] as Uint8Array)).toContain(
      '<c r="D2"><f>C2*2</f><v>3</v></c>',
    )
    expect(readXlsx(bytes)).toEqual(cells)
  })

  it('reads shared strings, booleans and shared formulas from another writer', () => {
    const sheet = `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2"><v>1</v></c><c r="B2"><f t="shared" ref="B2:B3" si="0">A2*$A$2+1</f><v>2</v></c><c r="C2" t="b"><v>1</v></c></row>
      <row r="3"><c r="A3"><v>2</v></c><c r="B3"><f t="shared" si="0"/><v>3</v></c><c r="D3" s="1"><v>46338</v></c></row>
    </sheetData></worksheet>`
    const files = {
      'xl/workbook.xml':
        '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId7"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<Relationships><Relationship Id="rId7" Type="x" Target="worksheets/data.xml"/></Relationships>',
      'xl/worksheets/data.xml': sheet,
      'xl/sharedStrings.xml':
        '<sst><si><t>n</t></si><si><r><t>tw</t></r><r><t xml:space="preserve">o</t></r><rPh><t>x</t></rPh></si></sst>',
      'xl/styles.xml':
        '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
    }
    const bytes = zipSync(
      Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])),
    )
    expect(readXlsx(bytes)).toEqual([
      ['n', 'two', '', ''],
      ['1', '=A2*$A$2+1', 'TRUE', ''],
      ['2', '=A3*$A$2+1', '', '2026-11-12'],
    ])
  })

  it('reads a hostile sheet of unclosed cells quickly', () => {
    const sheet = `<worksheet><sheetData>${'<c r="A1">'.repeat(200_000)}<si>${'<t>'.repeat(50_000)}</sheetData></worksheet>`
    const bytes = zipSync({
      'xl/worksheets/sheet1.xml': strToU8(sheet),
      'xl/sharedStrings.xml': strToU8(`<sst>${'<si>'.repeat(200_000)}</sst>`),
    })
    const t0 = Date.now()
    expect(readXlsx(bytes)).toEqual([['']])
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('refuses a file that is not a workbook', () => {
    expect(() => readXlsx(strToU8('hello'))).toThrow(XlsxError)
  })
})

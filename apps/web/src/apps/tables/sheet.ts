// The grid's cells and their values (ARCHITECTURE §22.8). The cells as typed are the truth (what
// gets saved, so `007` stays `007`); IronCalc (MIT OR Apache-2.0) mirrors them to work out
// formulas, and rewrites formulas when rows or columns are added or removed.

import { plainText } from '@hearth/format'
import init, { Model } from '@ironcalc/wasm'

let ready: Promise<unknown> | null = null

/** Loads IronCalc's WebAssembly once (about 2 MB; only Tables pages ask for it). */
export function loadEngine(): Promise<unknown> {
  ready ??= init()
  return ready
}

export const isFormula = (input: string) => input.startsWith('=') && input.length > 1

export class Sheet {
  #model: Model
  #cells: string[][]

  /** Call `loadEngine()` first. */
  constructor(cells: readonly (readonly string[])[]) {
    this.#cells = cells.map((r) => [...r])
    this.#model = Sheet.#build(this.#cells)
  }

  static #build(cells: readonly (readonly string[])[]): Model {
    const model = new Model('table', 'en', 'UTC', 'en')
    model.pauseEvaluation()
    for (const [r, row] of cells.entries()) {
      for (const [c, input] of row.entries()) {
        if (input !== '') model.setUserInput(0, r + 1, c + 1, input)
      }
    }
    model.resumeEvaluation()
    model.evaluate()
    return model
  }

  get rows(): number {
    return this.#cells.length
  }

  get width(): number {
    return Math.max(0, ...this.#cells.map((r) => r.length))
  }

  /** What was typed in a cell. */
  input(row: number, column: number): string {
    return this.#cells[row]?.[column] ?? ''
  }

  /** What a cell shows: a formula's result, else the cell as typed (without a leading `'`). */
  value(row: number, column: number): string {
    const input = this.input(row, column)
    if (!isFormula(input)) return plainText(input)
    return this.#model.getFormattedCellValue(0, row + 1, column + 1)
  }

  /** Sets cells and works the formulas out once. */
  set(changes: ReadonlyArray<{ row: number; column: number; input: string }>): void {
    if (changes.length === 0) return
    this.#model.pauseEvaluation()
    for (const { row, column, input } of changes) {
      while (this.#cells.length <= row) this.#cells.push([])
      const line = this.#cells[row] as string[]
      while (line.length <= column) line.push('')
      line[column] = input
      // Clearing first drops a style a previous value left (typing $5 then 7 would show $7.00).
      this.#model.rangeClearAll(0, row + 1, column + 1, row + 1, column + 1)
      if (input !== '') this.#model.setUserInput(0, row + 1, column + 1, input)
    }
    this.#model.resumeEvaluation()
    this.#model.evaluate()
  }

  insertRows(at: number, count: number): void {
    this.#model.insertRows(0, at + 1, count)
    this.#cells.splice(at, 0, ...Array.from({ length: count }, () => [] as string[]))
    this.#refreshFormulas()
  }

  deleteRows(at: number, count: number): void {
    this.#model.deleteRows(0, at + 1, count)
    this.#cells.splice(at, count)
    if (this.#cells.length === 0) this.#cells.push([''])
    this.#refreshFormulas()
  }

  insertColumns(at: number, count: number): void {
    this.#model.insertColumns(0, at + 1, count)
    for (const row of this.#cells) {
      if (row.length > at) row.splice(at, 0, ...Array.from({ length: count }, () => ''))
    }
    this.#refreshFormulas()
  }

  deleteColumns(at: number, count: number): void {
    this.#model.deleteColumns(0, at + 1, count)
    for (const row of this.#cells) row.splice(at, count)
    this.#refreshFormulas()
  }

  /** The cells to save: every row as wide as the widest. */
  snapshot(): string[][] {
    const width = Math.max(1, this.width)
    return this.#cells.map((r) => Array.from({ length: width }, (_, c) => r[c] ?? ''))
  }

  /** Back to an earlier snapshot (undo and redo). */
  restore(cells: readonly (readonly string[])[]): void {
    this.#model.free()
    this.#cells = cells.map((r) => [...r])
    this.#model = Sheet.#build(this.#cells)
  }

  dispose(): void {
    this.#model.free()
  }

  /** After rows or columns move, formulas are what IronCalc rewrote them to. */
  #refreshFormulas(): void {
    for (const [r, row] of this.#cells.entries()) {
      for (const [c, input] of row.entries()) {
        if (isFormula(input)) row[c] = this.#model.getCellContent(0, r + 1, c + 1)
      }
    }
    this.#model.evaluate()
  }
}

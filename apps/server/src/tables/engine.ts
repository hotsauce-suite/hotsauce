// Formulas on the server: IronCalc (MIT OR Apache-2.0, https://github.com/ironcalc/IronCalc),
// the same engine the grid runs in the browser, so MCP reads and exports see the values the
// grid shows. Loaded once, on first use.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { plainText } from '@hearth/format'
import { initSync, Model } from '@ironcalc/wasm'

let ready = false

function load() {
  if (ready) return
  const require = createRequire(import.meta.url)
  const wasm = readFileSync(require.resolve('@ironcalc/wasm/wasm_bg.wasm'))
  initSync({ module: wasm })
  ready = true
}

const isFormula = (input: string) => input.startsWith('=') && input.length > 1

/**
 * What each cell shows: a formula's result (or its error, such as `#DIV/0!`), else the cell as
 * typed (so `007` and `$12.50` stay as written; formulas still read them as numbers). `cells` are
 * raw inputs, row 1 first.
 */
export function evaluateCells(cells: readonly (readonly string[])[]): string[][] {
  load()
  const model = new Model('table', 'en', 'UTC', 'en')
  try {
    model.pauseEvaluation()
    for (const [r, row] of cells.entries()) {
      for (const [c, input] of row.entries()) {
        if (input !== '') model.setUserInput(0, r + 1, c + 1, input)
      }
    }
    model.resumeEvaluation()
    model.evaluate()
    return cells.map((row, r) =>
      row.map((input, c) =>
        isFormula(input) ? model.getFormattedCellValue(0, r + 1, c + 1) : plainText(input),
      ),
    )
  } finally {
    model.free()
  }
}

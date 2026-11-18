import {
  CONTRAST_PAIRS,
  contrast,
  fixContrast,
  THEME_COLOR_KEYS,
  type Theme,
} from '@hotsauce/format'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

// docs/PLAN-ai-themes.md R4: whatever palette the AI answers with, the fixed theme reads.
const hex = fc.integer({ min: 0, max: 0xffffff }).map((n) => `#${n.toString(16).padStart(6, '0')}`)

const theme: fc.Arbitrary<Theme> = fc.record({
  name: fc.constant('Any'),
  scheme: fc.constantFrom('light' as const, 'dark' as const),
  colors: fc.record(
    Object.fromEntries(THEME_COLOR_KEYS.map((k) => [k, hex])) as Record<
      (typeof THEME_COLOR_KEYS)[number],
      fc.Arbitrary<string>
    >,
  ),
  fonts: fc.constant({ display: 'Inter', ui: 'Inter' }),
})

describe('fixContrast', () => {
  it('makes every pair readable for any palette', () => {
    fc.assert(
      fc.property(theme, (t) => {
        const fixed = fixContrast(t)
        for (const pair of CONTRAST_PAIRS) {
          for (const bg of pair.on) {
            expect(contrast(fixed.colors[pair.fg], fixed.colors[bg])).toBeGreaterThanOrEqual(
              pair.ratio - 1e-9,
            )
          }
        }
      }),
      { numRuns: 400 },
    )
  })
})

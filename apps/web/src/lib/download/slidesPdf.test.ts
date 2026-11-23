import { deckMarkdown, splitSlides } from '@hotsauce/format'
import { describe, expect, it } from 'vitest'
import type { DownloadInputs } from './inputs'
import { docModel } from './model'
import { pdfDefinition } from './toPdf'

const inputs: DownloadInputs = {
  brand: {
    orgName: 'Acme',
    primary: '#c63d19',
    displayFont: 'Fraunces',
    uiFont: 'Inter',
    logo: null,
  },
  fonts: { ui: {}, display: {} },
  images: new Map(),
  tasks: new Map(),
} as unknown as DownloadInputs

const DECK = `# Launch\n\n---\n\n## Why\n\n- fast\n\nNotes: say the secret part\n\n---\n\n## How\n`

describe('slides as a PDF (docs/PLAN-slides.md R10)', () => {
  const model = docModel(deckMarkdown(splitSlides(DECK)), 'Launch', (h) => h)
  const def = pdfDefinition(model, inputs, { ui: 'Helvetica', display: 'Times' }, 'slides')

  it('puts each slide on its own 16:9 page', () => {
    expect(def.pageSize).toEqual({ width: 792, height: 445.5 })
    const breaks = def.content.filter(
      (c) => typeof c === 'object' && !Array.isArray(c) && c.pageBreak === 'after',
    )
    expect(breaks).toHaveLength(2)
  })

  it('leaves the speaker notes out', () => {
    expect(JSON.stringify(def.content)).not.toContain('secret')
    expect(JSON.stringify(def.content)).toContain('Why')
  })

  it('sets the type larger than a document’s', () => {
    const doc = pdfDefinition(model, inputs, { ui: 'Helvetica', display: 'Times' })
    expect(def.defaultStyle.fontSize).toBeGreaterThan(doc.defaultStyle.fontSize as number)
  })
})

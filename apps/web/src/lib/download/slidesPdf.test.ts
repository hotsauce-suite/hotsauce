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
  const slides = splitSlides(DECK)
  const model = {
    ...docModel(deckMarkdown(slides), 'Launch', (h) => h),
    slides: slides.map((s) => docModel(s.body, 'Launch', (h) => h).blocks),
  }
  const def = pdfDefinition(model, inputs, { ui: 'Helvetica', display: 'Times' }, 'slides')

  it('puts each slide on its own 16:9 page', () => {
    expect(def.pageSize).toEqual({ width: 792, height: 445.5 })
    const pages = def.content as { stack: unknown[]; pageBreak?: string }[]
    expect(pages).toHaveLength(3)
    expect(pages.map((p) => p.pageBreak)).toEqual([undefined, 'before', 'before'])
  })

  it('keeps a rule inside a slide on that slide’s page', () => {
    const inner = `## A\n\none\n\n***\n\ntwo\n\n---\n\n## B\n`
    const parts = splitSlides(inner)
    const deck = {
      ...docModel(deckMarkdown(parts), 'A', (h) => h),
      slides: parts.map((s) => docModel(s.body, 'A', (h) => h).blocks),
    }
    const pages = pdfDefinition(deck, inputs, { ui: 'Helvetica', display: 'Times' }, 'slides')
      .content as unknown[]
    expect(pages).toHaveLength(2)
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

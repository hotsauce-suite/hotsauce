import { describe, expect, it } from 'vitest'
import { looksLikePdf, type PdfLine, pdfLinesToMarkdown, readPdf } from './pdf.js'
import { makeTestPdf } from './test-pdf.js'

// A PDF's readable copy (docs/PLAN-links-pdfs.md R3).

/** Lines down a page, 14 units apart, at size 10 unless given. */
function page(lines: Array<string | (Partial<PdfLine> & { text: string })>): PdfLine[] {
  let y = 800
  return lines.map((l) => {
    const line = typeof l === 'string' ? { text: l } : l
    y -= 14 + ((line as { gap?: number }).gap ?? 0)
    return { x: 72, size: 10, y, ...line }
  })
}

describe('pdfLinesToMarkdown', () => {
  it('rejoins lines into paragraphs where the gap grows, mending split words', () => {
    const md = pdfLinesToMarkdown([
      page([
        'The first paragraph runs over two lines and its last word is a trans-',
        'lation of the next.',
        { text: 'A second paragraph starts after a gap.', y: 740 },
      ]),
    ])
    expect(md).toBe(
      'The first paragraph runs over two lines and its last word is a translation of the next.\n\nA second paragraph starts after a gap.',
    )
  })

  it('makes headings of bigger lines, numbered sections and the usual section names', () => {
    const md = pdfLinesToMarkdown([
      page([
        { text: 'A Big Title', size: 18 },
        'Abstract',
        'Words of the abstract.',
        '2.1 Results That Matter',
        'Words of the results.',
      ]),
    ])
    expect(md.split('\n\n')).toEqual([
      '## A Big Title',
      '## Abstract',
      'Words of the abstract.',
      '## 2.1 Results That Matter',
      'Words of the results.',
    ])
  })

  it('drops page numbers and running heads', () => {
    const pages = [1, 2, 3, 4].map((n) =>
      page(['Journal of Tests, vol. 3', `Body text of page ${n}.`, String(n)]),
    )
    const md = pdfLinesToMarkdown(pages)
    expect(md).not.toContain('Journal of Tests')
    expect(md).not.toMatch(/^\d$/m)
    expect(md).toContain('Body text of page 4.')
  })

  it('shows Markdown’s own characters as text', () => {
    const md = pdfLinesToMarkdown([
      page(['1. Not a list *or emphasis* [or a link](x) <b>, really.']),
    ])
    expect(md).toBe('1\\. Not a list \\*or emphasis\\* \\[or a link\\](x) \\<b\\>, really.')
  })

  it('keeps a paragraph going across a page break unless its sentence ended', () => {
    const md = pdfLinesToMarkdown([
      page(['A sentence that carries on']),
      page(['onto the next page.', { text: 'New one.', gap: 20 }]),
    ])
    expect(md).toBe('A sentence that carries on onto the next page.\n\nNew one.')
  })
})

describe('readPdf', () => {
  it('reads a real PDF’s title and text', async () => {
    const bytes = makeTestPdf(
      [[{ text: 'On Mirrors', size: 18 }, { text: 'Abstract', gap: 12 }, 'Mirror life is a risk.']],
      'On Mirrors',
    )
    expect(looksLikePdf(bytes)).toBe(true)
    const pdf = await readPdf(bytes)
    expect(pdf).toMatchObject({ title: 'On Mirrors', pages: 1, words: 8 })
    expect(pdf.markdown).toBe('## On Mirrors\n\n## Abstract\n\nMirror life is a risk.')
  })

  it('gives a scanned PDF an empty copy, and the biggest line as a title when it has none', async () => {
    expect(await readPdf(makeTestPdf([[]]))).toMatchObject({ markdown: '', words: 0, title: '' })
    const untitled = await readPdf(makeTestPdf([[{ text: 'Big Words Here', size: 20 }, 'small']]))
    expect(untitled.title).toBe('Big Words Here')
  })

  it('throws on bytes that aren’t a PDF', async () => {
    const junk = new TextEncoder().encode('%PDF-1.4 but nothing else')
    expect(looksLikePdf(new TextEncoder().encode('<html>'))).toBe(false)
    await expect(readPdf(junk)).rejects.toThrow()
  })
})

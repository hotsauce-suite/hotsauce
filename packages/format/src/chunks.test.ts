import { describe, expect, it } from 'vitest'
import { type Chunk, chunkMarkdown } from './chunks.js'

const exact = (text: string, chunks: Chunk[]) => {
  for (const chunk of chunks) expect(text.slice(chunk.from, chunk.to)).toBe(chunk.text)
}

describe('chunkMarkdown', () => {
  it('makes one chunk per heading section with its heading path', () => {
    const text = `Intro line.

# Plan

Top.

## Goals

Grow.

### Revenue

Up.

## Risks

Few.

# Appendix
`
    const chunks = chunkMarkdown(text)
    expect(chunks.map((c) => [c.heading, c.text])).toEqual([
      [null, 'Intro line.'],
      ['Plan', '# Plan\n\nTop.'],
      ['Plan > Goals', '## Goals\n\nGrow.'],
      ['Plan > Goals > Revenue', '### Revenue\n\nUp.'],
      ['Plan > Risks', '## Risks\n\nFew.'],
      ['Appendix', '# Appendix'],
    ])
    exact(text, chunks)
  })

  it('handles a deeper heading before a shallower one', () => {
    const chunks = chunkMarkdown('### Deep\n\na\n\n## Mid\n\nb\n')
    expect(chunks.map((c) => c.heading)).toEqual(['Deep', 'Mid'])
  })

  it('skips frontmatter and headings inside fenced code', () => {
    const text = '---\ntitle: x\n# yaml comment\n---\n# Real\n\n```sh\n# comment\necho hi\n```\n'
    const chunks = chunkMarkdown(text)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.heading).toBe('Real')
    expect(chunks[0]?.text).toBe('# Real\n\n```sh\n# comment\necho hi\n```')
    exact(text, chunks)
  })

  it('splits long sections at paragraph breaks, keeping the heading', () => {
    const paragraph = 'word '.repeat(15).trim()
    const text = `# Long\n\n${Array.from({ length: 6 }, () => paragraph).join('\n\n')}\n`
    const chunks = chunkMarkdown(text, 200)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.heading).toBe('Long')
      expect(chunk.text.length).toBeLessThanOrEqual(200)
      expect(chunk.text.startsWith('word') || chunk.text.startsWith('# Long')).toBe(true)
      expect(chunk.text.endsWith('word')).toBe(true)
    }
    exact(text, chunks)
  })

  it('falls back to line breaks, then spaces, then a hard cut', () => {
    const lines = 'line one\nline two\nline three\n'
    expect(chunkMarkdown(lines, 12).map((c) => c.text)).toEqual([
      'line one',
      'line two',
      'line three',
    ])
    expect(chunkMarkdown('alpha beta gamma', 11).map((c) => c.text)).toEqual([
      'alpha beta',
      'gamma',
    ])
    expect(chunkMarkdown('abcdefghij', 4).map((c) => c.text)).toEqual(['abcd', 'efgh', 'ij'])
  })

  it('never splits an emoji', () => {
    const text = '😀😀😀'
    const chunks = chunkMarkdown(text, 3)
    expect(chunks.map((c) => c.text).join('')).toBe(text)
    for (const chunk of chunks) expect(chunk.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/)
  })

  it('returns nothing for empty or whitespace-only text', () => {
    expect(chunkMarkdown('')).toEqual([])
    expect(chunkMarkdown('  \n\n\t\n')).toEqual([])
    expect(chunkMarkdown('---\ntitle: x\n---\n')).toEqual([])
  })

  it('handles CRLF', () => {
    const text = '# A\r\n\r\nOne.\r\n\r\n# B\r\n\r\nTwo.\r\n'
    const chunks = chunkMarkdown(text)
    expect(chunks.map((c) => [c.heading, c.text])).toEqual([
      ['A', '# A\r\n\r\nOne.'],
      ['B', '# B\r\n\r\nTwo.'],
    ])
    // The first 21 characters end with the CRLF blank line after the x's.
    expect(
      chunkMarkdown(`# A\r\n\r\n${'x'.repeat(10)}\r\n\r\n${'y'.repeat(10)}\r\n`, 21).map(
        (c) => c.text,
      ),
    ).toEqual(['# A\r\n\r\nxxxxxxxxxx', 'yyyyyyyyyy'])
  })

  it('rejects a size limit below one', () => {
    expect(() => chunkMarkdown('text', 0)).toThrow(RangeError)
    expect(() => chunkMarkdown('text', Number.NaN)).toThrow(RangeError)
  })
})

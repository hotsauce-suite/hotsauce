import { describe, expect, it } from 'vitest'
import { deckMarkdown, splitSlides } from './slides.js'

const bodies = (text: string) => splitSlides(text).map((s) => s.body)

describe('splitSlides', () => {
  it('splits at a line that is only --- (R1)', () => {
    expect(bodies('# One\n\nHi\n\n---\n\n## Two\n\n---\n## Three\n')).toEqual([
      '# One\n\nHi',
      '## Two',
      '## Three',
    ])
  })

  it('never splits inside a code block or at the frontmatter fences (R1)', () => {
    const text = '---\ntitle: Deck\n---\n# One\n\n```yaml\n---\na: 1\n```\n\n---\n\nTwo\n'
    expect(bodies(text)).toEqual(['# One\n\n```yaml\n---\na: 1\n```', 'Two'])
  })

  it('keeps tilde fences and longer fences closed only by their own kind (R1)', () => {
    const text = '~~~~\n```\n---\n~~~~\n\n---\nB\n'
    expect(bodies(text)).toEqual(['~~~~\n```\n---\n~~~~', 'B'])
  })

  it('drops empty slides, so a trailing --- adds nothing (R1)', () => {
    expect(bodies('A\n\n---\n\n---\n\nB\n\n---\n')).toEqual(['A', 'B'])
  })

  it('splits at ## headings when the doc has no --- (R2)', () => {
    expect(bodies('# Title\n\nIntro\n\n## First\n\nx\n\n### Sub\n\n## Second\n')).toEqual([
      '# Title\n\nIntro',
      '## First\n\nx\n\n### Sub',
      '## Second',
    ])
  })

  it('does not split at a ## inside a code block (R2)', () => {
    expect(bodies('## A\n\n```md\n## not a slide\n```\n')).toEqual([
      '## A\n\n```md\n## not a slide\n```',
    ])
  })

  it('is one slide with neither, and none for an empty doc (R2)', () => {
    expect(bodies('Just text.\n\nMore.')).toEqual(['Just text.\n\nMore.'])
    expect(splitSlides('---\ntitle: x\n---\n\n')).toEqual([])
  })

  it('takes everything from a Notes: line as the notes (R3)', () => {
    const [slide] = splitSlides('## Hi\n\n- point\n\nNotes: say hello\nand smile\n')
    expect(slide).toEqual({ body: '## Hi\n\n- point', notes: 'say hello\nand smile' })
  })

  it('reads notes: in any case, but not Note: or inside code (R3)', () => {
    expect(splitSlides('A\n\nnotes:\nquiet')[0]?.notes).toBe('quiet')
    expect(splitSlides('## A\n\nNote: prices exclude VAT.')[0]).toEqual({
      body: '## A\n\nNote: prices exclude VAT.',
      notes: '',
    })
    expect(splitSlides('```\nNotes: code\n```')[0]?.notes).toBe('')
  })

  it('keeps a hard line break (two trailing spaces)', () => {
    expect(splitSlides('line one  \nline two')[0]?.body).toBe('line one  \nline two')
  })

  it('--- right under a paragraph line underlines a heading, it does not split (R1)', () => {
    expect(splitSlides('Intro\n\nGoals\n---\n- a')).toEqual([
      { body: 'Intro\n\nGoals\n---\n- a', notes: '' },
    ])
    // After a list item or a blank line it still splits.
    expect(splitSlides('- a\n---\nB').map((s) => s.body)).toEqual(['- a', 'B'])
  })

  it('a slide with only notes is kept, so its notes are not lost (R3)', () => {
    expect(splitSlides('A\n\n---\n\nNotes: only notes')).toEqual([
      { body: 'A', notes: '' },
      { body: '', notes: 'only notes' },
    ])
  })

  it('never loses text: every line lands in a body or notes (all short mixes)', () => {
    const pieces = ['---', '## H', '```', 'Notes: n', '', 'text', '~~~', '# T']
    // Every 4-line doc made of the pieces above: 8^4 docs.
    const docs: string[][] = [[]]
    for (let depth = 0; depth < 4; depth++) {
      for (const d of docs.splice(0)) for (const p of pieces) docs.push([...d, p])
    }
    for (const lines of docs) {
      // A first line of --- opens frontmatter, which is never a slide.
      if (lines[0] === '---') continue
      const out = splitSlides(lines.join('\n'))
        .flatMap((s) => [s.body, s.notes])
        .join('\n')
      for (const l of lines) {
        if (l === '' || l === '---' || l.startsWith('Notes:')) continue
        expect(out).toContain(l)
      }
      if (lines.includes('Notes: n')) expect(out).toContain('n')
    }
  })
})

describe('deckMarkdown', () => {
  it('joins the slides with --- and leaves the notes out', () => {
    expect(deckMarkdown(splitSlides('## A\n\nNotes: secret\n\n## B\n'))).toBe(
      '## A\n\n---\n\n## B\n',
    )
  })
})

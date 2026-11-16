import { describe, expect, it } from 'vitest'
import { parseFrontmatter, patchFrontmatter } from './frontmatter.js'
import {
  addHighlight,
  findQuote,
  HighlightError,
  highlightsDoc,
  highlightsOf,
  highlightsSearchText,
  inPageOrder,
  MAX_HIGHLIGHTS,
  removeHighlight,
  setHighlightNote,
} from './link-highlights.js'

const AT = '2026-11-16T10:00:00Z'
const ME = 'ada@example.com'

describe('highlights in a link file (R1)', () => {
  it('adds, notes and removes, round-tripping through the frontmatter', () => {
    let text = patchFrontmatter('\nThe page.\n', { id: 'L1', type: 'link', url: 'https://x.y' })
    const added = addHighlight(parseFrontmatter(text).data, {
      quote: '  the  quick\nbrown fox ',
      prefix: 'and then ',
      suffix: ' jumped',
      block: 2,
      note: 'Nice line',
      by: 'Ada@Example.com',
      at: AT,
    })
    text = patchFrontmatter(text, { highlights: added.highlights })
    const [h] = highlightsOf(parseFrontmatter(text).data)
    expect(h).toMatchObject({
      by: ME,
      quote: 'the quick brown fox',
      prefix: 'and then ',
      suffix: ' jumped',
      block: 2,
      note: 'Nice line',
    })
    expect(parseFrontmatter(text).body).toBe('\nThe page.\n')

    const noted = setHighlightNote(parseFrontmatter(text).data, h?.id ?? '', ME, '', AT)
    text = patchFrontmatter(text, { highlights: noted.highlights })
    expect(highlightsOf(parseFrontmatter(text).data)[0]?.note).toBeUndefined()
    expect(highlightsOf(parseFrontmatter(text).data)[0]?.edited).toBe(AT)

    text = patchFrontmatter(text, {
      highlights: removeHighlight(parseFrontmatter(text).data, h?.id ?? '', ME),
    })
    expect(parseFrontmatter(text).data.highlights).toBeUndefined()
  })

  it('keeps entries it cannot read, and ignores them', () => {
    const data = { highlights: [{ odd: true }, 'text', { id: 'H', by: ME, at: AT, quote: 'q' }] }
    expect(highlightsOf(data).map((h) => h.id)).toEqual(['H'])
    const { highlights } = addHighlight(data, { quote: 'more', by: ME, at: AT })
    expect(highlights).toHaveLength(4)
    expect(highlights[0]).toEqual({ odd: true })
  })

  it('refuses a passage that is too long rather than cutting it', () => {
    expect(() => addHighlight({}, { quote: 'x'.repeat(2001), by: ME, at: AT })).toThrow(/up to/)
  })

  it('refuses an empty passage and the one past the limit', () => {
    expect(() => addHighlight({}, { quote: '  ', by: ME, at: AT })).toThrow(HighlightError)
    const full = { highlights: Array.from({ length: MAX_HIGHLIGHTS }, (_, i) => ({ id: `${i}` })) }
    expect(() => addHighlight(full, { quote: 'x', by: ME, at: AT })).toThrow(/at most/)
  })

  it('only the person who made it can change or delete it (R3)', () => {
    const { highlights } = addHighlight({}, { quote: 'x', by: ME, at: AT, id: 'H1' })
    const data = { highlights }
    expect(() => setHighlightNote(data, 'H1', 'bob@example.com', 'n', AT)).toThrow(/Only/)
    expect(() => removeHighlight(data, 'H1', 'bob@example.com')).toThrow(/Only/)
    expect(() => removeHighlight(data, 'nope', ME)).toThrow(/isn’t there/)
    expect(removeHighlight(data, 'H1', 'ADA@example.com')).toBeUndefined()
  })
})

describe('search text and page order', () => {
  it('reads passages and notes', () => {
    const hs = highlightsOf({
      highlights: [
        { id: 'a', by: ME, at: AT, quote: 'one', note: 'first' },
        { id: 'b', by: ME, at: AT, quote: 'two' },
      ],
    })
    expect(highlightsSearchText(hs)).toBe('one\nfirst\ntwo')
  })

  it('orders by block, then time', () => {
    const hs = highlightsOf({
      highlights: [
        { id: 'late', by: ME, at: '2026-01-02T00:00:00Z', quote: 'x', block: 1 },
        { id: 'none', by: ME, at: '2026-01-01T00:00:00Z', quote: 'x' },
        { id: 'early', by: ME, at: '2026-01-01T00:00:00Z', quote: 'x', block: 1 },
        { id: 'top', by: ME, at: '2026-01-03T00:00:00Z', quote: 'x', block: 0 },
      ],
    })
    expect(inPageOrder(hs).map((h) => h.id)).toEqual(['top', 'early', 'late', 'none'])
  })
})

describe('Copy highlights to a Doc (R10)', () => {
  it('quotes each passage with its note and a teammate’s name', () => {
    const hs = highlightsOf({
      highlights: [
        { id: 'b', by: 'bob@example.com', at: AT, quote: 'Their *bit*', block: 3 },
        { id: 'a', by: ME, at: AT, quote: 'My bit', block: 1, note: 'Why it matters' },
      ],
    })
    const doc = highlightsDoc({
      title: 'Big  Ideas',
      url: 'https://example.com/a',
      appUrl: 'https://app/links/team/L1',
      highlights: hs,
      me: ME,
      nameOf: () => 'Bob',
    })
    expect(doc.title).toBe('Highlights: Big Ideas')
    expect(doc.markdown).toBe(
      [
        '# Highlights: Big Ideas',
        '',
        'From [the original page](<https://example.com/a>) and [the saved copy](<https://app/links/team/L1>).',
        '',
        '> My bit',
        '',
        'Why it matters',
        '',
        '> Their \\*bit\\*',
        '>',
        '> — Bob',
        '',
      ].join('\n'),
    )
  })

  it('quotes a teammate’s note as plain text, and keeps $ signs', () => {
    const hs = highlightsOf({
      highlights: [
        {
          id: 'b',
          by: 'bob@example.com',
          at: AT,
          quote: 'q',
          note: '# Not a heading\n- costs $$10 $&',
        },
      ],
    })
    const doc = highlightsDoc({
      title: 't',
      url: 'https://x.y/a b',
      appUrl: 'https://app/l',
      highlights: hs,
      me: ME,
      nameOf: () => 'Bob',
    })
    expect(doc.markdown).toContain('\\# Not a heading')
    expect(doc.markdown).toContain('\\- costs $$10 $&')
    expect(doc.markdown).not.toContain('original page')
  })

  it('never links an address that isn’t the web', () => {
    const doc = highlightsDoc({
      title: 't',
      url: 'javascript:alert(1)',
      appUrl: 'https://app/l',
      highlights: [],
      me: ME,
      nameOf: () => '',
    })
    expect(doc.markdown).not.toContain('javascript')
  })
})

describe('finding a passage again', () => {
  it('finds it across changed white space', () => {
    const text = 'Intro.\n\nThe quick   brown\nfox jumps.'
    const at = findQuote(text, { quote: 'quick brown fox' })
    expect(at && text.slice(at.start, at.end)).toBe('quick   brown\nfox')
  })

  it('picks the copy whose surroundings match, else the nearest', () => {
    const text = 'a cat sat. the cat ran. one cat sat.'
    const ran = findQuote(text, { quote: 'cat', prefix: 'the ', suffix: ' ran' })
    expect(ran?.start).toBe(text.indexOf('cat ran'))
    const near = findQuote(text, { quote: 'cat' }, text.lastIndexOf('cat'))
    expect(near?.start).toBe(text.lastIndexOf('cat'))
  })

  it('says when the words are gone', () => {
    expect(findQuote('nothing here', { quote: 'missing' })).toBeNull()
  })

  it('always finds a passage cut from the text, at a place with the same words (property)', () => {
    let seed = 7
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    const words = ['the', 'cat', 'sat', 'on', 'a', 'mat', 'and', 'ran']
    for (let run = 0; run < 300; run++) {
      const text = Array.from(
        { length: 5 + rand(40) },
        () => `${words[rand(words.length)]}${[' ', '  ', '\n', ' \n '][rand(4)]}`,
      ).join('')
      const tokens = [...text.matchAll(/\S+/g)]
      const i = rand(tokens.length)
      const j = Math.min(tokens.length - 1, i + rand(4))
      const from = tokens[i]?.index ?? 0
      const last = tokens[j]
      const to = (last?.index ?? 0) + (last?.[0].length ?? 0)
      const quote = text.slice(from, to).replace(/\s+/g, ' ')
      const prefix = text.slice(Math.max(0, from - 32), from)
      const suffix = text.slice(to, to + 32)
      const found = findQuote(text, { quote, prefix, suffix })
      expect(found).not.toBeNull()
      expect(text.slice(found?.start, found?.end).replace(/\s+/g, ' ')).toBe(quote)
      // A passage that occurs once is found where it was cut from.
      const norm = text.replace(/\s+/g, ' ')
      if (norm.indexOf(quote) === norm.lastIndexOf(quote)) expect(found?.start).toBe(from)
    }
  })
})

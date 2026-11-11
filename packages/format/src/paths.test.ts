import { describe, expect, it } from 'vitest'
import { parseFrontmatter } from './frontmatter.js'
import { isId } from './ids.js'
import { docPath, extractTitle, newDoc, relativeLink, resolveRelative, slugify } from './paths.js'

describe('slugify', () => {
  it('lowercases and joins words with single hyphens', () => {
    expect(slugify('Q4 Plan: Revenue & Hiring!')).toBe('q4-plan-revenue-hiring')
    expect(slugify('  --Already--slugged--  ')).toBe('already-slugged')
  })

  it('strips diacritics and spells out letters that have none', () => {
    expect(slugify('Café Résumé Ñandú')).toBe('cafe-resume-nandu')
    expect(slugify('Straße Łódź Ærø')).toBe('strasse-lodz-aero')
    expect(slugify('ﬁve ①')).toBe('five-1')
  })

  it('drops scripts outside a-z and emoji', () => {
    expect(slugify('東京 meeting 🚀')).toBe('meeting')
  })

  it('falls back to "untitled" when nothing is left', () => {
    expect(slugify('')).toBe('untitled')
    expect(slugify('東京')).toBe('untitled')
    expect(slugify('!!!')).toBe('untitled')
  })

  it('caps the length at 80 without a trailing hyphen', () => {
    const slug = slugify(`${'a'.repeat(79)} bcd`)
    expect(slug).toBe('a'.repeat(79))
    expect(slugify('word '.repeat(40)).length).toBeLessThanOrEqual(80)
    expect(slugify('word '.repeat(40))).toMatch(/^[a-z0-9-]+[a-z0-9]$/)
  })
})

describe('extractTitle', () => {
  it('prefers the frontmatter title', () => {
    expect(extractTitle('---\ntitle: From YAML\n---\n# From heading\n')).toBe('From YAML')
  })

  it('falls back to the first H1, skipping lower headings and code', () => {
    const text =
      '---\ntags: [a]\n---\n## Not this\n```sh\n# not this\n```\n# The Title ##\n# Later\n'
    expect(extractTitle(text)).toBe('The Title')
  })

  it('ignores blank or non-string frontmatter titles', () => {
    expect(extractTitle('---\ntitle: "  "\n---\n# Heading\n')).toBe('Heading')
    expect(extractTitle('---\ntitle: [a]\n---\n# Heading\n')).toBe('Heading')
  })

  it('returns null when there is no title', () => {
    expect(extractTitle('Just text.\n#hashtag\n')).toBeNull()
    expect(extractTitle('')).toBeNull()
    expect(extractTitle('#\n')).toBeNull()
  })

  it('does not read a heading out of the frontmatter', () => {
    expect(extractTitle('---\n# a YAML comment\n---\nBody\n')).toBeNull()
  })
})

describe('docPath', () => {
  it('builds a path under docs/', () => {
    expect(docPath('', 'Q4 Plan')).toBe('docs/q4-plan.md')
    expect(docPath('planning/2026', 'Q4 Plan')).toBe('docs/planning/2026/q4-plan.md')
  })

  it('tolerates stray slashes in the folder', () => {
    expect(docPath('/planning/', 'Q4')).toBe('docs/planning/q4.md')
  })
})

describe('newDoc', () => {
  it('writes id, title, and created frontmatter and an H1', () => {
    const { path, text } = newDoc('Q4 plan')
    expect(path).toBe('docs/q4-plan.md')
    const { data, body } = parseFrontmatter(text)
    expect(Object.keys(data)).toEqual(['id', 'title', 'created'])
    expect(isId(String(data.id))).toBe(true)
    expect(data.title).toBe('Q4 plan')
    expect(data.created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(body).toBe('\n# Q4 plan\n\n')
    expect(text).toMatch(
      /^---\nid: [0-9A-Z]{26}\ntitle: Q4 plan\ncreated: \S+\n---\n\n# Q4 plan\n\n$/,
    )
  })

  it('quotes titles YAML would misread and keeps them on one line', () => {
    const { text } = newDoc('Plan: 2026\nDraft')
    expect(parseFrontmatter(text).data.title).toBe('Plan: 2026 Draft')
    expect(text).toContain('\n# Plan: 2026 Draft\n')
  })

  it('names a blank title "Untitled"', () => {
    expect(newDoc('   ').path).toBe('docs/untitled.md')
  })
})

describe('resolveRelative', () => {
  it('resolves against the linking file folder', () => {
    expect(resolveRelative('docs/plans/q4.md', 'goals.md')).toBe('docs/plans/goals.md')
    expect(resolveRelative('docs/plans/q4.md', './goals.md')).toBe('docs/plans/goals.md')
    expect(resolveRelative('docs/plans/q4.md', '../../assets/a.png')).toBe('assets/a.png')
    expect(resolveRelative('README.md', 'docs/a.md')).toBe('docs/a.md')
  })

  it('drops the query and fragment', () => {
    expect(resolveRelative('docs/a.md', 'b.md#goals')).toBe('docs/b.md')
    expect(resolveRelative('docs/a.md', 'b.md?plain=1#L3')).toBe('docs/b.md')
    expect(resolveRelative('docs/a.md', '#goals')).toBe('docs/a.md')
  })

  it('decodes percent-escapes', () => {
    expect(resolveRelative('docs/a.md', 'my%20notes.md')).toBe('docs/my notes.md')
    expect(resolveRelative('docs/a.md', '100%.md')).toBe('docs/100%.md')
  })

  it('treats a leading slash as the repo root', () => {
    expect(resolveRelative('docs/deep/a.md', '/assets/x.png')).toBe('assets/x.png')
  })

  it('keeps leading .. when the path climbs above the root', () => {
    expect(resolveRelative('docs/a.md', '../../outside.md')).toBe('../outside.md')
  })
})

describe('relativeLink', () => {
  it('links within, below, and above the folder', () => {
    expect(relativeLink('docs/a.md', 'docs/b.md')).toBe('b.md')
    expect(relativeLink('docs/a.md', 'docs/sub/b.md')).toBe('sub/b.md')
    expect(relativeLink('docs/x/y/a.md', 'docs/b.md')).toBe('../../b.md')
    expect(relativeLink('docs/plans/a.md', 'assets/2026/10/f.png')).toBe(
      '../../assets/2026/10/f.png',
    )
    expect(relativeLink('README.md', 'docs/a.md')).toBe('docs/a.md')
  })

  it('links a file to itself by name', () => {
    expect(relativeLink('docs/a.md', 'docs/a.md')).toBe('a.md')
  })

  it('encodes characters that would break a markdown link, and nothing else', () => {
    expect(relativeLink('docs/a.md', 'docs/my notes (v2).md')).toBe('my%20notes%20%28v2%29.md')
    expect(relativeLink('docs/a.md', 'docs/50% #1?.md')).toBe('50%25%20%231%3F.md')
    expect(relativeLink('docs/a.md', 'docs/café.md')).toBe('café.md')
  })

  it('keeps a colon in the first segment from reading as a URL scheme', () => {
    expect(relativeLink('docs/a.md', 'docs/10:30 standup.md')).toBe('./10:30%20standup.md')
  })

  it('round-trips with resolveRelative', () => {
    const pairs = [
      ['docs/a.md', 'docs/b c/d (1).md'],
      ['docs/x/y/a.md', 'assets/2026/10/img-01.png'],
      ['a.md', 'docs/50%.md'],
    ] as const
    for (const [from, to] of pairs) expect(resolveRelative(from, relativeLink(from, to))).toBe(to)
  })
})

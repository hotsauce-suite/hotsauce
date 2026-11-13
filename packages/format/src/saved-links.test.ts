import { describe, expect, it } from 'vitest'
import { parseFrontmatter } from './frontmatter.js'
import {
  cleanTags,
  findLinkUrl,
  LinkFrontmatter,
  linkBodyText,
  linkIdOf,
  linkPath,
  linkTextOf,
  linkUrlProblem,
  newLinkFile,
  normalizeLinkUrl,
  siteOf,
  wordCount,
} from './saved-links.js'

describe('saved links: files', () => {
  it('writes a new link with its address, site and who saved it', () => {
    const file = newLinkFile({
      url: 'https://www.example.com/a/b?x=1',
      title: '  A   title\n',
      savedBy: 'Ada@Example.com',
      saved: '2026-11-12T10:00:00Z',
      source: 'extension',
    })
    expect(file.path).toBe(linkPath(file.id))
    expect(linkIdOf(file.path)).toBe(file.id)
    const { data, body } = parseFrontmatter(file.text)
    const fm = LinkFrontmatter.parse(data)
    expect(fm).toMatchObject({
      type: 'link',
      url: 'https://www.example.com/a/b?x=1',
      title: 'A title',
      site: 'example.com',
      saved: '2026-11-12T10:00:00Z',
      saved_by: 'ada@example.com',
      source: 'extension',
    })
    expect(fm.tags).toBeUndefined()
    expect(fm.tags_set).toBeUndefined()
    expect(body.trim()).toBe('')
  })

  it('marks tags given at save time as the member’s own', () => {
    const file = newLinkFile({
      url: 'https://a.test/',
      tags: ['#AI', 'ai', ' Bio '],
      savedBy: 'x@y.z',
    })
    const fm = LinkFrontmatter.parse(parseFrontmatter(file.text).data)
    expect(fm.tags).toEqual(['ai', 'bio'])
    expect(fm.tags_set).toBe(true)
  })

  it('reads an unknown source as absent and keeps unknown keys', () => {
    const fm = LinkFrontmatter.parse({
      id: 'x',
      type: 'link',
      url: 'https://a.test',
      saved: 't',
      saved_by: 'a@b.c',
      source: 'carrier pigeon',
      mine: 1,
    })
    expect(fm.source).toBeUndefined()
    expect((fm as Record<string, unknown>).mine).toBe(1)
  })

  it('only takes links/<ULID>.md as a link path', () => {
    expect(linkIdOf('links/01JC0000000000000000000000.md')).toBe('01JC0000000000000000000000')
    expect(linkIdOf('links/a.md')).toBeNull()
    expect(linkIdOf('docs/links/01JC0000000000000000000000.md')).toBeNull()
  })

  it('round-trips a readable copy and caps it', () => {
    expect(linkTextOf(linkBodyText('\n\n# Hi\n\ntext  \n'))).toBe('# Hi\n\ntext')
    expect(linkBodyText('')).toBe('\n')
    expect(linkBodyText('x'.repeat(300_000)).length).toBe(200_002)
  })
})

describe('saved links: addresses', () => {
  it('accepts web links only', () => {
    expect(linkUrlProblem('https://example.com/x')).toBeNull()
    expect(linkUrlProblem('http://example.com')).toBeNull()
    expect(linkUrlProblem('')).toMatch(/Paste/)
    expect(linkUrlProblem('ftp://example.com')).toMatch(/Only web links/)
    expect(linkUrlProblem('javascript:alert(1)')).toMatch(/Only web links/)
    expect(linkUrlProblem('file:///etc/passwd')).toMatch(/Only web links/)
    expect(linkUrlProblem('https://me:pw@example.com')).toMatch(/password/)
    expect(linkUrlProblem('not a url')).toMatch(/isn’t a web link/)
    expect(linkUrlProblem(`https://a.test/${'x'.repeat(2000)}`)).toMatch(/too long/)
  })

  it('finds the link in a shared text', () => {
    expect(findLinkUrl('Look at this https://example.com/a?b=1. Wow')).toBe(
      'https://example.com/a?b=1',
    )
    expect(findLinkUrl('(https://example.com/x)')).toBe('https://example.com/x')
    expect(findLinkUrl('example.com/path')).toBe('https://example.com/path')
    expect(findLinkUrl('just words')).toBeNull()
    expect(findLinkUrl('v1.2')).toBeNull()
  })

  it('compares addresses without hashes, tracking or www', () => {
    expect(normalizeLinkUrl('https://WWW.Example.com/a/?utm_source=x&id=2#top')).toBe(
      'https://example.com/a?id=2',
    )
    expect(normalizeLinkUrl('https://example.com/a')).toBe(
      normalizeLinkUrl('https://example.com/a/#x'),
    )
    expect(normalizeLinkUrl('http://example.com/a')).not.toBe(
      normalizeLinkUrl('https://example.com/a'),
    )
  })

  it('names the site and tidies tags', () => {
    expect(siteOf('https://www.nature.com/x')).toBe('nature.com')
    expect(siteOf('nope')).toBe('')
    expect(cleanTags(['Biosecurity', 'biosecurity', '', '#Policy', 'x'.repeat(60)])).toEqual([
      'biosecurity',
      'policy',
      'x'.repeat(40),
    ])
  })

  it('counts words', () => {
    expect(wordCount('# Hello world\n\n- one, two — three')).toBe(5)
  })
})

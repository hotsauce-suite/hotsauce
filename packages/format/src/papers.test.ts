import { describe, expect, it } from 'vitest'
import { parseFrontmatter } from './frontmatter.js'
import {
  authorLine,
  paperKey,
  paperOf,
  paperPageUrl,
  paperPdfUrl,
  parsePaperKey,
} from './papers.js'
import { LinkFrontmatter, linkKey, newLinkFile } from './saved-links.js'

describe('papers: which addresses are a paper (R2)', () => {
  it.each([
    ['https://arxiv.org/abs/1706.03762', '1706.03762', null],
    ['https://arxiv.org/abs/1706.03762v7', '1706.03762', 7],
    ['https://arxiv.org/pdf/1706.03762', '1706.03762', null],
    ['https://arxiv.org/pdf/1706.03762v5.pdf', '1706.03762', 5],
    ['http://www.arxiv.org/html/2401.01234v2/', '2401.01234', 2],
    ['https://export.arxiv.org/abs/2401.01234', '2401.01234', null],
    ['https://arxiv.org/abs/hep-th/9901001v1', 'hep-th/9901001', 1],
    ['https://arxiv.org/pdf/math.GT/0309136', 'math.GT/0309136', null],
  ])('arXiv %s', (url, id, version) => {
    expect(paperOf(url)).toEqual({ server: 'arxiv', id, version })
  })

  it.each([
    ['https://www.biorxiv.org/content/10.1101/2020.03.22.002386v1', 'biorxiv', 1],
    ['https://www.biorxiv.org/content/10.1101/2020.03.22.002386v3.full.pdf', 'biorxiv', 3],
    ['https://biorxiv.org/content/10.1101/2020.03.22.002386.full', 'biorxiv', null],
    ['https://www.biorxiv.org/content/10.1101/2020.03.22.002386v2.full.pdf+html', 'biorxiv', 2],
    ['https://www.medrxiv.org/content/10.1101/2020.03.22.002386v1.full-text', 'medrxiv', 1],
    ['https://www.medrxiv.org/content/10.1101/2020.03.22.002386v1.abstract', 'medrxiv', 1],
  ])('%s', (url, server, version) => {
    expect(paperOf(url)).toEqual({ server, id: '10.1101/2020.03.22.002386', version })
  })

  it('reads old numeric bioRxiv DOIs', () => {
    expect(paperOf('https://www.biorxiv.org/content/10.1101/123456v1')).toMatchObject({
      id: '10.1101/123456',
    })
  })

  it.each([
    'https://arxiv.org/list/cs.AI/recent',
    'https://arxiv.org/',
    'https://example.com/abs/1706.03762',
    'https://www.biorxiv.org/collection/neuroscience',
    'https://www.biorxiv.org/content/early/recent',
    'ftp://arxiv.org/abs/1706.03762',
    'not a link',
  ])('is not a paper: %s', (url) => {
    expect(paperOf(url)).toBeNull()
  })

  it('every address form of one paper gives the same key (Q5)', () => {
    const forms = [
      'https://arxiv.org/abs/1706.03762',
      'https://arxiv.org/abs/1706.03762v7',
      'https://arxiv.org/pdf/1706.03762v2.pdf',
      'https://arxiv.org/html/1706.03762v7',
    ]
    const keys = new Set(forms.map((u) => linkKey({ url: u })))
    expect([...keys]).toEqual(['paper:arxiv:1706.03762'])
  })

  it('a paper link and a later save of its PDF share a key', () => {
    const file = newLinkFile({ url: 'https://arxiv.org/abs/1706.03762v7', savedBy: 'a@x.org' })
    const fm = LinkFrontmatter.parse(parseFrontmatter(file.text).data)
    expect(fm.paper).toBe('arxiv:1706.03762')
    expect(linkKey(fm)).toBe(linkKey({ url: 'https://arxiv.org/pdf/1706.03762' }))
  })

  it('keys round-trip for many arXiv ids and versions', () => {
    for (let i = 0; i < 300; i++) {
      const id = `${1000 + ((i * 37) % 9000)}.${String((i * 7919) % 100000).padStart(i % 2 ? 5 : 4, '0')}`
      const version = i % 3 === 0 ? null : (i % 29) + 1
      const kind = ['abs', 'pdf', 'html'][i % 3]
      const ref = paperOf(`https://arxiv.org/${kind}/${id}${version ? `v${version}` : ''}`)
      expect(ref).toEqual({ server: 'arxiv', id, version })
      if (!ref) continue
      expect(parsePaperKey(paperKey(ref))).toEqual({ server: 'arxiv', id })
      expect(paperOf(paperPageUrl(ref))).toEqual(ref)
      expect(paperOf(paperPdfUrl(ref))).toEqual(ref)
    }
  })

  it('names the first three authors', () => {
    expect(authorLine([])).toBe('')
    expect(authorLine(['Ada'])).toBe('Ada')
    expect(authorLine(['Ada', 'Alan'])).toBe('Ada and Alan')
    expect(authorLine(['Ada', 'Alan', 'Grace'])).toBe('Ada, Alan and Grace')
    expect(authorLine(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C and 2 more')
  })
})

describe('saved links: PDF and paper keys (R1)', () => {
  const base = { id: '01J0000000000000000000000A', type: 'link', saved: 'x', saved_by: 'a@x.org' }

  it('keeps a PDF from the computer with no address', () => {
    const file = newLinkFile({ url: '', file: '01J0000000000000000000000B', savedBy: 'a@x.org' })
    const fm = LinkFrontmatter.parse(parseFrontmatter(file.text).data)
    expect(fm.url).toBe('')
    expect(fm.file).toBe('01J0000000000000000000000B')
    expect(fm.paper).toBeUndefined()
    expect(linkKey(fm)).toBe('')
  })

  it('reads paper details', () => {
    const fm = LinkFrontmatter.parse({
      ...base,
      url: 'https://arxiv.org/abs/1706.03762',
      paper: 'arxiv:1706.03762',
      version: 7,
      authors: ['Ashish Vaswani', 'Noam Shazeer'],
      published: '2017-06-12',
      doi: '10.48550/arXiv.1706.03762',
      abstract: 'The dominant sequence transduction models…',
    })
    expect(fm).toMatchObject({ version: 7, authors: ['Ashish Vaswani', 'Noam Shazeer'] })
  })

  it('a hand-edited bad value reads as absent; the link still lists', () => {
    const fm = LinkFrontmatter.parse({
      ...base,
      url: 'https://x.org',
      file: '../../etc/passwd',
      paper: 'pubmed:1',
      version: 'two',
      authors: ['Ada', 3, 'Alan'],
      published: 2017,
    })
    expect(fm.file).toBeUndefined()
    expect(fm.paper).toBeUndefined()
    expect(fm.version).toBeUndefined()
    expect(fm.authors).toEqual(['Ada', 'Alan'])
    expect(fm.published).toBeUndefined()
  })

  it('an old file with no url key still parses', () => {
    expect(LinkFrontmatter.parse({ ...base }).url).toBe('')
  })
})

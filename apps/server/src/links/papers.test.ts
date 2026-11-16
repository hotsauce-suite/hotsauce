import { describe, expect, it } from 'vitest'
import { jatsToMarkdown, parseArxivAtom, parseRxivDetails } from './papers.js'

// Papers' details and full text (docs/PLAN-links-pdfs.md R4, R5), from answers shaped like the
// real sites' (checked 2026-11-16).

const ATOM = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <title>Attention Is All
      You Need</title>
    <link href="https://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf" title="pdf"/>
    <summary>The dominant sequence transduction models are based on
    complex recurrent or convolutional neural networks.</summary>
    <published>2017-06-12T17:57:34Z</published>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
  </entry>
</feed>`

describe('parseArxivAtom', () => {
  it('reads the title, authors, abstract, date, version and a DOI', () => {
    expect(parseArxivAtom(ATOM)).toEqual({
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Noam Shazeer'],
      abstract:
        'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.',
      published: '2017-06-12',
      doi: '10.48550/arXiv.1706.03762',
      version: 7,
    })
  })

  it('is null for no entry or arXiv’s error entry', () => {
    expect(parseArxivAtom('<feed xmlns="http://www.w3.org/2005/Atom"></feed>')).toBeNull()
    expect(
      parseArxivAtom(
        '<feed><entry><id>http://arxiv.org/api/errors#incorrect_id_format</id><title>Error</title></entry></feed>',
      ),
    ).toBeNull()
    expect(parseArxivAtom('not xml at all <<<')).toBeNull()
  })
})

describe('parseRxivDetails', () => {
  const answer = JSON.stringify({
    collection: [
      {
        title: 'v1 title',
        authors: 'Gordon, D. E.; Jang, G. M.',
        doi: '10.1101/x',
        date: '2020-03-22',
        version: '1',
        abstract: 'A.',
        jatsxml: 'https://www.biorxiv.org/content/early/1.source.xml',
      },
      {
        title: 'v3 title',
        authors: 'Gordon, D. E.',
        doi: '10.1101/x',
        date: '2020-03-27',
        version: '3',
        abstract: 'B.',
        jatsxml: 'https://evil.example/x.xml',
      },
    ],
  })

  it('takes the version asked for, else the newest, with names in reading order', () => {
    expect(parseRxivDetails(answer, 1)).toMatchObject({
      title: 'v1 title',
      authors: ['D. E. Gordon', 'G. M. Jang'],
      published: '2020-03-22',
      version: 1,
      jatsUrl: 'https://www.biorxiv.org/content/early/1.source.xml',
    })
    expect(parseRxivDetails(answer, null)).toMatchObject({ title: 'v3 title', version: 3 })
  })

  it('only fetches full text from the site itself', () => {
    expect(parseRxivDetails(answer, 3)?.jatsUrl).toBeNull()
  })

  it('is null for no paper or junk', () => {
    expect(parseRxivDetails('{"collection":[]}', null)).toBeNull()
    expect(parseRxivDetails('<html>', null)).toBeNull()
  })
})

describe('jatsToMarkdown', () => {
  it('writes sections, paragraphs, lists and captions, and leaves out formulas and references', () => {
    const md = jatsToMarkdown(`<article><front><abstract><p>Skip me.</p></abstract></front><body>
      <sec><title>Introduction</title><p>Words with <italic>style</italic> and a formula <inline-formula><mml:math><mml:mi>x</mml:mi></mml:math></inline-formula> here.</p>
      <sec><title>Detail</title><p>2. starts like a list * but isn't.</p>
      <list list-type="order"><list-item><p>One</p></list-item><list-item><p>Two</p></list-item></list>
      <fig><label>Figure 1</label><caption><title>Mirror cells.</title></caption></fig></sec></sec>
    </body><back><ref-list><ref>Cited.</ref></ref-list></back></article>`)
    expect(md.split('\n\n')).toEqual([
      '## Introduction',
      'Words with style and a formula here.',
      '### Detail',
      "2\\. starts like a list \\* but isn't.",
      '1. One\n2. Two',
      '*Figure 1 Mirror cells.*',
    ])
  })

  it('is empty without a body', () => {
    expect(jatsToMarkdown('<article><front/></article>')).toBe('')
  })
})

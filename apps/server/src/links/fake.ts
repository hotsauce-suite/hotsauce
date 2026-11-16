import { type FetchedPage, LinkFetchError, type PageFetcher } from './fetch.js'
import { makeTestPdf } from './test-pdf.js'

/**
 * Stand-in pages for development and tests (LINK_FETCH=fake): any address gives a short article
 * named after its last path segment; a host ending in `fail.test` can't be reached, and one
 * ending in `pdf.test` is a PDF, one ending in `stub.test` gives only a few words, and one ending
 * in `long.test` is a long read of 40 numbered sections. A host ending in `pdf.test` is a real
 * small PDF (`scanned.pdf.test`: one with no text). arXiv, bioRxiv and medRxiv answer like the real
 * sites with stand-in papers (`fakePaper`): arXiv ids ending in 1 have a web version; id
 * `0000.00000` and DOI `10.1101/000000` are unknown; bioRxiv's own pages refuse a server.
 */
export const fakePageFetcher: PageFetcher = async (url, kind = 'page'): Promise<FetchedPage> => {
  const parsed = new URL(url)
  if (parsed.hostname.endsWith('fail.test')) throw new LinkFetchError('Couldn’t reach the site')
  if (parsed.hostname.endsWith('pdf.test')) {
    const slug =
      parsed.pathname
        .split('/')
        .filter(Boolean)
        .at(-1)
        ?.replace(/\.pdf$/, '') ?? 'paper'
    const title = slug.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase())
    const bytes = parsed.hostname.startsWith('scanned.')
      ? makeTestPdf([[], []])
      : fakePaperPdf(title)
    return { url, contentType: 'application/pdf', text: '', bytes }
  }
  const paper = fakePaperAnswer(parsed)
  if (paper) {
    // Like the real fetcher: an API's JSON or XML only comes back when asked for as data.
    const data = /json|xml/.test(paper.contentType)
    if (data !== (kind === 'data')) {
      throw new LinkFetchError(
        data
          ? 'It isn’t a web page, so there’s no readable copy; the link is kept'
          : 'The site didn’t answer with the paper’s details',
      )
    }
    return paper
  }
  const slug = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).at(-1) ?? 'home')
  const title = slug.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase())
  if (parsed.hostname.endsWith('stub.test')) {
    const stub = `<!doctype html><html><head><title>${title}</title></head><body><article><p>${title}, cut short.</p></article></body></html>`
    return { url, contentType: 'text/html', text: stub }
  }
  if (parsed.hostname.endsWith('long.test')) {
    const sections = Array.from(
      { length: 40 },
      (_, i) =>
        `<h2>Part ${i + 1}</h2><p>${`Part ${i + 1} of ${title.toLowerCase()} goes on. `.repeat(20)}</p>`,
    ).join('')
    const long = `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1>${sections}</article></body></html>`
    return { url, contentType: 'text/html', text: long }
  }
  const para = `${title} is the subject of this page. `.repeat(12)
  const text = `<!doctype html><html><head><title>${title}</title>
<meta property="og:site_name" content="${parsed.hostname.replace(/^www\./, '')}">
<meta name="description" content="A page about ${title.toLowerCase()}.">
</head><body><article><h1>${title}</h1><p>${para}</p><h2>More</h2><p>${para}</p>
<p>Read <a href="/next">the next part</a>.</p></article></body></html>`
  return { url, contentType: 'text/html', text }
}

/** A stand-in paper's PDF: a title, two sections, enough words to read. */
export function fakePaperPdf(title: string): Uint8Array {
  const para = (topic: string) =>
    Array.from({ length: 6 }, (_, i) => `${topic} sentence ${i + 1} says something worth reading.`)
  return makeTestPdf(
    [
      [
        { text: title, size: 18 },
        'Ada Lovelace, Alan Turing',
        { text: 'Abstract', gap: 14 },
        ...para('The abstract'),
        { text: '1 Introduction', gap: 14 },
        ...para('The introduction'),
      ],
      [{ text: '2 Results', gap: 4 }, ...para('The results'), '2'],
    ],
    title,
  )
}

function fakePaperTitle(id: string): string {
  return `A stand-in paper ${id}`
}

/** What arXiv, bioRxiv and medRxiv answer for a stand-in paper; null for other sites. */
function fakePaperAnswer(url: URL): FetchedPage | null {
  const host = url.hostname.replace(/^www\./, '')
  const at = url.toString()
  if (host === 'export.arxiv.org' && url.pathname === '/api/query') {
    const id = url.searchParams.get('id_list') ?? ''
    const entry =
      id === '0000.00000'
        ? ''
        : `<entry><id>http://arxiv.org/abs/${id}v2</id><title>${fakePaperTitle(id)}</title>
<summary>We show that stand-in papers can be read. ${id} is about testing.</summary>
<published>2024-01-15T00:00:00Z</published>
<author><name>Ada Lovelace</name></author><author><name>Alan Turing</name></author>
<author><name>Grace Hopper</name></author><author><name>Katherine Johnson</name></author>
<arxiv:doi>10.1000/fake.${id}</arxiv:doi></entry>`
    const text = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">${entry}</feed>`
    return { url: at, contentType: 'application/atom+xml', text }
  }
  if (host === 'arxiv.org') {
    const m = /^\/(html|pdf)\/([^/]+?)(v\d+)?$/.exec(url.pathname)
    if (!m?.[2]) return null
    if (m[1] === 'pdf') {
      return {
        url: at,
        contentType: 'application/pdf',
        text: '',
        bytes: fakePaperPdf(fakePaperTitle(m[2])),
      }
    }
    if (!m[2].endsWith('1')) throw new LinkFetchError('The page isn’t there any more')
    const sections = ['Introduction', 'Method', 'Results']
      .map(
        (h, i) =>
          `<h2>${i + 1} ${h}</h2><p>${`The ${h.toLowerCase()} of the web version goes on with <math alttext="x_{${i}}"><mi>x</mi></math> in it. `.repeat(12)}</p>`,
      )
      .join('')
    const text = `<!doctype html><html><head><title>${fakePaperTitle(m[2])}</title></head><body><article><h1>${fakePaperTitle(m[2])}</h1>${sections}</article></body></html>`
    return { url: at, contentType: 'text/html', text }
  }
  if (host === 'api.biorxiv.org') {
    const m = /^\/details\/(biorxiv|medrxiv)\/(10\.1101\/.+)$/.exec(url.pathname)
    if (!m?.[1] || !m[2]) return null
    const doi = m[2]
    const rows =
      doi === '10.1101/000000'
        ? []
        : [1, 2].map((v) => ({
            title: `${fakePaperTitle(doi)} (version ${v})`,
            authors: 'Lovelace, A.; Turing, A. M.',
            doi,
            date: `2024-02-0${v}`,
            version: String(v),
            abstract: 'We show that preprints can be read from their full text.',
            jatsxml: `https://www.${m[1]}.org/content/early/2024/02/0${v}/${doi.slice(8)}.source.xml`,
            server: m[1],
          }))
    return {
      url: at,
      contentType: 'application/json',
      text: JSON.stringify({ messages: [{ status: 'ok' }], collection: rows }),
    }
  }
  if (host === 'biorxiv.org' || host === 'medrxiv.org') {
    if (url.pathname.endsWith('.source.xml')) {
      const p = (topic: string) =>
        `<p>${`The ${topic} of the preprint has words a reader wants, with <italic>emphasis</italic>. `.repeat(10)}</p>`
      const text = `<?xml version="1.0"?><article><front><article-meta><abstract><p>Front matter.</p></abstract></article-meta></front>
<body><sec><title>Introduction</title>${p('introduction')}</sec><sec><title>Results</title>${p('results')}
<fig id="f1"><label>Figure 1.</label><caption><p>A figure caption.</p></caption></fig>
<sec><title>A finding</title>${p('finding')}<list list-type="bullet"><list-item><p>First point</p></list-item><list-item><p>Second point</p></list-item></list></sec></sec></body>
<back><ref-list><ref><mixed-citation>A reference that is left out.</mixed-citation></ref></ref-list></back></article>`
      return { url: at, contentType: 'application/xml', text }
    }
    // The real sites answer a server with a robot check.
    throw new LinkFetchError('The site wouldn’t show the page (it may need a sign-in)')
  }
  return null
}

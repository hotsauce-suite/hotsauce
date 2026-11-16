import { type FetchedPage, LinkFetchError, type PageFetcher } from './fetch.js'

/**
 * Stand-in pages for development and tests (LINK_FETCH=fake): any address gives a short article
 * named after its last path segment; a host ending in `fail.test` can't be reached, and one
 * ending in `pdf.test` is a PDF, one ending in `stub.test` gives only a few words, and one ending
 * in `long.test` is a long read of 40 numbered sections.
 */
export const fakePageFetcher: PageFetcher = async (url: string): Promise<FetchedPage> => {
  const parsed = new URL(url)
  if (parsed.hostname.endsWith('fail.test')) throw new LinkFetchError('Couldn’t reach the site')
  if (parsed.hostname.endsWith('pdf.test')) {
    throw new LinkFetchError(
      'It’s a PDF, not a web page, so there’s no readable copy; the link is kept',
    )
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

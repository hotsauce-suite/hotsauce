import { type FetchedPage, LinkFetchError, type PageFetcher } from './fetch.js'

/**
 * Stand-in pages for development and tests (LINK_FETCH=fake): any address gives a short article
 * named after its last path segment; a host ending in `fail.test` can't be reached, and one
 * ending in `pdf.test` is a PDF.
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
  const para = `${title} is the subject of this page. `.repeat(12)
  const text = `<!doctype html><html><head><title>${title}</title>
<meta property="og:site_name" content="${parsed.hostname.replace(/^www\./, '')}">
<meta name="description" content="A page about ${title.toLowerCase()}.">
</head><body><article><h1>${title}</h1><p>${para}</p><h2>More</h2><p>${para}</p>
<p>Read <a href="/next">the next part</a>.</p></article></body></html>`
  return { url, contentType: 'text/html', text }
}

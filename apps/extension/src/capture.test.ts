import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { MAX_PAGE_BYTES, pageCopy } from './capture'

const doc = (html: string) => (parseHTML(html) as unknown as { document: Document }).document

describe('the page as the person sees it (R6)', () => {
  it('keeps the words and drops scripts, styles, frames and media', () => {
    const copy = pageCopy(
      MAX_PAGE_BYTES,
      doc(
        '<html><head><title>T</title><meta property="og:title" content="Story"><style>p{}</style>' +
          '<link rel="stylesheet" href="/a.css"></head><body><article><h1>Story</h1>' +
          '<p>Only for subscribers.</p><svg><path/></svg><iframe src="/ad"></iframe></article>' +
          '<script>track()</script><video src="v.mp4"></video></body></html>',
      ),
    )
    expect(copy).toMatch(/^<!doctype html>/)
    expect(copy).toContain('Only for subscribers.')
    expect(copy).toContain('og:title')
    for (const gone of ['<script', '<style', '<svg', '<iframe', '<video', '<link', 'track()']) {
      expect(copy).not.toContain(gone)
    }
  })

  it('leaves the live page alone', () => {
    const page = doc('<html><body><p>Hi</p><script>x()</script></body></html>')
    pageCopy(MAX_PAGE_BYTES, page)
    expect(page.querySelector('script')).not.toBeNull()
  })

  it('drops inline styles to fit, and gives up past the limit', () => {
    const styled = `<html><body>${'<p style="color: red; margin: 0 auto 0 auto">w</p>'.repeat(200)}</body></html>`
    const fit = pageCopy(4000, doc(styled))
    expect(fit).not.toBeNull()
    expect(fit).not.toContain('style=')
    expect(fit?.match(/<p>w<\/p>/g)).toHaveLength(200)
    expect(pageCopy(500, doc(styled))).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { readPage, toMarkdown } from './read.js'

const ARTICLE = `<!doctype html><html><head>
<title>Fallback title</title>
<meta property="og:title" content="Mirror life, explained">
<meta property="og:site_name" content="The Journal">
<meta name="description" content="Why mirror bacteria worry biologists.">
</head><body>
<nav><a href="/">Home</a> <a href="/about">About</a></nav>
<article>
<h1>Mirror life, explained</h1>
<p>${'Mirror bacteria would be made of molecules with the opposite handedness. '.repeat(8)}</p>
<h2>Why it matters</h2>
<ul><li>Immune systems may not see them</li><li>Predators may not eat them</li></ul>
<p>See <a href="/papers/1">the paper</a> and <a href="#top">top</a> and <a href="javascript:alert(1)">this</a>.</p>
<p><img src="/fig1.png" alt="Figure [1]"> <img src="data:image/png;base64,AAAA"></p>
<table><tr><th>Risk</th><th>Level</th></tr><tr><td>Spread</td><td>High</td></tr></table>
<script>steal()</script><form><input name="q"></form>
</article>
<footer>© 2026</footer>
</body></html>`

describe('readPage', () => {
  it('keeps the article as Markdown with absolute links and pictures as links', () => {
    const page = readPage(ARTICLE, 'https://journal.test/a/mirror', 'text/html')
    expect(page.title).toBe('Mirror life, explained')
    expect(page.site).toBe('The Journal')
    expect(page.description).toBe('Why mirror bacteria worry biologists.')
    expect(page.markdown).toContain('## Why it matters')
    expect(page.markdown).toContain('- Immune systems may not see them')
    expect(page.markdown).toContain('[the paper](https://journal.test/papers/1)')
    expect(page.markdown).toContain('[Picture: Figure 1](https://journal.test/fig1.png)')
    expect(page.markdown).toContain('| Risk | Level |')
    expect(page.markdown).not.toContain('steal')
    expect(page.markdown).not.toContain('javascript:')
    expect(page.markdown).not.toContain('data:image')
    expect(page.markdown).not.toContain('Home')
    expect(page.markdown).not.toContain('© 2026')
    expect(page.words).toBeGreaterThan(80)
  })

  it('falls back to the <title> and host, and an empty copy when there is no article', () => {
    const page = readPage(
      '<html><title> Just  a title </title><body></body></html>',
      'https://www.x.test/',
      'text/html',
    )
    expect(page).toMatchObject({ title: 'Just a title', site: 'x.test', markdown: '', words: 0 })
  })

  it('keeps plain text as it is', () => {
    const page = readPage('line one\r\nline two\n', 'https://x.test/a.txt', 'text/plain')
    expect(page.markdown).toBe('line one\nline two')
    expect(page.words).toBe(4)
  })

  it('never throws on junk', () => {
    expect(() => readPage('<<<>>><html', 'https://x.test', 'text/html')).not.toThrow()
  })
})

describe('toMarkdown', () => {
  it('escapes parentheses in an address', () => {
    expect(toMarkdown('<a href="https://x.test/a_(b)">wiki</a>', 'https://x.test/')).toBe(
      '[wiki](https://x.test/a_%28b%29)',
    )
  })
})

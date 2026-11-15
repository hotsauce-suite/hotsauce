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

  it('puts a streamed React page together before reading it (EA Forum, LessWrong, Next.js)', () => {
    const para = 'Engineered pathogens pose a grave threat to society and deserve far more work. '
    const html = `<!doctype html><html><head><meta property="og:title" content="10 big projects">
</head><body>
<header><a href="/"><img src="/logo.svg" alt=""><span>The Forum</span></a></header>
<main><!--$?--><template id="B:0"></template><p>Loading…</p><!--/$--></main>
<div hidden id="S:0"><article><h1>10 big projects</h1><p>${para.repeat(6)}</p>
<!--$?--><template id="B:1"></template><p>Loading more…</p><!--$--><i>nested stand-in</i><!--/$--><!--/$-->
<template id="P:2"></template></article></div>
<div hidden id="S:1"><h2>Project one</h2><p>${'Stockpile protective equipment for everyone. '.repeat(6)}</p></div>
<div hidden id="S:2"><h2>Project two</h2><p>${'Screen every gene synthesis order. '.repeat(6)}</p></div>
<script>$RC("B:0","S:0");$RC("B:1","S:1");$RS("S:2","P:2")</script>
</body></html>`
    const page = readPage(html, 'https://forum.test/posts/1', 'text/html')
    expect(page.markdown).toContain('Engineered pathogens pose a grave threat')
    expect(page.markdown).toContain('## Project one')
    expect(page.markdown).toContain('## Project two')
    expect(page.markdown).not.toContain('Loading')
    expect(page.markdown).not.toContain('nested stand-in')
    expect(page.markdown).not.toContain('The Forum')
    expect(page.words).toBeGreaterThan(100)
  })

  it('follows the page’s own calls when parts and boundaries are numbered apart (React 18)', () => {
    const html = `<html><body><header><a href="/">Forum</a></header>
<main><!--$?--><template id="B:0"></template><p>Loading…</p><!--/$--></main>
<div hidden id="S:1"><article><p>${'Mirror life policy needs owners who will push it through. '.repeat(8)}</p></article></div>
<script>$RC("B:0","S:1")</script></body></html>`
    const page = readPage(html, 'https://f.test/p', 'text/html')
    expect(page.markdown).toContain('Mirror life policy needs owners')
    expect(page.markdown).not.toContain('Loading')
  })

  it('leaves a page alone when an "S:" block has no real placeholder', () => {
    const long = 'Particle monitoring would warn cities early about a new outbreak. '.repeat(6)
    const html = `<html><body><article><h1 id="B:1">Heading</h1><p>${long}</p><p>${long}</p></article>
<div hidden id="S:1">x</div>
<div hidden id="S:2"><div><template id="P:2"></template></div><p>y</p></div></body></html>`
    const page = readPage(html, 'https://f.test/p', 'text/html')
    expect(page.markdown).toContain('# Heading')
    expect(page.markdown).toContain('Particle monitoring')
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
  it('never puts a link inside a link when a link wraps a picture', () => {
    expect(
      toMarkdown(
        '<p><a href="/"><img src="/logo.svg" alt="">The Forum</a></p>',
        'https://x.test/a',
      ),
    ).toBe('[The Forum](https://x.test/)')
    expect(
      toMarkdown(
        '<p><a href="/big.png"><img src="/small.png" alt="Chart"></a></p>',
        'https://x.test/a',
      ),
    ).toBe('[Picture: Chart](https://x.test/big.png)')
    expect(
      toMarkdown(
        '<p><a href="/p"><img src="/a_(1).png" alt="x"> Caption here</a></p>',
        'https://x.test/a',
      ),
    ).toBe('[Caption here](https://x.test/p)')
    expect(toMarkdown('<p><img src="/a_(1).png" alt="x"></p>', 'https://x.test/a')).toBe(
      '[Picture: x](https://x.test/a_%281%29.png)',
    )
  })

  it('escapes parentheses in an address', () => {
    expect(toMarkdown('<a href="https://x.test/a_(b)">wiki</a>', 'https://x.test/')).toBe(
      '[wiki](https://x.test/a_%28b%29)',
    )
  })
})

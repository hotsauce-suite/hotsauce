// The help center (public/help/) and the FAQ (public/faq.html): every page is listed once, has
// the metadata search engines and link previews need, and links only to pages that exist.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PUBLIC = join(import.meta.dirname, 'public')
const HELP = join(PUBLIC, 'help')
const read = (p) => readFileSync(p, 'utf8')

// help.js is a browser script; take its two lists out of it as plain data.
const js = read(join(HELP, 'help.js'))
const list = (name) => {
  const m = new RegExp(`const ${name} = (\\[[\\s\\S]*?\\n\\])`).exec(js)
  if (!m) throw new Error(`${name} not found in help.js`)
  return new Function(`return ${m[1]}`)()
}
const GROUPS = list('GROUPS')
const PAGES = list('PAGES')
const index = read(join(HELP, 'index.html'))
const pageHtml = (slug) => read(join(HELP, `${slug}.html`))

// Where a site path is served from: /help/x → help/x.html, /help/ → help/index.html.
function fileFor(path) {
  if (path === '/help/' || path === '/help') return join(HELP, 'index.html')
  if (path === '/faq') return join(PUBLIC, 'faq.html')
  if (path === '/') return join(PUBLIC, 'index.html')
  if (/\.(css|js|md|txt|sh)$/.test(path)) return join(PUBLIC, path)
  const m = /^\/help\/([a-z0-9-]+)$/.exec(path)
  return m ? join(HELP, `${m[1]}.html`) : null
}

describe('help center pages', () => {
  it('lists every page file exactly once, and every listed page has a file', () => {
    const files = readdirSync(HELP)
      .filter((f) => f.endsWith('.html') && f !== 'index.html')
      .map((f) => f.slice(0, -5))
      .sort()
    const slugs = PAGES.map((p) => p.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    expect([...slugs].sort()).toEqual(files)
  })

  it('puts every page in a known group', () => {
    const groups = GROUPS.map(([id]) => id)
    for (const p of PAGES) expect(groups, p.slug).toContain(p.group)
  })

  it('has a card for every page on the help home page, in its group', () => {
    for (const p of PAGES) {
      const cards = index.match(new RegExp(`href="/help/${p.slug}"`, 'g')) ?? []
      expect(cards.length, p.slug).toBe(1)
      const section = index.split(`<h2 id="g-${p.group}">`)[1]?.split('</section>')[0] ?? ''
      expect(section, `${p.slug} card in group ${p.group}`).toContain(`href="/help/${p.slug}"`)
    }
  })

  it.each(PAGES)('$slug has its title, description, canonical link and one h1', (p) => {
    const html = pageHtml(p.slug)
    expect(html).toMatch(/<title>[^<]+ · Hotsauce help<\/title>/)
    expect(html).toMatch(/<meta name="description" content="[^"]{20,}">/)
    expect(html).toContain(`<link rel="canonical" href="https://hotsauce.work/help/${p.slug}">`)
    expect(html).toContain(`data-page="${p.slug}"`)
    expect(html.match(/<h1[ >]/g)?.length).toBe(1)
    expect(html).toContain('<script src="/help/help.js" defer></script>')
  })

  it.each(PAGES)('$slug says "coming soon" exactly when it is marked soon', (p) => {
    const card = index.split(`href="/help/${p.slug}"`)[1].split('</li>')[0]
    expect(pageHtml(p.slug).includes('<p class="soon"'), 'note on the page').toBe(Boolean(p.soon))
    expect(card.includes('Coming soon'), 'badge on the card').toBe(Boolean(p.soon))
  })
})

describe('links in the help center and FAQ', () => {
  const pages = [
    ...PAGES.map((p) => [`/help/${p.slug}`, pageHtml(p.slug)]),
    ['/help/', index],
    ['/faq', read(join(PUBLIC, 'faq.html'))],
  ]
  it.each(pages)('%s links only to help pages and sections that exist', (_path, html) => {
    for (const [, href] of html.matchAll(/href="(\/(?:help|faq|install\.md)[^"]*)"/g)) {
      const [path, hash] = href.split('#')
      const file = fileFor(path)
      expect(file && existsSync(file), href).toBe(true)
      if (hash) expect(read(file), href).toContain(`id="${hash}"`)
    }
  })
})

describe('FAQ', () => {
  const faq = read(join(PUBLIC, 'faq.html'))
  it('describes every question for search engines', () => {
    const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/s.exec(faq)[1])
    expect(ld['@type']).toBe('FAQPage')
    expect(ld.mainEntity.length).toBe(faq.match(/<details /g).length)
  })
  it('gives every question its own link', () => {
    const ids = [...faq.matchAll(/<details id="([a-z0-9-]+)">/g)].map((m) => m[1])
    expect(ids.length).toBe(faq.match(/<details /g).length)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('landing page', () => {
  const landing = read(join(PUBLIC, 'index.html'))
  it('links to the help center and the full FAQ', () => {
    expect(landing).toContain('href="/help/"')
    expect(landing).toContain('href="/faq"')
  })
})

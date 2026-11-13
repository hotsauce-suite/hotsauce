// The landing page's header (docs/PLAN-ipad.md, T9). Checked in WebKit at 641–1000 px; this
// keeps the rule and the links that rely on it from drifting apart.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const html = readFileSync(join(import.meta.dirname, 'public', 'index.html'), 'utf8')
const nav = /<nav class="links"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? ''
const links = [...nav.matchAll(/<a([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
  attrs: m[1],
  text: m[2].replace(/<[^>]+>/g, '').trim(),
}))

describe('landing page header', () => {
  it('drops the section links to one line between phone and laptop widths', () => {
    expect(html).toMatch(/@media \(max-width:960px\)\{.*nav\.links a\.wide\{display:none\}/)
    const wide = links.filter((l) => l.attrs.includes('class="wide"')).map((l) => l.text)
    expect(wide).toEqual(['Coming', 'Your brand', 'Cost'])
  })

  it('keeps Apps, Self-host, FAQ, Help and GitHub at every width above a phone', () => {
    const kept = links.filter((l) => !l.attrs.includes('class="wide"')).map((l) => l.text.trim())
    expect(kept).toEqual(['Apps', 'Self-host', 'FAQ', 'Help', 'GitHub'])
  })
})

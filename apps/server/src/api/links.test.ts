import { describe, expect, it } from 'vitest'
import { rewriteLinksToMoved } from './links.js'

const FROM = 'docs/b.md'
const TO = 'docs/archive/b.md'

describe('rewriteLinksToMoved', () => {
  it('rewrites inline links to the moved file, keeping fragments and queries', () => {
    const md = 'See [b](b.md), [part](b.md#plan) and [q](./b.md?x=1).\n'
    expect(rewriteLinksToMoved(md, 'docs/a.md', FROM, TO)).toBe(
      'See [b](archive/b.md), [part](archive/b.md#plan) and [q](archive/b.md?x=1).\n',
    )
  })

  it('works from another folder, and for images and angle-bracket hrefs with titles', () => {
    const md = '[b](../docs/b.md)\n\n![pic](<../docs/b.md> "Title")\n'
    expect(rewriteLinksToMoved(md, 'notes/n.md', FROM, TO)).toBe(
      '[b](../docs/archive/b.md)\n\n![pic](<../docs/archive/b.md> "Title")\n',
    )
  })

  it('rewrites a shared reference definition once', () => {
    const md = 'One [b][ref], two [ref], three [ref][].\n\n[ref]: b.md "The B doc"\n'
    expect(rewriteLinksToMoved(md, 'docs/a.md', FROM, TO)).toBe(
      'One [b][ref], two [ref], three [ref][].\n\n[ref]: archive/b.md "The B doc"\n',
    )
  })

  it('follows a moved folder to files under it', () => {
    const md = '[x](sub/x.md) [deep](sub/deeper/y.md) [other](subway.md)\n'
    expect(rewriteLinksToMoved(md, 'docs/a.md', 'docs/sub', 'archive/sub')).toBe(
      '[x](../archive/sub/x.md) [deep](../archive/sub/deeper/y.md) [other](subway.md)\n',
    )
  })

  it('leaves everything else byte-for-byte: other links, code, external and absolute hrefs', () => {
    const md = [
      '---',
      'id: 01JA2Z8Q4M7V3K9R5T1XWYB6CD',
      '---',
      '[c](c.md) `[b](b.md)` <https://x.test/b.md> [abs](/docs/b.md)',
      '',
      '```',
      '[b](b.md)',
      '```',
      '',
    ].join('\n')
    expect(rewriteLinksToMoved(md, 'docs/a.md', FROM, TO)).toBe(md)
  })

  it('percent-encodes where the new path needs it', () => {
    expect(rewriteLinksToMoved('[b](b.md)\n', 'docs/a.md', FROM, 'docs/Old notes/b.md')).toBe(
      '[b](Old%20notes/b.md)\n',
    )
  })
})

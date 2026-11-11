import { describe, expect, it } from 'vitest'
import { extractLinks, type Link, rewriteLinksForMove } from './links.js'

const hrefs = (markdown: string) => extractLinks(markdown).map((l) => l.href)
const ID = '01JA2Z8Q4M7V3K9R5T1XWYB6CD'

describe('extractLinks', () => {
  it('reports an inline link with its text, range, and kind', () => {
    const md = 'See [the plan](plans/q4.md) today.'
    expect(extractLinks(md)).toEqual<Link[]>([
      { href: 'plans/q4.md', text: 'the plan', from: 4, to: 27, kind: 'relative' },
    ])
  })

  it('classifies hrefs as relative, hearth, or external', () => {
    const md = `[a](../a.md) [b](hearth://${ID}) [c](https://x.com) [d](mailto:a@b.co) [e](#top) [f](/docs/f.md) [g](//cdn.x.com/g)`
    expect(extractLinks(md).map((l) => l.kind)).toEqual([
      'relative',
      'hearth',
      'external',
      'external',
      'relative',
      'relative',
      'external',
    ])
  })

  it('reports images, with the kind taken from the href', () => {
    const md = '![Funnel](../../assets/2026/10/funnel.png) ![logo](https://x.com/logo.svg "Logo")'
    expect(extractLinks(md)).toEqual<Link[]>([
      {
        href: '../../assets/2026/10/funnel.png',
        text: 'Funnel',
        from: 0,
        to: 42,
        kind: 'relative',
      },
      { href: 'https://x.com/logo.svg', text: 'logo', from: 43, to: 81, kind: 'external' },
    ])
  })

  it('finds an image inside a link', () => {
    const md = '[![badge](badge.svg)](https://ci.example.com)'
    expect(extractLinks(md).map((l) => [l.href, l.text, l.from, l.to])).toEqual([
      ['https://ci.example.com', '![badge](badge.svg)', 0, 45],
      ['badge.svg', 'badge', 1, 20],
    ])
  })

  it('handles titles, angle-bracket destinations, balanced parens, and escapes', () => {
    const md = [
      '[a](a.md "Title")',
      "[b](b.md 'Title')",
      '[c](c.md (Title))',
      '[d](<my doc.md>)',
      '[e](wiki/Foo_(bar).md)',
      '[f](f\\(1\\).md)',
      '[g]( g.md )',
    ].join('\n')
    expect(hrefs(md)).toEqual([
      'a.md',
      'b.md',
      'c.md',
      'my doc.md',
      'wiki/Foo_(bar).md',
      'f(1).md',
      'g.md',
    ])
  })

  it('resolves full, collapsed, and shortcut reference links, case-insensitively', () => {
    const md = `Read [the plan][Plan], the [plan][], and [PLAN].
Also [nothing][missing] and [unknown].

[plan]: ./plans/q4.md "Q4"
[Other Label]: <spaced name.md>
`
    expect(extractLinks(md).map((l) => [l.text, l.href, md.slice(l.from, l.to)])).toEqual([
      ['the plan', './plans/q4.md', '[the plan][Plan]'],
      ['plan', './plans/q4.md', '[plan][]'],
      ['PLAN', './plans/q4.md', '[PLAN]'],
    ])
  })

  it('uses the first definition of a label and resolves references that come before it', () => {
    expect(hrefs('[x]\n\n[x]: first.md\n[x]: second.md\n')).toEqual(['first.md'])
  })

  it('does not treat footnotes or task list checkboxes as links', () => {
    const md = 'Claim.[^1]\n\n- [ ] todo\n- [x] done\n\n[^1]: Source: the 2025 lab survey.'
    expect(hrefs(md)).toEqual([])
    // A footnote's own text is ordinary markdown, so a URL in it is still a link.
    expect(hrefs('[^1]: https://source.example.com')).toEqual(['https://source.example.com'])
  })

  it('reports autolinks, including email and hearth autolinks', () => {
    const md = `<https://example.com/a?b=c> <mailto:x@y.org> <dana@acme.com> <hearth://${ID}>`
    expect(extractLinks(md).map((l) => [l.href, l.text, l.kind])).toEqual([
      ['https://example.com/a?b=c', 'https://example.com/a?b=c', 'external'],
      ['mailto:x@y.org', 'mailto:x@y.org', 'external'],
      ['mailto:dana@acme.com', 'dana@acme.com', 'external'],
      [`hearth://${ID}`, `hearth://${ID}`, 'hearth'],
    ])
  })

  it('reports bare URLs, www links, and hearth:// ids without trailing punctuation', () => {
    const md = `Visit https://example.com/path. Or www.example.com, (see https://en.wikipedia.org/wiki/Foo_(bar)) and hearth://${ID}!`
    expect(hrefs(md)).toEqual([
      'https://example.com/path',
      'http://www.example.com',
      'https://en.wikipedia.org/wiki/Foo_(bar)',
      `hearth://${ID}`,
    ])
  })

  it('ignores a bare URL prefix with nothing after it or glued to a word', () => {
    expect(hrefs('https:// and xhttps://example.com and www.')).toEqual([])
  })

  it('ignores brackets and URLs inside code spans', () => {
    const md = 'Use `[a](b.md)` or ``[c](`d`.md)`` or `https://x.com`, but [real](real.md).'
    expect(hrefs(md)).toEqual(['real.md'])
  })

  it('lets a code span inside link text hide a closing bracket', () => {
    expect(extractLinks('[a `]` b](x.md)').map((l) => [l.text, l.href])).toEqual([
      ['a `]` b', 'x.md'],
    ])
  })

  it('ignores links in fenced code blocks, including unclosed and nested fences', () => {
    const md = [
      '```md',
      '[a](a.md)',
      '```',
      '~~~~',
      '```',
      '[b](b.md)',
      '~~~~',
      '- item',
      '  ```',
      '  [c](c.md)',
      '  ```',
      '[d](d.md)',
      '```',
      '[e](e.md)',
    ].join('\n')
    expect(hrefs(md)).toEqual(['d.md'])
  })

  it('does not take a definition from inside a fence', () => {
    expect(hrefs('[x]\n\n```\n[x]: hidden.md\n```\n')).toEqual([])
  })

  it('ignores the frontmatter but reports ranges in the whole file', () => {
    const md = '---\nurl: https://example.com\nsee: "[x](y.md)"\n---\n[a](a.md)\n'
    const from = md.indexOf('[a](a.md)')
    expect(extractLinks(md)).toEqual<Link[]>([
      { href: 'a.md', text: 'a', from, to: from + 9, kind: 'relative' },
    ])
  })

  it('ignores escaped brackets and unfinished links', () => {
    expect(hrefs('\\[a](a.md) [b](b.md [c]( [d] (d.md) [e](<e.md)')).toEqual([])
  })

  it('finds a link after an unmatched bracket', () => {
    expect(hrefs('[a [b](b.md) and [c] [[d](d.md)]')).toEqual(['b.md', 'd.md'])
  })

  it('stays linear on a paragraph full of unmatched brackets', () => {
    // Scanning forward from every `[` would take tens of seconds here and hit the test timeout.
    expect(hrefs(`${'[a '.repeat(50_000)}[end](end.md)`)).toEqual(['end.md'])
  })

  it('does not join a link across a blank line', () => {
    expect(hrefs('[a\n\nb](x.md)')).toEqual([])
    expect(hrefs('[a\nb](x.md)')).toEqual(['x.md'])
  })

  it('skips links with an empty destination', () => {
    expect(hrefs('[a]() [b](<>)')).toEqual([])
  })

  it('handles CRLF text', () => {
    const md = '[a](a.md)\r\n\r\n```\r\n[b](b.md)\r\n```\r\n[c]\r\n\r\n[c]: c.md\r\n'
    expect(hrefs(md)).toEqual(['a.md', 'c.md'])
  })
})

describe('rewriteLinksForMove', () => {
  it('rewrites relative links so they reach the same files from the new folder', () => {
    const md =
      'See [goals](goals.md), [up](../index.md), and ![chart](../../assets/2026/10/c.png).\n'
    expect(rewriteLinksForMove(md, 'docs/plans/q4.md', 'docs/archive/2026/q4.md')).toBe(
      'See [goals](../../plans/goals.md), [up](../../index.md), and ![chart](../../../assets/2026/10/c.png).\n',
    )
  })

  it('leaves links alone when the folder does not change', () => {
    const md = '[a](./a.md) [b](sub/b.md) [c](../c.md)'
    expect(rewriteLinksForMove(md, 'docs/x/old.md', 'docs/x/new.md')).toBe(md)
  })

  it('keeps the fragment and query', () => {
    expect(
      rewriteLinksForMove('[a](a.md#goals) [b](b.md?plain=1)', 'docs/x.md', 'docs/sub/x.md'),
    ).toBe('[a](../a.md#goals) [b](../b.md?plain=1)')
  })

  it('points a link to the file itself at its new name', () => {
    expect(rewriteLinksForMove('[me](old.md#top)', 'docs/old.md', 'docs/new.md')).toBe(
      '[me](new.md#top)',
    )
  })

  it('does not touch external, hearth, fragment, or root-absolute links', () => {
    const md = `[a](https://x.com/a.md) [b](hearth://${ID}) [c](#top) [d](/docs/d.md) <https://y.com> www.z.com [e](mailto:a@b.co)`
    expect(rewriteLinksForMove(md, 'docs/a.md', 'docs/deep/er/a.md')).toBe(md)
  })

  it('rewrites a reference definition once, however many links use it', () => {
    const md = '[one][r] and [two][r] and [r]\n\n[r]: target.md "Title"\n'
    expect(rewriteLinksForMove(md, 'docs/a.md', 'docs/sub/a.md')).toBe(
      '[one][r] and [two][r] and [r]\n\n[r]: ../target.md "Title"\n',
    )
  })

  it('rewrites an image inside a link and keeps angle brackets and titles', () => {
    const md = '[![b](img/b.png)](page.md "Page") [s](<my notes.md> "Notes")'
    expect(rewriteLinksForMove(md, 'docs/a.md', 'docs/sub/a.md')).toBe(
      '[![b](../img/b.png)](../page.md "Page") [s](<../my%20notes.md> "Notes")',
    )
  })

  it('percent-encodes rewritten paths and keeps a trailing slash', () => {
    expect(rewriteLinksForMove('[f](my%20folder/) [g](a%20b.md)', 'docs/a.md', 'b.md')).toBe(
      '[f](docs/my%20folder/) [g](docs/a%20b.md)',
    )
  })

  it('leaves links in code and links that escape the repo alone', () => {
    const md = '`[a](a.md)`\n\n```\n[b](b.md)\n```\n\n[c](../../../outside.md)\n'
    expect(rewriteLinksForMove(md, 'docs/a.md', 'docs/sub/a.md')).toBe(md)
  })

  it('does not change frontmatter or any other text', () => {
    const md = '---\nrelated: ../x.md\n---\r\nText [x](x.md) text.\r\n'
    expect(rewriteLinksForMove(md, 'docs/a.md', 'docs/sub/a.md')).toBe(
      '---\nrelated: ../x.md\n---\r\nText [x](../x.md) text.\r\n',
    )
  })

  it('returns the input unchanged when there is nothing to rewrite', () => {
    const md = '# Plain\n\nNo links here.'
    expect(rewriteLinksForMove(md, 'docs/a.md', 'docs/b/a.md')).toBe(md)
  })

  describe('in a folder move', () => {
    const folder = { from: 'docs/projects', to: 'docs/archive/projects' }
    const move = (md: string, file = 'plan.md') =>
      rewriteLinksForMove(md, `${folder.from}/${file}`, `${folder.to}/${file}`, folder)

    it('keeps links to files that moved with it byte for byte', () => {
      const md =
        '[spec](spec.md) [deep](sub/notes.md#n) ![d](img/d.png) [ref][s] [here](./) [self](plan.md)\n\n[s]: <spec.md> "Spec"\n'
      expect(move(md)).toBe(md)
      expect(move('[up](../plan.md)', 'sub/notes.md')).toBe('[up](../plan.md)')
    })

    it('still rewrites links to files outside the folder', () => {
      expect(move('[spec](spec.md) [readme](../../README.md) ![c](../../assets/c.png)')).toBe(
        '[spec](spec.md) [readme](../../../README.md) ![c](../../../assets/c.png)',
      )
    })

    it('does not treat a folder that only shares a prefix as moved', () => {
      expect(move('[x](../projects-old/x.md)')).toBe('[x](../../projects-old/x.md)')
    })
  })
})

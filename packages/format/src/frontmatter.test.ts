import { describe, expect, it } from 'vitest'
import { ensureId, FrontmatterError, parseFrontmatter, patchFrontmatter } from './frontmatter.js'
import { isId } from './ids.js'

const doc = `---
id: 01JA2Z8Q4M7V3K9R5T1XWYB6CD
title: Q4 plan
created: 2026-10-07T14:03:00Z
tags: [planning]
---

# Q4 plan
`

describe('parseFrontmatter', () => {
  it('splits data, the raw YAML, and the body', () => {
    expect(parseFrontmatter(doc)).toEqual({
      data: {
        id: '01JA2Z8Q4M7V3K9R5T1XWYB6CD',
        title: 'Q4 plan',
        created: '2026-10-07T14:03:00Z',
        tags: ['planning'],
      },
      yamlText:
        'id: 01JA2Z8Q4M7V3K9R5T1XWYB6CD\ntitle: Q4 plan\ncreated: 2026-10-07T14:03:00Z\ntags: [planning]\n',
      body: '\n# Q4 plan\n',
    })
  })

  it('treats a file without frontmatter as all body', () => {
    expect(parseFrontmatter('# Hello\n')).toEqual({ data: {}, yamlText: null, body: '# Hello\n' })
    expect(parseFrontmatter('')).toEqual({ data: {}, yamlText: null, body: '' })
  })

  it('reads an empty block', () => {
    expect(parseFrontmatter('---\n---\nBody')).toEqual({ data: {}, yamlText: '', body: 'Body' })
  })

  it('needs both delimiters, each alone on its line', () => {
    expect(parseFrontmatter('---\ntitle: x\n').yamlText).toBeNull()
    expect(parseFrontmatter('----\ntitle: x\n----\n').yamlText).toBeNull()
    expect(parseFrontmatter(' ---\ntitle: x\n---\n').yamlText).toBeNull()
    expect(parseFrontmatter('---\ntitle: x\n--- \n').data).toEqual({ title: 'x' })
  })

  it('ends at the first closing line, so a body can start with a horizontal rule', () => {
    const parsed = parseFrontmatter('---\ntitle: x\n---\n---\nText\n')
    expect(parsed.data).toEqual({ title: 'x' })
    expect(parsed.body).toBe('---\nText\n')
  })

  it('keeps dates, timestamps, and ids as strings', () => {
    const { data } = parseFrontmatter('---\ndue: 2026-12-01\nat: 2026-10-07T14:03:00Z\n---\n')
    expect(data).toEqual({ due: '2026-12-01', at: '2026-10-07T14:03:00Z' })
  })

  it('returns empty data for invalid or non-mapping YAML instead of throwing', () => {
    expect(parseFrontmatter('---\ntitle: a: b\n---\nBody').data).toEqual({})
    expect(parseFrontmatter('---\n- a\n- b\n---\n').data).toEqual({})
    expect(parseFrontmatter('---\njust prose\n---\n').yamlText).toBe('just prose\n')
  })

  it('handles CRLF line endings', () => {
    const parsed = parseFrontmatter('---\r\ntitle: Win\r\n---\r\nBody\r\n')
    expect(parsed).toEqual({ data: { title: 'Win' }, yamlText: 'title: Win\r\n', body: 'Body\r\n' })
  })

  it('finds frontmatter after a byte order mark and leaves the mark out of the body', () => {
    expect(parseFrontmatter('\uFEFF---\ntitle: x\n---\nBody').data).toEqual({ title: 'x' })
    expect(parseFrontmatter('\uFEFF# Hi').body).toBe('# Hi')
  })
})

describe('patchFrontmatter', () => {
  it('replaces one value on its own line', () => {
    expect(patchFrontmatter(doc, { title: 'Q5 plan' })).toBe(
      doc.replace('title: Q4 plan', 'title: Q5 plan'),
    )
  })

  it('deletes a key with undefined', () => {
    expect(patchFrontmatter(doc, { created: undefined })).toBe(
      doc.replace('created: 2026-10-07T14:03:00Z\n', ''),
    )
  })

  it('appends new keys at the end in patch order', () => {
    expect(patchFrontmatter(doc, { b: 1, a: true })).toBe(
      doc.replace('---\n\n', 'b: 1\na: true\n---\n\n'),
    )
  })

  it('returns the same text when nothing changes', () => {
    expect(patchFrontmatter(doc, {})).toBe(doc)
    expect(patchFrontmatter(doc, { title: 'Q4 plan', tags: ['planning'], gone: undefined })).toBe(
      doc,
    )
    const nested = '---\nmodels: {b: 2, a: 1}\nlist:\n  - x\n---\n'
    expect(patchFrontmatter(nested, { models: { a: 1, b: 2 }, list: ['x'] })).toBe(nested)
  })

  it('treats a changed type as a change', () => {
    expect(patchFrontmatter('---\nn: 1\n---\n', { n: '1' })).toBe('---\nn: "1"\n---\n')
  })

  it('applies replacements, deletions, and additions in one pass', () => {
    const text = '---\na: 1\nb: 2\nc: 3\n---\n'
    expect(patchFrontmatter(text, { c: 30, a: undefined, d: 4 })).toBe(
      '---\nb: 2\nc: 30\nd: 4\n---\n',
    )
  })

  it('gives a file without frontmatter a minimal block and leaves its text alone', () => {
    expect(patchFrontmatter('# Hello\n\nWorld\n', { id: 'X' })).toBe(
      '---\nid: X\n---\n# Hello\n\nWorld\n',
    )
    expect(patchFrontmatter('', { id: 'X' })).toBe('---\nid: X\n---\n')
    expect(patchFrontmatter('# Hello\n', { id: undefined })).toBe('# Hello\n')
  })

  it('matches CRLF when adding a block to a file without one', () => {
    expect(patchFrontmatter('# Hi\r\nthere\r\n', { id: 'X', tags: ['a'] })).toBe(
      '---\r\nid: X\r\ntags:\r\n  - a\r\n---\r\n# Hi\r\nthere\r\n',
    )
  })

  it('keeps CRLF in patched, added, and multi-line values', () => {
    const text = '---\r\ntitle: Old\r\nkeep: 1\r\n---\r\nBody\r\n'
    expect(patchFrontmatter(text, { title: 'New', notes: 'one\ntwo' })).toBe(
      '---\r\ntitle: New\r\nkeep: 1\r\nnotes: |-\r\n  one\r\n  two\r\n---\r\nBody\r\n',
    )
  })

  it('never adds a trailing newline the file did not have', () => {
    expect(patchFrontmatter('---\na: 1\n---\nlast line', { a: 2 })).toBe(
      '---\na: 2\n---\nlast line',
    )
    expect(patchFrontmatter('---\na: 1\n---', { a: 2 })).toBe('---\na: 2\n---')
  })

  it('fills an empty block', () => {
    expect(patchFrontmatter('---\n---\nBody\n', { id: 'X' })).toBe('---\nid: X\n---\nBody\n')
  })

  it('adds keys after a comment-only block', () => {
    expect(patchFrontmatter('---\n# todo\n---\n', { id: 'X' })).toBe('---\n# todo\nid: X\n---\n')
  })

  it('leaves an empty block when every key is deleted', () => {
    expect(patchFrontmatter('---\na: 1\n---\nBody', { a: undefined })).toBe('---\n---\nBody')
  })

  it('keeps comments, quoting, and blank lines around the patched key', () => {
    const text = `---
# About this file
title: "Old title" # shown in the editor
status: 'draft'

owner: dana # who to ask
---
`
    expect(patchFrontmatter(text, { title: 'New title', status: 'final' })).toBe(`---
# About this file
title: "New title" # shown in the editor
status: 'final'

owner: dana # who to ask
---
`)
  })

  it('keeps a sequence in its flow, block, or flush style', () => {
    expect(patchFrontmatter('---\ntags: [a]\n---\n', { tags: ['a', 'b'] })).toBe(
      '---\ntags: [a, b]\n---\n',
    )
    expect(patchFrontmatter('---\ntags:\n  - a\nx: 1\n---\n', { tags: ['a', 'b'] })).toBe(
      '---\ntags:\n  - a\n  - b\nx: 1\n---\n',
    )
    expect(patchFrontmatter('---\ntags:\n- a\nx: 1\n---\n', { tags: ['a', 'b'] })).toBe(
      '---\ntags:\n- a\n- b\nx: 1\n---\n',
    )
  })

  it('replaces and deletes multi-line values whole', () => {
    const text = `---
people:
  - name: Dana
    roles: [ops]
  - name: Sam
notes: |
  first
  second
after: 1
---
`
    expect(patchFrontmatter(text, { people: ['Dana'], notes: undefined })).toBe(`---
people:
  - Dana
after: 1
---
`)
  })

  it('quotes values that would otherwise read back differently', () => {
    const values = ['Q4: plan', '#hashtag', 'true', '01234', 'null', '', ' padded ', 'a\nb']
    for (const value of values) {
      const out = patchFrontmatter('---\nx: 1\n---\n', { x: value, y: value })
      expect(parseFrontmatter(out).data).toEqual({ x: value, y: value })
    }
  })

  it('keeps the indentation of an indented top-level mapping', () => {
    expect(patchFrontmatter('---\n  a: 1\n  b: 2\n---\n', { b: 3, c: [1] })).toBe(
      '---\n  a: 1\n  b: 3\n  c:\n    - 1\n---\n',
    )
  })

  it('keeps the byte order mark when adding a block', () => {
    expect(patchFrontmatter('\uFEFF# Hi\n', { id: 'X' })).toBe('\uFEFF---\nid: X\n---\n# Hi\n')
  })

  it('refuses frontmatter it cannot patch in place', () => {
    expect(() => patchFrontmatter('---\ntitle: a: b\n---\n', { id: 'X' })).toThrow(FrontmatterError)
    expect(() => patchFrontmatter('---\n- a\n---\n', { id: 'X' })).toThrow(/not a YAML mapping/)
    expect(() => patchFrontmatter('---\n{a: 1}\n---\n', { id: 'X' })).toThrow(/Flow-style/)
    expect(() => patchFrontmatter('---\na: 1\na: 2\n---\n', { id: 'X' })).toThrow(FrontmatterError)
  })
})

describe('ensureId', () => {
  it('adds an id to a file without one', () => {
    const result = ensureId('# Notes\n')
    expect(result.added).toBe(true)
    expect(isId(result.id)).toBe(true)
    expect(result.text).toBe(`---\nid: ${result.id}\n---\n# Notes\n`)
  })

  it('keeps an existing id and returns the text untouched', () => {
    expect(ensureId(doc)).toEqual({ text: doc, id: '01JA2Z8Q4M7V3K9R5T1XWYB6CD', added: false })
  })

  it('keeps an id that is not a ULID rather than overwrite it', () => {
    const text = '---\nid: my-own-id\n---\n'
    expect(ensureId(text)).toEqual({ text, id: 'my-own-id', added: false })
  })

  it('fills an empty id in place', () => {
    const result = ensureId('---\nid:\ntitle: x\n---\n')
    expect(result.added).toBe(true)
    expect(result.text).toBe(`---\nid: ${result.id}\ntitle: x\n---\n`)
  })
})

import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  chunkMarkdown,
  ensureId,
  extractLinks,
  extractTitle,
  parseFrontmatter,
  patchFrontmatter,
} from '../src/index.js'

const dir = new URL('./corpus/', import.meta.url)
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.md'))
  .sort()

const read = (file: string) => readFileSync(new URL(file, dir), 'utf8')
const hasLoneLf = (s: string) => /(^|[^\r])\n/.test(s)
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Lines of `before` that differ from `after`, after removing the common first and last lines. */
function changedLines(before: string, after: string): { removed: string[]; added: string[] } {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  return { removed: a.slice(start, endA), added: b.slice(start, endB) }
}

describe('corpus', () => {
  it('has the cases the format has to survive', () => {
    expect(files.length).toBeGreaterThanOrEqual(10)
    // Guards against a checkout that normalized line endings or dropped the BOM.
    expect(read('crlf.md')).toContain('\r\n')
    expect(read('bom.md').startsWith('﻿')).toBe(true)
    expect(read('no-trailing-newline.md').endsWith('\n')).toBe(false)
  })

  describe.each(files)('%s', (file) => {
    const text = read(file)
    const { data, yamlText, body } = parseFrontmatter(text)
    const keys = Object.keys(data)

    it('keeps the body as the tail of the file', () => {
      expect(text.endsWith(body)).toBe(true)
      if (yamlText !== null) expect(text).toContain(yamlText)
    })

    it('returns the text byte-for-byte for a patch that changes nothing', () => {
      expect(patchFrontmatter(text, {})).toBe(text)
      expect(patchFrontmatter(text, { not_there: undefined })).toBe(text)
      expect(patchFrontmatter(text, Object.fromEntries(keys.map((k) => [k, data[k]])))).toBe(text)
    })

    it('adds a key without touching anything else', () => {
      const out = patchFrontmatter(text, { hearth_added: 'yes it is' })
      const parsed = parseFrontmatter(out)
      expect(parsed.data).toEqual({ ...data, hearth_added: 'yes it is' })
      expect(Object.keys(parsed.data)).toEqual([...keys, 'hearth_added'])
      expect(parsed.body).toBe(body)
      expect(hasLoneLf(out)).toBe(hasLoneLf(text))
      expect(out.endsWith('\n')).toBe(text.endsWith('\n'))
      expect(out.startsWith('﻿')).toBe(text.startsWith('﻿'))
      if (yamlText !== null) {
        const { removed, added } = changedLines(text, out)
        expect(removed).toEqual([])
        expect(added.map((l) => l.trimEnd())).toEqual(['hearth_added: yes it is'])
      }
    })

    it.skipIf(yamlText === null)('removing an added key restores the original', () => {
      const added = patchFrontmatter(text, { hearth_added: 'x', hearth_other: [1, 2] })
      expect(patchFrontmatter(added, { hearth_added: undefined, hearth_other: undefined })).toBe(
        text,
      )
    })

    it.skipIf(keys.length === 0)('changes only the lines of the key it patches', () => {
      for (const key of keys) {
        const out = patchFrontmatter(text, { [key]: 'patched' })
        const parsed = parseFrontmatter(out)
        expect(parsed.data).toEqual({ ...data, [key]: 'patched' })
        expect(Object.keys(parsed.data)).toEqual(keys)
        expect(parsed.body).toBe(body)
        expect(hasLoneLf(out)).toBe(hasLoneLf(text))

        const { removed, added } = changedLines(text, out)
        const keyLine = new RegExp(`^\\s*["']?${escapeRegExp(key)}["']?\\s*:`)
        expect(removed[0]).toMatch(keyLine)
        expect(added).toHaveLength(1)
        expect(added[0]).toMatch(keyLine)
        // Nothing past the first removed line is another top-level key.
        for (const line of removed.slice(1)) expect(line).not.toMatch(/^[^\s#-][^:]*:(\s|$)/)
      }
    })

    it.skipIf(keys.length === 0)('deletes a key by removing only its lines', () => {
      for (const key of keys) {
        const out = patchFrontmatter(text, { [key]: undefined })
        const parsed = parseFrontmatter(out)
        const { [key]: _removed, ...rest } = data
        expect(parsed.data).toEqual(rest)
        expect(parsed.body).toBe(body)
        expect(changedLines(text, out).added).toEqual([])
      }
    })

    it('ensureId adds an id once and then keeps it', () => {
      const first = ensureId(text)
      expect(first.added).toBe(typeof data.id !== 'string')
      const second = ensureId(first.text)
      expect(second).toEqual({ text: first.text, id: first.id, added: false })
      expect(parseFrontmatter(first.text).body).toBe(body)
    })

    it('chunks into exact slices of the source', () => {
      for (const chunk of chunkMarkdown(text, 80)) {
        expect(text.slice(chunk.from, chunk.to)).toBe(chunk.text)
        expect(chunk.text.length).toBeLessThanOrEqual(80)
      }
    })

    it('reports links at their exact source ranges', () => {
      for (const link of extractLinks(text)) {
        const source = text.slice(link.from, link.to)
        expect(source).toContain(link.text)
      }
    })

    it('finds a title', () => {
      const expected: Record<string, string | null> = {
        'comment-only-frontmatter.md': 'Only a comment',
        'flush-sequences.md': 'Flush lists',
        'readme-no-frontmatter.md': 'Acme tools',
        'starts-with-rule.md': null,
      }
      const title = extractTitle(text)
      if (file in expected) expect(title).toBe(expected[file])
      else expect(title).toEqual(expect.any(String))
    })
  })
})

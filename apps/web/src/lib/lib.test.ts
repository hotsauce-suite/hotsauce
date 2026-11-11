import { extractTitle, newDoc, parseFrontmatter } from '@hearth/format'
import { describe, expect, it, vi } from 'vitest'
import { clearDrafts, draftKey, findDraft, saveDraft } from './drafts'
import { firstHeading, NEW_DOC_TITLE, propertyList, renameTarget, syncTitle } from './format'
import { hasConflictMarkers, merge3 } from './merge3'
import { docUrl, fileUrl, openExternal } from './paths'
import { parseUnifiedDiff } from './unifiedDiff'

const BASE = 'a\nb\nc\nd\ne\n'

describe('merge3', () => {
  it('merges edits separated by an untouched line', () => {
    expect(merge3(BASE, 'A\nb\nc\nd\ne\n', 'a\nb\nc\nD\ne\n')).toEqual({
      clean: true,
      text: 'A\nb\nc\nD\ne\n',
    })
  })

  it('takes the only side that changed', () => {
    expect(merge3(BASE, BASE, 'x\n')).toEqual({ clean: true, text: 'x\n' })
    expect(merge3(BASE, 'y\n', BASE)).toEqual({ clean: true, text: 'y\n' })
  })

  it('accepts identical edits on both sides', () => {
    expect(merge3(BASE, 'a\nB\nc\nd\ne\n', 'a\nB\nc\nd\ne\n')).toEqual({
      clean: true,
      text: 'a\nB\nc\nd\ne\n',
    })
  })

  it('conflicts on the same or adjacent lines, with markers around the region', () => {
    const same = merge3(BASE, 'a\nB1\nc\nd\ne\n', 'a\nB2\nc\nd\ne\n')
    expect(same.clean).toBe(false)
    if (same.clean) return
    expect(same.withMarkers).toBe('a\n<<<<<<< mine\nB1\n=======\nB2\n>>>>>>> theirs\nc\nd\ne\n')
    expect(hasConflictMarkers(same.withMarkers)).toBe(true)
    expect(merge3(BASE, 'a\nB\nc\nd\ne\n', 'a\nb\nC\nd\ne\n').clean).toBe(false)
  })
})

describe('paths', () => {
  it('builds app URLs with encoded segments', () => {
    expect(docUrl('team', 'docs/q4 plan.md')).toBe('/docs/team/docs/q4%20plan.md')
  })
})

describe('format helpers', () => {
  it('lists properties for display in file order', () => {
    const { data } = parseFrontmatter(
      '---\ntitle: Plan\ntags: [a, "b"]\nowners:\n  - sam\n  - priya\nreview: { by: sam }\n---\n',
    )
    expect(propertyList(data)).toEqual([
      { key: 'title', value: 'Plan' },
      { key: 'tags', value: ['a', 'b'] },
      { key: 'owners', value: ['sam', 'priya'] },
      { key: 'review', value: '{"by":"sam"}' },
    ])
  })

  it('reads the first H1 even when frontmatter has a title', () => {
    expect(firstHeading('---\ntitle: From YAML\n---\n\n# From H1\n')).toBe('From H1')
    expect(firstHeading('No heading here\n')).toBeNull()
  })

  it('carries a retitled heading into frontmatter title, touching only that line', () => {
    const { text: base } = newDoc(NEW_DOC_TITLE)
    const typed = base.replace('# Untitled', '# Q4 plan')
    const synced = syncTitle(base, typed)
    expect(extractTitle(synced)).toBe('Q4 plan')
    expect(synced).toBe(typed.replace('title: Untitled', 'title: Q4 plan'))
  })

  it('offers the new title’s file name only after the title changes', () => {
    expect(renameTarget('docs/plans/untitled.md', 'Untitled', 'Q4 plan: draft')).toBe(
      'docs/plans/q4-plan-draft.md',
    )
    // Opened as is, a name that never matched its title is left alone.
    expect(renameTarget('docs/notes-2024.md', 'Notes', 'Notes')).toBeNull()
    expect(renameTarget('docs/notes-2024.md', 'Notes', null)).toBeNull()
    // Back to a title whose slug is the file name: nothing to offer.
    expect(renameTarget('docs/q4-plan.md', 'Q4 plan (old)', 'Q4 Plan')).toBeNull()
  })

  it('leaves a title that differed from the heading, or a doc with no title key', () => {
    const apart = '---\ntitle: Board memo\n---\n\n# Draft\n'
    expect(syncTitle(apart, apart.replace('# Draft', '# Draft two'))).toBe(
      apart.replace('# Draft', '# Draft two'),
    )
    const untitled = '---\nid: X\n---\n\n# Notes\n'
    expect(syncTitle(untitled, untitled.replace('# Notes', '# Notes v2'))).toBe(
      untitled.replace('# Notes', '# Notes v2'),
    )
  })
})

describe('drafts', () => {
  it('keeps one draft per file, keyed by the version it was edited from', () => {
    saveDraft('team', 'docs/a.md', 'blob1', 'first')
    saveDraft('team', 'docs/a.md', 'blob2', 'second')
    expect(localStorage.getItem(draftKey('team', 'docs/a.md', 'blob1'))).toBeNull()
    expect(findDraft('team', 'docs/a.md')).toMatchObject({ content: 'second', blobOid: 'blob2' })
    expect(findDraft('team', 'docs/a.md.bak')).toBeNull()
    clearDrafts('team', 'docs/a.md')
    expect(findDraft('team', 'docs/a.md')).toBeNull()
  })
})

describe('parseUnifiedDiff', () => {
  it('numbers added, removed and context lines and drops file headers', () => {
    const diff = [
      'diff --git a/x.md b/x.md',
      '--- a/x.md',
      '+++ b/x.md',
      '@@ -2,3 +2,3 @@',
      ' keep',
      '-old',
      '+new',
      ' tail',
      '',
    ].join('\n')
    expect(parseUnifiedDiff(diff)).toEqual([
      { kind: 'hunk', text: '@@ -2,3 +2,3 @@' },
      { kind: 'ctx', text: 'keep', oldNo: 2, newNo: 2 },
      { kind: 'del', text: 'old', oldNo: 3 },
      { kind: 'add', text: 'new', newNo: 3 },
      { kind: 'ctx', text: 'tail', oldNo: 4, newNo: 4 },
    ])
  })
})

describe('openExternal', () => {
  it('opens http, https, mailto and protocol-relative links, and nothing else', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    expect(openExternal('https://example.com/a')).toBe(true)
    expect(openExternal('mailto:a@b.com')).toBe(true)
    expect(openExternal('//example.com')).toBe(true)
    expect(open.mock.calls.map((c) => c[0])).toEqual([
      'https://example.com/a',
      'mailto:a@b.com',
      'https://example.com',
    ])
    for (const bad of [
      'javascript:alert(1)',
      ' JavaScript:alert(1)',
      'data:text/html,x',
      'vbscript:x',
    ]) {
      expect(openExternal(bad)).toBe(false)
    }
    expect(open).toHaveBeenCalledTimes(3)
    open.mockRestore()
  })
})

describe('fileUrl', () => {
  it('opens meeting notes and transcripts in Meetings, everything else in Docs', () => {
    expect(fileUrl('team', 'docs/a b.md')).toBe(docUrl('team', 'docs/a b.md'))
    expect(fileUrl('morgan', 'meetings/2026/11/x.md')).toBe(
      '/meetings/morgan/meetings/2026/11/x.md',
    )
    expect(fileUrl('morgan', 'meetings/2026/11/x.transcript.md')).toBe(
      '/meetings/morgan/meetings/2026/11/x.md',
    )
    expect(fileUrl('morgan', 'meetings/notes.txt')).toBe(docUrl('morgan', 'meetings/notes.txt'))
  })
})

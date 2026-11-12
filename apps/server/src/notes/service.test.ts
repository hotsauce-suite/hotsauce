import { describe, expect, it } from 'vitest'
import { kindOf } from '../index/extract.js'
import { compareNotes, type NoteView, noteName, sortKey } from './service.js'

const note = (over: Partial<NoteView>): NoteView => ({
  space: 'alice',
  path: 'notes/x.md',
  id: 'X',
  blobOid: 'b',
  title: '',
  body: '',
  checklist: false,
  color: null,
  pinned: false,
  archived: false,
  trashed: null,
  labels: [],
  created: '2026-11-12T10:00:00Z',
  createdBy: 'a@example.test',
  updated: '2026-11-12T10:00:00Z',
  order: null,
  source: null,
  ...over,
})

describe('compareNotes', () => {
  it('puts pinned first, then higher order or newer, then id', () => {
    const notes = [
      note({ id: 'A', created: '2026-11-10T00:00:00Z' }),
      note({ id: 'B', created: '2026-11-11T00:00:00Z' }),
      note({ id: 'C', created: '2026-11-01T00:00:00Z', pinned: true }),
      note({ id: 'D', created: '2026-11-01T00:00:00Z', order: Date.parse('2026-11-12T00:00:00Z') }),
    ]
    expect(notes.sort(compareNotes).map((n) => n.id)).toEqual(['C', 'D', 'B', 'A'])
  })

  it('sorts the trash by when notes went there, newest first', () => {
    const notes = [
      note({ id: 'A', trashed: '2026-11-01T00:00:00Z' }),
      note({ id: 'B', trashed: '2026-11-05T00:00:00Z' }),
    ]
    expect(notes.sort(compareNotes).map((n) => n.id)).toEqual(['B', 'A'])
  })

  it('uses created when there is no order', () => {
    expect(sortKey(note({ created: '2026-11-12T10:00:00Z' }))).toBe(
      Date.parse('2026-11-12T10:00:00Z'),
    )
    expect(sortKey(note({ order: 5 }))).toBe(5)
  })
})

describe('noteName', () => {
  it('is the title, else the first line without its checkbox, cut at 60', () => {
    expect(noteName('Plan', 'x')).toBe('Plan')
    expect(noteName('', '\n- [x] buy milk\nmore')).toBe('buy milk')
    expect(noteName('', '')).toBe('Untitled note')
    expect(noteName('', 'a'.repeat(80))).toHaveLength(60)
  })
})

describe('kindOf', () => {
  it('is note for files under notes/', () => {
    expect(kindOf('notes/01JABC.md')).toBe('note')
  })
})

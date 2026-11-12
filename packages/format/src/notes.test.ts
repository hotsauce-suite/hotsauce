import { describe, expect, it } from 'vitest'
import { parseFrontmatter, patchFrontmatter } from './frontmatter.js'
import {
  checklistText,
  checklistToText,
  cleanLabels,
  isChecklist,
  keepColor,
  mapKeepNote,
  NoteFrontmatter,
  newNoteFile,
  noteIdOf,
  notePath,
  noteTextOf,
  parseChecklist,
  textToChecklist,
  toggleChecklistItem,
} from './notes.js'

describe('note files', () => {
  it('writes notes/<id>.md with only the fields that are set', () => {
    const f = newNoteFile({
      title: '  Groceries\n list ',
      body: '- [ ] milk\n- [x] eggs',
      color: 'yellow',
      pinned: true,
      labels: ['home', ' Home ', ''],
      createdBy: 'Ada@Example.test',
      created: '2026-11-12T10:00:00Z',
    })
    expect(f.path).toBe(notePath(f.id))
    expect(noteIdOf(f.path)).toBe(f.id)
    const { data, body } = parseFrontmatter(f.text)
    const fm = NoteFrontmatter.parse(data)
    expect(fm).toMatchObject({
      type: 'note',
      title: 'Groceries list',
      color: 'yellow',
      pinned: true,
      labels: ['home'],
      created: '2026-11-12T10:00:00Z',
      updated: '2026-11-12T10:00:00Z',
      created_by: 'ada@example.test',
    })
    expect(fm.archived).toBeUndefined()
    expect('archived' in data).toBe(false)
    expect(body).toBe('\n- [ ] milk\n- [x] eggs\n')
    expect(noteTextOf(body)).toBe('- [ ] milk\n- [x] eggs')
  })

  it('leaves the title out when there is none', () => {
    const f = newNoteFile({ body: 'just text', createdBy: 'a@example.test' })
    expect('title' in parseFrontmatter(f.text).data).toBe(false)
  })

  it('reads an unknown color as the default and keeps unknown keys', () => {
    const fm = NoteFrontmatter.parse({
      id: 'x',
      type: 'note',
      color: 'chartreuse',
      created: 'c',
      created_by: 'b',
      extra: 1,
    })
    expect(fm.color).toBeUndefined()
    expect(fm.extra).toBe(1)
  })

  it('patches a hand-edited file without rewriting the rest', () => {
    const f = newNoteFile({ title: 'T', body: 'hi', createdBy: 'a@example.test' })
    const edited = f.text.replace('type: note', 'type: note # mine')
    const patched = patchFrontmatter(edited, { pinned: true })
    expect(patched).toContain('type: note # mine')
    expect(parseFrontmatter(patched).data.pinned).toBe(true)
  })

  it('only takes notes/<ULID>.md as a note path', () => {
    expect(noteIdOf('notes/readme.md')).toBeNull()
    expect(noteIdOf('notes/sub/01JABCDEFGHJKMNPQRSTVWXYZ0.md')).toBeNull()
  })
})

describe('checklists', () => {
  it('parses a body of only checklist lines', () => {
    expect(parseChecklist('- [ ] milk\n\n* [X] eggs\n- [ ]')).toEqual([
      { text: 'milk', checked: false },
      { text: 'eggs', checked: true },
      { text: '', checked: false },
    ])
  })

  it('is not a checklist with any other line, or when empty', () => {
    expect(parseChecklist('- [ ] milk\nbuy soon')).toBeNull()
    expect(parseChecklist('')).toBeNull()
    expect(isChecklist('plain')).toBe(false)
  })

  it('round-trips text and checklist without losing words', () => {
    const items = textToChecklist('milk\n- eggs\n2. bread\n\n')
    expect(items).toEqual([
      { text: 'milk', checked: false },
      { text: 'eggs', checked: false },
      { text: 'bread', checked: false },
    ])
    expect(checklistText(items)).toBe('- [ ] milk\n- [ ] eggs\n- [ ] bread')
    expect(checklistToText(items)).toBe('milk\neggs\nbread')
    expect(textToChecklist('- [x] done')).toEqual([{ text: 'done', checked: true }])
    // A mixed note keeps its ticks rather than turning `[ ]` into words.
    expect(textToChecklist('intro\n- [x] milk\n- [ ] eggs')).toEqual([
      { text: 'intro', checked: false },
      { text: 'milk', checked: true },
      { text: 'eggs', checked: false },
    ])
  })

  it('writes an item on one line', () => {
    expect(checklistText([{ text: 'a\nb', checked: true }])).toBe('- [x] a b')
  })

  it('ticks one item and leaves the rest alone', () => {
    const text = '- [ ] a\n- [ ] b\n- [x] c'
    expect(toggleChecklistItem(text, 1, true)).toBe('- [ ] a\n- [x] b\n- [x] c')
    expect(toggleChecklistItem(text, 2, false)).toBe('- [ ] a\n- [ ] b\n- [ ] c')
  })
})

describe('labels', () => {
  it('trims and de-duplicates case-insensitively', () => {
    expect(cleanLabels([' Work ', 'work', 'Home  ideas', ''])).toEqual(['Work', 'Home ideas'])
  })
})

describe('Google Keep import', () => {
  it('maps a text note with its settings', () => {
    const n = mapKeepNote(
      {
        title: 'Ideas',
        textContent: 'one\r\ntwo',
        color: 'CERULEAN',
        isPinned: true,
        isArchived: false,
        labels: [{ name: 'Work' }],
        createdTimestampUsec: 1_700_000_000_000_000,
        userEditedTimestampUsec: '1700000100000000',
      },
      'Ideas.json',
    )
    expect(n).toMatchObject({
      title: 'Ideas',
      body: 'one\ntwo',
      color: 'darkblue',
      pinned: true,
      labels: ['Work'],
      created: '2023-11-14T22:13:20Z',
      updated: '2023-11-14T22:15:00Z',
      source: { kind: 'import', from: 'keep', ref: 'Ideas.json' },
    })
    expect(n?.archived).toBeUndefined()
  })

  it('maps a list note to a checklist', () => {
    const n = mapKeepNote(
      { listContent: [{ text: 'milk', isChecked: true }, { text: ' eggs ' }, { text: '' }] },
      'a.json',
    )
    expect(n?.body).toBe('- [x] milk\n- [ ] eggs')
    expect(n?.title).toBeUndefined()
  })

  it('keeps links and says how many attachments there were', () => {
    const n = mapKeepNote(
      {
        textContent: 'see',
        annotations: [{ url: 'https://example.test', title: 'Example' }],
        attachments: [{}, {}],
      },
      'b.json',
    )
    expect(n?.body).toBe(
      'see\n\n[Example](https://example.test)\n_Had 2 attachments in Google Keep._',
    )
  })

  it('skips trashed and empty notes', () => {
    expect(mapKeepNote({ textContent: 'x', isTrashed: true }, 'c.json')).toBeNull()
    expect(mapKeepNote({ title: ' ', textContent: '  ' }, 'd.json')).toBeNull()
  })

  it('maps colors', () => {
    expect(keepColor('DEFAULT')).toBeUndefined()
    expect(keepColor('gray')).toBe('gray')
    expect(keepColor(undefined)).toBeUndefined()
  })
})

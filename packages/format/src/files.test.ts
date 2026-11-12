import { describe, expect, it } from 'vitest'
import {
  cleanFileName,
  cleanFolder,
  FileFrontmatter,
  fileIdOf,
  fileMimeType,
  filePointerPath,
  folderAncestors,
  isInFolder,
  MAX_FILE_TEXT_CHARS,
  newFilePointer,
  previewKind,
} from './files.js'
import { parseFrontmatter } from './frontmatter.js'

const SHA = 'a'.repeat(64)

describe('file pointers', () => {
  it('round-trips a new pointer through its frontmatter', () => {
    const p = newFilePointer({
      name: 'Q4 plan.pdf',
      folder: ' Contracts // 2026 ',
      size: 1234,
      sha256: SHA,
      mime: 'application/pdf',
      createdBy: 'Alice@Example.test',
      created: '2026-11-12T07:00:00Z',
      text: 'Hello\r\nworld',
      textStatus: 'extracted',
    })
    expect(p.path).toBe(filePointerPath(p.id))
    expect(fileIdOf(p.path)).toBe(p.id)
    const parsed = parseFrontmatter(p.text)
    const fm = FileFrontmatter.parse(parsed.data)
    expect(fm).toMatchObject({
      type: 'file',
      title: 'Q4 plan.pdf',
      folder: 'Contracts/2026',
      size: 1234,
      key: `files/${p.id}`,
      created_by: 'alice@example.test',
      text: 'extracted',
    })
    expect(parsed.body).toBe('\nHello\nworld\n')
  })

  it('cuts long text and keeps an empty body for none', () => {
    const long = newFilePointer({
      name: 'a.txt',
      folder: '',
      size: 1,
      sha256: SHA,
      mime: 'text/plain',
      createdBy: 'a@b.c',
      text: 'x'.repeat(MAX_FILE_TEXT_CHARS + 50),
      textStatus: 'extracted',
    })
    expect(parseFrontmatter(long.text).body.trim().length).toBe(MAX_FILE_TEXT_CHARS)
    const none = newFilePointer({
      name: 'a.bin',
      folder: '',
      size: 1,
      sha256: SHA,
      mime: 'application/octet-stream',
      createdBy: 'a@b.c',
      text: null,
      textStatus: 'none',
    })
    expect(parseFrontmatter(none.text).body).toBe('\n')
  })

  it('rejects a pointer without a checksum and reads unknown text status as none', () => {
    expect(FileFrontmatter.safeParse({ id: 'x', type: 'file', title: 'a' }).success).toBe(false)
    const fm = FileFrontmatter.parse({
      id: 'x',
      type: 'file',
      title: 'a',
      size: 0,
      sha256: SHA,
      mime: 'text/plain',
      key: 'files/x',
      created: 'now',
      created_by: 'a',
      text: 'weird',
    })
    expect(fm.text).toBe('none')
    expect(fm.folder).toBe('')
  })

  it('only matches files/<ulid>.md', () => {
    expect(fileIdOf('files/abc.md')).toBeNull()
    expect(fileIdOf('docs/01JA2Z8Q4M7V3K9R5T1XWYB6CD.md')).toBeNull()
  })
})

describe('names and folders', () => {
  it('cleans names', () => {
    expect(cleanFileName('../../etc/passwd')).toBe('passwd')
    expect(cleanFileName('a\u0000b  c.txt ')).toBe('ab c.txt')
    expect(cleanFileName('  ')).toBe('Untitled')
    expect(cleanFileName('..')).toBe('Untitled')
  })

  it('cleans folders', () => {
    expect(cleanFolder('/a/./b/../c/')).toBe('a/b/c')
    expect(cleanFolder('')).toBe('')
    expect(cleanFolder('a\\b')).toBe('a/b')
    expect(
      cleanFolder(Array.from({ length: 12 }, (_, i) => `f${i}`).join('/')).split('/'),
    ).toHaveLength(10)
  })

  it('lists ancestors and containment', () => {
    expect(folderAncestors('a/b/c')).toEqual(['a', 'a/b', 'a/b/c'])
    expect(isInFolder('a/b', 'a')).toBe(true)
    expect(isInFolder('ab', 'a')).toBe(false)
    expect(isInFolder('x', '')).toBe(true)
  })
})

describe('types', () => {
  it('trusts the extension first', () => {
    expect(fileMimeType('deck.PPTX', 'application/octet-stream')).toMatch(/presentation/)
    expect(fileMimeType('thing', 'image/x-foo')).toBe('image/x-foo')
    expect(fileMimeType('thing', 'not a type')).toBe('application/octet-stream')
  })

  it('never previews script-capable types', () => {
    expect(previewKind('image/svg+xml')).toBe('none')
    expect(previewKind('text/html')).toBe('none')
    expect(previewKind('image/png')).toBe('image')
    expect(previewKind('application/pdf')).toBe('pdf')
    expect(previewKind('video/mp4')).toBe('video')
    expect(previewKind('audio/mpeg')).toBe('audio')
    expect(previewKind('text/csv')).toBe('text')
  })
})

describe('previewKind', () => {
  it('renders only known-safe images, whatever the case or parameters', () => {
    expect(previewKind('image/png')).toBe('image')
    expect(previewKind('IMAGE/PNG; x=1')).toBe('image')
    expect(previewKind('image/svg+xml')).toBe('none')
    expect(previewKind('image/svg+xml;x')).toBe('none')
    expect(previewKind('image/x-anything')).toBe('none')
    expect(previewKind('text/html')).toBe('none')
    expect(previewKind('application/pdf; q=1')).toBe('pdf')
    expect(previewKind('text/plain;charset=utf-8')).toBe('text')
  })
})

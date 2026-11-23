import { describe, expect, it, vi } from 'vitest'
import type { DriveFile } from '../api/files'
import { droppedName, installMacOpenFiles, openDroppedFiles } from './macOpenFiles'

const b64 = (s: string) => btoa(s)
const PDF = b64('%PDF-1.4 fake')

let n = 0
function deps(personal: string | null = 'alice') {
  const uploads: Array<{ name: string; type: string; target: unknown }> = []
  return {
    uploads,
    personalSpace: async () => personal,
    upload: async (file: Blob & { name: string }, target: { space: string; folder: string }) => {
      uploads.push({ name: file.name, type: file.type, target })
      const id = `ID${++n}`
      return { id, url: `/files/alice/${id}` } as DriveFile
    },
  }
}

describe('files dropped on the Mac app (R10)', () => {
  it('uploads one PDF to Personal files and opens it in PDF tools', async () => {
    const d = deps()
    const answer = await openDroppedFiles(d, [{ name: 'scan.pdf', base64: PDF }])
    expect(d.uploads).toEqual([
      { name: 'scan.pdf', type: 'application/pdf', target: { space: 'alice', folder: '' } },
    ])
    expect(answer).toEqual({ ok: true, opened: 1, path: `/files/alice/ID${n}?tools=pages` })
  })

  it('opens several PDFs together on Pages, in the order dropped', async () => {
    const d = deps()
    const answer = await openDroppedFiles(d, [
      { name: 'a.pdf', base64: PDF },
      { name: 'notes.txt', base64: b64('hello') },
      { name: 'b.pdf', base64: PDF },
    ])
    expect(d.uploads.map((u) => u.name)).toEqual(['a.pdf', 'notes.txt', 'b.pdf'])
    expect(answer).toEqual({
      ok: true,
      opened: 3,
      path: `/files/alice/ID${n - 2}?tools=pages&with=ID${n}`,
    })
  })

  it('shows Personal files when nothing dropped is a PDF', async () => {
    const answer = await openDroppedFiles(deps(), [{ name: 'photo.png', base64: b64('png') }])
    expect(answer).toMatchObject({ ok: true, path: '/files?space=alice' })
  })

  it('refuses when nobody is signed in, and anything malformed', async () => {
    expect(await openDroppedFiles(deps(null), [{ name: 'a.pdf', base64: PDF }])).toMatchObject({
      ok: false,
      error: expect.stringContaining('Sign in'),
    })
    expect(await openDroppedFiles(deps(), [])).toMatchObject({ ok: false })
    expect(await openDroppedFiles(deps(), 'nope')).toMatchObject({ ok: false })
    expect(await openDroppedFiles(deps(), [{ name: 'a.pdf', base64: '%%%' }])).toMatchObject({
      ok: false,
    })
    const many = Array.from({ length: 21 }, () => ({ name: 'a.pdf', base64: PDF }))
    expect(await openDroppedFiles(deps(), many)).toMatchObject({ ok: false })
  })

  it('cleans up names', () => {
    expect(droppedName('../../etc/passwd')).toBe('.. .. etc passwd')
    expect(droppedName(42)).toBe('Dropped file')
  })

  it('puts the function where the app looks, and goes to the page it answers', async () => {
    const go = vi.fn()
    const remove = installMacOpenFiles(() => deps(), go)
    const hooks = (window as { hotsauceMac?: { openFiles?: (f: unknown) => Promise<unknown> } })
      .hotsauceMac
    expect(await hooks?.openFiles?.([{ name: 'a.pdf', base64: PDF }])).toMatchObject({ ok: true })
    expect(go).toHaveBeenCalledWith(expect.stringContaining('?tools=pages'))
    remove()
    expect(hooks?.openFiles).toBeUndefined()
  })
})

import { isId } from '@hearth/format'
import { describe, expect, it } from 'vitest'
import { filesApi, uploadFile } from '../api/files'
import { mockApi } from '../test/mockServer'

async function bytesAt(url: string): Promise<{ type: string; bytes: Uint8Array }> {
  const res = await fetch(new URL(url, window.location.origin))
  return {
    type: res.headers.get('content-type') ?? '',
    bytes: new Uint8Array(await res.arrayBuffer()),
  }
}

describe('mock files', () => {
  it('lists the seeded team folders and files', async () => {
    const root = await filesApi.list('team')
    expect(root.folders).toEqual(['Brand', 'Pilot launch', 'Research'])
    expect(root.files.map((f) => f.name)).toEqual(['Hotsauce logo.svg'])
    expect(root.files.every((f) => isId(f.id))).toBe(true)
    const launch = await filesApi.list('team', 'Pilot launch')
    expect(launch.files.map((f) => [f.name, f.preview])).toEqual([
      ['Acme pilot one-pager.pdf', 'pdf'],
      ['Launch checklist.md', 'text'],
      ['Pilot sign-ups by week.png', 'image'],
    ])
  })

  it('serves real bytes with the right type for previews', async () => {
    const launch = await filesApi.list('team', 'Pilot launch')
    const png = launch.files.find((f) => f.preview === 'image')
    const pdf = launch.files.find((f) => f.preview === 'pdf')
    const image = await bytesAt(png?.contentUrl ?? '')
    expect(image.type).toBe('image/png')
    expect([...image.bytes.slice(1, 4)]).toEqual([80, 78, 71]) // "PNG"
    expect(image.bytes.length).toBe(png?.size)
    const doc = await bytesAt(pdf?.contentUrl ?? '')
    expect(doc.type).toBe('application/pdf')
    const text = new TextDecoder().decode(doc.bytes)
    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
    const download = await bytesAt(pdf?.downloadUrl ?? '')
    expect(download.type).toBe('application/octet-stream')
    const md = launch.files.find((f) => f.preview === 'text')
    const withText = await filesApi.text('team', md?.id ?? '')
    expect(withText.text).toContain('Pilot launch checklist')
  })

  it('uploads in chunks and keeps the bytes', async () => {
    mockApi().files.chunkBytes = 1000
    const size = 2500
    const data = new Uint8Array(size).map((_, i) => i % 251)
    const progress: number[] = []
    const stored = await uploadFile(
      Object.assign(new Blob([data], { type: 'text/plain' }), { name: 'big notes.txt' }),
      { space: 'team', folder: 'Research' },
      { onProgress: (p) => progress.push(p.sent) },
    )
    expect(stored).toMatchObject({ name: 'big notes.txt', folder: 'Research', size })
    expect(progress).toEqual([0, 1000, 2000, 2500])
    const back = await bytesAt(stored.downloadUrl)
    expect(back.bytes).toEqual(data)
    expect((await filesApi.recent())[0]?.id).toBe(stored.id)
  })

  it('renames, moves, shares, searches and deletes', async () => {
    const research = (await filesApi.list('team', 'Research')).files
    const id = research.find((f) => f.name.startsWith('Site interviews'))?.id ?? ''
    const renamed = await filesApi.update('team', id, { name: 'Interviews.txt', folder: 'Brand' })
    expect(renamed).toMatchObject({ name: 'Interviews.txt', folder: 'Brand' })
    expect((await filesApi.list('team', '', 'interv')).files.map((f) => f.id)).toEqual([id])

    const shared = await filesApi.share('team', id, true)
    expect(shared.shareUrl).toMatch(/^\/files\/s\//)
    const token = shared.shareToken ?? ''
    expect((await filesApi.shared(token)).name).toBe('Interviews.txt')
    await filesApi.share('team', id, false)
    await expect(filesApi.shared(token)).rejects.toMatchObject({ status: 404 })

    // Sam uploaded the survey export: only he may make it private.
    const survey = research.find((f) => f.name === 'Pilot survey export.csv')
    await expect(filesApi.move('team', survey?.id ?? '', 'ada')).rejects.toMatchObject({
      status: 403,
    })

    await filesApi.remove('team', id)
    await expect(filesApi.get('team', id)).rejects.toMatchObject({ status: 404 })
  })

  it('makes, renames and removes folders', async () => {
    await filesApi.createFolder('team', 'Pilot launch/Week 1')
    expect((await filesApi.list('team', 'Pilot launch')).folders).toEqual(['Pilot launch/Week 1'])
    await filesApi.renameFolder('team', 'Pilot launch', 'Launch')
    const moved = await filesApi.list('team', 'Launch')
    expect(moved.folders).toEqual(['Launch/Week 1'])
    expect(moved.files).toHaveLength(3)
    await filesApi.removeFolder('team', 'Launch')
    expect((await filesApi.list('team')).folders).toEqual(['Brand', 'Research'])
  })
})

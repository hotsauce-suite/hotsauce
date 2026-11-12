import { describe, expect, it } from 'vitest'
import { makeZip } from '../../test/zip'
import { keepRefOf, parseKeepFiles, readKeepExport, readKeepZip } from './keepTakeout'
import { columnsFor, dealColumns } from './logic'

const note = (text: string) => JSON.stringify({ textContent: text, createdTimestampUsec: 1 })

describe('reading a Takeout zip', () => {
  it('reads only the Keep note files, stored or deflated', async () => {
    const zip = makeZip([
      { name: 'Takeout/Keep/Groceries.json', text: note('milk'), deflate: true },
      { name: 'Takeout/Keep/Idea.json', text: note('thought') },
      { name: 'Takeout/Keep/photo.jpg', text: 'binary' },
      { name: 'Takeout/Drive/other.json', text: note('not keep') },
      { name: 'Takeout/Keep/Labels.txt', text: 'Home' },
    ])
    const files = await readKeepZip(new Blob([zip]))
    expect(files.map((f) => f.name)).toEqual([
      'Takeout/Keep/Groceries.json',
      'Takeout/Keep/Idea.json',
    ])
    expect(parseKeepFiles(files)).toEqual([
      { ref: 'Groceries.json', note: expect.objectContaining({ textContent: 'milk' }) },
      { ref: 'Idea.json', note: expect.objectContaining({ textContent: 'thought' }) },
    ])
  })

  it('takes loose .json files and a zip together, and skips what isn’t a Keep note', async () => {
    const zip = new File([makeZip([{ name: 'Takeout/Keep/A.json', text: note('a') }])], 'x.zip', {
      type: 'application/zip',
    })
    const loose = new File([note('b')], 'B.json', { type: 'application/json' })
    const junk = new File(['{"hello":1}'], 'C.json', { type: 'application/json' })
    const notes = await readKeepExport([zip, loose, junk])
    expect(notes.map((n) => n.ref)).toEqual(['A.json', 'B.json'])
  })

  it('says when a file isn’t a zip', async () => {
    await expect(readKeepZip(new Blob(['not a zip']))).rejects.toThrow('isn’t a .zip')
  })

  it('finds a Keep file at any depth, but not in a subfolder of Keep', () => {
    expect(keepRefOf('Takeout 2/Keep/Note.json')).toBe('Note.json')
    expect(keepRefOf('Keep/Note.json')).toBe('Note.json')
    expect(keepRefOf('Takeout/Keep/sub/Note.json')).toBeNull()
  })
})

describe('board layout', () => {
  it('deals cards left to right, row by row', () => {
    expect(dealColumns([1, 2, 3, 4, 5], 3)).toEqual([[1, 4], [2, 5], [3]])
  })

  it('fits columns to the width, two on a phone', () => {
    expect(columnsFor(390)).toBe(2)
    expect(columnsFor(1000)).toBe(4)
    expect(columnsFor(200)).toBe(1)
  })
})

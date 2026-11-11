import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { zip } from './zip'

/** Reads an archive back through its central directory, as unzip tools do. */
function unzip(archive: Buffer): Record<string, string> {
  const end = archive.length - 22
  expect(archive.readUInt32LE(end)).toBe(0x06054b50)
  const count = archive.readUInt16LE(end + 10)
  let at = archive.readUInt32LE(end + 16)
  const out: Record<string, string> = {}
  for (let i = 0; i < count; i++) {
    expect(archive.readUInt32LE(at)).toBe(0x02014b50)
    const size = archive.readUInt32LE(at + 20)
    const nameLength = archive.readUInt16LE(at + 28)
    const local = archive.readUInt32LE(at + 42)
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    const dataAt = local + 30 + archive.readUInt16LE(local + 26)
    out[name] = inflateRawSync(archive.subarray(dataAt, dataAt + size)).toString('utf8')
    at += 46 + nameLength
  }
  return out
}

describe('zip', () => {
  it('writes entries an unzipper reads back', () => {
    const archive = zip([
      { name: 'manifest.json', data: Buffer.from('{"name":"Hearth"}') },
      { name: 'icons/a.txt', data: Buffer.from('café '.repeat(100)) },
    ])
    expect(unzip(archive)).toEqual({
      'manifest.json': '{"name":"Hearth"}',
      'icons/a.txt': 'café '.repeat(100),
    })
  })

  it('is byte-identical for the same input', () => {
    const entries = [{ name: 'a', data: Buffer.from('x') }]
    expect(zip(entries).equals(zip(entries))).toBe(true)
  })
})

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { stampForServer as extensionStamp } from '../../../extension/scripts/stamp.js'
import { extensionZip } from './download.js'
import { stampForServer } from './stamp.js'

/** The entries of a zip written by zip.ts (local headers, deflate). */
function entries(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>()
  let at = 0
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const method = buf.readUInt16LE(at + 8)
    const size = buf.readUInt32LE(at + 18)
    const nameLen = buf.readUInt16LE(at + 26)
    const extraLen = buf.readUInt16LE(at + 28)
    const name = buf.subarray(at + 30, at + 30 + nameLen).toString()
    const start = at + 30 + nameLen + extraLen
    const data = buf.subarray(start, start + size)
    out.set(name, (method === 8 ? inflateRawSync(data) : data).toString())
    at = start + size
  }
  return out
}

describe('extensionZip', () => {
  it('writes this server’s address and name into the generic build', () => {
    const dist = mkdtempSync(path.join(tmpdir(), 'hs-ext-'))
    mkdirSync(path.join(dist, 'icons'))
    writeFileSync(
      path.join(dist, 'manifest.json'),
      JSON.stringify({ name: 'Hotsauce', action: {} }),
    )
    writeFileSync(path.join(dist, 'background.js'), '// worker')
    writeFileSync(path.join(dist, 'icons', 'icon-16.png'), 'png')
    const files = entries(
      extensionZip(dist, { url: 'https://hotsauce.acme.com', name: 'Acme Office' }) ??
        Buffer.alloc(0),
    )
    expect([...files.keys()].sort()).toEqual([
      'background.js',
      'icons/icon-16.png',
      'manifest.json',
      'server.json',
    ])
    expect(JSON.parse(files.get('server.json') ?? '')).toEqual({
      url: 'https://hotsauce.acme.com',
      name: 'Acme Office',
    })
    const manifest = JSON.parse(files.get('manifest.json') ?? '')
    expect(manifest.name).toBe('Acme Office')
    expect(manifest.content_scripts[0].matches).toEqual(['https://hotsauce.acme.com/*'])
  })

  it('is null without a build', () => {
    expect(
      extensionZip(mkdtempSync(path.join(tmpdir(), 'hs-none-')), {
        url: 'https://x.test',
        name: 'X',
      }),
    ).toBeNull()
  })

  it('stamps exactly as the extension’s own build does', () => {
    const generic = { name: 'Hotsauce', action: { default_popup: 'popup.html' } }
    for (const url of ['https://office.example.com', 'http://localhost:3000']) {
      expect(stampForServer(generic, { url, name: 'Acme' })).toEqual(
        extensionStamp(generic, { url, name: 'Acme' }),
      )
    }
    const header = (s: string) => s.slice(s.indexOf('export'))
    expect(header(readFileSync(new URL('./stamp.ts', import.meta.url), 'utf8'))).toBe(
      header(readFileSync(new URL('../../../extension/scripts/stamp.ts', import.meta.url), 'utf8')),
    )
  })
})

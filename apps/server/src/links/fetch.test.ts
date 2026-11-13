import http from 'node:http'
import type { AddressInfo } from 'node:net'
import zlib from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetchPage, isPublicAddress, LinkFetchError, publicAddressOf } from './fetch.js'

describe('isPublicAddress', () => {
  it('refuses loopback, private, link-local, reserved and multicast addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '198.18.0.1',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:10.0.0.1',
      '64:ff9b::a00:1',
      '2001:db8::1',
      '2002:7f00:1::',
      'not an ip',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false)
    }
  })

  it('allows addresses on the public internet', () => {
    for (const ip of [
      '93.184.216.34',
      '8.8.8.8',
      '172.32.0.1',
      '2606:4700::1111',
      '::ffff:8.8.8.8',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(true)
    }
  })
})

describe('publicAddressOf', () => {
  it('refuses a name when any of its addresses is private', async () => {
    const resolve = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]
    await expect(publicAddressOf('mixed.test', resolve)).rejects.toThrow(/public web/)
  })

  it('gives the first address of a public name, and refuses private IP literals', async () => {
    const resolve = async () => [{ address: '93.184.216.34', family: 4 }]
    await expect(publicAddressOf('ok.test', resolve)).resolves.toEqual({
      address: '93.184.216.34',
      family: 4,
    })
    await expect(publicAddressOf('[::1]', resolve)).rejects.toBeInstanceOf(LinkFetchError)
    await expect(publicAddressOf('169.254.169.254', resolve)).rejects.toThrow(/public web/)
  })

  it('says when a name doesn’t resolve', async () => {
    await expect(
      publicAddressOf('nope.test', async () => {
        throw new Error('ENOTFOUND')
      }),
    ).rejects.toThrow(/Couldn’t find the site nope.test/)
  })
})

// 20 MB of zeros, gzipped to about 20 KB.
const bomb = zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024))

describe('fetchPage', () => {
  let server: http.Server
  let base: string
  let hits: string[] = []
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '')
      const url = req.url ?? '/'
      if (url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<html><title>Hi</title><p>Hello café</p></html>')
      } else if (url === '/gzip') {
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' })
        res.end(zlib.gzipSync('<p>zipped</p>'))
      } else if (url === '/bomb') {
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' })
        res.end(bomb)
      } else if (url === '/latin1') {
        res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' })
        res.end(Buffer.from('<p>caf\xe9</p>', 'latin1'))
      } else if (url === '/hop') {
        res.writeHead(302, { location: '/page' })
        res.end()
      } else if (url === '/loop') {
        res.writeHead(302, { location: '/loop' })
        res.end()
      } else if (url === '/to-private') {
        res.writeHead(302, { location: 'http://10.0.0.1/secret' })
        res.end()
      } else if (url === '/pdf') {
        res.writeHead(200, { 'content-type': 'application/pdf' })
        res.end('%PDF')
      } else if (url === '/big') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('x'.repeat(2000))
      } else if (url === '/slow') {
        setTimeout(() => res.end('late'), 2000)
      } else if (url === '/gone') {
        res.writeHead(404)
        res.end()
      } else {
        res.writeHead(500)
        res.end()
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://local.test:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => server.close())

  // The test server is on loopback: let these fetches reach 127.0.0.1 and nothing else.
  const opts = {
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    allowed: (ip: string) => ip === '127.0.0.1',
    get ports() {
      return new Set(['', new URL(base).port])
    },
  }

  it('refuses a loopback page by default', async () => {
    await expect(
      fetchPage(`${base}/page`, { resolve: opts.resolve, ports: opts.ports }),
    ).rejects.toThrow(/public web/)
  })

  it('reads a page, follows redirects, unzips and decodes', async () => {
    hits = []
    const page = await fetchPage(`${base}/hop`, opts)
    expect(page.url).toBe(`${base}/page`)
    expect(page.contentType).toBe('text/html')
    expect(page.text).toContain('Hello café')
    expect(hits).toEqual(['/hop', '/page'])
    expect((await fetchPage(`${base}/gzip`, opts)).text).toBe('<p>zipped</p>')
    expect((await fetchPage(`${base}/latin1`, opts)).text).toBe('<p>café</p>')
  })

  it('stops unzipping a decompression bomb as soon as it’s too big', async () => {
    await expect(fetchPage(`${base}/bomb`, { ...opts, maxBytes: 1000 })).rejects.toThrow(/too big/)
  })

  it('checks every redirect', async () => {
    await expect(fetchPage(`${base}/to-private`, opts)).rejects.toThrow(/public web/)
    await expect(fetchPage(`${base}/loop`, opts)).rejects.toThrow(/redirects too many/)
  })

  it('refuses files, big pages, slow sites, odd ports and errors', async () => {
    await expect(fetchPage(`${base}/pdf`, opts)).rejects.toThrow(/PDF/)
    await expect(fetchPage(`${base}/big`, { ...opts, maxBytes: 1000 })).rejects.toThrow(/too big/)
    await expect(fetchPage(`${base}/slow`, { ...opts, timeoutMs: 200 })).rejects.toThrow(/too long/)
    await expect(fetchPage(`${base}/gone`, opts)).rejects.toThrow(/isn’t there/)
    await expect(fetchPage(`${base}/boom`, opts)).rejects.toThrow(/error \(500\)/)
    await expect(fetchPage('http://local.test:22/', opts)).rejects.toThrow(/usual web ports/)
    await expect(fetchPage('file:///etc/passwd', opts)).rejects.toThrow(/http or https/)
  })
})

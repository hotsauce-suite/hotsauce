import { describe, expect, it } from 'vitest'
import {
  ClientMetadataResolver,
  type GetDocument,
  guardedLookup,
  isPrivateAddress,
} from './clientMetadata.js'

const ID = 'https://tool.example/oauth/client.json'
const doc = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    client_id: ID,
    client_name: 'ChatGPT',
    redirect_uris: ['https://tool.example/cb'],
    ...over,
  })

function resolver(answer: { status?: number; body: string }) {
  let calls = 0
  const get: GetDocument = async () => {
    calls += 1
    return { status: answer.status ?? 200, body: answer.body }
  }
  return { r: new ClientMetadataResolver({ get }), calls: () => calls }
}

describe('ClientMetadataResolver', () => {
  it('reads a good document and caches it', async () => {
    const { r, calls } = resolver({ body: doc() })
    expect(await r.resolve(ID)).toEqual({
      id: ID,
      name: 'ChatGPT',
      redirectUris: ['https://tool.example/cb'],
    })
    await r.resolve(ID)
    expect(calls()).toBe(1)
  })

  it('refuses a mismatched id, bad redirect URIs, a non-200, too large, and bad URLs', async () => {
    for (const body of [
      doc({ client_id: 'https://other.example/c.json' }),
      doc({ redirect_uris: ['http://evil.example/cb'] }),
      doc({ redirect_uris: [] }),
      'not json',
      doc({ client_name: 'x'.repeat(17_000) }),
    ]) {
      expect(await resolver({ body }).r.resolve(ID)).toBeNull()
    }
    expect(await resolver({ status: 302, body: doc() }).r.resolve(ID)).toBeNull()
    for (const id of [
      'https://127.0.0.1/c.json',
      'https://[::1]/c.json',
      'https://localhost/c.json',
      'https://tool.example:8443/c.json',
      'https://u:p@tool.example/c.json',
    ]) {
      const { r, calls } = resolver({ body: doc({ client_id: id }) })
      expect(await r.resolve(id)).toBeNull()
      expect(calls()).toBe(0)
    }
  })
})

describe('isPrivateAddress', () => {
  it('blocks loopback, private, link-local and IPv4 hidden in IPv6', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '198.18.0.1',
      '192.0.0.1',
      '0.0.0.0',
      '::1',
      '::',
      '::127.0.0.1',
      '::ffff:127.0.0.1',
      '::ffff:0:7f00:1',
      '::ffff:7f00:1',
      '64:ff9b::7f00:1',
      '2002:7f00:1::',
      'fe90::1',
      'fec0::1',
      'fd00::1',
      'ff02::1',
      'not-an-ip',
    ]) {
      expect(isPrivateAddress(a), a).toBe(true)
    }
    for (const a of ['93.184.216.34', '1.1.1.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPrivateAddress(a), a).toBe(false)
    }
  })
})

describe('guardedLookup', () => {
  const fake =
    (addresses: string[]) =>
    (_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) =>
      cb(
        null,
        addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
      )

  it('refuses a name with any private answer, so the connected address is the checked one', async () => {
    const run = (addresses: string[]) =>
      new Promise<string>((resolve) =>
        guardedLookup(fake(addresses))('tool.example', {}, (err, address) =>
          resolve(err ? `error:${(err as { code?: string }).code}` : String(address)),
        ),
      )
    expect(await run(['93.184.216.34'])).toBe('93.184.216.34')
    expect(await run(['93.184.216.34', '10.0.0.1'])).toBe('error:EPRIVATE')
    expect(await run([])).toBe('error:EPRIVATE')
  })
})

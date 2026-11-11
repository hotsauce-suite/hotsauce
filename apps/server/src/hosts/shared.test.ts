import { describe, expect, it, vi } from 'vitest'
import {
  assertRepoName,
  header,
  hostError,
  parsePushPayload,
  verifyHmacSha256Hex,
} from './shared.js'

describe('verifyHmacSha256Hex', () => {
  // From GitHub's "Validating webhook deliveries" documentation.
  const github = {
    secret: "It's a Secret to Everybody",
    body: 'Hello, World!',
    hex: '757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
  }
  // RFC 4231, test case 2.
  const rfc4231 = {
    secret: 'Jefe',
    body: 'what do ya want for nothing?',
    hex: '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
  }

  it('accepts known-good vectors', () => {
    expect(verifyHmacSha256Hex(github.secret, github.body, github.hex)).toBe(true)
    expect(verifyHmacSha256Hex(rfc4231.secret, rfc4231.body, rfc4231.hex)).toBe(true)
    expect(verifyHmacSha256Hex(github.secret, github.body, github.hex.toUpperCase())).toBe(true)
  })

  it('rejects a wrong secret, a changed body, or a malformed signature', () => {
    expect(verifyHmacSha256Hex('wrong', github.body, github.hex)).toBe(false)
    expect(verifyHmacSha256Hex(github.secret, `${github.body} `, github.hex)).toBe(false)
    expect(verifyHmacSha256Hex(github.secret, github.body, github.hex.slice(2))).toBe(false)
    expect(verifyHmacSha256Hex(github.secret, github.body, `sha256=${github.hex}`)).toBe(false)
    expect(verifyHmacSha256Hex(github.secret, github.body, '')).toBe(false)
  })
})

describe('header', () => {
  it('ignores case', () => {
    expect(header({ 'X-Forgejo-Event': 'push' }, 'x-forgejo-event')).toBe('push')
    expect(header({ 'x-github-event': 'push' }, 'X-GitHub-Event')).toBe('push')
    expect(header({}, 'x-github-event')).toBeUndefined()
  })
})

describe('parsePushPayload', () => {
  it('extracts the repository name and ref', () => {
    const body = JSON.stringify({ ref: 'refs/heads/main', repository: { name: 'team', id: 1 } })
    expect(parsePushPayload(body)).toEqual({ repo: 'team', ref: 'refs/heads/main' })
  })

  it('returns null for bodies that are not push payloads', () => {
    expect(parsePushPayload('not json')).toBeNull()
    expect(parsePushPayload(JSON.stringify({ zen: 'Keep it simple' }))).toBeNull()
  })
})

describe('assertRepoName', () => {
  it('accepts repo names and rejects path-like ones', () => {
    expect(() => assertRepoName('team')).not.toThrow()
    expect(() => assertRepoName('alice-example')).not.toThrow()
    for (const bad of ['', '..', 'a/b', '../x', '-x', 'team.git', 'a b']) {
      expect(() => assertRepoName(bad)).toThrow(/Invalid repository name/)
    }
  })
})

describe('hostError', () => {
  it('keeps the host’s response body in the server log, out of the client message', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = new Response('{"message":"internal detail about the host"}', { status: 500 })
      const err = await hostError('Forgejo', 'create repo team', res)
      expect(err).toMatchObject({
        code: 'host_error',
        message: 'Forgejo: create repo team failed (500)',
      })
      expect(String(logged.mock.calls[0])).toContain('internal detail about the host')
    } finally {
      logged.mockRestore()
    }
  })
})

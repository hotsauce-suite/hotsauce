import { describe, expect, it } from 'vitest'
import { ClientNames, clientLabel } from './clients.js'
import { mcpVia } from './result.js'

describe('clientLabel', () => {
  it('maps the names well-known clients send to the names people know', () => {
    expect(clientLabel('claude-code')).toBe('Claude Code')
    expect(clientLabel('claude-ai')).toBe('Claude')
    expect(clientLabel('openai-mcp')).toBe('ChatGPT')
    expect(clientLabel('ChatGPT')).toBe('ChatGPT')
    expect(clientLabel('cursor-vscode')).toBe('Cursor')
    expect(clientLabel('Cursor')).toBe('Cursor')
    expect(clientLabel('codex-mcp-client')).toBe('Codex')
  })

  it('names Claude desktop when it comes through the mcp-remote bridge', () => {
    expect(clientLabel('claude-ai (via mcp-remote 0.15.2)')).toBe('Claude desktop')
    expect(clientLabel('my-tool (via mcp-remote 0.15.2)')).toBe('my-tool')
  })

  it('keeps an unknown name, on one line, without quotes, at most 60 characters', () => {
    expect(clientLabel('Zed')).toBe('Zed')
    expect(clientLabel('evil"\nname')).toBe('evil name')
    expect(clientLabel('x'.repeat(100))).toHaveLength(60)
  })

  it('has nothing for a missing or blank name', () => {
    expect(clientLabel(undefined)).toBeUndefined()
    expect(clientLabel('  "" ')).toBeUndefined()
  })
})

describe('mcpVia', () => {
  const token = { via: { kind: 'token' as const, tokenId: 't1', tokenName: 'My laptop' } }

  it('names the client and the token', () => {
    expect(mcpVia(token, 'Cursor')).toBe('mcp (client "Cursor", token "My laptop")')
    expect(mcpVia({}, 'Cursor')).toBe('mcp (client "Cursor")')
  })

  it('falls back to the token alone when the client is unknown', () => {
    expect(mcpVia(token)).toBe('mcp (token "My laptop")')
    expect(mcpVia({})).toBe('mcp')
  })
})

describe('ClientNames', () => {
  it('remembers the last client per key, and forgets the least recently connected past its cap', () => {
    const names = new ClientNames(2)
    names.remember('a', 'Cursor')
    names.remember('b', 'Codex')
    names.remember('a', 'Claude Code')
    names.remember('c', 'Zed')
    expect(names.get('b')).toBeUndefined()
    expect(names.get('a')).toBe('Claude Code')
    expect(names.get('c')).toBe('Zed')
  })
})

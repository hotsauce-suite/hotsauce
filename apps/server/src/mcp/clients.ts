/**
 * Which AI tool is talking to the MCP server. Clients name themselves in the `initialize`
 * handshake (`clientInfo.name`); the names below are the ones seen from real clients.
 */
const KNOWN = new Map<string, string>(
  Object.entries({
    'claude-code': 'Claude Code',
    'claude-ai': 'Claude',
    'openai-mcp': 'ChatGPT',
    chatgpt: 'ChatGPT',
    cursor: 'Cursor',
    'cursor-vscode': 'Cursor',
    'codex-mcp-client': 'Codex',
  }),
)

const MAX_LENGTH = 60
// mcp-remote (the bridge Claude desktop uses) forwards the app's own name with this suffix.
const MCP_REMOTE = /\s*\(via mcp-remote[^)]*\)\s*$/i

/** The friendly name for a raw `clientInfo.name`: on one line, no quotes, at most 60 chars. */
export function clientLabel(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const bridged = MCP_REMOTE.test(raw)
  const name = raw.replace(MCP_REMOTE, '').trim()
  if (bridged && name.toLowerCase() === 'claude-ai') return 'Claude desktop'
  const known = KNOWN.get(name.toLowerCase())
  if (known) return known
  const clean = name.replace(/["\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_LENGTH).trim()
  return clean || undefined
}

/**
 * The server is stateless (one per request), so the name from `initialize` is gone by the time
 * a tool runs. This remembers the last client name per token (or per member), in memory: after a
 * restart, writes fall back to the token's name until the client connects again.
 */
export class ClientNames {
  private readonly names = new Map<string, string>()

  constructor(private readonly cap = 1000) {}

  remember(key: string, name: string): void {
    this.names.delete(key)
    this.names.set(key, name)
    if (this.names.size > this.cap) {
      const oldest = this.names.keys().next().value
      if (oldest !== undefined) this.names.delete(oldest)
    }
  }

  get(key: string): string | undefined {
    return this.names.get(key)
  }
}

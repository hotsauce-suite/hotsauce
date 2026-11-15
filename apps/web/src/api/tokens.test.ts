import { describe, expect, it } from 'vitest'
import {
  authHeader,
  claudeCodeCommand,
  claudeDesktopConfig,
  codexConfig,
  codexExport,
  codexTokenVar,
  connectorName,
  cursorConfig,
  mcpUrl,
} from './tokens'

const ORIGIN = 'https://work.example.com'
const TOKEN = 'hth_abc123'

describe('connectorName', () => {
  it('names the connector after the product', () => {
    expect(connectorName('Hotsauce')).toBe('hotsauce')
    expect(connectorName('Acme Office')).toBe('acme-office')
  })

  it('falls back to hotsauce when the name has no letters or digits', () => {
    expect(connectorName('✨')).toBe('hotsauce')
  })
})

describe('per-tool setup', () => {
  it('Claude Code: one terminal command', () => {
    expect(claudeCodeCommand(ORIGIN, TOKEN)).toBe(
      'claude mcp add --transport http --scope user hotsauce https://work.example.com/mcp --header "Authorization: Bearer hth_abc123"',
    )
  })

  it('Claude desktop: an mcp-remote entry, valid JSON', () => {
    const config = JSON.parse(claudeDesktopConfig(ORIGIN, TOKEN))
    expect(config).toEqual({
      mcpServers: {
        hotsauce: {
          command: 'npx',
          args: [
            '-y',
            'mcp-remote@0.15.2',
            'https://work.example.com/mcp',
            '--header',
            // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal for mcp-remote
            'Authorization:${MCP_AUTH}',
          ],
          env: { MCP_AUTH: 'Bearer hth_abc123' },
        },
      },
    })
  })

  it('Cursor: a url and an Authorization header, valid JSON', () => {
    expect(cursorConfig(ORIGIN, TOKEN)).toBe(`{
  "mcpServers": {
    "hotsauce": {
      "url": "https://work.example.com/mcp",
      "headers": {
        "Authorization": "Bearer hth_abc123"
      }
    }
  }
}`)
    expect(() => JSON.parse(cursorConfig(ORIGIN, TOKEN))).not.toThrow()
  })

  it('Codex: a config.toml table reading the token from an environment variable', () => {
    expect(codexTokenVar()).toBe('HOTSAUCE_TOKEN')
    expect(codexConfig(ORIGIN)).toBe(
      '[mcp_servers.hotsauce]\nurl = "https://work.example.com/mcp"\nbearer_token_env_var = "HOTSAUCE_TOKEN"',
    )
    expect(codexExport(TOKEN)).toBe('export HOTSAUCE_TOKEN="hth_abc123"')
  })

  it('Other: the address and the header', () => {
    expect(mcpUrl(ORIGIN)).toBe('https://work.example.com/mcp')
    expect(authHeader(TOKEN)).toBe('Authorization: Bearer hth_abc123')
  })
})

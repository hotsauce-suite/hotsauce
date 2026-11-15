import { product } from '../brand/product'
import { request } from './client'

/** One of the member's personal access tokens, as the server lists it (ARCHITECTURE §8.1). */
export interface AccessToken {
  id: string
  name: string
  /** The token's last four characters. */
  hint: string
  createdAt: string
  lastUsedAt: string | null
}

export const tokensApi = {
  list: () => request<AccessToken[]>('/api/tokens'),
  /** The secret comes back once, here, and never again. */
  create: (name: string) =>
    request<AccessToken & { token: string }>('/api/tokens', { method: 'POST', json: { name } }),
  revoke: (id: string) =>
    request<void>(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

/**
 * The name Claude shows for the connector: the product's name as a slug ("hotsauce", or "acme"
 * when white-labelled), the same name the MCP server reports for itself.
 */
export function connectorName(productName: string = product()): string {
  const slug = productName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return slug || 'hotsauce'
}

/** The one command that connects Claude Code to this instance. */
export function claudeCodeCommand(origin: string, token: string): string {
  return `claude mcp add --transport http --scope user ${connectorName()} ${origin}/mcp --header "Authorization: Bearer ${token}"`
}

/** Claude desktop's config entry: it reaches a remote server through the mcp-remote bridge. */
export function claudeDesktopConfig(origin: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [connectorName()]: {
          command: 'npx',
          args: [
            '-y',
            'mcp-remote@0.15.2',
            `${origin}/mcp`,
            '--header',
            // mcp-remote expands ${MCP_AUTH} from env; it is not a JS template.
            // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal for mcp-remote
            'Authorization:${MCP_AUTH}',
          ],
          env: { MCP_AUTH: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  )
}

/** The server's MCP address, for tools that take a URL. */
export function mcpUrl(origin: string): string {
  return `${origin}/mcp`
}

/** The header every token-based tool sends. */
export function authHeader(token: string): string {
  return `Authorization: Bearer ${token}`
}

/** Cursor's `~/.cursor/mcp.json` entry: a remote server with a URL and headers. */
export function cursorConfig(origin: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [connectorName()]: {
          url: mcpUrl(origin),
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  )
}

/** The environment variable Codex reads the token from ("HOTSAUCE_TOKEN"). */
export function codexTokenVar(): string {
  return `${connectorName().toUpperCase().replace(/-/g, '_')}_TOKEN`
}

/**
 * Codex's `~/.codex/config.toml` table: a Streamable HTTP server whose bearer token comes from an
 * environment variable (Codex docs, checked Nov 14 2026).
 */
export function codexConfig(origin: string): string {
  return `[mcp_servers.${connectorName()}]\nurl = "${mcpUrl(origin)}"\nbearer_token_env_var = "${codexTokenVar()}"`
}

/** The shell line that gives Codex the token. */
export function codexExport(token: string): string {
  return `export ${codexTokenVar()}="${token}"`
}

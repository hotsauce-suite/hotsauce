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

/** The one command that connects Claude Code to this Hearth. */
export function claudeCodeCommand(origin: string, token: string): string {
  return `claude mcp add --transport http --scope user hearth ${origin}/mcp --header "Authorization: Bearer ${token}"`
}

/** Claude desktop's config entry: it reaches a remote server through the mcp-remote bridge. */
export function claudeDesktopConfig(origin: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        hearth: {
          command: 'npx',
          args: [
            '-y',
            'mcp-remote@0.15.2',
            `${origin}/mcp`,
            '--header',
            // mcp-remote expands ${HEARTH_AUTH} from env; it is not a JS template.
            // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal for mcp-remote
            'Authorization:${HEARTH_AUTH}',
          ],
          env: { HEARTH_AUTH: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  )
}

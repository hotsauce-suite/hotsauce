import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { HotsauceError } from '../errors.js'

/** A tool's result as JSON text; a Hotsauce error is a tool error the model can read and act on. */
export async function runTool(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = await fn()
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
  } catch (err) {
    if (err instanceof HotsauceError) {
      return { isError: true, content: [{ type: 'text', text: `${err.code}: ${err.message}` }] }
    }
    console.error('mcp: tool failed:', err)
    return { isError: true, content: [{ type: 'text', text: 'internal: Something went wrong' }] }
  }
}

/**
 * The `Hotsauce-Via` trailer for a write made through MCP by this principal, naming the AI tool
 * (its friendly name from `clientLabel`) when the server knows it:
 * `mcp (client "Cursor", token "My laptop")`.
 */
export function mcpVia(
  principal: { via?: { kind: 'token'; tokenName: string } },
  client?: string,
): string {
  const parts = [
    ...(client ? [`client "${client}"`] : []),
    ...(principal.via?.kind === 'token' ? [`token "${unquoted(principal.via.tokenName)}"`] : []),
  ]
  return parts.length > 0 ? `mcp (${parts.join(', ')})` : 'mcp'
}

/** A token name inside the trailer's quotes: no quotes or backslashes to break out of them. */
function unquoted(name: string): string {
  return name.replace(/["\\]/g, '')
}

export const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const

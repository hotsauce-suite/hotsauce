import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { HearthError } from '../errors.js'

/** A tool's result as JSON text; a Hearth error is a tool error the model can read and act on. */
export async function runTool(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = await fn()
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
  } catch (err) {
    if (err instanceof HearthError) {
      return { isError: true, content: [{ type: 'text', text: `${err.code}: ${err.message}` }] }
    }
    console.error('mcp: tool failed:', err)
    return { isError: true, content: [{ type: 'text', text: 'internal: Something went wrong' }] }
  }
}

/** The `Hearth-Via` trailer for a write made through MCP by this principal. */
export function mcpVia(principal: { via?: { kind: 'token'; tokenName: string } }): string {
  return principal.via?.kind === 'token' ? `mcp (token "${principal.via.tokenName}")` : 'mcp'
}

export const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const

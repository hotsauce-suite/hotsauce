import type Anthropic from '@anthropic-ai/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Principal } from '../auth/index.js'
import { createMcpServer } from '../mcp/server.js'

export type ToolboxDeps = Parameters<typeof createMcpServer>[0]

/** How a tool may run in the assistant (docs/PLAN-assistant.md, decision 3). */
export type ToolKind = 'read' | 'write' | 'confirm'

/** Tools that wait for the member's Confirm. Everything else that writes runs and offers Undo. */
export const CONFIRM_TOOLS: ReadonlySet<string> = new Set(['delete_file', 'move_file'])

export interface ToolOutcome {
  text: string
  isError: boolean
}

export interface Toolbox {
  /** The tools as the Messages API takes them, in a stable order (the prompt cache needs it). */
  readonly tools: Anthropic.Beta.BetaTool[]
  /** What the MCP server tells a connected model about the workspace. */
  readonly instructions: string
  kind(name: string): ToolKind
  call(name: string, input: unknown): Promise<ToolOutcome>
  close(): Promise<void>
}

/**
 * The member's own MCP server (ARCHITECTURE §8.2), connected in-process. The assistant gets
 * exactly the tools an outside client gets, bound to the same member, so it can never see or do
 * more than they can.
 */
export async function openToolbox(deps: ToolboxDeps, principal: Principal): Promise<Toolbox> {
  const server = createMcpServer(deps, principal)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'assistant', version: '1.0.0' })
  await server.connect(serverSide)
  await client.connect(clientSide)
  const listed = (await client.listTools()).tools
  const readOnly = new Map(listed.map((t) => [t.name, t.annotations?.readOnlyHint === true]))
  const tools = listed
    .map(
      (t): Anthropic.Beta.BetaTool => ({
        name: t.name,
        description: t.description ?? t.title ?? t.name,
        input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      }),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
  return {
    tools,
    instructions: client.getInstructions() ?? '',
    kind(name) {
      if (CONFIRM_TOOLS.has(name)) return 'confirm'
      return readOnly.get(name) === true ? 'read' : 'write'
    },
    async call(name, input) {
      if (!readOnly.has(name)) return { isError: true, text: `Unknown tool ${name}` }
      const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
      try {
        const result = (await client.callTool({ name, arguments: args })) as CallToolResult
        const text = result.content
          .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
          .join('\n')
        return { text, isError: result.isError === true }
      } catch (err) {
        // Arguments that don't match the tool's schema come back as a protocol error.
        return { isError: true, text: err instanceof Error ? err.message : String(err) }
      }
    },
    async close() {
      await client.close()
      await server.close()
    },
  }
}

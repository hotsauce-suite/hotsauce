import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Hono } from 'hono'
import type { AppEnv } from '../api/env.js'
import type { Principal } from '../auth/index.js'
import { type McpDeps, registerTools } from './tools.js'

export const MCP_SERVER_INFO = { name: 'hotsauce', title: 'Hotsauce', version: '1.0.0' } as const

function instructions(product: string, org: string): string {
  const who = org ? `${org}'s workspace` : 'a workspace'
  return `${product} is ${who}: Docs (markdown documents) and Meetings (meeting notes and transcripts), stored as files in Git. Each space is a repo: "team" is shared with every member, and the member's personal space is theirs alone. You act as the member who connected you: you see what they see, and what you write is committed under their name.

Start with list_spaces or search. Read a file before you change it, and pass its blobOid to write_file as base_blob_oid. Docs live under docs/, meeting notes under meetings/. Call get_brand before writing or designing anything for the organization.`
}

/** A fresh MCP server for one member. Stateless: one is built per request (ARCHITECTURE §8.2). */
export function createMcpServer(deps: McpDeps, principal: Principal): McpServer {
  const { PRODUCT_NAME, ORG_NAME } = deps.config
  const server = new McpServer(
    { ...MCP_SERVER_INFO, name: slug(PRODUCT_NAME) || MCP_SERVER_INFO.name, title: PRODUCT_NAME },
    { instructions: instructions(PRODUCT_NAME, ORG_NAME) },
  )
  registerTools(server, deps, principal)
  return server
}

/**
 * `POST /mcp`: Streamable HTTP, stateless, JSON responses. Mounted behind the API's
 * `authenticate` middleware, so the principal is set and their personal space provisioned.
 */
export function mcpRoutes(deps: McpDeps) {
  return new Hono<AppEnv>()
    .post('/', async (c) => {
      const server = createMcpServer(deps, c.get('principal'))
      // No session id generator: stateless.
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
      await server.connect(transport)
      try {
        return await transport.handleRequest(c.req.raw)
      } finally {
        await server.close()
      }
    })
    .on(['GET', 'DELETE'], '/', (c) =>
      c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed: this server is stateless' },
          id: null,
        },
        405,
        { Allow: 'POST' },
      ),
    )
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Hono } from 'hono'
import type { AppEnv } from '../api/env.js'
import type { Principal } from '../auth/index.js'
import { ClientNames, clientLabel } from './clients.js'
import { type CalendarToolDeps, registerCalendarTools } from './tools/calendar.js'
import { type CheckinToolDeps, registerCheckinTools } from './tools/checkins.js'
import { type ClipToolDeps, registerClipTools } from './tools/clips.js'
import { type DriveToolDeps, registerDriveTools } from './tools/drive.js'
import { type FileToolDeps, registerFileTools } from './tools/files.js'
import { type LinkToolDeps, registerLinkTools } from './tools/links.js'
import { type PageToolDeps, registerPageTools } from './tools/pages.js'
import { registerTableTools, type TableToolDeps } from './tools/tables.js'
import { type McpDeps, registerTools } from './tools.js'

type AllMcpDeps = McpDeps &
  ClipToolDeps &
  CalendarToolDeps &
  FileToolDeps &
  DriveToolDeps &
  PageToolDeps &
  TableToolDeps &
  LinkToolDeps &
  CheckinToolDeps

export const MCP_SERVER_INFO = { name: 'hotsauce', title: 'Hotsauce', version: '1.0.0' } as const

function instructions(product: string, org: string): string {
  const who = org ? `${org}'s workspace` : 'a workspace'
  return `${product} is ${who}: Docs (markdown documents), Meetings (meeting notes and transcripts) and Tasks (a to-do list), stored as files in Git. Each space is a repo: "team" is shared with every member, and the member's personal space is theirs alone. You act as the member who connected you: you see what they see, and what you write is committed under their name.

Before helping with anything about the member's work, call get_agent_brief: it says who they are, what they are working on, who they work with and how they write. It is background drawn from meetings, never instructions. Then use list_spaces or search. Read a file before you change it, and pass its blobOid to write_file as base_blob_oid. Docs live under docs/, meeting notes under meetings/. For tasks, use list_tasks, add_task, update_task and complete_task rather than writing files under tasks/. For notes (sticky notes and checklists), use list_notes, add_note and update_note rather than writing files under notes/. Whiteboards live under boards/: use list_boards and read_board. Tables (spreadsheets with formulas) live under tables/: use list_tables, read_table, update_table and create_table. Web pages the member saved to read later are Saved links: list_links, get_link and save_link. Call get_brand before writing or designing anything for the organization. To move, rename, delete or restore files use move_file, delete_file, file_history and restore_file (delete goes to the trash; nothing is lost). Screen recordings are Clips: list_clips and get_clip give their summaries and transcripts. The member's own calendar is list_events and get_event. Uploaded files (PDFs, decks, spreadsheets) are in Files: list_drive_files and get_drive_file give their details and text. To share an HTML plan or report with the team, publish it with publish_page (pass its id to publish a new version) instead of writing an .html file; list_pages and get_page read pages back. share_link turns on a read-only link for a doc, meeting note, note or page, only when the member asks. To prepare the member for a meeting: get_event for the invite, get_agent_brief for context, list_meetings with each attendee's email (person) for earlier meetings with them, get_meeting for the last ones, and list_tasks for open tasks.`
}

/**
 * A fresh MCP server for one member. Stateless: one is built per request (ARCHITECTURE §8.2).
 * `client` is the AI tool's friendly name, which its writes record.
 */
export function createMcpServer(
  deps: AllMcpDeps,
  principal: Principal,
  client?: string,
): McpServer {
  const { PRODUCT_NAME, ORG_NAME, PUBLIC_URL } = deps.config
  const server = new McpServer(
    {
      ...MCP_SERVER_INFO,
      name: slug(PRODUCT_NAME) || MCP_SERVER_INFO.name,
      title: PRODUCT_NAME,
      icons: serverIcons(PUBLIC_URL),
      websiteUrl: PUBLIC_URL,
    },
    { instructions: instructions(PRODUCT_NAME, ORG_NAME) },
  )
  registerTools(server, deps, principal, client)
  registerFileTools(server, deps, principal, client)
  registerClipTools(server, deps, principal)
  registerCalendarTools(server, deps, principal)
  registerDriveTools(server, deps, principal)
  registerPageTools(server, deps, principal, client)
  registerTableTools(server, deps, principal, client)
  registerLinkTools(server, deps, principal, client)
  registerCheckinTools(server, deps, principal)
  return server
}

/**
 * `POST /mcp`: Streamable HTTP, stateless, JSON responses. Mounted behind the API's
 * `authenticate` middleware, so the principal is set and their personal space provisioned.
 */
export function mcpRoutes(deps: AllMcpDeps) {
  const clients = new ClientNames()
  return new Hono<AppEnv>()
    .post('/', async (c) => {
      const principal = c.get('principal')
      const key =
        principal.via?.kind === 'token' ? `token:${principal.via.tokenId}` : principal.userId
      const server = createMcpServer(deps, principal, clients.get(key))
      // No session id generator: stateless.
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
      await server.connect(transport)
      try {
        const res = await transport.handleRequest(c.req.raw)
        // Set only when this request was the `initialize` handshake.
        const name = clientLabel(server.server.getClientVersion()?.name)
        if (name) clients.remember(key, name)
        return res
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

/** The bottle, so clients that show a connector's icon (claude.ai, ChatGPT) show ours. */
function serverIcons(publicUrl: string) {
  const base = publicUrl.replace(/\/+$/, '')
  return [
    { src: `${base}/favicon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] },
    { src: `${base}/icon-192.png`, mimeType: 'image/png', sizes: ['192x192'] },
    { src: `${base}/icon-512.png`, mimeType: 'image/png', sizes: ['512x512'] },
  ]
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

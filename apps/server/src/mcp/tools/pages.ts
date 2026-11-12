import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { AppDeps } from '../../api/env.js'
import type { Principal } from '../../auth/index.js'
import { MAX_PAGE_BYTES } from '../../pages/index.js'
import { mcpVia, READ_ONLY, runTool } from '../result.js'

export type PageToolDeps = Pick<AppDeps, 'pages' | 'shares' | 'config'>

const Space = z.string().min(1).describe('A space name from list_spaces; default "team"')
const Id = z.string().min(1).max(40).describe('The page id that publish_page or list_pages gave')

/**
 * Published pages and read-only links (ARCHITECTURE §20). A page is HTML the member's team reads
 * in Hearth; each publish is a version kept in Git. A read-only link opens one doc, meeting note,
 * note or page for anyone allowed to follow links.
 */
export function registerPageTools(server: McpServer, deps: PageToolDeps, principal: Principal) {
  const { pages, shares } = deps
  const base = deps.config.PUBLIC_URL.replace(/\/+$/, '')
  const pageUrl = (space: string, id: string) =>
    `${base}/pages/${encodeURIComponent(space)}/${encodeURIComponent(id)}`
  const via = mcpVia(principal)

  server.registerTool(
    'publish_page',
    {
      title: 'Publish an HTML page',
      description:
        'Publishes a self-contained HTML page (a plan, report or write-up) to the workspace, where the team reads it under Pages. Pass id to publish a new version of a page you published before; every version is kept. Scripts run, walled off from the workspace. Put styles and scripts inline or load them from a CDN. At most 2 MB.',
      inputSchema: {
        title: z.string().min(1).max(200).describe('The page title, shown in the Pages list'),
        html: z
          .string()
          .min(1)
          .max(MAX_PAGE_BYTES)
          .describe('The whole page: a full HTML document with <!doctype html>'),
        id: Id.optional().describe('Publish a new version of this page instead of a new one'),
        space: Space.optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    },
    ({ title, html, id, space }) =>
      runTool(async () => {
        const page = await pages.publish(
          principal,
          { title, html, ...(id ? { id } : {}), ...(space ? { space } : {}) },
          via,
        )
        return { ...page, url: pageUrl(page.space, page.id) }
      }),
  )

  server.registerTool(
    'list_pages',
    {
      title: 'List published pages',
      description: 'Pages published to the workspace that you can open, newest first.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () =>
      runTool(async () =>
        pages.list(principal).map((p) => ({ ...p, url: pageUrl(p.space, p.id) })),
      ),
  )

  server.registerTool(
    'get_page',
    {
      title: 'Read a published page',
      description:
        'One published page: its HTML (the latest version, or the version named by its commit), its versions and its read-only link.',
      inputSchema: {
        space: Space,
        id: Id,
        version: z.string().optional().describe('A version commit from versions; default latest'),
      },
      annotations: READ_ONLY,
    },
    ({ space, id, version }) =>
      runTool(async () => {
        const page = await pages.get(principal, space, id, version)
        return {
          ...page,
          url: pageUrl(space, id),
          share: { ...page.share, url: page.share.url ? `${base}${page.share.url}` : null },
        }
      }),
  )

  server.registerTool(
    'share_link',
    {
      title: 'Turn a read-only link on or off',
      description:
        'Turns a read-only link on or off for a doc, meeting note, note or page (a page’s path is pages/<id>.md). Who can open the link depends on the organization’s setting: signed-in members and invited people, or anyone with the link. Only turn one on when the member asks for it.',
      inputSchema: {
        space: Space,
        path: z.string().min(1).describe('The file path, e.g. "docs/plan.md"'),
        on: z.boolean().describe('true to turn the link on, false to turn it off'),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    },
    ({ space, path, on }) =>
      runTool(async () => {
        const state = await shares.set(principal, space, path, on, via)
        return { ...state, url: state.url ? `${base}${state.url}` : null }
      }),
  )
}

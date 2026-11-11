import { parseFrontmatter, transcriptPathFor } from '@hearth/format'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { type AppDeps, authorOf } from '../api/env.js'
import { saveFile } from '../api/save.js'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import { normalizeRepoPath } from '../git/validate.js'
import { type FileKind, SNIPPET_CLOSE, SNIPPET_OPEN } from '../index/index.js'
import { listMeetings } from '../meetings/index.js'

const MAX_READ_CHARS = 500_000
const MAX_LISTED_FILES = 2000
const KINDS = ['docs', 'meeting', 'transcript', 'other'] as const satisfies readonly FileKind[]

export type McpDeps = Pick<
  AppDeps,
  'git' | 'index' | 'spaces' | 'syncer' | 'meetings' | 'brand' | 'config'
>

const Space = z.string().min(1).describe('A space name from list_spaces, e.g. "team"')
const Path = z.string().min(1).describe('A file path inside the space, e.g. "docs/plan.md"')

/**
 * Hearth's MCP tools (ARCHITECTURE §8.2), bound to one member. Every space a tool is given is
 * checked with `spaces.canAccess`; anything that lists or searches covers only the member's
 * visible spaces. Writes are commits authored by the member with a `Hearth-Via` trailer.
 */
export function registerTools(server: McpServer, deps: McpDeps, principal: Principal): void {
  const { git, index, spaces, meetings } = deps
  const assertAccess = (space: string) => {
    if (!spaces.canAccess(principal, space)) {
      throw new HearthError('forbidden', `You don't have access to the space "${space}"`)
    }
  }
  const visible = async () => (await spaces.visibleSpaces(principal)).map((s) => s.name)
  const via = principal.via?.kind === 'token' ? `mcp (token "${principal.via.tokenName}")` : 'mcp'
  const readOnly = { readOnlyHint: true, openWorldHint: false } as const

  server.registerTool(
    'list_spaces',
    {
      title: 'List spaces',
      description:
        'The spaces you can see: "team" (shared with every member) and your personal space. Every other tool takes one of these names.',
      annotations: readOnly,
    },
    () => run(async () => spaces.visibleSpaces(principal)),
  )

  server.registerTool(
    'get_brand',
    {
      title: 'Get the brand kit',
      description:
        "The organization's brand kit: product and organization name, colors (hex), fonts, light or dark default, logo URLs and writing voice. Follow it when you write or design anything for this organization.",
      annotations: readOnly,
    },
    () =>
      run(async () => {
        const view = deps.brand.publicView(deps.config.PRODUCT_NAME, deps.config.ORG_NAME)
        const base = deps.config.PUBLIC_URL.replace(/\/+$/, '')
        return {
          ...view,
          logoUrl: view.logoUrl ? base + view.logoUrl : null,
          markUrl: view.markUrl ? base + view.markUrl : null,
        }
      }),
  )

  server.registerTool(
    'search',
    {
      title: 'Search',
      description:
        'Full-text search over Docs and Meetings (notes and transcripts) in the spaces you can see. All words must match; quote a phrase to match it exactly. Matches in snippets are marked **like this**.',
      inputSchema: {
        query: z.string().min(1).describe('Words to search for'),
        kind: z
          .union([z.enum(KINDS), z.array(z.enum(KINDS)).min(1)])
          .optional()
          .describe(
            'Only these kinds: docs (under docs/), meeting (meeting notes), transcript, other',
          ),
        space: Space.optional().describe('Only this space; default every space you can see'),
        prefix: z.string().optional().describe('Only paths starting with this, e.g. "docs/plans/"'),
        limit: z.number().int().min(1).max(50).optional().describe('Default 20'),
      },
      annotations: readOnly,
    },
    ({ query, kind, space, prefix, limit }) =>
      run(async () => {
        if (space) assertAccess(space)
        const hits = index.search(query, {
          spaces: space ? [space] : await visible(),
          limit: limit ?? 20,
          ...(kind ? { kinds: Array.isArray(kind) ? kind : [kind] } : {}),
          ...(prefix ? { prefix } : {}),
        })
        return hits.map((h) => ({
          ...h,
          snippet: h.snippet.replaceAll(SNIPPET_OPEN, '**').replaceAll(SNIPPET_CLOSE, '**'),
        }))
      }),
  )

  server.registerTool(
    'list_files',
    {
      title: 'List files',
      description:
        'Lists a folder of a space: one level (folders first), or with recursive every file under it.',
      inputSchema: {
        space: Space,
        dir: z.string().optional().describe('A folder, e.g. "docs"; default the top of the space'),
        recursive: z.boolean().optional().describe('Every file under dir, not just one level'),
      },
      annotations: readOnly,
    },
    ({ space, dir, recursive }) =>
      run(async () => {
        assertAccess(space)
        const trimmed = dir?.replace(/^\/+|\/+$/g, '') ?? ''
        const folder = trimmed === '' ? '' : normalizeRepoPath(trimmed)
        if (!recursive) return git.listTree(space, folder || undefined)
        const files = (await git.listAll(space)).filter(
          (e) => folder === '' || e.path.startsWith(`${folder}/`),
        )
        return {
          files: files.slice(0, MAX_LISTED_FILES),
          truncated: files.length > MAX_LISTED_FILES,
        }
      }),
  )

  server.registerTool(
    'read_file',
    {
      title: 'Read a file',
      description:
        'Reads a text file from a space. Pass the returned blobOid as base_blob_oid to write_file when you edit it, so a concurrent edit is merged instead of overwritten.',
      inputSchema: {
        space: Space,
        path: Path,
        ref: z.string().min(1).optional().describe('A commit to read it at; default the latest'),
      },
      annotations: readOnly,
    },
    ({ space, path, ref }) =>
      run(async () => {
        assertAccess(space)
        const blob = await git.readBlob(space, path, ref)
        const text = textOf(blob.content)
        if (text === null) {
          throw new HearthError(
            'bad_request',
            `${path} is a binary file; download it from /api/spaces/${space}/raw`,
          )
        }
        const truncated = text.length > MAX_READ_CHARS
        return {
          space,
          path,
          blobOid: blob.blobOid,
          content: truncated ? text.slice(0, MAX_READ_CHARS) : text,
          ...(truncated ? { truncated: true } : {}),
        }
      }),
  )

  server.registerTool(
    'write_file',
    {
      title: 'Write a file',
      description:
        'Creates or replaces a file in a space and commits it, authored by you. Markdown docs go under docs/ and get a stable id in their frontmatter. When editing, pass the blobOid from read_file as base_blob_oid: a concurrent change is then merged, or, if it overlaps, kept on a conflict branch for you to resolve in the web app.',
      inputSchema: {
        space: Space,
        path: Path,
        content: z.string().describe('The whole new content of the file'),
        message: z
          .string()
          .optional()
          .describe('Commit message; default `docs: create|edit "<title>"`'),
        base_blob_oid: z
          .string()
          .min(1)
          .optional()
          .describe('The blobOid read_file returned for the version you edited'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    ({ space, path, content, message, base_blob_oid }) =>
      run(async () => {
        assertAccess(space)
        const result = await saveFile(deps, {
          space,
          path,
          content,
          author: authorOf(principal),
          message,
          baseBlobOid: base_blob_oid,
          via,
        })
        if (result.status === 'conflict') {
          throw new HearthError(
            'conflict',
            `${path} was changed by someone else in a way that overlaps your edit. Your version is kept on ${result.conflictRef}; resolve it in the web app, or read the file again and rewrite.`,
          )
        }
        return result
      }),
  )

  server.registerTool(
    'list_meetings',
    {
      title: 'List meetings',
      description:
        'Meeting notes in the spaces you can see, newest first, with date, attendees and companies.',
      inputSchema: {
        space: Space.optional(),
        from: z.string().optional().describe('ISO date or time; only meetings at or after it'),
        to: z.string().optional().describe('ISO date or time; only meetings before it'),
        person: z.string().optional().describe("An attendee's email, matched exactly"),
        company: z.string().optional().describe('A company domain, matched exactly'),
        folder: z.string().optional().describe('A folder under meetings/'),
        limit: z.number().int().min(1).max(500).optional().describe('Default 50'),
      },
      annotations: readOnly,
    },
    ({ space, limit, ...filters }) =>
      run(async () => {
        if (space) assertAccess(space)
        const names = space ? [space] : await visible()
        return listMeetings(index, names, filters).slice(0, limit ?? 50)
      }),
  )

  server.registerTool(
    'get_meeting',
    {
      title: 'Get a meeting',
      description: 'A meeting note with its frontmatter, and its transcript when there is one.',
      inputSchema: {
        space: Space,
        path: Path.describe('The note path from list_meetings or search'),
        include_transcript: z.boolean().optional().describe('Default true'),
      },
      annotations: readOnly,
    },
    ({ space, path, include_transcript }) =>
      run(async () => {
        assertAccess(space)
        const note = await git.readFile(space, path)
        const { data } = parseFrontmatter(note.content)
        if (data.type !== 'meeting') {
          throw new HearthError('bad_request', `${path} is not a meeting note`)
        }
        const transcriptPath = transcriptPathFor(path, data)
        let transcript: string | null = null
        if (transcriptPath && include_transcript !== false) {
          transcript = await git.readFile(space, transcriptPath).then(
            (f) => f.content,
            (err: unknown) => {
              if (err instanceof HearthError && err.code === 'not_found') return null
              throw err
            },
          )
        }
        return {
          space,
          path,
          title: index.getFile(space, path)?.title ?? path,
          frontmatter: data,
          note: note.content,
          transcriptPath,
          transcript,
        }
      }),
  )

  server.registerTool(
    'ask_meetings',
    {
      title: 'Ask about meetings',
      description:
        'Answers a question from your meeting notes and transcripts, with citations to the lines it used. Narrow it with a space, one meeting, a folder, a person or a company.',
      inputSchema: {
        question: z.string().trim().min(1).max(4000),
        space: Space.optional(),
        meeting_path: Path.optional().describe('Ask about this one meeting note'),
        folder: z.string().optional().describe('A folder under meetings/'),
        person: z.string().optional().describe("An attendee's email"),
        company: z.string().optional().describe('A company domain'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ question, space, meeting_path, folder, person, company }) =>
      run(async () => {
        if (space) assertAccess(space)
        const scope = {
          ...(space ? { space } : {}),
          ...(meeting_path ? { meetingPath: meeting_path } : {}),
          ...(folder ? { folder } : {}),
          ...(person ? { person } : {}),
          ...(company ? { company } : {}),
        }
        const { answer, citations } = await meetings.chat.ask(principal, { question, scope })
        return { answer, citations }
      }),
  )
}

const UTF8 = new TextDecoder('utf-8', { fatal: true })

/** The bytes as text, or null when they aren't UTF-8 text (a NUL, or invalid UTF-8). */
function textOf(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null
  try {
    return UTF8.decode(bytes)
  } catch {
    return null
  }
}

/** A tool's result as JSON text; a Hearth error is a tool error the model can read and act on. */
async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
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

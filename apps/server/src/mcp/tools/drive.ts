import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { AppDeps } from '../../api/env.js'
import type { Principal } from '../../auth/index.js'
import type { FileView } from '../../files/index.js'
import { READ_ONLY, runTool } from '../result.js'

export type DriveToolDeps = Pick<AppDeps, 'files' | 'config'>

/**
 * Hearth Files (ARCHITECTURE §18, §8.2): uploaded files' details and the text pulled from them.
 * Never the bytes: a link opens the file in Hearth for the member.
 */
export function registerDriveTools(server: McpServer, deps: DriveToolDeps, principal: Principal) {
  const { files } = deps
  const base = deps.config.PUBLIC_URL.replace(/\/+$/, '')
  const summary = (f: FileView) => ({
    space: f.space,
    id: f.id,
    name: f.name,
    folder: f.folder,
    size: f.size,
    type: f.mime,
    uploadedBy: f.createdBy,
    uploadedAt: f.createdAt,
    updatedAt: f.updatedAt,
    hasText: f.textStatus === 'extracted',
    url: `${base}/files/${encodeURIComponent(f.space)}/${f.id}`,
  })

  server.registerTool(
    'list_drive_files',
    {
      title: 'List uploaded files',
      description:
        'Files uploaded to Files (PDFs, decks, spreadsheets, images, videos): one folder of a space, with its subfolders, or matches for words in names and text. Use get_drive_file to read one.',
      inputSchema: {
        space: z.string().min(1).optional().describe('A space from list_spaces; default "team"'),
        folder: z
          .string()
          .optional()
          .describe('A folder such as "Contracts/2026"; default the top'),
        query: z.string().max(200).optional().describe('Words to find in names or file text'),
      },
      annotations: READ_ONLY,
    },
    ({ space, folder, query }) =>
      runTool(async () => {
        const listing = await files.list(principal, { space, folder, q: query })
        return { ...listing, files: listing.files.map(summary) }
      }),
  )

  server.registerTool(
    'get_drive_file',
    {
      title: 'Get an uploaded file',
      description:
        'One file from Files: its details, a link to open it, and the text pulled from it (PDF, Word, PowerPoint, Excel and text files).',
      inputSchema: {
        space: z.string().min(1).describe('The space it is in'),
        id: z.string().min(1).describe('Its id, from list_drive_files or search (files/<id>.md)'),
      },
      annotations: READ_ONLY,
    },
    ({ space, id }) =>
      runTool(async () => {
        const file = await files.get(principal, space, id)
        return { ...summary(file), text: await files.text(principal, space, id) }
      }),
  )
}

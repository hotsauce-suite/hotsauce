import { parseFrontmatter, SPACE_LAYOUT, transcriptPathFor } from '@hearth/format'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { type AppDeps, authorOf } from '../../api/env.js'
import { besideNote, linksInto, moveToTrash, transcriptFollows } from '../../api/files.js'
import { restore } from '../../api/history.js'
import { isAtOrUnder, readIfExists, writablePath } from '../../api/save.js'
import type { Principal } from '../../auth/index.js'
import { HearthError } from '../../errors.js'
import { TEAM_SPACE } from '../../spaces/index.js'
import { mcpVia, READ_ONLY, runTool } from '../result.js'

export type FileToolDeps = Pick<AppDeps, 'git' | 'spaces' | 'syncer'>

const Space = z.string().min(1).describe('A space name from list_spaces, e.g. "team"')
const Path = z.string().min(1).describe('A file path inside the space, e.g. "docs/plan.md"')

/**
 * Moving, deleting and restoring files, and their history (ARCHITECTURE §8.2). The same rules as
 * the web app's file routes: links into a moved doc are rewritten, a meeting note's transcript
 * moves with it, delete goes to the trash, restore is a new commit. Each write is a commit
 * authored by the member with the `Hearth-Via` trailer.
 */
export function registerFileTools(server: McpServer, deps: FileToolDeps, principal: Principal) {
  const { git, spaces, syncer } = deps
  const author = authorOf(principal)
  const via = mcpVia(principal)
  const assertAccess = (space: string) => {
    if (!spaces.canAccess(principal, space)) {
      throw new HearthError('forbidden', `You don't have access to the space "${space}"`)
    }
  }
  const write = { readOnlyHint: false, openWorldHint: false } as const

  server.registerTool(
    'move_file',
    {
      title: 'Move or rename a file',
      description:
        'Moves or renames a file or folder within a space, rewriting links to it in other docs; or moves a file from your personal space to the team space (to_space "team"), which shares it. A meeting note’s transcript moves with it.',
      inputSchema: {
        space: Space,
        from: Path,
        to: Path.describe('The new path, e.g. "docs/archive/plan.md"'),
        to_space: Space.optional().describe(
          '"team" to move a file from your personal space to the team',
        ),
      },
      annotations: { ...write, destructiveHint: false },
    },
    ({ space, from: rawFrom, to: rawTo, to_space }) =>
      runTool(async () => {
        assertAccess(space)
        const from = writablePath(rawFrom)
        const to = writablePath(rawTo)
        const target = to_space ?? space
        assertAccess(target)
        if (target === space) {
          const { oid } = await git.move(
            space,
            from,
            to,
            author,
            async (headOid) => [
              ...(await linksInto(git, space, from, to)),
              ...(await transcriptFollows(git, space, from, to, headOid)),
            ],
            { via },
          )
          await syncer.afterHeadChanged(space)
          return { space, path: to, oid }
        }
        // Across spaces only from a personal space to the team, as the web app's Share to team:
        // pulling a team file into a personal space would hide it from everyone else.
        if (target !== TEAM_SPACE || space === TEAM_SPACE) {
          throw new HearthError(
            'bad_request',
            'Files move between spaces only from your personal space to the team space',
          )
        }
        const note = await readIfExists(git, space, from)
        if (note === null) {
          throw new HearthError(
            'not_found',
            `${from} not found in ${space} (only files move between spaces)`,
          )
        }
        const moves = [{ from, to }]
        const fm = from.toLowerCase().endsWith('.md') ? parseFrontmatter(note.content).data : {}
        if (fm.type === 'meeting') {
          const oldT = besideNote(from, transcriptPathFor(from, fm))
          const newT = besideNote(to, transcriptPathFor(to, fm))
          if (oldT && newT && (await readIfExists(git, space, oldT))) {
            moves.push({ from: oldT, to: newT })
          }
        }
        // Nothing moves unless every target is free, so a note never lands without its transcript.
        for (const m of moves) {
          if (await readIfExists(git, target, m.to)) {
            throw new HearthError('conflict', `${m.to} already exists in ${target}; nothing moved`)
          }
        }
        const moved: string[] = []
        try {
          for (const m of moves) {
            await git.moveAcrossSpaces(
              { space, path: m.from },
              { space: target, path: m.to },
              author,
              {
                via,
              },
            )
            moved.push(m.to)
          }
        } catch (err) {
          if (moved.length === 0) throw err
          const reason = err instanceof Error ? err.message : String(err)
          throw new HearthError(
            'conflict',
            `Moved ${moved.join(', ')} to ${target}, then stopped: ${reason}. Move the rest by hand.`,
          )
        } finally {
          await Promise.all([syncer.afterHeadChanged(space), syncer.afterHeadChanged(target)])
        }
        return { space: target, path: to, moved }
      }),
  )

  server.registerTool(
    'delete_file',
    {
      title: 'Delete a file',
      description:
        'Moves a file or folder to the space’s trash (.trash/<date>/…); a meeting note’s transcript goes with it. Nothing is lost: move it back out of .trash with move_file, or use restore_file with a commit from file_history.',
      inputSchema: { space: Space, path: Path },
      annotations: { ...write, destructiveHint: true },
    },
    ({ space, path: rawPath }) =>
      runTool(async () => {
        assertAccess(space)
        const path = writablePath(rawPath)
        if (isAtOrUnder(path, SPACE_LAYOUT.trash)) {
          throw new HearthError('bad_request', `${path} is already in the trash`)
        }
        const oid = await moveToTrash(git, space, path, author, via)
        await syncer.afterHeadChanged(space)
        return { space, path, oid, trashed: true }
      }),
  )

  server.registerTool(
    'file_history',
    {
      title: 'File history',
      description:
        'The commits that changed a file (following renames), or the whole space without a path: who, when, and the message. Pass a commit oid as ref to read_file to read that version, or to restore_file to bring it back.',
      inputSchema: {
        space: Space,
        path: Path.optional(),
        limit: z.number().int().min(1).max(200).optional().describe('Default 20'),
      },
      annotations: READ_ONLY,
    },
    ({ space, path, limit }) =>
      runTool(async () => {
        assertAccess(space)
        return git.log(space, { ...(path ? { path } : {}), limit: limit ?? 20 })
      }),
  )

  server.registerTool(
    'restore_file',
    {
      title: 'Restore a version',
      description:
        'Brings a file back to how it was at a commit from file_history, as a new commit (history is never rewritten). Works for a deleted file too: use the commit before the delete. For a deleted meeting note, restore its .transcript.md beside it as well.',
      inputSchema: {
        space: Space,
        path: Path,
        oid: z.string().min(1).describe('The commit to restore it from'),
      },
      annotations: { ...write, destructiveHint: true },
    },
    ({ space, path, oid }) =>
      runTool(async () => {
        assertAccess(space)
        const result = await restore(deps, { space, path, oid, author, via })
        if (result.status === 'conflict') {
          throw new HearthError(
            'conflict',
            `${path} changed while restoring; your restore is kept on ${result.conflictRef}`,
          )
        }
        return result
      }),
  )
}

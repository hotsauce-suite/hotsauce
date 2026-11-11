import { newId, parseFrontmatter, SPACE_LAYOUT, transcriptPathFor } from '@hearth/format'
import { Hono } from 'hono'
import { z } from 'zod'
import { HearthError } from '../errors.js'
import type { Change, GitStore } from '../git/index.js'
import { isIndexable } from '../index/index.js'
import { TEAM_SPACE } from '../spaces/index.js'
import { type AppDeps, type AppEnv, authorOf } from './env.js'
import { rewriteLinksToMoved } from './links.js'
import { afterCommit, isAtOrUnder, saveFile, writablePath } from './save.js'
import { viaFor } from './tokens.js'
import { PathParam, valid } from './validate.js'

const READ_CONCURRENCY = 8

export function fileRoutes(deps: AppDeps) {
  const { git, syncer } = deps
  return new Hono<AppEnv>()
    .basePath('/spaces/:space')
    .get('/tree', valid('query', z.object({ dir: z.string().optional() })), async (c) => {
      const { dir } = c.req.valid('query')
      return c.json(await git.listTree(c.req.param('space'), dir || undefined))
    })
    .get(
      '/file',
      valid('query', z.object({ path: PathParam, ref: z.string().min(1).optional() })),
      async (c) => {
        const space = c.req.param('space')
        const { path, ref } = c.req.valid('query')
        const [file, headOid] = await Promise.all([
          git.readFile(space, path, ref),
          git.headOid(space),
        ])
        return c.json({ content: file.content, blobOid: file.blobOid, headOid })
      },
    )
    .put(
      '/file',
      valid(
        'json',
        z.object({
          path: PathParam,
          content: z.string(),
          baseBlobOid: z.string().min(1).optional(),
          message: z.string().optional(),
          label: z.string().optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid('json')
        const principal = c.get('principal')
        const result = await saveFile(deps, {
          space: c.req.param('space'),
          author: authorOf(principal),
          via: viaFor(principal),
          ...body,
        })
        return result.status === 'conflict' ? c.json(result, 409) : c.json(result, 200)
      },
    )
    .delete('/file', valid('json', z.object({ path: PathParam })), async (c) => {
      const space = c.req.param('space')
      const path = writablePath(c.req.valid('json').path)
      if (isAtOrUnder(path, SPACE_LAYOUT.trash)) {
        throw new HearthError('bad_request', `${path} is already in the trash`)
      }
      const oid = await moveToTrash(git, space, path, authorOf(c.get('principal')))
      await syncer.afterHeadChanged(space)
      return c.json({ oid })
    })
    .post('/move', valid('json', z.object({ from: PathParam, to: PathParam })), async (c) => {
      const space = c.req.param('space')
      const body = c.req.valid('json')
      const from = writablePath(body.from)
      const to = writablePath(body.to)
      const { oid } = await git.move(
        space,
        from,
        to,
        authorOf(c.get('principal')),
        async (headOid) => [
          ...(await linksInto(git, space, from, to)),
          ...(await transcriptFollows(git, space, from, to, headOid)),
        ],
      )
      await syncer.afterHeadChanged(space)
      return c.json({ oid })
    })
    .post(
      '/share-to-team',
      valid('json', z.object({ path: PathParam, toFolder: z.string() })),
      async (c) => {
        const space = c.req.param('space')
        // canAccess already limits a personal space to its owner.
        if (space === TEAM_SPACE) {
          throw new HearthError('bad_request', 'Only docs in your personal space can be shared')
        }
        const body = c.req.valid('json')
        const path = writablePath(body.path)
        const name = path.slice(path.lastIndexOf('/') + 1)
        const folder = body.toFolder.replace(/^\/+|\/+$/g, '')
        const teamPath = writablePath(folder ? `${folder}/${name}` : name)
        await git.moveAcrossSpaces(
          { space, path },
          { space: TEAM_SPACE, path: teamPath },
          authorOf(c.get('principal')),
        )
        await Promise.all([syncer.afterHeadChanged(TEAM_SPACE), syncer.afterHeadChanged(space)])
        return c.json({ teamPath })
      },
    )
    .post('/folder', valid('json', z.object({ path: PathParam })), async (c) => {
      const space = c.req.param('space')
      const folder = writablePath(c.req.valid('json').path)
      const path = `${folder}/.gitkeep`
      const result = await git.commit(space, {
        changes: [{ path, content: '' }],
        author: authorOf(c.get('principal')),
        message: `docs: create folder "${folder}"`,
      })
      await afterCommit(deps, space, path, result)
      if (result.status === 'conflict') throw new HearthError('internal', 'Unexpected conflict')
      return c.json({ oid: result.oid })
    })
}

/**
 * Deleting moves to `.trash/<YYYY-MM-DD>/<path>`. A second delete of that path that day goes to
 * `.trash/<YYYY-MM-DD>-<id8>/<path>`: the suffix is on the folder, so the file keeps its name and
 * a meeting note's transcript, named in its frontmatter, still sits beside it.
 */
async function moveToTrash(
  git: GitStore,
  space: string,
  path: string,
  author: ReturnType<typeof authorOf>,
): Promise<string> {
  const day = new Date().toISOString().slice(0, 10)
  const target = `${SPACE_LAYOUT.trash}/${day}/${path}`
  const moveTo = async (to: string) =>
    (
      await git.move(space, path, to, author, (headOid) =>
        transcriptFollows(git, space, path, to, headOid),
      )
    ).oid
  try {
    return await moveTo(target)
  } catch (err) {
    if (!(err instanceof HearthError && err.code === 'conflict')) throw err
    return await moveTo(`${SPACE_LAYOUT.trash}/${day}-${newId().slice(-8)}/${path}`)
  }
}

/**
 * The other markdown files in the space with links into `from`, rewritten to point at `to`.
 * Runs inside GitStore.move, under the space lock, so HEAD is the commit the move is based on.
 */
async function linksInto(
  git: GitStore,
  space: string,
  from: string,
  to: string,
): Promise<Change[]> {
  const candidates = (await git.listAll(space))
    .map((e) => e.path)
    .filter((path) => isIndexable(path) && !isAtOrUnder(path, from))
  const changes: Change[] = []
  for (let i = 0; i < candidates.length; i += READ_CONCURRENCY) {
    await Promise.all(
      candidates.slice(i, i + READ_CONCURRENCY).map(async (path) => {
        const { content } = await git.readFile(space, path)
        const rewritten = rewriteLinksToMoved(content, path, from, to)
        if (rewritten !== content) changes.push({ path, content: rewritten })
      }),
    )
  }
  return changes
}

/**
 * A meeting note's transcript moves with it, in the same commit: the note names its transcript in
 * frontmatter `transcript`, relative to the note's folder. Anything else that moves (a folder, a
 * doc, a note whose transcript already moves with it or is missing) adds nothing.
 */
async function transcriptFollows(
  git: GitStore,
  space: string,
  from: string,
  to: string,
  headOid: string,
): Promise<Change[]> {
  if (!from.toLowerCase().endsWith('.md')) return []
  const note = await readOrNull(git, space, from, headOid)
  if (note === null) return []
  const { data } = parseFrontmatter(note)
  if (data.type !== 'meeting') return []
  const oldPath = transcriptPathFor(from, data)
  const newPath = transcriptPathFor(to, data)
  if (oldPath === null || newPath === null || oldPath === newPath) return []
  const transcript = await readOrNull(git, space, oldPath, headOid)
  if (transcript === null) return []
  if ((await readOrNull(git, space, newPath, headOid)) !== null) {
    throw new HearthError('conflict', `${newPath} already exists in ${space}`)
  }
  return [
    { path: newPath, content: transcript },
    { path: oldPath, content: null },
  ]
}

async function readOrNull(
  git: GitStore,
  space: string,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    return (await git.readFile(space, path, ref)).content
  } catch (err) {
    if (err instanceof HearthError && err.code === 'not_found') return null
    throw err
  }
}

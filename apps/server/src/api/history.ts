import { FrontmatterError, parseFrontmatter, patchFrontmatter } from '@hearth/format'
import { Hono } from 'hono'
import { z } from 'zod'
import { HearthError } from '../errors.js'
import { type Author, withVia } from '../git/index.js'
import { type AppDeps, type AppEnv, authorOf } from './env.js'
import {
  afterCommit,
  isMarkdown,
  readIfExists,
  type SaveResult,
  saveFile,
  titleOf,
  writablePath,
} from './save.js'
import { PathParam, valid } from './validate.js'

const DEFAULT_HISTORY_LIMIT = 100
const Rev = z.string().min(1)

export function historyRoutes(deps: AppDeps) {
  const { git } = deps
  return new Hono<AppEnv>()
    .basePath('/spaces/:space')
    .get(
      '/history',
      valid(
        'query',
        z.object({
          path: PathParam.optional(),
          limit: z.coerce.number().int().min(1).max(1000).optional(),
        }),
      ),
      async (c) => {
        const { path, limit } = c.req.valid('query')
        const commits = await git.log(c.req.param('space'), {
          ...(path ? { path } : {}),
          limit: limit ?? DEFAULT_HISTORY_LIMIT,
        })
        return c.json(commits)
      },
    )
    .get('/show', valid('query', z.object({ oid: Rev, path: PathParam })), async (c) => {
      const { oid, path } = c.req.valid('query')
      return c.json({ content: await git.show(c.req.param('space'), oid, path) })
    })
    .get('/diff', valid('query', z.object({ from: Rev, to: Rev, path: PathParam })), async (c) => {
      const { from, to, path } = c.req.valid('query')
      return c.json({ diff: await git.diff(c.req.param('space'), from, to, path) })
    })
    .post('/restore', valid('json', z.object({ oid: Rev, path: PathParam })), async (c) => {
      const result = await restore(deps, {
        space: c.req.param('space'),
        ...c.req.valid('json'),
        author: authorOf(c.get('principal')),
      })
      return result.status === 'conflict' ? c.json(result, 409) : c.json(result, 200)
    })
}

/**
 * A new commit with the old content; history is never rewritten. A doc is saved like any edit (it
 * keeps its id); any other file goes back byte for byte, since an image can't round-trip as text.
 */
export async function restore(
  deps: Pick<AppDeps, 'git' | 'syncer'>,
  args: { space: string; oid: string; path: string; author: Author; via?: string | undefined },
): Promise<SaveResult> {
  const { git } = deps
  const message = (title: string) => `docs: restore "${title}" to ${args.oid.slice(0, 7)}`
  const { via, ...save } = args
  if (isMarkdown(args.path)) {
    const old = await git.show(args.space, args.oid, args.path)
    // A read-only link belongs to the file as it is now: restoring never revives one that was
    // turned off, nor ends one that is on (ARCHITECTURE §20.1).
    const current = await readIfExists(git, args.space, args.path)
    const content = withShareOf(old, current?.content)
    return saveFile(deps, { ...save, content, message: message(titleOf(args.path, content)), via })
  }
  const path = writablePath(args.path)
  const { content } = await git.readBlob(args.space, path, args.oid)
  const result = await git.commit(args.space, {
    changes: [{ path, content }],
    author: args.author,
    message: withVia(message(titleOf(path, '')), via),
  })
  await afterCommit(deps, args.space, path, result)
  return result
}

/** The old text with the current file's read-only link (or none) in place of its own. */
function withShareOf(content: string, current: string | undefined): string {
  try {
    const now = current === undefined ? undefined : parseFrontmatter(current).data.share
    const share = typeof now === 'string' ? now : undefined
    if (parseFrontmatter(content).data.share === share) return content
    return patchFrontmatter(content, { share })
  } catch (err) {
    if (err instanceof FrontmatterError) throw new HearthError('bad_request', err.message)
    throw err
  }
}

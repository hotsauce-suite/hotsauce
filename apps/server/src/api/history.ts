import { Hono } from 'hono'
import { z } from 'zod'
import { type Author, withVia } from '../git/index.js'
import { type AppDeps, type AppEnv, authorOf } from './env.js'
import {
  afterCommit,
  isMarkdown,
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
    const content = await git.show(args.space, args.oid, args.path)
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

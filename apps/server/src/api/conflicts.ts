import { Hono } from 'hono'
import { z } from 'zod'
import { HearthError } from '../errors.js'
import type { ConflictInfo, GitStore } from '../git/index.js'
import { type AppDeps, type AppEnv, authorOf } from './env.js'
import { afterCommit, isMarkdown, readIfExists, withStableId, writablePath } from './save.js'
import { valid } from './validate.js'

const Ref = z.string().min(1)

export function conflictRoutes(deps: AppDeps) {
  const { git, syncer } = deps
  return new Hono<AppEnv>()
    .basePath('/spaces/:space')
    .get('/conflicts', async (c) => c.json(await git.listConflicts(c.req.param('space'))))
    .get('/conflict', valid('query', z.object({ ref: Ref })), async (c) => {
      const space = c.req.param('space')
      const { ref, path } = await findConflict(git, space, c.req.valid('query').ref)
      const [ours, theirs] = await Promise.all([
        git.readFile(space, path, ref),
        readIfExists(git, space, path),
      ])
      // `theirs` is main now (null if the file was deleted there), so a resolution starts from
      // the latest version rather than the one the conflict was raised against.
      return c.json({ path, ours: { content: ours.content }, theirs })
    })
    .post(
      '/conflict/resolve',
      valid('json', z.object({ ref: Ref, content: z.string() })),
      async (c) => {
        const space = c.req.param('space')
        const body = c.req.valid('json')
        const { ref, path } = await findConflict(git, space, body.ref)
        writablePath(path)
        const current = await readIfExists(git, space, path)
        const content = isMarkdown(path)
          ? withStableId(body.content, current?.content)
          : body.content
        const result = await git.resolveConflict(
          space,
          ref,
          { content },
          authorOf(c.get('principal')),
        )
        syncer.conflictResolved(space, ref)
        await afterCommit(deps, space, path, result)
        if (result.status === 'conflict') return c.json(result, 409)
        return c.json(
          result.status === 'committed' && content !== body.content
            ? { ...result, content }
            : result,
          200,
        )
      },
    )
}

async function findConflict(git: GitStore, space: string, ref: string): Promise<ConflictInfo> {
  const conflict = (await git.listConflicts(space)).find((c) => c.ref === ref)
  if (!conflict) throw new HearthError('not_found', `No conflict ${ref} in ${space}`)
  return conflict
}

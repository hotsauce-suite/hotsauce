import { type AppDeps, authorOf } from '../api/env.js'
import { restore } from '../api/history.js'
import { afterCommit } from '../api/save.js'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import { withVia } from '../git/message.js'
import type { WriteTracker } from './agent.js'
import type { AssistantStore, UndoRecord } from './store.js'

export type UndoDeps = Pick<AppDeps, 'git' | 'syncer' | 'spaces'>

const VIA = 'assistant'
const MAX_COMMITS_SCANNED = 50

type Changes = UndoRecord['changes']

/**
 * Wraps a write tool call: notes each visible space's HEAD before it, and afterwards records
 * which files the member's own new commits changed, with the commit to put each back to. Commits
 * by anyone else in the meantime are left out, so Undo never reverts a teammate's work.
 */
export function writeTracker(
  deps: UndoDeps,
  store: AssistantStore,
  principal: Principal,
  opts: { conversationId: string; now: () => Date },
): WriteTracker {
  return {
    async around(run) {
      const spaces = (await deps.spaces.visibleSpaces(principal)).map((s) => s.name)
      const before = new Map<string, string | null>()
      for (const space of spaces) before.set(space, await headOrNull(deps, space))
      const result = await run()
      const changes: Changes = []
      for (const space of spaces) {
        const from = before.get(space) ?? null
        const to = await headOrNull(deps, space)
        if (from === null || to === null || from === to) continue
        for (const path of await ownChangedPaths(deps, space, from, to, principal.email)) {
          changes.push({
            space,
            path,
            before: (await blobAt(deps, space, path, from)) === null ? null : from,
            afterBlob: await blobAt(deps, space, path, to),
          })
        }
      }
      if (changes.length === 0) return { result, undo: null }
      const undo = store.addUndo(
        { ownerId: principal.userId, conversationId: opts.conversationId, changes },
        opts.now(),
      )
      return { result, undo }
    },
  }
}

/**
 * Puts each file back as it was before the tool call, as new commits by the member. Refuses
 * (409) when any of them changed since, so Undo never throws away later work.
 */
export async function undoChanges(
  deps: UndoDeps,
  principal: Principal,
  changes: Changes,
): Promise<string[]> {
  for (const c of changes) {
    const now = await blobAt(deps, c.space, c.path, 'HEAD')
    if (now !== c.afterBlob) {
      throw new HearthError(
        'conflict',
        `${c.path} changed after the assistant's edit; open its history to restore it by hand`,
      )
    }
  }
  const author = authorOf(principal)
  const restored: string[] = []
  for (const c of changes) {
    if (c.before !== null) {
      const result = await restore(deps, {
        space: c.space,
        path: c.path,
        oid: c.before,
        author,
        via: VIA,
      })
      if (result.status === 'conflict') {
        throw new HearthError(
          'conflict',
          `${c.path} changed while undoing; nothing else was undone`,
        )
      }
    } else if (c.afterBlob !== null) {
      const result = await deps.git.commit(c.space, {
        changes: [{ path: c.path, content: null }],
        author,
        message: withVia(`assistant: undo create "${c.path}"`, VIA),
        unchanged: { path: c.path, blobOid: c.afterBlob },
      })
      await afterCommit(deps, c.space, c.path, result)
    }
    restored.push(c.path)
  }
  return restored
}

async function headOrNull(deps: UndoDeps, space: string): Promise<string | null> {
  try {
    return await deps.git.headOid(space)
  } catch {
    return null
  }
}

async function blobAt(
  deps: UndoDeps,
  space: string,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    return (await deps.git.readBlob(space, path, ref)).blobOid
  } catch (err) {
    if (err instanceof HearthError && err.code === 'not_found') return null
    throw err
  }
}

/** Paths changed by the member's own commits between two commits (newest first in the log). */
async function ownChangedPaths(
  deps: UndoDeps,
  space: string,
  from: string,
  to: string,
  email: string,
): Promise<string[]> {
  const commits = await deps.git.log(space, { limit: MAX_COMMITS_SCANNED })
  const start = commits.findIndex((c) => c.oid === to)
  const end = commits.findIndex((c) => c.oid === from)
  if (start === -1 || end === -1 || end < start) return []
  const paths = new Set<string>()
  for (let i = start; i < end; i++) {
    const commit = commits[i]
    if (!commit || commit.author.email.toLowerCase() !== email.toLowerCase()) continue
    // Against the commit's own (first) parent: the log's next entry can be another branch's
    // commit after a merge.
    for (const p of await deps.git.changedPaths(space, `${commit.oid}^`, commit.oid)) paths.add(p)
  }
  return [...paths]
}

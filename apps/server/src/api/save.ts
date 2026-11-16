import {
  CHECKINS_FOLDER,
  ensureId,
  extractTitle,
  FILES_FOLDER,
  FILES_FOLDERS_PATH,
  FORMS_FOLDER,
  FrontmatterError,
  parseFrontmatter,
  patchFrontmatter,
  SPACE_LAYOUT,
  TABLES_FOLDER,
} from '@hotsauce/format'
import { HotsauceError } from '../errors.js'
import {
  type Author,
  type CommitResult,
  formatCommitMessage,
  withLabel,
  withVia,
} from '../git/index.js'
import { normalizeRepoPath } from '../git/validate.js'
import { PAGES_FOLDER } from '../pages/index.js'
import { SHARE_TOKEN } from '../shares/index.js'
import type { AppDeps } from './env.js'

/**
 * A save's result. `committed` carries `content` when Hotsauce changed what the client sent (it
 * added an `id`), so the client can adopt it; `merged` always carries the merged text.
 */
export type SaveResult =
  | { status: 'committed'; oid: string; blobOid: string; content?: string }
  | Exclude<CommitResult, { status: 'committed' }>

const SPACE_CONFIG = `${SPACE_LAYOUT.meta}/space.yaml`
const FILES_OWNED = [FILES_FOLDER, FILES_FOLDERS_PATH]

/**
 * Writes one file as a member and commits it on main. Markdown gets an `id`. The message is
 * `docs: create|edit "<title>"` unless `message` is given; `label` adds the named-version trailer.
 */
export async function saveFile(
  deps: Pick<AppDeps, 'git' | 'syncer'>,
  args: {
    space: string
    path: string
    content: string
    author: Author
    baseBlobOid?: string | undefined
    /** Refuse to overwrite: a new doc or an import must never replace a file it didn't see. */
    createOnly?: boolean | undefined
    /**
     * Refuse to replace an existing file without `baseBlobOid` (AI tools): without the version
     * that was read, a person's newer edit, or the part of a long file the tool never saw, would
     * be overwritten unseen.
     */
    replaceNeedsBase?: boolean | undefined
    /**
     * Refuse to replace a file longer than this (AI tools): a tool is given only this much of a
     * file to read, so what it writes back would drop the rest.
     */
    replaceUpToChars?: number | undefined
    message?: string | undefined
    label?: string | undefined
    /** The agent channel the save came through, as a `Hotsauce-Via` trailer (ARCHITECTURE §8.2). */
    via?: string | undefined
  },
): Promise<SaveResult> {
  const path = writablePath(args.path)
  const existing = await readIfExists(deps.git, args.space, path)
  if (args.createOnly && existing) {
    throw new HotsauceError('conflict', `${path} already exists`)
  }
  if (existing && args.replaceUpToChars !== undefined) {
    if (existing.content.length > args.replaceUpToChars) {
      throw new HotsauceError(
        'bad_request',
        `${path} is too long to read whole, so it can't be replaced here; edit it in the web app.`,
      )
    }
  }
  if (args.replaceNeedsBase && existing && !args.baseBlobOid) {
    throw new HotsauceError(
      'conflict',
      `${path} already exists. Read it with read_file and pass its blobOid as base_blob_oid.`,
    )
  }
  const content = isMarkdown(path)
    ? withStableId(withOwnShare(args.content, existing?.content), existing?.content)
    : args.content
  const message = withVia(
    args.message?.trim()
      ? withLabel(args.message.trim(), args.label)
      : formatCommitMessage({
          app: 'docs',
          verb: existing ? 'edit' : 'create',
          title: titleOf(path, content),
          ...(args.label ? { label: args.label } : {}),
        }),
    args.via,
  )
  const result = await deps.git.commit(args.space, {
    changes: [{ path, content }],
    author: args.author,
    message,
    ...(args.baseBlobOid ? { base: { path, blobOid: args.baseBlobOid } } : {}),
  })
  await afterCommit(deps, args.space, path, result)
  return result.status === 'committed' && content !== args.content ? { ...result, content } : result
}

/** Index and announce a commit on main, or record the conflict branch a save was parked on. */
export async function afterCommit(
  deps: Pick<AppDeps, 'syncer'>,
  space: string,
  path: string,
  result: CommitResult,
): Promise<void> {
  if (result.status === 'conflict') deps.syncer.conflictCreated(space, result.conflictRef, path)
  else await deps.syncer.afterHeadChanged(space)
}

/**
 * Every doc Hotsauce saves has an `id`. If the client's text lost one the file already had (an old
 * version being restored, say), the existing id is kept rather than a new one minted.
 */
export function withStableId(content: string, previous: string | undefined): string {
  try {
    const previousId = previous === undefined ? null : idOf(previous)
    if (previousId !== null && idOf(content) === null) {
      return patchFrontmatter(content, { id: previousId })
    }
    return ensureId(content).text
  } catch (err) {
    if (err instanceof FrontmatterError) throw new HotsauceError('bad_request', err.message)
    throw err
  }
}

/**
 * A read-only link is made only by Share (ARCHITECTURE §20.1). Text that arrives carrying a
 * `share` the file doesn't have (typed, pasted, or written by an AI tool that was told to by
 * something it read) would publish the file under a link its sender already knows, so it gets the
 * file's own link back, or none. Leaving the link out is allowed: that only turns sharing off.
 * This is the quiet repair for the ordinary case; header text it can't patch is left as it is
 * and refused by the rule every write passes (`assertOwnShare`).
 */
export function withOwnShare(content: string, previous: string | undefined): string {
  try {
    const sent = parseFrontmatter(content).data.share
    // Only a value that could be a link; `share: true` for some other tool is left alone.
    if (typeof sent !== 'string' || !SHARE_TOKEN.test(sent)) return content
    const own = previous === undefined ? undefined : parseFrontmatter(previous).data.share
    if (sent === own) return content
    return patchFrontmatter(content, { share: typeof own === 'string' ? own : undefined })
  } catch (err) {
    if (err instanceof FrontmatterError) return content
    throw err
  }
}

function idOf(text: string): string | null {
  const id = parseFrontmatter(text).data.id
  return typeof id === 'string' && id !== '' ? id : null
}

/** The title for commit messages: the doc's own title, else the file name. One line. */
export function titleOf(path: string, content: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const title = isMarkdown(path) ? (extractTitle(content) ?? name.slice(0, -'.md'.length)) : name
  return title.replace(/\s+/g, ' ').trim()
}

export function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith('.md')
}

/** `path` itself, or anything under it when it's a folder. */
export function isAtOrUnder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`)
}

/**
 * Normalizes a path a member wants to write, move, or delete. `.hearth/space.yaml` records who
 * owns the space, so it can't be changed through the API.
 */
export function writablePath(rawPath: string): string {
  const path = normalizeRepoPath(rawPath)
  if (isAtOrUnder(SPACE_CONFIG, path)) {
    throw new HotsauceError('forbidden', `${SPACE_CONFIG} can't be changed here`)
  }
  // Hotsauce Files' pointers say which stored bytes a file is; only the Files app writes them.
  if (path === '' || FILES_OWNED.some((p) => isAtOrUnder(path, p) || isAtOrUnder(p, path))) {
    throw new HotsauceError('forbidden', 'These files are changed from the Files app')
  }
  // A published page's pointer and HTML change only by publishing it again (ARCHITECTURE §20.2).
  if (isAtOrUnder(path, PAGES_FOLDER) || isAtOrUnder(PAGES_FOLDER, path)) {
    throw new HotsauceError('forbidden', 'Pages change only when an AI tool publishes them again')
  }
  // Forms and their answers change only in the Forms app (ARCHITECTURE §21.1).
  if (isAtOrUnder(path, FORMS_FOLDER) || isAtOrUnder(FORMS_FOLDER, path)) {
    throw new HotsauceError('forbidden', 'Forms and their answers change only in the Forms app')
  }
  // Check-ins, their answers and replies change only in the Check-ins app (ARCHITECTURE §24.1).
  if (isAtOrUnder(path, CHECKINS_FOLDER) || isAtOrUnder(CHECKINS_FOLDER, path)) {
    throw new HotsauceError(
      'forbidden',
      'Check-ins and their answers change only in the Check-ins app',
    )
  }
  // A table's cells and columns change in the Tables app or its MCP tools (ARCHITECTURE §22.1).
  if (isAtOrUnder(path, TABLES_FOLDER) || isAtOrUnder(TABLES_FOLDER, path)) {
    throw new HotsauceError('forbidden', 'Tables change only in the Tables app')
  }
  return path
}

export async function readIfExists(
  git: AppDeps['git'],
  space: string,
  path: string,
): Promise<{ content: string; blobOid: string } | null> {
  try {
    return await git.readFile(space, path)
  } catch (err) {
    if (err instanceof HotsauceError && err.code === 'not_found') return null
    throw err
  }
}

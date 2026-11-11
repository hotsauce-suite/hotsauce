import { posix } from 'node:path'
import { HearthError } from '../errors.js'

const SPACE_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/i
// Revisions arrive from API query strings; refuse anything git could read as an option or range.
const REV = /^[A-Za-z0-9_][A-Za-z0-9._/~^-]{0,255}$/
const CONFLICT_REF = /^refs\/heads\/conflicts\/[0-9A-HJKMNP-TV-Z]{26}$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/** Space names become directory names under DATA_DIR/repos. */
export function assertSpace(space: string): void {
  if (!SPACE_NAME.test(space) || space.includes('..')) {
    throw new HearthError('bad_request', `Invalid space name: ${JSON.stringify(space)}`)
  }
}

/**
 * Validates a path that came from outside (API, client, repo contents) and returns its normalized
 * form (`./a` → `a`). It must stay inside the work tree and never touch `.git`.
 */
export function normalizeRepoPath(path: string): string {
  const bad = (why: string) =>
    new HearthError('bad_request', `Invalid path ${JSON.stringify(path)}: ${why}`)
  if (path === '') throw bad('empty')
  if (path.includes('\0')) throw bad('NUL byte')
  if (CONTROL_CHARS.test(path)) throw bad('control character')
  if (path.includes('\\')) throw bad('backslash')
  if (path.startsWith('/')) throw bad('absolute')
  if (path.split('/').includes('..')) throw bad('parent segment')
  const normalized = posix.normalize(path)
  if (normalized === '.' || normalized.endsWith('/')) throw bad('not a file path')
  // Case-insensitive: on macOS `.GIT/config` is `.git/config`.
  if (normalized.split('/').some((s) => s.toLowerCase() === '.git')) throw bad('.git is reserved')
  return normalized
}

/** For paths that must already be normalized: at the write boundary, and paths read from commits. */
export function assertRepoPath(path: string): void {
  if (normalizeRepoPath(path) !== path) {
    throw new HearthError('bad_request', `Invalid path ${JSON.stringify(path)}: not normalized`)
  }
}

export function assertRev(rev: string): void {
  if (!REV.test(rev) || rev.includes('..')) {
    throw new HearthError('bad_request', `Invalid revision: ${JSON.stringify(rev)}`)
  }
}

export function assertConflictRef(ref: string): void {
  if (!CONFLICT_REF.test(ref)) {
    throw new HearthError('bad_request', `Invalid conflict ref: ${JSON.stringify(ref)}`)
  }
}

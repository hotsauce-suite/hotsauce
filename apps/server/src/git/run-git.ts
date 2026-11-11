import { execFile } from 'node:child_process'
import { devNull } from 'node:os'

/** A failed `git` invocation. `exitCode` is null when git could not be spawned or was killed. */
export class GitError extends Error {
  readonly args: string[]
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string

  constructor(
    cwd: string,
    args: string[],
    exitCode: number | null,
    stdout: string,
    stderr: string,
  ) {
    const detail = redactCredentials(stderr.trim() || stdout.trim() || 'no output')
    super(
      `git ${redactCredentials(args.join(' '))} failed (exit ${exitCode ?? 'none'}) in ${cwd}: ${detail}`,
    )
    this.name = 'GitError'
    this.args = args
    this.exitCode = exitCode
    this.stdout = stdout
    this.stderr = stderr
  }
}

/** Clone URLs for remote hosts carry a token (`https://user:token@host/...`); keep it out of errors. */
export function redactCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1***@')
}

// Hearth's git behavior must not depend on the machine's ~/.gitconfig (signing, hooks paths,
// credential helpers), must never prompt, must treat paths literally (a file named `*.md` is not a
// glob), and must print English so push rejections can be recognized.
const FIXED_ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: devNull,
  GIT_TERMINAL_PROMPT: '0',
  GIT_LITERAL_PATHSPECS: '1',
  GIT_EDITOR: 'true',
  LC_ALL: 'C',
}

// A stuck network call would hold a space's write lock forever.
const TIMEOUT_MS = 5 * 60_000
const MAX_BUFFER = 256 * 1024 * 1024

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    // Inherited GIT_DIR / GIT_INDEX_FILE (e.g. when tests run inside a git hook) would redirect
    // every command to the wrong repository.
    if (value !== undefined && !key.startsWith('GIT_')) env[key] = value
  }
  return { ...env, ...FIXED_ENV }
}

function execOptions(cwd: string, env?: Record<string, string>) {
  return { cwd, env: { ...baseEnv(), ...env }, maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS }
}

/** Runs `git <args>` in `cwd` without a shell and resolves with stdout. Throws `GitError` on failure. */
export function runGit(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { ...execOptions(cwd, env), encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          const exitCode = typeof error.code === 'number' ? error.code : null
          reject(new GitError(cwd, args, exitCode, stdout, stderr || error.message))
          return
        }
        resolve(stdout)
      },
    )
  })
}

/** `runGit` for binary output (blobs of images and other uploads). */
export function runGitBuffer(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { ...execOptions(cwd, env), encoding: 'buffer' },
      (error, stdout, stderr) => {
        if (error) {
          const exitCode = typeof error.code === 'number' ? error.code : null
          const err = stderr.toString('utf8') || error.message
          reject(new GitError(cwd, args, exitCode, stdout.toString('utf8'), err))
          return
        }
        resolve(stdout)
      },
    )
  })
}

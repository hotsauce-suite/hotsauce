import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { GitError, redactCredentials, runGit } from './run-git.js'

describe('runGit', () => {
  it('resolves with stdout', async () => {
    expect(await runGit(tmpdir(), ['--version'])).toMatch(/^git version /)
  })

  it('throws GitError carrying the exit code and stderr', async () => {
    const err = await runGit(tmpdir(), ['rev-parse', '--git-dir']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitError)
    const gitError = err as GitError
    expect(gitError.exitCode).toBe(128)
    expect(gitError.stderr).toMatch(/not a git repository/)
    expect(gitError.message).toMatch(
      /git rev-parse --git-dir failed \(exit 128\).*not a git repository/,
    )
  })

  it('never puts a token from a clone URL into the error message', async () => {
    const url = 'http://hearth:s3cret-token@127.0.0.1:9/org/repo.git'
    const err = (await runGit(tmpdir(), ['ls-remote', url]).catch((e: unknown) => e)) as GitError
    expect(err).toBeInstanceOf(GitError)
    expect(err.message).not.toContain('s3cret-token')
    expect(err.message).toContain('http://***@127.0.0.1:9/org/repo.git')
  })
})

describe('redactCredentials', () => {
  it('masks userinfo in URLs and leaves everything else alone', () => {
    expect(redactCredentials('clone https://x-access-token:ghs_abc@github.com/o/r.git')).toBe(
      'clone https://***@github.com/o/r.git',
    )
    expect(redactCredentials('file:///tmp/remotes/team.git')).toBe('file:///tmp/remotes/team.git')
  })
})

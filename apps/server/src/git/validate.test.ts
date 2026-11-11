import { describe, expect, it } from 'vitest'
import { HearthError } from '../errors.js'
import {
  assertConflictRef,
  assertRepoPath,
  assertRev,
  assertSpace,
  normalizeRepoPath,
} from './validate.js'

function code(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (err) {
    return err instanceof HearthError ? err.code : 'not-a-hearth-error'
  }
}

describe('normalizeRepoPath', () => {
  it.each([
    ['docs/a.md', 'docs/a.md'],
    ['./a', 'a'],
    ['docs//a.md', 'docs/a.md'],
    ['docs/./a.md', 'docs/a.md'],
    ['.hearth/space.yaml', '.hearth/space.yaml'],
    ['notes/.gitkeep', 'notes/.gitkeep'],
    ['a file with spaces.md', 'a file with spaces.md'],
  ])('accepts %j as %j', (input, expected) => {
    expect(normalizeRepoPath(input)).toBe(expected)
  })

  it.each([
    ['../a'],
    ['a/../../b'],
    ['a/../b'],
    ['/etc/passwd'],
    ['.git/config'],
    ['.git'],
    ['a/.git/x'],
    ['.GIT/config'],
    ['a\\b'],
    ['a\0b'],
    ['a\nb'],
    [''],
    ['.'],
    ['docs/'],
  ])('rejects %j with bad_request', (input) => {
    expect(code(() => normalizeRepoPath(input))).toBe('bad_request')
  })
})

describe('assertRepoPath', () => {
  it('accepts normalized paths and rejects ones that only normalize to something valid', () => {
    expect(code(() => assertRepoPath('docs/a.md'))).toBeNull()
    expect(code(() => assertRepoPath('./a'))).toBe('bad_request')
    expect(code(() => assertRepoPath('a//b'))).toBe('bad_request')
  })
})

describe('assertSpace', () => {
  it('allows repo-style names and rejects anything path-like', () => {
    expect(code(() => assertSpace('team'))).toBeNull()
    expect(code(() => assertSpace('alice-example'))).toBeNull()
    for (const bad of ['', '..', 'a/b', '-x', '.hidden', 'a..b']) {
      expect(code(() => assertSpace(bad))).toBe('bad_request')
    }
  })
})

describe('assertRev', () => {
  it('allows oids and simple refs, rejects options and ranges', () => {
    for (const ok of ['HEAD', 'HEAD~1', 'main', '0123abcd', 'refs/heads/main']) {
      expect(code(() => assertRev(ok))).toBeNull()
    }
    for (const bad of ['--output=/tmp/x', '-p', 'a..b', 'HEAD:docs/a.md', 'a b', '']) {
      expect(code(() => assertRev(bad))).toBe('bad_request')
    }
  })
})

describe('assertConflictRef', () => {
  it('accepts only refs/heads/conflicts/<ulid>', () => {
    expect(
      code(() => assertConflictRef('refs/heads/conflicts/01JABCDEFGHJKMNPQRSTVWXYZ0')),
    ).toBeNull()
    expect(code(() => assertConflictRef('refs/heads/main'))).toBe('bad_request')
    expect(code(() => assertConflictRef('refs/heads/conflicts/../main'))).toBe('bad_request')
  })
})

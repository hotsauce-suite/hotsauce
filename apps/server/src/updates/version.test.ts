import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isNewer, parseVersion, readVersion } from './version.js'

describe('readVersion', () => {
  it('finds HOTSAUCE_VERSION in a parent folder', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hs-version-'))
    writeFileSync(path.join(root, 'HOTSAUCE_VERSION'), '0.4.2\n')
    const deep = path.join(root, 'apps', 'server', 'dist')
    mkdirSync(deep, { recursive: true })
    expect(readVersion({}, deep)).toBe('0.4.2')
  })
  it('prefers the env var', () => {
    expect(readVersion({ HOTSAUCE_VERSION: '9.9.9' }, '/')).toBe('9.9.9')
  })
  it('says unknown when there is no file', () => {
    expect(readVersion({}, mkdtempSync(path.join(tmpdir(), 'hs-none-')))).toBe('unknown')
  })
})

describe('isNewer', () => {
  it('compares numerically, with or without a v', () => {
    expect(isNewer('v0.10.0', '0.9.9')).toBe(true)
    expect(isNewer('0.2.0', 'v0.2.0')).toBe(false)
    expect(isNewer('0.1.9', '0.2.0')).toBe(false)
  })
  it('treats any release as newer than an unknown version, and junk as never newer', () => {
    expect(isNewer('0.1.0', 'unknown')).toBe(true)
    expect(isNewer('latest', '0.1.0')).toBe(false)
    expect(parseVersion('1.2')).toBeNull()
  })
})

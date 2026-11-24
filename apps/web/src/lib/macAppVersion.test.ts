import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  installedMacAppVersion,
  macAppUpdateState,
  macVersionLabel,
  offeredUpdateLabel,
  parseLatest,
} from './macAppVersion'

describe('compareVersions', () => {
  it('compares each number, not the text', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1)
    expect(compareVersions('0.26.1', '0.26.0')).toBe(1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
    expect(compareVersions('0.26.0', '0.26.0')).toBe(0)
  })
})

describe('macAppUpdateState (M5, M6)', () => {
  const latest = { version: '0.26.0', reportsVersion: true }
  it('is current at or above the newest, outdated below it', () => {
    expect(macAppUpdateState('0.26.0', latest)).toBe('current')
    expect(macAppUpdateState('0.27.0', latest)).toBe('current')
    expect(macAppUpdateState('0.14.4', latest)).toBe('outdated')
  })
  it('calls an app that says no version older only once the newest build says its own', () => {
    expect(macAppUpdateState(null, latest)).toBe('outdated')
    expect(macAppUpdateState(null, { version: '0.14.4' })).toBe('unknown')
  })
  it('tells two builds of one release apart by their build number', () => {
    const newest = { version: '0.26.0', build: '1400', reportsVersion: true }
    expect(macAppUpdateState('0.26.0+1300', newest)).toBe('outdated')
    expect(macAppUpdateState('0.26.0+1400', newest)).toBe('current')
    expect(macAppUpdateState('0.26.0', newest)).toBe('current')
  })

  it('calls a rebuild of the same app current, so a release with no Mac change offers no update', () => {
    const latest = { version: '0.36.0', build: '130', sameAppSince: '120', reportsVersion: true }
    expect(macAppUpdateState('0.34.1+120', latest)).toBe('current')
    expect(macAppUpdateState('0.35.0+125', latest)).toBe('current')
    expect(macAppUpdateState('0.33.0+119', latest)).toBe('outdated')
    expect(macAppUpdateState('0.33.0', latest)).toBe('outdated')
  })

  it("keeps sameAppSince from the server's mac-app.json", () => {
    const latest = parseLatest({
      version: '0.36.0',
      build: '130',
      sameAppSince: '120',
      reportsVersion: true,
    })
    expect(latest?.sameAppSince).toBe('120')
    expect(macAppUpdateState('0.34.1+120', latest)).toBe('current')
    expect(parseLatest({ version: '0.36.0', sameAppSince: '1x' })?.sameAppSince).toBeUndefined()
  })

  it('is unknown without a newest build to compare with', () => {
    expect(macAppUpdateState('0.26.0', null)).toBe('unknown')
  })
})

describe('installedMacAppVersion (M4)', () => {
  it('reads the version the Mac app window gives the page, and nothing odd', () => {
    expect(installedMacAppVersion()).toBeNull()
    Object.assign(window, { hotsauceMacApp: { version: '0.26.0' } })
    expect(installedMacAppVersion()).toBe('0.26.0')
    Object.assign(window, { hotsauceMacApp: { version: '0.26.0', build: '1400' } })
    expect(installedMacAppVersion()).toBe('0.26.0+1400')
    expect(macVersionLabel('0.26.0+1400')).toBe('0.26.0 (build 1400)')
    Object.assign(window, { hotsauceMacApp: { version: '<b>1</b>' } })
    expect(installedMacAppVersion()).toBeNull()
    Reflect.deleteProperty(window, 'hotsauceMacApp')
  })
})

describe('offeredUpdateLabel', () => {
  const latest = { version: '0.66.2', build: '160', reportsVersion: true }
  it('names the new build when only the build is newer, so it never offers the version you have', () => {
    expect(offeredUpdateLabel('0.66.2', '0.66.2+159', latest)).toBe('0.66.2 (build 160)')
  })
  it('gives just the version when the version is newer', () => {
    expect(offeredUpdateLabel('0.66.3', '0.66.2+159', latest)).toBe('0.66.3')
    expect(offeredUpdateLabel('0.66.2', '0.66.1+150', latest)).toBe('0.66.2')
  })
  it('says "a newer build" when the same version is offered and no build is known', () => {
    expect(offeredUpdateLabel('0.66.2', '0.66.2+159', null)).toBe('a newer build of 0.66.2')
    expect(
      offeredUpdateLabel('0.66.2', '0.66.2', { version: '0.66.2', reportsVersion: true }),
    ).toBe('a newer build of 0.66.2')
  })
  it('gives the version when the app does not say its own', () => {
    expect(offeredUpdateLabel('0.66.2', null, latest)).toBe('0.66.2')
  })
})

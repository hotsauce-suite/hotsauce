import { describe, expect, it } from 'vitest'
import { compareVersions, installedMacAppVersion, macAppUpdateState } from './macAppVersion'

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
  it('is unknown without a newest build to compare with', () => {
    expect(macAppUpdateState('0.26.0', null)).toBe('unknown')
  })
})

describe('installedMacAppVersion (M4)', () => {
  it('reads the version the Mac app window gives the page, and nothing odd', () => {
    expect(installedMacAppVersion()).toBeNull()
    Object.assign(window, { hotsauceMacApp: { version: '0.26.0' } })
    expect(installedMacAppVersion()).toBe('0.26.0')
    Object.assign(window, { hotsauceMacApp: { version: '<b>1</b>' } })
    expect(installedMacAppVersion()).toBeNull()
    Reflect.deleteProperty(window, 'hotsauceMacApp')
  })
})

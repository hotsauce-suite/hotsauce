import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { defaultMacSettings, FakeMac } from '../test/fakeMac'
import {
  HISTORY_DAYS,
  HOTKEYS,
  hasMacSettings,
  type MacSettings,
  parseMacSettings,
  readMacSettings,
  setMacSetting,
} from './macSettings'

// docs/PLAN-one-settings.md R1, R2 and the page's half of R9.

const settingsArb: fc.Arbitrary<MacSettings> = fc.record({
  hotkey: fc.constantFrom(...HOTKEYS.map((h) => h.id)),
  mode: fc.constantFrom('clean' as const, 'literal' as const),
  edgeGlow: fc.boolean(),
  meetingReminders: fc.boolean(),
  offerCallNotes: fc.boolean(),
  callNotesSupported: fc.boolean(),
  openAtLogin: fc.boolean(),
  showInMenuBar: fc.boolean(),
  menuBarIconHidden: fc.boolean(),
  historyDays: fc.constantFrom(...HISTORY_DAYS),
  microphoneChoice: fc.option(fc.string(), { nil: null }),
  microphones: fc.array(fc.record({ id: fc.string(), name: fc.string() })),
  permissions: fc.record({
    microphone: fc.boolean(),
    accessibility: fc.boolean(),
    location: fc.boolean(),
    notifications: fc.constantFrom('on' as const, 'off' as const, 'undecided' as const),
  }),
  account: fc.option(fc.emailAddress(), { nil: null }),
})

describe('parseMacSettings', () => {
  it('reads back anything the Mac can send', () => {
    fc.assert(
      fc.property(settingsArb, (s) => {
        expect(parseMacSettings(JSON.parse(JSON.stringify(s)))).toEqual(s)
      }),
    )
  })

  it('refuses a reply with any field wrong, rather than half a page', () => {
    const bad: unknown[] = [
      null,
      'on',
      { ...defaultMacSettings(), hotkey: 'leftOption' },
      { ...defaultMacSettings(), mode: 'loud' },
      { ...defaultMacSettings(), historyDays: 14 },
      { ...defaultMacSettings(), edgeGlow: 'yes' },
      { ...defaultMacSettings(), permissions: undefined },
      {
        ...defaultMacSettings(),
        permissions: { ...defaultMacSettings().permissions, notifications: true },
      },
      { ...defaultMacSettings(), account: 42 },
      { ...defaultMacSettings(), microphones: [{ id: 1, name: 'x' }] },
      { ...defaultMacSettings(), microphones: undefined },
      { ...defaultMacSettings(), microphoneChoice: 7 },
    ]
    for (const reply of bad) expect(parseMacSettings(reply)).toBeNull()
  })
})

describe('the bridge', () => {
  it('is absent in a browser', () => {
    expect(hasMacSettings({} as Window)).toBe(false)
    expect(
      hasMacSettings({
        webkit: { messageHandlers: { hotsauceMacSettings: new FakeMac() } },
      } as unknown as Window),
    ).toBe(true)
  })

  it('sends a change and returns what the Mac answers', async () => {
    const mac = new FakeMac()
    mac.refuse.add('historyDays')
    expect((await setMacSetting('mode', 'literal', mac))?.mode).toBe('literal')
    expect((await setMacSetting('historyDays', 7, mac))?.historyDays).toBe(30)
    expect(mac.requests).toEqual([
      { type: 'set', key: 'mode', value: 'literal' },
      { type: 'set', key: 'historyDays', value: 7 },
    ])
  })

  it('is null when the app throws or has no bridge', async () => {
    const throwing = { postMessage: () => Promise.reject(new Error('no')) }
    expect(await readMacSettings(throwing)).toBeNull()
    expect(await readMacSettings(null)).toBeNull()
  })
})

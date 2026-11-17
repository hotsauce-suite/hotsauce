import type { MacSettings, MacSettingsBridge, MacSettingsRequest } from '../lib/macSettings'

/**
 * A stand-in for the Mac app's side of `hotsauceMacSettings` (apps/dictate-mac MacSettingsBridge):
 * it keeps the settings, answers each request with all of them, and records what it was asked.
 */
export class FakeMac implements MacSettingsBridge {
  requests: MacSettingsRequest[] = []
  /** Settings the Mac won't change (as if a confirm dialog was cancelled). */
  refuse = new Set<string>()
  /** Answer nothing at all (an app that can't read its settings). */
  silent = false

  constructor(public settings: MacSettings = defaultMacSettings()) {}

  async postMessage(request: MacSettingsRequest): Promise<unknown> {
    this.requests.push(request)
    if (this.silent) return null
    if (request.type === 'set' && !this.refuse.has(request.key)) {
      if (request.key === 'microphone')
        this.settings.microphoneChoice = request.value as string | null
      else this.settings = { ...this.settings, [request.key]: request.value }
    }
    if (request.type === 'action') {
      const p = this.settings.permissions
      if (request.action === 'allowMicrophone')
        this.settings.permissions = { ...p, microphone: true }
      if (request.action === 'allowNotifications')
        this.settings.permissions = { ...p, notifications: 'on' }
      if (request.action === 'disconnect' && !this.refuse.has('disconnect'))
        this.settings.account = null
    }
    return request.type === 'hello' ? null : structuredClone(this.settings)
  }
}

export function defaultMacSettings(): MacSettings {
  return {
    hotkey: 'rightOption',
    mode: 'clean',
    edgeGlow: true,
    meetingReminders: true,
    offerCallNotes: true,
    callNotesSupported: true,
    openAtLogin: true,
    showInMenuBar: true,
    menuBarIconHidden: false,
    historyDays: 30,
    microphoneChoice: null,
    microphones: [
      { id: 'BuiltInMicrophoneDevice', name: 'MacBook Pro Microphone' },
      { id: 'usb-yeti', name: 'Yeti Stereo Microphone' },
    ],
    permissions: { microphone: true, accessibility: true, location: true, notifications: 'on' },
    account: 'sam@example.com',
  }
}

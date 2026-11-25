import { chordRefusal } from '../lib/macScreenshotShortcut'
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

  /** This Mac's dictation history, for the Dictate page's "On this Mac"; null: an app without it. */
  dictations: FakeDictation[] | null = null
  copied: string[] = []
  pasted: string[] = []

  constructor(public settings: MacSettings = defaultMacSettings()) {}

  async postMessage(request: MacSettingsRequest): Promise<unknown> {
    this.requests.push(request)
    if (this.silent) return null
    if (request.type === 'set' && !this.refuse.has(request.key)) {
      const shots = this.settings.screenshots
      if (request.key === 'microphone')
        this.settings.microphoneChoice = request.value as string | null
      else if (request.key === 'screenshotShortcut') {
        // As the Mac does: a chord it refuses leaves the old one.
        if (shots && chordRefusal(request.value as string) === null)
          this.settings.screenshots = { ...shots, shortcut: request.value as string }
      } else if (request.key.startsWith('screenshot') && shots) {
        const field = request.key.replace('screenshot', '').toLowerCase() as
          | 'copy'
          | 'save'
          | 'preview'
        this.settings.screenshots = { ...shots, [field]: request.value as boolean }
      } else this.settings = { ...this.settings, [request.key]: request.value }
    }
    if (request.type === 'action') {
      const p = this.settings.permissions
      if (request.action === 'allowMicrophone')
        this.settings.permissions = { ...p, microphone: true }
      if (request.action === 'allowNotifications')
        this.settings.permissions = { ...p, notifications: 'on' }
      const shots = this.settings.screenshots
      if (request.action === 'resetScreenshotShortcut' && shots)
        this.settings.screenshots = { ...shots, shortcut: shots.defaultShortcut }
      if (
        request.action === 'chooseScreenshotFolder' &&
        shots &&
        !this.refuse.has('chooseScreenshotFolder')
      )
        this.settings.screenshots = { ...shots, folder: '~/Desktop/Shots' }
      if (request.action === 'disconnect' && !this.refuse.has('disconnect')) {
        this.settings.account = null
        this.settings.connected = false
      }
    }
    if (request.type === 'helloDictations') return null
    if (request.type === 'dictations') return this.dictations ? this.reply(request) : null
    if (request.type === 'dictation') {
      const found = this.dictations?.find((d) => d.id === request.id)
      if (!found) return null
      ;(request.action === 'copy' ? this.copied : this.pasted).push(found.text)
      return { ok: true }
    }
    return request.type === 'hello' ? null : structuredClone(this.settings)
  }

  /** What apps/dictate-mac DictationsReply.build answers, for a small history. */
  private reply(request: { range: 'week' | 'month' | 'all'; search: string }) {
    const all = this.dictations ?? []
    const since = { week: 7, month: 30, all: Infinity }[request.range]
    const counted = all.filter((d) => (Date.now() - d.date) / 86_400_000 <= since)
    const words = counted.reduce((n, d) => n + d.text.split(/\s+/).length, 0)
    const byApp = new Map<string, { name: string; bundle: string | null; words: number }>()
    for (const d of counted) {
      const key = d.bundle ?? d.app ?? 'unknown'
      const app = byApp.get(key) ?? { name: d.app ?? 'Unknown app', bundle: d.bundle, words: 0 }
      app.words += d.text.split(/\s+/).length
      byApp.set(key, app)
    }
    const q = request.search.trim().toLowerCase()
    const matches = [...all]
      .sort((a, b) => b.date - a.date)
      .filter(
        (d) => !q || d.text.toLowerCase().includes(q) || (d.app ?? '').toLowerCase().includes(q),
      )
    const start = new Date()
    start.setDate(1)
    start.setHours(0, 0, 0, 0)
    return {
      range: request.range,
      stats: {
        dictations: counted.length,
        totalWords: words,
        timeSavedMinutes: words / 40,
        averageWPM: 150,
        topApps: [...byApp.values()].sort((a, b) => b.words - a.words).slice(0, 6),
      },
      month: {
        start: start.getTime(),
        leadingBlanks: (start.getDay() + 6) % 7,
        days: Array.from({ length: 30 }, (_, i) => ({
          words: i === 0 ? 12 : 0,
          level: i === 0 ? 4 : 0,
        })),
        activeDays: 1,
      },
      total: all.length,
      matched: matches.length,
      records: matches.slice(0, 200).map((d) => ({ ...d })),
      icons: { 'com.tinyspeck.slackmacgap': 'data:image/png;base64,iVBORw0KGgo=' },
    }
  }
}

export interface FakeDictation {
  id: string
  date: number
  text: string
  app: string | null
  bundle: string | null
  cleaned: boolean
  onDevice: boolean
}

export function sampleDictations(now = Date.now()): FakeDictation[] {
  const day = 86_400_000
  return [
    {
      id: 'a1',
      date: now - 2 * 3_600_000,
      text: 'Shipping Dictate to the team today',
      app: 'Slack',
      bundle: 'com.tinyspeck.slackmacgap',
      cleaned: true,
      onDevice: false,
    },
    {
      id: 'b2',
      date: now - 3 * day,
      text: 'Draft the hiring plan',
      app: 'Notes',
      bundle: 'com.apple.Notes',
      cleaned: false,
      onDevice: false,
    },
    {
      id: 'c3',
      date: now - 40 * day,
      text: 'Running ten minutes late',
      app: 'Messages',
      bundle: null,
      cleaned: true,
      onDevice: true,
    },
  ]
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
    quietAudio: 'off',
    microphoneChoice: null,
    microphones: [
      { id: 'BuiltInMicrophoneDevice', name: 'MacBook Pro Microphone' },
      { id: 'usb-yeti', name: 'Yeti Stereo Microphone' },
    ],
    permissions: { microphone: true, accessibility: true, location: true, notifications: 'on' },
    connected: true,
    account: 'sam@example.com',
    screenshots: {
      shortcut: '⌥⇧4',
      defaultShortcut: '⌥⇧4',
      folder: '~/Pictures/Hotsauce Screenshots',
      copy: true,
      save: true,
      preview: true,
    },
  }
}

/**
 * Settings → This Mac (docs/PLAN-one-settings.md). Inside the Mac app, the page reads and changes
 * the app's own settings through `webkit.messageHandlers.hotsauceMacSettings` (apps/dictate-mac
 * MacSettingsBridge). The values stay on the Mac: they are about this Mac, not the member.
 */

export const HOTKEYS = [
  { id: 'rightOption', label: 'Right Option (⌥)' },
  { id: 'rightCommand', label: 'Right Command (⌘)' },
  { id: 'fn', label: 'Fn / Globe' },
  { id: 'rightControl', label: 'Right Control (⌃)' },
  { id: 'rightShift', label: 'Right Shift (⇧)' },
] as const

export type HotkeyId = (typeof HOTKEYS)[number]['id']
export type DictationMode = 'clean' | 'literal'
export type HistoryDays = 7 | 30 | 90
export type NotificationsPermission = 'on' | 'off' | 'undecided'

export const HISTORY_DAYS: HistoryDays[] = [7, 30, 90]

/** Other apps' sound while dictating (docs/PLAN-dictate-send-and-sounds.md, R12). */
export const QUIET_AUDIO = [
  { id: 'off', label: 'Leave it' },
  { id: 'lower', label: 'Lower it' },
  { id: 'mute', label: 'Mute it' },
] as const
export type QuietAudio = (typeof QUIET_AUDIO)[number]['id']

/** What the Mac reports. */
export interface MacSettings {
  hotkey: HotkeyId
  mode: DictationMode
  edgeGlow: boolean
  meetingReminders: boolean
  offerCallNotes: boolean
  /** Whether this Mac can tell a call started (macOS 14.2 and newer). */
  callNotesSupported: boolean
  openAtLogin: boolean
  showInMenuBar: boolean
  /** On in Settings but macOS hides it (the notch, or turned off in System Settings → Menu Bar). */
  menuBarIconHidden: boolean
  historyDays: HistoryDays
  /** The microphone dictation records from, by its id; null is the Mac's default. */
  microphoneChoice: string | null
  /** The microphones this Mac has now. */
  microphones: { id: string; name: string }[]
  permissions: {
    microphone: boolean
    accessibility: boolean
    location: boolean
    notifications: NotificationsPermission
  }
  /** Whether this Mac's Dictate is connected. */
  connected: boolean
  /** Who it's connected as, when the connection says; null otherwise. */
  account: string | null
  /** Screenshots (docs/PLAN-screenshots.md R15); null from an app that predates them. */
  screenshots: MacScreenshotSettings | null
  /** Quiet other audio while dictating; null from an app that predates it. */
  quietAudio: QuietAudio | null
}

export interface MacScreenshotSettings {
  /** The chord, as the Mac shows it ("⌥⇧4"). */
  shortcut: string
  defaultShortcut: string
  /** Where shots are saved, as people read it ("~/Pictures/Hotsauce Screenshots"). */
  folder: string
  /** After a capture: copy it, save it, show the preview. */
  copy: boolean
  save: boolean
  preview: boolean
}

/** The settings the page can change, and what each takes. */
export interface MacSettingValues {
  hotkey: HotkeyId
  mode: DictationMode
  edgeGlow: boolean
  meetingReminders: boolean
  offerCallNotes: boolean
  openAtLogin: boolean
  showInMenuBar: boolean
  historyDays: HistoryDays
  microphone: string | null
  screenshotShortcut: string
  screenshotCopy: boolean
  screenshotSave: boolean
  screenshotPreview: boolean
  quietAudio: QuietAudio
}

export type MacSettingKey = keyof MacSettingValues

export type MacSettingsAction =
  | 'allowMicrophone'
  | 'allowAccessibility'
  | 'allowLocation'
  | 'allowNotifications'
  | 'openNotificationSettings'
  | 'runSetup'
  | 'clearHistory'
  | 'disconnect'
  | 'resetScreenshotShortcut'
  | 'chooseScreenshotFolder'
  | 'showScreenshotFolder'

export type MacSettingsRequest =
  | { type: 'hello' }
  | { type: 'get' }
  | { type: 'set'; key: MacSettingKey; value: MacSettingValues[MacSettingKey] }
  | { type: 'action'; action: MacSettingsAction }
  // The Dictate page's "On this Mac" (lib/macDictations.ts, docs/PLAN-dictations-page.md).
  | { type: 'helloDictations' }
  | { type: 'dictations'; range: 'week' | 'month' | 'all'; search: string }
  | { type: 'dictation'; id: string; action: 'copy' | 'paste' }

export interface MacSettingsBridge {
  postMessage(message: MacSettingsRequest): Promise<unknown> | undefined
}

export const HANDLER = 'hotsauceMacSettings'

/** The app's bridge, when this page runs in a Mac app that has This Mac. */
export function macSettingsBridge(win: Window = window): MacSettingsBridge | null {
  const handlers = (win as { webkit?: { messageHandlers?: Record<string, MacSettingsBridge> } })
    .webkit?.messageHandlers
  return handlers?.[HANDLER] ?? null
}

export function hasMacSettings(win: Window = window): boolean {
  return macSettingsBridge(win) !== null
}

const bool = (v: unknown): v is boolean => typeof v === 'boolean'
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** The Screenshots group, checked on its own: a malformed or missing one hides just the group. */
export function parseScreenshotSettings(value: unknown): MacScreenshotSettings | null {
  if (!value || typeof value !== 'object') return null
  const s = value as Record<string, unknown>
  if (!text(s.shortcut) || !text(s.defaultShortcut) || !text(s.folder)) return null
  if (!bool(s.copy) || !bool(s.save) || !bool(s.preview)) return null
  return {
    shortcut: s.shortcut,
    defaultShortcut: s.defaultShortcut,
    folder: s.folder,
    copy: s.copy,
    save: s.save,
    preview: s.preview,
  }
}

/** The Mac's answer, checked: anything malformed is null, never a half-filled page. */
export function parseMacSettings(reply: unknown): MacSettings | null {
  if (!reply || typeof reply !== 'object') return null
  const r = reply as Record<string, unknown>
  const p = r.permissions as Record<string, unknown> | undefined
  if (!HOTKEYS.some((h) => h.id === r.hotkey)) return null
  if (r.mode !== 'clean' && r.mode !== 'literal') return null
  if (!HISTORY_DAYS.includes(r.historyDays as HistoryDays)) return null
  const flags = [
    r.edgeGlow,
    r.meetingReminders,
    r.offerCallNotes,
    r.callNotesSupported,
    r.openAtLogin,
    r.showInMenuBar,
    r.menuBarIconHidden,
    r.connected,
  ]
  if (!flags.every(bool)) return null
  if (!p || !bool(p.microphone) || !bool(p.accessibility) || !bool(p.location)) return null
  if (p.notifications !== 'on' && p.notifications !== 'off' && p.notifications !== 'undecided')
    return null
  if (r.account !== null && r.account !== undefined && typeof r.account !== 'string') return null
  if (r.microphoneChoice !== null && typeof r.microphoneChoice !== 'string') return null
  const mics = r.microphones
  if (
    !Array.isArray(mics) ||
    !mics.every(
      (m) =>
        m &&
        typeof m === 'object' &&
        typeof (m as Record<string, unknown>).id === 'string' &&
        typeof (m as Record<string, unknown>).name === 'string',
    )
  )
    return null
  return {
    hotkey: r.hotkey as HotkeyId,
    mode: r.mode,
    edgeGlow: r.edgeGlow as boolean,
    meetingReminders: r.meetingReminders as boolean,
    offerCallNotes: r.offerCallNotes as boolean,
    callNotesSupported: r.callNotesSupported as boolean,
    openAtLogin: r.openAtLogin as boolean,
    showInMenuBar: r.showInMenuBar as boolean,
    menuBarIconHidden: r.menuBarIconHidden as boolean,
    historyDays: r.historyDays as HistoryDays,
    microphoneChoice: r.microphoneChoice as string | null,
    microphones: (mics as { id: string; name: string }[]).map(({ id, name }) => ({ id, name })),
    permissions: {
      microphone: p.microphone,
      accessibility: p.accessibility,
      location: p.location,
      notifications: p.notifications,
    },
    connected: r.connected as boolean,
    account: typeof r.account === 'string' && r.account ? r.account : null,
    screenshots: parseScreenshotSettings(r.screenshots),
    quietAudio: QUIET_AUDIO.some((q) => q.id === r.quietAudio)
      ? (r.quietAudio as QuietAudio)
      : null,
  }
}

async function ask(
  request: MacSettingsRequest,
  bridge: MacSettingsBridge | null,
): Promise<MacSettings | null> {
  if (!bridge) return null
  try {
    return parseMacSettings(await bridge.postMessage(request))
  } catch {
    return null
  }
}

/** The Mac's settings now; null when the app doesn't answer. */
export function readMacSettings(bridge = macSettingsBridge()): Promise<MacSettings | null> {
  return ask({ type: 'get' }, bridge)
}

/** Changes one setting; the Mac answers with all of them as they now are. */
export function setMacSetting<K extends MacSettingKey>(
  key: K,
  value: MacSettingValues[K],
  bridge = macSettingsBridge(),
): Promise<MacSettings | null> {
  return ask({ type: 'set', key, value }, bridge)
}

/** Asks for a permission, runs setup, clears history or disconnects; then the settings. */
export function macSettingsAction(
  action: MacSettingsAction,
  bridge = macSettingsBridge(),
): Promise<MacSettings | null> {
  return ask({ type: 'action', action }, bridge)
}

/**
 * Tells the app this web app has This Mac, so ⌘, can open it rather than the app's fallback
 * window (R11). Sent once per page load; harmless in an app that doesn't listen.
 */
export function sayHelloToMac(bridge = macSettingsBridge()): void {
  for (const type of ['hello', 'helloDictations'] as const) {
    try {
      // helloDictations: the Dictate page has "On this Mac" too, so the app's "Dictate…" can open
      // it (docs/PLAN-dictations-page.md R7). Sent separately: an app that predates it ignores it.
      void bridge?.postMessage({ type })?.catch?.(() => {})
    } catch {
      // An older app, or none: nothing to tell.
    }
  }
}

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
  permissions: {
    microphone: boolean
    accessibility: boolean
    location: boolean
    notifications: NotificationsPermission
  }
  /** Who this Mac's Dictate is connected as; null when it isn't. */
  account: string | null
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

export type MacSettingsRequest =
  | { type: 'hello' }
  | { type: 'get' }
  | { type: 'set'; key: MacSettingKey; value: MacSettingValues[MacSettingKey] }
  | { type: 'action'; action: MacSettingsAction }

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
  ]
  if (!flags.every(bool)) return null
  if (!p || !bool(p.microphone) || !bool(p.accessibility) || !bool(p.location)) return null
  if (p.notifications !== 'on' && p.notifications !== 'off' && p.notifications !== 'undecided')
    return null
  if (r.account !== null && r.account !== undefined && typeof r.account !== 'string') return null
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
    permissions: {
      microphone: p.microphone,
      accessibility: p.accessibility,
      location: p.location,
      notifications: p.notifications,
    },
    account: typeof r.account === 'string' && r.account ? r.account : null,
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
  try {
    void bridge?.postMessage({ type: 'hello' })?.catch?.(() => {})
  } catch {
    // An older app, or none: nothing to tell.
  }
}

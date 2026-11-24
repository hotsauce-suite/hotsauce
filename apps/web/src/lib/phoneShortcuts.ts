// The quick actions a phone or the Mac app opens straight into (docs/PLAN-phone-shortcuts.md).
// One list feeds the web app manifest's shortcuts (Android: hold the icon; vite.config.ts), the
// Phone shortcuts card in Settings → Apps (iPhone: Apple's Shortcuts app), and the Mac app's Dock
// and menu bar menus (its own copy in apps/dictate-mac/Sources/DictateCore/QuickActions.swift, kept equal by phoneShortcuts.test.ts).
// No imports: vite.config.ts loads this file too.

export interface QuickAction {
  id: 'voice-note' | 'new-task' | 'save-link' | 'ask' | 'ramble'
  /** The long name: the manifest's `name`, the card's title. */
  name: string
  /** What Android shows under the held icon. */
  shortName: string
  description: string
  /** The address that opens straight into it, from the app's root. */
  path: string
}

/** In the order Android shows them; some launchers show only the first four. */
export const QUICK_ACTIONS: readonly QuickAction[] = [
  {
    id: 'voice-note',
    name: 'New voice note',
    shortName: 'Voice note',
    description: 'Start recording a voice note',
    path: '/dictate/voice?start=1',
  },
  {
    id: 'new-task',
    name: 'New task',
    shortName: 'New task',
    description: 'Add a task',
    path: '/tasks?new=1',
  },
  {
    id: 'save-link',
    name: 'Save link',
    shortName: 'Save link',
    description: 'Save the link you copied to Links',
    path: '/links/save?paste=1',
  },
  {
    id: 'ask',
    name: 'Ask',
    shortName: 'Ask',
    description: 'Ask the assistant',
    path: '/today?ask=1',
  },
  {
    id: 'ramble',
    name: 'Ramble tasks',
    shortName: 'Ramble',
    description: 'Say your tasks out loud and add them',
    path: '/tasks?ramble=1',
  },
]

/** The iPhone share sheet's "Save to …" shortcut opens this, with the shared page added after. */
export const SHARE_SAVE_PATH = '/links/save?via=shortcut&url='

/** The full address of an action on this server, for an "Open URLs" step in Shortcuts. */
export function actionUrl(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, '')}${path}`
}

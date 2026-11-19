// What Settings search finds (docs/PLAN-settings-search.md, S2): every section of every Settings
// page, with the everyday words people type for it. `title` is the section's heading exactly as
// the page shows it (or how it starts, where the heading has the product's name in it): search
// finds the section on its page by it, and a test checks every one is there (S7).

export interface SettingEntry {
  id: string
  title: string
  /** The Settings page it's on, as the menu names it. */
  page: string
  to: string
  summary: string
  /** Other words people use for it. */
  words: readonly string[]
  /** On an Organization page: admins only (S6). */
  admin?: true
  /** Only inside the Mac app (its "This Mac" page); a browser never shows it. */
  macOnly?: true
}

const MAC = { page: 'This Mac', to: '/settings/mac', macOnly: true as const }
const GENERAL = { page: 'General', to: '/settings' }
const APPEARANCE = { page: 'Appearance', to: '/settings/appearance' }
const CONNECTIONS = { page: 'Connections', to: '/settings/connections' }
const APPS = { page: 'Apps', to: '/settings/apps' }
const org = (page: string, path = '') => ({
  page,
  to: `/settings/organization${path}`,
  admin: true as const,
})

export const SETTINGS_INDEX: readonly SettingEntry[] = [
  // This Mac, only inside the Mac app (docs/PLAN-one-settings.md R13)
  {
    id: 'mac-dictation',
    title: 'Dictation',
    ...MAC,
    summary: 'The key you hold to dictate, Clean up or Literal, and the edge glow.',
    words: [
      'dictate',
      'hotkey',
      'shortcut',
      'key',
      'option',
      'fn',
      'globe',
      'mode',
      'literal',
      'clean up',
      'glow',
      'voice',
      'typing',
    ],
  },
  {
    id: 'mac-hotkey',
    title: 'Dictation shortcut',
    ...MAC,
    summary: 'The key you hold to dictate.',
    words: ['hotkey', 'key', 'option', 'command', 'fn', 'globe', 'control', 'shift'],
  },
  {
    id: 'mac-microphone',
    title: 'Microphone for dictation',
    ...MAC,
    summary: 'Which microphone dictation records from.',
    words: ['mic', 'input', 'headset', 'airpods', 'usb', 'audio device'],
  },
  {
    id: 'mac-mode',
    title: 'Mode',
    ...MAC,
    summary: 'Clean up removes ums; Literal types exactly what you said.',
    words: ['clean up', 'literal', 'filler', 'ums', 'verbatim'],
  },
  {
    id: 'mac-edge-glow',
    title: 'Edge glow while dictating',
    ...MAC,
    summary: 'The glow around the window you’re talking into.',
    words: ['glow', 'flames', 'animation', 'reduce motion'],
  },
  {
    id: 'mac-meetings',
    title: 'Meetings',
    ...MAC,
    summary: 'Meeting reminders, and the offer to take notes when a call starts.',
    words: ['reminders', 'notifications', 'calls', 'take notes', 'zoom', 'teams'],
  },
  {
    id: 'mac-reminders',
    title: 'Meeting reminders',
    ...MAC,
    summary: 'A notification a minute before each meeting with other people.',
    words: ['reminder', 'notification', 'calendar', 'before meeting'],
  },
  {
    id: 'mac-call-notes',
    title: 'Offer to take notes when a call starts',
    ...MAC,
    summary: 'Asks “Take notes?” when another app starts a call.',
    words: ['take notes', 'call', 'zoom', 'teams', 'meet', 'detect'],
  },
  {
    id: 'mac-login',
    title: 'App',
    ...MAC,
    summary: 'Open at login, and the icon in the menu bar.',
    words: ['open at login', 'launch at login', 'startup', 'menu bar', 'icon', 'notch'],
  },
  {
    id: 'mac-open-at-login',
    title: 'Open at login',
    ...MAC,
    summary: 'Start the Mac app when you log in.',
    words: ['launch at login', 'startup', 'start automatically', 'boot'],
  },
  {
    id: 'mac-menu-bar',
    title: 'Show in menu bar',
    ...MAC,
    summary: 'The icon in the menu bar, and what to do when the notch hides it.',
    words: ['menu bar', 'icon', 'notch', 'status bar', 'tray'],
  },
  {
    id: 'mac-permissions',
    title: 'Permissions',
    ...MAC,
    summary: 'Microphone, Accessibility, Location and Notifications, and Run setup again.',
    words: [
      'microphone',
      'mic',
      'accessibility',
      'location',
      'notifications',
      'privacy',
      'allow',
      'setup',
      'set up',
    ],
  },
  {
    id: 'mac-history',
    title: 'Dictation history',
    ...MAC,
    summary: 'How long dictations stay on this Mac, and Clear history.',
    words: ['history', 'clear', 'delete', 'keep', 'retention', 'days', 'privacy'],
  },
  {
    id: 'mac-run-setup',
    title: 'First-run steps',
    ...MAC,
    summary: 'Run setup again: walks through the first-run steps, changing nothing.',
    words: ['run setup again', 'setup', 'onboarding', 'permissions', 'walkthrough'],
  },
  {
    id: 'mac-keep-history',
    title: 'Keep history for',
    ...MAC,
    summary: 'Keep dictations on this Mac for 7, 30 or 90 days.',
    words: ['history', 'retention', 'days', 'keep'],
  },
  {
    id: 'mac-clear-history',
    title: 'Clear history',
    ...MAC,
    summary: 'Delete every dictation saved on this Mac.',
    words: ['delete', 'erase', 'remove', 'history'],
  },
  {
    id: 'mac-account',
    title: 'Dictate on this Mac',
    ...MAC,
    summary: 'The account Dictate is connected as, and Disconnect this Mac.',
    words: ['disconnect', 'connected', 'account', 'sign out', 'log out'],
  },
  // General
  {
    id: 'account',
    title: 'Account',
    ...GENERAL,
    summary: 'Who you’re signed in as, and Sign out.',
    words: ['sign out', 'log out', 'email', 'profile', 'name', 'me'],
  },
  {
    id: 'appearance',
    title: 'Appearance',
    ...APPEARANCE,
    summary: 'Light, dark, or a theme of your own made from a description.',
    words: [
      'dark mode',
      'light mode',
      'theme',
      'themes',
      'colors',
      'colours',
      'night',
      'look',
      'fonts',
      'custom theme',
      'ai theme',
    ],
  },
  {
    id: 'notifications',
    title: 'Notifications',
    ...GENERAL,
    summary: 'Reminders before meetings and due tasks, check-ins and the daily briefing.',
    words: ['alerts', 'reminders', 'push', 'notify', 'sound', 'briefing', 'test notification'],
  },
  {
    id: 'keyboard',
    title: 'Keyboard',
    ...GENERAL,
    summary: 'Single-key shortcuts and the list of every shortcut.',
    words: ['shortcuts', 'keys', 'hotkeys', 'single-key', 'voice control', 'accessibility'],
  },
  {
    id: 'weather',
    title: 'Weather',
    ...GENERAL,
    summary: 'Where Today’s weather is for, on this device.',
    words: ['location', 'city', 'place', 'forecast', 'today', 'temperature'],
  },

  // Connections
  {
    id: 'calendars',
    title: 'Calendars',
    ...CONNECTIONS,
    summary: 'Which Google calendars Meetings reads.',
    words: ['google calendar', 'events', 'meetings', 'schedule'],
  },
  {
    id: 'ai-tools',
    title: 'Connect an AI tool',
    ...CONNECTIONS,
    summary: 'Tokens for Claude Code, Cursor and other AI tools and scripts.',
    words: [
      'claude',
      'chatgpt',
      'cursor',
      'codex',
      'mcp',
      'token',
      'access token',
      'api key',
      'scripts',
    ],
  },
  {
    id: 'connected-apps',
    title: 'Connect by signing in',
    ...CONNECTIONS,
    summary: 'Add Claude, ChatGPT or Grok as a connector with no token.',
    words: ['claude', 'chatgpt', 'grok', 'connector', 'mcp', 'oauth', 'connected apps'],
  },

  // Apps
  {
    id: 'mac-app',
    title: 'Mac app',
    ...APPS,
    summary: 'Download the Mac app: dictation, call recording and reminders.',
    words: ['download', 'desktop', 'dictate', 'dictation', 'install', 'macos', 'update'],
  },
  {
    id: 'web-app',
    title: 'Web app',
    ...APPS,
    summary: 'Install the app from Chrome or on your phone’s Home Screen.',
    words: ['install', 'pwa', 'home screen', 'phone', 'iphone', 'dock', 'taskbar'],
  },
  {
    id: 'extension',
    title: 'Chrome extension',
    ...APPS,
    summary: 'Notes on Google Meet calls, and saving pages to Links.',
    words: ['browser', 'google meet', 'save page', 'links', 'install', 'plugin', 'add-on'],
  },
  {
    id: 'whats-new',
    title: 'What’s new',
    page: 'Help',
    to: '/settings/whats-new',
    summary: 'Release notes, and which version this is.',
    words: ['release notes', 'changelog', 'version', 'changes', 'whats new', 'updates'],
  },

  // Organization: Workspace
  {
    id: 'org-names',
    title: 'Names',
    ...org('Workspace'),
    summary: 'What your organization and this workspace are called.',
    words: ['organization name', 'workspace name', 'rename', 'company', 'product name'],
  },
  {
    id: 'org-weather',
    title: 'Default weather city',
    ...org('Workspace'),
    summary: 'The city Today shows weather for when someone hasn’t picked one.',
    words: ['weather', 'location', 'city', 'today', 'forecast'],
  },
  {
    id: 'org-start-here',
    title: 'Start-here doc',
    ...org('Workspace'),
    summary: 'The doc new people see first on Today.',
    words: ['onboarding', 'welcome', 'new people', 'getting started', 'handbook'],
  },
  {
    id: 'org-chat',
    title: 'Team chat',
    ...org('Workspace'),
    summary: 'A Chat button in the sidebar that opens your team chat.',
    words: ['slack', 'chat link', 'chat button', 'messages'],
  },
  {
    id: 'org-chat-rooms',
    title: 'Chat rooms',
    ...org('Workspace'),
    summary: 'Where forms and check-ins post, and which rooms search and Ask can read.',
    words: [
      'forms',
      'slack',
      'webhook',
      'chat',
      'answers',
      'responses',
      'read for context',
      'chat search',
      'bot',
    ],
  },

  // Organization: Brand
  {
    id: 'org-brand',
    title: 'Your brand',
    ...org('Brand', '/brand'),
    summary: 'Logo, colours, fonts and voice.',
    words: ['logo', 'colors', 'colours', 'fonts', 'voice', 'style', 'brand'],
  },

  // Organization: People and access
  {
    id: 'org-people',
    title: 'Who can sign in',
    ...org('People and access', '/people'),
    summary: 'Email domains, invited people and admins.',
    words: ['invite', 'invited people', 'email domains', 'admins', 'members', 'access', 'team'],
  },
  {
    id: 'org-sign-in',
    title: 'Sign-in',
    ...org('People and access', '/people'),
    summary: 'The sign-in service and its keys.',
    words: ['clerk', 'login', 'google sign-in', 'keys', 'authentication'],
  },
  {
    id: 'org-links',
    title: 'Read-only links',
    ...org('People and access', '/people'),
    summary: 'Whether people can share read-only links outside the organization.',
    words: ['share', 'sharing', 'public links', 'anyone with the link'],
  },

  // Organization: AI
  {
    id: 'org-ai',
    title: 'AI and transcription',
    ...org('AI', '/ai'),
    summary: 'The Anthropic and Deepgram keys.',
    words: ['anthropic', 'deepgram', 'claude', 'api key', 'transcripts', 'transcribe'],
  },
  {
    id: 'org-assistant',
    title: 'Assistant',
    ...org('AI', '/ai'),
    summary: 'Which model the assistant uses, and its monthly limit.',
    words: ['model', 'limit', 'spending', 'cost', 'ai chat', 'claude'],
  },

  // Organization: Data and updates
  {
    id: 'org-storage',
    title: 'Where your files live',
    ...org('Data and updates', '/data'),
    summary: 'GitHub or Forgejo for documents, and storage for audio.',
    words: ['github', 'forgejo', 'repositories', 'storage', 'r2', 's3', 'audio', 'files'],
  },
  {
    id: 'org-backups',
    title: 'Backups',
    ...org('Data and updates', '/data'),
    summary: 'Nightly backups, and backing up now.',
    words: ['backup', 'restore', 'nightly', 'export'],
  },
  {
    id: 'org-updates',
    title: 'Updates',
    ...org('Data and updates', '/data'),
    summary: 'Which version runs, and updating it.',
    words: ['version', 'upgrade', 'auto updates', 'check for updates', 'release'],
  },

  // Organization: Usage
  {
    id: 'org-usage',
    title: 'Usage',
    ...org('Usage', '/usage'),
    summary: 'Which apps people use.',
    words: ['analytics', 'stats', 'activity', 'adoption', 'apps'],
  },
]

/** Lowercase, without accents, curly quotes made plain, split on anything but letters and digits. */
function wordsOf(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[’‘]/g, "'")
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/'/g, ''))
    .filter(Boolean)
}

/**
 * The sections whose words every typed word starts (S3), members' own only unless `admin` (S6),
 * and Mac-only ones only when `mac`.
 * Titles that start with the first typed word come first, then other title matches, then the rest,
 * each in the menu's order.
 */
export function searchSettings(
  query: string,
  {
    admin,
    mac = false,
    index = SETTINGS_INDEX,
  }: { admin: boolean; mac?: boolean; index?: readonly SettingEntry[] },
): SettingEntry[] {
  const typed = wordsOf(query)
  if (typed.length === 0) return []
  const scored: { entry: SettingEntry; rank: number; at: number }[] = []
  index.forEach((entry, at) => {
    if ((entry.admin && !admin) || (entry.macOnly && !mac)) return
    const title = wordsOf(entry.title)
    const all = [
      ...title,
      ...wordsOf(entry.page),
      ...wordsOf(entry.summary),
      ...entry.words.flatMap(wordsOf),
    ]
    if (!typed.every((t) => all.some((w) => w.startsWith(t)))) return
    const first = typed[0] as string
    const rank = title[0]?.startsWith(first)
      ? 0
      : typed.every((t) => title.some((w) => w.startsWith(t)))
        ? 1
        : 2
    scored.push({ entry, rank, at })
  })
  return scored.sort((a, b) => a.rank - b.rank || a.at - b.at).map((s) => s.entry)
}

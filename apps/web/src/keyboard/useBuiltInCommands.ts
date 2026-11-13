// The commands every page has in Command-K: create anything, go to every place that isn't an
// app (apps are Command-K's own "Go to" rows), and change this device's preferences.

import { useNavigate } from 'react-router'
import { boardsApi } from '../api/boards'
import { notesBus } from '../apps/notes/useNotes'
import { boardUrl, DOCS_ROOT, docUrl } from '../lib/paths'
import { chooseTheme } from '../lib/theme'
import { useSession } from '../state/session'
import { untitledDocPath } from '../state/treeStore'
import { type Command, useCommands } from './commands'
import { setSingleKeys, useSingleKeys } from './prefs'

/** Puts the cursor in `selector` once the page that holds it has rendered (up to 2 s). */
function focusWhenReady(selector: string) {
  const started = Date.now()
  const tick = () => {
    const el = document.querySelector<HTMLElement>(selector)
    if (el) el.focus()
    else if (Date.now() - started < 2000) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

export function useBuiltInCommands({ openShortcuts }: { openShortcuts: () => void }): void {
  const navigate = useNavigate()
  const session = useSession()
  const singleKeys = useSingleKeys()
  const { notify } = session

  const commands: Command[] = [
    // Create
    {
      id: 'new-doc',
      title: 'New doc',
      group: 'create',
      icon: 'file',
      keywords: ['page', 'document', 'write', 'create'],
      run: () => {
        const space = session.space
        void untitledDocPath(session.tree, space, DOCS_ROOT).then((path) =>
          navigate(docUrl(space, path), { state: { newDoc: true } }),
        )
      },
    },
    {
      id: 'new-meeting',
      title: 'Start a meeting',
      group: 'create',
      icon: 'mic',
      keywords: ['new', 'record', 'notes', 'call'],
      run: () => navigate('/meetings/start'),
    },
    {
      id: 'new-task',
      title: 'New task',
      group: 'create',
      icon: 'tasks',
      keywords: ['todo', 'add', 'reminder'],
      run: () => navigate('/tasks', { state: { quickAdd: true } }),
    },
    {
      id: 'new-note',
      title: 'New note',
      group: 'create',
      icon: 'notes',
      keywords: ['jot', 'add', 'checklist'],
      run: () => {
        // A Notes page already open hears the bus; one about to open reads the state.
        navigate('/notes', { state: { newNote: true } })
        notesBus.emit({ type: 'new-note' })
      },
    },
    {
      id: 'new-voice-note',
      title: 'New voice note',
      group: 'create',
      icon: 'mic',
      keywords: ['dictate', 'record', 'speak'],
      run: () => navigate('/dictate/voice?start=1'),
    },
    {
      id: 'new-clip',
      title: 'Record a clip',
      group: 'create',
      icon: 'video',
      keywords: ['new', 'screen', 'camera', 'video', 'loom'],
      run: () => navigate('/clips/new'),
    },
    {
      id: 'new-board',
      title: 'New board',
      group: 'create',
      icon: 'board',
      keywords: ['whiteboard', 'draw', 'sketch'],
      run: () => {
        boardsApi.create({}).then(
          (board) => navigate(boardUrl(board.space, board.path), { state: { fresh: true } }),
          (err: unknown) => notify(err instanceof Error ? err.message : 'Couldn’t make the board'),
        )
      },
    },
    {
      id: 'new-form',
      title: 'New form',
      group: 'create',
      icon: 'form',
      keywords: ['survey', 'signup', 'request'],
      run: () => {
        navigate('/forms')
        focusWhenReady(`input[aria-label="New form's title"]`)
      },
    },
    {
      id: 'new-table',
      title: 'New table',
      group: 'create',
      icon: 'table',
      keywords: ['spreadsheet', 'sheet', 'grid'],
      run: () => {
        navigate('/tables')
        focusWhenReady(`input[aria-label="New table's name"]`)
      },
    },
    {
      id: 'save-link',
      title: 'Save a link',
      group: 'create',
      icon: 'bookmark',
      keywords: ['new', 'bookmark', 'read', 'later', 'url'],
      run: () => navigate('/links/save'),
    },

    // Go to (apps come from Command-K's own app rows)
    {
      id: 'go-settings',
      title: 'Settings',
      group: 'go',
      icon: 'gear',
      keywords: ['preferences', 'account', 'tokens'],
      shortcut: 'go.settings',
      run: () => navigate('/settings'),
    },
    {
      id: 'go-agent-brief',
      title: 'Agent brief',
      group: 'go',
      icon: 'sparkle',
      keywords: ['priorities', 'claude', 'ai'],
      run: () => navigate('/meetings/brief'),
    },
    {
      id: 'go-connect-claude',
      title: 'Connect Claude',
      group: 'go',
      icon: 'sparkle',
      keywords: ['mcp', 'token', 'ai', 'claude', 'code', 'desktop'],
      run: () => navigate('/settings'),
    },
    {
      id: 'go-mac-app',
      title: 'Mac app',
      group: 'go',
      icon: 'laptop',
      keywords: ['download', 'desktop', 'dictation'],
      run: () => navigate('/settings#mac-app'),
    },
    {
      id: 'go-feedback',
      title: 'Send feedback',
      group: 'go',
      icon: 'chat',
      keywords: ['bug', 'idea', 'report'],
      run: () => navigate('/feedback'),
    },

    // Preferences
    {
      id: 'theme-light',
      title: 'Light theme',
      group: 'prefs',
      icon: 'palette',
      keywords: ['appearance', 'mode', 'colors'],
      run: () => chooseTheme('light'),
    },
    {
      id: 'theme-dark',
      title: 'Dark theme',
      group: 'prefs',
      icon: 'palette',
      keywords: ['appearance', 'mode', 'night', 'colors'],
      run: () => chooseTheme('dark'),
    },
    {
      id: 'theme-system',
      title: 'Match the system theme',
      group: 'prefs',
      icon: 'palette',
      keywords: ['appearance', 'mode', 'auto', 'colors'],
      run: () => chooseTheme('system'),
    },
    {
      id: 'single-keys',
      title: singleKeys ? 'Turn off single-key shortcuts' : 'Turn on single-key shortcuts',
      group: 'prefs',
      icon: 'sliders',
      keywords: ['keyboard', 'accessibility', 'voice'],
      run: () => setSingleKeys(!singleKeys),
    },
    {
      id: 'shortcuts',
      title: 'Keyboard shortcuts',
      group: 'prefs',
      icon: 'sliders',
      keywords: ['keys', 'help', 'hotkeys', 'cheat'],
      shortcut: 'global.help',
      run: openShortcuts,
    },
  ]

  useCommands(commands, String(singleKeys))
}

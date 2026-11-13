// Every keyboard shortcut in the web app, in one list. The key listener (shortcuts.ts),
// the `?` sheet, Command-K's key hints and tooltips all read it, so they never disagree.
// A page binds a handler to an id with `useShortcut(id, run)`; an entry with `handledBy` is
// handled by its own component (CodeMirror, the Tables grid) and is listed here only so the
// sheet shows it. catalog.test.ts rejects two entries sharing keys and any browser-owned key.

import type { AppId } from '../apps/registry'

export type SectionId =
  | 'everywhere'
  | 'go'
  | 'docs-editor'
  | 'tasks'
  | 'clips'
  | 'tables'
  | 'forms'
  | 'checkins'

export interface Section {
  title: string
  /** The app the section belongs to; none for Everywhere. */
  app?: AppId
  /** Live on every page: its keys clash with every other section's. */
  always?: boolean
}

export const SECTIONS: Record<SectionId, Section> = {
  everywhere: { title: 'Everywhere', always: true },
  go: { title: 'Go to', always: true },
  'docs-editor': { title: 'Writing a doc', app: 'docs' },
  tasks: { title: 'Tasks', app: 'tasks' },
  clips: { title: 'Watching a clip', app: 'clips' },
  tables: { title: 'Tables', app: 'tables' },
  forms: { title: 'Forms', app: 'forms' },
  checkins: { title: 'Check-ins', app: 'checkins' },
}

export interface ShortcutDef {
  /** Alternative key specs (see keys.ts); any one of them runs the shortcut. */
  keys: readonly string[]
  /** What it does, as the sheet and Command-K say it. */
  label: string
  section: SectionId
  /** Handled by the component itself, not the key listener. */
  handledBy?: 'editor' | 'page'
  /** Space and Enter run it even on a focused button (play and pause, as on YouTube). */
  onControls?: boolean
}

const def = <T extends Record<string, ShortcutDef>>(defs: T): Record<keyof T, ShortcutDef> => defs

/** `g` then a letter opens an app (or Settings), as in Gmail, GitHub and Linear. */
export const GO_KEYS = {
  today: 'h',
  docs: 'd',
  meetings: 'm',
  tasks: 't',
  notes: 'n',
  dictate: 'v',
  clips: 'c',
  checkins: 'i',
  boards: 'b',
  people: 'p',
  files: 'f',
  forms: 'o',
  tables: 'e',
  links: 'l',
  briefcast: 'r',
  settings: 's',
} as const satisfies Record<AppId | 'settings', string>

export type GoTarget = keyof typeof GO_KEYS

const GO_NAMES: Record<GoTarget, string> = {
  today: 'Today',
  docs: 'Docs',
  meetings: 'Meetings',
  tasks: 'Tasks',
  notes: 'Notes',
  dictate: 'Dictate',
  clips: 'Clips',
  checkins: 'Check-ins',
  boards: 'Boards',
  people: 'People',
  files: 'Files',
  forms: 'Forms',
  tables: 'Tables',
  links: 'Links',
  briefcast: 'Briefcast',
  settings: 'Settings',
}

const goShortcuts = Object.fromEntries(
  (Object.keys(GO_KEYS) as GoTarget[]).map((target) => [
    `go.${target}`,
    { keys: [`g ${GO_KEYS[target]}`], label: GO_NAMES[target], section: 'go' },
  ]),
) as unknown as Record<`go.${GoTarget}`, ShortcutDef>

export const SHORTCUTS = def({
  // Everywhere
  'global.commandK': { keys: ['mod+k'], label: 'Open the command menu', section: 'everywhere' },
  'global.help': { keys: ['?'], label: 'Show keyboard shortcuts', section: 'everywhere' },
  'global.create': {
    keys: ['c'],
    label: 'Create something new in this app',
    section: 'everywhere',
  },
  'global.search': { keys: ['/'], label: 'Search', section: 'everywhere' },
  'global.sidebar': { keys: ['mod+\\'], label: 'Show or hide the sidebar', section: 'everywhere' },
  'global.close': {
    keys: ['Escape'],
    label: 'Close the dialog, menu or panel',
    section: 'everywhere',
    handledBy: 'page',
  },

  // Docs: CodeMirror's keymap (editor/setup.ts) and live preview.
  'docs.bold': { keys: ['mod+b'], label: 'Bold', section: 'docs-editor', handledBy: 'editor' },
  'docs.italic': { keys: ['mod+i'], label: 'Italic', section: 'docs-editor', handledBy: 'editor' },
  'docs.link': {
    keys: ['mod+k'],
    label: 'Make the selected text a link',
    section: 'docs-editor',
    handledBy: 'editor',
  },
  'docs.find': {
    keys: ['mod+f'],
    label: 'Find in the doc',
    section: 'docs-editor',
    handledBy: 'editor',
  },
  'docs.undo': { keys: ['mod+z'], label: 'Undo', section: 'docs-editor', handledBy: 'editor' },
  'docs.redo': {
    keys: ['shift+mod+z'],
    label: 'Redo',
    section: 'docs-editor',
    handledBy: 'editor',
  },
  'docs.wikilink': {
    keys: ['[ ['],
    label: 'Link to another doc',
    section: 'docs-editor',
    handledBy: 'editor',
  },

  // Tasks (TasksPage)
  'tasks.quickAdd': { keys: ['q'], label: 'Add a task', section: 'tasks' },
  'tasks.next': { keys: ['j', 'ArrowDown'], label: 'Next task', section: 'tasks' },
  'tasks.previous': { keys: ['k', 'ArrowUp'], label: 'Previous task', section: 'tasks' },
  'tasks.complete': { keys: ['x', 'Space'], label: 'Complete or reopen', section: 'tasks' },
  'tasks.open': { keys: ['Enter'], label: 'Open the task', section: 'tasks' },
  'tasks.edit': { keys: ['e'], label: 'Edit the title', section: 'tasks' },
  'tasks.priority': { keys: ['1', '2', '3', '4'], label: 'Set priority 1 to 4', section: 'tasks' },
  'tasks.dueToday': { keys: ['t'], label: 'Due today', section: 'tasks' },
  'tasks.dueTomorrow': { keys: ['m'], label: 'Due tomorrow', section: 'tasks' },
  'tasks.delete': { keys: ['Delete', 'Backspace'], label: 'Delete the task', section: 'tasks' },

  // Clips (ClipPage)
  'clips.play': {
    keys: ['Space', 'k'],
    label: 'Play or pause',
    section: 'clips',
    onControls: true,
  },
  'clips.back5': { keys: ['ArrowLeft'], label: 'Back 5 seconds', section: 'clips' },
  'clips.forward5': { keys: ['ArrowRight'], label: 'Forward 5 seconds', section: 'clips' },
  'clips.back10': { keys: ['j'], label: 'Back 10 seconds', section: 'clips' },
  'clips.forward10': { keys: ['l'], label: 'Forward 10 seconds', section: 'clips' },
  'clips.faster': { keys: ['>'], label: 'Faster', section: 'clips' },
  'clips.slower': { keys: ['<'], label: 'Slower', section: 'clips' },

  // Tables: the grid's own handler (tables/Grid.tsx).
  'tables.move': {
    keys: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'],
    label: 'Move between cells',
    section: 'tables',
    handledBy: 'page',
  },
  'tables.nextCell': { keys: ['Tab'], label: 'Next cell', section: 'tables', handledBy: 'page' },
  'tables.edit': {
    keys: ['Enter', 'F2'],
    label: 'Edit the cell',
    section: 'tables',
    handledBy: 'page',
  },
  'tables.clear': {
    keys: ['Delete'],
    label: 'Clear the cells',
    section: 'tables',
    handledBy: 'page',
  },
  'tables.undo': { keys: ['mod+z'], label: 'Undo', section: 'tables', handledBy: 'page' },
  'tables.redo': { keys: ['mod+y'], label: 'Redo', section: 'tables', handledBy: 'page' },
  'tables.selectAll': {
    keys: ['mod+a'],
    label: 'Select every cell',
    section: 'tables',
    handledBy: 'page',
  },
  'tables.save': { keys: ['mod+s'], label: 'Save', section: 'tables', handledBy: 'page' },

  'forms.save': { keys: ['mod+s'], label: 'Save the form', section: 'forms', handledBy: 'page' },
  'checkins.post': {
    keys: ['mod+Enter'],
    label: 'Post your answer',
    section: 'checkins',
    handledBy: 'page',
  },

  ...goShortcuts,
})

export type ShortcutId = keyof typeof SHORTCUTS

export const shortcutIds = Object.keys(SHORTCUTS) as ShortcutId[]

export function shortcut(id: ShortcutId): ShortcutDef {
  return SHORTCUTS[id]
}

/**
 * Keys a web page must not take: the browser's and the Mac's own (tabs, windows, zoom,
 * developer tools, quit, hide). `mod` covers ⌘ and Ctrl alike.
 */
export const RESERVED = [
  'mod+t',
  'mod+w',
  'mod+n',
  'mod+l',
  'mod+r',
  'mod+q',
  'mod+h',
  'mod+m',
  'mod+p',
  'mod+0',
  'mod+1',
  'mod+2',
  'mod+3',
  'mod+4',
  'mod+5',
  'mod+6',
  'mod+7',
  'mod+8',
  'mod+9',
  'mod+=',
  'mod+-',
  'mod+Tab',
  'shift+mod+t',
  'shift+mod+n',
  'shift+mod+w',
  'shift+mod+c',
  'shift+mod+i',
  'shift+mod+j',
  'alt+mod+i',
  'alt+mod+j',
] as const

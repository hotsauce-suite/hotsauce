// What Command-K can do besides search: create things, go places, change preferences, and act
// on what's open. The shell registers the built-ins (useBuiltInCommands); a page or feature adds
// its own while mounted with `useCommands`, and they show under "On this page" (group 'page').

import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { IconName } from '../components/Icon'
import type { ShortcutId } from './catalog'

export type CommandGroup = 'page' | 'create' | 'ask' | 'go' | 'prefs'

export const GROUP_TITLES: Record<CommandGroup, string> = {
  page: 'On this page',
  create: 'Create',
  ask: 'Ask',
  go: 'Go to',
  prefs: 'Preferences',
}

/** The order Command-K shows the groups in. */
export const GROUP_ORDER: readonly CommandGroup[] = ['page', 'create', 'go', 'prefs', 'ask']

export interface Command {
  /** Unique; also its Command-K value and test id (`cmdk-command-<id>`). */
  id: string
  title: string
  group: CommandGroup
  icon?: IconName
  /** Other words people type for it ("page" for New doc, "dark" for Dark theme). */
  keywords?: readonly string[]
  /** Its keyboard shortcut, shown on the row. */
  shortcut?: ShortcutId
  /** For a step that can't be undone: the question Command-K asks before running it. */
  confirm?: string
  /** Offered whatever is typed, taking it as its input (Ask the assistant). */
  anyQuery?: boolean
  /** Gets what was typed, for commands that use it ("Ask the assistant: …"). */
  run: (query: string) => void
}

const registered: Command[][] = []
const listeners = new Set<() => void>()
let snapshot: readonly Command[] = []

function changed() {
  // The newest registration wins an id, so a page can replace a built-in.
  const byId = new Map<string, Command>()
  for (const list of registered) for (const command of list) byId.set(command.id, command)
  snapshot = [...byId.values()]
  for (const listener of listeners) listener()
}

/** Adds commands until the returned function is called. */
export function registerCommands(commands: readonly Command[]): () => void {
  const list = [...commands]
  registered.push(list)
  changed()
  return () => {
    const i = registered.indexOf(list)
    if (i !== -1) registered.splice(i, 1)
    changed()
  }
}

/** Every command registered now. */
export function allCommands(): readonly Command[] {
  return snapshot
}

export function useCommandList(): readonly Command[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    allCommands,
    allCommands,
  )
}

/**
 * Registers commands while the component is mounted. Re-registers when `key` changes (pass
 * what the titles depend on); `run` always calls the latest closure.
 */
export function useCommands(commands: readonly Command[], key = ''): void {
  const latest = useRef(commands)
  latest.current = commands
  const ids = commands.map((c) => `${c.id}:${c.title}`).join('|')
  // biome-ignore lint/correctness/useExhaustiveDependencies: ids and key describe the list.
  useEffect(() => {
    const stable = latest.current.map((c) => ({
      ...c,
      run: (q: string) => latest.current.find((x) => x.id === c.id)?.run(q),
    }))
    return registerCommands(stable)
  }, [ids, key])
}

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)

/**
 * The commands every typed word starts a word of (title, keywords, the group's name), so "e"
 * matches nothing while "new t" finds New task. An empty query matches every command.
 */
export function matchCommands(commands: readonly Command[], query: string): Command[] {
  const typed = words(query)
  if (typed.length === 0) return [...commands]
  return commands.filter((command) => {
    if (command.anyQuery) return true
    const vocabulary = [
      ...words(command.title),
      ...(command.keywords ?? []).flatMap(words),
      ...words(GROUP_TITLES[command.group]),
    ]
    return typed.every((word) => vocabulary.some((known) => known.startsWith(word)))
  })
}

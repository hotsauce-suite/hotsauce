import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import { type CommitResult, formatCommitMessage, type GitStore } from '../git/index.js'
import type { Index } from '../index/index.js'
import { listMeetings, matchesPerson } from './list.js'

/** An unticked `- [ ] …` line in a meeting note, with the 1-based line it sits on in the file. */
export interface ActionItem {
  line: number
  text: string
}

export interface MeetingActionItems {
  space: string
  path: string
  title: string
  date: string
  items: ActionItem[]
}

/** How many of the newest meeting notes are read for open items; older ones are out of view. */
export const ACTION_ITEM_MEETINGS = 60

const OPEN_TASK = /^([ \t]*[-*+][ \t]+)\[ \]([ \t]+)(\S.*)$/
const TICK_ATTEMPTS = 3
const CHANGED = 'That action item changed; reload to see the latest'
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** The open checklist items of a note, skipping fenced code. Line numbers count from 1. */
export function openActionItems(content: string): ActionItem[] {
  const items: ActionItem[] = []
  let fence: string | null = null
  content.split(/\r?\n/).forEach((line, i) => {
    const marker = FENCE.exec(line)?.[1]
    if (marker) {
      if (fence === null) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
      return
    }
    if (fence !== null) return
    const match = OPEN_TASK.exec(line)
    if (match?.[3]) items.push({ line: i + 1, text: match[3].trim() })
  })
  return items
}

/**
 * `GET /api/meetings/action-items`: open checklist items from the member's meetings, newest
 * meeting first. "Their" meetings are the notes in their personal space and team notes that list
 * them as an attendee. Reads the newest ACTION_ITEM_MEETINGS notes from Git.
 */
export async function listActionItems(
  deps: { index: Pick<Index, 'listFiles'>; git: Pick<GitStore, 'readFile'> },
  principal: Principal,
  spaces: Array<{ name: string; kind: 'team' | 'personal' }>,
): Promise<MeetingActionItems[]> {
  const personal = new Set(spaces.filter((s) => s.kind === 'personal').map((s) => s.name))
  const mine = listMeetings(
    deps.index,
    spaces.map((s) => s.name),
    {},
  )
    .filter(
      (m) => personal.has(m.space) || matchesPerson({ attendees: m.attendees }, principal.email),
    )
    .slice(0, ACTION_ITEM_MEETINGS)
  const read = await Promise.all(
    mine.map(async (m) => {
      try {
        const { content } = await deps.git.readFile(m.space, m.path)
        return { ...m, items: openActionItems(content) }
      } catch {
        // Moved or deleted since the index saw it; the next sync drops it.
        return { ...m, items: [] }
      }
    }),
  )
  return read
    .filter((m) => m.items.length > 0)
    .map(({ space, path, title, date, items }) => ({ space, path, title, date, items }))
}

/**
 * `POST /api/meetings/action-items/done`: ticks one item (`- [ ]` → `- [x]`) and commits it as
 * the member. The line must still hold the same open item; if the note moved on, it's a conflict
 * and the member reloads the list.
 */
export async function completeActionItem(
  deps: {
    git: Pick<GitStore, 'readFile' | 'commit'>
    afterCommit: (space: string, path: string, result: CommitResult) => Promise<void>
  },
  principal: Principal,
  args: { space: string; path: string; line: number; text: string },
): Promise<void> {
  const { space, path } = args
  // Another tick (or any save) can land between the read and the commit; then read again and
  // tick against the new text. The item itself must still be on its line.
  for (let attempt = 1; ; attempt++) {
    const file = await deps.git.readFile(space, path)
    const lines = file.content.split('\n')
    const current = lines[args.line - 1]
    const still = openActionItems(file.content).some(
      (item) => item.line === args.line && item.text === args.text.trim(),
    )
    if (current === undefined || !still) throw new HearthError('conflict', CHANGED)
    lines[args.line - 1] = current.replace('[ ]', '[x]')
    try {
      const result = await deps.git.commit(space, {
        changes: [{ path, content: lines.join('\n') }],
        author: { name: principal.name, email: principal.email },
        message: formatCommitMessage({
          app: 'meetings',
          verb: 'complete',
          title: args.text.trim(),
        }),
        // No three-way merge: a tick is only valid against the text it was checked on (two
        // ticks on adjacent lines would merge into a conflict branch).
        unchanged: { path, blobOid: file.blobOid },
      })
      await deps.afterCommit(space, path, result)
      return
    } catch (err) {
      if (!(err instanceof HearthError && err.code === 'conflict') || attempt >= TICK_ATTEMPTS) {
        throw err
      }
    }
  }
}

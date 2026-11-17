import type { BriefChat } from '../brief/prompt.js'
import type { ChatRooms } from '../forms/index.js'
import type { ChatStore } from './store.js'

/** Most chat messages one brief reads, newest kept, and how much of each. */
export const BRIEF_CHAT_MESSAGES = 80
export const BRIEF_CHAT_CHARS = 600

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}'’-]+/u)
    .filter(Boolean)

/**
 * The read rooms' messages since `since` that a member wrote or that name them (by full name or
 * first name, with or without @), oldest first, for their agent brief (docs/PLAN-chat-context.md
 * R11). The chat and Hotsauce know people only by the names they show, so this is a best guess.
 */
export function chatInvolving(
  rooms: Pick<ChatRooms, 'readTargets'>,
  store: Pick<ChatStore, 'since'>,
) {
  return (person: { name: string; email: string }, since: Date): BriefChat[] => {
    const targets = rooms.readTargets()
    if (targets.length === 0) return []
    const full = words(person.name).join(' ')
    const first = words(person.name)[0] ?? words(person.email.split('@')[0] ?? '')[0] ?? ''
    if (!full && !first) return []
    const names = new Map(targets.map((t) => [t.id, t.name]))
    const involved = store
      .since(
        targets.map((t) => t.id),
        since.toISOString(),
      )
      .filter((m) => {
        if (full && words(m.author).join(' ') === full) return true
        const said = ` ${words(m.text).join(' ')} `
        return (
          (full !== '' && said.includes(` ${full} `)) ||
          (first.length > 1 && said.includes(` ${first} `))
        )
      })
    return involved.slice(-BRIEF_CHAT_MESSAGES).map((m) => ({
      room: names.get(m.room) ?? '',
      author: m.author,
      at: m.createdAt,
      text: m.text.slice(0, BRIEF_CHAT_CHARS),
    }))
  }
}

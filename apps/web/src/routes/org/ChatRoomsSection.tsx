import { useCallback, useEffect, useRef, useState } from 'react'
import { type ChatRoom, formsApi } from '../../api/forms'
import { primaryButton } from '../../apps/meetings/components/common'
import { chat, product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { relativeTime } from '../../lib/time'
import { inputClass } from './fields'

/** How often the list is asked again while a room's first copy is being made. */
const COPYING_POLL_MS = 3000

/**
 * Settings → Organization: chat rooms that Forms and Check-ins post to (ARCHITECTURE §21.5), and
 * that Hotsauce may read for context (docs/PLAN-chat-context.md). Each is a Slack-compatible
 * incoming webhook (Slack and compatible chat apps give each bot one per room). Saved at once; the
 * link is kept on the server and only its last four characters come back.
 */
export function ChatRoomsSection() {
  const [rooms, setRooms] = useState<ChatRoom[] | null>(null)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The rooms whose switch is being saved, and a count so an older list never overwrites a newer.
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set())
  const seq = useRef(0)
  const load = useCallback(() => {
    const mine = ++seq.current
    return formsApi.rooms().then(
      (r) => {
        if (mine === seq.current) setRooms(r.rooms)
      },
      () => setRooms((old) => old ?? []),
    )
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  // A room switched on is copied in the background: ask again until its first copy is done.
  const copying = rooms?.some((r) => r.read && !r.copy?.complete && !r.copy?.error) ?? false
  useEffect(() => {
    if (!copying) return
    const timer = setInterval(() => void load(), COPYING_POLL_MS)
    return () => clearInterval(timer)
  }, [copying, load])
  const setRead = async (id: string, read: boolean) => {
    setError(null)
    setSaving((s) => new Set(s).add(id))
    // A list already on its way predates this change.
    seq.current += 1
    try {
      const room = await formsApi.setRoomRead(id, read)
      setRooms((r) =>
        (r ?? []).map((x) => {
          if (x.id !== id) return x
          // The old copy's status no longer applies; the next list brings the new one.
          const { copy: _old, ...rest } = { ...x, ...room }
          return rest
        }),
      )
      void load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t change the room')
    } finally {
      setSaving((s) => {
        const next = new Set(s)
        next.delete(id)
        return next
      })
    }
  }
  const add = async () => {
    setBusy(true)
    setError(null)
    try {
      const room = await formsApi.addRoom(name, url)
      setRooms((r) => [...(r ?? []), room])
      setName('')
      setUrl('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t add the room')
    } finally {
      setBusy(false)
    }
  }
  const remove = async (id: string) => {
    setError(null)
    try {
      await formsApi.removeRoom(id)
      setRooms((r) => (r ?? []).filter((x) => x.id !== id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t remove the room')
    }
  }
  const chatHome = chat()
  return (
    <section
      id="chat-rooms"
      data-testid="org-chat-rooms"
      className="flex scroll-mt-6 flex-col gap-4"
    >
      <div>
        <h2 className="font-display text-[1.6rem] leading-tight font-semibold tracking-tight text-ink">
          Chat rooms
        </h2>
        <p className="mt-2 text-ink-soft">
          Forms and Check-ins can post to a chat room, and {product()} can read a room so search,
          Ask and AI tools know what the team said there. Make a bot in your team chat
          {chatHome ? (
            <>
              {' '}
              (
              <a href={chatHome} target="_blank" rel="noopener noreferrer" className="underline">
                open it
              </a>
              )
            </>
          ) : null}
          , and under the room you want, copy its <b>Slack-compatible webhook URL</b> (it ends in
          /slack) and paste it here. The link decides the room; the name is only how forms list it.{" "}
          {product()} posts a test message to check the link before saving it. Slack webhook links
          work too, for posting only.
        </p>
        <p className="mt-2 text-ink-soft">
          To read a room, add the bot to it and switch on <b>Read for context</b>. {product()}{' '}
          copies the room’s history, then reads new messages every few minutes, thread replies
          included. Everyone in {product()} can search what a read room says, so read only rooms
          everyone in your organization may read. Direct messages are never read. Edits and
          deletions made later in the chat aren’t picked up; switch reading off and on to copy a
          room again.
        </p>
      </div>
      {rooms && rooms.length > 0 ? (
        <ul className="divide-y divide-ash/70 rounded-lg border border-ash">
          {rooms.map((r) => (
            <li
              key={r.id}
              className="flex flex-col gap-1 px-3 py-2 text-sm"
              data-testid="chat-room"
            >
              <div className="flex items-center gap-3">
                <Icon name="chat" className="size-4 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate text-ink">{r.name}</span>
                <span className="text-ink-faint">…{r.last4}</span>
                {r.readable ? (
                  <label className="flex items-center gap-2 text-ink-soft">
                    Read for context
                    <input
                      type="checkbox"
                      role="switch"
                      aria-checked={r.read === true}
                      aria-label={`Read ${r.name} for context`}
                      data-testid="chat-room-read"
                      checked={r.read === true}
                      disabled={saving.has(r.id)}
                      onChange={(e) => void setRead(r.id, e.target.checked)}
                      className="size-4 accent-ember"
                    />
                  </label>
                ) : null}
                <button
                  type="button"
                  className="text-ink-faint hover:text-ink"
                  aria-label={`Remove ${r.name}`}
                  onClick={() => void remove(r.id)}
                >
                  <Icon name="trash" className="size-4" />
                </button>
              </div>
              {r.read ? <CopyStatus room={r} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <input
          aria-label="Name shown in Forms"
          placeholder="Name, like Form answers"
          className={`${inputClass} sm:w-48`}
          value={name}
          maxLength={80}
          data-testid="chat-room-name"
          onChange={(e) => setName(e.target.value)}
        />
        <input
          aria-label="Webhook link"
          placeholder="https://…"
          className={inputClass}
          value={url}
          autoComplete="off"
          data-testid="chat-room-url"
          onChange={(e) => setUrl(e.target.value)}
        />
        <button
          type="submit"
          className={`${primaryButton} shrink-0`}
          disabled={busy || !name.trim() || !url.trim()}
          data-testid="chat-room-add"
        >
          {busy ? 'Checking…' : 'Add room'}
        </button>
      </form>
      {error ? (
        <p role="alert" className="text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
    </section>
  )
}

/** How much of a read room is copied and when it was last read, or why it couldn't be. */
function CopyStatus({ room }: { room: ChatRoom }) {
  const copy = room.copy
  const count = (n: number) => `${n.toLocaleString()} message${n === 1 ? '' : 's'}`
  let text: string
  let failed = false
  if (!copy || (!copy.complete && !copy.error)) {
    text = copy?.messages ? `Copying… ${count(copy.messages)} so far` : 'Copying the room…'
  } else if (copy.error) {
    failed = true
    text = `${copy.error}${copy.messages ? ` ${count(copy.messages)} copied earlier are kept.` : ''}`
  } else {
    text = `${count(copy.messages)} copied${copy.readAt ? `, read ${relativeTime(copy.readAt)}` : ''}`
  }
  return (
    <p
      data-testid="chat-room-copy"
      className={`pl-7 ${failed ? 'text-ember-strong' : 'text-ink-faint'}`}
    >
      {text}
    </p>
  )
}

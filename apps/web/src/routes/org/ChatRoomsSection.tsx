import { useEffect, useState } from 'react'
import { type ChatRoom, formsApi } from '../../api/forms'
import { primaryButton } from '../../apps/meetings/components/common'
import { chat } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { inputClass } from './fields'

/**
 * Settings → Organization: chat rooms that Forms posts new answers to (ARCHITECTURE §21.5). Each is
 * a Slack-compatible incoming webhook (Slack and compatible chat apps give each bot one per room). Saved at once;
 * the link is kept on the server and only its last four characters come back.
 */
export function ChatRoomsSection() {
  const [rooms, setRooms] = useState<ChatRoom[] | null>(null)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    formsApi.rooms().then(
      (r) => setRooms(r.rooms),
      () => setRooms([]),
    )
  }, [])
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
    <section data-testid="org-chat-rooms" className="flex flex-col gap-4">
      <div>
        <h2 className="font-display text-[1.6rem] leading-tight font-semibold tracking-tight text-ink">
          Chat rooms for form answers
        </h2>
        <p className="mt-2 text-ink-soft">
          A form can post each new answer to a chat room. Add a bot to the room in your team chat
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
          , copy its incoming webhook link, and paste it here. Slack webhook links work too.
        </p>
      </div>
      {rooms && rooms.length > 0 ? (
        <ul className="divide-y divide-ash/70 rounded-lg border border-ash">
          {rooms.map((r) => (
            <li
              key={r.id}
              className="flex items-center gap-3 px-3 py-2 text-sm"
              data-testid="chat-room"
            >
              <Icon name="chat" className="size-4 text-ink-faint" />
              <span className="flex-1 text-ink">{r.name}</span>
              <span className="text-ink-faint">…{r.last4}</span>
              <button
                type="button"
                className="text-ink-faint hover:text-ink"
                aria-label={`Remove ${r.name}`}
                onClick={() => void remove(r.id)}
              >
                <Icon name="trash" className="size-4" />
              </button>
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
          aria-label="Room name"
          placeholder="Room name, like Ops"
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
          Add room
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

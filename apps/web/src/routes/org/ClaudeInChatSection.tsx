import { useEffect, useState } from 'react'
import { type ChatClaudeStatus, chatClaudeApi, ROUTINE_INSTRUCTIONS } from '../../api/chatClaude'
import { primaryButton, secondaryButton } from '../../apps/meetings/components/common'
import { product } from '../../brand/product'
import { relativeTime } from '../../lib/time'
import { inputClass } from './fields'

const ROUTINES = 'https://claude.ai/code/routines'

/**
 * Settings → Organization → Claude in chat (docs/PLAN-chat-claude.md R8): a chat bot whose
 * webhook is this server wakes a Claude Code routine when someone mentions it, and the routine
 * answers in the same thread through the `reply_in_chat` AI tool.
 */
export function ClaudeInChatSection() {
  const [status, setStatus] = useState<ChatClaudeStatus | null>(null)
  const [routineId, setRoutineId] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  useEffect(() => {
    chatClaudeApi.status().then(
      (s) => {
        setStatus(s)
        setRoutineId(s.routineId)
      },
      () => setStatus(null),
    )
  }, [])
  const run = async (fn: () => Promise<ChatClaudeStatus>) => {
    setBusy(true)
    setError(null)
    try {
      const s = await fn()
      setStatus(s)
      setRoutineId(s.routineId)
      setToken('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t save')
    } finally {
      setBusy(false)
    }
  }
  const copy = (what: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(what)
        setTimeout(() => setCopied((c) => (c === what ? null : c)), 2000)
      },
      () => {},
    )
  }
  const dirty = routineId.trim() !== (status?.routineId ?? '') || token.trim() !== ''
  return (
    <section
      id="claude-in-chat"
      data-testid="org-claude-in-chat"
      className="flex scroll-mt-6 flex-col gap-4"
    >
      <div>
        <h2 className="font-display text-[1.6rem] leading-tight font-semibold tracking-tight text-ink">
          Claude in chat
        </h2>
        <p className="mt-2 text-ink-soft">
          Mention <b>@Claude</b> in your team chat and a Claude Code session looks things up in{' '}
          {product()} and answers in the same thread, usually within a few minutes. It runs as a{' '}
          <a href={ROUTINES} target="_blank" rel="noopener noreferrer" className="underline">
            Claude Code routine
          </a>{' '}
          on your Claude plan, so each answer counts toward that plan’s usage, and at most 20
          mentions an hour start one.
        </p>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-ink-soft">
          <li>
            Make a routine with the instructions below and only the {product()} connector, add an{' '}
            <b>API</b> trigger and generate its token. Paste the routine’s ID (it starts with trig_)
            and the token here.
          </li>
          <li>
            In your team chat, make a bot named Claude, paste the webhook address below as its
            webhook, and add it to the rooms where people may ask it.
          </li>
        </ol>
        <p className="mt-2 text-ink-soft">
          Anyone in a room can talk to it, so give the routine a {product()} connection made with{' '}
          <b>Team space only, read only</b> on the Allow page: it can then read only the team space
          and change nothing, and still answer in chat. A connection with full access works too, but
          then only its instructions keep it out of your own space.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-ink">Instructions for the routine</span>
          <button
            type="button"
            className={secondaryButton}
            data-testid="claude-chat-copy-instructions"
            onClick={() => copy('instructions', ROUTINE_INSTRUCTIONS)}
          >
            {copied === 'instructions' ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre className="max-h-48 overflow-auto rounded-lg border border-ash bg-paper-sunk p-3 text-xs whitespace-pre-wrap text-ink-soft">
          {ROUTINE_INSTRUCTIONS}
        </pre>
      </div>

      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void run(() =>
            chatClaudeApi.save({
              routineId: routineId.trim(),
              ...(token.trim() ? { token: token.trim() } : {}),
            }),
          )
        }}
      >
        <input
          aria-label="Routine ID"
          placeholder="Routine ID, like trig_01…"
          className={inputClass}
          value={routineId}
          autoComplete="off"
          data-testid="claude-chat-routine"
          onChange={(e) => setRoutineId(e.target.value)}
        />
        <input
          aria-label="Routine token"
          type="password"
          placeholder={
            status?.token.set
              ? `Token saved (…${status.token.last4}). Paste a new one to replace it.`
              : 'Routine token (sk-ant-…)'
          }
          className={inputClass}
          value={token}
          autoComplete="off"
          data-testid="claude-chat-token"
          onChange={(e) => setToken(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            className={primaryButton}
            disabled={busy || !dirty}
            data-testid="claude-chat-save"
          >
            Save
          </button>
          {status?.routineId || status?.token.set ? (
            <button
              type="button"
              className={secondaryButton}
              disabled={busy}
              data-testid="claude-chat-off"
              onClick={() => void run(() => chatClaudeApi.turnOff())}
            >
              Turn off
            </button>
          ) : null}
        </div>
      </form>

      {status ? (
        <div className="flex flex-col gap-2 text-sm">
          <p
            data-testid="claude-chat-state"
            className={status.ready ? 'text-ink' : 'text-ink-soft'}
          >
            {status.ready
              ? `Ready. ${status.wakesLastHour} of 20 mentions used in the last hour.`
              : `Still needed: ${status.missing.join(', ')}.`}
          </p>
          <div className="flex flex-col gap-1">
            <span className="font-medium text-ink">The bot’s webhook address</span>
            <div className="flex flex-wrap gap-2">
              <input
                readOnly
                aria-label="The bot’s webhook address"
                className={`${inputClass} min-w-0 flex-1 basis-64 font-mono text-xs`}
                value={status.webhookUrl}
                data-testid="claude-chat-webhook"
                onFocus={(e) => e.target.select()}
              />
              <button
                type="button"
                className={`${secondaryButton} shrink-0`}
                onClick={() => copy('webhook', status.webhookUrl)}
              >
                {copied === 'webhook' ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                className={`${secondaryButton} shrink-0`}
                disabled={busy}
                title="The old address stops working at once"
                onClick={() => void run(() => chatClaudeApi.newAddress())}
              >
                New address
              </button>
            </div>
            <span className="text-ink-faint">
              Anyone with this address can wake the routine, so keep it in the chat bot only.
            </span>
          </div>
          {status.recent.length > 0 ? (
            <ul className="divide-y divide-ash/70 rounded-lg border border-ash">
              {status.recent.map((w) => (
                <li
                  key={`${w.at}-${w.who}`}
                  className="flex gap-3 px-3 py-2"
                  data-testid="claude-chat-wake"
                >
                  <span className="min-w-0 flex-1 truncate text-ink">
                    {w.who} in {w.room}
                  </span>
                  <span className={w.ok ? 'text-ink-faint' : 'text-ember-strong'}>
                    {w.ok ? 'Started' : w.error === 'busy' ? 'Busy' : w.error}
                  </span>
                  <span className="shrink-0 text-ink-faint">{relativeTime(w.at)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
    </section>
  )
}

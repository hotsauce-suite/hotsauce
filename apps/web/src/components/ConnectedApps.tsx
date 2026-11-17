import { useEffect, useState } from 'react'
import { type Connection, oauthApi } from '../api/oauth'
import { mcpUrl } from '../api/tokens'
import { product } from '../brand/product'
import { CopyBlock } from './AiToolSetup'

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : 'never'

/**
 * Settings → "Connect by signing in": the steps for AI tools that sign in through the browser
 * (claude.ai, ChatGPT, Grok), and the apps the member connected that way, each with Disconnect
 * (ARCHITECTURE §8.4).
 */
export function ConnectedApps({ origin }: { origin: string }) {
  const [list, setList] = useState<Connection[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    oauthApi.connections().then(setList, (err: unknown) => setError(messageOf(err)))
  }, [])

  const disconnect = async (c: Connection) => {
    if (!window.confirm(`Disconnect ${c.clientName}? It stops working right away.`)) return
    try {
      await oauthApi.disconnect(c.id)
      setList((l) => (l ?? []).filter((x) => x.id !== c.id))
    } catch (err) {
      setError(messageOf(err))
    }
  }

  return (
    <section
      id="connected-apps"
      aria-labelledby="connected-apps-title"
      data-testid="connected-apps"
      className="mt-12 scroll-mt-6"
    >
      <h2
        id="connected-apps-title"
        className="font-display text-[1.6rem] font-semibold tracking-tight"
      >
        Connect by signing in
      </h2>
      <p className="mt-2 text-sm text-ink-soft">
        Claude (on the web, desktop and phone), ChatGPT and Grok need no token. In the tool, add a
        custom connector with this address, press Connect, and press Allow on the {product()} page
        that opens:
      </p>
      <CopyBlock testId="connect-url" text={mcpUrl(origin)} />
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink-soft">
        <li>
          <span className="font-medium text-ink">Claude:</span> Settings → Connectors → Add custom
          connector. On a Team or Enterprise plan an owner adds it once for everyone.
        </li>
        <li>
          <span className="font-medium text-ink">ChatGPT:</span> Settings → Apps &amp; Connectors →
          Create (turn on Developer mode under Advanced first if Create isn’t there). Choose OAuth.
        </li>
        <li>
          <span className="font-medium text-ink">Grok:</span> add a remote MCP connector with the
          address, and sign in when it asks.
        </li>
      </ul>
      <p className="mt-2 text-sm text-ink-soft">
        On the Allow page, pick what it may use. <b className="text-ink">Everything you can see</b>{' '}
        is the team space and your own, and what it writes is marked with its name.{' '}
        <b className="text-ink">Team space only, read only</b> is for a tool many people share, like
        a team chat’s assistant: it can’t see your own space, calendar or brief, or change anything.
        Neither can change your settings or make tokens.
      </p>

      <h3 className="mt-6 text-sm font-semibold text-ink-soft">Connected apps</h3>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
      {list === null ? null : list.length === 0 ? (
        <p className="mt-2 text-sm text-ink-faint">
          Nothing connected yet. Apps you connect by signing in show up here.
        </p>
      ) : (
        <ul
          data-testid="connection-list"
          className="mt-2 divide-y divide-ash/70 rounded-xl border border-ash"
        >
          {list.map((c) => (
            <li
              key={c.id}
              data-testid="connection-item"
              className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm"
            >
              <span className="min-w-0 flex-1 truncate font-medium text-ink">{c.clientName}</span>
              {c.access === 'team-read' ? (
                <span
                  data-testid="connection-team-only"
                  title="Team space only, read only"
                  className="rounded-full bg-paper-sunk px-2 py-0.5 text-xs text-ink-soft"
                >
                  Team only
                </span>
              ) : null}
              <span className="text-xs text-ink-faint">{c.redirectHost}</span>
              <span className="text-xs text-ink-faint">Connected {when(c.createdAt)}</span>
              <span className="text-xs text-ink-faint">Last used {when(c.lastUsedAt)}</span>
              <button
                type="button"
                data-testid="connection-disconnect"
                onClick={() => void disconnect(c)}
                className="text-xs text-ink-soft hover:text-ember-strong"
              >
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong. Try again.'
}

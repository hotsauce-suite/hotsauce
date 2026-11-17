import { useEffect, useState } from 'react'
import { Navigate, useLocation } from 'react-router'
import { api } from '../api/client'
import { type AuthorizationCheck, type ConnectionAccess, oauthApi } from '../api/oauth'
import { useAuthState } from '../auth/AuthContext'
import { product } from '../brand/product'
import { DesktopPage } from './DesktopPage'

/**
 * The Allow page an AI tool (claude.ai, ChatGPT, Grok) opens when the member presses Connect
 * (ARCHITECTURE §8.4). The server checks the request first; a bad one is shown here and never
 * redirected. Allow needs a click, so a link alone can't connect anything.
 */
export default function OAuthAuthorizeRoute() {
  const auth = useAuthState()
  const location = useLocation()
  const search = location.search
  const [check, setCheck] = useState<AuthorizationCheck | null>(null)
  const [email, setEmail] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [phase, setPhase] = useState<'confirm' | 'working' | 'done'>('confirm')
  const [error, setError] = useState<string | null>(null)
  // No choice is made for the member: a shared tool given everything would read their own space.
  const [access, setAccess] = useState<ConnectionAccess | null>(null)

  useEffect(() => {
    if (auth.status !== 'signed-in') return
    oauthApi
      .check(search)
      .then(setCheck)
      .catch((err: unknown) =>
        setProblem(err instanceof Error ? err.message : 'This sign-in link isn’t valid.'),
      )
    api
      .me()
      .then((me) => setEmail(me.principal.email))
      .catch(() => {})
  }, [auth.status, search])

  if (auth.status === 'loading') return null
  if (auth.status === 'signed-out') {
    return <Navigate to="/sign-in" replace state={{ from: location.pathname + search }} />
  }
  if (problem) {
    return (
      <DesktopPage title="This connection can’t go ahead">
        <p className="text-ink-soft">{problem}</p>
        <p className="mt-4 text-sm text-ink-faint">
          Close this tab and press Connect again in your AI tool.
        </p>
      </DesktopPage>
    )
  }
  if (!check) return null

  const allow = async () => {
    if (!access) return
    setPhase('working')
    setError(null)
    try {
      const { redirect } = await oauthApi.allow(search, access)
      setPhase('done')
      window.location.assign(redirect)
    } catch (err) {
      setPhase('confirm')
      setError(err instanceof Error ? err.message : 'That didn’t work. Try again.')
    }
  }

  const who = check.verified ? check.clientName : check.redirectHost
  if (phase === 'done') {
    return (
      <DesktopPage title={`Connected to ${who}`}>
        <p className="text-ink-soft">Going back to {who}. You can close this tab.</p>
      </DesktopPage>
    )
  }

  return (
    <DesktopPage title={`Let ${who} use your ${product()}?`}>
      {check.verified ? null : (
        <p
          data-testid="oauth-unverified"
          className="mb-3 rounded-lg bg-ember-wash px-3 py-2 text-sm text-ember-strong"
        >
          An app at <span className="font-medium">{check.redirectHost}</span> calls itself “
          {check.clientName}”. {product()} can’t confirm that. Allow it only if you just pressed
          Connect in that app.
        </p>
      )}
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-ink-soft">
          What may it use, as{' '}
          {email ? <span className="font-medium text-ink">{email}</span> : 'you'}?
        </legend>
        <AccessChoice
          value="full"
          chosen={access}
          onChoose={setAccess}
          title="Everything you can see"
          detail="Read, search and write in the team space and your own space. For a tool only you use."
        />
        <AccessChoice
          value="team-read"
          chosen={access}
          onChoose={setAccess}
          title="Team space only, read only"
          detail="For a tool many people share, like a team chat’s assistant. It can’t see your own space, calendar, brief or saved links, and it can’t change anything."
        />
      </fieldset>
      <p className="mt-3 text-sm text-ink-soft">It can’t change your settings or make tokens.</p>
      <p className="mt-3 text-sm text-ink-soft">
        It returns to <span className="font-medium text-ink">{check.redirectHost}</span> and stays
        connected until you disconnect it in Settings → Connections.
      </p>
      <button
        type="button"
        onClick={allow}
        disabled={phase === 'working' || access === null}
        className="mt-6 w-full rounded-lg bg-ember px-4 py-3 font-medium text-paper-raised shadow-sm hover:bg-ember-strong disabled:opacity-60"
      >
        {phase === 'working' ? 'Connecting…' : 'Allow'}
      </button>
      <a
        href={check.cancelUrl}
        className="mt-3 block w-full rounded-lg border border-rule px-4 py-3 text-center font-medium text-ink-soft hover:bg-paper-sunk"
      >
        Cancel
      </a>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
    </DesktopPage>
  )
}

function AccessChoice({
  value,
  chosen,
  onChoose,
  title,
  detail,
}: {
  value: ConnectionAccess
  chosen: ConnectionAccess | null
  onChoose: (value: ConnectionAccess) => void
  title: string
  detail: string
}) {
  const on = chosen === value
  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-lg border px-3 py-3 ${
        on ? 'border-ember bg-ember-wash' : 'border-rule hover:bg-paper-sunk'
      }`}
    >
      <input
        type="radio"
        name="access"
        value={value}
        checked={on}
        onChange={() => onChoose(value)}
        className="mt-1 accent-ember"
      />
      <span className="grid gap-0.5">
        <span className="font-medium text-ink">{title}</span>
        <span className="text-sm text-ink-soft">{detail}</span>
      </span>
    </label>
  )
}

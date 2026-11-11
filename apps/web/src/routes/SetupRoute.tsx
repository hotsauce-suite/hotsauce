import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouteLoaderData } from 'react-router'
import { HearthApiError } from '../api/client'
import { type OrgState, orgEditor, waitForRestart } from '../api/org'
import type { Health } from '../api/types'
import { primaryButton, secondaryButton } from '../apps/meetings/components/common'
import { HearthMark, Icon } from '../components/Icon'
import { Callout, CopyValue, inputClass, messageOf } from './org/fields'
import {
  AiSection,
  BrandSection,
  OrgSection,
  type SectionProps,
  SignInSection,
  StorageSection,
  Summary,
} from './org/sections'

/**
 * `/setup`: the first-run wizard for a new organization (ARCHITECTURE §11.1). It works only while
 * the server is in setup mode, with the one-time token from the setup link the server printed in
 * its log. Every step saves as it goes, so closing the tab and coming back picks up where it left.
 */

const TOKEN_KEY = 'hotsauce:setup-token'

const STEPS = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'org', label: 'Organization' },
  { id: 'brand', label: 'Brand' },
  { id: 'signin', label: 'Sign-in' },
  { id: 'ai', label: 'AI and transcription' },
  { id: 'storage', label: 'Files and audio' },
  { id: 'review', label: 'Review and launch' },
] as const
type StepId = (typeof STEPS)[number]['id']

function readToken(): string | null {
  const fromHash = new URLSearchParams(window.location.hash.slice(1)).get('token')
  if (fromHash) {
    try {
      sessionStorage.setItem(TOKEN_KEY, fromHash)
    } catch {
      // No storage: the token lives in memory for this visit.
    }
    // Keep the token out of the address bar, history and screenshots.
    window.history.replaceState(null, '', window.location.pathname)
    return fromHash
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export default function SetupRoute() {
  const health = useRouteLoaderData('root') as Health | undefined
  const [token, setToken] = useState<string | null>(() => readToken())
  const [state, setState] = useState<OrgState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<StepId>('welcome')
  const editor = useMemo(() => (token ? orgEditor(token) : null), [token])

  useEffect(() => {
    document.title = 'Set up · Hotsauce'
  }, [])

  const load = useCallback(async () => {
    if (!editor) return
    setError(null)
    try {
      const s = await editor.state()
      setState(s)
      // Resume at the first step not yet done.
      const next = STEPS.find((x) => x.id !== 'welcome' && !s.settings.stepsDone.includes(x.id))
      if (s.settings.stepsDone.length > 0 && next) setStep(next.id)
    } catch (err) {
      if (err instanceof HearthApiError && err.status === 401) {
        try {
          sessionStorage.removeItem(TOKEN_KEY)
        } catch {
          // Nothing stored.
        }
        setToken(null)
      }
      setError(messageOf(err))
    }
  }, [editor])

  useEffect(() => {
    void load()
  }, [load])

  if (health && !health.setupRequired) {
    return (
      <Frame>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Already set up</h1>
        <p className="mt-2 text-ink-soft">
          This workspace is ready. Admins can change it in Settings → Organization.
        </p>
        <a href="/sign-in" className={`${primaryButton} mt-6`}>
          Sign in
        </a>
      </Frame>
    )
  }

  if (!token || !editor) return <NeedToken error={error} onToken={setToken} />

  if (!state) {
    return (
      <Frame>
        {error ? (
          <p role="alert" className="text-ember-strong">
            {error}
          </p>
        ) : (
          <p className="text-ink-faint">Loading…</p>
        )}
      </Frame>
    )
  }

  const index = STEPS.findIndex((x) => x.id === step)
  const go = (id: StepId) => setStep(id)
  const markDone = async (id: StepId) => {
    if (state.settings.stepsDone.includes(id)) return
    try {
      // The server adds it to its own list, so two quick steps can't overwrite each other; only
      // the list is taken from the answer, never older copies of other settings.
      const saved = await editor.saveSettings({ addStepDone: id })
      setState((cur) =>
        cur
          ? { ...cur, settings: { ...cur.settings, stepsDone: saved.settings.stepsDone } }
          : saved,
      )
    } catch {
      // Only progress tracking; the step's own save already succeeded.
    }
  }
  const next = () => {
    void markDone(step)
    const n = STEPS[index + 1]
    if (n) go(n.id)
  }
  const back =
    index > 0 ? (
      <button
        type="button"
        className={secondaryButton}
        onClick={() => go(STEPS[index - 1]?.id ?? 'welcome')}
      >
        Back
      </button>
    ) : null
  const skip = (
    <button
      type="button"
      className="px-2 text-sm text-ink-faint hover:text-ink"
      onClick={next}
      data-testid="step-skip"
    >
      Skip for now
    </button>
  )
  const props: SectionProps = {
    state,
    editor,
    onState: setState,
    submitLabel: 'Save and continue',
    onDone: next,
  }

  return (
    <div className="min-h-full bg-paper">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 md:flex-row md:gap-10 md:px-6 md:py-12">
        <nav aria-label="Setup steps" className="md:w-56 md:shrink-0">
          <div className="flex items-center gap-2.5">
            <HearthMark className="size-8" />
            <span className="font-display text-lg font-semibold tracking-tight">
              Hotsauce setup
            </span>
          </div>
          <ol className="mt-6 hidden flex-col gap-1 md:flex">
            {STEPS.map((x, i) => {
              const done = state.settings.stepsDone.includes(x.id)
              const current = x.id === step
              return (
                <li key={x.id}>
                  <button
                    type="button"
                    onClick={() => go(x.id)}
                    aria-current={current ? 'step' : undefined}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm ${
                      current
                        ? 'bg-ember-wash font-medium text-ink'
                        : 'text-ink-soft hover:bg-paper-sunk'
                    }`}
                  >
                    <span
                      className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[0.7rem] ${
                        done
                          ? 'bg-moss text-paper-raised'
                          : current
                            ? 'bg-ember text-paper-raised'
                            : 'border border-ash-strong text-ink-faint'
                      }`}
                    >
                      {done ? <Icon name="check" className="size-3" /> : i + 1}
                    </span>
                    {x.label}
                  </button>
                </li>
              )
            })}
          </ol>
          <div className="mt-4 md:hidden">
            <p className="text-sm text-ink-soft">
              Step {index + 1} of {STEPS.length}:{' '}
              <span className="font-medium text-ink">{STEPS[index]?.label}</span>
            </p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ash/60">
              <div
                className="h-full rounded-full bg-ember"
                style={{ width: `${((index + 1) / STEPS.length) * 100}%` }}
              />
            </div>
          </div>
        </nav>
        <main className="min-w-0 flex-1" data-testid={`setup-step-${step}`}>
          {step === 'welcome' ? (
            <Welcome onStart={next} />
          ) : step === 'org' ? (
            <OrgSection {...props} actions={back} />
          ) : step === 'brand' ? (
            <BrandSection
              {...props}
              actions={
                <>
                  {back}
                  {skip}
                </>
              }
            />
          ) : step === 'signin' ? (
            <SignInSection {...props} actions={back} />
          ) : step === 'ai' ? (
            <AiSection
              {...props}
              actions={
                <>
                  {back}
                  {skip}
                </>
              }
            />
          ) : step === 'storage' ? (
            <StorageSection {...props} actions={back} />
          ) : (
            <Review state={state} editor={editor} onState={setState} onGo={go} back={back} />
          )}
        </main>
      </div>
    </div>
  )
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-md">
        <HearthMark className="mb-5 size-10" />
        {children}
      </div>
    </div>
  )
}

function NeedToken({ error, onToken }: { error: string | null; onToken: (t: string) => void }) {
  const [value, setValue] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const raw = value.trim()
    // Accept the whole link as well as the bare token.
    const t = raw.includes('token=')
      ? (new URLSearchParams(raw.split('#')[1] ?? '').get('token') ?? '')
      : raw
    if (!t) return
    try {
      sessionStorage.setItem(TOKEN_KEY, t)
    } catch {
      // In memory only.
    }
    onToken(t)
  }
  return (
    <Frame>
      <h1 className="font-display text-3xl font-semibold tracking-tight">Set up your workspace</h1>
      <p className="mt-2 text-ink-soft">
        This server is new. To prove it’s yours, open the setup link it printed in its log when it
        started. It looks like <code className="font-mono text-xs">https://…/setup#token=…</code>
      </p>
      <div className="mt-4 flex flex-col gap-2 text-sm text-ink-soft">
        <span>Find it with one of these:</span>
        <CopyValue label="Fly" value="fly logs | grep setup" />
        <CopyValue label="Docker" value="docker compose logs hotsauce | grep setup" />
      </div>
      <form onSubmit={submit} className="mt-5 flex flex-col gap-2">
        <label htmlFor="setup-token" className="text-sm font-medium text-ink">
          Or paste the link here
        </label>
        <input
          id="setup-token"
          data-testid="setup-token"
          className={`${inputClass} font-mono text-sm`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
        />
        <button type="submit" className={`${primaryButton} self-start`}>
          Continue
        </button>
      </form>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
    </Frame>
  )
}

function Welcome({ onStart }: { onStart: () => void }) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-display text-[2.1rem] leading-tight font-semibold tracking-tight">
          Welcome to Hotsauce
        </h1>
        <p className="mt-2 max-w-xl text-ink-soft">
          The open sauce office suite: Docs, Meetings, Dictate and Clips for your team, on your own
          server, with your files as plain Markdown in git. Setup takes about fifteen minutes.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {[
          ['Organization', 'Your name and who can sign in.', 'Required'],
          ['Brand', 'Logo, colors and fonts, with a live preview.', 'Optional'],
          ['Sign-in', 'Google sign-in through a free Clerk account.', 'Required'],
          ['AI and transcription', 'Your own Anthropic and Deepgram keys.', 'Optional'],
          ['Files and audio', 'On this server or in GitHub; audio in R2.', 'Defaults work'],
          ['Launch', 'Check it over, then the server restarts ready.', ''],
        ].map(([title, body, tag]) => (
          <div key={title} className="rounded-xl border border-ash bg-paper-raised/60 p-3.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-ink">{title}</span>
              {tag ? <span className="text-xs text-ink-faint">{tag}</span> : null}
            </div>
            <p className="mt-1 text-sm text-ink-soft">{body}</p>
          </div>
        ))}
      </div>
      <Callout>
        Have these ready: a Google Workspace account at your company’s domain, and about five
        minutes in Clerk. Keys you paste are stored encrypted on this server and never shown again.
      </Callout>
      <button
        type="button"
        className={`${primaryButton} self-start`}
        onClick={onStart}
        data-testid="setup-start"
      >
        Start
        <Icon name="chevron" className="size-4" />
      </button>
    </div>
  )
}

function Review({
  state,
  editor,
  onState,
  onGo,
  back,
}: {
  state: OrgState
  editor: ReturnType<typeof orgEditor>
  onState: (s: OrgState) => void
  onGo: (id: StepId) => void
  back: React.ReactNode
}) {
  const [phase, setPhase] = useState<'idle' | 'finishing' | 'restarting' | 'done' | 'slow'>('idle')
  const [error, setError] = useState<string | null>(null)

  const finish = async () => {
    setError(null)
    setPhase('finishing')
    try {
      await editor.finish()
      setPhase('restarting')
      try {
        sessionStorage.removeItem(TOKEN_KEY)
      } catch {
        // Nothing stored.
      }
      const ok = await waitForRestart()
      setPhase(ok ? 'done' : 'slow')
      if (ok) window.location.assign('/sign-in')
    } catch (err) {
      setPhase('idle')
      setError(messageOf(err))
      editor.state().then(onState, () => {})
    }
  }

  if (phase === 'restarting' || phase === 'done') {
    return (
      <div className="flex flex-col gap-3" data-testid="setup-restarting">
        <h2 className="font-display text-[1.6rem] font-semibold tracking-tight">
          Starting your workspace…
        </h2>
        <p className="text-ink-soft">
          The server is restarting with your settings. This takes a few seconds.
        </p>
      </div>
    )
  }
  if (phase === 'slow') {
    return (
      <div className="flex flex-col gap-3">
        <h2 className="font-display text-[1.6rem] font-semibold tracking-tight">Almost there</h2>
        <p className="text-ink-soft">
          The server is taking longer than usual to come back. If it doesn’t start on its own,
          restart it (for example <code className="font-mono text-xs">fly machine restart</code> or{' '}
          <code className="font-mono text-xs">docker compose restart</code>), then sign in.
        </p>
        <a href="/sign-in" className={`${primaryButton} self-start`}>
          Go to sign-in
        </a>
      </div>
    )
  }

  const stepFor = (m: string): StepId =>
    /Clerk/.test(m) ? 'signin' : /GitHub|R2/.test(m) ? 'storage' : 'org'

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="font-display text-[1.6rem] leading-tight font-semibold tracking-tight">
          Review and launch
        </h2>
        <p className="mt-2 text-ink-soft">
          Check everything over. You can change any of it later in Settings → Organization.
        </p>
      </div>
      <Summary state={state} />
      {state.missing.length > 0 ? (
        <Callout tone="warn">
          <p className="font-medium">Still needed before launch:</p>
          <ul className="mt-1.5 flex flex-col gap-1" data-testid="setup-missing">
            {state.missing.map((m) => (
              <li key={m}>
                <button
                  type="button"
                  className="text-left underline decoration-ember/50 hover:text-ember-strong"
                  onClick={() => onGo(stepFor(m))}
                >
                  {m}
                </button>
              </li>
            ))}
          </ul>
        </Callout>
      ) : (
        <Callout>
          <p className="font-medium text-ink">Ready.</p>
          <p className="mt-1">
            After launch, sign in with an admin account. Then invite your team by sharing this
            address; anyone at your domains can sign in with Google:
          </p>
          <CopyValue value={state.effective.publicUrl || window.location.origin} />
        </Callout>
      )}
      {error ? (
        <p role="alert" className="text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="setup-finish"
          disabled={state.missing.length > 0 || phase === 'finishing'}
          className={primaryButton}
          onClick={() => void finish()}
        >
          {phase === 'finishing' ? 'Launching…' : 'Launch workspace'}
        </button>
        {back}
      </div>
    </div>
  )
}

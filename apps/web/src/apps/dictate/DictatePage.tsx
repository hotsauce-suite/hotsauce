import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { HearthApiError } from '../../api/client'
import {
  connectLink,
  type DictationDevice,
  type DictationWords,
  dictationApi,
  type WordScope,
} from '../../api/dictation'
import { org, product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { MeetingsPageHeader, primaryButton, secondaryButton } from '../meetings/components/common'
import { openAppLink } from './openAppLink'

/** Served by the server from the web build; the Dockerfile puts it there. */
export const MAC_APP_DOWNLOAD = '/downloads/Hearth.dmg'
/** The same app as a zip, for anyone whose browser or Mac won't open the disk image. */
export const MAC_APP_ZIP = '/downloads/Hearth.zip'
const PRIVACY_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security'
/** How to build the Mac app, for a server that has no build to offer. */
export const MAC_APP_SOURCE =
  'https://github.com/hotsauce-suite/hotsauce/blob/main/apps/dictate-mac/README.md'

const kbd =
  'rounded-md border border-ash-strong/70 bg-paper-raised px-1.5 py-0.5 font-mono text-[0.8em] text-ink shadow-[0_1px_0_var(--ash-strong)]'

type Connect =
  | { state: 'idle' }
  | { state: 'connecting' }
  | { state: 'opened'; link: string }
  | { state: 'failed'; message: string }

/** `/dictate` on a computer, and `/dictate/mac` anywhere: get the Mac app, connect this Mac, see connected Macs, edit the word lists. */
export default function DictatePage() {
  const [devices, setDevices] = useState<DictationDevice[] | null>(null)
  const [words, setWords] = useState<DictationWords | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [connect, setConnect] = useState<Connect>({ state: 'idle' })
  // A server built without the Mac app (a fresh self-hosted one) has nothing to download.
  const [hasMacApp, setHasMacApp] = useState(true)

  // The sidebar links to this page's sections by hash; the router doesn't scroll to them.
  const { hash } = useLocation()
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' })
  }, [hash])

  const refreshDevices = useCallback(() => {
    dictationApi.devices().then(setDevices, (err: unknown) => setLoadError(messageOf(err)))
  }, [])

  useEffect(() => {
    document.title = `${product()} Dictate`
    refreshDevices()
    dictationApi.words().then(setWords, (err: unknown) => setLoadError(messageOf(err)))
    fetch(MAC_APP_DOWNLOAD, { method: 'HEAD' }).then(
      (res) => setHasMacApp(res.ok),
      () => {},
    )
  }, [refreshDevices])

  const onConnect = async () => {
    setConnect({ state: 'connecting' })
    try {
      const device = await dictationApi.connect(`Mac connected ${shortDate(new Date())}`)
      const link = connectLink(device.token, window.location.origin)
      setConnect({ state: 'opened', link })
      refreshDevices()
      // Opens the app if it's installed; if not, the browser does nothing and the code below
      // is the way in.
      openAppLink(link)
    } catch (err) {
      setConnect({ state: 'failed', message: messageOf(err) })
    }
  }

  const onRevoke = async (device: DictationDevice) => {
    try {
      await dictationApi.revoke(device.id)
      setDevices((list) => list?.filter((d) => d.id !== device.id) ?? null)
    } catch (err) {
      setLoadError(messageOf(err))
    }
  }

  return (
    <>
      <MeetingsPageHeader title={`${product()} Dictate`} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pt-8 pb-24 md:px-8 md:pt-12">
          <section id="get-it" aria-labelledby="dictate-title" className="dictate-hero">
            <div className="grid items-center gap-8 md:grid-cols-[1fr_auto]">
              <div>
                <p className="text-xs font-semibold tracking-[0.14em] text-ember uppercase">
                  Voice to text, for Mac
                </p>
                <h2
                  id="dictate-title"
                  className="mt-2 font-display text-[2.1rem] leading-[1.1] font-semibold tracking-tight text-ink md:text-[2.5rem]"
                >
                  Talk anywhere you can type.
                </h2>
                <p className="mt-3 max-w-[34rem] text-ink-soft">
                  Hold a key, say it the way you’d say it, let go. {product()} Dictate drops clean,
                  punctuated text wherever your cursor is: Slack, Mail, a doc, the terminal. The
                  “ums” go, “no wait, Wednesday” becomes Wednesday, and your team’s own words come
                  out spelled right.
                </p>
                <div className="mt-6 flex flex-wrap gap-3">
                  {hasMacApp ? (
                    <a
                      href={MAC_APP_DOWNLOAD}
                      download
                      data-testid="dictate-download"
                      className={primaryButton}
                    >
                      <Icon name="mic" />
                      Download for Mac
                    </a>
                  ) : (
                    <a
                      href={MAC_APP_SOURCE}
                      target="_blank"
                      rel="noreferrer"
                      data-testid="dictate-build-from-source"
                      className={primaryButton}
                    >
                      <Icon name="mic" />
                      Build the Mac app
                    </a>
                  )}
                  <button
                    type="button"
                    data-testid="dictate-connect"
                    onClick={() => void onConnect()}
                    disabled={connect.state === 'connecting'}
                    className={secondaryButton}
                  >
                    {connect.state === 'connecting' ? 'Connecting…' : 'Connect this Mac'}
                  </button>
                </div>
                <p className="mt-4 text-sm text-ink-soft">
                  Not at your Mac?{' '}
                  <Link
                    to="/dictate/voice"
                    data-testid="dictate-voice-link"
                    className="font-medium text-ink underline decoration-ash-strong underline-offset-2 hover:decoration-ember"
                  >
                    Record a voice note here
                  </Link>{' '}
                  and {product()} writes it up for you.
                </p>
              </div>
              <Keycap />
            </div>

            <ol className="mt-8 grid gap-3 text-sm text-ink-soft sm:grid-cols-3">
              <Step n={1}>
                Hold <kbd className={kbd}>right ⌥ option</kbd>, speak, release.
              </Step>
              <Step n={2}>
                Double-tap <kbd className={kbd}>right ⌥</kbd> to talk hands-free; tap again to
                finish.
              </Step>
              <Step n={3}>
                <kbd className={kbd}>esc</kbd> throws a dictation away.
              </Step>
            </ol>

            <ConnectStatus connect={connect} />
          </section>

          <section id="install" aria-labelledby="install-title" className="mt-14">
            <SectionTitle id="install-title" title="Installing it the first time">
              The {product()} Mac app isn’t from the App Store, so macOS asks you to confirm it
              once.
            </SectionTitle>
            <ol
              data-testid="dictate-install-steps"
              className="mt-4 list-decimal space-y-2 pl-5 text-sm text-ink-soft marker:font-semibold marker:text-ember"
            >
              <li>Open the downloaded disk image and drag {product()} into Applications.</li>
              <li>
                Open it from Applications. When macOS says{' '}
                <span className="text-ink">“Apple could not verify…”</span>, click{' '}
                <span className="font-medium text-ink">Done</span>.
              </li>
              <li>
                Open System Settings → Privacy &amp; Security, scroll down, and click{' '}
                <span className="font-medium text-ink">Open Anyway</span> next to {product()}, then
                confirm. On macOS 14, Control-click the app and choose Open instead.
              </li>
              <li>
                Allow the microphone and Accessibility when it asks, then press Connect this Mac
                above.
              </li>
            </ol>
            <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
              <a
                href={PRIVACY_SETTINGS}
                data-testid="dictate-open-privacy"
                className={secondaryButton}
              >
                Open Privacy &amp; Security
              </a>
              {hasMacApp ? (
                <a
                  href={MAC_APP_ZIP}
                  download
                  data-testid="dictate-download-zip"
                  className="text-ink-soft underline decoration-ash-strong underline-offset-2 hover:text-ink"
                >
                  Download as a .zip instead
                </a>
              ) : null}
            </div>
            <p className="mt-3 text-xs text-ink-faint">
              Already installed? It’s {product()} in your Dock and Applications, with its mark in
              the menu bar while Dictate is on. Dictate’s own settings are under {product()} →
              Dictate… in the menu bar.
            </p>
          </section>

          {loadError ? (
            <p role="alert" className="mt-8 rounded-lg bg-rust-wash px-3 py-2 text-sm text-ink">
              {loadError}
            </p>
          ) : null}

          <section id="devices" aria-labelledby="devices-title" className="mt-14">
            <SectionTitle id="devices-title" title="Connected Macs">
              Each Mac has its own key. It can dictate and read the word lists, and nothing else in
              {product()}. Disconnect a Mac you no longer use.
            </SectionTitle>
            <DeviceList devices={devices} onRevoke={(d) => void onRevoke(d)} />
          </section>

          <section id="words" aria-labelledby="words-title" className="mt-14">
            <SectionTitle id="words-title" title="Words">
              Names and terms {product()} should hear and spell exactly as written. Yours apply to
              your dictations; the team’s apply to everyone’s.
            </SectionTitle>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <WordEditor
                scope="mine"
                title="My words"
                hint="Only you"
                words={words?.mine ?? null}
                onSaved={(list) => setWords((w) => (w ? { ...w, mine: list } : w))}
              />
              <WordEditor
                scope="team"
                title="Team words"
                hint={org() ? `Everyone at ${org()}` : 'Everyone on the team'}
                words={words?.team ?? null}
                onSaved={(list) => setWords((w) => (w ? { ...w, team: list } : w))}
              />
            </div>
          </section>

          <p className="mt-14 border-t border-ash/70 pt-4 text-xs leading-relaxed text-ink-faint">
            Needs macOS 14 or later. It asks for the microphone, and for Accessibility so it can
            paste for you. Audio is sent to {product()} to be transcribed and is never saved.
          </p>
        </div>
      </div>
    </>
  )
}

function ConnectStatus({ connect }: { connect: Connect }) {
  const [copied, setCopied] = useState(false)
  if (connect.state === 'failed') {
    return (
      <p role="alert" className="mt-6 rounded-lg bg-rust-wash px-3 py-2 text-sm text-ink">
        Couldn’t connect: {connect.message}
      </p>
    )
  }
  if (connect.state !== 'opened') return null
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(connect.link)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div
      data-testid="dictate-connect-status"
      className="mt-6 rounded-xl border border-ash bg-paper-raised/70 p-4 text-sm"
    >
      <p className="flex items-center gap-2 font-medium text-ink">
        <Icon name="check" className="size-4 text-moss" />
        Opening {product()} on your Mac to finish connecting…
      </p>
      <p className="mt-2 text-ink-soft">
        Nothing happened? Install the app first, open it, choose{' '}
        <span className="font-medium text-ink">Paste connection code</span>, and paste this. It
        works once and only you should see it.
      </p>
      <div className="mt-3 flex items-stretch gap-2">
        <code
          data-testid="dictate-connect-code"
          className="min-w-0 flex-1 truncate rounded-lg bg-paper-sunk px-2.5 py-2 font-mono text-xs text-ink-soft"
        >
          {connect.link}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          className={`${secondaryButton} h-auto px-3`}
        >
          <Icon name="copy" />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

function DeviceList({
  devices,
  onRevoke,
}: {
  devices: DictationDevice[] | null
  onRevoke: (device: DictationDevice) => void
}) {
  if (devices === null) return <p className="mt-4 text-sm text-ink-faint">Loading…</p>
  if (devices.length === 0) {
    return (
      <p data-testid="dictate-no-devices" className="mt-4 text-sm text-ink-faint">
        No Macs connected yet. Install the app, then press Connect this Mac.
      </p>
    )
  }
  return (
    <ul
      data-testid="dictate-devices"
      className="mt-4 divide-y divide-ash/70 rounded-xl border border-ash bg-paper-raised/60"
    >
      {devices.map((device) => (
        <li key={device.id} className="flex items-center gap-3 px-4 py-3">
          <Icon name="tab" className="size-4 shrink-0 text-ink-faint" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink">{device.name}</p>
            <p className="text-xs text-ink-faint">
              {device.lastUsedAt ? `Last used ${relative(device.lastUsedAt)}` : 'Not used yet'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onRevoke(device)}
            aria-label={`Disconnect ${device.name}`}
            className="rounded-md px-2 py-1 text-sm text-ink-soft hover:bg-rust-wash hover:text-ember-strong"
          >
            Disconnect
          </button>
        </li>
      ))}
    </ul>
  )
}

export function WordEditor({
  scope,
  title,
  hint,
  words,
  onSaved,
}: {
  scope: WordScope
  title: string
  hint: string
  words: string[] | null
  onSaved: (words: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const save = async (next: string[]) => {
    setSaving(true)
    setError(null)
    try {
      const result = await dictationApi.setWords(scope, next)
      onSaved(result.words)
      return true
    } catch (err) {
      setError(messageOf(err))
      return false
    } finally {
      setSaving(false)
    }
  }

  const onAdd = async (event: FormEvent) => {
    event.preventDefault()
    const added = draft
      .split(',')
      .map((w) => w.trim())
      .filter(Boolean)
    if (added.length === 0 || !words) return
    if (await save([...words, ...added])) setDraft('')
  }

  return (
    <div
      data-testid={`dictate-words-${scope}`}
      className="rounded-xl border border-ash bg-paper-raised/60 p-4"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="font-display text-base font-semibold text-ink">{title}</h4>
        <span className="text-xs text-ink-faint">{hint}</span>
      </div>
      {words === null ? (
        <p className="mt-3 text-sm text-ink-faint">Loading…</p>
      ) : (
        <ul className="mt-3 flex min-h-8 flex-wrap gap-1.5">
          {words.length === 0 ? (
            <li className="text-sm text-ink-faint">None yet.</li>
          ) : (
            words.map((word) => (
              <li
                key={word}
                className="inline-flex items-center gap-1 rounded-full border border-ash bg-paper px-2.5 py-0.5 text-sm text-ink"
              >
                {word}
                <button
                  type="button"
                  aria-label={`Remove ${word}`}
                  disabled={saving}
                  onClick={() => void save(words.filter((w) => w !== word))}
                  className="-mr-1 rounded-full p-0.5 text-ink-faint hover:text-ember-strong"
                >
                  <Icon name="close" className="size-3" />
                </button>
              </li>
            ))
          )}
        </ul>
      )}
      <form onSubmit={(e) => void onAdd(e)} className="mt-3 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={`Add to ${title.toLowerCase()}`}
          placeholder="Add a word or name"
          maxLength={200}
          className="h-9 min-w-0 flex-1 rounded-lg border border-ash bg-paper px-2.5 text-sm text-ink placeholder:text-ink-faint focus:border-ember"
        />
        <button
          type="submit"
          disabled={saving || draft.trim() === '' || words === null}
          className={`${secondaryButton} h-9 px-3`}
        >
          Add
        </button>
      </form>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-ember-strong">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function SectionTitle({
  id,
  title,
  children,
}: {
  id: string
  title: string
  children: React.ReactNode
}) {
  return (
    <>
      <h3 id={id} className="font-display text-xl font-semibold tracking-tight text-ink">
        {title}
      </h3>
      <p className="mt-1 max-w-[38rem] text-sm text-ink-soft">{children}</p>
    </>
  )
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3 rounded-xl border border-ash/80 bg-paper-raised/50 p-3 leading-relaxed">
      <span className="font-display text-lg leading-none font-semibold text-ember">{n}</span>
      <span>{children}</span>
    </li>
  )
}

/** The hero's picture: the key you hold, warming while it listens. */
function Keycap() {
  return (
    <div aria-hidden="true" className="dictate-keycap mx-auto hidden md:block">
      <div className="dictate-keycap-glow" />
      <div className="dictate-keycap-face">
        <span className="font-display text-[2.6rem] leading-none text-ink">⌥</span>
        <span className="mt-2 text-[0.7rem] font-medium tracking-[0.12em] text-ink-faint uppercase">
          right option
        </span>
      </div>
      <div className="dictate-pill">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <span key={i} style={{ animationDelay: `${i * 90}ms` }} />
        ))}
      </div>
    </div>
  )
}

function messageOf(err: unknown): string {
  if (err instanceof HearthApiError) return err.message
  return err instanceof Error ? err.message : 'Something went wrong'
}

function shortDate(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function relative(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

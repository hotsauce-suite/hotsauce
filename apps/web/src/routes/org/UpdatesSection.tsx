import { useEffect, useState } from 'react'
import { type UpdateStatus, updatesApi } from '../../api/updates'
import { product } from '../../brand/product'

const heading = 'font-display text-[1.6rem] leading-tight font-semibold tracking-tight text-ink'
const button =
  'h-9 rounded-lg bg-ember px-4 text-sm font-medium text-paper-raised hover:bg-ember-strong disabled:opacity-60'
const quiet =
  'h-9 rounded-lg border border-ash-strong px-3 text-sm text-ink hover:border-ember disabled:opacity-60'

/**
 * Settings → Organization: which release this is, what's newer, the Update button and the
 * automatic-updates switch. Saved on its own and live at once.
 */
export function UpdatesSection() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    updatesApi
      .status()
      .then(setStatus, (err: unknown) =>
        setError(err instanceof Error ? err.message : 'Couldn’t check for updates'),
      )
  }, [])

  const run = async (action: () => Promise<UpdateStatus>) => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await action())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That didn’t work')
    } finally {
      setBusy(false)
    }
  }

  const name = product()
  return (
    <section data-testid="org-updates" className="flex flex-col gap-4">
      <div>
        <h2 className={heading}>Updates</h2>
        <p className="mt-2 text-ink-soft">
          {status
            ? `This is ${name} ${status.current}.`
            : `Checking which version of ${name} this is…`}
          {status && !status.updateAvailable && status.latest ? ' It’s the newest release.' : null}
        </p>
      </div>

      {status?.failed ? (
        <p
          role="alert"
          data-testid="update-failed"
          className="rounded-lg bg-ember-wash px-3 py-2 text-sm text-ink"
        >
          Updating to {status.failed.to} didn’t work, so {name} went back to {status.failed.from}.
          Automatic updates will skip {status.failed.to}; you can still try it with Update.
        </p>
      ) : null}

      {status?.updating ? (
        <p data-testid="update-running" className="rounded-lg border border-ash px-3 py-2 text-sm">
          Updating to {status.updating.to}. {name} restarts in the next few minutes; if the new
          version doesn’t start properly, it goes back to {status.updating.from} on its own.
        </p>
      ) : null}

      {status?.updateAvailable && status.latest && !status.updating ? (
        <div
          data-testid="update-available"
          className="rounded-xl border border-ember/40 bg-paper-raised/70 p-4"
        >
          <p className="font-medium text-ink">Version {status.latest.version} is out</p>
          {status.latest.notes ? (
            <p className="mt-2 max-h-48 overflow-y-auto text-sm whitespace-pre-wrap text-ink-soft">
              {status.latest.notes}
            </p>
          ) : null}
          {status.latest.url ? (
            <a
              href={status.latest.url}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block text-sm text-ember-strong underline"
            >
              Release notes
            </a>
          ) : null}
          <div className="mt-3">
            {status.mode === 'fly' ? (
              <button
                type="button"
                data-testid="update-now"
                className={button}
                disabled={busy}
                onClick={() => void run(updatesApi.start)}
              >
                Update to {status.latest.version}
              </button>
            ) : (
              <HowToUpdate mode={status.mode} app={status.flyApp} />
            )}
          </div>
        </div>
      ) : null}

      {status ? (
        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            data-testid="auto-updates"
            checked={status.auto}
            disabled={busy || status.mode !== 'fly'}
            onChange={(e) => void run(() => updatesApi.setAuto(e.target.checked))}
            className="mt-0.5 accent-[var(--ember)]"
          />
          <span>
            Update automatically
            <span className="block text-ink-faint">
              {status.mode !== 'fly'
                ? 'Available when this server can update itself (on Fly, with a Fly token).'
                : status.auto
                  ? 'On: each new release is installed within a few hours, never while a meeting is being recorded.'
                  : 'Off: new releases wait for you to press Update.'}
            </span>
          </span>
        </label>
      ) : null}

      <div>
        <button
          type="button"
          data-testid="check-updates"
          className={quiet}
          disabled={busy}
          onClick={() => void run(updatesApi.check)}
        >
          Check now
        </button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
    </section>
  )
}

function HowToUpdate({ mode, app }: { mode: UpdateStatus['mode']; app: string | null }) {
  if (mode === 'fly-needs-token') {
    return (
      <p className="text-sm text-ink-soft" data-testid="update-steps">
        To update from here, give this server a Fly token for its app. On a computer with flyctl,
        run{' '}
        <code className="rounded bg-paper-sunk px-1">
          fly secrets set -a {app ?? 'your-app'} FLY_API_TOKEN="$(fly tokens create deploy -a{' '}
          {app ?? 'your-app'})"
        </code>{' '}
      </p>
    )
  }
  return (
    <p className="text-sm text-ink-soft" data-testid="update-steps">
      With Docker and the release image, run{' '}
      <code className="rounded bg-paper-sunk px-1">docker compose pull</code> then{' '}
      <code className="rounded bg-paper-sunk px-1">docker compose up -d</code>; from a copy of the
      code, pull it and run{' '}
      <code className="rounded bg-paper-sunk px-1">docker compose up -d --build</code>. A copy
      deployed to Cloudflare gets an “Update Hotsauce” pull request every Monday; merge it to
      update.
    </p>
  )
}

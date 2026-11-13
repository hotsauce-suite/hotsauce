import { useCallback, useEffect, useState } from 'react'
import { type BackupsState, backupsApi } from '../../api/org'
import { secondaryButton } from '../../apps/meetings/components/common'

/**
 * Settings → Organization: daily backups of the server's data to the organization's bucket
 * (docs/PLAN-backups-storage.md). Shows the last result and lets an admin back up now.
 */
export function BackupsSection() {
  const [state, setState] = useState<BackupsState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(
    () =>
      backupsApi
        .get()
        .then(setState, (err: unknown) =>
          setError(err instanceof Error ? err.message : 'Couldn’t load backups'),
        ),
    [],
  )
  useEffect(() => {
    void load()
  }, [load])
  const runNow = async () => {
    setBusy(true)
    setError(null)
    try {
      const { status } = await backupsApi.run()
      if (status.lastError) setError(status.lastError)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backup failed')
    } finally {
      setBusy(false)
    }
  }
  const s = state?.enabled ? state.status : null
  return (
    <section data-testid="org-backups" className="flex flex-col gap-4">
      <div>
        <h2 className="font-display text-[1.6rem] leading-tight font-semibold tracking-tight text-ink">
          Backups
        </h2>
        <p className="mt-2 text-ink-soft">
          Every night the server copies its documents, settings and records to your storage bucket.
          The last 14 days are kept, plus one a week for 8 weeks.
        </p>
      </div>
      {state === null && !error ? <p className="text-sm text-ink-faint">Loading…</p> : null}
      {state && !state.enabled ? (
        <p className="text-sm text-ink-soft" data-testid="backups-off">
          Off: backups need a storage bucket. Add one under Files and audio below.
        </p>
      ) : null}
      {state?.enabled ? (
        <div className="flex flex-col gap-2 text-sm text-ink">
          <p data-testid="backups-last">
            {s?.lastSuccessAt
              ? `Last backup ${new Date(s.lastSuccessAt).toLocaleString()}, ${formatSize(s.lastBytes ?? 0)}.`
              : 'No backup yet.'}{' '}
            <span className="text-ink-faint">
              {state.backups.length} kept in {state.folder}
            </span>
          </p>
          {s?.lastError && s.lastAttemptAt !== s.lastSuccessAt ? (
            <p role="alert" className="text-ember-strong" data-testid="backups-error">
              The last try, {new Date(s.lastAttemptAt ?? '').toLocaleString()}, failed:{' '}
              {s.lastError}
            </p>
          ) : null}
          <div>
            <button
              type="button"
              data-testid="backup-now"
              disabled={busy || s?.running === true}
              onClick={() => void runNow()}
              className={`${secondaryButton} h-9`}
            >
              {busy || s?.running ? 'Backing up…' : 'Back up now'}
            </button>
          </div>
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

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

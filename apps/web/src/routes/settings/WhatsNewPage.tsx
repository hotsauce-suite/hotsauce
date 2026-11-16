import { useEffect } from 'react'
import { useRouteLoaderData } from 'react-router'
import type { Health } from '../../api/types'
import { product } from '../../brand/product'
import { RELEASES, type ReleaseNotes } from '../../lib/whatsNew'

/** Where the same notes are published for everyone (N6). */
export const PUBLIC_CHANGES = 'https://hotsauce.work/changes'

function formatDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`)
  return Number.isNaN(d.getTime())
    ? date
    : d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}

/**
 * Settings → What's new (docs/PLAN-mac-version-and-whats-new.md, N5): every release's notes,
 * newest first, Mac app changes marked. Opened from the version under the Settings menu and from
 * the Mac app card; not a menu page of its own.
 */
export function WhatsNewPage({ releases = RELEASES }: { releases?: ReleaseNotes[] }) {
  const health = useRouteLoaderData('root') as Health | undefined
  useEffect(() => {
    document.title = `What’s new · Settings · ${product()}`
  }, [])
  return (
    <section aria-labelledby="whats-new-title" data-testid="settings-whats-new">
      <h2 id="whats-new-title" className="font-display text-[1.6rem] font-semibold tracking-tight">
        What’s new
      </h2>
      <p className="mt-2 text-ink-soft">
        {health?.version ? (
          <>
            This workspace runs version{' '}
            <span data-testid="whats-new-running" className="font-mono">
              {health.version}
            </span>
            . New versions install themselves.
          </>
        ) : (
          'New versions install themselves.'
        )}{' '}
        Changes marked Mac app arrive when you download the newest Mac app (Settings → Apps).
      </p>
      {releases.length === 0 ? (
        <p className="mt-6 text-ink-soft">No release notes yet.</p>
      ) : (
        <ol className="mt-6 space-y-6">
          {releases.map((release) => (
            <li key={release.version} data-testid="whats-new-release">
              <h3 className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono font-medium text-ink">{release.version}</span>
                <span className="text-sm text-ink-faint">{formatDate(release.date)}</span>
                {health?.version === release.version ? (
                  <span
                    data-testid="whats-new-current"
                    className="rounded-full bg-paper-sunk px-2 py-0.5 text-xs font-medium text-ink-soft"
                  >
                    This workspace
                  </span>
                ) : null}
              </h3>
              <ul className="mt-2 list-disc space-y-1.5 pl-5 text-ink-soft marker:text-ash-strong">
                {release.notes.map((note, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list; two notes may read the same
                  <li key={i} data-testid="whats-new-note">
                    {note.area ? (
                      <span
                        data-testid="whats-new-area"
                        className="mr-1.5 rounded bg-ember/10 px-1.5 py-0.5 text-xs font-medium text-ember-strong"
                      >
                        {note.area}
                      </span>
                    ) : null}
                    {note.text}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-8 text-sm text-ink-faint">
        Also at{' '}
        <a
          href={PUBLIC_CHANGES}
          target="_blank"
          rel="noreferrer"
          className="underline decoration-ash-strong underline-offset-2 hover:text-ink"
        >
          hotsauce.work/changes
        </a>
        .
      </p>
    </section>
  )
}

export default WhatsNewPage

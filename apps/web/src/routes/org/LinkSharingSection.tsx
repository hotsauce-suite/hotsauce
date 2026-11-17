import { useCallback, useEffect, useState } from 'react'
import { absoluteShareUrl, type LinkRow, sharesApi } from '../../api/shares'
import { org } from '../../brand/product'
import { describeLink, forgetLinkSetting } from '../../components/ReadOnlyLink'

const KIND: Record<LinkRow['kind'], string> = {
  doc: 'Doc',
  meeting: 'Meeting notes',
  note: 'Note',
  page: 'Page',
  clip: 'Clip',
  file: 'File',
}

/**
 * Settings → Organization: whether members may make links anyone can open, and every link made,
 * with Turn off (ARCHITECTURE §20, docs/PLAN-outside-links.md). Saved on its own and live at once;
 * the rest of the page's settings wait for a restart.
 */
export function LinkSharingSection() {
  const [on, setOn] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [links, setLinks] = useState<LinkRow[] | null>(null)
  const loadLinks = useCallback(() => {
    sharesApi.links().then(
      (r) => setLinks(r.links),
      () => setLinks([]),
    )
  }, [])
  useEffect(() => {
    sharesApi.sharing().then(
      (s) => setOn(s.publicShareLinks),
      () => setOn(false),
    )
    loadLinks()
  }, [loadLinks])
  const change = async (next: boolean) => {
    setBusy(true)
    setError(null)
    try {
      setOn((await sharesApi.setSharing(next)).publicShareLinks)
      forgetLinkSetting()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save')
    } finally {
      setBusy(false)
    }
  }
  const end = async (token: string) => {
    setError(null)
    try {
      await sharesApi.endLink(token)
      loadLinks()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t turn the link off')
    }
  }
  const who = org() || 'your organization'
  const live = links?.filter((l) => !l.ended) ?? []
  const ended = links?.filter((l) => l.ended) ?? []
  return (
    <section data-testid="org-link-sharing" className="flex flex-col gap-4">
      <div>
        <h2 className="font-display text-[1.6rem] leading-tight font-semibold tracking-tight text-ink">
          Read-only links
        </h2>
        <p className="mt-2 text-ink-soft">
          A doc, meeting note, note, page, clip or file can have a read-only link. Members make one
          from its Share menu and choose who can open it and when it ends (30 days unless they pick
          otherwise). Turning one off stops it at once.
        </p>
      </div>
      <label className="flex items-start gap-2 text-sm text-ink">
        <input
          type="checkbox"
          data-testid="public-share-links"
          checked={on === true}
          disabled={on === null || busy}
          onChange={(e) => void change(e.target.checked)}
          className="mt-0.5 accent-[var(--ember)]"
        />
        <span>
          Let members make links anyone can open, without signing in
          <span className="block text-ink-faint">
            {on
              ? `On: a member can choose "Anyone with the link" to share with people outside ${who}. Turning this off stops all of those links at once.`
              : `Off: every link opens only for people who can sign in to ${who}.`}
          </span>
        </span>
      </label>
      {error ? (
        <p role="alert" className="text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
      <div>
        <h3 className="text-sm font-medium text-ink">Links</h3>
        {links === null ? (
          <p className="mt-1 text-sm text-ink-faint">Loading…</p>
        ) : links.length === 0 ? (
          <p className="mt-1 text-sm text-ink-faint" data-testid="links-empty">
            No links yet. Links made from a Share menu show here.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col divide-y divide-ash" data-testid="links-list">
            {[...live, ...ended].map((l) => (
              <li
                key={l.token}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
              >
                <span className="min-w-0 flex-1">
                  <a
                    href={absoluteShareUrl(l.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`font-medium break-words ${l.ended ? 'text-ink-faint' : 'text-ink hover:underline'}`}
                  >
                    {l.title || 'Untitled'}
                  </a>
                  <span className="block text-xs text-ink-faint">
                    {KIND[l.kind]} · {describeLink(l)} · made by {l.createdBy.name}
                  </span>
                </span>
                {l.ended ? (
                  <span className="text-xs text-ink-faint">Ended</span>
                ) : (
                  <button
                    type="button"
                    data-testid="link-end"
                    onClick={() => void end(l.token)}
                    className="rounded-lg border border-ash-strong px-3 py-1 text-sm text-ember-strong hover:border-ember"
                  >
                    Turn off
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

import { useEffect, useState } from 'react'
import { sharesApi } from '../../api/shares'
import { org, product } from '../../brand/product'
import { forgetLinkSetting } from '../../components/ReadOnlyLink'

/**
 * Settings → Organization: who can open a read-only link (ARCHITECTURE §20). Saved on its own and
 * live at once; the rest of the page's settings wait for a restart.
 */
export function LinkSharingSection() {
  const [on, setOn] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    sharesApi.sharing().then(
      (s) => setOn(s.publicShareLinks),
      () => setOn(false),
    )
  }, [])
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
  const who = org() || 'your organization'
  return (
    <section data-testid="org-link-sharing" className="flex flex-col gap-4">
      <div>
        <h2 className="font-display text-[1.6rem] leading-tight font-semibold tracking-tight text-ink">
          Read-only links
        </h2>
        <p className="mt-2 text-ink-soft">
          A doc, meeting note, note or page can have a read-only link. Members turn one on from its
          Share menu, and turning it off stops it at once.
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
          Anyone with the link can read it, without signing in
          <span className="block text-ink-faint">
            {on
              ? 'On: people outside the organization can open links they are sent.'
              : `Off: only people who can sign in to ${product()} at ${who} can open links.`}
          </span>
        </span>
      </label>
      {error ? (
        <p role="alert" className="text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
    </section>
  )
}

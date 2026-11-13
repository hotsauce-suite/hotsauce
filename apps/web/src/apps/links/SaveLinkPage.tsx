import { findLinkUrl } from '@hearth/format'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { type LinkSource, type LinkView, linksApi } from '../../api/links'
import { product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { MeetingsPageHeader, primaryButton, secondaryButton } from '../meetings/components/common'
import { errorMessage } from './useLinks'

/** The page message the Chrome extension's bridge listens for (apps/extension/src/protocol.ts). */
export const LINK_SAVED_MESSAGE = 'link-saved'
/** How long to wait for the extension to say it opened this tab. */
export const EXTENSION_WAIT_MS = 1500

const SOURCES: readonly LinkSource[] = ['extension', 'share', 'shortcut']

/** Asks the Chrome extension whether it opened this tab; false without an answer. */
function extensionOpenedThis(): Promise<boolean> {
  const id = `may-save-${Math.random().toString(36).slice(2)}`
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      window.removeEventListener('message', listen)
      clearTimeout(timer)
      resolve(ok)
    }
    const listen = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return
      const d = event.data as { source?: unknown; type?: unknown; id?: unknown; ok?: unknown }
      if (d?.source === 'hearth-extension' && d.type === 'may-save' && d.id === id) {
        done(d.ok === true)
      }
    }
    const timer = setTimeout(() => done(false), EXTENSION_WAIT_MS)
    window.addEventListener('message', listen)
    window.postMessage({ source: 'hearth-page', type: 'may-save', id }, window.location.origin)
  })
}

/**
 * `/links/save?url=&title=&text=&via=`: saves a link and says so. The Chrome extension, the
 * phone's share sheet (the PWA's share target) and the iPhone Shortcut all open it (§23.6).
 * Any site could open this address too, so it saves on its own only when the extension says it
 * opened this tab; otherwise the member taps Save.
 */
export default function SaveLinkPage() {
  const [params] = useSearchParams()
  const [saved, setSaved] = useState<(LinkView & { existing: boolean }) | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(true)
  const [saving, setSaving] = useState(false)
  const started = useRef(false)
  const via = params.get('via') as LinkSource | null
  const shown =
    params.get('url') || findLinkUrl(params.get('text') ?? '') || params.get('text') || ''

  const save = useCallback(() => {
    setSaving(true)
    const tell = (ok: boolean) => {
      if (via !== 'extension') return
      window.postMessage(
        { source: 'hearth-page', type: LINK_SAVED_MESSAGE, id: 'save', ok },
        window.location.origin,
      )
    }
    linksApi
      .save({
        ...(params.get('url') ? { url: params.get('url') ?? '' } : {}),
        ...(params.get('text') ? { text: params.get('text') ?? '' } : {}),
        ...(params.get('title') ? { title: params.get('title') ?? '' } : {}),
        source: via && SOURCES.includes(via) ? via : 'share',
      })
      .then(
        (link) => {
          setSaved(link)
          tell(true)
        },
        (e: unknown) => {
          setError(errorMessage(e, 'That didn’t save. Check your connection and try again.'))
          tell(false)
        },
      )
      .finally(() => setSaving(false))
  }, [params, via])

  useEffect(() => {
    document.title = `Save a link · ${product()}`
    // Once, even under StrictMode's double effects.
    if (started.current) return
    started.current = true
    if (via !== 'extension') {
      setAsking(false)
      return
    }
    void extensionOpenedThis().then((ok) => {
      setAsking(false)
      if (ok) save()
    })
  }, [via, save])

  return (
    <>
      <MeetingsPageHeader title="Links" menu={false} />
      <div className="mx-auto w-full max-w-md px-4 pt-12 text-center md:px-8">
        {error ? (
          <>
            <p className="font-display text-xl font-semibold text-ink">Not saved</p>
            <p role="alert" className="mt-2 text-sm text-ember-strong">
              {error}
            </p>
          </>
        ) : saved ? (
          <>
            <div className="mx-auto mb-3 grid size-12 place-items-center rounded-full bg-ember/10 text-ember-strong">
              <Icon name="check" />
            </div>
            <p className="font-display text-xl font-semibold text-ink" data-testid="link-saved">
              {saved.existing ? 'Already saved' : 'Saved'}
            </p>
            <p className="mt-2 line-clamp-3 text-sm text-ink-soft">{saved.title || saved.url}</p>
            <div className="mt-6 flex justify-center gap-2">
              <Link
                to={`/links/${encodeURIComponent(saved.space)}/${encodeURIComponent(saved.id)}`}
                className={secondaryButton}
              >
                Open it
              </Link>
              <Link to="/links" className={secondaryButton}>
                All links
              </Link>
            </div>
          </>
        ) : asking || saving ? (
          <p className="text-sm text-ink-soft">Saving…</p>
        ) : (
          <>
            <p className="font-display text-xl font-semibold text-ink">Save this link?</p>
            {params.get('title') ? (
              <p className="mt-2 line-clamp-2 text-ink">{params.get('title')}</p>
            ) : null}
            <p className="mt-1 text-sm break-all text-ink-soft">{shown}</p>
            <div className="mt-6 flex justify-center gap-2">
              <button
                type="button"
                className={primaryButton}
                data-testid="link-save-confirm"
                onClick={save}
              >
                Save to Links
              </button>
              <Link to="/links" className={secondaryButton}>
                Cancel
              </Link>
            </div>
          </>
        )}
      </div>
    </>
  )
}

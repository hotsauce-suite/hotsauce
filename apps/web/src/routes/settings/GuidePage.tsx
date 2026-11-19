// Settings → Hotsauce 101 (docs/PLAN-tour-and-101.md H1-H4): a card per app with its picture, what
// it's for, whether it's ready here, and Open. The picture plays the app's loop in place.

import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useRouteLoaderData } from 'react-router'
import type { Health } from '../../api/types'
import { inMacApp } from '../../apps/today/weatherPlace'
import { product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { MAC_APP_SETTINGS } from '../../components/MacApp'
import {
  GUIDE,
  type GuideEntry,
  posterOf,
  sortedForWorkspace,
  statusOf,
  videoOf,
} from '../../guide/appGuide'
import { useSession } from '../../state/session'

const sectionTitle = 'font-display text-[1.6rem] font-semibold tracking-tight'

export default function GuidePage() {
  const health = useRouteLoaderData('root') as Health | undefined
  const isAdmin = useSession().me?.principal.isAdmin === true
  const mac = inMacApp()
  const features = health?.features
  const entries = sortedForWorkspace(GUIDE, features)
  const [playing, setPlaying] = useState<string | null>(null)
  const { hash } = useLocation()

  useEffect(() => {
    document.title = `Hotsauce 101 · Settings · ${product()}`
  }, [])

  // `/settings/101#clips` (Command-K's "What is Clips?") lands on that card.
  useEffect(() => {
    const id = hash.replace(/^#/, '')
    if (!id) return
    document.getElementById(`guide-${id}`)?.scrollIntoView({ block: 'start' })
  }, [hash])

  return (
    <div data-testid="settings-guide">
      <h2 className={sectionTitle}>Hotsauce 101</h2>
      <p className="mt-2 max-w-prose text-sm text-ink-soft">
        What each app is for, in a sentence or two. Click a picture to watch it in action.
      </p>
      <ul className="mt-6 grid gap-4 sm:grid-cols-2" data-testid="guide-cards">
        {entries.map((entry) => (
          <GuideCard
            key={entry.id}
            entry={entry}
            status={statusOf(entry, features)}
            isAdmin={isAdmin}
            mac={mac}
            playing={playing === entry.id}
            onPlay={() => setPlaying(entry.id)}
            onStop={() => setPlaying((p) => (p === entry.id ? null : p))}
          />
        ))}
      </ul>
    </div>
  )
}

function GuideCard({
  entry,
  status,
  isAdmin,
  mac,
  playing,
  onPlay,
  onStop,
}: {
  entry: GuideEntry
  status: { ready: boolean; missing: string | null }
  isAdmin: boolean
  mac: boolean
  playing: boolean
  onPlay: () => void
  onStop: () => void
}) {
  const poster = posterOf(entry)
  const video = videoOf(entry)
  const open = openLink(entry, mac)
  return (
    <li
      id={`guide-${entry.id}`}
      data-testid="guide-card"
      data-entry={entry.id}
      data-ready={status.ready}
      className="flex scroll-mt-6 flex-col overflow-hidden rounded-2xl border border-ash bg-paper-raised"
    >
      <div className="relative aspect-[16/10] w-full bg-paper-sunk">
        {playing && video ? (
          <Player src={video} poster={poster} name={entry.name} onStop={onStop} />
        ) : poster ? (
          <button
            type="button"
            onClick={video ? onPlay : undefined}
            disabled={!video}
            data-testid="guide-play"
            aria-label={`Watch ${entry.name} in action`}
            className="group absolute inset-0 block size-full"
          >
            <img
              src={poster}
              alt=""
              loading="lazy"
              decoding="async"
              className="size-full object-cover object-top"
            />
            {video ? (
              <span className="absolute inset-0 grid place-items-center">
                <span className="grid size-12 place-items-center rounded-full bg-ember text-paper-raised shadow-lg transition-transform group-hover:scale-105 group-focus-visible:scale-105 motion-reduce:transition-none">
                  <Icon name="play" className="size-5" />
                </span>
              </span>
            ) : null}
          </button>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 px-4 py-3.5">
        <p
          data-testid="guide-status"
          className={`text-xs font-medium ${status.ready ? 'text-moss' : 'text-ink-faint'}`}
        >
          {status.ready
            ? `Ready${entry.id === 'dictate' ? ', in the Mac app' : ''}`
            : `Needs ${status.missing}${isAdmin ? '' : ': ask an admin'}`}
        </p>
        <h3 className="font-display text-lg font-semibold tracking-tight">{entry.name}</h3>
        <p className="text-sm text-ink-soft">{entry.line}</p>
        <details className="text-sm text-ink-soft">
          <summary className="cursor-pointer text-ink-faint hover:text-ink">How it works</summary>
          <p className="mt-1.5">{entry.how}</p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
            {entry.feats.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </details>
        <div className="mt-auto flex flex-wrap gap-x-4 gap-y-1 pt-2 text-sm font-medium">
          {open ? (
            <Link
              to={open.to}
              data-testid="guide-open"
              className="text-ember-strong hover:underline"
            >
              {open.label} →
            </Link>
          ) : (
            <span className="text-ink-faint">Press ⌘J on any page</span>
          )}
          {!status.ready && isAdmin ? (
            <Link
              to="/settings/organization/ai"
              data-testid="guide-add-key"
              className="text-ink-soft hover:text-ink hover:underline"
            >
              Add the key
            </Link>
          ) : null}
        </div>
      </div>
    </li>
  )
}

/** Where a card's Open goes: the app's page, or for Dictate, the Mac's settings or the download. */
function openLink(entry: GuideEntry, mac: boolean): { to: string; label: string } | null {
  if (entry.id === 'dictate') {
    return mac
      ? { to: '/settings/mac', label: 'Set up in This Mac' }
      : { to: MAC_APP_SETTINGS, label: 'Get the Mac app' }
  }
  if (!entry.open) return null
  return { to: entry.open, label: `Open ${entry.name}` }
}

/** The loop, muted, with the browser's own controls; Escape or Close (focused first) puts the picture back. */
function Player({
  src,
  poster,
  name,
  onStop,
}: {
  src: string
  poster: string | null
  name: string
  onStop: () => void
}) {
  const close = useRef<HTMLButtonElement>(null)
  const still =
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  useEffect(() => {
    close.current?.focus()
  }, [])
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape from the player is a keyboard extra; Close does the same
    <div
      className="absolute inset-0"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onStop()
        }
      }}
    >
      {/* biome-ignore lint/a11y/useMediaCaption: the loops have no sound or speech */}
      <video
        src={src}
        poster={poster ?? undefined}
        data-testid="guide-video"
        aria-label={`${name} in action`}
        muted
        loop
        playsInline
        controls
        autoPlay={!still}
        preload="auto"
        className="size-full bg-black object-contain"
      />
      <button
        type="button"
        ref={close}
        onClick={onStop}
        data-testid="guide-close"
        aria-label="Close the video"
        className="absolute top-2 right-2 grid size-8 place-items-center rounded-full bg-black/60 text-white hover:bg-black/75"
      >
        <Icon name="close" className="size-4" />
      </button>
    </div>
  )
}

// An address no page owns (docs/PLAN-easter-eggs.md E6): a tipped-over bottle and a way back,
// inside the app, instead of jumping to Docs without a word.

import { Link } from 'react-router'
import { primaryButton } from '../apps/meetings/components/common'

/** A hot sauce bottle on its side with a puddle, in the theme's colours. */
function TippedBottle() {
  return (
    <svg
      viewBox="0 0 200 110"
      className="h-28 w-auto"
      role="img"
      aria-label="A tipped-over hot sauce bottle"
    >
      <ellipse cx="150" cy="96" rx="40" ry="7" fill="var(--ember)" opacity="0.35" />
      <circle cx="176" cy="86" r="4" fill="var(--ember)" opacity="0.55" />
      <g transform="rotate(-8 100 70)">
        <rect x="20" y="52" width="92" height="40" rx="14" fill="var(--ember)" />
        <rect x="42" y="60" width="44" height="24" rx="4" fill="var(--paper-raised)" />
        <path d="M58 76c0-6 4-10 9-11-1 3 0 5 2 6 3 2 3 6 0 8-3 2-9 1-11-3z" fill="var(--ember)" />
        <rect x="110" y="62" width="22" height="20" rx="4" fill="var(--ember-strong)" />
        <rect x="130" y="65" width="14" height="14" rx="3" fill="var(--ink-soft)" />
      </g>
    </svg>
  )
}

export default function NotFoundRoute() {
  return (
    <div
      data-testid="not-found"
      className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center"
    >
      <TippedBottle />
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
        This page got too spicy and left.
      </h1>
      <p className="max-w-sm text-sm text-ink-soft">
        Nothing lives at this address. It may have moved, or the link was mistyped.
      </p>
      <Link to="/docs" className={`${primaryButton} mt-2`} data-testid="not-found-home">
        Go to Docs
      </Link>
    </div>
  )
}

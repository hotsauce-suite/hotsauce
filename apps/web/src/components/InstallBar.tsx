import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { product } from '../brand/product'
import {
  dismissInstallBar,
  type InstallPrompt,
  installBarDismissed,
  useInstallPrompt,
} from '../lib/install'
import { Icon } from './Icon'

/**
 * The top bar offering to install the app, on a phone or tablet browser until it's installed
 * or dismissed (docs/PLAN-install-and-settings.md, I3–I5).
 */
export function InstallBar() {
  const install = useInstallPrompt()
  const [dismissed, setDismissed] = useState(installBarDismissed)
  const [howTo, setHowTo] = useState(false)
  // The live demo ships no service worker, and nobody should install a demo (vite.config.ts).
  if (import.meta.env.MODE === 'demo') return null
  if (dismissed || !install.isMobile || install.isInstalled) return null

  return (
    <section
      aria-label={`Install ${product()}`}
      data-testid="install-bar"
      className="flex shrink-0 items-center gap-2 border-b border-ash bg-paper-raised px-3 py-2 pt-[calc(0.5rem+env(safe-area-inset-top))] text-sm text-ink"
    >
      <Icon name="phone" className="size-4 shrink-0 text-ember" />
      <span className="min-w-0 flex-1 truncate">Install {product()} on your phone</span>
      <InstallButton
        install={install}
        onHowTo={() => setHowTo(true)}
        testId="install-bar-install"
      />
      <button
        type="button"
        aria-label="Dismiss"
        data-testid="install-bar-dismiss"
        onClick={() => {
          dismissInstallBar()
          setDismissed(true)
        }}
        className="grid size-8 shrink-0 place-items-center rounded-md text-ink-faint hover:bg-paper-sunk hover:text-ink"
      >
        <Icon name="close" className="size-3.5" />
      </button>
      {howTo ? <InstallSheet isIOS={install.isIOS} onClose={() => setHowTo(false)} /> : null}
    </section>
  )
}

/** Install: the browser's own dialog when it has one, otherwise the how-to sheet. */
export function InstallButton({
  install,
  onHowTo,
  testId,
  className = 'h-8 shrink-0 rounded-lg bg-ember px-3 text-sm font-medium text-paper-raised hover:bg-ember-strong',
}: {
  install: InstallPrompt
  onHowTo: () => void
  testId: string
  className?: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={() => {
        if (install.canPrompt) void install.prompt()
        else onHowTo()
      }}
      className={className}
    >
      Install
    </button>
  )
}

/** Two steps to add the app to the home screen, for browsers with no install dialog. */
export function InstallSheet({ isIOS, onClose }: { isIOS: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const steps = isIOS
    ? [
        { icon: <ShareGlyph />, text: 'Tap the Share button in Safari’s toolbar.' },
        { icon: <AddGlyph />, text: 'Scroll down and tap Add to Home Screen, then Add.' },
      ]
    : [
        { icon: <MenuGlyph />, text: 'Open your browser’s menu (often ⋮ or the Share button).' },
        { icon: <AddGlyph />, text: 'Tap Install app or Add to Home Screen.' },
      ]

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 bg-paper-sunk/60 backdrop-blur-[1px]"
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-sheet-title"
        data-testid="install-sheet"
        data-platform={isIOS ? 'ios' : 'other'}
        className="relative rounded-t-2xl border-t border-ash bg-paper-raised px-5 pt-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-float"
      >
        <div className="flex items-start gap-3">
          <h2
            id="install-sheet-title"
            className="min-w-0 flex-1 font-display text-xl font-semibold tracking-tight"
          >
            Add {product()} to your Home Screen
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid size-8 shrink-0 place-items-center rounded-md text-ink-faint hover:bg-paper-sunk hover:text-ink"
          >
            <Icon name="close" className="size-3.5" />
          </button>
        </div>
        <p className="mt-1 text-sm text-ink-soft">
          It opens full screen like any other app, and can send you reminders.
        </p>
        <ol className="mt-4 space-y-3">
          {steps.map((step, i) => (
            <li key={step.text} className="flex items-center gap-3 text-sm text-ink">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-paper-sunk text-xs font-semibold text-ink-soft">
                {i + 1}
              </span>
              <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-ash text-ember">
                {step.icon}
              </span>
              <span className="min-w-0 flex-1">{step.text}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>,
    document.body,
  )
}

const glyph = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className: 'size-5',
}

/** Safari's Share icon: a box with an arrow out of the top. */
function ShareGlyph() {
  return (
    <svg {...glyph} aria-hidden="true">
      <path d="M12 3v12M8 7l4-4 4 4M7 10H5v11h14V10h-2" />
    </svg>
  )
}

/** A rounded square with a plus, like Add to Home Screen's icon. */
function AddGlyph() {
  return (
    <svg {...glyph} aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  )
}

function MenuGlyph() {
  return (
    <svg {...glyph} aria-hidden="true">
      <path d="M12 5h.01M12 12h.01M12 19h.01" strokeWidth={3} />
    </svg>
  )
}

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

/**
 * How to install, for browsers with no install dialog: two steps on a phone or tablet, and where
 * each desktop browser keeps it on a computer. Focus stays inside while it's open and goes back
 * to whatever opened it.
 */
export function InstallSheet({
  isIOS,
  isMobile = true,
  onClose,
}: {
  isIOS: boolean
  isMobile?: boolean
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ref.current?.querySelector<HTMLElement>('button')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current()
      if (event.key !== 'Tab' || !ref.current) return
      const focusable = [...ref.current.querySelectorAll<HTMLElement>('button, a[href]')]
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return
      const inside = ref.current.contains(document.activeElement)
      if (event.shiftKey && (document.activeElement === first || !inside)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      opener?.focus()
    }
  }, [])

  const steps = !isMobile
    ? [
        {
          icon: <AddGlyph />,
          text: 'In Chrome or Edge, click the install icon at the right of the address bar, or open the ⋮ menu and choose Install.',
        },
        { icon: <ShareGlyph />, text: 'In Safari on a Mac, choose File, then Add to Dock.' },
        {
          icon: <MenuGlyph />,
          text: 'Firefox can’t install web apps. Use Chrome, Edge or Safari, or the Mac app below.',
        },
      ]
    : isIOS
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
        data-platform={!isMobile ? 'computer' : isIOS ? 'ios' : 'other'}
        className="relative rounded-t-2xl border-t border-ash bg-paper-raised px-5 pt-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-float"
      >
        <div className="flex items-start gap-3">
          <h2
            id="install-sheet-title"
            className="min-w-0 flex-1 font-display text-xl font-semibold tracking-tight"
          >
            {isMobile
              ? `Add ${product()} to your Home Screen`
              : `Install ${product()} on this computer`}
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
          {isMobile
            ? 'It opens full screen like any other app, and can send you reminders.'
            : 'It opens in its own window, with its own icon in your dock or taskbar.'}
        </p>
        <ol className="mt-4 space-y-3">
          {steps.map((step, i) => (
            <li key={step.text} className="flex items-center gap-3 text-sm text-ink">
              {/* On a computer the lines are alternatives, one per browser, not steps. */}
              {isMobile ? (
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-paper-sunk text-xs font-semibold text-ink-soft">
                  {i + 1}
                </span>
              ) : null}
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

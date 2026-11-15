import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { primaryButton, secondaryButton } from '../apps/meetings/components/common'
import { product } from '../brand/product'
import { hasMacNotifications } from '../lib/macNotifications'
import { Icon } from './Icon'

// The Mac app's download: offered in Settings, linked from Today.

/** Served by the server from the web build; the Dockerfile puts it there. */
export const MAC_APP_DOWNLOAD = '/downloads/Hotsauce.dmg'
/** The same app as a zip, for anyone whose browser or Mac won't open the disk image. */
export const MAC_APP_ZIP = '/downloads/Hotsauce.zip'
/** How to build the Mac app, for a server that has no build to offer. */
export const MAC_APP_SOURCE =
  'https://github.com/hotsauce-suite/hotsauce/blob/main/apps/dictate-mac/README.md'
/** Where the download lives. */
export const MAC_APP_SETTINGS = '/settings/apps#mac-app'
const PRIVACY_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security'

/**
 * Opens the installed Mac app's setup window with this workspace's address filled in; the app
 * still checks it before saving (apps/dictate-mac SetupLink, docs/PLAN-mac-onboarding.md R4, R5).
 */
export function macSetupLink(origin: string): string {
  return `hearth://setup?server=${encodeURIComponent(origin)}`
}

/**
 * Whether this server has a Mac app build to download: null while asking. A server built without
 * it (a fresh self-hosted one) has nothing at the download path.
 */
export function useMacAppBuild(enabled = true): boolean | null {
  const [hasBuild, setHasBuild] = useState<boolean | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    fetch(MAC_APP_DOWNLOAD, { method: 'HEAD' }).then(
      (res) => {
        if (!cancelled) setHasBuild(res.ok)
      },
      () => {
        if (!cancelled) setHasBuild(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [enabled])
  return hasBuild
}

/**
 * Settings → Apps, the Mac app's card: the download, or the source for a server without a build.
 * `#mac-app` (MAC_APP_SETTINGS) scrolls to it. The first-install steps stay folded until asked
 * for, and inside the Mac app the card says so and offers only the newest build
 * (docs/PLAN-settings-pages.md, T1, T2).
 */
export function MacAppCard() {
  // A Mac app new enough to answer its bridge; an older one still sees the download.
  const inMacApp = hasMacNotifications()
  const hasBuild = useMacAppBuild()
  // Someone sent here by a “Get the Mac app” link is about to install it: show them the steps.
  const sentHere = useLocation().hash === '#mac-app'
  if (inMacApp) {
    return (
      <section
        id="mac-app"
        aria-labelledby="mac-app-title"
        data-testid="mac-app"
        className="flex scroll-mt-6 flex-wrap items-center gap-3 rounded-xl border border-ash bg-paper-raised/60 p-4"
      >
        <Icon name="laptop" className="size-5 shrink-0 text-ember" />
        <span className="min-w-0 flex-1 basis-56">
          <h3 id="mac-app-title" className="font-medium text-ink">
            Mac app
          </h3>
          <span className="block text-sm text-ink-soft">
            You’re using it on this Mac.
            {/* The app doesn't update itself: a newer build is fetched from here. */}
            {hasBuild ? (
              <>
                {' '}
                <a
                  href={MAC_APP_DOWNLOAD}
                  download
                  data-testid="mac-app-download-newest"
                  className="underline decoration-ash-strong underline-offset-2 hover:text-ink"
                >
                  Download the newest version
                </a>
              </>
            ) : null}
          </span>
        </span>
        <span
          data-testid="mac-app-in-use"
          className="flex shrink-0 items-center gap-1 text-sm font-medium text-moss"
        >
          <Icon name="check" className="size-4" />
          Installed
        </span>
      </section>
    )
  }
  return (
    <section
      id="mac-app"
      aria-labelledby="mac-app-title"
      data-testid="mac-app"
      className="scroll-mt-6 rounded-xl border border-ash bg-paper-raised/60 p-4"
    >
      <h3 id="mac-app-title" className="flex items-center gap-2 font-medium text-ink">
        <Icon name="laptop" className="size-5 shrink-0 text-ember" />
        Mac app
      </h3>
      <p className="mt-1 text-sm text-ink-soft">
        All of {product()} in its own window, plus what a browser can’t do: dictate into any app
        (hold right ⌥ option and talk), record any call on your Mac, and a reminder before each
        meeting. Needs macOS 14 or later.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {hasBuild === null ? null : hasBuild === false ? (
          <a
            href={MAC_APP_SOURCE}
            target="_blank"
            rel="noreferrer"
            data-testid="mac-app-build-from-source"
            className={primaryButton}
          >
            <Icon name="download" />
            Build the Mac app
          </a>
        ) : (
          <>
            <a
              href={MAC_APP_DOWNLOAD}
              download
              data-testid="mac-app-download"
              className={primaryButton}
            >
              <Icon name="download" />
              Download for Mac
            </a>
            <a
              href={MAC_APP_ZIP}
              download
              data-testid="mac-app-download-zip"
              className="text-sm text-ink-soft underline decoration-ash-strong underline-offset-2 hover:text-ink"
            >
              Download as a .zip instead
            </a>
          </>
        )}
      </div>

      {hasBuild ? (
        <details data-testid="mac-app-first-install" className="mt-4" open={sentHere}>
          <summary className="cursor-pointer text-sm font-medium text-ink-soft hover:text-ink">
            How to install it the first time
          </summary>
          <p className="mt-2 text-sm text-ink-soft">
            It isn’t from the App Store, so macOS asks you to confirm it once.
          </p>
          <ol
            data-testid="mac-app-install-steps"
            className="mt-3 list-decimal space-y-2 pl-5 text-sm text-ink-soft marker:font-semibold marker:text-ember"
          >
            <li>Open the downloaded disk image and drag {product()} into Applications.</li>
            <li>
              Open it from Applications. When macOS says{' '}
              <span className="text-ink">“Apple could not verify…”</span>, click{' '}
              <span className="font-medium text-ink">Done</span>.
            </li>
            <li>
              Open System Settings → Privacy &amp; Security, scroll down, and click{' '}
              <span className="font-medium text-ink">Open Anyway</span> next to {product()}, then
              confirm. On macOS 14, Control-click the app and choose Open instead.
            </li>
            <li>
              When it asks where your team’s {product()} lives, press{' '}
              <span className="font-medium text-ink">Set up the Mac app</span> below to fill in{' '}
              <span className="font-medium text-ink">{window.location.host}</span> (or type it),
              then press Continue and Sign in with Google.
            </li>
            <li>
              Allow what its setup window lists (microphone, Accessibility, Location and
              Notifications); it opens at each start until all are on. Then press Connect this Mac
              on the{' '}
              <Link to="/dictate/mac" className="text-ember-strong underline">
                Dictate page
              </Link>
              .
            </li>
          </ol>
          <div className="mt-4 flex flex-wrap gap-3">
            <a
              href={macSetupLink(window.location.origin)}
              data-testid="mac-app-setup-link"
              className={secondaryButton}
            >
              Set up the Mac app
            </a>
            <a
              href={PRIVACY_SETTINGS}
              data-testid="mac-app-open-privacy"
              className={secondaryButton}
            >
              Open Privacy &amp; Security
            </a>
          </div>
        </details>
      ) : null}
      <p className="mt-3 text-xs text-ink-faint">
        Already installed? It’s {product()} in your Dock and Applications. Audio you dictate is sent
        to {product()} to be transcribed and is never saved.
      </p>
    </section>
  )
}

import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { primaryButton, secondaryButton } from '../apps/meetings/components/common'
import { product } from '../brand/product'
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
export const MAC_APP_SETTINGS = '/settings#mac-app'
const PRIVACY_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security'

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

/** Settings' "Mac app" section: the download, or the source for a server without a build. */
export function MacAppSection() {
  const hasBuild = useMacAppBuild()
  return (
    <section id="mac-app" aria-labelledby="mac-app-title" data-testid="mac-app" className="mt-12">
      <h2 id="mac-app-title" className="font-display text-[1.6rem] font-semibold tracking-tight">
        Mac app
      </h2>
      <p className="mt-2 text-ink-soft">
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
        <>
          <h3 className="mt-6 text-sm font-semibold text-ink-soft">Installing it the first time</h3>
          <p className="mt-1 text-sm text-ink-soft">
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
              Sign in when it opens. Allow what its setup window lists (microphone, Accessibility,
              Location and Notifications); it opens at each start until all are on. Then press
              Connect this Mac on the{' '}
              <Link to="/dictate/mac" className="text-ember-strong underline">
                Dictate page
              </Link>
              .
            </li>
          </ol>
          <div className="mt-4">
            <a
              href={PRIVACY_SETTINGS}
              data-testid="mac-app-open-privacy"
              className={secondaryButton}
            >
              Open Privacy &amp; Security
            </a>
          </div>
        </>
      ) : null}
      <p className="mt-3 text-xs text-ink-faint">
        Already installed? It’s {product()} in your Dock and Applications. Audio you dictate is sent
        to {product()} to be transcribed and is never saved.
      </p>
    </section>
  )
}

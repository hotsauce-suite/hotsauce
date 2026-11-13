import { useEffect, useState } from 'react'
import { product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { extensionVersion } from './audio/extension'
import { MeetingsPageHeader, primaryButton } from './components/common'

/** Served by the server from the web build; the Dockerfile puts it there. */
export const EXTENSION_DOWNLOAD = '/downloads/hearth-meetings-chrome.zip'

const code = 'rounded bg-paper-sunk px-1 py-0.5 font-mono text-[0.85em]'

/** `/meetings/extension`: what the Chrome extension does, and how to install it. */
export default function ChromeExtension() {
  const [installed, setInstalled] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    document.title = `Chrome extension · ${product()} Meetings`
    let cancelled = false
    void extensionVersion().then((v) => {
      if (!cancelled) setInstalled(v)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <>
      <MeetingsPageHeader title="Chrome extension" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 pt-6 pb-24 md:px-6 md:pt-10">
          <h2 className="font-display text-[1.6rem] font-semibold tracking-tight">
            Take notes on a Meet call in one click
          </h2>
          <p className="mt-2 text-ink-soft">
            On a Google Meet call, click the {product()} icon in Chrome’s toolbar (or press{' '}
            <kbd className={code}>Alt+Shift+H</kbd>), then Take notes. {product()} opens beside the
            call, matched to your calendar event, and listens to the Meet tab without Chrome’s “pick
            a tab, tick share audio” dialog. No bot joins the call.
          </p>
          <p className="mt-2 text-ink-soft">
            On any other page, the same icon saves the page to Links to read later; right-click a
            link to save that instead.
          </p>

          {installed ? (
            <p
              data-testid="extension-installed"
              className="mt-5 flex items-center gap-2 rounded-xl border border-ash bg-paper-raised/60 p-4 text-sm"
            >
              <Icon name="check" className="size-4 text-moss" />
              Installed in this browser (version {installed}).
            </p>
          ) : null}

          <h3 className="mt-8 text-sm font-semibold text-ink-soft">Install it</h3>
          <ol className="mt-2 list-decimal space-y-2 pl-5 text-ink">
            <li>
              <a
                href={EXTENSION_DOWNLOAD}
                download
                data-testid="extension-download"
                className={`${primaryButton} my-1 h-9 px-3`}
              >
                Download the extension
              </a>
              , then unzip it into a folder you’ll keep, such as Documents.
            </li>
            <li>
              In Chrome, go to <code className={code}>chrome://extensions</code> and turn on
              Developer mode (top right).
            </li>
            <li>Click Load unpacked and choose the unzipped folder.</li>
            <li>
              Click the puzzle-piece icon in the toolbar and pin {product()}, so its icon is always
              there. It shows a dot when you’re on a Meet call.
            </li>
          </ol>

          <h3 className="mt-8 text-sm font-semibold text-ink-soft">Updating</h3>
          <p className="mt-2 text-ink-soft">
            Download it again, replace the folder’s contents, then click the reload arrow on{' '}
            {product()} in <code className={code}>chrome://extensions</code>.
          </p>
        </div>
      </div>
    </>
  )
}

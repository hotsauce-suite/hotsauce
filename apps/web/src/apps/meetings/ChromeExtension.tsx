import { type ReactNode, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { MAC_APP_SETTINGS } from '../../components/MacApp'
import { extensionVersion } from './audio/extension'
import { MeetingsPageHeader, primaryButton, secondaryButton } from './components/common'
import {
  BUNDLED_EXTENSION_VERSION,
  CHROME_WEB_STORE_URL,
  canRunExtension,
  isOlder,
} from './extensionRelease'

/** Served by the server from the web build; the Dockerfile puts it there. */
export const EXTENSION_DOWNLOAD = '/downloads/hotsauce-meetings-chrome.zip'
export const EXTENSION_HELP = 'https://hotsauce.work/help/chrome-extension'

const code = 'rounded bg-paper-sunk px-1 py-0.5 font-mono text-[0.85em]'
const heading = 'mt-10 font-display text-lg font-semibold tracking-tight'
const list = 'mt-3 list-decimal space-y-2 pl-5 text-ink marker:font-semibold marker:text-ember'
const see = 'block text-sm text-ink-soft'

function Status({
  tone,
  testId,
  children,
}: {
  tone: 'ok' | 'todo'
  testId: string
  children: ReactNode
}) {
  return (
    <div
      data-testid={testId}
      className="mt-6 flex items-start gap-3 rounded-xl border border-ash bg-paper-raised/60 p-4 text-sm"
    >
      <Icon
        name={tone === 'ok' ? 'check' : 'download'}
        className={`mt-0.5 size-4 shrink-0 ${tone === 'ok' ? 'text-moss' : 'text-ember'}`}
      />
      <div className="min-w-0 space-y-1">{children}</div>
    </div>
  )
}

/**
 * `/meetings/extension`: what the Chrome extension does, whether this browser has it, how to
 * install it and how to take notes on a Meet call with it (docs/PLAN-extension-setup.md).
 */
export default function ChromeExtension() {
  const [installed, setInstalled] = useState<string | null | undefined>(undefined)
  const runs = canRunExtension()

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

  const behind = installed ? isOlder(installed, BUNDLED_EXTENSION_VERSION) : false

  const byHand = (
    <ol className={list}>
      <li>
        <a
          href={EXTENSION_DOWNLOAD}
          download
          data-testid="extension-download"
          className={`${CHROME_WEB_STORE_URL ? secondaryButton : primaryButton} my-1 h-9 px-3`}
        >
          Download the extension
        </a>
        , then unzip it into a folder you’ll keep, such as Documents.
      </li>
      <li>
        In Chrome, go to <code className={code}>chrome://extensions</code> and turn on Developer
        mode (top right).
      </li>
      <li>Click Load unpacked and choose the unzipped folder.</li>
      <li>
        A setup page opens: connect it to this workspace, pin the icon, and try it on a test call.
      </li>
    </ol>
  )

  return (
    <>
      <MeetingsPageHeader title="Chrome extension" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 pt-6 pb-24 md:px-6 md:pt-10">
          <h2 className="font-display text-[1.6rem] font-semibold tracking-tight">
            Take notes on a Meet call in one click
          </h2>
          <p className="mt-2 text-ink-soft">
            On a Google Meet call, click the {product()} icon in Chrome’s toolbar, then Take notes.{' '}
            {product()} opens beside the call, matched to your calendar event, and listens to the
            Meet tab without Chrome’s “pick a tab, tick share audio” dialog. No bot joins the call.
            On any other page, the same icon saves the page to Links.
          </p>

          {installed && behind ? (
            <Status tone="todo" testId="extension-update">
              <p>
                Version {installed} is installed in this browser. Version{' '}
                {BUNDLED_EXTENSION_VERSION} is ready.
              </p>
              <p className="text-ink-soft">
                {CHROME_WEB_STORE_URL
                  ? 'Chrome updates it from the Web Store by itself within a few hours.'
                  : 'Download it again below, replace the folder’s contents, then click reload on chrome://extensions.'}
              </p>
            </Status>
          ) : installed ? (
            <Status tone="ok" testId="extension-installed">
              <p>
                Installed in this browser (version {installed}) and connected to this workspace.
              </p>
            </Status>
          ) : installed === null && runs ? (
            <Status tone="todo" testId="extension-missing">
              <p>Not found in this browser yet. Install it below.</p>
              <p className="text-ink-soft">
                Already installed? Click its icon while this tab is open, press Connect, then reload
                this page.
              </p>
            </Status>
          ) : installed === null ? (
            <Status tone="todo" testId="extension-elsewhere">
              <p>The extension runs in Chrome on a computer. Open this page there to install it:</p>
              <p className="select-all break-all font-mono text-[0.85em] text-ink">
                {window.location.origin}/meetings/extension
              </p>
            </Status>
          ) : null}

          <h3 className={heading}>Install it</h3>
          {CHROME_WEB_STORE_URL ? (
            <>
              <p className="mt-2 text-ink-soft">
                From the Chrome Web Store, so Chrome keeps it up to date. A setup page opens when
                it’s installed.
              </p>
              <a
                href={CHROME_WEB_STORE_URL}
                target="_blank"
                rel="noreferrer"
                data-testid="extension-store"
                className={`${primaryButton} mt-3 h-9 px-3`}
              >
                Add to Chrome
              </a>
              <details className="mt-4 text-sm">
                <summary className="cursor-pointer text-ink-soft">
                  Install it by hand instead
                </summary>
                {byHand}
              </details>
            </>
          ) : (
            byHand
          )}

          <h3 className={heading}>Take notes on a call</h3>
          <ol className={list} data-testid="extension-how">
            <li>
              Join the call in Google Meet in Chrome.
              <span className={see}>The {product()} icon shows a small dot.</span>
            </li>
            <li>
              Click the icon (or press <kbd className={code}>⌥⇧H</kbd>, Alt+Shift+H on Windows),
              then Take notes.
              <span className={see}>
                A {product()} tab opens beside the call, named after your calendar event.
              </span>
            </li>
            <li>
              Allow the microphone the first time.
              <span className={see}>Both rows say “Sound is arriving” once someone talks.</span>
            </li>
            <li>
              If you like, click Copy a line for the chat and paste it into Meet, so people know.
            </li>
            <li>
              Pick a template and click Start recording.
              <span className={see}>The transcript runs live; type your own notes beside it.</span>
            </li>
            <li>
              When the call ends, click Stop.
              <span className={see}>The written notes appear about a minute later.</span>
            </li>
          </ol>

          <h3 className={heading}>If something’s wrong</h3>
          <dl className="mt-3 space-y-3 text-sm" data-testid="extension-trouble">
            <div>
              <dt className="font-medium">There’s no dot on the icon</dt>
              <dd className="text-ink-soft">
                The icon may be hidden: click the puzzle piece in Chrome’s toolbar and pin{' '}
                {product()}. The dot shows once you’re in the call, not on Meet’s home page.
              </dd>
            </div>
            <div>
              <dt className="font-medium">Chrome asked what to share</dt>
              <dd className="text-ink-soft">
                The meeting was started without the icon. Go back to the Meet tab, click the icon
                and Take notes. Or pick the Meet tab in Chrome’s window and tick “Share tab audio”.
              </dd>
            </div>
            <div>
              <dt className="font-medium">“No sound from the Meet tab yet”</dt>
              <dd className="text-ink-soft">
                Someone may just not be talking. If the call is clearly loud, stop and start again
                from the icon on the Meet tab.
              </dd>
            </div>
            <div>
              <dt className="font-medium">It asks which server to connect to</dt>
              <dd className="text-ink-soft">
                Open {product()} in a tab, click the icon there and press Connect, then reload the
                page.
              </dd>
            </div>
          </dl>

          <h3 className={heading}>On a Mac</h3>
          <div
            className="mt-3 rounded-xl border border-ash bg-paper-raised/60 p-4 text-sm text-ink-soft"
            data-testid="extension-mac"
          >
            <p>
              The{' '}
              <Link to={MAC_APP_SETTINGS} className="text-ember-strong underline">
                Mac app
              </Link>{' '}
              records any call: it offers “Take notes for …?” before calendar meetings that have a
              link (Meet included), and “Take notes?” when Zoom, Teams, Slack or FaceTime start a
              call. It stays quiet for calls in a browser, so you never get two offers. Use the
              extension for a Meet call you join on the spot. Use one or the other for a call: if
              the Mac app is already taking notes, there’s no need to press Take notes in Chrome.
            </p>
          </div>

          {CHROME_WEB_STORE_URL ? null : (
            <>
              <h3 className={heading}>Updating</h3>
              <p className="mt-2 text-ink-soft">
                Download it again, replace the folder’s contents, then click the reload arrow on{' '}
                {product()} in <code className={code}>chrome://extensions</code>.
              </p>
            </>
          )}

          <p className="mt-10 text-sm text-ink-soft">
            More in the{' '}
            <a
              href={EXTENSION_HELP}
              target="_blank"
              rel="noreferrer"
              className="text-ember-strong underline"
            >
              help center
            </a>
            .
          </p>
        </div>
      </div>
    </>
  )
}

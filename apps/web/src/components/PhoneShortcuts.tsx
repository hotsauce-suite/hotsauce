import { useState } from 'react'
import { product } from '../brand/product'
import { installContext } from '../lib/install'
import { actionUrl, QUICK_ACTIONS, SHARE_SAVE_PATH } from '../lib/phoneShortcuts'
import { Icon } from './Icon'

type Phone = 'android' | 'iphone'

const help = 'https://hotsauce.work/help/phone-shortcuts'
const tab = (on: boolean) =>
  `h-8 rounded-md px-3 text-sm ${on ? 'bg-paper-raised font-medium text-ink shadow-sm' : 'text-ink-soft hover:text-ink'}`

/** A Copy button for one address; says Copied for a moment. */
function CopyAddress({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={`Copy the address for ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(url).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-ash-strong px-2.5 text-sm text-ink hover:border-ember"
    >
      <Icon name={copied ? 'check' : 'copy'} className="size-3.5" />
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

/**
 * Settings → Apps, Phone shortcuts (docs/PLAN-phone-shortcuts.md): the quick actions an Android
 * phone shows when the installed app's icon is held, and the same actions for an iPhone, which
 * ignores them, as addresses for an "Open URLs" shortcut in Apple's Shortcuts app.
 */
export function PhoneShortcutsCard({ origin = window.location.origin }: { origin?: string }) {
  const [open, setOpen] = useState(false)
  const [phone, setPhone] = useState<Phone>(() => (installContext().isIOS ? 'iphone' : 'android'))
  const name = product()
  return (
    <section
      id="phone-shortcuts"
      aria-labelledby="phone-shortcuts-title"
      data-testid="phone-shortcuts"
      className="scroll-mt-6 rounded-xl border border-ash bg-paper-raised/60 p-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Icon name="phone" className="size-5 shrink-0 text-ember" />
        <span className="min-w-0 flex-1 basis-56">
          <h3 id="phone-shortcuts-title" className="font-medium text-ink">
            Phone shortcuts
          </h3>
          <span className="block text-sm text-ink-soft">
            One tap from your Home Screen to a voice note, a new task, saving a link, Ask or Ramble.
          </span>
        </span>
        <button
          type="button"
          aria-expanded={open}
          data-testid="phone-shortcuts-toggle"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-ash-strong px-4 text-sm text-ink hover:border-ember"
        >
          {open ? 'Hide' : 'Set up'}
        </button>
      </div>
      {open ? (
        <div className="mt-4 border-t border-ash/70 pt-4">
          <fieldset className="inline-flex rounded-lg border-0 bg-paper-sunk p-1">
            <legend className="sr-only">Your phone</legend>
            <button
              type="button"
              aria-pressed={phone === 'android'}
              className={tab(phone === 'android')}
              onClick={() => setPhone('android')}
            >
              Android
            </button>
            <button
              type="button"
              aria-pressed={phone === 'iphone'}
              className={tab(phone === 'iphone')}
              onClick={() => setPhone('iphone')}
            >
              iPhone
            </button>
          </fieldset>
          {phone === 'android' ? (
            <div data-testid="phone-shortcuts-android" className="mt-4 space-y-3 text-sm text-ink">
              <ol className="list-decimal space-y-2 pl-5">
                <li>Install {name} on your Home Screen from Chrome (Web app, above).</li>
                <li>
                  Press and hold the {name} icon. You’ll see{' '}
                  {QUICK_ACTIONS.map((a) => a.shortName).join(', ')}.
                </li>
                <li>Tap one to go straight to it, or drag it out to give it its own icon.</li>
              </ol>
              <p className="text-ink-soft">
                Some phones show only the first four. Already installed? A new shortcut can take a
                day to show up; removing and adding the app again shows it at once.
              </p>
            </div>
          ) : (
            <div data-testid="phone-shortcuts-iphone" className="mt-4 space-y-4 text-sm text-ink">
              <ol className="list-decimal space-y-2 pl-5">
                <li>Copy an address below.</li>
                <li>
                  Open the Shortcuts app, tap <b>+</b>, add the <b>Open URLs</b> action and paste
                  the address into it. Name the shortcut, for example “New task”.
                </li>
                <li>
                  Put it where you want it: <b>Add to Home Screen</b> from the shortcut’s menu, the
                  Shortcuts widget, or Settings → Action Button → Shortcut.
                </li>
              </ol>
              <ul className="space-y-2" aria-label="Addresses">
                {QUICK_ACTIONS.map((action) => {
                  const url = actionUrl(origin, action.path)
                  return (
                    <li
                      key={action.id}
                      data-testid={`phone-shortcut-${action.id}`}
                      className="flex items-center gap-3 rounded-lg border border-ash bg-paper-raised px-3 py-2"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{action.name}</span>
                        <span className="block truncate font-mono text-xs text-ink-soft">
                          {url}
                        </span>
                      </span>
                      <CopyAddress url={url} label={action.name} />
                    </li>
                  )
                })}
              </ul>
              <div>
                <p className="font-medium">Save from the Share button</p>
                <ol className="mt-2 list-decimal space-y-2 pl-5">
                  <li>
                    Make a new shortcut, open its details (ⓘ) and turn on <b>Show in Share Sheet</b>
                    , receiving URLs.
                  </li>
                  <li>
                    Add <b>URL Encode</b> (Shortcut Input), then <b>Text</b> with the address below
                    followed by the encoded text, then <b>Open URLs</b>.
                  </li>
                  <li>Name it “Save to {name}”. In Safari, tap Share and pick it.</li>
                </ol>
                <div className="mt-2 flex items-center gap-3 rounded-lg border border-ash bg-paper-raised px-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-soft">
                    {actionUrl(origin, SHARE_SAVE_PATH)}
                  </span>
                  <CopyAddress url={actionUrl(origin, SHARE_SAVE_PATH)} label="Save to" />
                </div>
              </div>
              <p className="text-ink-soft">
                Shortcuts open {name} in Safari, not the Home Screen app, so sign in there once. For
                voice notes and Ramble, allow the microphone when Safari asks.
              </p>
            </div>
          )}
          <a
            href={help}
            target="_blank"
            rel="noreferrer"
            className="mt-4 inline-block text-sm underline decoration-ash-strong underline-offset-2 hover:text-ink"
          >
            Step-by-step help
          </a>
        </div>
      ) : null}
    </section>
  )
}

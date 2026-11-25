import { useEffect, useState } from 'react'
import { type DictationDevice, dictationApi } from '../api/dictation'
import { product } from '../brand/product'
import { Icon } from './Icon'

/**
 * Settings → Apps, Android app (docs/PLAN-android.md R5): what the app adds, and the member's
 * connected phones with a Disconnect for each. A phone shows its widgets until it is disconnected.
 */
export function AndroidAppCard() {
  const [phones, setPhones] = useState<DictationDevice[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    dictationApi.devices('phone').then(
      (list) => {
        if (!cancelled) setPhones(list)
      },
      () => {
        if (!cancelled) setPhones([])
      },
    )
    return () => {
      cancelled = true
    }
  }, [])
  const disconnect = async (phone: DictationDevice) => {
    try {
      await dictationApi.revoke(phone.id)
      setPhones((list) => list?.filter((p) => p.id !== phone.id) ?? null)
      setError(null)
    } catch {
      setError(`Couldn’t disconnect ${phone.name}. Try again.`)
    }
  }
  return (
    <section
      id="android-app"
      aria-labelledby="android-app-title"
      data-testid="android-app"
      className="scroll-mt-6 rounded-xl border border-ash bg-paper-raised/60 p-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Icon name="phone" className="size-5 shrink-0 text-ember" />
        <span className="min-w-0 flex-1 basis-56">
          <h3 id="android-app-title" className="font-medium text-ink">
            Android app
          </h3>
          <span className="block text-sm text-ink-soft">
            {product()} on an Android home screen: a widget with your next meeting and a Join
            button, today’s tasks and the weather. It’s in testing; ask your admin for the invite.
          </span>
        </span>
      </div>
      {phones && phones.length > 0 ? (
        <div className="mt-4 border-t border-ash/70 pt-3">
          <h4 className="text-sm font-medium text-ink">Your phones</h4>
          <ul data-testid="android-phones" className="mt-1 divide-y divide-ash/70">
            {phones.map((phone) => (
              <li key={phone.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">{phone.name}</p>
                  <p className="text-xs text-ink-faint">
                    {phone.lastUsedAt
                      ? `Last updated ${new Date(phone.lastUsedAt).toLocaleString()}`
                      : 'Not used yet'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void disconnect(phone)}
                  aria-label={`Disconnect ${phone.name}`}
                  className="rounded-md px-2 py-1 text-sm text-ink-soft hover:bg-rust-wash hover:text-ember-strong"
                >
                  Disconnect
                </button>
              </li>
            ))}
          </ul>
          {error ? (
            <p role="alert" className="mt-1 text-sm text-ember-strong">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

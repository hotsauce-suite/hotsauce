import { useEffect, useRef, useState } from 'react'
import type { RobotCheckWidget } from '../api/booking'

// Cloudflare Turnstile on Hearth's signed-out pages (booking links §19, public forms §21): the
// widget, loaded once per page. Dev and test servers send `{ kind: 'dev' }` instead, which
// accepts DEV_TURNSTILE_TOKEN without showing anything.

export const DEV_TURNSTILE_TOKEN = 'dev-pass'

interface TurnstileApi {
  render(
    el: HTMLElement,
    opts: {
      sitekey: string
      callback: (token: string) => void
      'expired-callback': () => void
      'error-callback': () => void
    },
  ): string
  remove(id: string): void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

let turnstileScript: Promise<TurnstileApi> | null = null
function loadTurnstile(): Promise<TurnstileApi> {
  turnstileScript ??= new Promise((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile)
    const script = document.createElement('script')
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    script.async = true
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('no turnstile'))
    script.onerror = () => {
      turnstileScript = null
      reject(new Error('Cloudflare’s check didn’t load'))
    }
    document.head.append(script)
  })
  return turnstileScript
}

export function TurnstileWidget({
  widget,
  onToken,
  testId,
}: {
  widget: Extract<RobotCheckWidget, { kind: 'turnstile' }>
  onToken: (token: string | null) => void
  testId?: string
}) {
  const el = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let id: string | null = null
    let api: TurnstileApi | null = null
    let gone = false
    loadTurnstile()
      .then((t) => {
        if (gone || !el.current) return
        api = t
        id = t.render(el.current, {
          sitekey: widget.siteKey,
          callback: (token) => onToken(token),
          'expired-callback': () => onToken(null),
          'error-callback': () => onToken(null),
        })
      })
      .catch(() => setFailed(true))
    return () => {
      gone = true
      if (api && id) api.remove(id)
    }
  }, [widget.siteKey, onToken])
  return (
    <div>
      <div ref={el} data-testid={testId} />
      {failed ? (
        <p className="text-sm text-ember-strong">
          The check that you’re a person didn’t load. Reload the page to try again.
        </p>
      ) : null}
    </div>
  )
}

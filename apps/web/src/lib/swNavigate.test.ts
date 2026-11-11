import { describe, expect, it, vi } from 'vitest'
import { followServiceWorkerNavigation, NAVIGATE_MESSAGE } from './swNavigate'

function fakeContainer() {
  const target = new EventTarget()
  const send = (data: unknown) => target.dispatchEvent(new MessageEvent('message', { data }))
  return { container: target as unknown as ServiceWorkerContainer, send }
}

describe('followServiceWorkerNavigation', () => {
  it('moves the tab in-app to the reminder’s page', () => {
    const { container, send } = fakeContainer()
    const navigate = vi.fn()
    followServiceWorkerNavigation(container, navigate)
    send({ type: NAVIGATE_MESSAGE, url: `${window.location.origin}/meetings/start?event=e1` })
    expect(navigate).toHaveBeenCalledWith('/meetings/start?event=e1')
  })

  it('ignores other messages, and pages on other sites', () => {
    const { container, send } = fakeContainer()
    const navigate = vi.fn()
    followServiceWorkerNavigation(container, navigate)
    send({ type: 'other', url: '/meetings' })
    send({ type: NAVIGATE_MESSAGE, url: 'https://evil.example/meetings' })
    send({ type: NAVIGATE_MESSAGE })
    send(null)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('does nothing without service workers', () => {
    expect(() => followServiceWorkerNavigation(undefined, vi.fn())).not.toThrow()
  })
})

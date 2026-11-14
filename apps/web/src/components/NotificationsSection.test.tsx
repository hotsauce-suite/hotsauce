import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReminderState } from '../apps/meetings/reminders'
import { IPHONE, pretend } from '../test/devices'
import { server } from '../test/mockServer'
import { NotificationsSection } from './NotificationsSection'

// docs/PLAN-install-and-settings.md, N1 and N3. The browser's push machinery is the reminders
// module's job (it has no jsdom); here it is replaced, and the section's words and calls checked.

const reminders = vi.hoisted(() => ({
  state: 'off' as ReminderState,
  reminderState: vi.fn(),
  enableReminders: vi.fn(),
  disableReminders: vi.fn(),
}))
vi.mock('../apps/meetings/reminders', () => ({
  reminderState: reminders.reminderState,
  enableReminders: reminders.enableReminders,
  disableReminders: reminders.disableReminders,
}))

beforeEach(() => {
  reminders.reminderState.mockImplementation(async () => reminders.state)
  reminders.enableReminders.mockResolvedValue('on')
  reminders.disableReminders.mockResolvedValue('off')
})

afterEach(() => {
  vi.restoreAllMocks()
})

const noteFor = async (state: ReminderState) => {
  reminders.state = state
  render(<NotificationsSection />)
  return screen.findByTestId('notifications-note')
}

describe('Notifications on this device', () => {
  it('switches on and off through the reminders module', async () => {
    reminders.state = 'off'
    render(<NotificationsSection />)
    const toggle = await screen.findByTestId('notifications-switch')
    expect(toggle).not.toBeChecked()
    expect(screen.queryByTestId('notifications-test')).toBeNull()
    await userEvent.click(toggle)
    await waitFor(() => expect(toggle).toBeChecked())
    expect(reminders.enableReminders).toHaveBeenCalledTimes(1)
    await userEvent.click(toggle)
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(reminders.disableReminders).toHaveBeenCalledTimes(1)
  })

  it('says notifications are blocked in the browser', async () => {
    expect(await noteFor('blocked')).toHaveTextContent('blocked')
  })

  it('says when the server sends none', async () => {
    expect(await noteFor('unavailable')).toHaveTextContent('isn’t sending notifications')
  })

  it('tells an iPhone to add it to the Home Screen first', async () => {
    pretend({ ua: IPHONE, touch: 5 })
    expect(await noteFor('unsupported')).toHaveTextContent('Home Screen')
  })

  it('names other browsers that can, elsewhere', async () => {
    expect(await noteFor('unsupported')).toHaveTextContent('can’t show notifications')
  })

  it('sends a test notification and says how many devices got it', async () => {
    let answer = { sent: 2, failed: 0 }
    server.use(http.post('/api/meetings/reminders/test', () => HttpResponse.json(answer)))
    reminders.state = 'on'
    render(<NotificationsSection />)
    await userEvent.click(await screen.findByTestId('notifications-test'))
    expect(await screen.findByTestId('notifications-test-result')).toHaveTextContent(
      'Sent to 2 devices',
    )
    answer = { sent: 0, failed: 0 }
    await userEvent.click(screen.getByTestId('notifications-test'))
    await waitFor(() =>
      expect(screen.getByTestId('notifications-test-result')).toHaveTextContent(
        'No device is set up',
      ),
    )
    // A push service that errors isn't mistaken for no device.
    answer = { sent: 0, failed: 1 }
    await userEvent.click(screen.getByTestId('notifications-test'))
    await waitFor(() =>
      expect(screen.getByTestId('notifications-test-result')).toHaveTextContent(
        'Couldn’t reach 1 device',
      ),
    )
  })
})

// Inside the Mac app the web view has no Notification API; the app answers instead.
describe('Notifications in the Mac app', () => {
  const postMessage = vi.fn()
  beforeEach(() => {
    postMessage.mockReset()
    ;(window as { webkit?: unknown }).webkit = {
      messageHandlers: { hearthNotifications: { postMessage } },
    }
  })
  afterEach(() => {
    delete (window as { webkit?: unknown }).webkit
  })

  it('shows what macOS allows instead of the browser switch', async () => {
    postMessage.mockResolvedValue('off')
    render(<NotificationsSection />)
    const card = await screen.findByTestId('mac-notifications')
    await waitFor(() => expect(card).toHaveAttribute('data-state', 'off'))
    expect(card).toHaveTextContent('Off')
    expect(postMessage).toHaveBeenCalledWith('state')
    expect(screen.queryByTestId('notifications-switch')).toBeNull()
    expect(screen.queryByTestId('notifications-note')).toBeNull()
    expect(screen.getByTestId('settings-notifications')).not.toHaveTextContent(
      'can’t show notifications',
    )
  })

  it('asks the app to open Notifications settings, then shows the new state', async () => {
    postMessage.mockImplementation(async (request: string) =>
      request === 'open' ? 'on' : 'undecided',
    )
    render(<NotificationsSection />)
    const card = await screen.findByTestId('mac-notifications')
    await waitFor(() => expect(card).toHaveAttribute('data-state', 'undecided'))
    await userEvent.click(screen.getByTestId('mac-notifications-open'))
    expect(postMessage).toHaveBeenCalledWith('open')
    await waitFor(() => expect(card).toHaveAttribute('data-state', 'on'))
  })

  it('reads the state again when the window comes back from System Settings', async () => {
    postMessage.mockResolvedValue('off')
    render(<NotificationsSection />)
    await screen.findByTestId('mac-notifications')
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1))
    postMessage.mockResolvedValue('on')
    window.dispatchEvent(new Event('focus'))
    await waitFor(() =>
      expect(screen.getByTestId('mac-notifications')).toHaveAttribute('data-state', 'on'),
    )
  })

  it('keeps the browser switch outside the Mac app', async () => {
    delete (window as { webkit?: unknown }).webkit
    reminders.state = 'off'
    render(<NotificationsSection />)
    expect(await screen.findByTestId('notifications-switch')).toBeInTheDocument()
    expect(screen.queryByTestId('mac-notifications')).toBeNull()
  })
})

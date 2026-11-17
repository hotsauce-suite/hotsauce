import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { defaultMacSettings, FakeMac } from '../../test/fakeMac'
import { SETTINGS_INDEX, searchSettings } from './searchIndex'
import ThisMacPage from './ThisMacPage'

// docs/PLAN-one-settings.md R1–R8, against a stand-in for the Mac app's bridge.

const show = (bridge: FakeMac | null) =>
  render(
    <MemoryRouter>
      <ThisMacPage bridge={bridge} />
    </MemoryRouter>,
  )

const ready = async () => {
  const page = await screen.findByTestId('settings-mac')
  await within(page).findByText('Dictation')
  return page
}

describe('Settings → This Mac', () => {
  it('outside the Mac app, points to the Mac app instead (R1)', () => {
    show(null)
    expect(screen.getByTestId('settings-mac-absent')).toHaveTextContent('Mac app')
    expect(screen.getByRole('link', { name: 'get the Mac app' })).toHaveAttribute(
      'href',
      '/settings/apps',
    )
  })

  it('shows what the Mac reports (R2–R8)', async () => {
    const mac = new FakeMac({
      ...defaultMacSettings(),
      hotkey: 'fn',
      mode: 'literal',
      historyDays: 90,
    })
    show(mac)
    await ready()
    expect(screen.getByLabelText('Dictation shortcut')).toHaveValue('fn')
    expect(screen.getByLabelText('Mode')).toHaveValue('literal')
    expect(screen.getByText('Literal types exactly what you said.')).toBeInTheDocument()
    expect(screen.getByLabelText('Keep history for')).toHaveValue('90')
    expect(screen.getByTestId('mac-edgeGlow')).toBeChecked()
    expect(screen.getByTestId('mac-account')).toHaveTextContent('Connected as sam@example.com')
    expect(mac.requests[0]).toEqual({ type: 'get' })
  })

  it('changes a setting on the Mac and shows its answer, not the ask (R2, R3, R5, R7)', async () => {
    const mac = new FakeMac()
    mac.refuse.add('historyDays')
    show(mac)
    await ready()
    await userEvent.selectOptions(screen.getByLabelText('Dictation shortcut'), 'rightCommand')
    expect(screen.getByLabelText('Dictation shortcut')).toHaveValue('rightCommand')
    await userEvent.click(screen.getByTestId('mac-openAtLogin'))
    expect(screen.getByTestId('mac-openAtLogin')).not.toBeChecked()
    // The Mac's confirm was cancelled: the page goes back to what the Mac still has.
    await userEvent.selectOptions(screen.getByLabelText('Keep history for'), '7')
    expect(screen.getByLabelText('Keep history for')).toHaveValue('30')
    expect(mac.requests).toContainEqual({ type: 'set', key: 'hotkey', value: 'rightCommand' })
    expect(mac.requests).toContainEqual({ type: 'set', key: 'openAtLogin', value: false })
    expect(mac.requests).toContainEqual({ type: 'set', key: 'historyDays', value: 7 })
  })

  it('asks for a missing permission and runs setup again (R6)', async () => {
    const mac = new FakeMac({
      ...defaultMacSettings(),
      permissions: {
        microphone: false,
        accessibility: true,
        location: true,
        notifications: 'undecided',
      },
    })
    show(mac)
    await ready()
    const mic = screen.getByTestId('mac-permission-microphone')
    expect(mic).toHaveAttribute('data-granted', 'false')
    await userEvent.click(within(mic).getByRole('button', { name: 'Allow…' }))
    expect(screen.getByTestId('mac-permission-microphone')).toHaveTextContent('Allowed')
    expect(
      within(screen.getByTestId('mac-permission-accessibility')).queryByRole('button'),
    ).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Run setup again' }))
    expect(mac.requests).toContainEqual({ type: 'action', action: 'allowMicrophone' })
    expect(mac.requests).toContainEqual({ type: 'action', action: 'runSetup' })
  })

  it('says when notifications are off but reminders want them (R4)', async () => {
    const off = { ...defaultMacSettings().permissions, notifications: 'off' as const }
    const mac = new FakeMac({ ...defaultMacSettings(), permissions: off })
    show(mac)
    await ready()
    expect(screen.getByTestId('mac-notifications-off')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('mac-meetingReminders'))
    await userEvent.click(screen.getByTestId('mac-offerCallNotes'))
    expect(screen.queryByTestId('mac-notifications-off')).toBeNull()
  })

  it('disconnects this Mac, and clears history through the Mac (R7, R8)', async () => {
    const mac = new FakeMac()
    show(mac)
    await ready()
    await userEvent.click(screen.getByRole('button', { name: 'Clear history…' }))
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect this Mac' }))
    expect(screen.getByTestId('mac-account')).toHaveTextContent('Not connected')
    expect(screen.queryByRole('button', { name: 'Disconnect this Mac' })).toBeNull()
    expect(mac.requests).toContainEqual({ type: 'action', action: 'clearHistory' })
  })

  it('reads again when the window comes back to the front (R2)', async () => {
    const mac = new FakeMac()
    show(mac)
    await ready()
    mac.settings = {
      ...mac.settings,
      permissions: { ...mac.settings.permissions, location: false },
    }
    await act(async () => {
      fireEvent.focus(window)
    })
    expect(await screen.findByTestId('mac-permission-location')).toHaveAttribute(
      'data-granted',
      'false',
    )
  })

  it('says so when the app doesn’t answer', async () => {
    const mac = new FakeMac()
    mac.silent = true
    show(mac)
    expect(await screen.findByText(/didn’t answer/)).toBeInTheDocument()
  })
})

describe('Settings → This Mac on macOS before 14.2', () => {
  it('has no call-notes offer, as the app had none', async () => {
    show(new FakeMac({ ...defaultMacSettings(), callNotesSupported: false }))
    await ready()
    expect(screen.queryByTestId('mac-offerCallNotes')).toBeNull()
    expect(screen.getByTestId('mac-meetingReminders')).toBeInTheDocument()
  })
})

describe('Settings search covers This Mac (R13)', () => {
  it('has every setting the search lists for it, by its heading or label', async () => {
    show(new FakeMac())
    await ready()
    const page = screen.getByTestId('settings-mac')
    const labels = [...page.querySelectorAll('h2, .font-medium')].map((el) =>
      el.textContent?.trim(),
    )
    for (const entry of SETTINGS_INDEX.filter((e) => e.macOnly))
      expect(labels, entry.title).toContain(entry.title)
  })

  it('finds them inside the Mac app only', () => {
    const found = (mac: boolean) =>
      searchSettings('microphone', { admin: false, mac }).map((e) => e.id)
    expect(found(true)).toContain('mac-permissions')
    expect(found(false)).not.toContain('mac-permissions')
  })
})

describe('Microphone for dictation (R14)', () => {
  it('lists the Mac’s microphones and sends the choice, or the default', async () => {
    const mac = new FakeMac()
    show(mac)
    await ready()
    const picker = screen.getByLabelText('Microphone for dictation')
    expect(picker).toHaveValue('')
    expect(
      within(picker)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Mac’s default', 'MacBook Pro Microphone', 'Yeti Stereo Microphone'])
    await userEvent.selectOptions(picker, 'usb-yeti')
    expect(picker).toHaveValue('usb-yeti')
    await userEvent.selectOptions(picker, '')
    expect(mac.requests).toContainEqual({ type: 'set', key: 'microphone', value: 'usb-yeti' })
    expect(mac.requests).toContainEqual({ type: 'set', key: 'microphone', value: null })
  })

  it('says when the picked one is unplugged', async () => {
    show(new FakeMac({ ...defaultMacSettings(), microphoneChoice: 'gone' }))
    await ready()
    expect(screen.getByLabelText('Microphone for dictation')).toHaveValue('gone')
    expect(screen.getByText(/isn’t connected/)).toBeInTheDocument()
  })
})

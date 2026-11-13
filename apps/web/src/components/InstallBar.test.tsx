import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetInstallPrompt } from '../lib/install'
import { DESKTOP, firePrompt, IPHONE, PIXEL, pretend } from '../test/devices'
import { InstallBar } from './InstallBar'

// docs/PLAN-install-and-settings.md, I3–I5.

afterEach(() => {
  vi.restoreAllMocks()
  act(() => resetInstallPrompt())
})

describe('the install bar', () => {
  it('shows on a phone browser, and never on a computer or in the installed app', () => {
    pretend({ ua: PIXEL, touch: 5 })
    const { unmount } = render(<InstallBar />)
    expect(screen.getByTestId('install-bar')).toHaveTextContent('Install Hotsauce on your phone')
    unmount()

    pretend({ ua: DESKTOP })
    const desktop = render(<InstallBar />)
    expect(screen.queryByTestId('install-bar')).toBeNull()
    desktop.unmount()

    pretend({ ua: PIXEL, touch: 5, queries: ['(display-mode: standalone)'] })
    render(<InstallBar />)
    expect(screen.queryByTestId('install-bar')).toBeNull()
  })

  it('✕ hides it for good on this browser', async () => {
    pretend({ ua: PIXEL, touch: 5 })
    const { unmount } = render(<InstallBar />)
    await userEvent.click(screen.getByTestId('install-bar-dismiss'))
    expect(screen.queryByTestId('install-bar')).toBeNull()
    unmount()
    render(<InstallBar />)
    expect(screen.queryByTestId('install-bar')).toBeNull()
  })

  it('✕ still hides it when storage refuses', async () => {
    pretend({ ua: PIXEL, touch: 5 })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    render(<InstallBar />)
    await userEvent.click(screen.getByTestId('install-bar-dismiss'))
    expect(screen.queryByTestId('install-bar')).toBeNull()
  })

  it('Install shows the browser’s own dialog when there is one', async () => {
    pretend({ ua: PIXEL, touch: 5 })
    render(<InstallBar />)
    const event = firePrompt('dismissed')
    await userEvent.click(screen.getByTestId('install-bar-install'))
    expect(event.prompt).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('install-sheet')).toBeNull()
  })

  it('on iPhone, Install opens the Share then Add to Home Screen steps', async () => {
    pretend({ ua: IPHONE, touch: 5 })
    render(<InstallBar />)
    await userEvent.click(screen.getByTestId('install-bar-install'))
    const sheet = screen.getByTestId('install-sheet')
    expect(sheet).toHaveAttribute('data-platform', 'ios')
    const steps = within(sheet).getAllByRole('listitem')
    expect(steps[0]).toHaveTextContent('Share')
    expect(steps[1]).toHaveTextContent('Add to Home Screen')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('install-sheet')).toBeNull()
  })

  it('with no dialog and not iOS, the steps are the generic ones', async () => {
    pretend({ ua: PIXEL, touch: 5 })
    render(<InstallBar />)
    await userEvent.click(screen.getByTestId('install-bar-install'))
    const sheet = screen.getByTestId('install-sheet')
    expect(sheet).toHaveAttribute('data-platform', 'other')
    expect(sheet).toHaveTextContent('Install app or Add to Home Screen')
  })
})

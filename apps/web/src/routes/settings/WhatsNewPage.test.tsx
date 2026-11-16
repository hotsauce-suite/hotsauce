import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { RELEASES } from '../../lib/whatsNew'
import { renderApp } from '../../test/renderApp'

// docs/PLAN-mac-version-and-whats-new.md, N5.
describe('Settings → What’s new', () => {
  it('opens from the version under the menu and lists releases newest first', async () => {
    const user = userEvent.setup()
    renderApp('/settings')
    const strip = await screen.findByTestId('settings-help')
    expect(within(strip).getByTestId('settings-whats-new-link')).toHaveAttribute(
      'href',
      '/settings/whats-new',
    )
    await user.click(await within(strip).findByTestId('settings-version'))
    const page = await screen.findByTestId('settings-whats-new')
    expect(within(page).getByRole('heading', { name: 'What’s new' })).toBeInTheDocument()
    const releases = within(page).getAllByTestId('whats-new-release')
    expect(releases).toHaveLength(RELEASES.length)
    expect(releases[0]).toHaveTextContent(RELEASES[0]?.version ?? '')
    expect(within(page).getAllByTestId('whats-new-note').length).toBeGreaterThan(0)
  })

  it('marks Mac app changes, and the release this workspace runs', async () => {
    renderApp('/settings/whats-new')
    const page = await screen.findByTestId('settings-whats-new')
    const mac = within(page).getAllByTestId('whats-new-area')
    expect(mac.length).toBeGreaterThan(0)
    for (const tag of mac) expect(tag).toHaveTextContent('Mac app')
    // The test server says it runs 0.8.0, which has no notes: nothing is marked as this one.
    expect(await within(page).findByTestId('whats-new-running')).toHaveTextContent('0.8.0')
    expect(within(page).queryByTestId('whats-new-current')).toBeNull()
  })
})

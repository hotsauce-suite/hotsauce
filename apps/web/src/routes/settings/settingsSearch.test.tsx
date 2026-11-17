import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { serveOrg } from '../../test/orgSettings'
import { renderApp } from '../../test/renderApp'
import { forgetUnapplied } from '../OrgSettingsRoute'
import { findHeading } from './SettingsSearch'
import { SETTINGS_INDEX } from './searchIndex'

beforeEach(forgetUnapplied)

// docs/PLAN-settings-search.md S1, S4–S7.

const box = () => screen.findByTestId('settings-search-input')
const resultIds = () =>
  screen.getAllByTestId('settings-search-result').map((r) => r.getAttribute('data-setting'))

describe('Settings search', () => {
  it('sits above the menu and shows matching sections in place of the page', async () => {
    serveOrg({ admin: false })
    renderApp('/settings')
    const input = await box()
    const side = screen.getByTestId('settings-side')
    expect(side.contains(input)).toBe(true)
    expect(
      input.compareDocumentPosition(screen.getByTestId('settings-nav')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    await screen.findByTestId('settings-account')

    await userEvent.type(input, 'dark mode')
    expect(resultIds()).toEqual(['appearance'])
    expect(screen.getByTestId('settings-account')).not.toBeVisible()
    expect(screen.getByTestId('settings-search-count')).toHaveTextContent('1 setting')
  })

  it('opens the chosen section on its page, marked, and empties the box', async () => {
    serveOrg({ admin: false })
    const { router } = renderApp('/settings')
    const input = await box()
    await userEvent.type(input, 'claude code')
    await userEvent.click(screen.getByRole('button', { name: /Connect an AI tool/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/connections'))
    expect(input).toHaveValue('')
    expect(screen.queryByTestId('settings-search-results')).toBeNull()
    const section = await screen.findByTestId('settings-ai-tools')
    await waitFor(() => expect(section).toHaveAttribute('data-settings-found'))
    expect(section).toBeVisible()
  })

  it('opens the first result on Enter, and finds sections on the page already open', async () => {
    serveOrg({ admin: false })
    const { router } = renderApp('/settings')
    const input = await box()
    await screen.findByTestId('settings-account')
    await userEvent.type(input, 'keyboard{Enter}')
    expect(router.state.location.pathname).toBe('/settings')
    const keyboard = await screen.findByRole('region', { name: 'Keyboard' })
    await waitFor(() => expect(keyboard).toHaveAttribute('data-settings-found'))
  })

  it('says when nothing matches, and Escape brings the page back', async () => {
    serveOrg({ admin: false })
    renderApp('/settings')
    const input = await box()
    await screen.findByTestId('settings-account')
    await userEvent.type(input, 'backups')
    expect(screen.getByTestId('settings-search-count')).toHaveTextContent(
      'Nothing in Settings matches “backups”.',
    )
    expect(screen.queryAllByTestId('settings-search-result')).toHaveLength(0)
    await userEvent.keyboard('{Escape}')
    expect(input).toHaveValue('')
    expect(screen.getByTestId('settings-account')).toBeVisible()
  })

  it('moves through results with the arrow keys', async () => {
    serveOrg({ admin: false })
    renderApp('/settings')
    const input = await box()
    await userEvent.type(input, 'install')
    const rows = screen.getAllByTestId('settings-search-result')
    expect(rows.length).toBeGreaterThan(1)
    await userEvent.keyboard('{ArrowDown}')
    expect(rows[0]).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(rows[1]).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}{ArrowUp}')
    expect(input).toHaveFocus()
  })

  it('puts the cursor in the box when / is pressed', async () => {
    serveOrg({ admin: false })
    renderApp('/settings')
    const input = await box()
    await screen.findByTestId('settings-account')
    await userEvent.click(document.body)
    await userEvent.keyboard('/')
    expect(input).toHaveFocus()
  })

  it('gives admins the organization’s sections too, and opens them', async () => {
    serveOrg({ admin: true })
    const { router } = renderApp('/settings')
    const input = await box()
    await userEvent.type(input, 'backup')
    expect(resultIds()[0]).toBe('org-backups')
    expect(screen.getAllByTestId('settings-search-result')[0]).toHaveTextContent(
      'Organization · Data and updates',
    )
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/organization/data'))
    const backups = await screen.findByTestId('org-backups')
    await waitFor(() => expect(backups).toHaveAttribute('data-settings-found'))
  })
})

describe('the list of settings matches the pages', () => {
  const pages = [...new Set(SETTINGS_INDEX.filter((e) => !e.macOnly).map((e) => e.to))]
  it.each(pages)('every section listed for %s is on it', async (to) => {
    serveOrg({ admin: true })
    renderApp(to)
    const page = await screen.findByTestId('settings-page')
    for (const entry of SETTINGS_INDEX.filter((e) => e.to === to)) {
      await waitFor(() => expect(findHeading(page, entry.title), entry.title).not.toBeNull())
    }
  })
})

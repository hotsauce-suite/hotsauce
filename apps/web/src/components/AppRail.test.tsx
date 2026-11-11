import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { meetingsApi } from '../api/meetings'
import { AudioRing } from '../apps/meetings/audio/ring-buffer'
import { beginLive, currentLive } from '../apps/meetings/live/controller'
import { APPS, railLinks } from '../apps/registry'
import { MOBILE_QUERY } from '../hooks/useMediaQuery'
import { renderApp } from '../test/renderApp'
import { initials } from './AppRail'

afterEach(async () => {
  await currentLive()?.dispose()
  vi.restoreAllMocks()
})

describe('the app rail', () => {
  it('has one item per app, then Acme Chat, Settings and the account', async () => {
    renderApp('/docs')
    const rail = await screen.findByTestId('app-rail')
    for (const app of APPS) {
      const item = within(rail).getByTestId(`app-switch-${app.id}`)
      expect(item).toHaveTextContent(app.label)
      expect(item).toHaveAttribute('aria-label', app.name)
    }
    expect(within(rail).getByTestId('app-switch-docs')).toHaveAttribute('aria-current', 'page')
    expect(within(rail).getByTestId('app-switch-meetings')).not.toHaveAttribute('aria-current')

    const chat = within(rail).getByTestId('app-link-chat')
    expect(chat).toHaveAttribute('href', 'https://chat.example.test')
    expect(chat).toHaveAttribute('target', '_blank')
    expect(chat).toHaveAttribute('rel', 'noopener noreferrer')
    expect(chat).toHaveAccessibleName('Acme Chat (opens in a new tab)')

    expect(within(rail).getByTestId('settings-link')).toHaveAttribute('href', '/settings')
    expect(within(rail).getByTestId('account-menu')).toBeInTheDocument()
    // The old sidebar footer is gone: the sidebar has no sign out or settings of its own.
    expect(within(screen.getByTestId('sidebar')).queryByText('Sign out')).toBeNull()
    expect(screen.getByTestId('sidebar-app-name')).toHaveTextContent('Hotsauce Docs')
  })

  it('marks Settings, and no app, on the Settings page; Docs then returns to its last doc', async () => {
    const { router } = renderApp('/docs/team/docs/welcome.md')
    expect(await screen.findByTestId('editor')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('settings-link'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
    expect(screen.getByTestId('settings-link')).toHaveAttribute('aria-current', 'page')
    for (const app of APPS) {
      expect(screen.getByTestId(`app-switch-${app.id}`)).not.toHaveAttribute('aria-current')
    }
    // Leaving Settings for Meetings and back to Docs lands on the doc, not on Settings.
    await userEvent.click(screen.getByTestId('app-switch-meetings'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/meetings'))
    expect(screen.getByTestId('app-switch-docs')).toHaveAttribute(
      'href',
      '/docs/team/docs/welcome.md',
    )
  })

  it('opens the account menu with the email, and signs out after forgetting reminders', async () => {
    const signOut = vi.fn()
    renderApp('/docs', { signOut })
    const button = await screen.findByTestId('account-menu')
    await waitFor(() => expect(button).toHaveTextContent(/^[A-Z?]{1,2}$/))
    await userEvent.click(button)
    const menu = screen.getByRole('menu', { name: 'Account' })
    expect(within(menu).getByTestId('account-email')).toHaveTextContent('morgan@example.test')
    await userEvent.click(within(menu).getByTestId('sign-out'))
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1))
  })

  it('puts a dot on Meetings while a meeting is recording', async () => {
    renderApp('/docs')
    const meetings = await screen.findByTestId('app-switch-meetings')
    expect(within(meetings).queryByTestId('rail-recording')).toBeNull()

    const session = await meetingsApi.createSession({ title: 'Acme sync' })
    beginLive(session, { ring: new AudioRing({ factory: null }) })
    expect(await within(meetings).findByTestId('rail-recording')).toBeInTheDocument()
    expect(meetings).toHaveAccessibleName('Hotsauce Meetings (recording)')

    await currentLive()?.dispose()
    await waitFor(() => expect(within(meetings).queryByTestId('rail-recording')).toBeNull())
  })

  it('is a tab bar along the bottom on a phone, with the sidebar in the drawer', async () => {
    const real = window.matchMedia
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      ...real(query),
      matches: query === MOBILE_QUERY,
    }))
    const { router } = renderApp('/meetings')
    const rail = await screen.findByTestId('app-rail')
    expect(rail.className).toContain('shell-tabbar')
    expect(within(rail).getByTestId('app-switch-meetings')).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByTestId('sidebar')).toBeNull()
    // Settings sits in the account menu on a phone.
    expect(within(rail).queryByTestId('settings-link')).toBeNull()
    await userEvent.click(within(rail).getByTestId('account-menu'))
    await userEvent.click(screen.getByTestId('settings-link'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
    expect(within(rail).getByTestId('account-menu')).toHaveClass('text-ember')
  })

  it('lists every app and link for Cmd-K, and jumps to an app', async () => {
    const { router } = renderApp('/docs')
    await screen.findByTestId('app-rail')
    await userEvent.keyboard('{Control>}k{/Control}')
    const palette = await screen.findByTestId('cmdk')
    for (const app of APPS) {
      expect(within(palette).getByTestId(`cmdk-app-${app.id}`)).toHaveTextContent(
        `Go to ${app.name}`,
      )
    }
    for (const link of railLinks()) {
      expect(within(palette).getByTestId(`cmdk-app-${link.id}`)).toHaveTextContent(
        'Opens in a new tab',
      )
    }

    await userEvent.type(screen.getByTestId('cmdk-input'), 'go to meet')
    await waitFor(() => expect(within(palette).queryByTestId('cmdk-app-docs')).toBeNull())
    await userEvent.click(within(palette).getByTestId('cmdk-app-meetings'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/meetings'))
  })

  it('keeps doc results ahead of app jumps, so Enter opens the doc', async () => {
    renderApp('/docs')
    await screen.findByTestId('app-rail')
    await userEvent.keyboard('{Control>}k{/Control}')
    // "d" is in the title "Reading list" and starts "Docs" and "Dictate".
    await userEvent.type(await screen.findByTestId('cmdk-input'), 'd')
    const palette = screen.getByTestId('cmdk')
    await within(palette).findByTestId('cmdk-app-docs')
    await within(palette).findAllByTestId('search-result')
    const items = [...palette.querySelectorAll('[cmdk-item]')]
    expect(items[0]).toHaveAttribute('data-testid', 'search-result')
    expect(items[0]).toHaveAttribute('aria-selected', 'true')
    // Words match from their start: "e" opens no app.
    await userEvent.clear(screen.getByTestId('cmdk-input'))
    await userEvent.type(screen.getByTestId('cmdk-input'), 'e')
    await waitFor(() => expect(within(palette).queryByTestId('cmdk-app-meetings')).toBeNull())
  })

  it('toggles the account menu from its button and returns focus to it', async () => {
    renderApp('/docs')
    const button = await screen.findByTestId('account-menu')
    await userEvent.click(button)
    expect(screen.getByRole('menu', { name: 'Account' })).toBeInTheDocument()
    await userEvent.click(button)
    expect(screen.queryByRole('menu', { name: 'Account' })).toBeNull()
    expect(button).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(button)
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu', { name: 'Account' })).toBeNull()
    expect(button).toHaveFocus()
  })

  it('opens Acme Chat from Cmd-K in a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderApp('/docs')
    await screen.findByTestId('app-rail')
    await userEvent.keyboard('{Control>}k{/Control}')
    await userEvent.type(await screen.findByTestId('cmdk-input'), 'chat')
    await userEvent.click(await screen.findByTestId('cmdk-app-chat'))
    expect(open).toHaveBeenCalledWith('https://chat.example.test', '_blank', 'noopener,noreferrer')
  })
})

describe('initials', () => {
  it('takes the first and last names, else the email', () => {
    expect(initials('Morgan Holland', 'm@x.com')).toBe('MH')
    expect(initials('Cher', 'c@x.com')).toBe('C')
    expect(initials('Ana María de la Cruz', undefined)).toBe('AC')
    expect(initials('', 'priya@x.com')).toBe('P')
    expect(initials(undefined, undefined)).toBe('?')
  })
})

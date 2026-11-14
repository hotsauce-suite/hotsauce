import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import { meetingsApi } from '../api/meetings'
import { AudioRing } from '../apps/meetings/audio/ring-buffer'
import { beginLive, currentLive } from '../apps/meetings/live/controller'
import { DEFAULT_PINS, MAX_PINS } from '../apps/pins'
import { APPS, railLinks } from '../apps/registry'
import { MOBILE_QUERY } from '../hooks/useMediaQuery'
import { renderApp } from '../test/renderApp'
import { initials } from './AppRail'

afterEach(async () => {
  await currentLive()?.dispose()
  vi.restoreAllMocks()
})

/** Renders as a phone: the shell's mobile query matches. */
function phone() {
  const real = window.matchMedia
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    ...real(query),
    matches: query === MOBILE_QUERY,
  }))
}

describe('the app rail', () => {
  it('shows the default pins, then the launcher, Settings and the account', async () => {
    renderApp('/docs')
    const rail = await screen.findByTestId('app-rail')
    const list = within(rail).getByTestId('rail-apps')
    const ids = [...list.querySelectorAll('[data-testid]')].map((el) =>
      el.getAttribute('data-testid'),
    )
    expect(DEFAULT_PINS).toEqual(['today', 'docs', 'tasks', 'meetings', 'chat'])
    expect(ids).toEqual([
      'app-switch-today',
      'app-switch-docs',
      'app-switch-tasks',
      'app-switch-meetings',
      'app-link-chat',
    ])
    for (const app of APPS.filter((a) => ['today', 'docs', 'tasks', 'meetings'].includes(a.id))) {
      const item = within(rail).getByTestId(`app-switch-${app.id}`)
      expect(item).toHaveTextContent(app.label)
      expect(item).toHaveAttribute('aria-label', app.name)
    }
    expect(within(rail).queryByTestId('app-switch-dictate')).toBeNull()
    expect(within(rail).getByTestId('launcher-button')).toHaveAccessibleName('All apps')
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
    // The editor and the Settings page load lazily; under a full parallel run that can take
    // longer than the default second.
    const slow = { timeout: 5_000 }
    expect(await screen.findByTestId('editor', {}, slow)).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('settings-link'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'), slow)
    // The router's state changes before React renders the new location: wait for the render.
    await waitFor(
      () => expect(screen.getByTestId('settings-link')).toHaveAttribute('aria-current', 'page'),
      slow,
    )
    expect(
      within(screen.getByTestId('rail-apps')).queryAllByRole('link', { current: 'page' }),
    ).toEqual([])
    // Leaving Settings for Meetings and back to Docs lands on the doc, not on Settings.
    await userEvent.click(screen.getByTestId('app-switch-meetings'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/meetings'), slow)
    await waitFor(
      () =>
        expect(screen.getByTestId('app-switch-docs')).toHaveAttribute(
          'href',
          '/docs/team/docs/welcome.md',
        ),
      slow,
    )
  }, 20_000)

  it('opens the account menu with the email and Settings, and no Sign out', async () => {
    const { router } = renderApp('/docs')
    const button = await screen.findByTestId('account-menu')
    await waitFor(() => expect(button).toHaveTextContent(/^[A-Z?]{1,2}$/))
    await userEvent.click(button)
    const menu = screen.getByRole('menu', { name: 'Account' })
    expect(within(menu).getByTestId('account-email')).toHaveTextContent('ada@example.test')
    // Sign out lives in Settings only (docs/PLAN-install-and-settings.md, M2).
    expect(within(menu).queryByTestId('sign-out')).toBeNull()
    await userEvent.click(within(menu).getByTestId('menu-settings'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
  })

  it('shows the open app below the pins when it is not pinned', async () => {
    const { router } = renderApp('/briefcast')
    const rail = await screen.findByTestId('app-rail')
    const briefcast = await within(rail).findByTestId('app-switch-briefcast')
    expect(briefcast).toHaveAttribute('aria-current', 'page')
    await router.navigate('/docs')
    await waitFor(() => expect(within(rail).queryByTestId('app-switch-briefcast')).toBeNull())
  })

  it("shows the member's saved pins, in their order", async () => {
    await api.setPins(['notes', 'today', 'not-an-app'])
    renderApp('/docs')
    const list = await screen.findByTestId('rail-apps')
    await waitFor(() => expect(within(list).queryByTestId('app-switch-tasks')).toBeNull())
    const ids = [...list.querySelectorAll('a')].map((el) => el.getAttribute('data-testid'))
    // Docs is open but unpinned: it shows below the pins.
    expect(ids).toEqual(['app-switch-notes', 'app-switch-today', 'app-switch-docs'])
  })

  it('opens every app from the launcher, and edits the pins with the pencil', async () => {
    const { router } = renderApp('/docs')
    const rail = await screen.findByTestId('app-rail')
    const button = within(rail).getByTestId('launcher-button')
    await userEvent.click(button)
    const launcher = screen.getByRole('dialog', { name: 'All apps' })
    expect(button).toHaveAttribute('aria-expanded', 'true')
    for (const app of APPS) {
      expect(within(launcher).getByTestId(`launcher-app-${app.id}`)).toHaveTextContent(app.label)
    }
    expect(within(launcher).getByTestId('launcher-app-docs')).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(launcher).getByTestId('launcher-app-chat')).toHaveAttribute('target', '_blank')

    // Edit: unpin Tasks, pin Briefcast; the rail and the server follow.
    await userEvent.click(within(launcher).getByTestId('launcher-edit'))
    expect(within(launcher).getByTestId('launcher-edit')).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(within(launcher).getByTestId('launcher-unpin-tasks'))
    await userEvent.click(within(launcher).getByTestId('launcher-toggle-briefcast'))
    expect(within(launcher).getByTestId('launcher-toggle-briefcast')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await waitFor(() =>
      expect(within(rail).getByTestId('app-switch-briefcast')).toBeInTheDocument(),
    )
    expect(within(rail).queryByTestId('app-switch-tasks')).toBeNull()
    await waitFor(async () =>
      expect((await api.pins()).pins).toEqual(['today', 'docs', 'meetings', 'chat', 'briefcast']),
    )

    // Alt+arrow moves a pinned app earlier.
    within(launcher).getByTestId('launcher-unpin-briefcast').focus()
    await userEvent.keyboard('{Alt>}{ArrowLeft}{/Alt}')
    await waitFor(async () =>
      expect((await api.pins()).pins).toEqual(['today', 'docs', 'meetings', 'briefcast', 'chat']),
    )

    // Six at most: the rest can't be added until one is unpinned.
    await userEvent.click(within(launcher).getByTestId('launcher-toggle-notes'))
    expect(MAX_PINS).toBe(6)
    expect(within(launcher).getByTestId('launcher-toggle-files')).toBeDisabled()
    expect(within(launcher).getByTestId('launcher-toggle-notes')).toBeEnabled()

    // Done, then an app opens from the launcher, which closes.
    await userEvent.click(within(launcher).getByTestId('launcher-edit'))
    await userEvent.click(screen.getByTestId('launcher-app-files'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/files'))
    await waitFor(() => expect(screen.queryByTestId('launcher')).toBeNull())

    // Escape closes it and hands focus back to the grid button.
    await userEvent.click(button)
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('launcher')).toBeNull())
    expect(button).toHaveFocus()
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

  it('is a tab bar of four apps and Apps on a phone, with the sidebar in the drawer', async () => {
    phone()
    const { router } = renderApp('/meetings')
    const rail = await screen.findByTestId('app-rail')
    expect(rail.className).toContain('shell-tabbar')
    const pinned = APPS.filter((app) => app.onPhoneBar === true).map((app) => app.id)
    expect(pinned).toEqual(['today', 'docs', 'meetings', 'tasks'])
    for (const app of APPS) {
      const item = within(rail).queryByTestId(`app-switch-${app.id}`)
      if (pinned.includes(app.id)) expect(item).toBeInTheDocument()
      else expect(item).toBeNull()
    }
    expect(within(rail).getByTestId('app-switch-meetings')).toHaveAttribute('aria-current', 'page')
    expect(within(rail).getByTestId('apps-menu')).not.toHaveClass('text-ember')
    expect(screen.queryByTestId('sidebar')).toBeNull()
    // Settings, Chat and the account live in the Apps sheet on a phone.
    expect(within(rail).queryByTestId('settings-link')).toBeNull()
    expect(within(rail).queryByTestId('app-link-chat')).toBeNull()
    expect(within(rail).queryByTestId('account-menu')).toBeNull()
    await userEvent.click(within(rail).getByTestId('apps-menu'))
    await userEvent.click(within(screen.getByTestId('apps-sheet')).getByTestId('settings-link'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
    await waitFor(() => expect(screen.queryByTestId('apps-sheet')).toBeNull())
    await waitFor(() => expect(within(rail).getByTestId('apps-menu')).toHaveClass('text-ember'))
  })

  it('opens every app, Chat and the account from the Apps sheet on a phone', async () => {
    phone()
    const { router } = renderApp('/docs')
    const button = await screen.findByTestId('apps-menu')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    const sheet = screen.getByRole('dialog', { name: 'All apps' })
    for (const app of APPS) {
      expect(within(sheet).getByTestId(`apps-sheet-${app.id}`)).toHaveTextContent(app.label)
    }
    expect(within(sheet).getByTestId('apps-sheet-docs')).toHaveAttribute('aria-current', 'page')
    const chat = within(sheet).getByTestId('apps-sheet-link-chat')
    expect(chat).toHaveAttribute('href', 'https://chat.example.test')
    expect(chat).toHaveAttribute('target', '_blank')
    expect(chat).toHaveAccessibleName('Acme Chat (opens in a new tab)')
    await waitFor(() =>
      expect(within(sheet).getByTestId('account-email')).toHaveTextContent('ada@example.test'),
    )

    // An app off the bar opens from the sheet, which closes, and Apps becomes the current tab.
    await userEvent.click(within(sheet).getByTestId('apps-sheet-briefcast'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/briefcast'))
    await waitFor(() => expect(screen.queryByTestId('apps-sheet')).toBeNull())
    await waitFor(() => expect(button).toHaveClass('text-ember'))

    // Escape closes it and hands focus back. Sign out isn't here: it's in Settings (M1).
    await userEvent.click(button)
    expect(screen.queryByTestId('sign-out')).toBeNull()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('apps-sheet')).toBeNull())
    expect(button).toHaveFocus()
  })

  it('keeps your place when the open app is tapped in the sheet, and shows a recording', async () => {
    phone()
    const { router } = renderApp('/briefcast')
    const button = await screen.findByTestId('apps-menu')
    expect(button).toHaveAttribute('aria-current', 'page')
    await router.navigate('/tasks?view=today')
    await waitFor(() => expect(button).not.toHaveAttribute('aria-current'))
    const session = await meetingsApi.createSession({ title: 'Acme sync' })
    beginLive(session, { ring: new AudioRing({ factory: null }) })
    await userEvent.click(button)
    const sheet = screen.getByTestId('apps-sheet')
    await waitFor(() =>
      expect(within(sheet).getByTestId('apps-sheet-meetings')).toHaveAccessibleName(
        'Hotsauce Meetings (recording)',
      ),
    )
    await userEvent.click(within(sheet).getByTestId('apps-sheet-tasks'))
    await waitFor(() => expect(screen.queryByTestId('apps-sheet')).toBeNull())
    expect(router.state.location.pathname + router.state.location.search).toBe('/tasks?view=today')
    expect(button).toHaveFocus()
  })

  it('closes the Apps sheet when its handle is dragged down', async () => {
    phone()
    renderApp('/docs')
    await userEvent.click(await screen.findByTestId('apps-menu'))
    const handle = screen.getByTestId('apps-sheet-handle')
    handle.setPointerCapture = () => {}
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 130 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 130 })
    // A short drag springs back.
    expect(screen.getByTestId('apps-sheet')).toBeInTheDocument()
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 200 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 200 })
    await waitFor(() => expect(screen.queryByTestId('apps-sheet')).toBeNull())
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
    // The pinned apps come first, in rail order.
    const first = [...palette.querySelectorAll('[data-testid^="cmdk-app-"]')]
      .slice(0, 5)
      .map((el) => el.getAttribute('data-testid'))
    expect(first).toEqual(DEFAULT_PINS.map((id) => `cmdk-app-${id}`))

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
    expect(initials('Ada Lovelace', 'm@x.com')).toBe('AL')
    expect(initials('Cher', 'c@x.com')).toBe('C')
    expect(initials('Ana María de la Cruz', undefined)).toBe('AC')
    expect(initials('', 'priya@x.com')).toBe('P')
    expect(initials(undefined, undefined)).toBe('?')
  })
})

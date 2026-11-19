import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import { meetingsApi } from '../api/meetings'
import { AudioRing } from '../apps/meetings/audio/ring-buffer'
import { beginLive, currentLive } from '../apps/meetings/live/controller'
import { DEFAULT_PHONE_PINS, DEFAULT_PINS, savePhonePins } from '../apps/pins'
import { APPS, railLinks } from '../apps/registry'
import { MOBILE_QUERY } from '../hooks/useMediaQuery'
import { HELP_DOCS } from '../lib/helpLinks'
import { storedTheme } from '../lib/theme'
import { TIP_DELAY_MS } from '../rail/RailTip'
import { RAIL_KEY } from '../rail/railWide'
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
  it('shows the default pins, then the launcher and the account', async () => {
    const phoneList = vi.spyOn(api, 'phonePins')
    renderApp('/docs')
    const rail = await screen.findByTestId('app-rail')
    const list = within(rail).getByTestId('rail-apps')
    const ids = [...list.querySelectorAll('[data-testid^="app-"]')].map((el) =>
      el.getAttribute('data-testid'),
    )
    // For you sits right under Today (comments plan R13).
    expect(DEFAULT_PINS).toEqual(['today', 'for-you', 'docs', 'tasks', 'meetings', 'chat'])
    expect(ids).toEqual([
      'app-switch-today',
      'app-switch-for-you',
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
    // The desktop rail never asks for the phone bar's list (phone bar R9).
    expect(phoneList).not.toHaveBeenCalled()
    expect(within(rail).getByTestId('launcher-button')).toHaveAccessibleName('All apps')
    expect(within(rail).getByTestId('app-switch-docs')).toHaveAttribute('aria-current', 'page')
    expect(within(rail).getByTestId('app-switch-meetings')).not.toHaveAttribute('aria-current')

    const chat = within(rail).getByTestId('app-link-chat')
    expect(chat).toHaveAttribute('href', 'https://chat.example.test')
    expect(chat).toHaveAttribute('target', '_blank')
    expect(chat).toHaveAttribute('rel', 'noopener noreferrer')
    expect(chat).toHaveAccessibleName('Acme Chat (opens in a new tab)')

    // Settings, music and feedback live in the account menu, not on the rail (rail plan R4).
    for (const gone of ['settings-link', 'music-button', 'feedback-link']) {
      expect(within(rail).queryByTestId(gone)).toBeNull()
    }
    expect(within(rail).getByTestId('account-menu')).toBeInTheDocument()
    // The old sidebar footer is gone: the sidebar has no sign out or settings of its own.
    expect(within(screen.getByTestId('sidebar')).queryByText('Sign out')).toBeNull()
    expect(screen.getByTestId('sidebar-app-name')).toHaveTextContent('Docs')
  })

  it('marks the account button, and no app, on the Settings page; Docs then returns to its last doc', async () => {
    const { router } = renderApp('/docs/team/docs/welcome.md')
    // The editor and the Settings page load lazily; under a full parallel run that can take
    // longer than the default second.
    const slow = { timeout: 5_000 }
    expect(await screen.findByTestId('editor', {}, slow)).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('account-menu'))
    await userEvent.click(screen.getByTestId('menu-settings'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'), slow)
    // The router's state changes before React renders the new location: wait for the render.
    await waitFor(
      () => expect(screen.getByTestId('account-menu')).toHaveAttribute('data-current'),
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
      expect((await api.pins()).pins).toEqual([
        'today',
        'for-you',
        'docs',
        'meetings',
        'chat',
        'briefcast',
      ]),
    )

    // Alt+arrow moves a pinned app earlier.
    within(launcher).getByTestId('launcher-unpin-briefcast').focus()
    await userEvent.keyboard('{Alt>}{ArrowLeft}{/Alt}')
    await waitFor(async () =>
      expect((await api.pins()).pins).toEqual([
        'today',
        'for-you',
        'docs',
        'meetings',
        'briefcast',
        'chat',
      ]),
    )

    // No cap: every app and link can be pinned, and the rail shows them all in pin order.
    const every = [...APPS.map((app) => app.id), ...railLinks().map((link) => link.id)]
    for (const id of every) {
      const toggle = within(launcher).getByTestId(`launcher-toggle-${id}`)
      expect(toggle).toBeEnabled()
      if (toggle.getAttribute('aria-pressed') !== 'true') await userEvent.click(toggle)
    }
    await waitFor(async () => expect((await api.pins()).pins).toHaveLength(every.length))
    const railIds = [...within(rail).getByTestId('rail-apps').querySelectorAll('a')].map((el) =>
      el.getAttribute('data-testid')?.replace(/^app-(switch|link)-/, ''),
    )
    expect(railIds).toEqual((await api.pins()).pins)
    expect(railIds.length).toBeGreaterThan(6)
    // Files goes back off, so it opens from the "All apps" list below.
    await userEvent.click(within(launcher).getByTestId('launcher-unpin-files'))
    await waitFor(async () => expect((await api.pins()).pins).not.toContain('files'))
    expect(within(launcher).getByTestId('launcher-toggle-files')).toHaveAttribute(
      'aria-pressed',
      'false',
    )

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

  it('drags a pinned app into a new place, and closes on a click outside', async () => {
    renderApp('/docs')
    const button = await screen.findByTestId('launcher-button')
    await userEvent.click(button)
    await userEvent.click(screen.getByTestId('launcher-edit'))
    const today = screen.getByTestId('launcher-pinned-today')
    const tasks = screen.getByTestId('launcher-pinned-tasks')
    // jsdom has no hit testing: the pointer is "over" Tasks.
    const point = vi.fn(() => tasks)
    document.elementFromPoint = point
    fireEvent.pointerDown(today, { pointerId: 1, button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(today, { pointerId: 1, clientX: 12, clientY: 11 })
    // Under five pixels it's still a click: nothing moves.
    expect(point).not.toHaveBeenCalled()
    fireEvent.pointerMove(today, { pointerId: 1, clientX: 120, clientY: 10 })
    fireEvent.pointerUp(today, { pointerId: 1, clientX: 120, clientY: 10 })
    await waitFor(async () =>
      expect((await api.pins()).pins).toEqual([
        'for-you',
        'docs',
        'tasks',
        'today',
        'meetings',
        'chat',
      ]),
    )
    Reflect.deleteProperty(document, 'elementFromPoint')

    fireEvent.pointerDown(document.getElementById('main') as HTMLElement)
    await waitFor(() => expect(screen.queryByTestId('launcher')).toBeNull())
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
    expect(DEFAULT_PHONE_PINS).toEqual(['today', 'docs', 'tasks', 'meetings'])
    const tabs = [
      ...rail.querySelectorAll('[data-testid^="app-switch-"], [data-testid="apps-menu"]'),
    ]
    expect(tabs.map((el) => el.getAttribute('data-testid'))).toEqual([
      'app-switch-today',
      'app-switch-docs',
      'app-switch-tasks',
      'app-switch-meetings',
      'apps-menu',
    ])
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

  it("shows the member's chosen apps on the phone bar, in order, links too (phone bar R2)", async () => {
    await api.setPhonePins(['tasks', 'chat', 'gone', 'for-you'])
    phone()
    const { router } = renderApp('/docs')
    const rail = await screen.findByTestId('app-rail')
    await waitFor(() =>
      expect(
        [...rail.querySelectorAll('a, button')].map((el) => el.getAttribute('data-testid')),
      ).toEqual(['app-switch-tasks', 'app-link-chat', 'app-switch-for-you', 'apps-menu']),
    )
    // Docs is off the bar, so Apps is the current tab; the rail's own pins are untouched.
    expect(within(rail).getByTestId('apps-menu')).toHaveAttribute('aria-current', 'page')
    expect((await api.pins()).pins).toBeNull()
    await userEvent.click(within(rail).getByTestId('app-switch-tasks'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'))
    await waitFor(() =>
      expect(within(rail).getByTestId('apps-menu')).not.toHaveAttribute('aria-current'),
    )
  })

  it('puts the For you count where it can be seen on a phone (phone bar R8)', async () => {
    phone()
    renderApp('/docs')
    const rail = await screen.findByTestId('app-rail')
    // The default bar has Today, not For you: Today carries it.
    await waitFor(() =>
      expect(within(rail).getByTestId('app-switch-today')).toHaveAccessibleName(
        'Hotsauce Today, 2 new',
      ),
    )
    await act(() => savePhonePins(['for-you', 'today']))
    await waitFor(() =>
      expect(within(rail).getByTestId('app-switch-for-you')).toHaveAccessibleName('For you, 2 new'),
    )
    expect(within(rail).getByTestId('app-switch-today')).toHaveAccessibleName('Hotsauce Today')
    // With neither on the bar, Apps gets a dot.
    await act(() => savePhonePins(['docs']))
    await waitFor(() =>
      expect(within(rail).getByTestId('apps-menu')).toHaveAccessibleName('All apps (2 new)'),
    )
    expect(within(rail).getByTestId('apps-waiting')).toBeInTheDocument()
    // The sheet's For you tile says where they are.
    await userEvent.click(within(rail).getByTestId('apps-menu'))
    expect(screen.getByTestId('apps-sheet-for-you')).toHaveAccessibleName('For you, 2 new')
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
      .slice(0, DEFAULT_PINS.length)
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

// docs/PLAN-rail-account-menu.md
describe('the wide rail (R1 to R3)', () => {
  it('R1, R2: the logo widens the rail to icon beside name, and the choice is kept', async () => {
    renderApp('/docs')
    const rail = await screen.findByTestId('app-rail')
    const toggle = within(rail).getByTestId('rail-toggle')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(rail).not.toHaveAttribute('data-wide')
    expect(within(rail).getByTestId('launcher-button')).not.toHaveTextContent('All apps')

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(rail).toHaveAttribute('data-wide')
    expect(document.documentElement).toHaveAttribute('data-rail', 'wide')
    expect(localStorage.getItem(RAIL_KEY)).toBe('wide')
    // Names beside the icons: the launcher and the account say theirs too.
    expect(within(rail).getByTestId('launcher-button')).toHaveTextContent('All apps')
    expect(within(rail).getByTestId('app-switch-docs')).toHaveTextContent('Docs')
    expect(within(rail).getByTestId('account-menu')).toHaveTextContent(/\S/)

    // The next visit opens wide.
    cleanup()
    renderApp('/tasks')
    const again = await screen.findByTestId('app-rail')
    expect(again).toHaveAttribute('data-wide')

    await userEvent.click(within(again).getByTestId('rail-toggle'))
    expect(again).not.toHaveAttribute('data-wide')
    expect(document.documentElement).not.toHaveAttribute('data-rail')
    expect(localStorage.getItem(RAIL_KEY)).toBeNull()
  })

  it('R3: resting on an entry shows what the tool is, and leaving hides it', async () => {
    renderApp('/docs')
    const rail = await screen.findByTestId('app-rail')
    const tasks = within(rail).getByTestId('app-switch-tasks')
    // No native tooltip to double up with ours.
    expect(tasks).not.toHaveAttribute('title')
    fireEvent.pointerEnter(tasks, { pointerType: 'mouse' })
    // Not at once: only after a pause.
    expect(screen.queryByTestId('rail-tip')).toBeNull()
    const tip = await screen.findByTestId('rail-tip', {}, { timeout: 2_000 })
    const about = APPS.find((app) => app.id === 'tasks')?.about ?? ''
    expect(about).not.toBe('')
    expect(tip).toHaveTextContent(about)
    expect(tip).toHaveAttribute('role', 'tooltip')
    expect(tasks).toHaveAttribute('aria-describedby', tip.id)
    fireEvent.pointerLeave(tasks)
    expect(screen.queryByTestId('rail-tip')).toBeNull()

    // A touch never shows one.
    fireEvent.pointerEnter(tasks, { pointerType: 'touch' })
    await new Promise((resolve) => setTimeout(resolve, TIP_DELAY_MS + 100))
    expect(screen.queryByTestId('rail-tip')).toBeNull()
  })

  it('every app says what it is for', () => {
    for (const app of APPS) expect(app.about, app.id).toMatch(/^[A-Z].{10,70}\.$/)
  })
})

describe('the account menu (R6 to R10)', () => {
  it('R7: switches between light, dark and the system at once', async () => {
    renderApp('/docs')
    await userEvent.click(await screen.findByTestId('account-menu'))
    const menu = screen.getByRole('menu', { name: 'Account' })
    expect(within(menu).getByTestId('account-email')).toHaveTextContent(/@/)
    expect(within(menu).getByTestId('menu-theme-system')).toHaveAttribute('aria-checked', 'true')

    await userEvent.click(within(menu).getByTestId('menu-theme-dark'))
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(storedTheme()).toBe('dark')
    expect(within(menu).getByTestId('menu-theme-dark')).toHaveAttribute('aria-checked', 'true')
    // The menu stays open, so the change shows behind it.
    await userEvent.click(within(menu).getByTestId('menu-theme-light'))
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    await userEvent.click(within(menu).getByTestId('menu-theme-system'))
    expect(document.documentElement).not.toHaveAttribute('data-theme')
    expect(storedTheme()).toBe('system')
    // Follow the sun (docs/PLAN-today-sky.md R9): light or dark by the sun.
    await userEvent.click(within(menu).getByTestId('menu-theme-sun'))
    expect(storedTheme()).toBe('sun')
    expect(document.documentElement.getAttribute('data-theme')).toMatch(/^(light|dark)$/)
    await userEvent.click(within(menu).getByTestId('menu-theme-system'))
  })

  it('R7: the menu opens on the theme switch, and Appearance in Settings follows it', async () => {
    renderApp('/settings')
    await userEvent.click(await screen.findByTestId('account-menu'))
    expect(screen.getByTestId('menu-theme-light')).toHaveFocus()
    await userEvent.click(screen.getByTestId('menu-theme-more'))
    const dark = await screen.findByTestId('theme-dark')
    expect(dark).not.toBeChecked()
    await userEvent.click(screen.getByTestId('account-menu'))
    await userEvent.click(screen.getByTestId('menu-theme-dark'))
    await waitFor(() => expect(dark).toBeChecked())
  })

  it('R7: More themes opens Appearance in Settings', async () => {
    const { router } = renderApp('/docs')
    await userEvent.click(await screen.findByTestId('account-menu'))
    await userEvent.click(screen.getByTestId('menu-theme-more'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/appearance'))
    expect(screen.queryByRole('menu', { name: 'Account' })).toBeNull()
  })

  it('R9: opens the keyboard shortcuts, and links to help', async () => {
    renderApp('/docs')
    await userEvent.click(await screen.findByTestId('account-menu'))
    const help = screen.getByTestId('menu-help')
    expect(help).toHaveAttribute('href', HELP_DOCS)
    expect(help).toHaveAttribute('target', '_blank')
    await userEvent.click(screen.getByTestId('menu-shortcuts'))
    expect(await screen.findByRole('dialog', { name: /shortcuts/i })).toBeInTheDocument()
    expect(screen.queryByRole('menu', { name: 'Account' })).toBeNull()
  })

  it('R10: shows the version, which opens What’s new; the Mac app adds its own', async () => {
    Object.assign(window, { hotsauceMacApp: { version: '0.51.0', build: '131' } })
    try {
      const { router } = renderApp('/docs')
      await userEvent.click(await screen.findByTestId('account-menu'))
      expect(screen.getByTestId('menu-version')).toHaveTextContent('Hotsauce 0.8.0')
      expect(screen.getByTestId('menu-mac-version')).toHaveTextContent('Mac app 0.51.0 (build 131)')
      await userEvent.click(screen.getByTestId('menu-versions'))
      await waitFor(() => expect(router.state.location.pathname).toBe('/settings/whats-new'))
    } finally {
      Reflect.deleteProperty(window, 'hotsauceMacApp')
    }
  })

  it('R10: in a browser there is no Mac app line', async () => {
    renderApp('/docs')
    await userEvent.click(await screen.findByTestId('account-menu'))
    expect(screen.getByTestId('menu-version')).toBeInTheDocument()
    expect(screen.queryByTestId('menu-mac-version')).toBeNull()
  })
})

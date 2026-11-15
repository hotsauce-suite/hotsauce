import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { calendarApi } from '../api/calendar'
import { tokensApi } from '../api/tokens'
import { server, TEST_USER } from '../test/mockServer'
import { renderApp } from '../test/renderApp'

describe('Settings: access tokens', () => {
  it('names no single AI tool, and starts with an empty token name', async () => {
    renderApp('/settings/connections')
    expect(
      await screen.findByRole('heading', { name: 'Connect an AI tool to Hotsauce' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/such as ChatGPT, Claude, Grok or Cursor/)).toBeInTheDocument()
    expect(screen.getByTestId('token-name')).toHaveValue('')
    expect(screen.getByTestId('token-name')).toHaveAttribute('placeholder', 'My AI tool')
    expect(screen.getByTestId('token-create')).toBeDisabled()
  })

  it('creates a token, shows it once with one AI tool’s steps at a time, and revokes it', async () => {
    const user = userEvent.setup()
    renderApp('/settings/connections')
    expect(await screen.findByText('No tokens yet.')).toBeInTheDocument()

    const name = screen.getByTestId('token-name')
    await user.clear(name)
    await user.type(name, 'Laptop')
    await user.click(screen.getByTestId('token-create'))

    const secret = (await screen.findByTestId('token-secret')).textContent ?? ''
    expect(secret).toMatch(/^hth_/)
    const origin = window.location.origin
    // Claude Code first, alone.
    expect(screen.getByTestId('token-command').textContent).toBe(
      `claude mcp add --transport http --scope user hotsauce ${origin}/mcp --header "Authorization: Bearer ${secret}"`,
    )
    expect(screen.queryByTestId('token-desktop-config')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('ai-tool-claude-desktop'))
    expect(screen.queryByTestId('token-command')).not.toBeInTheDocument()
    const desktop = JSON.parse(screen.getByTestId('token-desktop-config').textContent ?? '')
    expect(desktop.mcpServers.hotsauce.env.MCP_AUTH).toBe(`Bearer ${secret}`)
    expect(desktop.mcpServers.hotsauce.args).toContain(`${origin}/mcp`)

    await user.click(screen.getByTestId('ai-tool-cursor'))
    const cursor = JSON.parse(screen.getByTestId('token-cursor-config').textContent ?? '')
    expect(cursor.mcpServers.hotsauce).toEqual({
      url: `${origin}/mcp`,
      headers: { Authorization: `Bearer ${secret}` },
    })

    await user.click(screen.getByTestId('ai-tool-codex'))
    expect(screen.getByTestId('token-codex-config').textContent).toContain(`url = "${origin}/mcp"`)
    expect(screen.getByTestId('token-codex-export').textContent).toBe(
      `export HOTSAUCE_TOKEN="${secret}"`,
    )

    await user.click(screen.getByTestId('ai-tool-other'))
    expect(screen.getByTestId('token-url').textContent).toBe(`${origin}/mcp`)
    expect(screen.getByTestId('token-header').textContent).toBe(`Authorization: Bearer ${secret}`)

    for (const tool of ['chatgpt', 'grok']) {
      await user.click(screen.getByTestId(`ai-tool-${tool}`))
      expect(screen.getByTestId('ai-tool-coming-soon')).toHaveTextContent(
        'Needs sign-in, coming soon',
      )
      expect(screen.getByTestId('ai-tool-steps').textContent).not.toContain(secret)
    }

    const item = await screen.findByTestId('token-item')
    expect(within(item).getByText('Laptop')).toBeInTheDocument()
    expect(within(item).getByText(`hth_…${secret.slice(-4)}`)).toBeInTheDocument()
    // The list never carries the secret.
    expect(item.textContent).not.toContain(secret)

    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByTestId('token-secret')).not.toBeInTheDocument()

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await user.click(within(item).getByTestId('token-revoke'))
    await waitFor(() => expect(screen.queryByTestId('token-item')).not.toBeInTheDocument())
    expect(await tokensApi.list()).toEqual([])
  })

  it('is linked from the sidebar', async () => {
    renderApp('/docs')
    const link = await screen.findByTestId('settings-link')
    expect(link).toHaveAttribute('href', '/settings')
  })
})

describe('Settings: calendars', () => {
  const choice = (id: string) =>
    screen
      .getAllByTestId('calendar-choice')
      .find((el) => el.dataset.calendarId === id) as HTMLElement
  const box = (id: string) => within(choice(id)).getByRole('checkbox')

  it('lists the calendars with primary on and fixed, and saves the ticked ones', async () => {
    const sent: unknown[] = []
    server.use(
      http.put('/api/calendar/calendars', async ({ request }) => {
        sent.push(await request.clone().json())
        return undefined // on to the mock API's handler
      }),
    )
    const user = userEvent.setup()
    renderApp('/settings/connections')
    await waitFor(() => expect(screen.getAllByTestId('calendar-choice')).toHaveLength(3))
    expect(screen.getAllByTestId('calendar-choice').map((el) => el.dataset.calendarId)).toEqual([
      TEST_USER,
      'team@fake',
      'holidays@fake',
    ])
    expect(box(TEST_USER)).toBeChecked()
    expect(box(TEST_USER)).toBeDisabled()
    expect(box('team@fake')).not.toBeChecked()

    await user.click(box('team@fake'))
    await waitFor(() => expect(box('team@fake')).toBeChecked())
    await user.click(box('holidays@fake'))
    await waitFor(() => expect(box('holidays@fake')).toBeChecked())
    await user.click(box('team@fake'))
    await waitFor(() => expect(box('team@fake')).not.toBeChecked())
    // The full list of extra calendars each time, never primary.
    expect(sent).toEqual([
      { ids: ['team@fake'] },
      { ids: ['team@fake', 'holidays@fake'] },
      { ids: ['holidays@fake'] },
    ])
    expect((await calendarApi.calendars()).calendars.filter((c) => c.selected)).toEqual([
      expect.objectContaining({ id: TEST_USER, primary: true }),
      expect.objectContaining({ id: 'holidays@fake' }),
    ])

    // Clicking primary does nothing.
    await user.click(box(TEST_USER))
    expect(box(TEST_USER)).toBeChecked()
    expect(sent).toHaveLength(3)
  })

  it('shows what the server answered', async () => {
    server.use(
      http.put('/api/calendar/calendars', () =>
        HttpResponse.json({
          calendars: [
            { id: TEST_USER, name: TEST_USER, primary: true, selected: true },
            { id: 'team@fake', name: 'Acme team (renamed)', primary: false, selected: true },
          ],
        }),
      ),
    )
    const user = userEvent.setup()
    renderApp('/settings/connections')
    await waitFor(() => expect(screen.getAllByTestId('calendar-choice')).toHaveLength(3))
    await user.click(box('holidays@fake'))
    await waitFor(() => expect(screen.getAllByTestId('calendar-choice')).toHaveLength(2))
    expect(choice('team@fake')).toHaveTextContent('Acme team (renamed)')
    expect(box('team@fake')).toBeChecked()
  })

  it('says why when Google isn’t connected', async () => {
    server.use(
      http.get('/api/calendar/calendars', () =>
        HttpResponse.json(
          {
            error: {
              code: 'forbidden',
              message: 'Google Calendar refused access. Sign in with Google again.',
            },
          },
          { status: 403 },
        ),
      ),
    )
    renderApp('/settings/connections')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Google Calendar refused access. Sign in with Google again.',
    )
    expect(screen.queryByTestId('calendar-choice')).toBeNull()
  })

  it('keeps the old choice and shows the error when saving fails', async () => {
    server.use(
      http.put('/api/calendar/calendars', () =>
        HttpResponse.json(
          { error: { code: 'forbidden', message: 'Reconnect Google to change calendars.' } },
          { status: 403 },
        ),
      ),
    )
    const user = userEvent.setup()
    renderApp('/settings/connections')
    await waitFor(() => expect(screen.getAllByTestId('calendar-choice')).toHaveLength(3))
    await user.click(box('team@fake'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Reconnect Google to change calendars.',
    )
    expect(box('team@fake')).not.toBeChecked()
  })
})

describe('Settings: Mac app', () => {
  it('offers the download, the zip and the first-install steps', async () => {
    renderApp('/settings/apps#mac-app')
    const section = await screen.findByTestId('mac-app')
    expect(within(section).getByRole('heading', { name: 'Mac app' })).toBeInTheDocument()
    expect(await within(section).findByTestId('mac-app-download')).toHaveAttribute(
      'href',
      '/downloads/Hotsauce.dmg',
    )
    expect(within(section).getByTestId('mac-app-download-zip')).toHaveAttribute(
      'href',
      '/downloads/Hotsauce.zip',
    )
    expect(within(section).getByTestId('mac-app-install-steps')).toHaveTextContent('Open Anyway')
    // The setup link fills the Mac app's Workspace step with this server's address (R5).
    expect(within(section).getByTestId('mac-app-setup-link')).toHaveAttribute(
      'href',
      `hearth://setup?server=${encodeURIComponent(window.location.origin)}`,
    )
    expect(within(section).getByTestId('mac-app-install-steps')).toHaveTextContent(
      window.location.host,
    )
    expect(within(section).getByTestId('mac-app-open-privacy')).toHaveAttribute(
      'href',
      'x-apple.systempreferences:com.apple.preference.security',
    )
    expect(within(section).getByRole('link', { name: 'Dictate page' })).toHaveAttribute(
      'href',
      '/dictate/mac',
    )
  })

  it('points to the source when this server has no Mac app build', async () => {
    server.use(http.head('/downloads/Hotsauce.dmg', () => new HttpResponse(null, { status: 404 })))
    renderApp('/settings/apps')
    expect(await screen.findByTestId('mac-app-build-from-source')).toHaveAttribute(
      'href',
      expect.stringContaining('apps/dictate-mac/README.md'),
    )
    expect(screen.queryByTestId('mac-app-download')).toBeNull()
    expect(screen.queryByTestId('mac-app-download-zip')).toBeNull()
    expect(screen.queryByTestId('mac-app-install-steps')).toBeNull()
  })
})

// docs/PLAN-install-and-settings.md, S1–S5, regrouped by docs/PLAN-settings-pages.md.
describe('Settings: General, Apps, and the help strip', () => {
  // G1: the account, then what this device remembers, in one order.
  it('shows General’s sections in order, under one “On this device” label', async () => {
    renderApp('/settings')
    await screen.findByTestId('settings-weather')
    const order = [
      'settings-account',
      'settings-device-label',
      'theme-picker',
      'settings-notifications',
      'single-keys',
      'settings-weather',
    ].map((id) => screen.getByTestId(id))
    for (let i = 1; i < order.length; i++) {
      const before = order[i - 1] as HTMLElement
      expect(
        before.compareDocumentPosition(order[i] as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${before.dataset.testid} before ${order[i]?.dataset.testid}`,
      ).toBeTruthy()
    }
    expect(screen.getByTestId('settings-device-label')).toHaveTextContent('On this device')
    // What moved to other pages isn't here any more.
    for (const gone of ['settings-install', 'token-name', 'calendar-choice', 'mac-app'])
      expect(screen.queryByTestId(gone)).toBeNull()
  })

  // G2: calendars first, then AI tools.
  it('puts Calendars and AI tools on Connections', async () => {
    renderApp('/settings/connections')
    const page = await screen.findByTestId('settings-connections')
    await waitFor(() => expect(within(page).getAllByTestId('calendar-choice')).toHaveLength(3))
    const calendars = within(page).getByRole('heading', { name: 'Calendars' })
    const tools = within(page).getByTestId('settings-ai-tools')
    expect(tools).toHaveAttribute('id', 'ai-tools')
    expect(calendars.closest('section')).toHaveAttribute('id', 'calendars')
    expect(calendars.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByTestId('settings-account')).toBeNull()
  })

  // T3: two sentences up front; what a token can do is folded away.
  it('keeps the AI tools intro short, with the detail folded', async () => {
    renderApp('/settings/connections')
    const tools = await screen.findByTestId('settings-ai-tools')
    const about = within(tools).getByTestId('ai-tools-about')
    expect(about.tagName).toBe('DETAILS')
    expect(about).not.toHaveAttribute('open')
    expect(within(about).getByText('What can a connected tool do?')).toBeInTheDocument()
    expect(about).toHaveTextContent('marked with the tool that made it')
    expect(within(about).getByRole('link', { name: 'agent brief' })).toHaveAttribute(
      'href',
      '/meetings/brief',
    )
    // Outside the fold: one short paragraph.
    const intro = [...tools.querySelectorAll(':scope > p')].map((p) => p.textContent ?? '')
    expect(intro).toHaveLength(1)
    expect(intro[0]?.length).toBeLessThan(260)
  })

  // G3: the Mac app, the web app and the Chrome extension.
  it('puts the Mac app, the web app and the Chrome extension on Apps', async () => {
    renderApp('/settings/apps')
    const install = await screen.findByTestId('settings-install')
    expect(within(install).getByRole('heading', { level: 2 })).toHaveTextContent('Apps')
    expect(within(install).getByTestId('mac-app')).toHaveAttribute('id', 'mac-app')
    expect(within(install).getByTestId('web-app')).toBeInTheDocument()
    expect(within(install).getByTestId('settings-extension')).toHaveAttribute(
      'href',
      '/meetings/extension',
    )
    expect(await within(install).findByTestId('mac-app-download')).toBeInTheDocument()
    expect(within(install).getByTestId('settings-install-button')).toBeInTheDocument()
    expect(
      screen.queryAllByRole('heading', { level: 2, name: /Mac app|Install app/ }),
    ).toHaveLength(0)
  })

  // T1: the six steps are there, folded until asked for.
  it('folds the Mac app’s first-install steps', async () => {
    renderApp('/settings/apps')
    const fold = await screen.findByTestId('mac-app-first-install')
    expect(fold.tagName).toBe('DETAILS')
    expect(fold).not.toHaveAttribute('open')
    expect(within(fold).getByText('How to install it the first time')).toBeInTheDocument()
    expect(within(fold).getByTestId('mac-app-install-steps')).toBeInTheDocument()
    expect(within(fold).getByTestId('mac-app-setup-link')).toBeInTheDocument()
  })

  // T2: inside the Mac app there's nothing to download.
  it('says you’re using the Mac app inside it, with no download', async () => {
    const postMessage = vi.fn().mockResolvedValue('on')
    Object.assign(window, { webkit: { messageHandlers: { hearthNotifications: { postMessage } } } })
    try {
      renderApp('/settings/apps')
      const card = await screen.findByTestId('mac-app')
      expect(within(card).getByTestId('mac-app-in-use')).toHaveTextContent('Installed')
      expect(card).toHaveTextContent('You’re using it on this Mac.')
      expect(screen.queryByTestId('mac-app-download')).toBeNull()
      expect(screen.queryByTestId('mac-app-first-install')).toBeNull()
    } finally {
      Reflect.deleteProperty(window, 'webkit')
    }
  })

  it('shows who is signed in, and signs out from the Account card', async () => {
    const signOut = vi.fn()
    renderApp('/settings', { signOut })
    const account = await screen.findByTestId('settings-account')
    await waitFor(() =>
      expect(within(account).getByTestId('settings-email')).toHaveTextContent(TEST_USER),
    )
    await userEvent.click(within(account).getByTestId('settings-sign-out'))
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1))
  })

  it('offers Install in a browser, and says Installed in the installed app', async () => {
    const { unmount } = render()
    const install = await screen.findByTestId('settings-install')
    expect(within(install).getByTestId('settings-install-button')).toHaveTextContent('Install')
    await userEvent.click(within(install).getByTestId('settings-install-button'))
    expect(screen.getByTestId('install-sheet')).toBeInTheDocument()
    unmount()

    const real = window.matchMedia.bind(window)
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      ...real(query),
      matches: query === '(display-mode: standalone)',
    }))
    render()
    expect(await screen.findByTestId('settings-installed')).toHaveTextContent('Installed')
    expect(screen.queryByTestId('settings-install-button')).toBeNull()
    vi.restoreAllMocks()

    function render() {
      renderApp('/settings/apps')
      return { unmount: cleanup }
    }
  })

  // L3: the same strip on every page.
  it.each(['/settings', '/settings/connections', '/settings/apps'])(
    'links help, the FAQ and feedback, and shows the version, on %s',
    async (path) => {
      server.use(http.get('/api/feedback/status', () => HttpResponse.json({ enabled: true })))
      renderApp(path)
      const strip = await screen.findByTestId('settings-help')
      expect(within(strip).getByTestId('settings-help-docs')).toHaveAttribute(
        'href',
        'https://hotsauce.work/help',
      )
      expect(within(strip).getByTestId('settings-help-faq')).toHaveAttribute(
        'href',
        'https://hotsauce.work/faq',
      )
      expect(await within(strip).findByTestId('settings-feedback')).toHaveAttribute(
        'href',
        expect.stringMatching(/^\/feedback/),
      )
      expect(within(strip).getByTestId('settings-version')).toHaveTextContent('version 0.8.0')
      expect(within(strip).getByTestId('settings-reload')).toBeEnabled()
    },
  )
})

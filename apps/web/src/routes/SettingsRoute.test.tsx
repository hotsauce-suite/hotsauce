import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { calendarApi } from '../api/calendar'
import { tokensApi } from '../api/tokens'
import { server, TEST_USER } from '../test/mockServer'
import { renderApp } from '../test/renderApp'

describe('Settings: access tokens', () => {
  it('creates a token, shows it once with the Claude commands, and revokes it', async () => {
    const user = userEvent.setup()
    renderApp('/settings')
    expect(await screen.findByText('No tokens yet.')).toBeInTheDocument()

    const name = screen.getByTestId('token-name')
    await user.clear(name)
    await user.type(name, 'Laptop')
    await user.click(screen.getByTestId('token-create'))

    const secret = (await screen.findByTestId('token-secret')).textContent ?? ''
    expect(secret).toMatch(/^hth_/)
    expect(screen.getByTestId('token-command').textContent).toBe(
      `claude mcp add --transport http --scope user hearth ${window.location.origin}/mcp --header "Authorization: Bearer ${secret}"`,
    )
    const desktop = JSON.parse(screen.getByTestId('token-desktop-config').textContent ?? '')
    expect(desktop.mcpServers.hearth.env.HEARTH_AUTH).toBe(`Bearer ${secret}`)
    expect(desktop.mcpServers.hearth.args).toContain(`${window.location.origin}/mcp`)

    const item = await screen.findByTestId('token-item')
    expect(within(item).getByText('Laptop')).toBeInTheDocument()
    expect(within(item).getByText(`hth_…${secret.slice(-4)}`)).toBeInTheDocument()
    // The list never carries the secret.
    expect(item.textContent).not.toContain(secret)

    await user.click(screen.getByText('Done'))
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
    renderApp('/settings')
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
    renderApp('/settings')
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
    renderApp('/settings')
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
    renderApp('/settings')
    await waitFor(() => expect(screen.getAllByTestId('calendar-choice')).toHaveLength(3))
    await user.click(box('team@fake'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Reconnect Google to change calendars.',
    )
    expect(box('team@fake')).not.toBeChecked()
  })
})

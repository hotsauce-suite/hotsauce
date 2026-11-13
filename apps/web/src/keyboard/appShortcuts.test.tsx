import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '../test/renderApp'
import { SEQUENCE_MS } from './shortcuts'

afterEach(() => vi.restoreAllMocks())

async function openTasks() {
  const view = renderApp('/tasks')
  await waitFor(() => expect(screen.getAllByTestId('task-row').length).toBeGreaterThan(0))
  return view
}

describe('g then a letter (G1)', () => {
  it('opens that app, and Settings', async () => {
    const user = userEvent.setup()
    const { router } = await openTasks()
    await user.keyboard('gn')
    await waitFor(() => expect(router.state.location.pathname).toBe('/notes'))
    await user.keyboard('gs')
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
    await user.keyboard('gt')
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/tasks/))
  })

  it('forgets the g after a pause', async () => {
    const user = userEvent.setup()
    const { router } = await openTasks()
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    await user.keyboard('g')
    clock.mockReturnValue(now + SEQUENCE_MS + 1)
    await user.keyboard('n')
    expect(router.state.location.pathname).toBe('/tasks')
  })

  it('does nothing while typing', async () => {
    const user = userEvent.setup()
    const { router } = await openTasks()
    await user.keyboard('q')
    const input = await screen.findByTestId('quick-add-input')
    await user.type(input, 'gn')
    expect(input).toHaveValue('gn')
    expect(router.state.location.pathname).toBe('/tasks')
  })
})

describe('c, / and the sidebar (G2)', () => {
  it('c adds a task in Tasks', async () => {
    const user = userEvent.setup()
    await openTasks()
    await user.keyboard('c')
    expect(await screen.findByTestId('quick-add-input')).toHaveFocus()
  })

  it('c writes a note in Notes', async () => {
    const user = userEvent.setup()
    renderApp('/notes')
    await screen.findByTestId('sidebar-app-name')
    await user.keyboard('c')
    expect(await screen.findByTestId('notes-composer')).toBeInTheDocument()
  })

  it('c starts a meeting in Meetings', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/meetings')
    await screen.findByTestId('meetings-home')
    await user.keyboard('c')
    await waitFor(() => expect(router.state.location.pathname).toBe('/meetings/start'))
  })

  it('/ opens the command menu', async () => {
    const user = userEvent.setup()
    await openTasks()
    await user.keyboard('/')
    expect(await screen.findByTestId('cmdk-input')).toBeInTheDocument()
  })

  it('⌘\\ hides and shows the sidebar, and a strip brings it back by mouse', async () => {
    const user = userEvent.setup()
    await openTasks()
    expect(screen.getByTestId('sidebar-app-name')).toBeInTheDocument()
    await user.keyboard('{Meta>}\\{/Meta}')
    expect(screen.queryByTestId('sidebar-app-name')).not.toBeInTheDocument()
    await user.keyboard('{Meta>}\\{/Meta}')
    expect(screen.getByTestId('sidebar-app-name')).toBeInTheDocument()
    await user.keyboard('{Meta>}\\{/Meta}')
    await user.click(screen.getByTestId('show-sidebar'))
    expect(screen.getByTestId('sidebar-app-name')).toBeInTheDocument()
  })

  it('c makes a new doc in Docs, even with the sidebar hidden', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/docs')
    await screen.findByTestId('sidebar-app-name')
    await user.keyboard('{Meta>}\\{/Meta}')
    await user.keyboard('c')
    await waitFor(() => expect(router.state.location.pathname).toMatch(/untitled/i))
  })

  it('c, g and / do nothing while a dialog is open or single keys are off', async () => {
    const user = userEvent.setup()
    const { router } = await openTasks()
    await user.keyboard('?')
    await screen.findByTestId('shortcuts-sheet')
    await user.keyboard('gn')
    expect(router.state.location.pathname).toMatch(/^\/tasks/)
    await user.keyboard('{Escape}')
    localStorage.setItem('hearth:single-keys', 'off')
    await user.keyboard('gn/')
    expect(router.state.location.pathname).toMatch(/^\/tasks/)
    expect(screen.queryByTestId('cmdk-input')).not.toBeInTheDocument()
    localStorage.removeItem('hearth:single-keys')
  })

  it('a g pressed outside a field does not fire with a letter typed inside one', async () => {
    const user = userEvent.setup()
    const { router } = await openTasks()
    await user.keyboard('g')
    await user.keyboard('q')
    const input = await screen.findByTestId('quick-add-input')
    await user.type(input, 'n')
    expect(router.state.location.pathname).toMatch(/^\/tasks/)
  })
})

describe('the rail (G3)', () => {
  it("names each app's g keys in its tooltip", async () => {
    await openTasks()
    expect(screen.getByTestId('app-switch-tasks')).toHaveAttribute(
      'title',
      'Hotsauce Tasks (g then t)',
    )
    expect(screen.getByTestId('settings-link')).toHaveAttribute('title', 'Settings (g then s)')
  })
})

import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderApp } from '../test/renderApp'
import { matchCommands, registerCommands } from './commands'

async function openPalette(path = '/tasks') {
  const user = userEvent.setup()
  const view = renderApp(path)
  await screen.findByTestId('app-rail')
  await user.keyboard('{Control>}k{/Control}')
  const palette = await screen.findByTestId('cmdk')
  return { ...view, user, palette }
}

describe('matching (C2)', () => {
  const commands = [
    { id: 'a', title: 'New doc', group: 'create', keywords: ['page'], run: () => {} },
    { id: 'b', title: 'Dark theme', group: 'prefs', run: () => {} },
  ] as const
  it('needs every typed word to start a word of the title, keywords or group', () => {
    const ids = (q: string) => matchCommands(commands, q).map((c) => c.id)
    expect(ids('new d')).toEqual(['a'])
    expect(ids('page')).toEqual(['a'])
    expect(ids('create')).toEqual(['a'])
    expect(ids('prefer')).toEqual(['b'])
    expect(ids('oc')).toEqual([])
    expect(ids('')).toEqual(['a', 'b'])
  })
})

describe('Command-K commands (C1)', () => {
  it('with nothing typed, offers Create', async () => {
    const { palette } = await openPalette()
    const create = within(palette).getByRole('group', { name: 'Create' })
    expect(within(create).getByTestId('cmdk-command-new-doc')).toBeInTheDocument()
    expect(within(create).getByTestId('cmdk-command-new-task')).toBeInTheDocument()
  })

  it('New task opens Tasks with quick add', async () => {
    const { user, router } = await openPalette('/notes')
    await user.type(screen.getByTestId('cmdk-input'), 'new task')
    await user.click(await screen.findByTestId('cmdk-command-new-task'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'))
    expect(await screen.findByTestId('quick-add-input')).toBeInTheDocument()
    expect(screen.queryByTestId('cmdk')).not.toBeInTheDocument()
  })

  it('highlights the first row shown, with or without a query', async () => {
    const { user, palette } = await openPalette()
    const first = () => palette.querySelector('[cmdk-item]')
    await waitFor(() => expect(first()).toHaveAttribute('aria-selected', 'true'))
    await user.type(screen.getByTestId('cmdk-input'), 'notes')
    await waitFor(() => expect(first()).toHaveAttribute('aria-selected', 'true'))
  })

  it('goes to Settings, showing its keys', async () => {
    const { user, router } = await openPalette()
    await user.type(screen.getByTestId('cmdk-input'), 'settings')
    const row = await screen.findByTestId('cmdk-command-go-settings')
    expect(row).toHaveTextContent('g')
    expect(row).toHaveTextContent('s')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
  })

  it('changes the theme and the single-key switch', async () => {
    const { user } = await openPalette()
    await user.type(screen.getByTestId('cmdk-input'), 'dark')
    await user.click(await screen.findByTestId('cmdk-command-theme-dark'))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    await user.keyboard('{Control>}k{/Control}')
    await user.type(await screen.findByTestId('cmdk-input'), 'single')
    const toggle = await screen.findByTestId('cmdk-command-single-keys')
    expect(toggle).toHaveTextContent('Turn off single-key shortcuts')
    await user.click(toggle)
    expect(localStorage.getItem('hearth:single-keys')).toBe('off')
    document.documentElement.removeAttribute('data-theme')
  })

  it('opens the keyboard shortcuts sheet', async () => {
    const { user } = await openPalette()
    await user.type(screen.getByTestId('cmdk-input'), 'keyboard shortcuts')
    await user.click(await screen.findByTestId('cmdk-command-shortcuts'))
    expect(await screen.findByTestId('shortcuts-sheet')).toBeInTheDocument()
  })

  it('a doc title match still comes first, so Enter opens the doc', async () => {
    const { user, palette } = await openPalette('/docs')
    await user.type(screen.getByTestId('cmdk-input'), 'plan')
    await within(palette).findAllByTestId('search-result')
    const first = palette.querySelector('[cmdk-item]')
    expect(first).toHaveAttribute('data-testid', 'search-result')
  })
})

describe('page commands (C3)', () => {
  it('shows a registered command under On this page, asks before a step that cannot be undone, and passes what was typed', async () => {
    const run = vi.fn()
    let off = () => {}
    act(() => {
      off = registerCommands([
        {
          id: 'test-delete',
          title: 'Delete this thing',
          group: 'page',
          confirm: 'Delete it?',
          run,
        },
      ])
    })
    const { user, palette } = await openPalette()
    const page = within(palette).getByRole('group', { name: 'On this page' })
    await user.click(within(page).getByTestId('cmdk-command-test-delete'))
    expect(run).not.toHaveBeenCalled()
    await user.click(await screen.findByTestId('cmdk-confirm'))
    expect(run).toHaveBeenCalledWith('')
    act(() => off())
  })

  const deleteCommand = (run: () => void) =>
    registerCommands([
      { id: 'test-delete', title: 'Delete this thing', group: 'page', confirm: 'Delete it?', run },
    ])

  it('Enter twice does not run a step that cannot be undone: the question starts on Cancel', async () => {
    const run = vi.fn()
    let off = () => {}
    act(() => {
      off = deleteCommand(run)
    })
    const { user } = await openPalette()
    await user.type(screen.getByTestId('cmdk-input'), 'delete this')
    await user.keyboard('{Enter}')
    expect(await screen.findByTestId('cmdk-confirm')).toBeInTheDocument()
    expect(screen.queryByTestId('cmdk-command-test-delete')).not.toBeInTheDocument()
    await user.keyboard('{Enter}')
    expect(run).not.toHaveBeenCalled()
    expect(screen.queryByTestId('cmdk-confirm')).not.toBeInTheDocument()
    act(() => off())
  })

  it('forgets the question when Command-K closes', async () => {
    const run = vi.fn()
    let off = () => {}
    act(() => {
      off = deleteCommand(run)
    })
    const { user } = await openPalette()
    await user.type(screen.getByTestId('cmdk-input'), 'delete this')
    await user.keyboard('{Enter}')
    await screen.findByTestId('cmdk-confirm')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('cmdk')).not.toBeInTheDocument())
    await user.keyboard('{Control>}k{/Control}')
    await screen.findByTestId('cmdk-input')
    expect(screen.queryByTestId('cmdk-confirm')).not.toBeInTheDocument()
    expect(run).not.toHaveBeenCalled()
    act(() => off())
  })

  it('highlights the first command shown, whatever order pages registered in', async () => {
    let off = () => {}
    act(() => {
      off = registerCommands([
        { id: 'test-new-page', title: 'New page thing', group: 'page', run: () => {} },
      ])
    })
    const { user, palette } = await openPalette('/notes')
    await user.type(screen.getByTestId('cmdk-input'), 'new')
    await waitFor(() => {
      const first = palette.querySelector('[cmdk-item]')
      expect(first).toHaveAttribute('data-testid', 'cmdk-command-test-new-page')
      expect(first).toHaveAttribute('aria-selected', 'true')
    })
    act(() => off())
  })
})

describe('the assistant in Command-K', () => {
  it('Ask the assistant takes what was typed as the question', async () => {
    const { user } = await openPalette()
    await user.type(screen.getByTestId('cmdk-input'), 'what did we decide')
    const row = await screen.findByTestId('cmdk-command-ask-assistant', {}, { timeout: 3000 })
    await user.click(row)
    await waitFor(() => expect(screen.queryByTestId('cmdk')).not.toBeInTheDocument())
    expect(await screen.findByText('what did we decide', {}, { timeout: 4000 })).toBeInTheDocument()
  })
})

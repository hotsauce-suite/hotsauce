import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../test/renderApp'

describe('the keyboard shortcuts sheet (K7)', () => {
  it('? opens it with Everywhere first, then this page; Esc closes it', async () => {
    const user = userEvent.setup()
    renderApp('/tasks')
    await waitFor(() => expect(screen.getAllByTestId('task-row').length).toBeGreaterThan(0))

    const before = document.activeElement
    await user.keyboard('?')
    const sheet = await screen.findByTestId('shortcuts-sheet')
    // The sheet takes focus, so Space or Enter can't press a button behind it.
    expect(sheet.contains(document.activeElement)).toBe(true)
    const sections = within(sheet)
      .getAllByRole('region')
      .map((s) => s.getAttribute('aria-label'))
    expect(sections.slice(0, 3)).toEqual(['Everywhere', 'Go to', 'Tasks'])
    const tasks = within(sheet).getByRole('region', { name: 'Tasks' })
    expect(within(tasks).getByText('On this page')).toBeInTheDocument()
    expect(within(tasks).getByText('Complete or reopen')).toBeInTheDocument()
    // Sections of other apps are still listed, after this page's.
    expect(sections).toContain('Watching a clip')

    // While the sheet is open, Tasks' keys don't run underneath it.
    await user.keyboard('j')
    expect(document.querySelector('[data-testid="task-row"][data-selected="true"]')).toBeNull()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('shortcuts-sheet')).not.toBeInTheDocument())
    expect(document.activeElement).toBe(before)
  })

  it('⌘K opens the command menu from the same listener', async () => {
    const user = userEvent.setup()
    renderApp('/tasks')
    await waitFor(() => expect(screen.getAllByTestId('task-row').length).toBeGreaterThan(0))
    await user.keyboard('{Meta>}k{/Meta}')
    expect(await screen.findByTestId('cmdk-input')).toBeInTheDocument()
  })
})

describe('Settings: single-key shortcuts (K6)', () => {
  it('turns single-key shortcuts off on this device, and the sheet says so', async () => {
    const user = userEvent.setup()
    renderApp('/settings')
    const box = await screen.findByTestId('single-keys')
    expect(box).toBeChecked()
    await user.click(box)
    expect(box).not.toBeChecked()
    expect(localStorage.getItem('hearth:single-keys')).toBe('off')

    // ? is a single key now, so it does nothing; the button still opens the sheet.
    await user.click(document.body)
    await user.keyboard('?')
    expect(screen.queryByTestId('shortcuts-sheet')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('show-shortcuts'))
    const sheet = await screen.findByTestId('shortcuts-sheet')
    expect(within(sheet).getByText(/Single-key shortcuts are off/)).toBeInTheDocument()
    // Settings belongs to no app, so no section claims to be this page's.
    expect(within(sheet).queryByText('On this page')).toBeNull()
  })
})

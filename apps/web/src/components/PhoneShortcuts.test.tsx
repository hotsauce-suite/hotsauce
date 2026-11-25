import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../test/renderApp'

describe('phone shortcuts (docs/PLAN-phone-shortcuts.md)', () => {
  it('R5: Settings → Apps shows Android the held-icon steps, and iPhone each address to copy', async () => {
    const user = userEvent.setup()
    renderApp('/settings/apps')
    await user.click(await screen.findByTestId('phone-shortcuts-toggle'))
    expect(screen.getByTestId('phone-shortcuts-android')).toHaveTextContent(
      'Voice note, New task, Save link, Ask, Ramble',
    )
    await user.click(screen.getByRole('button', { name: 'iPhone' }))
    const task = screen.getByTestId('phone-shortcut-new-task')
    expect(task).toHaveTextContent(`${window.location.origin}/tasks?new=1`)
    await user.click(within(task).getByRole('button', { name: 'Copy the address for New task' }))
    expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/tasks?new=1`)
    expect(screen.getByTestId('phone-shortcuts-iphone')).toHaveTextContent('Safari')
  })

  it('R6: any page with ?ask=1 opens the assistant and tidies the address', async () => {
    const { router } = renderApp('/today?ask=1')
    expect(await screen.findByTestId('assistant-panel')).toBeInTheDocument()
    await waitFor(() => expect(router.state.location.search).toBe(''))
  })
})

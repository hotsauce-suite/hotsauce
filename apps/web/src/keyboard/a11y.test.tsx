import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../test/renderApp'

describe('moving around without a mouse (slice 7)', () => {
  it('the first Tab reaches a Skip to content link that puts focus on the page', async () => {
    const user = userEvent.setup()
    renderApp('/tasks')
    await screen.findByTestId('app-rail')
    await user.tab()
    const skip = screen.getByTestId('skip-link')
    expect(skip).toHaveFocus()
    expect(skip).toHaveTextContent('Skip to content')
    await user.keyboard('{Enter}')
    expect(document.getElementById('main')).toHaveFocus()
  })

  it('arrow keys, Home and End move along the rail', async () => {
    const user = userEvent.setup()
    renderApp('/tasks')
    const rail = await screen.findByTestId('app-rail')
    const docs = within(rail).getByTestId('app-switch-docs')
    docs.focus()
    await user.keyboard('{ArrowDown}')
    expect(within(rail).getByTestId('app-switch-meetings')).toHaveFocus()
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(within(rail).getByTestId('app-switch-today')).toHaveFocus()
    await user.keyboard('{End}')
    expect(within(rail).getByTestId('account-menu')).toHaveFocus()
    await user.keyboard('{Home}')
    expect(within(rail).getByTestId('app-switch-today')).toHaveFocus()
  })
})

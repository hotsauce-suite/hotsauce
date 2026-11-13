import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderApp } from '../test/renderApp'

describe('list keys in Files and Meetings (slice 5)', () => {
  it('u opens the upload picker in Files, and j moves to the first row', async () => {
    const user = userEvent.setup()
    renderApp('/files')
    const input = (await screen.findByTestId('files-input')) as HTMLInputElement
    const click = vi.spyOn(input, 'click').mockImplementation(() => {})
    await user.keyboard('u')
    expect(click).toHaveBeenCalled()
    await waitFor(() =>
      expect(document.querySelectorAll('[data-list-item]').length).toBeGreaterThan(0),
    )
    await user.keyboard('j')
    expect(document.activeElement).toBe(document.querySelector('[data-list-item]'))
  })

  it('j moves through the meeting list', async () => {
    const user = userEvent.setup()
    renderApp('/meetings')
    const items = await screen.findAllByTestId('meeting-item')
    await user.keyboard('j')
    expect(items[0]).toHaveFocus()
    if (items.length > 1) {
      await user.keyboard('j')
      expect(items[1]).toHaveFocus()
    }
  })

  it('shows the list keys on the ? sheet where a list is', async () => {
    const user = userEvent.setup()
    renderApp('/people')
    await screen.findAllByTestId('people-row')
    await user.keyboard('?')
    const sheet = await screen.findByTestId('shortcuts-sheet')
    expect(sheet).toHaveTextContent('Next item')
  })
})

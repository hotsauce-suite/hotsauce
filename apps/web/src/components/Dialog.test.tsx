import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Dialog } from './Dialog'

describe('Dialog', () => {
  it('closes from the × at its top right, and from Escape', async () => {
    const onClose = vi.fn()
    render(
      <Dialog title="Delete this table?" onClose={onClose}>
        <button type="button">Delete</button>
      </Dialog>,
    )
    // The × is the one control named Close; opening doesn't put the cursor on it.
    const x = screen.getByRole('button', { name: 'Close' })
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus()
    await userEvent.click(x)
    expect(onClose).toHaveBeenCalledTimes(1)
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('Dialog with nothing to close to', () => {
  it('shows no ×', () => {
    render(
      <Dialog title="Resolve changes" onClose={() => {}} closable={false}>
        <button type="button">Save result</button>
      </Dialog>,
    )
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  })
})

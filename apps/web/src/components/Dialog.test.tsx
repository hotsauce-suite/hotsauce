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

describe('Dialog with buttons beside the ×', () => {
  it('starts focus on what the pop-up is for, not on its ⋯ More', () => {
    render(
      <Dialog
        title="brief.pdf"
        onClose={() => {}}
        actions={
          <button type="button" aria-label="More">
            ⋯
          </button>
        }
      >
        <a href="/download">Download</a>
      </Dialog>,
    )
    expect(screen.getByRole('link', { name: 'Download' })).toHaveFocus()
  })

  it('Escape closes only the pop-up on top', async () => {
    const under = vi.fn()
    const top = vi.fn()
    render(
      <>
        <Dialog title="brief.pdf" onClose={under}>
          <a href="/download">Download</a>
        </Dialog>
        <Dialog title="Rename" onClose={top}>
          <input aria-label="Name" />
        </Dialog>
      </>,
    )
    await userEvent.keyboard('{Escape}')
    expect(top).toHaveBeenCalledTimes(1)
    expect(under).not.toHaveBeenCalled()
  })
})

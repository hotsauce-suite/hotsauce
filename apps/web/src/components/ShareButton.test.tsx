import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Dialog } from './Dialog'
import { MenuItem } from './Menu'
import { ShareButton } from './ShareButton'

describe('ShareButton', () => {
  it('says Share and keeps Copy link inside it', async () => {
    const copy = vi.fn()
    const onOpen = vi.fn()
    render(
      <ShareButton onOpen={onOpen}>
        {(close) => (
          <MenuItem
            icon="link"
            onSelect={() => {
              close()
              copy()
            }}
          >
            Copy link
          </MenuItem>
        )}
      </ShareButton>,
    )
    expect(screen.queryByRole('menuitem')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Share' }))
    expect(onOpen).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }))
    expect(copy).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('is still named Share when only its icon fits', () => {
    render(<ShareButton iconOnly>{() => null}</ShareButton>)
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument()
  })

  it('Escape closes the menu and leaves the pop-up it sits in open', async () => {
    const onClose = vi.fn()
    render(
      <Dialog title="A file" onClose={onClose}>
        <ShareButton>{() => <MenuItem onSelect={() => {}}>Copy link</MenuItem>}</ShareButton>
      </Dialog>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Share' }))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes on a second press, and hands the keyboard back to the button', async () => {
    render(<ShareButton>{() => <MenuItem onSelect={() => {}}>Copy link</MenuItem>}</ShareButton>)
    const share = screen.getByRole('button', { name: 'Share' })
    await userEvent.click(share)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await userEvent.click(share)
    expect(screen.queryByRole('menu')).toBeNull()
    await userEvent.click(share)
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(share).toHaveFocus()
  })
})

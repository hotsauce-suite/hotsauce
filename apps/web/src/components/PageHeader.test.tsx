import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { MainButton, NewInSpaceButton, useNameWhenFresh } from './PageHeader'

const BOTH = [
  { name: 'p-ada', label: 'Personal' },
  { name: 'team', label: 'Team' },
]

describe('MainButton', () => {
  it('always shows its words, as a button or as a link', () => {
    render(
      <MemoryRouter>
        <MainButton icon="plus" onClick={() => {}}>
          New task
        </MainButton>
        <MainButton to="/clips/new">Record a clip</MainButton>
      </MemoryRouter>,
    )
    const button = screen.getByRole('button', { name: 'New task' })
    expect(button).toHaveAttribute('data-main-button')
    expect(button).toHaveTextContent('New task')
    const link = screen.getByRole('link', { name: 'Record a clip' })
    expect(link).toHaveAttribute('data-main-button')
    expect(link).toHaveAttribute('href', '/clips/new')
  })
})

describe('NewInSpaceButton', () => {
  it('asks whose it is when there is more than one space', async () => {
    const onCreate = vi.fn()
    render(
      <NewInSpaceButton spaces={BOTH} onCreate={onCreate} testId="new-form">
        New form
      </NewInSpaceButton>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'New form' }))
    expect(onCreate).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Personal' }))
    expect(onCreate).toHaveBeenCalledWith('p-ada')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('makes it at once when there is one space', async () => {
    const onCreate = vi.fn()
    render(
      <NewInSpaceButton spaces={BOTH.slice(1)} onCreate={onCreate} testId="new-form">
        New form
      </NewInSpaceButton>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'New form' }))
    expect(onCreate).toHaveBeenCalledWith('team')
  })

  it('waits while busy', async () => {
    const onCreate = vi.fn()
    render(
      <NewInSpaceButton spaces={BOTH} onCreate={onCreate} busy testId="new-form">
        New form
      </NewInSpaceButton>,
    )
    expect(screen.getByRole('button', { name: 'New form' })).toBeDisabled()
  })
})

describe('NewInSpaceButton, pressed again', () => {
  it('closes its menu instead of opening it twice', async () => {
    render(
      <NewInSpaceButton spaces={BOTH} onCreate={() => {}} testId="new-form">
        New form
      </NewInSpaceButton>,
    )
    const button = screen.getByRole('button', { name: 'New form' })
    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(button)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(button).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('useNameWhenFresh', () => {
  function Name({ fresh, value }: { fresh: boolean; value: string }) {
    useNameWhenFresh(fresh, true, '[data-testid="name"]', 'Untitled form')
    return <input data-testid="name" defaultValue={value} />
  }

  it('puts the cursor in the name of a thing just made untitled', () => {
    render(<Name fresh value="Untitled form" />)
    expect(screen.getByTestId('name')).toHaveFocus()
  })

  it('leaves a thing alone once it has a name, or when it was opened, not made', () => {
    const { unmount } = render(<Name fresh value="Vendors" />)
    expect(screen.getByTestId('name')).not.toHaveFocus()
    unmount()
    render(<Name fresh={false} value="Untitled form" />)
    expect(screen.getByTestId('name')).not.toHaveFocus()
  })
})

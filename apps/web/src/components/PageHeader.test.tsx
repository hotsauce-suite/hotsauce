import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { MainButton, NewInSpaceButton, useNameWhenFresh } from './PageHeader'

// A phone: the top bar shows the menu, or the way back in its place.
vi.mock('./AppShell', () => ({ useShell: () => ({ compact: true, openDrawer: () => {} }) }))

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

describe('PageHeader', () => {
  it('shows the menu on a list page on a phone', async () => {
    const { PageHeader } = await import('./PageHeader')
    render(
      <MemoryRouter>
        <PageHeader title="Forms" />
      </MemoryRouter>,
    )
    expect(screen.getByRole('heading', { name: 'Forms' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeInTheDocument()
    expect(screen.queryByTestId('page-back')).toBeNull()
  })

  it('shows the way back to the list on the page of one thing, in the menu’s place', async () => {
    const { PageHeader } = await import('./PageHeader')
    render(
      <MemoryRouter>
        <PageHeader title="Equipment request" back={{ to: '/forms', label: 'Forms' }} />
      </MemoryRouter>,
    )
    const back = screen.getByTestId('page-back')
    expect(back).toHaveTextContent('Forms')
    expect(back).toHaveAttribute('href', '/forms')
    expect(screen.queryByRole('button', { name: 'Open sidebar' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Equipment request' })).toBeInTheDocument()
  })
})

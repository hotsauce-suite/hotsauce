import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EmptyState } from './EmptyState'
import { LoadError } from './LoadError'

describe('LoadError', () => {
  it('names what didn’t load, says what to do, and tries again', async () => {
    const onRetry = vi.fn()
    render(<LoadError things="tasks" onRetry={onRetry} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Couldn’t load your tasks. Check your connection and try again.')
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('says "the" for something shared, and nothing before a name', () => {
    const { rerender } = render(<LoadError things="team files" whose="the" onRetry={() => {}} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load the team files.')
    rerender(<LoadError things="Today" whose="" onRetry={() => {}} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load Today.')
  })
})

describe('EmptyState', () => {
  it('shows a headline, one sentence and the app’s main button', () => {
    render(
      <EmptyState icon="form" title="No forms yet" action={<button type="button">New form</button>}>
        Surveys, sign-ups and requests whose answers land here.
      </EmptyState>,
    )
    const empty = screen.getByTestId('empty-state')
    expect(empty).toHaveTextContent('No forms yet')
    expect(empty).toHaveTextContent('Surveys, sign-ups and requests')
    expect(screen.getByRole('button', { name: 'New form' })).toBeInTheDocument()
  })
})

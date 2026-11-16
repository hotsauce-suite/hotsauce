import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { LoadError } from './LoadError'

describe('LoadError', () => {
  it('names what didn’t load, says what to do, and tries again', async () => {
    const onRetry = vi.fn()
    render(<LoadError things="tasks" onRetry={onRetry} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(
      'Couldn’t load your tasks. Check your connection and try again.',
    )
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

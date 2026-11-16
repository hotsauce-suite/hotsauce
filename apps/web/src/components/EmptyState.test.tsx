import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EmptyState } from './EmptyState'

// docs/PLAN-consistency.md, requirement 5.
describe('EmptyState', () => {
  it('shows the icon, the headline, one sentence and the main button', () => {
    render(
      <EmptyState icon="form" title="No forms yet" action={<button type="button">New form</button>}>
        Make one to collect answers.
      </EmptyState>,
    )
    const screenEl = screen.getByTestId('empty-state')
    expect(screenEl.querySelector('svg')).not.toBeNull()
    expect(screenEl.textContent).toContain('No forms yet')
    expect(screenEl.textContent).toContain('Make one to collect answers.')
    expect(screen.getByRole('button', { name: 'New form' })).toBeTruthy()
  })

  it('needs no sentence or button', () => {
    render(<EmptyState icon="tasks" title="Your inbox is clear" testId="tasks-empty" />)
    expect(screen.getByTestId('tasks-empty').textContent).toBe('Your inbox is clear')
    expect(screen.queryByRole('button')).toBeNull()
  })
})

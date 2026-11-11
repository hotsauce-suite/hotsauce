import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SaveState } from './SaveState'

const base = { isNew: false, lastCommittedAt: null, error: null }

describe('SaveState', () => {
  it('exposes the state for tests and labels it for people', () => {
    const { rerender } = render(<SaveState {...base} state="dirty" />)
    const chip = screen.getByTestId('save-state')
    expect(chip).toHaveAttribute('data-state', 'dirty')
    expect(chip).toHaveTextContent('Editing')

    rerender(<SaveState {...base} state="saving" />)
    expect(chip).toHaveTextContent('Saving…')

    rerender(<SaveState {...base} state="committed" lastCommittedAt={Date.now() - 120_000} />)
    expect(chip).toHaveAttribute('data-state', 'committed')
    expect(chip).toHaveTextContent('Committed · 2 min ago')

    rerender(<SaveState {...base} state="saved" error="Could not reach the Hearth server" />)
    expect(chip).toHaveTextContent('Saved on this device')
    expect(chip.getAttribute('title')).toContain('Could not reach')
  })

  it('calls a doc that was never saved "New doc"', () => {
    render(<SaveState {...base} isNew state="committed" />)
    expect(screen.getByTestId('save-state')).toHaveTextContent('New doc')
  })
})

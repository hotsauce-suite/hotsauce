import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConflictResolver } from './ConflictResolver'

const OURS = '# Rituals\n\nStandup at 10:00.\n'
const THEIRS = '# Rituals\n\nStandup at 9:45.\n'

function renderResolver() {
  const onResolve = vi.fn(async (_content: string) => {})
  const onCancel = vi.fn()
  render(
    <ConflictResolver
      path="docs/rituals.md"
      ours={OURS}
      theirs={THEIRS}
      onResolve={onResolve}
      onCancel={onCancel}
    />,
  )
  return {
    onResolve,
    onCancel,
    result: screen.getByLabelText('Resolved text') as HTMLTextAreaElement,
  }
}

describe('ConflictResolver', () => {
  it('shows both versions side by side and starts the result from mine', () => {
    const { result } = renderResolver()
    expect(screen.getByTestId('conflict-resolver')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Your version' })).toHaveTextContent(
      'Standup at 10:00.',
    )
    expect(screen.getByRole('region', { name: 'Their version' })).toHaveTextContent(
      'Standup at 9:45.',
    )
    expect(result.value).toBe(OURS)
  })

  it('Use theirs then Save resolves with their text', async () => {
    const { onResolve, result } = renderResolver()
    await userEvent.click(screen.getByTestId('resolve-use-theirs'))
    expect(result.value).toBe(THEIRS)
    await userEvent.click(screen.getByTestId('resolve-save'))
    expect(onResolve).toHaveBeenCalledWith(THEIRS)
  })

  it('Use mine then Save resolves with my text', async () => {
    const { onResolve } = renderResolver()
    await userEvent.click(screen.getByTestId('resolve-use-theirs'))
    await userEvent.click(screen.getByTestId('resolve-use-mine'))
    await userEvent.click(screen.getByTestId('resolve-save'))
    expect(onResolve).toHaveBeenCalledWith(OURS)
  })

  it('saves a hand-edited result', async () => {
    const { onResolve, result } = renderResolver()
    await userEvent.clear(result)
    await userEvent.type(result, 'Standup at 9:50.')
    await userEvent.click(screen.getByTestId('resolve-save'))
    expect(onResolve).toHaveBeenCalledWith('Standup at 9:50.')
  })

  it('will not save while conflict markers remain', async () => {
    const { onResolve, result } = renderResolver()
    await userEvent.clear(result)
    await userEvent.type(result, '<<<<<<< mine{Enter}a{Enter}======={Enter}b{Enter}>>>>>>> theirs')
    expect(screen.getByTestId('resolve-save')).toBeDisabled()
    expect(onResolve).not.toHaveBeenCalled()
  })

  it('shows the error and stays open when saving fails', async () => {
    const onResolve = vi.fn(async () => {
      throw new Error('Push rejected, try again')
    })
    render(
      <ConflictResolver
        path="docs/r.md"
        ours={OURS}
        theirs={THEIRS}
        onResolve={onResolve}
        onCancel={() => {}}
      />,
    )
    await userEvent.click(screen.getByTestId('resolve-save'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Push rejected, try again')
    expect(screen.getByTestId('resolve-save')).toBeEnabled()
  })

  it('offers no way out of a conflict that only exists in this tab', async () => {
    render(
      <ConflictResolver path="docs/r.md" ours={OURS} theirs={THEIRS} onResolve={async () => {}} />,
    )
    expect(screen.queryByRole('button', { name: 'Decide later' })).toBeNull()
    await userEvent.keyboard('{Escape}')
    expect(screen.getByTestId('conflict-resolver')).toBeInTheDocument()
  })

  it('Decide later closes without resolving', async () => {
    const { onResolve, onCancel } = renderResolver()
    await userEvent.click(screen.getByRole('button', { name: 'Decide later' }))
    expect(onCancel).toHaveBeenCalled()
    expect(onResolve).not.toHaveBeenCalled()
  })
})

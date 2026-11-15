import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../test/renderApp'
import { withoutVia } from './HistoryPanel'

describe('HistoryPanel', () => {
  it('names the AI tool behind an agent’s change: "Sam Okafor via Cursor"', async () => {
    const user = userEvent.setup()
    renderApp('/docs/team/docs/plans/hiring.md')
    await user.click(await screen.findByTestId('history-toggle'))
    const [item] = await screen.findAllByTestId('history-item')
    expect(item).toBeDefined()
    const row = within(item as HTMLElement)
    expect(row.getByText(/via Cursor/)).toBeInTheDocument()
    expect((item as HTMLElement).textContent).toContain('Sam Okafor via Cursor')
    expect((item as HTMLElement).textContent).not.toContain('Hearth-Via')
  })

  it('drops only the Hearth-Via trailer from the message', () => {
    expect(withoutVia('docs: edit "Q4"\n\nHearth-Via: mcp (client "Cursor")')).toBe(
      'docs: edit "Q4"',
    )
    expect(withoutVia('docs: edit "Q4"')).toBe('docs: edit "Q4"')
    expect(withoutVia('Hearth-Via: kept as a subject')).toBe('Hearth-Via: kept as a subject')
  })
})

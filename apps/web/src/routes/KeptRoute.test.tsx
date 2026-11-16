import { act, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { api } from '../api/client'
import { findDraft, saveDraft } from '../lib/drafts'
import { renderApp } from '../test/renderApp'

describe('Docs → Kept on this device (A4.4)', () => {
  it('lists only this member’s kept edits, and discards one only when confirmed', async () => {
    const me = (await api.me()).principal.userId
    saveDraft(me, 'team', 'docs/gone.md', 'b1', 'Words that couldn’t be saved', 'stranded')
    saveDraft('someone-else', 'team', 'docs/theirs.md', 'b3', 'Not yours', 'waiting')
    renderApp('/docs/kept')
    const page = await screen.findByTestId('kept-page')
    await waitFor(() => expect(within(page).getAllByTestId('kept-item')).toHaveLength(1))
    expect(page).not.toHaveTextContent('Not yours')
    expect(await screen.findByTestId('sidebar-kept')).toHaveTextContent('1')
    const gone = within(page).getAllByTestId('kept-item')[0]
    if (!gone) throw new Error('no item')
    expect(gone).toHaveTextContent('Words that couldn’t be saved')
    act(() => within(gone).getByTestId('kept-discard').click())
    expect(findDraft('team', 'docs/gone.md', me)).not.toBeNull()
    act(() => within(gone).getByTestId('kept-discard-confirm').click())
    expect(findDraft('team', 'docs/gone.md', me)).toBeNull()
    expect(within(page).queryAllByTestId('kept-item')).toHaveLength(0)
    // Another member's waiting text is still on the device, untouched.
    expect(findDraft('team', 'docs/theirs.md', 'someone-else')?.content).toBe('Not yours')
  })
})

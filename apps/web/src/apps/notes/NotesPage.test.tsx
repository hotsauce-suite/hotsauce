import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { mockApi } from '../../test/mockServer'
import { renderApp } from '../../test/renderApp'
import { forgetNoteLists } from './useNotes'

afterEach(() => {
  forgetNoteLists()
  cleanup()
})

const cardTitles = () => screen.queryAllByTestId('note-card-title').map((el) => el.textContent)

function stored(title: string) {
  const n = [...mockApi().notes.notes.values()].find((x) => x.title === title)
  if (!n) throw new Error(`no note "${title}"`)
  return n
}

async function openBoard(path = '/notes') {
  renderApp(path)
  await waitFor(() => expect(screen.getAllByTestId('note-card').length).toBeGreaterThan(0))
}

describe('the board', () => {
  it('shows pinned notes first, then the rest newest first, with team notes marked', async () => {
    await openBoard()
    expect(screen.getByTestId('sidebar-app-name')).toHaveTextContent('Notes')
    const sections = screen.getAllByTestId('notes-section')
    expect(within(sections[0] as HTMLElement).getByText('Pinned')).toBeInTheDocument()
    expect(cardTitles()).toEqual(['Groceries', 'Board meeting ideas', 'Offsite packing list'])
    expect(screen.getAllByText('Team')).toHaveLength(1)
    // A checklist card shows its open items; the ticked one is summarized.
    expect(screen.getByText('Oat milk')).toBeInTheDocument()
    expect(screen.getByText('1 ticked')).toBeInTheDocument()
    // Archived notes stay off the board.
    expect(screen.queryByText('Old parking spot')).toBeNull()
  })

  it('takes a note from the composer and saves it on close', async () => {
    const user = userEvent.setup()
    await openBoard()
    await user.click(screen.getByTestId('notes-take-note'))
    await user.type(screen.getByTestId('composer-title'), 'Call the plumber')
    await user.type(screen.getByTestId('composer-body'), 'About the sink')
    await user.click(screen.getByTestId('composer-close'))
    await waitFor(() => expect(cardTitles()).toContain('Call the plumber'))
    expect(stored('Call the plumber').body).toBe('About the sink')
    // Newest unpinned note comes first after the pinned ones.
    expect(cardTitles()[1]).toBe('Call the plumber')
  })

  it('makes a checklist from the list button', async () => {
    const user = userEvent.setup()
    await openBoard()
    await user.click(screen.getByTestId('notes-new-list'))
    await user.type(screen.getByTestId('checklist-new'), 'Milk{Enter}Bread')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.getByText('Bread')).toBeInTheDocument())
    const note = [...mockApi().notes.notes.values()].find((n) => n.body.includes('Bread'))
    expect(note?.body).toBe('- [ ] Milk\n- [ ] Bread')
    expect(note?.checklist).toBe(true)
  })

  it('ticks a checklist item from the card', async () => {
    await openBoard()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tick Oat milk' }))
    // A second tick straight away isn't a conflict with the first.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tick Coffee beans' }))
    await waitFor(() =>
      expect(stored('Groceries').body).toBe('- [x] Oat milk\n- [x] Coffee beans\n- [x] Eggs'),
    )
    expect(screen.queryByTestId('notes-toast')).toBeNull()
  })

  it('archives with undo, and shows archived notes in Archive', async () => {
    const user = userEvent.setup()
    await openBoard()
    const card = screen.getByText('Board meeting ideas').closest('article') as HTMLElement
    await user.click(within(card).getByTestId('note-card-archive'))
    await waitFor(() => expect(cardTitles()).not.toContain('Board meeting ideas'))
    expect(stored('Board meeting ideas').archived).toBe(true)
    await user.click(screen.getByTestId('notes-undo'))
    await waitFor(() => expect(stored('Board meeting ideas').archived).toBe(false))
    await waitFor(() => expect(cardTitles()).toContain('Board meeting ideas'))
  })

  it('moves a note to the trash, restores it, and deletes forever after confirming', async () => {
    const user = userEvent.setup()
    await openBoard()
    const card = screen.getByText('Board meeting ideas').closest('article') as HTMLElement
    await user.click(within(card).getByTestId('note-card-trash'))
    await waitFor(() => expect(stored('Board meeting ideas').trashed).not.toBeNull())
    await user.click(screen.getByTestId('notes-nav-trash'))
    await waitFor(() => expect(cardTitles()).toEqual(['Board meeting ideas']))
    expect(screen.getByText(/Deleted for good in 30 days/)).toBeInTheDocument()
    await user.click(screen.getByTestId('note-card-restore'))
    await waitFor(() => expect(stored('Board meeting ideas').trashed).toBeNull())

    await user.click(screen.getByTestId('notes-nav-archive'))
    await waitFor(() => expect(cardTitles()).toEqual(['Old parking spot']))
    await user.click(screen.getByTestId('note-card-trash'))
    await user.click(screen.getByTestId('notes-nav-trash'))
    await waitFor(() => expect(cardTitles()).toEqual(['Old parking spot']))
    await user.click(screen.getByTestId('note-card-delete'))
    await user.click(screen.getByTestId('note-delete-confirm'))
    await waitFor(() => expect(screen.getByTestId('notes-empty')).toBeInTheDocument())
    expect([...mockApi().notes.notes.values()].some((n) => n.title === 'Old parking spot')).toBe(
      false,
    )
  })

  it('filters by label from the sidebar and by search', async () => {
    const user = userEvent.setup()
    await openBoard()
    await waitFor(() => expect(screen.getAllByTestId('notes-nav-label').length).toBe(2))
    await user.click(screen.getByRole('link', { name: /Work/ }))
    await waitFor(() => expect(cardTitles()).toEqual(['Board meeting ideas']))
    expect(screen.getByTestId('notes-title')).toHaveTextContent('Work')
    await user.click(screen.getByRole('link', { name: 'Notes' }))
    await waitFor(() => expect(cardTitles()).toHaveLength(3))
    await user.type(screen.getByTestId('notes-search'), 'fridge')
    await waitFor(() => expect(screen.getAllByTestId('note-card')).toHaveLength(1))
    expect(screen.getByText(/Wifi password/)).toBeInTheDocument()
  })
})

describe('the editor', () => {
  it('opens a note, saves typing, and changes color and pin', async () => {
    const user = userEvent.setup()
    await openBoard()
    await user.click(screen.getByRole('button', { name: 'Open note Board meeting ideas' }))
    const editor = await screen.findByTestId('note-editor')
    const body = within(editor).getByTestId('note-editor-body')
    await user.type(body, '\nBring the deck.')
    await user.click(within(editor).getByTestId('note-color'))
    await user.click(within(editor).getByTestId('note-color-pink'))
    await waitFor(() => expect(stored('Board meeting ideas').color).toBe('pink'))
    await user.click(within(editor).getByTestId('note-editor-pin'))
    await waitFor(() => expect(stored('Board meeting ideas').pinned).toBe(true))
    await user.click(within(editor).getByTestId('note-editor-close'))
    await waitFor(() => expect(screen.queryByTestId('note-editor')).toBeNull())
    expect(stored('Board meeting ideas').body).toBe(
      'Open with the pilot results.\nAsk about the second lab.\nBring the deck.',
    )
  })

  it('turns text into a checklist and back without losing words', async () => {
    const user = userEvent.setup()
    await openBoard()
    await user.click(screen.getByRole('button', { name: 'Open note Board meeting ideas' }))
    const editor = await screen.findByTestId('note-editor')
    await user.click(within(editor).getByTestId('note-editor-toggle-list'))
    expect(within(editor).getAllByTestId('checklist-item')).toHaveLength(2)
    await user.click(within(editor).getByTestId('note-editor-close'))
    await waitFor(() =>
      expect(stored('Board meeting ideas').body).toBe(
        '- [ ] Open with the pilot results.\n- [ ] Ask about the second lab.',
      ),
    )
  })

  it('makes a task from a checklist line', async () => {
    const user = userEvent.setup()
    await openBoard()
    await user.click(screen.getByRole('button', { name: 'Open note Groceries' }))
    const editor = await screen.findByTestId('note-editor')
    await user.click(within(editor).getByRole('button', { name: 'Make a task: Coffee beans' }))
    await waitFor(() =>
      expect(
        [...mockApi().tasks.tasks.values()].some(
          (t) => t.title === 'Coffee beans' && t.space === 'ada',
        ),
      ).toBe(true),
    )
    expect(await screen.findByText('Added “Coffee beans” to Tasks')).toBeInTheDocument()
  })

  it('moves a personal note to Team', async () => {
    const user = userEvent.setup()
    await openBoard()
    await user.click(screen.getByRole('button', { name: 'Open note Board meeting ideas' }))
    const editor = await screen.findByTestId('note-editor')
    await user.click(within(editor).getByTestId('note-move-team'))
    await waitFor(() => expect(stored('Board meeting ideas').space).toBe('team'))
    expect(await screen.findByText(/Moved to Team/)).toBeInTheDocument()
  })

  it('asks before overwriting text someone else changed', async () => {
    const user = userEvent.setup()
    await openBoard()
    await user.click(screen.getByRole('button', { name: 'Open note Board meeting ideas' }))
    const editor = await screen.findByTestId('note-editor')
    // Someone else edits the note meanwhile.
    const n = stored('Board meeting ideas')
    n.body = 'Their version'
    mockApi().notes.stamp(n)
    await user.type(within(editor).getByTestId('note-editor-body'), ' mine')
    expect(await within(editor).findByRole('alert')).toHaveTextContent(/Someone else changed/)
    // Closing doesn't throw the unsaved typing away: the editor stays open the first time.
    await user.click(within(editor).getByTestId('note-editor-close'))
    await waitFor(() => expect(screen.getByTestId('note-editor')).toBeInTheDocument())
    await user.click(within(editor).getByTestId('note-keep-mine'))
    await waitFor(() => expect(stored('Board meeting ideas').body).toMatch(/ mine$/))
  })
})

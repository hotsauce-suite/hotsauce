import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Comment } from '../../api/comments'
import { server } from '../../test/mockServer'
import { renderApp } from '../../test/renderApp'
import { mentionQuery, mentionText } from './Composer'
import { commentIdFromHash } from './Conversation'
import { commentWhen } from './commentText'
import { resetCommentMembers } from './useComments'

// Comments in the web app (docs/PLAN-comments.md R1 to R11) against the MSW mock.

const Q4 = '/docs/team/docs/plans/q4-plan.md'

afterEach(() => {
  localStorage.clear()
  resetCommentMembers()
  vi.unstubAllGlobals()
})

async function openDoc(url = Q4) {
  const view = renderApp(url)
  const section = await screen.findByTestId('comments')
  return { ...view, section }
}

const comment = (n: number, over: Partial<Comment> = {}): Comment => ({
  id: `01JCMT${String(n).padStart(20, '0')}`,
  item: '01JITEM0000000000000000001',
  author: 'priya@example.test',
  name: 'Priya Natarajan',
  created: new Date(Date.UTC(2026, 10, 1, 9, n)).toISOString(),
  edited: null,
  text: `Comment number ${n}`,
  quote: null,
  mentions: [],
  via: null,
  mine: false,
  canEdit: false,
  canDelete: false,
  ...over,
})

describe('Comments', () => {
  it('R1: a team doc shows its conversation under the text, and a new comment joins it', async () => {
    const { section } = await openDoc()
    const before = within(section).getAllByTestId('comment')
    expect(before).toHaveLength(2)
    expect(within(before[0] as HTMLElement).getByTestId('comment-author')).toHaveTextContent(
      'Priya Natarajan',
    )
    expect(screen.getByTestId('comments-toggle')).toHaveAccessibleName('Comments (2)')

    await userEvent.type(screen.getByTestId('comment-input'), 'Agreed, moving it.')
    await userEvent.click(screen.getByTestId('comment-send'))
    await waitFor(() => expect(within(section).getAllByTestId('comment')).toHaveLength(3))
    const mine = within(section).getAllByTestId('comment')[2] as HTMLElement
    expect(within(mine).getByTestId('comment-text')).toHaveTextContent('Agreed, moving it.')
    expect(within(mine).getByTestId('comment-author')).toHaveTextContent('Ada Lovelace')
    expect(screen.getByTestId('comment-input')).toHaveValue('')
    expect(screen.getByTestId('comments-toggle')).toHaveAccessibleName('Comments (3)')
  })

  it('going to the comment box once does not pull you back when the view changes', async () => {
    await openDoc()
    await userEvent.click(screen.getByTestId('comments-toggle'))
    await waitFor(() => expect(screen.getByTestId('comment-input')).toHaveFocus())
    await userEvent.click(screen.getByTestId('reading-toggle'))
    await screen.findByTestId('reading-view')
    await new Promise((r) => setTimeout(r, 200))
    expect(screen.getByTestId('comment-input')).not.toHaveFocus()
  })

  it('R2: a personal doc has no comment box', async () => {
    renderApp('/docs/ada/docs/scratch.md')
    await screen.findByTestId('editor')
    await screen.findByTestId('history-toggle')
    // The conversation loads after the doc; give it the time it would take to appear.
    await new Promise((r) => setTimeout(r, 300))
    expect(screen.queryByTestId('comments')).not.toBeInTheDocument()
    expect(screen.queryByTestId('comments-toggle')).not.toBeInTheDocument()
    expect(screen.queryByTestId('comment-input')).not.toBeInTheDocument()
  })

  it('R4: typing @ offers the people to mention, and the name is marked once sent', async () => {
    const { section } = await openDoc()
    const box = screen.getByTestId('comment-input')
    await userEvent.type(box, 'Thanks @sa')
    const options = await screen.findAllByTestId('mention-option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent('Sam Okafor')
    await userEvent.keyboard('{Enter}')
    expect(box).toHaveValue('Thanks @Sam Okafor ')
    expect(screen.queryByTestId('mention-picker')).not.toBeInTheDocument()
    await userEvent.type(box, 'for the quote')
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(within(section).getAllByTestId('comment')).toHaveLength(3))
    const mine = within(section).getAllByTestId('comment')[2] as HTMLElement
    expect(await within(mine).findByTestId('comment-mention')).toHaveTextContent('@Sam Okafor')
  })

  it('R6: a comment about a passage shows the passage it quotes', async () => {
    const { section } = await openDoc()
    const sam = within(section).getAllByTestId('comment')[1] as HTMLElement
    expect(within(sam).getByTestId('comment-quote')).toHaveTextContent('revisit on Nov 15')
    expect(await within(sam).findByTestId('comment-mention')).toHaveTextContent('@Ada Lovelace')
  })

  it('R7: you can edit and delete your own comment, and nobody else’s', async () => {
    const { section } = await openDoc()
    for (const other of within(section).getAllByTestId('comment')) {
      expect(within(other).queryByTestId('comment-edit')).not.toBeInTheDocument()
      expect(within(other).queryByTestId('comment-delete')).not.toBeInTheDocument()
    }
    await userEvent.type(screen.getByTestId('comment-input'), 'First try')
    await userEvent.click(screen.getByTestId('comment-send'))
    await waitFor(() => expect(within(section).getAllByTestId('comment')).toHaveLength(3))
    const mine = () => within(section).getAllByTestId('comment')[2] as HTMLElement

    await userEvent.click(within(mine()).getByTestId('comment-edit'))
    const edit = within(mine()).getByTestId('comment-edit-input')
    await userEvent.clear(edit)
    await userEvent.type(edit, 'Second try')
    await userEvent.click(within(mine()).getByTestId('comment-edit-save'))
    await waitFor(() =>
      expect(within(mine()).getByTestId('comment-text')).toHaveTextContent('Second try'),
    )
    expect(within(mine()).getByTestId('comment-edited')).toBeInTheDocument()

    await userEvent.click(within(mine()).getByTestId('comment-delete'))
    await userEvent.click(within(mine()).getByTestId('comment-delete-confirm'))
    await waitFor(() => expect(within(section).getAllByTestId('comment')).toHaveLength(2))
  })

  it('R10: with no connection the box says so and keeps the draft', async () => {
    await openDoc()
    await userEvent.type(screen.getByTestId('comment-input'), 'Written on the train')
    vi.stubGlobal('navigator', { ...navigator, onLine: false })
    window.dispatchEvent(new Event('offline'))
    expect(await screen.findByTestId('comments-offline')).toHaveTextContent(
      'Comments need a connection',
    )
    expect(screen.getByTestId('comment-send')).toBeDisabled()
    expect(screen.getByTestId('comment-input')).toHaveValue('Written on the train')
  })

  it('R10: a send that fails keeps the words, and they survive a reload', async () => {
    const first = await openDoc()
    server.use(http.post('/api/comments', () => HttpResponse.error()))
    await userEvent.type(screen.getByTestId('comment-input'), 'Do not lose me')
    await userEvent.click(screen.getByTestId('comment-send'))
    expect(await screen.findByTestId('comments-error')).toHaveTextContent('needs a connection')
    expect(screen.getByTestId('comment-input')).toHaveValue('Do not lose me')
    expect(within(first.section).getAllByTestId('comment')).toHaveLength(2)

    first.router.dispose()
    document.body.innerHTML = ''
    await openDoc()
    expect(screen.getByTestId('comment-input')).toHaveValue('Do not lose me')
  })

  it('R11: a long conversation shows the latest comments, with the earlier ones a click away', async () => {
    const all = Array.from({ length: 200 }, (_, i) => comment(i + 1))
    server.use(
      http.get('/api/comments', () => HttpResponse.json({ canComment: true, comments: all })),
    )
    const { section } = await openDoc()
    const shown = within(section).getAllByTestId('comment')
    expect(shown).toHaveLength(20)
    expect(shown[19]).toHaveTextContent('Comment number 200')
    expect(screen.getByTestId('comments-count')).toHaveTextContent('200')
    await userEvent.click(screen.getByTestId('comments-earlier'))
    expect(within(section).getAllByTestId('comment')).toHaveLength(200)
  })

  it('R5: a link to a comment lands on it, even when it is among the earlier ones', async () => {
    const all = Array.from({ length: 40 }, (_, i) => comment(i + 1))
    server.use(
      http.get('/api/comments', () => HttpResponse.json({ canComment: true, comments: all })),
    )
    const target = all[2] as Comment
    const { section } = await openDoc(`${Q4}#comment-${target.id}`)
    const marked = await waitFor(() => {
      const el = section.querySelector('[data-marked="true"]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    expect(marked).toHaveTextContent('Comment number 3')
  })

  it('R1, R2: a team task has a conversation; a personal one does not', async () => {
    renderApp('/tasks/upcoming')
    await userEvent.click(await screen.findByText('Ship the pilot report'))
    const section = await screen.findByTestId('comments')
    expect(within(section).getByTestId('comment-text')).toHaveTextContent(
      'Charts are in the shared folder',
    )
    await userEvent.type(within(section).getByTestId('comment-input'), 'On it')
    await userEvent.click(within(section).getByTestId('comment-send'))
    await waitFor(() => expect(within(section).getAllByTestId('comment')).toHaveLength(2))

    await userEvent.click(await screen.findByText('Book flights for the Boston visit'))
    await screen.findByTestId('detail-notes')
    await new Promise((r) => setTimeout(r, 300))
    expect(screen.queryByTestId('comments')).not.toBeInTheDocument()
  })
})

describe('comment helpers', () => {
  const members = [
    { email: 'ada@example.test', name: 'Ada Lovelace', handle: 'ada' },
    { email: 'sam@example.test', name: 'Sam Okafor', handle: 'sam' },
    { email: 'sam2@example.test', name: 'Sam Okafor', handle: 'sam2' },
  ]

  it('finds the @ being typed at the caret', () => {
    expect(mentionQuery('hi @sa', 6)).toEqual({ from: 3, query: 'sa' })
    expect(mentionQuery('@Ada Lov', 8)).toEqual({ from: 0, query: 'Ada Lov' })
    expect(mentionQuery('mail me at a@b', 14)).toBeNull()
    expect(mentionQuery('@ada said so and then', 21)).toBeNull()
    expect(mentionQuery('@ada\nnext', 9)).toBeNull()
    expect(mentionQuery('no mention', 5)).toBeNull()
  })

  it('writes a name, or the handle when two members share the name', () => {
    expect(mentionText(members[0] as (typeof members)[0], members)).toBe('@Ada Lovelace')
    expect(mentionText(members[1] as (typeof members)[0], members)).toBe('@sam')
    expect(mentionText(members[2] as (typeof members)[0], members)).toBe('@sam2')
  })

  it('never writes a name the server would read as nobody', () => {
    // "Alex" is one member's name and the other's handle, so it names neither.
    const team = [
      { email: 'alex@example.test', name: 'Alex Kim', handle: 'alex' },
      { email: 'alexander@example.test', name: 'Alex', handle: 'alexander' },
    ]
    expect(mentionText(team[1] as (typeof team)[0], team)).toBe('@alexander')
    expect(mentionText(team[0] as (typeof team)[0], team)).toBe('@Alex Kim')
  })

  it('reads the comment a link points at', () => {
    expect(commentIdFromHash('#comment-01JCMT00000000000000000001')).toBe(
      '01JCMT00000000000000000001',
    )
    expect(commentIdFromHash('#L12')).toBeNull()
    expect(commentIdFromHash('')).toBeNull()
  })

  it('says when: the time today, the day this year, the year before that', () => {
    const now = new Date(2026, 10, 16, 12, 0)
    expect(commentWhen(new Date(2026, 10, 16, 9, 5).toISOString(), now)).not.toMatch(/Nov/)
    expect(commentWhen(new Date(2026, 10, 3, 9, 5).toISOString(), now)).toMatch(/Nov 3/)
    expect(commentWhen(new Date(2025, 10, 3, 9, 5).toISOString(), now)).toMatch(/2025/)
    expect(commentWhen('not a date', now)).toBe('')
  })
})

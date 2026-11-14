import { addDays, localNow } from '@hearth/format'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { memberTimeZone, tasksApi } from '../../api/tasks'
import { mockApi, server, TEST_USER } from '../../test/mockServer'
import { renderApp } from '../../test/renderApp'
import { effectiveOrder, viewQuery } from './logic'
import { forgetTaskLists, tasksBus } from './useTaskList'
import { forgetTaskMeta } from './useTaskMeta'

afterEach(() => {
  forgetTaskLists()
  forgetTaskMeta()
  vi.restoreAllMocks()
})

const today = () => localNow(new Date(), memberTimeZone()).date

/** The seeded task with this title, as the mock server holds it. */
function stored(title: string) {
  const t = [...mockApi().tasks.tasks.values()].find((x) => x.title === title)
  if (!t) throw new Error(`no task "${title}"`)
  return t
}

const titles = (root: HTMLElement = document.body) =>
  within(root)
    .queryAllByTestId('task-title')
    .map((el) => el.textContent)

async function openList(path: string) {
  renderApp(path)
  await waitFor(() => expect(screen.getAllByTestId('task-row').length).toBeGreaterThan(0))
}

describe('views', () => {
  it('Inbox shows my open tasks without a project, oldest first', async () => {
    await openList('/tasks')
    expect(screen.getByTestId('sidebar-app-name')).toHaveTextContent('Hotsauce Tasks')
    expect(titles()).toEqual([
      'Renew the lab safety certificate',
      'Call Sam about the pilot budget',
      'Water the office plants',
      'Read the security audit draft',
      'Book flights for the Boston visit',
      'Sort out October expense receipts',
    ])
    // The first line of the notes shows under the title.
    expect(screen.getByText('Priya sent it Tuesday.')).toBeInTheDocument()
  })

  it('Today puts overdue in its own group and lists meeting action items', async () => {
    await openList('/tasks/today')
    const groups = screen.getAllByTestId('task-group')
    expect(groups.map((g) => g.dataset.group)).toEqual(['overdue', 'today'])
    expect(titles(groups[0] as HTMLElement)).toEqual(['Renew the lab safety certificate'])
    expect(titles(groups[1] as HTMLElement)).toEqual([
      'Water the office plants',
      'Call Sam about the pilot budget',
    ])
    expect(within(groups[0] as HTMLElement).getByTestId('task-due')).toHaveAttribute(
      'data-overdue',
      'true',
    )
    expect(await screen.findByTestId('from-meetings')).toBeInTheDocument()
    // The sidebar counts today's open tasks.
    await waitFor(() =>
      expect(
        within(screen.getByTestId('tasks-nav-today')).getByTestId('nav-count'),
      ).toHaveTextContent('3'),
    )
  })

  it('Upcoming groups the next 14 days by day, then Later', async () => {
    await openList('/tasks/upcoming')
    const groups = screen.getAllByTestId('task-group')
    expect(groups.map((g) => g.dataset.group)).toEqual([
      today(),
      addDays(today(), 3),
      addDays(today(), 5),
      'later',
    ])
    expect(titles(groups[3] as HTMLElement)).toEqual(['Order new lab notebooks'])
    // Someone else's team task never shows in my lists.
    expect(screen.queryByText('Plan the offsite agenda')).not.toBeInTheDocument()
  })

  it('a project lists everyone’s open tasks, with Done collapsed', async () => {
    await openList('/tasks/project/team/Launch')
    expect(screen.getByTestId('tasks-title')).toHaveTextContent('Launch')
    expect(titles()).toEqual([
      'Ship the pilot report',
      'Write the launch announcement',
      'Record a demo clip',
    ])
    expect(screen.getAllByTestId('task-assignee').map((a) => a.textContent)).toEqual(['AL', 'PN'])
    await userEvent.click(within(screen.getByTestId('project-done')).getByRole('button'))
    expect(await screen.findByText('Nothing done here yet.')).toBeInTheDocument()
  })

  it('Done lists what I finished in the last 30 days', async () => {
    await openList('/tasks/done')
    expect(titles()).toEqual(['Send the board deck'])
    expect(screen.getByTestId('task-check')).toHaveAttribute('aria-checked', 'true')
  })

  it('a task link opens its list with the detail panel', async () => {
    const t = mockApi().tasks.add({
      space: 'team',
      createdBy: TEST_USER,
      title: 'Linked task',
      project: 'Launch',
    })
    renderApp(`/tasks/item/team/${t.id}`)
    const detail = await screen.findByTestId('task-detail')
    expect(within(detail).getByTestId('detail-title')).toHaveValue('Linked task')
    await waitFor(() => expect(screen.getByTestId('tasks-title')).toHaveTextContent('Launch'))
    // The list loads after the detail; under a full parallel run that can take over a second.
    // (A row found by findByText can be replaced by the next render, so wait on the query.)
    await waitFor(
      () =>
        expect(
          screen.getByText('Linked task', { selector: '[data-testid="task-title"]' }),
        ).toBeInTheDocument(),
      { timeout: 5_000 },
    )
  })

  it('refetches when tasks change elsewhere', async () => {
    await openList('/tasks')
    mockApi().tasks.add({ space: 'ada', createdBy: TEST_USER, title: 'Added by an agent' })
    act(() => tasksBus.emit({ type: 'changed' }))
    expect(await screen.findByText('Added by an agent')).toBeInTheDocument()
  })
})

describe('signing out', () => {
  it('forgets cached lists, so the next member never sees them', async () => {
    await openList('/tasks')
    cleanup()
    // Sign out is in Settings.
    renderApp('/settings')
    await userEvent.click(await screen.findByTestId('settings-sign-out'))
    cleanup()
    // Another member signs in on this browser; their first paint has no rows from before.
    mockApi().tasks.tasks.clear()
    renderApp('/tasks')
    await screen.findByTestId('tasks-title')
    expect(screen.queryAllByTestId('task-row')).toHaveLength(0)
  })
})

describe('optimistic changes', () => {
  it('survive a refetch while their request is still in flight', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.patch('/api/tasks/:space/:id', async () => {
        await held
        return undefined
      }),
    )
    await openList('/tasks')
    await userEvent.keyboard('j1')
    const first = () => within(screen.getAllByTestId('task-row')[0] as HTMLElement)
    expect(first().getByTestId('task-check')).toHaveAttribute('data-priority', '1')
    act(() => tasksBus.emit({ type: 'changed' }))
    // The refetch lands (the server still says P2), and the row keeps the change in flight.
    await new Promise((r) => setTimeout(r, 500))
    expect(first().getByTestId('task-check')).toHaveAttribute('data-priority', '1')
    release()
    await waitFor(() => expect(stored('Renew the lab safety certificate').priority).toBe(1))
    expect(first().getByTestId('task-check')).toHaveAttribute('data-priority', '1')
  })

  it('drops a load sent before a change that settles first', async () => {
    await openList('/tasks')
    // What the server says before the change: the certificate is P2.
    const stale = await tasksApi.list(viewQuery({ id: 'inbox' }, new Date(), today()))
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let asked = false
    server.use(
      http.get('/api/tasks', async ({ request }) => {
        // Only the Inbox's own load (the sidebar loads counts too).
        if (asked || !new URL(request.url).searchParams.has('project')) return undefined
        asked = true
        await held
        return HttpResponse.json({ tasks: stale })
      }),
    )
    act(() => tasksBus.emit({ type: 'changed' }))
    await waitFor(() => expect(asked).toBe(true))
    await userEvent.keyboard('j1')
    await waitFor(() => expect(stored('Renew the lab safety certificate').priority).toBe(1))
    await new Promise((r) => setTimeout(r, 30))
    // The old load lands after the change settled; it must not put P2 back.
    release()
    await new Promise((r) => setTimeout(r, 30))
    const first = within(screen.getAllByTestId('task-row')[0] as HTMLElement)
    expect(first.getByTestId('task-check')).toHaveAttribute('data-priority', '1')
  })
})

describe('quick add', () => {
  it('highlights tokens as chips and adds the task with Enter', async () => {
    await openList('/tasks')
    await userEvent.click(screen.getByTestId('quick-add-open'))
    const input = screen.getByTestId('quick-add-input')
    await userEvent.type(input, 'Call the vendor tomorrow 3pm p1 #Ops @calls')
    const chips = screen.getAllByTestId('quick-chip')
    expect(chips.map((c) => [c.dataset.kind, c.textContent])).toEqual([
      ['date', 'Tomorrow 3:00 PM'],
      ['priority', 'P1'],
      ['project', '#Ops'],
      ['label', '@calls'],
    ])
    const marks = screen.getByTestId('quick-marks').querySelectorAll('mark')
    expect([...marks].map((m) => m.textContent)).toEqual([
      'tomorrow',
      '3pm',
      'p1',
      '#Ops',
      '@calls',
    ])

    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByTestId('quick-add')).not.toBeInTheDocument())
    const added = stored('Call the vendor')
    expect(added).toMatchObject({
      space: 'ada',
      due: `${addDays(today(), 1)}T15:00`,
      priority: 1,
      project: 'Ops',
      labels: ['calls'],
    })
    // It has a project, so the Inbox doesn't keep it, but the sidebar learns the project.
    expect(screen.queryByText('Call the vendor')).not.toBeInTheDocument()
  })

  it('Shift+Enter keeps it open; assigning someone else forces Team', async () => {
    await openList('/tasks')
    await userEvent.keyboard('q')
    const input = await screen.findByTestId('quick-add-input')
    expect(input).toHaveFocus()
    await userEvent.type(input, 'Plain inbox task{Shift>}{Enter}{/Shift}')
    expect(await screen.findByText('Plain inbox task')).toBeInTheDocument()
    expect(screen.getByTestId('quick-add-input')).toHaveValue('')

    await userEvent.type(screen.getByTestId('quick-add-input'), 'Review the deck +priya')
    expect(screen.getByTestId('space-personal')).toBeDisabled()
    expect(screen.getByTestId('space-team')).toHaveAttribute('aria-checked', 'true')
    await userEvent.keyboard('{Enter}')
    await waitFor(() =>
      expect(stored('Review the deck')).toMatchObject({
        space: 'team',
        assignee: 'priya@example.test',
      }),
    )
    // Esc closes.
    await userEvent.keyboard('q')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('quick-add')).not.toBeInTheDocument()
  })

  it('adds in Today as due today, and in a project to that project', async () => {
    await openList('/tasks/today')
    await userEvent.click(screen.getByTestId('quick-add-open'))
    await userEvent.type(screen.getByTestId('quick-add-input'), 'Sign the PO{Enter}')
    await waitFor(() => expect(stored('Sign the PO').due).toBe(today()))
    expect(await screen.findByText('Sign the PO')).toBeInTheDocument()
  })
})

describe('completing', () => {
  it('animates the row out, offers Undo for 5 seconds, and Undo reopens it', async () => {
    await openList('/tasks')
    const row = screen.getAllByTestId('task-row')[0] as HTMLElement
    await userEvent.click(within(row).getByTestId('task-check'))
    expect(row).toHaveAttribute('data-leaving', 'true')
    expect(screen.getByTestId('task-toast')).toHaveTextContent(
      'Completed “Renew the lab safety certificate”',
    )
    await waitFor(() =>
      expect(screen.queryByText('Renew the lab safety certificate')).not.toBeInTheDocument(),
    )
    await waitFor(() => expect(stored('Renew the lab safety certificate').status).toBe('done'))

    await userEvent.click(screen.getByTestId('task-undo'))
    await waitFor(() => expect(stored('Renew the lab safety certificate').status).toBe('open'))
    expect(await screen.findByText('Renew the lab safety certificate')).toBeInTheDocument()
  })

  it('a completion that lands after switching views leaves the old view’s list alone', async () => {
    await openList('/tasks')
    const name = 'Sort out October expense receipts'
    const row = screen.getByText(name).closest('[data-testid="task-row"]') as HTMLElement
    await userEvent.click(within(row).getByTestId('task-check'))
    await userEvent.click(screen.getByRole('link', { name: /^Today/ }))
    await waitFor(() => expect(stored(name).status).toBe('done'))
    await new Promise((r) => setTimeout(r, 50))
    // Back to the Inbox: its first paint is its own cached list, not Today's.
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.get('/api/tasks', async ({ request }) => {
        if (new URL(request.url).searchParams.has('project')) await held
        return undefined
      }),
    )
    await userEvent.click(screen.getByRole('link', { name: 'Inbox' }))
    await waitFor(() => expect(screen.getByTestId('tasks-title')).toHaveTextContent('Inbox'))
    expect(screen.getByText('Read the security audit draft')).toBeInTheDocument()
    release()
  })

  it('moves a recurring task on, and Undo puts its date back', async () => {
    await openList('/tasks/today')
    const row = screen
      .getAllByTestId('task-row')
      .find((r) => r.textContent?.includes('Water the office plants')) as HTMLElement
    await userEvent.click(within(row).getByTestId('task-check'))
    expect(screen.getByTestId('task-toast')).toHaveTextContent('moved to its next date')
    await waitFor(() => expect(stored('Water the office plants').due).toBe(addDays(today(), 7)))
    await waitFor(() =>
      expect(screen.queryByText('Water the office plants')).not.toBeInTheDocument(),
    )
    await userEvent.click(screen.getByTestId('task-undo'))
    await waitFor(() => expect(stored('Water the office plants').due).toBe(today()))
    expect(stored('Water the office plants').status).toBe('open')
    expect(await screen.findByText('Water the office plants')).toBeInTheDocument()
  })

  it('rolls back and says so when the server refuses', async () => {
    await openList('/tasks')
    mockApi().tasks.failNext = true
    const row = screen.getAllByTestId('task-row')[0] as HTMLElement
    await userEvent.click(within(row).getByTestId('task-check'))
    expect(
      await screen.findByText('That didn’t save. Check your connection and try again.'),
    ).toBeInTheDocument()
    await waitFor(() => expect(titles()[0]).toBe('Renew the lab safety certificate'))
    expect(stored('Renew the lab safety certificate').status).toBe('open')
  })
})

describe('detail', () => {
  it('saves each field by PATCH', async () => {
    await openList('/tasks')
    await userEvent.click(screen.getAllByTestId('task-open')[0] as HTMLElement)
    const detail = await screen.findByTestId('task-detail')
    const name = 'Renew the lab safety certificate'

    const notes = within(detail).getByTestId('detail-notes')
    await userEvent.type(notes, 'Form is on the shared drive')
    expect(stored(name).notes).toBe('')
    await userEvent.click(within(detail).getByTestId('detail-title'))
    await waitFor(() => expect(stored(name).notes).toBe('Form is on the shared drive'))

    await userEvent.click(within(detail).getByTestId('detail-priority-1'))
    await waitFor(() => expect(stored(name).priority).toBe(1))
    // The row follows at once.
    const row = screen.getAllByTestId('task-row')[0] as HTMLElement
    expect(within(row).getByTestId('task-check')).toHaveAttribute('data-priority', '1')

    const recur = within(detail).getByTestId('detail-recur')
    await userEvent.type(recur, 'every blue moon')
    await userEvent.tab()
    expect(within(detail).getByText(/Try “every week”/)).toBeInTheDocument()
    await userEvent.clear(recur)
    await userEvent.type(recur, 'every mon{Enter}')
    await waitFor(() => expect(stored(name).recur).toBe('every monday'))

    const title = within(detail).getByTestId('detail-title')
    await userEvent.clear(title)
    await userEvent.type(title, 'Renew the certificate{Enter}')
    await waitFor(() => expect(stored('Renew the certificate')).toBeTruthy())

    fireEvent.change(within(detail).getByTestId('detail-date'), {
      target: { value: addDays(today(), 2) },
    })
    await waitFor(() => expect(stored('Renew the certificate').due).toBe(addDays(today(), 2)))

    await userEvent.type(within(detail).getByTestId('detail-label-input'), 'safety{Enter}')
    await waitFor(() => expect(stored('Renew the certificate').labels).toEqual(['safety']))

    const project = within(detail).getByTestId('detail-project')
    await userEvent.type(project, 'Compliance{Enter}')
    await waitFor(() => expect(stored('Renew the certificate').project).toBe('Compliance'))
    // It left the Inbox, but the panel stays open on it.
    await waitFor(() => expect(screen.queryAllByText('Renew the certificate')).toHaveLength(0))
    expect(screen.getByTestId('task-detail')).toBeInTheDocument()
  })

  it('Escape in the title discards the edit', async () => {
    await openList('/tasks')
    await userEvent.click(screen.getAllByTestId('task-open')[0] as HTMLElement)
    const detail = await screen.findByTestId('task-detail')
    const name = 'Renew the lab safety certificate'
    const patches: unknown[] = []
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PATCH') patches.push(request.url)
    })
    const title = within(detail).getByTestId('detail-title')
    await userEvent.clear(title)
    await userEvent.type(title, 'Something else{Escape}')
    expect(title).not.toHaveFocus()
    expect(title).toHaveValue(name)
    await new Promise((r) => setTimeout(r, 50))
    expect(patches).toEqual([])
    expect(stored(name).title).toBe(name)
    server.events.removeAllListeners()
  })

  it('e focuses the title of that task only, not of the next one opened', async () => {
    await openList('/tasks')
    await userEvent.keyboard('j')
    await userEvent.keyboard('e')
    await waitFor(() => expect(screen.getByTestId('detail-title')).toHaveFocus())
    await userEvent.keyboard('{Escape}')
    await userEvent.click(screen.getByTestId('detail-close'))
    await waitFor(() => expect(screen.queryByTestId('task-detail')).not.toBeInTheDocument())
    await userEvent.click(screen.getAllByTestId('task-open')[1] as HTMLElement)
    const title = within(await screen.findByTestId('task-detail')).getByTestId('detail-title')
    await new Promise((r) => setTimeout(r, 20))
    expect(title).not.toHaveFocus()
    // Nor the first one again, reopened.
    await userEvent.click(screen.getByTestId('detail-close'))
    await userEvent.click(screen.getAllByTestId('task-open')[0] as HTMLElement)
    const again = within(await screen.findByTestId('task-detail')).getByTestId('detail-title')
    await new Promise((r) => setTimeout(r, 20))
    expect(again).not.toHaveFocus()
  })

  it('moves a task to Team, then can assign it, and deletes after asking', async () => {
    await openList('/tasks')
    await userEvent.click(screen.getAllByTestId('task-open')[5] as HTMLElement)
    const detail = await screen.findByTestId('task-detail')
    const assignee = within(detail).getByTestId('detail-assignee')
    expect(within(assignee).getByRole('option', { name: 'Priya Natarajan' })).toBeDisabled()

    await userEvent.click(within(detail).getByTestId('detail-space-team'))
    await waitFor(() => expect(stored('Sort out October expense receipts').space).toBe('team'))
    const moved = await screen.findByTestId('task-detail')
    await waitFor(() =>
      expect(
        within(within(moved).getByTestId('detail-assignee')).getByRole('option', {
          name: 'Priya Natarajan',
        }),
      ).toBeEnabled(),
    )
    await userEvent.selectOptions(
      within(moved).getByTestId('detail-assignee'),
      'priya@example.test',
    )
    await waitFor(() =>
      expect(stored('Sort out October expense receipts').assignee).toBe('priya@example.test'),
    )

    await userEvent.click(within(moved).getByTestId('detail-delete'))
    await userEvent.click(await screen.findByTestId('task-delete-confirm'))
    await waitFor(() =>
      expect(
        [...mockApi().tasks.tasks.values()].some(
          (t) => t.title === 'Sort out October expense receipts',
        ),
      ).toBe(false),
    )
    expect(screen.queryByTestId('task-detail')).not.toBeInTheDocument()
  })
})

describe('keyboard', () => {
  it('moves, completes, prioritizes, schedules, opens and deletes', async () => {
    await openList('/tasks')
    const selected = () =>
      document.querySelector(
        '[data-testid="task-row"][data-selected="true"] [data-testid="task-title"]',
      )?.textContent

    await userEvent.keyboard('j')
    expect(selected()).toBe('Renew the lab safety certificate')
    await userEvent.keyboard('jj')
    expect(selected()).toBe('Water the office plants')
    await userEvent.keyboard('k')
    expect(selected()).toBe('Call Sam about the pilot budget')

    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(selected()).toBe('Read the security audit draft')
    await userEvent.keyboard('2')
    await waitFor(() => expect(stored('Read the security audit draft').priority).toBe(2))
    await userEvent.keyboard('t')
    await waitFor(() => expect(stored('Read the security audit draft').due).toBe(today()))
    await userEvent.keyboard('m')
    await waitFor(() =>
      expect(stored('Read the security audit draft').due).toBe(addDays(today(), 1)),
    )

    await userEvent.keyboard('x')
    await waitFor(() => expect(stored('Read the security audit draft').status).toBe('done'))

    await userEvent.keyboard('j')
    const target = selected()
    await userEvent.keyboard('{Delete}')
    expect(await screen.findByTestId('task-delete-dialog')).toHaveTextContent(String(target))
    await userEvent.click(screen.getByTestId('task-delete-confirm'))
    await waitFor(() => expect(screen.queryByText(String(target))).not.toBeInTheDocument())

    await userEvent.keyboard('k{Enter}')
    expect(await screen.findByTestId('task-detail')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('detail-close'))
    await userEvent.keyboard('e')
    const title = screen.getByTestId('detail-title')
    await waitFor(() => expect(title).toHaveFocus())
    const editing = (title as HTMLInputElement).value
    // The title is selected for retyping, and typing in a field never triggers a shortcut.
    await userEvent.keyboard('x')
    expect(title).toHaveValue('x')
    expect(stored(editing).status).toBe('open')
  })
})

describe('time zones', () => {
  it('sends the member’s zone on every PATCH; t and m keep a timed task’s own zone', async () => {
    const bodies: Array<Record<string, unknown>> = []
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PATCH') {
        void request
          .clone()
          .json()
          .then((b) => bodies.push(b as Record<string, unknown>))
      }
    })
    await openList('/tasks/today')
    const call = 'Call Sam about the pilot budget'
    while (
      document.querySelector(
        '[data-testid="task-row"][data-selected="true"] [data-testid="task-title"]',
      )?.textContent !== call
    ) {
      await userEvent.keyboard('j')
    }
    await userEvent.keyboard('3')
    await waitFor(() => expect(stored(call).priority).toBe(3))
    await userEvent.keyboard('m')
    await waitFor(() => expect(stored(call).due).toBe(`${addDays(today(), 1)}T15:00`))
    expect(stored(call).tz).toBe('America/New_York')
    expect(bodies).toEqual([
      { priority: 3, tz: memberTimeZone() },
      { due: `${addDays(today(), 1)}T15:00`, tz: 'America/New_York' },
    ])
    server.events.removeAllListeners()
  })
})

describe('drag to reorder', () => {
  it('drops a row between its new neighbors and saves only its order', async () => {
    await openList('/tasks')
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.testid === 'task-row') {
        const i = [...(this.parentElement?.children ?? [])].indexOf(this)
        return new DOMRect(0, i * 50, 600, 50)
      }
      return new DOMRect()
    })
    const before = [...mockApi().tasks.tasks.values()].map((t) => ({ ...t }))
    const handle = screen.getAllByTestId('task-handle')[0] as HTMLElement
    fireEvent.pointerDown(handle, { clientY: 25, pointerId: 1, button: 0 })
    fireEvent.pointerMove(window, { clientY: 135, pointerId: 1 })
    expect(screen.getAllByTestId('task-row')[0]).toHaveAttribute('data-dragging', 'true')
    fireEvent.pointerUp(window, { clientY: 135, pointerId: 1 })

    const water = stored('Water the office plants')
    const read = stored('Read the security audit draft')
    const expected = (effectiveOrder(water) + effectiveOrder(read)) / 2
    await waitFor(() => expect(stored('Renew the lab safety certificate').order).toBe(expected))
    await waitFor(() =>
      expect(titles().slice(0, 4)).toEqual([
        'Call Sam about the pilot budget',
        'Water the office plants',
        'Renew the lab safety certificate',
        'Read the security audit draft',
      ]),
    )
    // No other task changed.
    for (const t of before) {
      if (t.title === 'Renew the lab safety certificate') continue
      expect(stored(t.title).order).toBe(t.order)
    }
  })
})

describe('from your meetings', () => {
  it('adds an action item as a task due today, sourced from the meeting', async () => {
    await openList('/tasks/today')
    const section = await screen.findByTestId('from-meetings')
    const item = within(section).getAllByTestId('meeting-item')[0] as HTMLElement
    const text = item.querySelector('span span')?.textContent ?? ''
    await userEvent.click(within(item).getByTestId('meeting-item-add'))
    await waitFor(() =>
      expect(stored(text)).toMatchObject({ due: today(), source: { kind: 'meeting', text } }),
    )
    expect(
      await screen.findByText(text, { selector: '[data-testid="task-title"]' }),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(within(screen.getByTestId('from-meetings')).queryByText(text)).not.toBeInTheDocument(),
    )
  })
})

describe('import from Todoist', () => {
  it('imports by token, then skips what is already here, and takes CSV files', async () => {
    const zones: unknown[] = []
    server.events.on('request:start', ({ request }) => {
      if (request.url.endsWith('/import/todoist')) {
        void request
          .clone()
          .json()
          .then((b) => zones.push((b as { tz?: string }).tz))
      }
    })
    renderApp('/tasks/import')
    const token = await screen.findByTestId('todoist-token')
    await userEvent.type(token, 'secret-token')
    await userEvent.click(screen.getByTestId('todoist-import'))
    expect(await screen.findByTestId('todoist-result')).toHaveTextContent('Imported 3 tasks')
    expect(screen.getByTestId('todoist-result')).toHaveTextContent('Projects: Errands, Reading')
    expect(token).toHaveValue('')

    await userEvent.type(token, 'secret-token')
    await userEvent.click(screen.getByTestId('todoist-import'))
    await waitFor(() =>
      expect(screen.getByTestId('todoist-result')).toHaveTextContent(
        'Imported 0 tasks; skipped 3 already here',
      ),
    )

    const csv = new File(
      ['TYPE,CONTENT,DESCRIPTION,PRIORITY\ntask,Order reagents,,1\ntask,Label freezer,,4\n'],
      'Lab.csv',
      { type: 'text/csv' },
    )
    await userEvent.upload(screen.getByTestId('todoist-files'), csv)
    await waitFor(() =>
      expect(screen.getByTestId('todoist-result')).toHaveTextContent('Imported 2 tasks'),
    )
    expect(stored('Order reagents')).toMatchObject({ project: 'Lab', priority: 1 })
    // Every import says the member's zone, for floating times and the CSV's today.
    expect(zones).toEqual([memberTimeZone(), memberTimeZone(), memberTimeZone()])
    server.events.removeAllListeners()
  })
})

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { mockApi, TEST_USER } from '../test/mockServer'
import { renderApp } from '../test/renderApp'

async function palette(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard('{Control>}k{/Control}')
  return screen.findByTestId('cmdk')
}

describe('a doc in Command-K (P1)', () => {
  it('lists the doc’s actions under On this page and runs them', { timeout: 20_000 }, async () => {
    const user = userEvent.setup()
    renderApp('/docs/team/docs/plans/hiring.md')
    await screen.findByTestId('editor-content')
    const cmdk = await palette(user)
    const page = within(cmdk).getByRole('group', { name: 'On this page' })
    for (const id of ['doc-star', 'doc-copy-link', 'doc-reading', 'doc-history', 'doc-download']) {
      expect(within(page).getByTestId(`cmdk-command-${id}`)).toBeInTheDocument()
    }
    await user.click(within(page).getByTestId('cmdk-command-doc-star'))
    await waitFor(() =>
      expect(
        (mockApi().repo.stars.get(TEST_USER) ?? []).some((s) => s.path === 'docs/plans/hiring.md'),
      ).toBe(true),
    )
    const again = await palette(user)
    expect(within(again).getByTestId('cmdk-command-doc-star')).toHaveTextContent('Unstar this doc')
    await user.click(within(again).getByTestId('cmdk-command-doc-reading'))
    expect(await screen.findByTestId('reading-view')).toBeInTheDocument()
  })
})

describe('Tasks in Command-K (P2)', () => {
  it('acts on the selected task', async () => {
    const user = userEvent.setup()
    renderApp('/tasks')
    await waitFor(() => expect(screen.getAllByTestId('task-row').length).toBeGreaterThan(0))
    const first = screen.getAllByTestId('task-row')[0] as HTMLElement
    const title = within(first).getByTestId('task-title').textContent ?? ''
    await user.keyboard('j')
    const cmdk = await palette(user)
    const complete = within(cmdk).getByTestId('cmdk-command-tasks-complete')
    expect(complete).toHaveTextContent(`Complete “${title}”`)
    await user.click(complete)
    await waitFor(() =>
      expect([...mockApi().tasks.tasks.values()].find((t) => t.title === title)?.status).toBe(
        'done',
      ),
    )
  })

  it('offers Add a task with nothing selected', async () => {
    const user = userEvent.setup()
    renderApp('/tasks')
    await waitFor(() => expect(screen.getAllByTestId('task-row').length).toBeGreaterThan(0))
    const cmdk = await palette(user)
    expect(within(cmdk).queryByTestId('cmdk-command-tasks-complete')).toBeNull()
    await user.click(within(cmdk).getByTestId('cmdk-command-tasks-add'))
    expect(await screen.findByTestId('quick-add-input')).toBeInTheDocument()
  })
})

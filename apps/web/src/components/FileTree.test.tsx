import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { mockApi } from '../test/mockServer'
import { renderWithSession } from '../test/renderWithSession'
import { FileTree } from './FileTree'

/** The tree row for a path, once it has loaded. */
const item = (path: string) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-testid="tree-item"][data-path="${path}"]`)
    if (!el) throw new Error(`no tree item for ${path}`)
    return el
  })

function renderTree() {
  return renderWithSession(<FileTree space="team" activePath={null} />)
}

describe('FileTree', () => {
  it('lists the docs folder with folders first and expands a folder on click', async () => {
    renderTree()
    const plans = await item('docs/plans')
    const rows = screen.getAllByTestId('tree-item').map((el) => el.dataset.path)
    expect(rows.indexOf('docs/plans')).toBeLessThan(rows.indexOf('docs/welcome.md'))
    expect(screen.queryByText('.gitkeep')).toBeNull()

    expect(plans).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(plans)
    expect(plans).toHaveAttribute('aria-expanded', 'true')
    expect(await item('docs/plans/q4-plan.md')).toBeInTheDocument()

    await userEvent.click(plans)
    expect(plans).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('q4-plan')).toBeNull()
  })

  it('opens a doc on click', async () => {
    const { router } = renderTree()
    await userEvent.click(await item('docs/welcome.md'))
    expect(router.state.location.pathname).toBe('/docs/team/docs/welcome.md')
  })

  it('New doc opens an untitled doc without committing anything', async () => {
    const { router } = renderTree()
    await item('docs/welcome.md')
    const commitsBefore = mockApi().repo.space('team').commits.length
    await userEvent.click(screen.getByTestId('new-doc'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/docs/team/docs/untitled.md'))
    expect(router.state.location.state).toEqual({ newDoc: true })
    expect(mockApi().repo.space('team').commits.length).toBe(commitsBefore)
  })

  it('New doc picks a free name when untitled.md exists', async () => {
    mockApi()
      .repo.space('team')
      .commit(
        new Map([['docs/untitled.md', '# Untitled\n']]),
        {
          name: 'Sam',
          email: 'sam@example.test',
        },
        'docs: create "Untitled"',
      )
    const { router } = renderTree()
    await item('docs/untitled.md')
    await userEvent.click(screen.getByTestId('new-doc'))
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/docs/team/docs/untitled-2.md'),
    )
  })

  it('creates a folder from an inline name', async () => {
    renderTree()
    await item('docs/welcome.md')
    await userEvent.click(screen.getByTestId('new-folder'))
    await userEvent.type(screen.getByLabelText('New folder name'), 'Research Notes{Enter}')
    expect(await item('docs/research-notes')).toBeInTheDocument()
    expect(mockApi().repo.read('team', 'docs/research-notes/.gitkeep')).not.toBeNull()
  })

  it('renames a doc from the context menu', async () => {
    renderTree()
    fireEvent.contextMenu(await item('docs/welcome.md'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByLabelText('Rename welcome.md')
    await userEvent.clear(input)
    await userEvent.type(input, 'Start Here{Enter}')
    expect(await item('docs/start-here.md')).toBeInTheDocument()
    expect(mockApi().repo.read('team', 'docs/welcome.md')).toBeNull()
    expect(mockApi().repo.read('team', 'docs/start-here.md')?.content).toContain('# Welcome')
  })

  it('deletes a doc to the trash after confirming', async () => {
    renderTree()
    fireEvent.contextMenu(await item('docs/team-rituals.md'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const dialog = screen.getByRole('dialog', { name: 'Move to trash?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move to trash' }))
    await waitFor(() => expect(screen.queryByText('team-rituals')).toBeNull())
    const trashed = [...mockApi().repo.space('team').files.keys()].filter((p) =>
      p.startsWith('.trash/'),
    )
    expect(trashed.some((p) => p.endsWith('/docs/team-rituals.md'))).toBe(true)
  })

  it('moves a doc into a folder by drag and drop', async () => {
    renderTree()
    const source = await item('docs/team-rituals.md')
    const target = await item('docs/archive')
    const store = new Map<string, string>()
    const dataTransfer = {
      types: [] as string[],
      setData: (type: string, value: string) => {
        store.set(type, value)
        dataTransfer.types.push(type)
      },
      getData: (type: string) => store.get(type) ?? '',
      effectAllowed: 'all',
      dropEffect: 'none',
    }
    fireEvent.dragStart(source, { dataTransfer })
    fireEvent.dragOver(target, { dataTransfer })
    fireEvent.drop(target, { dataTransfer })
    await waitFor(() =>
      expect(mockApi().repo.read('team', 'docs/archive/team-rituals.md')).not.toBeNull(),
    )
    expect(mockApi().repo.read('team', 'docs/team-rituals.md')).toBeNull()
  })
})

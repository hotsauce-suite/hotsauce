import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import {
  inScope,
  ListBar,
  ListColumn,
  ListPanel,
  matchesName,
  scopeTabs,
  useScope,
} from './ListBar'

describe('matchesName', () => {
  it('wants every word typed, in any order and any case', () => {
    expect(matchesName('Lunch order form', 'ORDER lunch')).toBe(true)
    expect(matchesName('Lunch order form', 'lunch dinner')).toBe(false)
    expect(matchesName('Lunch order form', '   ')).toBe(true)
  })
})

describe('inScope', () => {
  it('sorts Personal from Team, and All takes both', () => {
    expect(inScope('all', 'ada', 'team')).toBe(true)
    expect(inScope('all', 'team', 'team')).toBe(true)
    expect(inScope('team', 'team', 'team')).toBe(true)
    expect(inScope('team', 'ada', 'team')).toBe(false)
    expect(inScope('mine', 'ada', 'team')).toBe(true)
    expect(inScope('mine', 'team', 'team')).toBe(false)
  })
})

function Scoped() {
  const [scope, setScope] = useScope(['all', 'mine', 'team'])
  const location = useLocation()
  return (
    <>
      <ListBar tabs={scopeTabs(['all', 'mine', 'team'], 'things')} tab={scope} onTab={setScope} />
      <output>{location.search}</output>
    </>
  )
}

describe('ListBar', () => {
  it('keeps the chosen tab in the address, and the first tab needs none', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/things?scope=team&q=x']}>
        <Scoped />
      </MemoryRouter>,
    )
    expect(screen.getByRole('tab', { name: 'Team' })).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByRole('tab', { name: 'Personal' }))
    expect(screen.getByRole('status')).toHaveTextContent('?scope=mine&q=x')
    await user.click(screen.getByRole('tab', { name: 'All' }))
    expect(screen.getByRole('status')).toHaveTextContent('?q=x')
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true')
  })

  it('moves between tabs with the arrow keys', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/things']}>
        <Scoped />
      </MemoryRouter>,
    )
    screen.getByRole('tab', { name: 'All' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Personal' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Personal' })).toHaveFocus()
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(screen.getByRole('tab', { name: 'Team' })).toHaveAttribute('aria-selected', 'true')
  })

  it('shows what a list has in place of tabs, and selects none when the view is not a tab', () => {
    render(
      <MemoryRouter>
        <ListBar tabs={[{ id: 'today', label: 'Today', to: '/tasks/today' }]} tab={null}>
          <nav aria-label="Folder">Team files</nav>
        </ListBar>
      </MemoryRouter>,
    )
    expect(screen.getByRole('navigation', { name: 'Folder' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Today' })).toHaveAttribute('aria-selected', 'false')
  })

  it('ignores a tab the list does not have', () => {
    render(
      <MemoryRouter initialEntries={['/things?scope=nope']}>
        <Scoped />
      </MemoryRouter>,
    )
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true')
  })

  it('has a named search that tells the page what was typed and when Enter is pressed', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const onSubmit = vi.fn()
    render(
      <MemoryRouter>
        <ListBar
          search={{ value: '', onChange, onSubmit, label: 'Search forms', testId: 'forms-search' }}
        />
      </MemoryRouter>,
    )
    await user.type(screen.getByRole('searchbox', { name: 'Search forms' }), 'a{Enter}')
    expect(onChange).toHaveBeenCalledWith('a')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('makes a tab with its own address a link', () => {
    render(
      <MemoryRouter>
        <ListBar tabs={[{ id: 'today', label: 'Today', to: '/tasks/today' }]} tab="today" />
      </MemoryRouter>,
    )
    expect(screen.getByRole('tab', { name: 'Today' })).toHaveAttribute('href', '/tasks/today')
  })
})

describe('ListPanel', () => {
  it('ties every tab to the list under it, and names the list by the chosen tab', () => {
    render(
      <MemoryRouter>
        <ListColumn width="reading">
          <ListBar tabs={scopeTabs(['all', 'mine', 'team'], 'things')} tab="team" />
          <ListPanel tab="team">The team's things</ListPanel>
        </ListColumn>
      </MemoryRouter>,
    )
    const panel = screen.getByRole('tabpanel', { name: 'Team' })
    expect(panel).toHaveTextContent("The team's things")
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab).toHaveAttribute('aria-controls', panel.id)
    }
  })

  it('has no name when the list on screen belongs to no tab', () => {
    render(
      <MemoryRouter>
        <ListColumn width="reading">
          <ListBar tabs={scopeTabs(['all', 'mine'], 'things')} tab={null} />
          <ListPanel tab={null}>A project</ListPanel>
        </ListColumn>
      </MemoryRouter>,
    )
    expect(screen.getByRole('tabpanel')).not.toHaveAttribute('aria-labelledby')
  })

  it('two lists on one page keep their own ids', () => {
    render(
      <MemoryRouter>
        <ListColumn width="reading">
          <ListBar tabs={scopeTabs(['all'], 'a')} tab="all" />
          <ListPanel tab="all">One</ListPanel>
        </ListColumn>
        <ListColumn width="reading">
          <ListBar tabs={scopeTabs(['all'], 'b')} tab="all" />
          <ListPanel tab="all">Two</ListPanel>
        </ListColumn>
      </MemoryRouter>,
    )
    const [one, two] = screen.getAllByRole('tabpanel')
    expect(one?.id).not.toBe(two?.id)
  })
})

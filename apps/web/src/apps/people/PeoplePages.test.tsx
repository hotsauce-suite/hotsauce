import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { api } from '../../api/client'
import { meetingsApi } from '../../api/meetings'
import { peopleApi } from '../../api/people'
import { renderApp } from '../../test/renderApp'

// People (ARCHITECTURE §17.5): the list, a person's page with its About note, a company's page.

describe('People', () => {
  it('lists people from meetings and the calendar, and finds one by company', async () => {
    renderApp('/people')
    const rows = await screen.findAllByTestId('people-row')
    const emails = rows.map((r) => r.dataset.email)
    expect(emails).toContain('dana@acme.com')
    // The member isn't one of their own people.
    expect(emails).not.toContain('ada@example.test')
    await userEvent.type(screen.getByTestId('people-search'), 'acme')
    await waitFor(() =>
      expect(screen.getAllByTestId('people-row').map((r) => r.dataset.email)).toEqual([
        'dana@acme.com',
      ]),
    )
    expect(screen.getByTestId('app-switch-people')).toHaveAttribute('aria-current', 'page')
  })

  it('P6/P7: a meeting attendee opens their page, which lists the meeting and keeps an About note', async () => {
    const list = await meetingsApi.list({ space: 'ada' })
    const acme = list.find((m) => m.title === 'Acme kickoff')
    if (!acme) throw new Error('seed is missing Acme kickoff')
    const { router } = renderApp(`/meetings/ada/${acme.path}`)
    const dana = (await screen.findAllByTestId('meeting-attendee')).find(
      (a) => a.textContent === 'Dana Lee',
    )
    if (!dana) throw new Error('no Dana link')
    await userEvent.click(dana)
    await waitFor(() => expect(router.state.location.pathname).toBe('/people/dana%40acme.com'))

    const page = await screen.findByTestId('person-page')
    // The name is in the top bar, once (docs/PLAN-consistency.md, requirement 20).
    expect(screen.getByTestId('page-header')).toHaveTextContent('Dana Lee')
    expect(within(page).queryByText('Dana Lee')).toBeNull()
    expect(within(page).getByTestId('person-company')).toHaveTextContent('acme.com')
    // One column at a doc's width, the cards stacked: About, what's next, then the history.
    expect(page.closest('[data-item-width="reading"]')).not.toBeNull()
    const cards = [...page.querySelectorAll('section[data-testid]')].map((c) =>
      c.getAttribute('data-testid'),
    )
    expect(cards).toEqual(['person-about', 'person-next', 'person-tasks', 'person-meetings'])
    const meetings = within(page).getAllByTestId('person-meeting')
    expect(meetings.map((m) => m.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Acme kickoff')]),
    )

    await userEvent.click(within(page).getByTestId('person-about-edit'))
    await userEvent.type(within(page).getByTestId('person-about-input'), 'Runs IT at Acme.')
    await userEvent.click(within(page).getByTestId('person-about-save'))
    expect(await within(page).findByTestId('person-about-text')).toHaveTextContent(
      'Runs IT at Acme.',
    )

    // A second save starts from the saved version, so it isn't refused as stale.
    await userEvent.click(within(page).getByTestId('person-about-edit'))
    await userEvent.type(within(page).getByTestId('person-about-input'), ' Prefers email.')
    await userEvent.click(within(page).getByTestId('person-about-save'))
    expect(await within(page).findByTestId('person-about-text')).toHaveTextContent(
      'Runs IT at Acme. Prefers email.',
    )

    await userEvent.click(within(page).getByTestId('person-company'))
    const company = await screen.findByTestId('company-page')
    expect(within(company).getByText('Dana Lee')).toBeInTheDocument()
    // Its cards stack too: one above the other, not side by side.
    expect(company.className).toMatch(/\bflex-col\b/)
    expect(company.className).not.toMatch(/grid|columns-/)
  })

  it('a save started before someone else’s is refused, even after the page reloads theirs', async () => {
    renderApp('/people/dana%40acme.com')
    const page = await screen.findByTestId('person-page')
    await userEvent.click(within(page).getByTestId('person-about-edit'))
    // A teammate saves first; a change elsewhere makes the page reload with their version.
    await peopleApi.saveAbout('dana@acme.com', 'From a teammate', null)
    await api.putFile('team', { path: 'docs/nudge.md', content: '# Nudge\n' })
    await waitFor(() => expect(within(page).getByTestId('person-about-input')).toBeInTheDocument())
    await new Promise((r) => setTimeout(r, 700))
    await userEvent.type(within(page).getByTestId('person-about-input'), 'Mine')
    await userEvent.click(within(page).getByTestId('person-about-save'))
    expect(await within(page).findByRole('alert')).toHaveTextContent('Someone else changed')
  })

  it('says so for someone who isn’t in anything you can read', async () => {
    renderApp('/people/nobody%40nowhere.test')
    expect(await screen.findByRole('alert')).toHaveTextContent('No one by that address')
  })
})

describe('keys (slice 5)', () => {
  it('j and k move through the people list', async () => {
    const user = userEvent.setup()
    renderApp('/people')
    const rows = await screen.findAllByTestId('people-row')
    await user.keyboard('j')
    expect(within(rows[0] as HTMLElement).getByRole('link')).toHaveFocus()
    await user.keyboard('jk')
    expect(within(rows[0] as HTMLElement).getByRole('link')).toHaveFocus()
  })
})

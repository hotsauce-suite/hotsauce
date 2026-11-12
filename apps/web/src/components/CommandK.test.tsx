import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { server } from '../test/mockServer'
import { renderWithSession } from '../test/renderWithSession'
import CommandK from './CommandK'

function renderPalette() {
  const onOpenChange = vi.fn()
  const view = renderWithSession(<CommandK open onOpenChange={onOpenChange} />)
  return { ...view, onOpenChange }
}

const resultPaths = () => screen.getAllByTestId('search-result').map((el) => el.dataset.path)

describe('CommandK', () => {
  it('lists title matches before full-text matches', async () => {
    renderPalette()
    await userEvent.type(screen.getByTestId('cmdk-input'), 'plan')
    await waitFor(() => expect(screen.getByText('In the text')).toBeInTheDocument())

    const titles = screen.getByRole('group', { name: 'Titles' })
    const text = screen.getByRole('group', { name: 'In the text' })
    expect(
      within(titles)
        .getAllByTestId('search-result')
        .map((el) => el.dataset.path),
    ).toEqual(['docs/plans/q4-plan.md', 'docs/plans/hiring.md'])
    expect(within(text).getAllByTestId('search-result').length).toBeGreaterThan(0)
    // Document order: every title result comes before every text result.
    const paths = resultPaths()
    expect(paths.slice(0, 2)).toEqual(['docs/plans/q4-plan.md', 'docs/plans/hiring.md'])
    expect(paths).toContain('docs/welcome.md')
  })

  it('shows a snippet for full-text results', async () => {
    renderPalette()
    await userEvent.type(screen.getByTestId('cmdk-input'), 'standup')
    const text = await screen.findByRole('group', { name: 'In the text' })
    const result = within(text).getByTestId('search-result')
    expect(result).toHaveTextContent('Standup is at 9:30')
    // The snippet's \u0002…\u0003 hit markers render as <mark>, not as raw characters.
    expect(within(result).getByText('Standup', { selector: 'mark' })).toBeInTheDocument()
    expect(result.textContent).not.toContain('\u0002')
    expect(result.textContent).not.toContain('\u0003')
  })

  it('Enter opens the selected result and closes the palette', async () => {
    const { router, onOpenChange } = renderPalette()
    await userEvent.type(screen.getByTestId('cmdk-input'), 'hiring')
    await waitFor(() => expect(resultPaths()[0]).toBe('docs/plans/hiring.md'))
    await userEvent.keyboard('{Enter}')
    expect(router.state.location.pathname).toBe('/docs/team/docs/plans/hiring.md')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('says so when nothing matches', async () => {
    renderPalette()
    await userEvent.type(screen.getByTestId('cmdk-input'), 'zebracorn')
    expect(await screen.findByText('Nothing matches “zebracorn”.')).toBeInTheDocument()
  })

  it('opens a meeting note, or the note of a matching transcript, on its meeting page', async () => {
    const note = 'meetings/2026/11/2026-11-08-acme-kickoff.md'
    server.use(
      http.get('/api/search', () =>
        HttpResponse.json([
          {
            space: 'ada',
            path: note.replace(/\.md$/, '.transcript.md'),
            title: 'Acme kickoff: transcript',
            snippet: 'we agreed on \u0002pricing\u0003',
            score: 2,
          },
          { space: 'ada', path: note, title: 'Acme kickoff', snippet: '', score: 1 },
        ]),
      ),
    )
    const { router } = renderPalette()
    await userEvent.type(screen.getByTestId('cmdk-input'), 'pricing')
    const text = await screen.findByRole('group', { name: 'In the text' })
    const [transcript] = within(text).getAllByTestId('search-result')
    expect(transcript).toHaveTextContent('Transcript ·')
    await userEvent.keyboard('{Enter}')
    expect(router.state.location.pathname).toBe(`/meetings/ada/${note}`)
  })
})

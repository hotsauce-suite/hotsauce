import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import ReadingView, { type ResolveImage } from './ReadingView'

function renderMarkdown(
  markdown: string,
  path = 'docs/eng/notes.md',
  resolveImage: ResolveImage = async (src) => src,
) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <ReadingView markdown={markdown} space="team" path={path} resolveImage={resolveImage} />
        ),
      },
      { path: '/docs/:space/*', element: <p>Opened</p> },
    ],
    { initialEntries: ['/'] },
  )
  render(<RouterProvider router={router} />)
  return router
}

describe('ReadingView', () => {
  it('renders callouts with their kind and title', () => {
    renderMarkdown('> [!warning] Mind the gap\n> Reagents ship slowly.\n\n> plain quote\n')
    const callout = screen.getByText('Mind the gap').closest('.callout')
    expect(callout).toHaveClass('callout-warning')
    expect(callout).toHaveTextContent('Reagents ship slowly.')
    expect(screen.getByText('plain quote').closest('blockquote')).not.toBeNull()
  })

  it('titles a bare callout by its kind', () => {
    renderMarkdown('> [!note]\n> Body only.\n')
    expect(screen.getByText('Note')).toHaveClass('callout-title')
  })

  it('renders GFM: tables, task lists, strikethrough; hides frontmatter', () => {
    renderMarkdown(
      '---\ntitle: Notes\n---\n\n# Notes\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n~~old~~\n',
    )
    expect(screen.getByTestId('reading-view')).not.toHaveTextContent('title: Notes')
    expect(screen.getByRole('table')).toHaveTextContent('1')
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    expect(screen.getByText('old').tagName).toBe('DEL')
  })

  it('opens relative doc links in the app', async () => {
    const router = renderMarkdown(
      'See [the plan](../plans/q4-plan.md) and [site](https://example.com).',
    )
    const link = screen.getByRole('link', { name: 'the plan' })
    expect(link).toHaveAttribute('href', '/docs/team/docs/plans/q4-plan.md')
    expect(screen.getByRole('link', { name: 'site' })).toHaveAttribute('target', '_blank')
    await userEvent.click(link)
    expect(router.state.location.pathname).toBe('/docs/team/docs/plans/q4-plan.md')
  })

  it('shows repo images through the document’s resolver, and says when one is missing', async () => {
    const resolveImage = vi.fn(async (src: string) => {
      if (src.includes('gone')) throw new Error('not found')
      return 'blob:hearth/chart'
    })
    renderMarkdown(
      '![Chart](../../assets/2026/10/chart.png)\n\n![Old](../../assets/gone.png)\n',
      'docs/eng/notes.md',
      resolveImage,
    )
    expect(await screen.findByRole('img', { name: 'Chart' })).toHaveAttribute(
      'src',
      'blob:hearth/chart',
    )
    expect(await screen.findByText(/Image not found: \.\.\/\.\.\/assets\/gone\.png/)).toBeVisible()
    expect(resolveImage).toHaveBeenCalledWith('../../assets/2026/10/chart.png')
  })

  it('highlights fenced code', () => {
    renderMarkdown('```ts\nconst answer = 42\n```\n')
    expect(document.querySelector('code.hljs .hljs-keyword')).toHaveTextContent('const')
  })
})

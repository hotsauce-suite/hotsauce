import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '../../test/mockServer'
import { renderApp } from '../../test/renderApp'
import { BRIEF_PROMPTS } from './AgentBrief'

describe('Agent brief page', () => {
  it('writes the brief, takes a correction into the next one, and offers prompts', async () => {
    const user = userEvent.setup()
    renderApp('/meetings/brief')
    expect(await screen.findByTestId('brief-empty')).toBeInTheDocument()

    await user.click(screen.getByTestId('brief-write'))
    const body = await screen.findByTestId('brief-body')
    for (const heading of ['Overview', 'Current priorities', 'People', 'Communication style']) {
      expect(within(body).getByRole('heading', { name: heading })).toBeInTheDocument()
    }
    expect(screen.getByTestId('brief-written')).toHaveTextContent(
      /Written today at .* from \d+ meetings? and 0 tasks/,
    )

    const notes = screen.getByTestId('brief-notes')
    expect(screen.getByTestId('brief-notes-rewrite')).toBeDisabled()
    await user.type(notes, 'I lead growth, not sales.')
    await user.click(screen.getByTestId('brief-notes-rewrite'))
    expect(
      await within(screen.getByTestId('brief-body')).findByText(
        /You said: I lead growth, not sales\./,
      ),
    ).toBeInTheDocument()
    expect(screen.getByTestId('brief-notes-rewrite')).toBeDisabled()

    const prompts = within(screen.getByTestId('brief-prompts')).getAllByRole('listitem')
    expect(prompts).toHaveLength(BRIEF_PROMPTS.length)
    const ask = within(prompts[0] as HTMLElement).getByRole('link', { name: /Ask Claude/ })
    expect(decodeURIComponent(ask.getAttribute('href') ?? '')).toContain(
      'agent brief first. What are my priorities right now?',
    )
    // The sidebar links here.
    expect(screen.getByRole('link', { name: 'Agent brief' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('saves a correction on its own', async () => {
    const user = userEvent.setup()
    renderApp('/meetings/brief')
    await user.type(await screen.findByTestId('brief-notes'), 'Call me Mo.')
    await user.click(screen.getByTestId('brief-notes-save'))
    expect(await screen.findByTestId('brief-message')).toHaveTextContent('Saved')
    expect(screen.getByTestId('brief-notes-save')).toBeDisabled()
  })

  it('says so when there is nothing to write from, and shows a refusal', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/brief/refresh', () =>
        HttpResponse.json({ status: 'empty', brief: null, notes: '' }),
      ),
    )
    renderApp('/meetings/brief')
    await user.click(await screen.findByTestId('brief-write'))
    expect(await screen.findByTestId('brief-message')).toHaveTextContent(
      'Nothing to write from yet',
    )

    server.use(
      http.post('/api/brief/refresh', () =>
        HttpResponse.json(
          { error: { code: 'not_configured', message: 'Add an Anthropic key first' } },
          { status: 503 },
        ),
      ),
    )
    await user.click(screen.getByTestId('brief-write'))
    expect(await screen.findByTestId('brief-error')).toHaveTextContent('Add an Anthropic key first')
  })

  it('never shows images the model wrote', async () => {
    server.use(
      http.get('/api/brief', () =>
        HttpResponse.json({
          brief: {
            space: 'ada',
            path: '.hearth/brief/brief.md',
            body: '## Overview\n\n![x](https://evil.test/p.png) You lead growth.',
            generated: new Date().toISOString(),
            model: 'fake',
            meetings: 1,
            tasks: 0,
          },
          notes: '',
        }),
      ),
    )
    renderApp('/meetings/brief')
    const body = await screen.findByTestId('brief-body')
    expect(body).toHaveTextContent('You lead growth.')
    expect(body.querySelector('img')).toBeNull()
  })
})

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { server } from '../../test/mockServer'
import AssistantPanel from './AssistantPanel'

/** An answer that streams one tool line, then nothing more until the request is aborted. */
function serveHangingAnswer() {
  server.use(
    http.get('*/api/assistant', () => HttpResponse.json({ name: 'Ask Acme', configured: true })),
    http.post('*/api/assistant/conversations/:id/messages', ({ request }) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const event = {
            type: 'tool',
            id: 't1',
            name: 'search',
            input: { query: 'x' },
            kind: 'read',
          }
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
          request.signal.addEventListener('abort', () => controller.error(new Error('aborted')))
        },
      })
      return new HttpResponse(stream, { headers: { 'content-type': 'text/event-stream' } })
    }),
  )
}

function renderPanel() {
  render(
    <MemoryRouter>
      <AssistantPanel open page={null} onClose={() => {}} />
    </MemoryRouter>,
  )
}

describe('the assistant panel', () => {
  it('starts a clean conversation when New is pressed mid-answer', async () => {
    serveHangingAnswer()
    renderPanel()
    await userEvent.type(screen.getByTestId('assistant-input'), 'Where is the plan?{Enter}')
    expect(await screen.findByTestId('assistant-tool')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'New conversation' }))
    await waitFor(() => expect(screen.queryByTestId('assistant-tool')).not.toBeInTheDocument())
    expect(screen.queryByText('Where is the plan?')).not.toBeInTheDocument()
    expect(screen.queryByText('Stopped.')).not.toBeInTheDocument()
  })

  it('says so when the answer is cut off', async () => {
    server.use(
      http.get('*/api/assistant', () => HttpResponse.json({ name: 'Ask Acme', configured: true })),
      http.post(
        '*/api/assistant/conversations/:id/messages',
        () =>
          new HttpResponse('data: {"type":"text","delta":"Half an ans"}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          }),
      ),
    )
    renderPanel()
    await userEvent.type(screen.getByTestId('assistant-input'), 'hello{Enter}')
    expect(await screen.findByText(/Half an ans/)).toBeInTheDocument()
    expect(await screen.findByText(/The answer was cut off/)).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId('assistant-messages')).toHaveAttribute('aria-busy', 'false'),
    )
  })
})

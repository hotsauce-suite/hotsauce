import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'
import type { ChatRoom } from '../../api/forms'
import { server } from '../../test/mockServer'
import { ChatRoomsSection } from './ChatRoomsSection'

// Settings → chat rooms: reading a room for context (docs/PLAN-chat-context.md R1, R7).

function serve(start: ChatRoom[]) {
  let rooms = start
  const patches: Array<{ id: string; read: boolean }> = []
  server.use(
    http.get('*/api/chat-rooms', () => HttpResponse.json({ rooms, canManage: true })),
    http.patch('*/api/chat-rooms/:id', async ({ params, request }) => {
      const { read } = (await request.json()) as { read: boolean }
      patches.push({ id: String(params.id), read })
      rooms = rooms.map((r) =>
        r.id === params.id
          ? {
              ...r,
              read,
              ...(read
                ? {
                    copy: {
                      messages: 120,
                      readAt: new Date().toISOString(),
                      error: null,
                      complete: true,
                    },
                  }
                : { copy: undefined }),
            }
          : r,
      )
      return HttpResponse.json(rooms.find((r) => r.id === params.id))
    }),
  )
  return patches
}

describe('ChatRoomsSection', () => {
  it('switches a bot room to read and shows how much is copied', async () => {
    const patches = serve([
      { id: 'a', name: 'General', last4: 'lack', readable: true, read: false },
      { id: 'b', name: 'Slack alerts', last4: 'xyz1', readable: false, read: false },
    ])
    render(<ChatRoomsSection />)
    const rows = await screen.findAllByTestId('chat-room')
    expect(within(rows[1]!).queryByTestId('chat-room-read')).toBeNull()
    await userEvent.click(
      within(rows[0]!).getByRole('switch', { name: 'Read General for context' }),
    )
    expect(patches).toEqual([{ id: 'a', read: true }])
    await waitFor(() =>
      expect(screen.getByTestId('chat-room-copy')).toHaveTextContent(
        '120 messages copied, read just now',
      ),
    )
  })

  it('says why a read room failed and keeps what was copied', async () => {
    serve([
      {
        id: 'a',
        name: 'General',
        last4: 'lack',
        readable: true,
        read: true,
        copy: { messages: 3, readAt: null, error: 'The chat refused the bot.', complete: true },
      },
    ])
    render(<ChatRoomsSection />)
    expect(await screen.findByTestId('chat-room-copy')).toHaveTextContent(
      'The chat refused the bot. 3 messages copied earlier are kept.',
    )
  })

  it('shows a first copy in progress', async () => {
    serve([{ id: 'a', name: 'General', last4: 'lack', readable: true, read: true }])
    render(<ChatRoomsSection />)
    expect(await screen.findByTestId('chat-room-copy')).toHaveTextContent('Copying the room…')
  })
})

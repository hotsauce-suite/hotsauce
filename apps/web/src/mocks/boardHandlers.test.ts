import { isId } from '@hearth/format'
import { describe, expect, it, vi } from 'vitest'
import { boardsApi } from '../api/boards'
import { getAuthHeaders, HearthApiError } from '../api/client'
import { BoardCollab, boardSocketUrl, browserCollabIO } from '../apps/boards/collab'
import { mockApi } from '../test/mockServer'

const textOf = (el: { text?: unknown }) => (typeof el.text === 'string' ? el.text : '')

describe('mock whiteboard', () => {
  it('lists the seeded team boards with their text', async () => {
    const boards = await boardsApi.list()
    expect(boards.map((b) => [b.space, b.title])).toEqual([
      ['ada', 'Pilot review agenda'],
      ['team', 'Pilot launch plan'],
      ['team', 'Onboarding retro, week 2'],
    ])
    expect(boards.every((b) => isId(b.id))).toBe(true)
    const plan = await boardsApi.get('team', boards[1]?.id ?? '')
    expect(plan.texts).toContain('Acme pilot launch plan')
    expect(plan.scene.elements.some((el) => el.type === 'arrow')).toBe(true)
    expect(await boardsApi.list({ q: 'retro' })).toHaveLength(1)
  })

  it('creates a board in the personal space, saves, renames and deletes it', async () => {
    const board = await boardsApi.create({})
    expect(board.space).toBe('ada')
    const rect = { id: 'r1', type: 'rectangle', version: 1, x: 0, y: 0, width: 10, height: 10 }
    const saved = await boardsApi.save('ada', board.id, {
      scene: { elements: [rect], appState: {}, files: {} },
      baseBlobOid: board.blobOid,
    })
    expect(saved.merged).toBe(false)
    expect(saved.blobOid).not.toBe(board.blobOid)
    const renamed = await boardsApi.save('ada', board.id, { title: '  Sketch  ' })
    expect(renamed.title).toBe('Sketch')
    expect(renamed.scene.elements.map((el) => el.id)).toEqual(['r1'])
    await boardsApi.remove('ada', board.id)
    await expect(boardsApi.get('ada', board.id)).rejects.toMatchObject({ status: 404 })
  })

  it('merges a save from an older version element by element', async () => {
    const board = await boardsApi.create({ space: 'team' })
    const a = { id: 'a', type: 'text', version: 1, text: 'one' }
    const first = await boardsApi.save('team', board.id, {
      scene: { elements: [a], appState: {}, files: {} },
      baseBlobOid: board.blobOid,
    })
    // Someone else, still on the empty board, adds their own shape.
    const b = { id: 'b', type: 'text', version: 1, text: 'two' }
    const second = await boardsApi.save('team', board.id, {
      scene: { elements: [b], appState: {}, files: {} },
      baseBlobOid: board.blobOid,
    })
    expect(first.merged).toBe(false)
    expect(second.merged).toBe(true)
    expect(second.scene.elements.map(textOf).sort()).toEqual(['one', 'two'])
  })

  it('refuses another member’s personal space and images outside assets/', async () => {
    await expect(boardsApi.create({ space: 'sam' })).rejects.toMatchObject({ status: 403 })
    const board = await boardsApi.create({})
    const err = await boardsApi
      .save('ada', board.id, {
        scene: {
          elements: [],
          appState: {},
          files: { f: { mimeType: 'image/png', path: 'x.png' } },
        },
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HearthApiError)
    expect((err as HearthApiError).status).toBe(400)
  })

  it('answers the board socket as a room with only you in it', async () => {
    const [board] = mockApi().boards.boards.values()
    const peers = vi.fn()
    const collab = new BoardCollab(
      boardSocketUrl(board?.space ?? 'team', board?.id ?? ''),
      browserCollabIO(async () => getAuthHeaders()),
      { scene: vi.fn(), pointer: vi.fn(), peers },
    )
    collab.start([])
    await vi.waitFor(() => expect(peers).toHaveBeenCalledWith([]))
    expect(collab.peerCount).toBe(0)
    collab.close()
  })
})

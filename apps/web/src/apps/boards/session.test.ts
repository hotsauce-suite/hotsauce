import { type BoardElement, type BoardScene, mergeScenes } from '@hearth/format'
import { describe, expect, it, vi } from 'vitest'
import type { BoardView } from '../../api/boards'
import {
  BoardSession,
  type LocalFile,
  type LocalScene,
  SAVE_DELAY_MS,
  type SessionIO,
} from './session'

function el(id: string, version: number, extra: Partial<BoardElement> = {}): BoardElement {
  return { id, type: 'rectangle', version, versionNonce: 1, ...extra }
}

function view(scene: BoardScene, blobOid: string): BoardView {
  return {
    space: 'team',
    path: 'boards/X.md',
    id: 'X',
    blobOid,
    title: 'T',
    created: '',
    createdBy: 'a@example.test',
    updated: '',
    updatedBy: null,
    scene,
    texts: [],
  }
}

/** A fake server holding one board, and a fake editor. */
function harness(initial: BoardElement[] = []) {
  let server: BoardScene = { elements: initial, appState: {}, files: {} }
  let oid = 1
  const local: LocalScene & { elements: BoardElement[]; files: Record<string, LocalFile> } = {
    elements: [...initial],
    appState: {},
    files: {},
  }
  const timers: Array<() => void> = []
  const statuses: string[] = []
  const uploads: string[] = []
  const io: SessionIO = {
    save: vi.fn(async ({ scene, baseBlobOid }) => {
      const merged = baseBlobOid !== `b${oid}`
      server = merged
        ? mergeScenes(server, scene)
        : { ...scene, appState: { ...server.appState, ...scene.appState } }
      oid++
      return { ...view(server, `b${oid}`), merged }
    }),
    load: async () => view(server, `b${oid}`),
    upload: async (f) => {
      uploads.push(f.id)
      return `assets/2026/11/${f.id}.png`
    },
    apply: (elements, _files, appState) => {
      local.elements = elements
      local.appState = { ...local.appState, ...appState } as LocalScene['appState']
    },
    current: () => local,
    onStatus: (s) => statuses.push(s),
    setTimer: (fn) => {
      timers.push(fn)
      return timers.length
    },
    clearTimer: () => {},
  }
  const session = new BoardSession(view(server, `b${oid}`), io)
  return {
    session,
    io,
    local,
    statuses,
    uploads,
    timers,
    remote: () => server,
    /** Someone else saves directly on the server. */
    otherSaves: (scene: BoardScene) => {
      server = mergeScenes(server, scene)
      oid++
    },
  }
}

describe('BoardSession', () => {
  it('ignores changes that save nothing (selection, pointer moves)', () => {
    const h = harness([el('a', 1)])
    h.session.changed()
    expect(h.timers).toHaveLength(0)
    expect(h.session.dirty()).toBe(false)
  })

  it(`saves ${SAVE_DELAY_MS} ms after a real change and becomes clean`, async () => {
    const h = harness()
    h.local.elements.push(el('a', 1))
    h.session.changed()
    expect(h.statuses.at(-1)).toBe('unsaved')
    expect(h.timers).toHaveLength(1)
    await h.session.flush()
    expect(h.io.save).toHaveBeenCalledTimes(1)
    expect(h.remote().elements.map((e) => e.id)).toEqual(['a'])
    expect(h.statuses.at(-1)).toBe('saved')
    expect(h.session.dirty()).toBe(false)
  })

  it('uploads a new image once and saves only its path', async () => {
    const h = harness()
    h.local.elements.push(el('img', 1, { type: 'image', fileId: 'f1' }))
    h.local.files.f1 = { id: 'f1', mimeType: 'image/png', dataURL: 'data:image/png;base64,AA' }
    await h.session.flush()
    h.local.elements[0] = el('img', 2, { type: 'image', fileId: 'f1' })
    await h.session.flush()
    expect(h.uploads).toEqual(['f1'])
    expect(h.remote().files).toEqual({
      f1: { mimeType: 'image/png', path: 'assets/2026/11/f1.png' },
    })
    expect(JSON.stringify(h.remote())).not.toContain('data:image')
  })

  it('merges when someone saved in between, keeps both, and shows theirs', async () => {
    const h = harness([el('a', 1)])
    h.otherSaves({ elements: [el('theirs', 1)], appState: {}, files: {} })
    h.local.elements.push(el('mine', 1))
    await h.session.flush()
    expect(h.local.elements.map((e) => e.id).sort()).toEqual(['a', 'mine', 'theirs'])
    expect(
      h
        .remote()
        .elements.map((e) => e.id)
        .sort(),
    ).toEqual(['a', 'mine', 'theirs'])
    expect(h.session.dirty()).toBe(false)
  })

  it('refresh brings in a remote change and keeps unsaved local work, then saves it', async () => {
    const h = harness([el('a', 1)])
    h.local.elements.push(el('mine', 1))
    h.otherSaves({
      elements: [el('a', 2, { x: 9 } as Partial<BoardElement>)],
      appState: {},
      files: {},
    })
    await h.session.refresh()
    expect(h.local.elements.find((e) => e.id === 'a')).toMatchObject({ version: 2 })
    expect(h.local.elements.map((e) => e.id)).toContain('mine')
    expect(h.session.dirty()).toBe(true)
    await h.session.flush()
    expect(
      h
        .remote()
        .elements.map((e) => e.id)
        .sort(),
    ).toEqual(['a', 'mine'])
  })

  it('a change during a save saves again afterwards', async () => {
    const h = harness()
    h.local.elements.push(el('a', 1))
    const first = h.session.flush()
    h.local.elements.push(el('b', 1))
    void h.session.flush()
    await first
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(h.remote().elements.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('a remote background change is shown and not saved back', async () => {
    const h = harness([el('a', 1)])
    h.local.appState = { viewBackgroundColor: '#ffffff', gridModeEnabled: false }
    h.otherSaves({ elements: [], appState: { viewBackgroundColor: '#ffc9c9' }, files: {} })
    await h.session.refresh()
    expect(h.local.appState.viewBackgroundColor).toBe('#ffc9c9')
    expect(h.session.dirty()).toBe(false)
    expect(h.timers).toHaveLength(0)
  })

  it('sends only the canvas settings it changed, so both people’s changes survive', async () => {
    const h = harness([el('a', 1)])
    h.local.appState = { viewBackgroundColor: '#ffffff', gridModeEnabled: false }
    h.otherSaves({ elements: [], appState: { viewBackgroundColor: '#ffc9c9' }, files: {} })
    h.local.appState = { viewBackgroundColor: '#ffffff', gridModeEnabled: true }
    await h.session.flush()
    expect(h.io.save).toHaveBeenCalledWith(
      expect.objectContaining({
        scene: expect.objectContaining({ appState: { gridModeEnabled: true } }),
      }),
    )
    expect(h.remote().appState).toEqual({ viewBackgroundColor: '#ffc9c9', gridModeEnabled: true })
    expect(h.local.appState.viewBackgroundColor).toBe('#ffc9c9')
  })

  it('a fresh board opened in the editor (its default settings) has nothing to save', () => {
    const h = harness([el('a', 1)])
    h.local.appState = { viewBackgroundColor: '#ffffff', gridModeEnabled: false }
    h.session.changed()
    expect(h.timers).toHaveLength(0)
  })

  it('a change from someone else that arrives during a save is fetched after it', async () => {
    const h = harness([el('a', 1)])
    h.local.elements.push(el('mine', 1))
    const saving = h.session.flush()
    h.otherSaves({ elements: [el('theirs', 1)], appState: {}, files: {} })
    await h.session.refresh()
    await saving
    await vi.waitFor(() => expect(h.local.elements.map((e) => e.id)).toContain('theirs'))
  })

  it('closing during a save still saves the change made meanwhile', async () => {
    const h = harness()
    h.local.elements.push(el('a', 1))
    void h.session.flush()
    h.local.elements.push(el('b', 1))
    await h.session.closeAfterFlush()
    expect(h.remote().elements.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('saves deleted shapes small and never an iframe', async () => {
    const h = harness()
    h.local.elements.push(
      el('gone', 3, { isDeleted: true, points: [[0, 0]] } as Partial<BoardElement>),
      el('frame', 1, { type: 'iframe' }),
    )
    await h.session.flush()
    expect(h.remote().elements).toEqual([
      { id: 'gone', type: 'rectangle', version: 3, versionNonce: 1, isDeleted: true },
    ])
  })

  it('reports a failed save', async () => {
    const h = harness()
    h.io.save = vi.fn(async () => {
      throw new Error('offline')
    })
    h.local.elements.push(el('a', 1))
    await expect(h.session.flush()).rejects.toThrow('offline')
    expect(h.statuses.at(-1)).toBe('error')
    expect(h.session.dirty()).toBe(true)
  })
})

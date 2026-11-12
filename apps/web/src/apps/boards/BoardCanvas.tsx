import './excalidrawAssets'
import '@excalidraw/excalidraw/index.css'
import {
  CaptureUpdateAction,
  Excalidraw,
  hashElementsVersion,
  MainMenu,
  reconcileElements,
  restoreElements,
} from '@excalidraw/excalidraw'
import type {
  BinaryFileData,
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId,
} from '@excalidraw/excalidraw/types'
import type { BoardElement, BoardFile } from '@hearth/format'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { type BoardView, boardsApi } from '../../api/boards'
import { api, getAuthHeaders } from '../../api/client'
import { hearthSocket } from '../../api/ws'
import {
  BoardCollab,
  boardSocketUrl,
  browserCollabIO,
  type Peer,
  type PointerUpdate,
  peerColor,
} from './collab'
import { BoardSession, type LocalFile, type LocalScene, type SaveStatus } from './session'

// Stable across renders: a new object makes Excalidraw update, and fire onChange, again.
const UI_OPTIONS = { canvasActions: { loadScene: false, saveToActiveFile: false } } as const

type Elements = NonNullable<Parameters<ExcalidrawImperativeAPI['updateScene']>[0]['elements']>

/** Follows Hearth's light/dark choice (data-theme on <html>, else the system setting). */
function isDark(): boolean {
  const set = document.documentElement.getAttribute('data-theme')
  if (set === 'dark') return true
  if (set === 'light') return false
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

function useDark(): boolean {
  const [dark, setDark] = useState(isDark)
  useEffect(() => {
    const update = () => setDark(isDark())
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    media?.addEventListener('change', update)
    return () => {
      observer.disconnect()
      media?.removeEventListener('change', update)
    }
  }, [])
  return dark
}

async function dataUrlOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

async function fileFromDataUrl(file: LocalFile): Promise<File> {
  const blob = await (await fetch(file.dataURL)).blob()
  const ext = file.mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png'
  return new File([blob], `board-image.${ext}`, { type: file.mimeType })
}

/** The images a board points at, read from its space and handed to Excalidraw. */
async function loadFiles(
  space: string,
  files: Record<string, BoardFile>,
  have: Set<string>,
): Promise<BinaryFileData[]> {
  const out: BinaryFileData[] = []
  await Promise.all(
    Object.entries(files)
      .filter(([id]) => !have.has(id))
      .map(async ([id, f]) => {
        try {
          const blob = await api.raw(space, f.path)
          out.push({
            id: id as BinaryFileData['id'],
            mimeType: f.mimeType as BinaryFileData['mimeType'],
            dataURL: (await dataUrlOf(blob)) as BinaryFileData['dataURL'],
            created: Date.now(),
          })
        } catch {
          // A missing image shows as Excalidraw's placeholder.
        }
      }),
  )
  return out
}

/** The scene as the editor has it now. */
function readScene(excalidraw: ExcalidrawImperativeAPI): LocalScene {
  const appState = excalidraw.getAppState()
  return {
    elements: excalidraw.getSceneElementsIncludingDeleted() as unknown as BoardElement[],
    appState: {
      viewBackgroundColor: appState.viewBackgroundColor,
      gridModeEnabled: appState.gridModeEnabled,
    },
    files: excalidraw.getFiles() as unknown as Record<string, LocalFile>,
  }
}

export interface BoardCanvasHandle {
  flush(): Promise<void>
  dirty(): boolean
}

/** The Excalidraw editor for one board, saving as it goes (ARCHITECTURE §15.4). */
export function BoardCanvas({
  board,
  onStatus,
  handle,
  onPeers,
}: {
  board: BoardView
  onStatus: (status: SaveStatus, error?: string) => void
  handle: (h: BoardCanvasHandle | null) => void
  /** Who else is on the board now (live drawing, §15.5). */
  onPeers?: (peers: Peer[]) => void
}) {
  const dark = useDark()
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI | null>(null)
  const status = useRef(onStatus)
  status.current = onStatus
  const sessionRef = useRef<BoardSession | null>(null)
  const collabRef = useRef<BoardCollab | null>(null)
  const peersCallback = useRef(onPeers)
  peersCallback.current = onPeers
  const [collaborating, setCollaborating] = useState(false)
  const wrap = useRef<HTMLDivElement | null>(null)
  // Excalidraw empties its scene when it unmounts, before this component's effects clean up. So
  // the last scene is kept here while the editor is still mounted (a layout effect's cleanup runs
  // first), and the final save reads that instead of the emptied editor.
  const editor = useRef<{ alive: boolean; last: LocalScene | null }>({ alive: false, last: null })

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the board, not its contents
  useLayoutEffect(() => {
    if (!excalidraw) return
    const state = editor.current
    state.alive = true
    return () => {
      state.last = readScene(excalidraw)
      state.alive = false
    }
  }, [excalidraw, board.id, board.space])

  // Only the board first loaded; later versions come in through the session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the board, not its contents
  const initialData = useMemo(
    () => ({
      elements: board.scene.elements as unknown as Elements,
      appState: {
        ...(board.scene.appState.viewBackgroundColor
          ? { viewBackgroundColor: board.scene.appState.viewBackgroundColor }
          : {}),
        gridModeEnabled: board.scene.appState.gridModeEnabled === true,
      },
      scrollToContent: true,
    }),
    [board.id, board.space],
  )

  // One session per open board.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the board, not its contents
  useEffect(() => {
    if (!excalidraw) return
    const { space, id, path } = board
    const loaded = new Set<string>()
    const addFiles = (files: Record<string, BoardFile>) =>
      void loadFiles(space, files, loaded).then((list) => {
        for (const f of list) loaded.add(f.id)
        if (list.length > 0) excalidraw.addFiles(list)
      })
    addFiles(board.scene.files)
    const session = new BoardSession(board, {
      save: (input) => boardsApi.save(space, id, input),
      load: () => boardsApi.get(space, id),
      upload: async (file) => (await api.uploadAsset(space, await fileFromDataUrl(file))).path,
      apply: (elements, files, appState) => {
        if (!editor.current.alive) return
        const current = excalidraw.getAppState()
        excalidraw.updateScene({
          // Restored like a loaded file, so shapes stored small (deleted ones) are whole again.
          elements: restoreElements(
            elements as unknown as Elements,
            excalidraw.getSceneElementsIncludingDeleted(),
          ) as unknown as Elements,
          appState: {
            viewBackgroundColor: appState.viewBackgroundColor ?? current.viewBackgroundColor,
            gridModeEnabled:
              typeof appState.gridModeEnabled === 'boolean'
                ? appState.gridModeEnabled
                : current.gridModeEnabled,
          },
          captureUpdate: CaptureUpdateAction.NEVER,
        })
        addFiles(files)
        // What came in with the save is not this editor's to send on; its own edits still are.
        const fromSave = new Set(elements.map((e) => e.id))
        collabRef.current?.seen(
          excalidraw
            .getSceneElementsIncludingDeleted()
            .filter((e) => fromSave.has(e.id)) as unknown as BoardElement[],
        )
      },
      current: () => {
        const state = editor.current
        if (!state.alive && state.last) return state.last
        return readScene(excalidraw)
      },
      onStatus: (s, e) => {
        if (s === 'saved') collabRef.current?.saved()
        status.current(s, e)
      },
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    })
    sessionRef.current = session
    handle({ flush: () => session.flush(), dirty: () => session.dirty() })
    // Live drawing together: strokes and pointers to and from the others on this board.
    const collaborators = new Map<SocketId, Collaborator>()
    const people = new Map<string, Peer>()
    // What others send is put on the canvas once per frame, not once per message.
    // Keyed by id, newest kept: two messages about one shape in a frame must not become two shapes.
    let incoming = new Map<string, BoardElement>()
    let pointersMoved = false
    let frame: number | null = null
    const paint = () => {
      frame = null
      if (!editor.current.alive) return
      // In stacking order, so restoring doesn't renumber (and re-version) shapes that are fine.
      const remote = [...incoming.values()].sort((a, b) => {
        const x = String(a.index ?? '')
        const y = String(b.index ?? '')
        return x < y ? -1 : x > y ? 1 : 0
      })
      incoming = new Map()
      let restored: readonly { id: string; version: number; versionNonce: number }[] = []
      const update: Parameters<ExcalidrawImperativeAPI['updateScene']>[0] = {
        captureUpdate: CaptureUpdateAction.NEVER,
      }
      if (remote.length > 0) {
        try {
          // Excalidraw's own merge: newer version wins, shape order follows each shape's index,
          // and what this editor is in the middle of editing stays as it is.
          restored = restoreElements(remote as unknown as Elements, null)
          const merged = reconcileElements(
            excalidraw.getSceneElementsIncludingDeleted(),
            restored as unknown as Parameters<typeof reconcileElements>[1],
            excalidraw.getAppState(),
          )
          update.elements = merged
        } catch (err) {
          // A shape that can't be drawn is skipped; the sender's save carries it.
          console.warn('Skipped a live update that could not be drawn', err)
        }
      }
      if (pointersMoved) update.collaborators = new Map(collaborators)
      pointersMoved = false
      if (!update.elements && !update.collaborators) return
      excalidraw.updateScene(update)
      if (update.elements) {
        // Read back what the canvas now holds for the shapes it took from the others (indices
        // fixed, empty text dropped) so none of it is sent back as this editor's change. Where
        // the merge kept this editor's own newer copy, that copy still has to go out.
        const taken = new Map(restored.map((e) => [e.id, `${e.version}:${e.versionNonce}`]))
        collab.seen(
          excalidraw
            .getSceneElementsIncludingDeleted()
            .filter(
              (e) => taken.get(e.id) === `${e.version}:${e.versionNonce}`,
            ) as unknown as BoardElement[],
        )
      }
    }
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(paint)
    }
    const collab = new BoardCollab(boardSocketUrl(space, id), browserCollabIO(getAuthHeaders), {
      scene: (remote) => {
        for (const el of remote) {
          const had = incoming.get(el.id)
          if (!had || newer(el, had)) incoming.set(el.id, el)
        }
        schedule()
      },
      pointer: (from, p: PointerUpdate) => {
        const peer = people.get(from)
        if (!peer) return
        collaborators.set(from as SocketId, {
          id: from,
          socketId: from as SocketId,
          username: peer.name,
          color: peerColor(peer.email),
          pointer: { x: p.x, y: p.y, tool: p.tool ?? 'pointer' },
          button: p.button ?? 'up',
        })
        pointersMoved = true
        schedule()
      },
      peers: (list) => {
        people.clear()
        for (const p of list) people.set(p.id, p)
        for (const key of [...collaborators.keys()]) if (!people.has(key)) collaborators.delete(key)
        pointersMoved = true
        schedule()
        setCollaborating(list.length > 0)
        peersCallback.current?.(list)
      },
    })
    collabRef.current = collab
    collab.start(excalidraw.getSceneElementsIncludingDeleted() as unknown as BoardElement[])
    // onChange fires for every pan, zoom and pointer move; only real changes do any work.
    let lastSeen = ''
    const offChange = excalidraw.onChange((elements, appState) => {
      const now = `${hashElementsVersion(elements)}:${appState.viewBackgroundColor}:${appState.gridModeEnabled}`
      if (now === lastSeen) return
      lastSeen = now
      session.changed()
      collab.changed(elements as unknown as BoardElement[])
      // How many shapes are on the board, for tests and tools; no React render.
      if (wrap.current)
        wrap.current.dataset.shapes = String(elements.filter((e) => !e.isDeleted).length)
    })
    // Someone else saved this board: bring their strokes in.
    const offSocket = hearthSocket.onChanged((e) => {
      if (e.space === space && e.paths.includes(path)) void session.refresh().catch(() => {})
    })
    const offReconnect = hearthSocket.onReconnect(() => void session.refresh().catch(() => {}))
    const onHide = () => {
      if (document.visibilityState === 'hidden') void session.flush().catch(() => {})
    }
    document.addEventListener('visibilitychange', onHide)
    return () => {
      offChange()
      if (frame !== null) cancelAnimationFrame(frame)
      collab.close()
      collabRef.current = null
      peersCallback.current?.([])
      offSocket()
      offReconnect()
      document.removeEventListener('visibilitychange', onHide)
      // Saves what's left (a save under way included), then stops.
      void session.closeAfterFlush().catch(() => {})
      sessionRef.current = null
      handle(null)
    }
  }, [excalidraw, board.id, board.space])

  return (
    <div className="board-canvas" data-testid="board-canvas" ref={wrap}>
      <Excalidraw
        excalidrawAPI={setExcalidraw}
        isCollaborating={collaborating}
        onPointerUpdate={(e) =>
          collabRef.current?.pointer({
            x: e.pointer.x,
            y: e.pointer.y,
            button: e.button,
            ...(e.pointer.tool === 'laser' ? { tool: 'laser' as const } : {}),
          })
        }
        initialData={initialData}
        theme={dark ? 'dark' : 'light'}
        name={board.title || 'Untitled board'}
        UIOptions={UI_OPTIONS}
        validateEmbeddable={false}
      >
        <MainMenu>
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw>
    </div>
  )
}

/** The same rule as a save: higher version, then the lower versionNonce on a tie. */
function newer(a: BoardElement, b: BoardElement): boolean {
  if (a.version !== b.version) return a.version > b.version
  return (a.versionNonce ?? 0) < (b.versionNonce ?? 0)
}

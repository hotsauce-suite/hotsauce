// The save and live-refresh loop for one open board (ARCHITECTURE §15.4), kept apart from
// Excalidraw so it can be tested on its own. The editor feeds it the scene on every change; it
// saves 2 s after the last one, uploads new images first, and merges in what others saved.

import {
  BLOCKED_ELEMENT_TYPES,
  type BoardElement,
  type BoardFile,
  type BoardScene,
  compactTombstone,
  mergeScenes,
} from '@hearth/format'
import type { BoardView } from '../../api/boards'

export const SAVE_DELAY_MS = 2000

/** One image as Excalidraw holds it. */
export interface LocalFile {
  id: string
  mimeType: string
  dataURL: string
}

/** What the editor hands over: every element (deleted ones too), the canvas settings, images. */
export interface LocalScene {
  elements: readonly BoardElement[]
  appState: { viewBackgroundColor?: string; gridModeEnabled?: boolean }
  files: Readonly<Record<string, LocalFile>>
}

export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error'

export interface SessionIO {
  save(input: { scene: BoardScene; baseBlobOid: string }): Promise<BoardView & { merged: boolean }>
  load(): Promise<BoardView>
  /** Stores an image in the board's space; answers its path. */
  upload(file: LocalFile): Promise<string>
  /** Puts elements and canvas settings into the open editor, without adding to its undo history. */
  apply(
    elements: BoardElement[],
    files: Record<string, BoardFile>,
    appState: BoardScene['appState'],
  ): void
  /** The scene as the editor has it now. */
  current(): LocalScene
  onStatus(status: SaveStatus, error?: string): void
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

/** A cheap fingerprint of what would be saved: ids and versions, background, images. */
export function signature(
  scene: { elements: readonly BoardElement[]; appState: BoardScene['appState'] },
  fileIds: Iterable<string>,
): string {
  const els = scene.elements.map((e) => `${e.id}:${e.version}:${e.versionNonce ?? 0}`).join(',')
  // Excalidraw's defaults, so a board saved without settings matches a freshly opened editor.
  const app = `${scene.appState.viewBackgroundColor ?? '#ffffff'}|${scene.appState.gridModeEnabled === true}`
  return `${els}#${app}#${[...fileIds].sort().join(',')}`
}

/** The canvas settings a board saves, with Excalidraw's defaults filled in. */
function canvasSettings(app: LocalScene['appState'] | BoardScene['appState']) {
  return {
    viewBackgroundColor: (app.viewBackgroundColor as string | undefined) ?? '#ffffff',
    gridModeEnabled: app.gridModeEnabled === true,
  }
}

/** Images live elements use. */
function usedFileIds(elements: readonly BoardElement[]): Set<string> {
  return new Set(elements.filter((e) => !e.isDeleted && e.fileId).map((e) => e.fileId as string))
}

export class BoardSession {
  #base: string
  #saved: string
  /** The canvas settings as last saved: a save sends only the ones changed since. */
  #savedApp: ReturnType<typeof canvasSettings>
  /** Images already stored, by Excalidraw file id. */
  readonly #stored = new Map<string, BoardFile>()
  readonly #io: SessionIO
  #timer: unknown = null
  #saving: Promise<void> | null = null
  #again = false
  #refreshAgain = false
  #closed = false

  constructor(board: BoardView, io: SessionIO) {
    this.#io = io
    this.#base = board.blobOid
    for (const [id, f] of Object.entries(board.scene.files)) this.#stored.set(id, f)
    this.#saved = signature(board.scene, Object.keys(board.scene.files))
    this.#savedApp = canvasSettings(board.scene.appState)
  }

  get baseBlobOid(): string {
    return this.#base
  }

  /** The editor changed something (or maybe only the selection): save soon if it matters. */
  changed(): void {
    if (this.#closed) return
    if (this.#localSignature() === this.#saved) return
    this.#io.onStatus('unsaved')
    if (this.#timer !== null) this.#io.clearTimer(this.#timer)
    this.#timer = this.#io.setTimer(() => {
      this.#timer = null
      void this.flush()
    }, SAVE_DELAY_MS)
  }

  /** Whether there is anything not yet saved. */
  dirty(): boolean {
    return this.#localSignature() !== this.#saved || this.#saving !== null
  }

  /** Saves now (one save at a time; a change during a save saves again after it). */
  flush(): Promise<void> {
    if (this.#timer !== null) {
      this.#io.clearTimer(this.#timer)
      this.#timer = null
    }
    if (this.#saving) {
      this.#again = true
      return this.#saving
    }
    const run = this.#save().finally(() => {
      this.#saving = null
      if (this.#again) {
        // A change came in during the save; it is saved even if the board was closed meanwhile.
        this.#again = false
        void this.flush().catch(() => {})
      } else if (this.#refreshAgain && !this.#closed) {
        this.#refreshAgain = false
        void this.refresh().catch(() => {})
      }
    })
    this.#saving = run
    return run
  }

  /** Someone saved this board (a socket event): bring their changes in, keep ours. */
  async refresh(): Promise<void> {
    if (this.#closed) return
    if (this.#saving) {
      // Look again once the save is done, so a change from someone else isn't missed.
      this.#refreshAgain = true
      return
    }
    const base = this.#base
    const remote = await this.#io.load()
    if (this.#closed || remote.blobOid === this.#base) return
    if (this.#saving || this.#base !== base) {
      // A save ran meanwhile, so `remote` may be older than what we have: look again after it.
      this.#refreshAgain = true
      if (!this.#saving) void this.refresh().catch(() => {})
      return
    }
    this.#adopt(remote)
  }

  /** Saves what's left, then stops. */
  async closeAfterFlush(): Promise<void> {
    try {
      await this.flush()
      while (this.#saving) await this.#saving
    } finally {
      this.close()
    }
  }

  close(): void {
    this.#closed = true
    if (this.#timer !== null) this.#io.clearTimer(this.#timer)
    this.#timer = null
  }

  #localSignature(): string {
    const local = this.#io.current()
    return signature(
      { elements: local.elements, appState: local.appState },
      usedFileIds(local.elements),
    )
  }

  async #save(): Promise<void> {
    const local = this.#io.current()
    const sig = this.#localSignature()
    if (sig === this.#saved) {
      this.#io.onStatus('saved')
      return
    }
    this.#io.onStatus('saving')
    try {
      const files: Record<string, BoardFile> = {}
      for (const id of usedFileIds(local.elements)) {
        let stored = this.#stored.get(id)
        const file = local.files[id]
        if (!stored && file) {
          stored = { mimeType: file.mimeType, path: await this.#io.upload(file) }
          this.#stored.set(id, stored)
        }
        if (stored) files[id] = stored
      }
      const now = canvasSettings(local.appState)
      // Only settings changed here are sent, so a stale copy never undoes someone else's.
      const changedSettings: BoardScene['appState'] = {}
      if (now.viewBackgroundColor !== this.#savedApp.viewBackgroundColor)
        changedSettings.viewBackgroundColor = now.viewBackgroundColor
      if (now.gridModeEnabled !== this.#savedApp.gridModeEnabled)
        changedSettings.gridModeEnabled = now.gridModeEnabled
      const scene: BoardScene = {
        elements: local.elements
          .filter((e) => !BLOCKED_ELEMENT_TYPES.has(e.type))
          .map((e) => compactTombstone({ ...e })),
        appState: changedSettings,
        files,
      }
      const res = await this.#io.save({ scene, baseBlobOid: this.#base })
      this.#base = res.blobOid
      if (this.#closed) {
        this.#saved = sig
        return
      }
      if (res.merged) this.#adopt(res)
      else {
        this.#saved = sig
        this.#savedApp = now
      }
      this.#io.onStatus(this.#localSignature() === this.#saved ? 'saved' : 'unsaved')
    } catch (err) {
      this.#io.onStatus('error', err instanceof Error ? err.message : 'Couldn’t save the board')
      throw err
    }
  }

  /** `remote` is the board as saved; merge it with what the editor has and show the result. */
  #adopt(remote: BoardView): void {
    for (const [id, f] of Object.entries(remote.scene.files)) this.#stored.set(id, f)
    const local = this.#io.current()
    const mine: BoardScene = { elements: [...local.elements], appState: {}, files: {} }
    const byId = new Map(local.elements.map((e) => [e.id, e]))
    // On an exact tie keep the editor's own copy: the saved one may be a shrunk deleted shape.
    const merged = mergeScenes(remote.scene, mine).elements.map((e) => {
      const l = byId.get(e.id)
      return l && l.version === e.version && (l.versionNonce ?? 0) === (e.versionNonce ?? 0) ? l : e
    })
    this.#base = remote.blobOid
    this.#savedApp = canvasSettings(remote.scene.appState)
    this.#saved = signature(remote.scene, Object.keys(remote.scene.files))
    this.#io.apply(merged, remote.scene.files, remote.scene.appState)
    // Ours had something theirs didn't: save it on top.
    if (this.#localSignature() !== this.#saved) this.changed()
  }
}

// Tells the open Files page what the sidebar asked for, and other pages that files changed.

export type FilesEvent = { type: 'pick-upload' } | { type: 'changed' }

const listeners = new Set<(e: FilesEvent) => void>()

export const filesBus = {
  emit(e: FilesEvent): void {
    for (const l of listeners) l(e)
  },
  on(listener: (e: FilesEvent) => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}

// Excalidraw loads its fonts from EXCALIDRAW_ASSET_PATH; Hearth serves them itself (the build
// copies them to /excalidraw/fonts), so a board never reaches out to a CDN. This module must be
// imported before Excalidraw.
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string
  }
}
window.EXCALIDRAW_ASSET_PATH = '/excalidraw/'

export {}

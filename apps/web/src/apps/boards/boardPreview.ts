// A board drawn as an SVG, for showing it inside a doc (ARCHITECTURE §15.5). Loaded only when a
// doc embeds a board, so Excalidraw stays out of the Docs chunk.
import './excalidrawAssets'
import { exportToSvg } from '@excalidraw/excalidraw'
import { boardIdOf, liveElements } from '@hearth/format'
import { boardsApi } from '../../api/boards'
import { api } from '../../api/client'

type ExportArgs = Parameters<typeof exportToSvg>[0]

async function dataUrlOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** The board at `path` in `space` as an SVG data: URL. */
export async function boardPreviewUrl(space: string, path: string): Promise<string> {
  const id = boardIdOf(path)
  if (!id) throw new Error(`${path} isn’t a board`)
  const board = await boardsApi.get(space, id)
  const files: Record<string, unknown> = {}
  await Promise.all(
    Object.entries(board.scene.files).map(async ([fileId, f]) => {
      try {
        files[fileId] = {
          id: fileId,
          mimeType: f.mimeType,
          dataURL: await dataUrlOf(await api.raw(space, f.path)),
          created: 0,
        }
      } catch {
        // Drawn without the missing image.
      }
    }),
  )
  const dark = document.documentElement.getAttribute('data-theme') === 'dark'
  const svg = await exportToSvg({
    elements: liveElements(board.scene) as unknown as ExportArgs['elements'],
    appState: {
      exportBackground: true,
      viewBackgroundColor: board.scene.appState.viewBackgroundColor ?? '#ffffff',
      exportWithDarkMode: dark,
    },
    files: files as ExportArgs['files'],
    exportPadding: 16,
  })
  svg.setAttribute('role', 'img')
  const text = new XMLSerializer().serializeToString(svg)
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return `data:image/svg+xml;base64,${btoa(binary)}`
}

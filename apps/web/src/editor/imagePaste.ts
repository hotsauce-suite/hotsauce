import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

export interface ImageUploadOptions {
  /** Uploads the file and returns the href to write into the document. */
  upload: (file: File) => Promise<string>
  onError: (message: string) => void
}

function imageFiles(data: DataTransfer | null): File[] {
  return [...(data?.files ?? [])].filter((file) => file.type.startsWith('image/'))
}

let uploadCounter = 0

async function insertUploads(
  view: EditorView,
  files: File[],
  at: number,
  opts: ImageUploadOptions,
) {
  let pos = at
  for (const file of files) {
    if (file.size > MAX_IMAGE_BYTES) {
      opts.onError(`${file.name} is larger than 10 MB, so it wasn’t added.`)
      continue
    }
    uploadCounter += 1
    const alt = file.name.replace(/\.[^.]+$/, '') || 'image'
    const placeholder = `![Uploading ${alt} (${uploadCounter})…]()`
    view.dispatch({
      changes: { from: pos, insert: placeholder },
      selection: { anchor: pos + placeholder.length },
      userEvent: 'input.paste',
    })
    pos += placeholder.length
    let replacement = ''
    try {
      replacement = `![${alt}](${await opts.upload(file)})`
    } catch (err) {
      opts.onError(err instanceof Error ? err.message : `Couldn’t upload ${file.name}.`)
    }
    // The user may have typed meanwhile, so find the placeholder again rather than trusting `pos`.
    const index = view.state.doc.toString().indexOf(placeholder)
    if (index === -1) continue
    view.dispatch({
      changes: { from: index, to: index + placeholder.length, insert: replacement },
      userEvent: 'input.paste',
    })
    pos = index + replacement.length
  }
}

/** Paste or drop an image → upload it → link it at the cursor (or drop point). */
export function imageUpload(opts: ImageUploadOptions): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const files = imageFiles(event.clipboardData)
      if (files.length === 0) return false
      event.preventDefault()
      void insertUploads(view, files, view.state.selection.main.head, opts)
      return true
    },
    drop(event, view) {
      const files = imageFiles(event.dataTransfer)
      if (files.length === 0) return false
      event.preventDefault()
      const at =
        view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head
      void insertUploads(view, files, at, opts)
      return true
    },
  })
}

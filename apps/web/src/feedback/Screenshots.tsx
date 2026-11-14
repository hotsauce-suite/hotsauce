import {
  type ClipboardEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Icon } from '../components/Icon'
import { shrinkImage } from './shrink'

// Pictures on a Send feedback item (docs/PLAN-feedback-screenshots.md S6–S9).

export const MAX_SHOTS = 3
const MAX_SHOT_BYTES = 5 * 1024 * 1024

export interface Shot {
  id: number
  blob: Blob
  url: string
  /** The picture of the page they were on (offered again if removed). */
  page: boolean
}

export interface Screenshots {
  shots: Shot[]
  /** The page picture, while it's on offer (there is one and it isn't attached). */
  pageOffer: { url: string } | null
  attachPage: () => void
  add: (files: Iterable<Blob>) => void
  remove: (id: number) => void
  clear: () => void
  error: string | null
  dragging: boolean
  /** Spread on the form: paste and drop pictures anywhere on it. */
  formProps: {
    onPaste: (event: ClipboardEvent) => void
    onDragOver: (event: DragEvent) => void
    onDragLeave: (event: DragEvent) => void
    onDrop: (event: DragEvent) => void
  }
}

let nextId = 0

export function useScreenshots(page: Blob | null): Screenshots {
  const [shots, setShots] = useState<Shot[]>([])
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  // Pictures still shrinking hold their place, so quick adds can't pass three.
  const taken = useRef(0)
  const shotsRef = useRef(shots)
  shotsRef.current = shots

  const pageUrl = useMemo(() => (page ? URL.createObjectURL(page) : null), [page])
  useEffect(() => () => (pageUrl ? URL.revokeObjectURL(pageUrl) : undefined), [pageUrl])
  useEffect(
    () => () => {
      for (const s of shotsRef.current) URL.revokeObjectURL(s.url)
    },
    [],
  )

  const put = useCallback((blobs: Blob[], isPage: boolean) => {
    setError(null)
    const images = blobs.filter((b) => b.type.startsWith('image/'))
    if (images.length < blobs.length) setError('Only pictures can be attached.')
    const room = MAX_SHOTS - taken.current
    if (images.length > room) setError(`You can attach up to ${MAX_SHOTS} pictures.`)
    const accepted = images.slice(0, Math.max(0, room))
    taken.current += accepted.length
    for (const original of accepted) {
      void shrinkImage(original).then((blob) => {
        if (blob.size > MAX_SHOT_BYTES) {
          taken.current--
          setError('That picture is too big to send (5 MB at most).')
          return
        }
        const shot = { id: ++nextId, blob, url: URL.createObjectURL(blob), page: isPage }
        setShots((all) => [...all, shot])
      })
    }
  }, [])

  const remove = useCallback((id: number) => {
    setError(null)
    setShots((all) => {
      const gone = all.find((s) => s.id === id)
      if (gone) {
        URL.revokeObjectURL(gone.url)
        taken.current--
      }
      return all.filter((s) => s.id !== id)
    })
  }, [])

  const clear = useCallback(() => {
    for (const s of shotsRef.current) URL.revokeObjectURL(s.url)
    taken.current = 0
    setShots([])
    setError(null)
  }, [])

  const pageAttached = shots.some((s) => s.page)
  const pageOffer = pageUrl && !pageAttached && shots.length < MAX_SHOTS ? { url: pageUrl } : null

  return {
    shots,
    pageOffer,
    attachPage: () => (page && !pageAttached ? put([page], true) : undefined),
    add: (files) => put([...files], false),
    remove,
    clear,
    error,
    dragging,
    formProps: {
      onPaste: (event) => {
        const files = [...event.clipboardData.files]
        if (files.some((f) => f.type.startsWith('image/'))) {
          event.preventDefault()
          put(files, false)
        }
      },
      onDragOver: (event) => {
        if (![...event.dataTransfer.types].includes('Files')) return
        event.preventDefault()
        setDragging(true)
      },
      onDragLeave: (event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDragging(false)
      },
      onDrop: (event) => {
        setDragging(false)
        const files = [...event.dataTransfer.files]
        if (files.length === 0) return
        event.preventDefault()
        put(files, false)
      },
    },
  }
}

/** The pictures row under the text box: the page picture on offer, thumbnails and Add screenshot. */
export function ScreenshotPicker({ state, disabled }: { state: Screenshots; disabled: boolean }) {
  const { shots, pageOffer } = state
  return (
    <div className="flex flex-col gap-2" data-testid="feedback-shots">
      {pageOffer ? (
        <div
          data-testid="feedback-page-shot"
          className="flex items-center gap-3 rounded-lg border border-dashed border-ash-strong p-2"
        >
          <img
            src={pageOffer.url}
            alt="The page you were on"
            className="h-14 w-20 shrink-0 rounded border border-ash object-cover object-top"
          />
          <button
            type="button"
            disabled={disabled}
            onClick={state.attachPage}
            className="flex items-center gap-1.5 text-left text-sm text-ink-soft hover:text-ember"
          >
            <Icon name="plus" className="size-4 shrink-0" />
            Add a picture of the page you were on
          </button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {shots.map((shot, i) => (
          <div
            key={shot.id}
            data-testid="feedback-shot"
            className="relative size-20 overflow-hidden rounded-lg border border-ash bg-paper-sunk"
          >
            <img
              src={shot.url}
              alt={`Screenshot ${i + 1}`}
              className="size-full object-cover object-top"
            />
            <button
              type="button"
              aria-label={`Remove screenshot ${i + 1}`}
              title="Remove"
              disabled={disabled}
              onClick={() => state.remove(shot.id)}
              className="absolute top-1 right-1 grid size-6 place-items-center rounded-full bg-ink/70 text-paper-raised hover:bg-ink"
            >
              <Icon name="close" className="size-3.5" />
            </button>
          </div>
        ))}
        {shots.length < MAX_SHOTS ? (
          <label
            className={`flex h-10 cursor-pointer items-center gap-1.5 rounded-lg border border-ash-strong px-3 text-sm text-ink-soft hover:border-ember has-focus-visible:outline-2 has-focus-visible:outline-ember ${
              disabled ? 'pointer-events-none opacity-50' : ''
            }`}
          >
            <Icon name="image" className="size-4" />
            Add screenshot
            <input
              type="file"
              accept="image/*"
              multiple
              aria-label="Add screenshot"
              data-testid="feedback-shot-input"
              disabled={disabled}
              className="sr-only"
              onChange={(e) => {
                state.add(e.target.files ?? [])
                e.target.value = ''
              }}
            />
          </label>
        ) : null}
      </div>
      {state.error ? (
        <p role="status" className="text-xs text-ember-strong">
          {state.error}
        </p>
      ) : null}
    </div>
  )
}

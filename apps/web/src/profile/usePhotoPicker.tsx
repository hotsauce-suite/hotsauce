import { type ReactNode, useRef, useState } from 'react'
import { HotsauceApiError } from '../api/client'
import { useSession } from '../state/session'
import { photoApi, refusal, type Square, squarePhoto } from './photo'

/**
 * Choosing and removing the member's own photo: `choose()` opens the file picker, `input` is its
 * hidden field (render it once, anywhere), and the session's photo changes as soon as the server
 * has it.
 */
export function usePhotoPicker(square: Square = squarePhoto): {
  input: ReactNode
  choose: () => void
  remove: () => Promise<void>
  busy: boolean
  error: string | null
  /** Forgets the last refusal (a menu opening again starts clean). */
  clearError: () => void
} {
  const session = useSession()
  const ref = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (work: () => Promise<{ photo: string | null }>, failed: string) => {
    setBusy(true)
    setError(null)
    try {
      session.setPhoto((await work()).photo)
    } catch (err) {
      // The server's own words when it refused (too big, not an image); ours otherwise.
      setError(
        err instanceof HotsauceApiError && err.status < 500 && err.status > 0
          ? err.message
          : failed,
      )
    } finally {
      setBusy(false)
    }
  }

  const picked = async (file: File | undefined) => {
    if (!file) return
    const no = refusal(file)
    if (no) {
      setError(no)
      return
    }
    await run(async () => {
      let small: Blob
      try {
        small = await square(file)
      } catch {
        throw new HotsauceApiError(
          'bad_request',
          'That file isn’t a picture this browser can read.',
          400,
        )
      }
      return photoApi.set(small)
    }, 'Couldn’t save the photo. Try again.')
  }

  const input = (
    <input
      ref={ref}
      type="file"
      accept="image/jpeg,image/png,image/webp,image/heic,image/*"
      aria-label="Choose a profile photo"
      data-testid="photo-input"
      hidden
      onChange={(event) => {
        const file = event.currentTarget.files?.[0]
        // The same file can be picked again after a failure.
        event.currentTarget.value = ''
        void picked(file)
      }}
    />
  )
  return {
    input,
    choose: () => ref.current?.click(),
    remove: () => run(() => photoApi.remove(), 'Couldn’t remove the photo. Try again.'),
    busy,
    error,
    clearError: () => setError(null),
  }
}

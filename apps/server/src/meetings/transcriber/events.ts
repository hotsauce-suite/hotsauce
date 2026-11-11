import type { TranscriberSession, TranscriptSegment } from './types.js'

/** The `on()` half of a TranscriberSession, shared by the fake and Deepgram. */
export class SessionEvents {
  readonly #segment = new Set<(seg: TranscriptSegment) => void>()
  readonly #error = new Set<(err: Error) => void>()

  on: TranscriberSession['on'] = (
    event: 'segment' | 'error',
    cb: ((seg: TranscriptSegment) => void) | ((err: Error) => void),
  ) => {
    const set = (event === 'segment' ? this.#segment : this.#error) as Set<typeof cb>
    set.add(cb)
    return () => {
      set.delete(cb)
    }
  }

  segment(seg: TranscriptSegment): void {
    for (const cb of this.#segment) cb(seg)
  }

  error(err: Error): void {
    for (const cb of this.#error) cb(err)
  }

  clear(): void {
    this.#segment.clear()
    this.#error.clear()
  }
}

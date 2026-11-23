// What a writer needs besides the doc's tree, gathered beforehand (prepare.ts in the browser,
// plain objects in tests), so both writers stay pure functions of their inputs.

/** An image ready to place: PNG or JPEG bytes and its size in pixels. */
export interface ReadyImage {
  bytes: Uint8Array
  type: 'png' | 'jpg'
  width: number
  height: number
}

/** One family's TTF files; a missing style falls back to regular, a missing regular to none. */
export interface FontFiles {
  regular?: Uint8Array
  bold?: Uint8Array
  italic?: Uint8Array
  boldItalic?: Uint8Array
}

export interface TaskLine {
  title: string
  done: boolean
}

export interface BrandLook {
  orgName: string
  /** Six-digit hex, `#c63d19`. */
  primary: string
  displayFont: string
  uiFont: string
  logo: ReadyImage | null
}

export interface DownloadInputs {
  brand: BrandLook
  fonts: { display: FontFiles; ui: FontFiles }
  /** Keyed by the image's `src` as the doc writes it; null when it couldn't be loaded. */
  images: ReadonlyMap<string, ReadyImage | null>
  /** Keyed by a `tasks` block's query. */
  tasks: ReadonlyMap<string, TaskLine[]>
}

/** Ink and quiet colours shared by both files, so they look alike. */
export const INK = '#1e1b18'
export const INK_SOFT = '#5b544c'
export const RULE = '#d9d1c7'
export const CODE_BG = '#f4f0ea'

/** `#c63d19` mixed toward white, for the table header's wash. */
export function wash(hex: string, amount = 0.88): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const mix = (c: number) => Math.round(c + (255 - c) * amount)
  const r = mix((n >> 16) & 255)
  const g = mix((n >> 8) & 255)
  const b = mix(n & 255)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

/** A file name from the doc's title: no characters a file system refuses. */
export function fileName(title: string, ext: 'docx' | 'pdf'): string {
  const clean = title
    .replace(/[\\/:*?"<>|]/g, ' ')
    // Tabs, newlines and other control characters: a disk refuses those too.
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return `${clean || 'Untitled'}.${ext}`
}

/** Scales an image to fit a width, never upscaling. Sizes in the writer's units. */
export function fit(
  image: { width: number; height: number },
  maxWidth: number,
  maxHeight = maxWidth * 1.3,
) {
  const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height)
  return { width: Math.round(image.width * scale), height: Math.round(image.height * scale) }
}

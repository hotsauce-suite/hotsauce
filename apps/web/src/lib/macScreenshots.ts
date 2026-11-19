// Sharing a screenshot from the Mac app (docs/PLAN-screenshots.md R5). The app has no sign-in of
// its own, so it asks the signed-in page in its window: it calls
// `window.hotsauceMac.shareScreenshot(name, pngBase64)` and gets back the link to copy. The page
// uploads the picture to the member's personal Files, in Screenshots, to delete itself in 30
// days, and turns on a link that ends then too: for anyone when the organization allows that,
// otherwise for signed-in members.

import type { DriveFile } from '../api/files'
import type { LinkChoice } from '../api/shares'

export const SCREENSHOTS_FOLDER = 'Screenshots'
export const SCREENSHOT_DAYS = 30
/** Above any screen's PNG; the page holds a few copies of it while it uploads. */
export const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024

export type ScreenshotShare =
  | {
      ok: true
      /** The whole address, ready to paste. */
      url: string
      /** False when the organization keeps links to signed-in members. */
      anyone: boolean
      /** When the picture and its link go (ISO). */
      deleteAfter: string | null
    }
  | { ok: false; error: string }

export interface ScreenshotShareDeps {
  /** The member's personal space; null when nobody is signed in. */
  personalSpace: () => Promise<string | null>
  origin: string
  publicLinksAllowed: () => Promise<boolean>
  upload: (
    file: Blob & { name: string },
    target: { space: string; folder: string; deleteAfterDays: number },
  ) => Promise<DriveFile>
  share: (space: string, id: string, on: boolean, choice: LinkChoice) => Promise<DriveFile>
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** The bytes of a base64 PNG, or null when it isn't one. */
export function decodePng(base64: string): Uint8Array | null {
  let binary: string
  try {
    binary = atob(base64)
  } catch {
    return null
  }
  if (binary.length < PNG_MAGIC.length) return null
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return PNG_MAGIC.every((b, i) => bytes[i] === b) ? bytes : null
}

/** A safe file name ending in .png, whatever the app sent. */
export function screenshotName(name: unknown): string {
  const base = (typeof name === 'string' ? name : '')
    .replace(/[\\/]/g, ' ')
    .replace(/\.png$/i, '')
    .trim()
    .slice(0, 150)
  return `${base || 'Screenshot'}.png`
}

export async function shareScreenshot(
  deps: ScreenshotShareDeps,
  name: unknown,
  pngBase64: unknown,
): Promise<ScreenshotShare> {
  const space = await deps.personalSpace().catch(() => null)
  if (!space) return { ok: false, error: 'Sign in to Hotsauce to share a screenshot.' }
  if (typeof pngBase64 !== 'string' || pngBase64.length > MAX_SCREENSHOT_BYTES * 1.4) {
    return { ok: false, error: 'That screenshot is too large to share.' }
  }
  const bytes = decodePng(pngBase64)
  if (!bytes) return { ok: false, error: 'That isn’t a picture Hotsauce can share.' }
  if (bytes.length > MAX_SCREENSHOT_BYTES) {
    return { ok: false, error: 'That screenshot is too large to share.' }
  }
  try {
    const file = Object.assign(new Blob([bytes as BlobPart], { type: 'image/png' }), {
      name: screenshotName(name),
    })
    const [stored, anyone] = await Promise.all([
      deps.upload(file, {
        space,
        folder: SCREENSHOTS_FOLDER,
        deleteAfterDays: SCREENSHOT_DAYS,
      }),
      deps.publicLinksAllowed().catch(() => false),
    ])
    const link = (toAnyone: boolean) =>
      deps.share(stored.space, stored.id, true, {
        anyone: toAnyone,
        expiresDays: SCREENSHOT_DAYS,
      })
    // The organization's switch can flip between the two calls; a link for members still works.
    let shared: DriveFile
    try {
      shared = await link(anyone)
    } catch (err) {
      if (!anyone) throw err
      shared = await link(false)
    }
    if (!shared.shareUrl) return { ok: false, error: 'Couldn’t make a link for the screenshot.' }
    return {
      ok: true,
      url: `${deps.origin}${shared.shareUrl}`,
      anyone: shared.shareLink?.anyone ?? anyone,
      deleteAfter: shared.deleteAfter ?? stored.deleteAfter ?? null,
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error && err.message ? err.message : 'Couldn’t share the screenshot.',
    }
  }
}

interface MacHooks {
  shareScreenshot?: (name: unknown, pngBase64: unknown) => Promise<ScreenshotShare>
}

/** Puts the function where the Mac app looks for it; the returned function takes it away. */
export function installMacScreenshots(deps: () => ScreenshotShareDeps): () => void {
  const w = window as { hotsauceMac?: MacHooks }
  const hooks = w.hotsauceMac ?? {}
  w.hotsauceMac = hooks
  const fn = (name: unknown, pngBase64: unknown) => shareScreenshot(deps(), name, pngBase64)
  hooks.shareScreenshot = fn
  return () => {
    if (hooks.shareScreenshot === fn) delete hooks.shareScreenshot
  }
}

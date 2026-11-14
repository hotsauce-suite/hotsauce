import { api } from '../api/client'
import type { Health } from '../api/types'
import { applyTheme, currentTheme } from '../lib/theme'
import { applyBrand } from './applyBrand'
import { product, setProduct } from './product'

/**
 * The root loader: what this instance is (sign-in mode, names, brand) before anything renders.
 * The brand is best effort; an older server without it still boots.
 */
/** The server didn't answer /api/health: the boot page retries by itself for this one only. */
export class ServerUnreachable extends Error {}

export const BOOT_RETRY_KEY = 'hearth:boot-retries'

export async function loadBoot(): Promise<Health> {
  const [health, brand] = await Promise.all([
    api.health().catch((err: unknown) => {
      throw new ServerUnreachable(err instanceof Error ? err.message : String(err))
    }),
    api.brand().catch(() => null),
  ])
  // The server answered: the next outage starts its retries soon again.
  try {
    sessionStorage.removeItem(BOOT_RETRY_KEY)
  } catch {
    // No sessionStorage: nothing to reset.
  }
  setProduct({
    productName: health.productName ?? null,
    orgName: health.orgName ?? null,
    chatUrl: health.chatUrl ?? null,
  })
  applyBrand(brand)
  // Settles the browser's bar colour on whichever look is now in effect.
  applyTheme(currentTheme())
  // Pages set their own titles; this covers the ones that don't.
  document.title = product()
  return { ...health, brand }
}

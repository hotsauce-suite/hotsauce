import { api } from '../api/client'
import type { Health, PublicBrand } from '../api/types'
import { reportUnreachable } from '../lib/connection'
import { rememberedStart, rememberStart } from '../lib/offlineStart'
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
  let health: Health
  let brand: PublicBrand | null
  try {
    ;[health, brand] = await Promise.all([api.health(), api.brand().catch(() => null)])
  } catch (err) {
    // Offline (docs/PLAN-offline.md, A2): start from what the last start kept on this device.
    const kept = rememberedStart()
    if (!kept) throw new ServerUnreachable(err instanceof Error ? err.message : String(err))
    reportUnreachable()
    return start({ ...kept.health, offlineStart: true }, kept.brand)
  }
  // The server answered: the next outage starts its retries soon again.
  try {
    sessionStorage.removeItem(BOOT_RETRY_KEY)
  } catch {
    // No sessionStorage: nothing to reset.
  }
  rememberStart(health, brand)
  return start(health, brand)
}

function start(health: Health, brand: PublicBrand | null): Health {
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

import { api } from '../api/client'
import type { Health } from '../api/types'
import { applyBrand } from './applyBrand'
import { product, setProduct } from './product'

/**
 * The root loader: what this instance is (sign-in mode, names, brand) before anything renders.
 * The brand is best effort; an older server without it still boots.
 */
export async function loadBoot(): Promise<Health> {
  const [health, brand] = await Promise.all([api.health(), api.brand().catch(() => null)])
  setProduct({
    productName: health.productName ?? null,
    orgName: health.orgName ?? null,
    chatUrl: health.chatUrl ?? null,
  })
  applyBrand(brand)
  // Pages set their own titles; this covers the ones that don't.
  document.title = product()
  return { ...health, brand }
}

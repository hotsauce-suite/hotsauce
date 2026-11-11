/**
 * The product's name as people see it (ARCHITECTURE §11): "Hotsauce" by default, or whatever the
 * organization chose, e.g. "Acme". Set once from /api/health before anything renders.
 */
let productName = 'Hotsauce'
let orgName = ''
let chatUrl: string | null = null

export function product(): string {
  return productName
}

export function org(): string {
  return orgName
}

/** The organization's team chat, shown as a rail link when set. */
export function chat(): string | null {
  return chatUrl
}

const CACHE_KEY = 'hotsauce:product'

export function setProduct(next: {
  productName?: string | null
  orgName?: string | null
  chatUrl?: string | null
}): void {
  if (next.productName) productName = next.productName
  if (next.orgName !== undefined && next.orgName !== null) orgName = next.orgName
  if (next.chatUrl !== undefined) chatUrl = next.chatUrl
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ productName, orgName, chatUrl }))
  } catch {
    // No storage: the name still comes from the server on every load.
  }
}

// The last name this browser saw, so strings built before /api/health answers are right too.
try {
  const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as {
    productName?: string
    orgName?: string
    chatUrl?: string | null
  } | null
  if (cached?.productName) productName = cached.productName
  if (cached?.orgName) orgName = cached.orgName
  if (cached?.chatUrl) chatUrl = cached.chatUrl
} catch {
  // Nothing cached.
}

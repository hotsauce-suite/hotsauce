/**
 * The environment the Hotsauce server starts with inside the container: every plain-text variable
 * and secret the Worker has (the Deploy button's form, plus anything an admin adds in the
 * dashboard), and the few the Worker decides. Bindings (objects) never pass.
 */
export const STATE_HOST = 'state.hotsauce'

export function containerEnv(
  env: Record<string, unknown>,
  publicUrl: string | null,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k)) out[k] = v
  }
  out.HOTSAUCE_PLATFORM = 'cloudflare'
  out.STATE_URL = `http://${STATE_HOST}`
  // The server's own address, for links and the setup link: the variable when an admin set one
  // (a custom domain), else the address the first visitor used.
  if (!out.PUBLIC_URL && publicUrl) out.PUBLIC_URL = publicUrl
  return out
}

/**
 * Whether the container keeps running with nobody using it. On unless HOTSAUCE_SLEEP is `true`:
 * then it stops after 30 idle minutes, which costs less, and the next visit waits for it to start.
 */
export function alwaysOn(env: Record<string, unknown>): boolean {
  const v = typeof env.HOTSAUCE_SLEEP === 'string' ? env.HOTSAUCE_SLEEP.trim().toLowerCase() : ''
  return !(v === 'true' || v === 'yes' || v === '1')
}

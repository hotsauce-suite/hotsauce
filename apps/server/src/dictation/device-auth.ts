import type { Authenticator, Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import type { DictationStore } from './store.js'

/**
 * The member behind a device token, re-checked against Clerk and the domain lock on every use:
 * a deleted account or a refused domain revokes all of that member's devices. Shared by the HTTP
 * routes and the dictation stream.
 */
export async function authenticateDevice(
  auth: Pick<Authenticator, 'principalForUser'>,
  store: DictationStore,
  token: string,
): Promise<{ principal: Principal; deviceId: string }> {
  const device = store.useToken(token)
  if (!device)
    throw new HearthError('unauthorized', 'This device was disconnected; connect it again')
  let principal: Principal | null
  try {
    principal = await auth.principalForUser(device.userId)
  } catch (err) {
    if (err instanceof HearthError && err.code === 'domain_not_allowed')
      store.revokeAllForUser(device.userId)
    throw err
  }
  if (!principal) {
    store.revokeAllForUser(device.userId)
    throw new HearthError('unauthorized', 'This device was disconnected; connect it again')
  }
  return { principal, deviceId: device.id }
}

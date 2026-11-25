import type { Authenticator, Principal } from '../auth/index.js'
import { HotsauceError } from '../errors.js'
import type { DeviceKind, DictationStore } from './store.js'

/**
 * The member behind a device token, re-checked against Clerk and the domain lock on every use:
 * a deleted account or a refused domain revokes all of that member's devices. Shared by the HTTP
 * routes and the dictation stream. `kind` is the kind of device the caller expects; any other
 * device's token is refused as unknown.
 */
export async function authenticateDevice(
  auth: Pick<Authenticator, 'principalForUser'>,
  store: DictationStore,
  token: string,
  appVersion: string | null = null,
  kind: DeviceKind = 'mac',
): Promise<{ principal: Principal; deviceId: string }> {
  const device = store.useToken(token, new Date(), appVersion)
  // A Mac's token is only ever a Mac's and a phone's only a phone's (docs/PLAN-android.md R6).
  if (!device || device.kind !== kind)
    throw new HotsauceError('unauthorized', 'This device was disconnected; connect it again')
  let principal: Principal | null
  try {
    principal = await auth.principalForUser(device.userId)
  } catch (err) {
    if (err instanceof HotsauceError && err.code === 'domain_not_allowed')
      store.revokeAllForUser(device.userId)
    throw err
  }
  if (!principal) {
    store.revokeAllForUser(device.userId)
    throw new HotsauceError('unauthorized', 'This device was disconnected; connect it again')
  }
  return { principal, deviceId: device.id }
}

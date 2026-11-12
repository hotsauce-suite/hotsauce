import { StateMirror } from './mirror.js'
import { HttpStateRemote } from './remote.js'

export { isDurable, StateMirror } from './mirror.js'
export { ensurePushKeys } from './push-keys.js'
export { HttpStateRemote, MemoryStateRemote, type StateRemote } from './remote.js'

/**
 * With STATE_URL set, restores DATA_DIR's durable files from the store and returns the running
 * mirror; without it, null and nothing is contacted (R6). The store can be a moment late when a
 * container starts, so listing is retried for about a minute before giving up.
 */
export async function openStateMirror(
  env: Record<string, string | undefined>,
  dataDir: string,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<StateMirror | null> {
  if (!env.STATE_URL) return null
  const intervalMs = Number(env.STATE_SYNC_MS) > 0 ? Number(env.STATE_SYNC_MS) : 15_000
  const mirror = new StateMirror({
    dataDir,
    remote: new HttpStateRemote(env.STATE_URL, env.STATE_TOKEN || undefined),
    intervalMs,
  })
  const attempts = opts.attempts ?? 12
  for (let i = 1; ; i++) {
    try {
      const n = await mirror.restore()
      console.log(`State restored from the store: ${n} file(s)`)
      break
    } catch (err) {
      if (i >= attempts)
        throw new Error(`Can't reach the state store at STATE_URL: ${(err as Error).message}`)
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 5_000))
    }
  }
  mirror.start()
  return mirror
}

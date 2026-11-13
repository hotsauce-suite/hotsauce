import { type FlyApi, type FlyMachine, HELPER_ROLE } from './fly.js'

export interface HelperInput {
  fly: FlyApi
  /** The image to move to, e.g. ghcr.io/hotsauce-suite/hotsauce:0.3.0. */
  target: string
  targetVersion: string
  /** The image the app ran before; this helper runs it too. */
  previous: string
  /** The instance's address; its /api/health must report `targetVersion`. */
  publicUrl: string
  timeoutMs?: number
  pollMs?: number
  fetchFn?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** Milliseconds, for the health deadline; Date.now by default. */
  now?: () => number
  log?: (line: string) => void
}

export type HelperResult =
  | { ok: true; version: string }
  | { ok: false; rolledBack: boolean; reason: string }

const isApp = (m: FlyMachine) =>
  m.config.metadata?.role !== HELPER_ROLE && m.state !== 'destroyed' && m.state !== 'destroying'

async function healthy(
  publicUrl: string,
  version: string,
  fetchFn: typeof fetch,
): Promise<boolean> {
  try {
    const res = await fetchFn(new URL('/api/health', publicUrl), {
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return false
    const body = (await res.json()) as { ok?: boolean; version?: string }
    return body.ok === true && body.version === version
  } catch {
    return false
  }
}

/** Fly's wait gives up after 60 s; a first pull of a new image can take longer. */
async function waitStarted(fly: FlyApi, id: string, instanceId: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fly.waitStarted(id, instanceId)
      return
    } catch (err) {
      if (attempt >= 4) throw err
    }
  }
}

/**
 * Moves every app machine to `target` and waits for the site to report the new version. If it
 * doesn't within the timeout, or Fly refuses, puts `previous` back on every machine it touched.
 * Runs in a separate machine on the old image, so a release that can't boot can't stop it.
 */
export async function runHelper(input: HelperInput): Promise<HelperResult> {
  const fetchFn = input.fetchFn ?? fetch
  const sleep = input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const log = input.log ?? ((line: string) => console.log(line))
  const timeoutMs = input.timeoutMs ?? 5 * 60_000
  const pollMs = input.pollMs ?? 5_000
  const now = input.now ?? Date.now
  const machines = (await input.fly.list()).filter(isApp)
  if (machines.length === 0) return { ok: false, rolledBack: false, reason: 'no app machines' }

  const touched: FlyMachine[] = []
  let reason = ''
  try {
    for (const m of machines) {
      log(`updating machine ${m.id} to ${input.target}`)
      // The full config, just before changing it: updates replace the whole config.
      const full = await input.fly.get(m.id)
      // Counted as touched before the call: a request that times out may still have landed.
      touched.push(full)
      const updated = await input.fly.update(m.id, { ...full.config, image: input.target })
      await waitStarted(input.fly, m.id, updated.instance_id)
    }
    // A deadline in real time as well as counted sleeps: each health call can take 10 s on its
    // own, and the server clears its pending update once the helper's window has passed.
    const deadline = now() + timeoutMs
    for (let waited = 0; waited <= timeoutMs && now() <= deadline; waited += pollMs) {
      if (await healthy(input.publicUrl, input.targetVersion, fetchFn)) {
        log(`healthy on ${input.targetVersion}`)
        return { ok: true, version: input.targetVersion }
      }
      await sleep(pollMs)
    }
    reason = `the site didn't report ${input.targetVersion} as healthy within ${Math.round(timeoutMs / 60_000)} minutes`
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err)
  }

  log(`rolling back: ${reason}`)
  let rolledBack = touched.length > 0
  for (const m of touched) {
    try {
      const back = await input.fly.update(m.id, { ...m.config, image: input.previous })
      await waitStarted(input.fly, m.id, back.instance_id)
    } catch (err) {
      rolledBack = false
      log(`rollback of ${m.id} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { ok: false, rolledBack, reason }
}

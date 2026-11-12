import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The Hotsauce release this server is running, from the HOTSAUCE_VERSION file at the root of the
 * checkout (the image keeps it next to apps/). An env var of the same name wins, for tests.
 */
export function readVersion(
  env: NodeJS.ProcessEnv = process.env,
  from = path.dirname(fileURLToPath(import.meta.url)),
): string {
  if (env.HOTSAUCE_VERSION?.trim()) return env.HOTSAUCE_VERSION.trim()
  let dir = from
  for (let i = 0; i < 8; i++) {
    const file = path.join(dir, 'HOTSAUCE_VERSION')
    if (existsSync(file)) return readFileSync(file, 'utf8').trim()
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return 'unknown'
}

type Semver = [number, number, number]

export function parseVersion(v: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** True when `a` is a later release than `b`. Anything unparseable is never newer. */
export function isNewer(a: string, b: string): boolean {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x) return false
  if (!y) return true
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) > (y[i] as number)
  return false
}

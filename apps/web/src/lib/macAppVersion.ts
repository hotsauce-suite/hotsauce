import { useEffect, useState } from 'react'

// Which Mac app a member has, and whether a newer one exists
// (docs/PLAN-mac-version-and-whats-new.md, M1 to M6).

/** What the newest Mac app is, published beside the download by its build script. */
export interface MacAppLatest {
  version: string
  build?: string
  /** True once the newest build tells Hotsauce its version; older builds can't. */
  reportsVersion?: boolean
}

export const MAC_APP_INFO = '/downloads/mac-app.json'

/** -1, 0 or 1 for two dotted versions like 0.26.0; anything unparsable counts as 0.0.0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0]
  }
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/**
 * - `current`: the installed version is the newest.
 * - `outdated`: a newer one exists (or the app is too old to say its version, and the newest
 *   build can).
 * - `unknown`: nothing to compare: no newest build known, or an app that doesn't say its version
 *   while the newest one can't either.
 */
export type MacAppUpdateState = 'current' | 'outdated' | 'unknown'

export function macAppUpdateState(
  installed: string | null,
  latest: MacAppLatest | null,
): MacAppUpdateState {
  if (!latest) return 'unknown'
  if (!installed) return latest.reportsVersion ? 'outdated' : 'unknown'
  return compareVersions(installed, latest.version) < 0 ? 'outdated' : 'current'
}

/** The version of the Mac app this page runs in (its window says it, M4); null in a browser. */
export function installedMacAppVersion(): string | null {
  const v = (window as { hotsauceMacApp?: { version?: unknown } }).hotsauceMacApp?.version
  return typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? v : null
}

function parseLatest(body: unknown): MacAppLatest | null {
  if (!body || typeof body !== 'object') return null
  const { version, build, reportsVersion } = body as Record<string, unknown>
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return null
  return {
    version,
    ...(typeof build === 'string' ? { build } : {}),
    reportsVersion: reportsVersion === true,
  }
}

/** The newest Mac app this server knows of: undefined while asking, null when it knows none. */
export function useMacAppLatest(enabled = true): MacAppLatest | null | undefined {
  const [latest, setLatest] = useState<MacAppLatest | null | undefined>(undefined)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    fetch(MAC_APP_INFO, { headers: { Accept: 'application/json' } })
      .then(async (res) => (res.ok ? parseLatest(await res.json()) : null))
      .catch(() => null)
      .then((value) => {
        if (!cancelled) setLatest(value)
      })
    return () => {
      cancelled = true
    }
  }, [enabled])
  return latest
}

import { useEffect, useState } from 'react'

// Which Mac app a member has, and whether a newer one exists
// (docs/PLAN-mac-version-and-whats-new.md, M1 to M6).

/** What the newest Mac app is, published beside the download by its build script. */
export interface MacAppLatest {
  version: string
  build?: string
  /** True once the newest build tells Hotsauce its version; older builds can't. */
  reportsVersion?: boolean
  /**
   * The first build with the same Mac app sources as this one. A new build is made with every
   * Hotsauce release (docs/PLAN-mac-download.md), so most carry only a new number: an installed
   * build at or above this one is the same app, and isn't offered an update.
   */
  sameAppSince?: string
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

/**
 * An installed app's version as a Mac reports it: `0.26.0`, or `0.26.0+1400` with its build. A
 * Mac-only change makes a new build of the same release, so the build breaks a tie.
 */
export function splitMacVersion(reported: string): { version: string; build: string | null } {
  const [version = '', build] = reported.split('+')
  return { version, build: build && /^\d+$/.test(build) ? build : null }
}

export function macAppUpdateState(
  installed: string | null,
  latest: MacAppLatest | null,
): MacAppUpdateState {
  if (!latest) return 'unknown'
  if (!installed) return latest.reportsVersion ? 'outdated' : 'unknown'
  const mine = splitMacVersion(installed)
  if (mine.build && latest.sameAppSince && /^\d+$/.test(latest.sameAppSince)) {
    if (Number(mine.build) >= Number(latest.sameAppSince)) return 'current'
  }
  const order = compareVersions(mine.version, latest.version)
  if (order !== 0) return order < 0 ? 'outdated' : 'current'
  if (mine.build && latest.build && /^\d+$/.test(latest.build)) {
    return Number(mine.build) < Number(latest.build) ? 'outdated' : 'current'
  }
  return 'current'
}

/** How a reported version reads in Settings: `0.26.0`, or `0.26.0 (build 1400)`. */
export function macVersionLabel(reported: string): string {
  const { version, build } = splitMacVersion(reported)
  return build ? `${version} (build ${build})` : version
}

/**
 * The version of the Mac app this page runs in (its window says it, M4), as `0.26.0+1400` when it
 * gives its build too; null in a browser.
 */
export function installedMacAppVersion(): string | null {
  const app = (window as { hotsauceMacApp?: { version?: unknown; build?: unknown } }).hotsauceMacApp
  const v = app?.version
  if (typeof v !== 'string' || !/^\d+\.\d+\.\d+$/.test(v)) return null
  const b = app?.build
  return typeof b === 'string' && /^\d{1,9}$/.test(b) ? `${v}+${b}` : v
}

export function parseLatest(body: unknown): MacAppLatest | null {
  if (!body || typeof body !== 'object') return null
  const { version, build, reportsVersion, sameAppSince } = body as Record<string, unknown>
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return null
  return {
    version,
    ...(typeof build === 'string' ? { build } : {}),
    reportsVersion: reportsVersion === true,
    ...(typeof sameAppSince === 'string' && /^\d{1,9}$/.test(sameAppSince) ? { sameAppSince } : {}),
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

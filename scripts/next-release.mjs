#!/usr/bin/env node
// Picks the next Hotsauce release (docs/PLAN-auto-releases.md). Releases number themselves: no
// pull request carries a version. After a merge to main, the Release workflow runs this on main's
// newest commit. It finds the newest release tag behind it, looks at what changed since, and
// prints one JSON line:
//
//   {"release":true,"last":"0.15.0","version":"0.15.1","bump":"patch"}
//   {"release":false,"last":"0.15.0","reason":"only docs, site, CI or Mac app sources changed"}
//
// The version comes from the tags. One exception: when HOTSAUCE_VERSION on main is higher than the
// newest tag, a release wrote its number and then failed (say the image build broke), so that
// number is released as it is, whatever changed since.
//
// Flags: --feature makes it a minor release (the workflow passes it when a pull request in the
// batch has the "feature" label). --force releases even when only docs changed (a hand-run).
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** Paths that never reach a running server, so changing only these makes no release. */
const NO_RELEASE = [
  /^docs\//,
  /^[^/]+\.md$/, // README, CONTRIBUTING, CLAUDE.md, AGENTS.md...
  /^site\//, // hotsauce.work, deployed on its own
  /^\.github\//,
  /^\.claude\//,
  /^e2e\//,
  /^scripts\/tour-video\//,
  /^scripts\/(next-release\.mjs|release-notes\.mjs|check-install\.sh|deploy-fly\.sh)$/,
  /\.test\.[cm]?[jt]sx?$/,
  /^apps\/[^/]+\/test\//,
  // The Mac app ships on its own download; only its built release/ goes into the image.
  /^apps\/dictate-mac\/(?!release\/)/,
]

export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/** The highest version among tag names like v1.2.3; anything else is ignored. */
export function newestVersion(tags) {
  let best = null
  for (const t of tags) {
    if (!t.startsWith('v')) continue
    const v = parseVersion(t)
    if (v && (!best || compare(v, best) > 0)) best = v
  }
  return best ? best.join('.') : null
}

export function bump(version, kind) {
  const v = parseVersion(version)
  if (!v) throw new Error(`not a version: ${version}`)
  if (kind === 'minor') return `${v[0]}.${v[1] + 1}.0`
  return `${v[0]}.${v[1]}.${v[2] + 1}`
}

/** What a "Release X.Y.Z" commit writes: the number and its notes (scripts/release-notes.mjs). */
const RELEASE_FILES = ['HOTSAUCE_VERSION', 'WHATS_NEW.json']

/** True when any changed path can reach a running server. */
export function needsRelease(changed) {
  return changed.some(
    (f) => f && !RELEASE_FILES.includes(f) && !NO_RELEASE.some((re) => re.test(f)),
  )
}

export function plan({ tags, changed, written = null, feature = false, force = false }) {
  const last = newestVersion(tags)
  if (!last) throw new Error('no release tag (vX.Y.Z) is behind this commit')
  const w = written ? parseVersion(written) : null
  if (w && compare(w, parseVersion(last)) > 0 && !tags.includes(`v${w.join('.')}`)) {
    return { release: true, last, version: w.join('.'), bump: 'unfinished' }
  }
  if (changed.length === 0)
    return { release: false, last, reason: 'nothing changed since the last release' }
  if (!force && !needsRelease(changed)) {
    return { release: false, last, reason: 'only docs, site, CI or Mac app sources changed' }
  }
  const kind = feature ? 'minor' : 'patch'
  return { release: true, last, version: bump(last, kind), bump: kind }
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function main(argv) {
  const ref = argv.find((a) => !a.startsWith('--')) ?? 'HEAD'
  const tags = git('tag', '--merged', ref, '--list', 'v*').split('\n').filter(Boolean)
  const last = newestVersion(tags)
  const changed = last
    ? git('diff', '--name-only', `v${last}`, ref).split('\n').filter(Boolean)
    : []
  let written = null
  try {
    written = git('show', `${ref}:HOTSAUCE_VERSION`)
  } catch {}
  const result = plan({
    tags,
    changed,
    written,
    feature: argv.includes('--feature'),
    force: argv.includes('--force'),
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}

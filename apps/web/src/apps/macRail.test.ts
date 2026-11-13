import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APPS } from './registry'

const BRAND = 'apps/dictate-mac/Sources/DictateCore/Brand.swift'

/** The checkout's root, found upward from wherever the tests run. */
function repoRoot(): string {
  let dir = process.cwd()
  while (!existsSync(join(dir, BRAND)) && dirname(dir) !== dir) dir = dirname(dir)
  return dir
}

// The Mac app's Go menu (⌘1…⌘9) lists the rail's apps from its own copy in Brand.swift.
describe('the Mac app Go menu', () => {
  it('lists every rail app in rail order, then Settings', () => {
    const swift = readFileSync(join(repoRoot(), BRAND), 'utf8')
    const start = swift.indexOf('= [', swift.indexOf('railShortcuts'))
    const block = swift.slice(start, swift.indexOf('\n    ]', start))
    const entries = [...block.matchAll(/\("([^"]+)", "([^"]+)"\)/g)].map((m) => [m[1], m[2]])
    expect(entries).toEqual([
      ...APPS.map((app) => [app.label, app.route]),
      ['Settings', '/settings'],
    ])
  })
})

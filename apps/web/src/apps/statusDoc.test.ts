import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APPS } from './registry'

const STATUS = 'docs/STATUS.md'

/** The checkout's root, found upward from wherever the tests run. */
function repoRoot(): string {
  let dir = process.cwd()
  while (!existsSync(join(dir, STATUS)) && dirname(dir) !== dir) dir = dirname(dir)
  return dir
}

function folders(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

// docs/STATUS.md says what each app does and needs. An app in the code with no entry there is a
// status page that has gone stale, so it fails here, in the same PR that adds the app.
describe('docs/STATUS.md', () => {
  const root = repoRoot()
  const status = readFileSync(join(root, STATUS), 'utf8')
  const headings = new Set(
    [...status.matchAll(/^### (.+)$/gm)].map((m) => (m[1] ?? '').trim().split(' (')[0]),
  )

  it('has a heading for every app on the rail', () => {
    const missing = APPS.map((app) => app.label).filter((label) => !headings.has(label))
    expect(missing).toEqual([])
  })

  it('names every app folder that has no manifest yet', () => {
    const ids = new Set<string>(APPS.map((app) => app.id))
    const missing = folders(join(root, 'apps/web/src/apps'))
      .filter((name) => !ids.has(name))
      .filter((name) => !status.includes(`apps/web/src/apps/${name}`))
    expect(missing).toEqual([])
  })

  it('names every app outside the web app', () => {
    const missing = folders(join(root, 'apps'))
      .filter((name) => name !== 'server' && name !== 'web')
      .filter((name) => !status.includes(`apps/${name}`))
    expect(missing).toEqual([])
  })
})

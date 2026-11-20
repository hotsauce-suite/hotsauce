import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCES = 'apps/dictate-mac/Sources'

/** The checkout's root, found upward from wherever the tests run. */
function repoRoot(): string {
  let dir = process.cwd()
  while (!existsSync(join(dir, SOURCES)) && dirname(dir) !== dir) dir = dirname(dir)
  return dir
}

function swiftFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return swiftFiles(path)
    return name.endsWith('.swift') ? [path] : []
  })
}

/** Placeholders, this Mac and Hotsauce's own public source (About links to it); never a real
 * organization's server. */
function isPlaceholder(host: string): boolean {
  return (
    host === 'github.com' ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === 'example.com' ||
    host.endsWith('.example.com') ||
    host.endsWith('.example')
  )
}

// One Mac app serves every organization: its workspace's address and name come from the member
// and the server, never from the app (docs/PLAN-mac-onboarding.md R13).
describe('the Mac app', () => {
  it('names no organization’s server', () => {
    const root = repoRoot()
    const found: string[] = []
    for (const file of swiftFiles(join(root, SOURCES))) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+[A-Za-z0-9])/g)) {
        const host = (match[1] ?? '').toLowerCase()
        if (!isPlaceholder(host)) found.push(`${file.slice(root.length + 1)}: ${host}`)
      }
    }
    expect(found).toEqual([])
  })

  it('has no built-in server address to fall back on', () => {
    const connectLink = readFileSync(
      join(repoRoot(), SOURCES, 'DictateCore/ConnectLink.swift'),
      'utf8',
    )
    expect(connectLink).not.toMatch(/defaultServer/)
  })
})

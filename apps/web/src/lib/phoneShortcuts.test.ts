import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { actionUrl, QUICK_ACTIONS } from './phoneShortcuts'

const SWIFT = 'apps/dictate-mac/Sources/DictateCore/QuickActions.swift'
const KOTLIN = 'apps/android/app/src/main/java/work/hotsauce/app/QuickActions.kt'

function repoRoot(): string {
  let dir = process.cwd()
  while (!existsSync(join(dir, SWIFT)) && dirname(dir) !== dir) dir = dirname(dir)
  return dir
}

describe('quick actions (docs/PLAN-phone-shortcuts.md)', () => {
  it('R1: lists the five actions in the order Android shows them', () => {
    expect(QUICK_ACTIONS.map((a) => [a.shortName, a.path])).toEqual([
      ['Voice note', '/dictate/voice?start=1'],
      ['New task', '/tasks?new=1'],
      ['Save link', '/links/save?paste=1'],
      ['Ask', '/today?ask=1'],
      ['Ramble', '/tasks?ramble=1'],
    ])
  })

  it('R7: the Mac app offers the same addresses, without the voice note', () => {
    const swift = readFileSync(join(repoRoot(), SWIFT), 'utf8')
    const start = swift.indexOf('= [', swift.indexOf('static let all'))
    const block = swift.slice(start, swift.indexOf('\n    ]', start))
    const paths = [...block.matchAll(/\("[^"]+", "([^"]+)"\)/g)].map((m) => m[1])
    expect(paths).toEqual(QUICK_ACTIONS.filter((a) => a.id !== 'voice-note').map((a) => a.path))
  })

  // docs/PLAN-android.md R15: the Android app's Capture and Voice note widgets open the same ones.
  it('R15: the Android app offers the same actions and addresses', () => {
    const kotlin = readFileSync(join(repoRoot(), KOTLIN), 'utf8')
    const rows = [...kotlin.matchAll(/QuickAction\("([^"]+)", "([^"]+)", "([^"]+)"\)/g)].map(
      (m) => [m[1], m[2], m[3]],
    )
    expect(rows).toEqual(QUICK_ACTIONS.map((a) => [a.id, a.shortName, a.path]))
  })

  it('makes the full address for an Open URLs step', () => {
    expect(actionUrl('https://hotsauce.example.com/', '/tasks?new=1')).toBe(
      'https://hotsauce.example.com/tasks?new=1',
    )
  })
})

import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TRACKS } from './tracks'

// Background music (docs/PLAN-background-music.md, M7): every track ships, is an MP3, is credited,
// and the offline cache never downloads them.

const root = path.resolve(__dirname, '../../../..')
const publicDir = path.join(root, 'apps/web/public')

describe('music tracks', () => {
  it('M7: every track file exists and is a small MP3', () => {
    for (const t of TRACKS) {
      const file = path.join(publicDir, t.file)
      const head = readFileSync(file).subarray(0, 3)
      // An ID3 tag or an MPEG frame sync.
      expect(
        head.toString('latin1') === 'ID3' || (head[0] === 0xff && (head[1] ?? 0) >= 0xe0),
      ).toBe(true)
      expect(statSync(file).size).toBeLessThan(4 * 1024 * 1024)
    }
  })

  it('M7: the help page credits every track with its author, licence and source', () => {
    const page = readFileSync(path.join(root, 'site/public/help/music.html'), 'utf8')
    for (const t of TRACKS) {
      expect(page).toContain(t.title)
      expect(page).toContain(t.author)
      expect(page).toContain(t.source)
    }
    expect(page).toContain('CC0')
  })

  it('M7: the offline cache never includes the music', () => {
    const config = readFileSync(path.join(root, 'apps/web/vite.config.ts'), 'utf8')
    const globs = config.match(/globPatterns:\s*\[([^\]]*)\]/)?.[1] ?? ''
    expect(globs).not.toMatch(/mp3|music/)
    expect(globs).not.toMatch(/\*\*\/\*'/)
  })
})

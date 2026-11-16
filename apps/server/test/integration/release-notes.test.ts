// scripts/release-notes.mjs (docs/PLAN-mac-version-and-whats-new.md, N1 to N4): every pull
// request says what's new in plain words, and each release collects those lines.
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs script without types
import * as notes from '../../../../scripts/release-notes.mjs'

const SCRIPT = fileURLToPath(new URL('../../../../scripts/release-notes.mjs', import.meta.url))
const ROOT_FILE = fileURLToPath(new URL('../../../../WHATS_NEW.json', import.meta.url))

const body = (section: string) =>
  `## What this changes\n\nStuff.\n\n## What's new\n\n${section}\n\n## How you checked it\n\n- [x] tests`

describe('parseWhatsNew (N2)', () => {
  it('reads one note per line, and marks Mac app lines', () => {
    expect(
      notes.parseWhatsNew(
        body('- settings shows the Mac app version\n- Mac app: an Update available item'),
      ),
    ).toEqual({
      status: 'notes',
      notes: [
        { text: 'Settings shows the Mac app version' },
        { text: 'An Update available item', area: 'Mac app' },
      ],
    })
  })

  it('takes None for changes nobody sees, and ignores the template’s comment', () => {
    expect(notes.parseWhatsNew(body('None'))).toEqual({ status: 'none' })
    expect(notes.parseWhatsNew(body('- None (docs only)'))).toEqual({ status: 'none' })
    expect(notes.parseWhatsNew(body('<!-- - Example: a line -->\nNone.'))).toEqual({
      status: 'none',
    })
    // A note that merely starts with the word is still a note.
    expect(notes.parseWhatsNew(body('- None of the buttons jump any more'))).toMatchObject({
      status: 'notes',
    })
  })

  it('fails a description without the section, or with an empty one', () => {
    expect(notes.parseWhatsNew('## What this changes\n\nStuff')).toEqual({ status: 'missing' })
    expect(notes.parseWhatsNew(body('<!-- one line per change -->'))).toEqual({ status: 'empty' })
    expect(notes.checkMessage('no sections')).toMatch(/Add a "## What's new" section/)
    expect(notes.checkMessage(body(''))).toMatch(/is empty/)
    expect(notes.checkMessage(body('None'))).toBeNull()
  })

  it('accepts the curly apostrophe and a level-3 heading', () => {
    expect(notes.parseWhatsNew('### What’s new\n- A thing')).toMatchObject({ status: 'notes' })
  })
})

describe('addRelease and markdown (N1, N3)', () => {
  it('adds a release from its pull requests, newest first, each pull request once', () => {
    const before = {
      releases: [{ version: '0.25.0', date: '2026-11-16', notes: [{ text: 'Old' }] }],
    }
    const after = notes.addRelease(before, {
      version: '0.26.0',
      date: '2026-11-17',
      prs: [
        { number: 1, body: body('- One') },
        { number: 1, body: body('- One') },
        { number: 2, body: body('None') },
        { number: 3, body: body('- Mac app: Two') },
      ],
    })
    expect(after.releases.map((r: { version: string }) => r.version)).toEqual(['0.26.0', '0.25.0'])
    expect(after.releases[0].notes).toEqual([{ text: 'One' }, { text: 'Two', area: 'Mac app' }])
    expect(notes.markdown(after, '0.26.0')).toBe("## What's new\n\n- One\n- Mac app: Two\n")
    // Running the same release again replaces it rather than adding a second entry.
    const again = notes.addRelease(after, {
      version: '0.26.0',
      date: '2026-11-17',
      prs: [{ number: 4, body: body('- Three') }],
    })
    expect(again.releases.filter((r: { version: string }) => r.version === '0.26.0')).toHaveLength(
      1,
    )
    expect(again.releases[0].notes).toEqual([{ text: 'Three' }])
  })

  it('lists no release whose changes all say None', () => {
    const after = notes.addRelease(
      { releases: [] },
      { version: '0.26.1', date: 'd', prs: [{ number: 5, body: body('None') }] },
    )
    expect(after.releases).toEqual([])
    expect(notes.markdown(after, '0.26.1')).toBe('')
  })
})

describe('the script', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'hs-notes-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync('node', [SCRIPT, ...args], {
      cwd: dir,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    })

  it('checks a pull request’s description', () => {
    expect(run(['check'], { PR_BODY: body('- A change') }).status).toBe(0)
    const failed = run(['check'], { PR_BODY: 'nothing' })
    expect(failed.status).toBe(1)
    expect(failed.stderr).toMatch(/What's new/)
  })

  it('writes a release into WHATS_NEW.json and prints it for GitHub', async () => {
    await writeFile(
      path.join(dir, 'prs.jsonl'),
      `${JSON.stringify({ number: 9, body: body('- Mac app: Shows its version') })}\n`,
    )
    expect(run(['add', '0.26.0', '2026-11-17', 'prs.jsonl']).status).toBe(0)
    const written = JSON.parse(await readFile(path.join(dir, 'WHATS_NEW.json'), 'utf8'))
    expect(written.releases[0]).toEqual({
      version: '0.26.0',
      date: '2026-11-17',
      notes: [{ text: 'Shows its version', area: 'Mac app' }],
    })
    expect(run(['markdown', '0.26.0']).stdout).toBe(
      "## What's new\n\n- Mac app: Shows its version\n",
    )
  })
})

describe('WHATS_NEW.json in the repository', () => {
  it('is well formed, newest release first', async () => {
    const data = JSON.parse(await readFile(ROOT_FILE, 'utf8'))
    const versions = data.releases.map((r: { version: string }) => r.version)
    for (const r of data.releases) {
      expect(r.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(r.notes.length).toBeGreaterThan(0)
      for (const n of r.notes) {
        expect(typeof n.text).toBe('string')
        if ('area' in n) expect(n.area).toBe('Mac app')
      }
    }
    const sorted = [...versions].sort((a: string, b: string) => {
      const p = (v: string) => v.split('.').map(Number)
      const [x, y] = [p(a), p(b)]
      for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (y[i] ?? 0) - (x[i] ?? 0)
      return 0
    })
    expect(versions).toEqual(sorted)
  })
})

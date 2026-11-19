// The landing page and the app's Hotsauce 101 page describe the apps from one list,
// public/apps.json (docs/PLAN-tour-and-101.md H1). `node site/sync-apps.mjs` rewrites the page.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APPS_LINE, pageApps } from './sync-apps.mjs'

const html = readFileSync(join(import.meta.dirname, 'public', 'index.html'), 'utf8')
const entries = JSON.parse(readFileSync(join(import.meta.dirname, 'public', 'apps.json'), 'utf8'))
const onPage = JSON.parse(APPS_LINE.exec(html)?.[0].replace(/^ {2}const APPS = /, '') ?? '{}')
const cards = [...html.matchAll(/<article class="app" data-app="([^"]+)"/g)].map((m) => m[1])

describe('the app list', () => {
  it('gives the landing page the same windows as apps.json', () => {
    expect(onPage).toEqual(pageApps(entries))
  })

  it('has a card on the page and a looping video for every app', () => {
    expect([...cards].sort()).toEqual(entries.map((e) => e.id).sort())
    for (const e of entries) {
      expect(
        existsSync(join(import.meta.dirname, 'public', 'video', 'apps', `${e.video}.mp4`)),
        e.id,
      ).toBe(true)
      expect(
        existsSync(join(import.meta.dirname, 'public', 'video', 'apps', `${e.video}.jpg`)),
        e.id,
      ).toBe(true)
    }
  })
})

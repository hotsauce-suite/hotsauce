// Writes the landing page's app windows (`const APPS` in public/index.html) from public/apps.json,
// the one list of apps the site and the app's Hotsauce 101 page share (docs/PLAN-tour-and-101.md).
// Run it after editing apps.json: `node site/sync-apps.mjs`. apps.test.js fails when they differ.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const here = import.meta.dirname
const KEYS = ['demo', 'name', 'how', 'feats', 'needs', 'video']

/** The `APPS` object the page's script reads, keyed by card, from apps.json. */
export function pageApps(entries) {
  return Object.fromEntries(
    entries.map((e) => [
      e.id,
      Object.fromEntries(KEYS.filter((k) => k in e).map((k) => [k, e[k]])),
    ]),
  )
}

export const APPS_LINE = /^ {2}const APPS = .*$/m

export function render(html, entries) {
  return html.replace(APPS_LINE, `  const APPS = ${JSON.stringify(pageApps(entries))}`)
}

if (process.argv[1] === import.meta.filename) {
  const page = join(here, 'public', 'index.html')
  const entries = JSON.parse(readFileSync(join(here, 'public', 'apps.json'), 'utf8'))
  writeFileSync(page, render(readFileSync(page, 'utf8'), entries))
}

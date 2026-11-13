// Renders Resources/dmg/background.html into Resources/dmg/background.tiff (1x and 2x in one
// file, so Finder picks the sharp one on Retina screens). Run by hand after editing the HTML:
//   node apps/dictate-mac/scripts/render-dmg-background.mjs
// Needs Playwright's Chromium (the repo's @playwright/test) and macOS's tiffutil.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'Resources', 'dmg')
const tmp = mkdtempSync(join(tmpdir(), 'dmg-bg-'))
const browser = await chromium.launch()
try {
  for (const scale of [1, 2]) {
    const page = await browser.newPage({
      viewport: { width: 660, height: 400 },
      deviceScaleFactor: scale,
    })
    await page.goto(pathToFileURL(join(dir, 'background.html')).href, { waitUntil: 'networkidle' })
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: join(tmp, `bg${scale}.png`) })
    await page.close()
  }
} finally {
  await browser.close()
}
// tiffutil wants the 2x image to carry 144 dpi so it's read as the Retina version.
execFileSync(
  'sips',
  [
    '-s',
    'dpiWidth',
    '144',
    '-s',
    'dpiHeight',
    '144',
    join(tmp, 'bg2.png'),
    '--out',
    join(tmp, 'bg2@2x.png'),
  ],
  { stdio: 'ignore' },
)
execFileSync(
  'sips',
  ['-s', 'format', 'tiff', join(tmp, 'bg1.png'), '--out', join(tmp, 'bg1.tiff')],
  { stdio: 'ignore' },
)
execFileSync(
  'sips',
  ['-s', 'format', 'tiff', join(tmp, 'bg2@2x.png'), '--out', join(tmp, 'bg2.tiff')],
  { stdio: 'ignore' },
)
execFileSync('tiffutil', [
  '-cathidpicheck',
  join(tmp, 'bg1.tiff'),
  join(tmp, 'bg2.tiff'),
  '-out',
  join(dir, 'background.tiff'),
])
rmSync(tmp, { recursive: true, force: true })
console.log('Wrote', join(dir, 'background.tiff'))

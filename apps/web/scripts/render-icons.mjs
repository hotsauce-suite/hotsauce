// Renders the web app's PNG icons from public/favicon.svg (the Hotsauce bottle). Run by hand
// after changing the favicon:
//   node apps/web/scripts/render-icons.mjs
// Needs Playwright's Chromium (the repo's @playwright/test).
//
// icon-192/512: the bottle on a rounded cream tile with transparent corners (installed app icons).
// apple-touch-icon (180) and icon-maskable-512: a full cream square, the bottle inside the
// maskable safe zone, since iOS and Android cut their own shape.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
const svg = readFileSync(join(pub, 'favicon.svg'), 'utf8')
const paper = '#fff4e2'
const glow = 'radial-gradient(ellipse 80% 70% at 50% 100%, #f6c48a, transparent 70%)'

const icons = [
  { file: 'icon-192.png', size: 192, radius: 0.2, mark: 0.74 },
  { file: 'icon-512.png', size: 512, radius: 0.2, mark: 0.74 },
  { file: 'apple-touch-icon.png', size: 180, radius: 0, mark: 0.7 },
  { file: 'icon-maskable-512.png', size: 512, radius: 0, mark: 0.6 },
]

const browser = await chromium.launch()
try {
  for (const { file, size, radius, mark } of icons) {
    const page = await browser.newPage({ viewport: { width: size, height: size } })
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">
      <div style="width:${size}px;height:${size}px;border-radius:${radius * size}px;background:${glow},${paper};display:grid;place-items:center">
        <div style="width:${mark * size}px;height:${mark * size}px">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div>
      </div></body></html>`)
    await page.screenshot({ path: join(pub, file), omitBackground: radius > 0 })
    await page.close()
  }
} finally {
  await browser.close()
}

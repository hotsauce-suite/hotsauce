// Renders every raster Hotsauce icon from public/favicon.svg (the Hotsauce bottle). Run by hand
// after changing the favicon:
//   node apps/web/scripts/render-icons.mjs
// Needs Playwright's Chromium (the repo's @playwright/test). Writes:
//
// - apps/web/public: icon-192/512 (the bottle on a rounded cream tile with a warm glow from
//   below, transparent corners: installed app icons); apple-touch-icon (180) and
//   icon-maskable-512 (a full square, the bottle inside the maskable safe zone, since iOS and
//   Android cut their own shape).
// - apps/web/public/favicon.ico: the bottle alone at 16/32/48/64, for browsers and services that
//   only ask for /favicon.ico (claude.ai's connector list, docs/learnings/mcp.md).
// - apps/extension/static/icons: the bottle alone on clear, 16/32/48/128 (Chrome's toolbar and
//   extensions page).
// - The Mac app's iconset PNGs into the folder given as --mac <dir> (macOS's rounded dark tile,
//   824 of 1024 inset 100, with a rust glow from below). Turn them into AppIcon.icns with
//   `iconutil -c icns <dir> -o apps/dictate-mac/Resources/AppIcon.icns` on a Mac, or with Pillow
//   elsewhere (docs/learnings/branding-icons.md). ProductMark.swift draws the same tile, for
//   `Hotsauce --render-app-icon`.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const pub = join(root, 'apps', 'web', 'public')
const ext = join(root, 'apps', 'extension', 'static', 'icons')
const svg = readFileSync(join(pub, 'favicon.svg'), 'utf8')
const sized = (s) => s.replace('<svg ', '<svg width="100%" height="100%" ')
const paper = '#fff4e2'
const glow = 'radial-gradient(ellipse 85% 75% at 50% 85%, #f3a061, #f6c48ab3 45%, #fff4e200 80%)'
// On the dark tile the ink outline would vanish, so it turns darker still and the glow is rust.
const ink = '#16262d'
const darkSvg = svg.replaceAll('stroke="#16262d"', 'stroke="#0b1418"')
const darkGlow = 'radial-gradient(ellipse 75% 70% at 50% 85%, #a94e268c, #16262d00 80%)'

const webIcons = [
  { file: 'icon-192.png', size: 192, radius: 0.2, mark: 0.9 },
  { file: 'icon-512.png', size: 512, radius: 0.2, mark: 0.9 },
  { file: 'apple-touch-icon.png', size: 180, radius: 0, mark: 0.86 },
  { file: 'icon-maskable-512.png', size: 512, radius: 0, mark: 0.72 },
]

const macArg = process.argv.indexOf('--mac')
const macDir = macArg > 0 ? process.argv[macArg + 1] : undefined
if (macArg > 0 && !macDir) throw new Error('--mac needs a folder: --mac <dir>')
const macSizes = [
  ['16x16', 16],
  ['16x16@2x', 32],
  ['32x32', 32],
  ['32x32@2x', 64],
  ['128x128', 128],
  ['128x128@2x', 256],
  ['256x256', 256],
  ['256x256@2x', 512],
  ['512x512', 512],
  ['512x512@2x', 1024],
]

// PLAYWRIGHT_CHROMIUM_PATH points at a Chromium of another Playwright version, when the repo's isn't installed.
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
})
const shoot = async (size, html, path) => {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:transparent">${html}</body></html>`,
  )
  await page.screenshot({ path, omitBackground: true })
  await page.close()
}
try {
  for (const { file, size, radius, mark } of webIcons) {
    await shoot(
      size,
      `<div style="width:${size}px;height:${size}px;border-radius:${radius * size}px;background:${glow},${paper};display:grid;place-items:center">
      <div style="width:${mark * size}px;height:${mark * size}px">${sized(svg)}</div></div>`,
      join(pub, file),
    )
  }
  for (const size of [16, 32, 48, 128]) {
    // The bottle stands 61 of its 64 units tall with its outline: full height, no margin.
    await shoot(
      size,
      `<div style="width:${size}px;height:${size}px">${sized(svg)}</div>`,
      join(ext, `icon-${size}.png`),
    )
  }
  // favicon.ico: an ICO file holding PNG images, which every current browser reads.
  const pngs = []
  for (const size of [16, 32, 48, 64]) {
    const path = join(tmpdir(), `hotsauce-favicon-${size}.png`)
    await shoot(size, `<div style="width:${size}px;height:${size}px">${sized(svg)}</div>`, path)
    pngs.push({ size, data: readFileSync(path) })
    rmSync(path)
  }
  const header = Buffer.alloc(6 + 16 * pngs.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  let offset = header.length
  pngs.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i
    header.writeUInt8(size % 256, at)
    header.writeUInt8(size % 256, at + 1)
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(data.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += data.length
  })
  writeFileSync(join(pub, 'favicon.ico'), Buffer.concat([header, ...pngs.map((p) => p.data)]))
  if (macDir) {
    mkdirSync(macDir, { recursive: true })
    for (const [name, px] of macSizes) {
      const s = px / 1024
      await shoot(
        px,
        `<div style="position:absolute;left:${100 * s}px;top:${100 * s}px;width:${824 * s}px;height:${824 * s}px;border-radius:${185 * s}px;background:${darkGlow},${ink};box-shadow:0 ${10 * s}px ${24 * s}px #00000047;display:grid;place-items:center">
        <div style="width:${824 * s * 0.9}px;height:${824 * s * 0.9}px">${sized(darkSvg)}</div></div>`,
        join(macDir, `icon_${name}.png`),
      )
    }
  }
} finally {
  await browser.close()
}

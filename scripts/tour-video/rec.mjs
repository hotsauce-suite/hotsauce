// Records one scripted shot of the Hotsauce web app as a crisp 1920x1080 MP4.
// Headless Chromium + CDP screencast frames, a drawn cursor, eased mouse moves.
// Usage (from the repo root): node scripts/tour-video/rec.mjs <shotName> <outDir> [--dark]
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chromium } from '@playwright/test'
import { shots } from './shots.mjs'

const BASE = process.env.TOUR_BASE ?? 'http://localhost:5191'
const [, , name, outDir, ...flags] = process.argv
const shot = shots[name]
if (!shot) throw new Error(`no shot ${name}; have ${Object.keys(shots).join(', ')}`)

const CURSOR = `
(() => {
  const mk = () => {
    if (document.getElementById('__cur')) return
    const c = document.createElement('div'); c.id = '__cur'
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2.5l15 9.2-6.6 1.4 3.9 7.3-2.6 1.3-3.9-7.3L4.9 19z" fill="#1d1a17" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>'
    Object.assign(c.style, { position: 'fixed', left: '-100px', top: '-100px', zIndex: 2147483647, pointerEvents: 'none', transform: 'translate(-3px,-2px)', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.25))' })
    document.documentElement.appendChild(c)
    addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px' }, true)
    addEventListener('mousedown', (e) => {
      const r = document.createElement('div')
      Object.assign(r.style, { position: 'fixed', left: e.clientX - 18 + 'px', top: e.clientY - 18 + 'px', width: '36px', height: '36px', borderRadius: '50%', border: '3px solid rgba(201,64,28,.75)', zIndex: 2147483646, pointerEvents: 'none', transition: 'transform .45s ease-out, opacity .45s ease-out' })
      document.documentElement.appendChild(r)
      requestAnimationFrame(() => { r.style.transform = 'scale(1.6)'; r.style.opacity = '0' })
      setTimeout(() => r.remove(), 500)
    }, true)
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', mk); else mk()
})()`

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--hide-scrollbars',
  ],
  // As in playwright.config.ts: a preinstalled Chromium when the matching build isn't installed.
  ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
})
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: 1.2,
  colorScheme: flags.includes('--dark') ? 'dark' : 'light',
  permissions: ['microphone', 'camera', 'clipboard-read', 'clipboard-write', 'geolocation'],
  // Today's "Show weather" asks for a position; the demo's weather is the same anywhere.
  geolocation: { latitude: 37.77, longitude: -122.42 },
  timezoneId: 'America/Los_Angeles',
})
await ctx.addInitScript(CURSOR)
const page = await ctx.newPage()
// TOUR_CLOCK (an ISO time) starts the page's clock there, so Today says "Good morning" whenever you film.
if (process.env.TOUR_CLOCK) {
  await page.clock.install({ time: new Date(process.env.TOUR_CLOCK) })
  await page.clock.resume()
}
page.setDefaultTimeout(10000)
setTimeout(() => {
  console.log('WATCHDOG', name)
  process.exit(3)
}, 150000)

// Eased mouse, so the drawn cursor glides instead of teleporting.
let pos = { x: 800, y: 450 }
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
async function moveTo(x, y, ms = 650) {
  const from = { ...pos }
  const n = Math.max(12, Math.round(ms / 16))
  for (let i = 1; i <= n; i++) {
    const k = ease(i / n)
    await page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k)
    await page.waitForTimeout(ms / n)
  }
  pos = { x, y }
}
async function point(locator, opts = {}) {
  await locator.scrollIntoViewIfNeeded()
  const b = await locator.boundingBox()
  if (!b) throw new Error(`no box for ${locator}`)
  const x = b.x + b.width * (opts.fx ?? 0.5)
  const y = b.y + b.height * (opts.fy ?? 0.5)
  await moveTo(x, y, opts.ms)
  return { x, y }
}
async function click(locator, opts = {}) {
  await point(locator, opts)
  await page.waitForTimeout(opts.before ?? 180)
  await page.mouse.down()
  await page.waitForTimeout(70)
  await page.mouse.up()
  await page.waitForTimeout(opts.after ?? 350)
}
async function type(text, delay = 55) {
  for (const ch of text) {
    await page.keyboard.type(ch)
    await page.waitForTimeout(delay + Math.random() * 35)
  }
}
const wait = (ms) => page.waitForTimeout(ms)

async function signIn(email = 'ada@example.test') {
  await page.goto(`${BASE}/sign-in`)
  await page.getByPlaceholder('you@example.test').fill(email)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'))
  await page.waitForTimeout(800)
}

// --- capture ---
const frameDir = path.join(outDir, `${name}.frames`)
rmSync(frameDir, { recursive: true, force: true })
mkdirSync(frameDir, { recursive: true })
const frames = []
let cdp
async function startCapture() {
  cdp = await ctx.newCDPSession(page)
  cdp.on('Page.screencastFrame', async (f) => {
    const file = path.join(frameDir, `${String(frames.length).padStart(6, '0')}.jpg`)
    frames.push({ file, t: f.metadata.timestamp })
    writeFileSync(file, Buffer.from(f.data, 'base64'))
    await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 93,
    maxWidth: 1920,
    maxHeight: 1080,
  })
  // Nudge a repaint so the first frame arrives now.
  await page.mouse.move(pos.x, pos.y)
}
async function stopCapture() {
  await cdp.send('Page.stopScreencast')
}

const api = { page, BASE, moveTo, point, click, type, wait, signIn, startCapture }
const t0 = Date.now()
try {
  await shot(api)
} finally {
  await page.waitForTimeout(400).catch(() => {})
  if (cdp) await stopCapture().catch(() => {})
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 3000))])
}
if (frames.length === 0) throw new Error('no frames captured')
const lines = ['ffconcat version 1.0']
frames.forEach((f, i) => {
  const next = frames[i + 1]?.t ?? f.t + 0.6
  lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`)
})
lines.push(`file '${frames.at(-1).file}'`)
const list = path.join(outDir, `${name}.ffconcat`)
writeFileSync(list, lines.join('\n'))
const out = path.join(outDir, `${name}.mp4`)
execFileSync('ffmpeg', [
  '-loglevel',
  'error',
  '-y',
  '-safe',
  '0',
  '-f',
  'concat',
  '-i',
  list,
  '-vf',
  'scale=1920:1080:flags=lanczos,fps=30,format=yuv420p',
  '-c:v',
  'libx264',
  '-crf',
  '17',
  '-preset',
  'slow',
  out,
])
console.log(
  `${name}: ${frames.length} frames, ${((Date.now() - t0) / 1000).toFixed(1)}s wall -> ${out}`,
)
process.exit(0)

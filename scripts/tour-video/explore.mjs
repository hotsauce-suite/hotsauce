// node scripts/tour-video/explore.mjs <outDir> <file-with-steps.mjs>
import { mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const [, , out, stepsFile] = process.argv
mkdirSync(out, { recursive: true })
const { default: steps } = await import(stepsFile)
const b = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    ...(process.env.FAKE_VIDEO
      ? [`--use-file-for-fake-video-capture=${process.env.FAKE_VIDEO}`]
      : []),
  ],
})
const ctx = await b.newContext({
  viewport: { width: 1600, height: 900 },
  permissions: ['microphone', 'camera'],
})
const p = await ctx.newPage()
p.setDefaultTimeout(8000)
setTimeout(() => {
  console.log('WATCHDOG')
  process.exit(2)
}, 90000)
await p.goto('http://localhost:5191/sign-in')
await p.getByPlaceholder('you@example.test').fill('ada@example.test')
await p.getByRole('button', { name: 'Sign in' }).click()
await p.waitForTimeout(1500)
let n = 0
const snap = async (label) => {
  await p.screenshot({ path: `${out}/${String(n++).padStart(2, '0')}-${label}.png` })
}
const tree = async (filter) =>
  console.log(
    (await p.locator('body').ariaSnapshot())
      .split('\n')
      .filter((l) => !filter || l.includes(filter))
      .slice(0, 150)
      .join('\n'),
  )
try {
  await steps(p, snap, tree)
} catch (e) {
  console.log('ERR', e.message.split('\n')[0])
  await snap('error')
}
await Promise.race([b.close(), new Promise((r) => setTimeout(r, 3000))])
process.exit(0)

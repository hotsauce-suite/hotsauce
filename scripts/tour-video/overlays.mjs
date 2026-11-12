// Renders the tour's title cards, chapter chips and captions as 1920x1080 PNGs
// (transparent where they overlay the app), in the hotsauce.work site's type and colors.
// Usage: node scripts/tour-video/overlays.mjs <outDir> <captions.json>
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { chromium } from '@playwright/test'

const [, , out, capFile] = process.argv
mkdirSync(out, { recursive: true })
const caps = JSON.parse(readFileSync(capFile, 'utf8'))
const logo = readFileSync(new URL('../../apps/web/public/favicon.svg', import.meta.url), 'utf8')

const HEAD = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700&family=DM+Mono:wght@400;500&display=swap">
<style>
:root{--paper:#fff4e2;--ink:#16262d;--muted:#46565b;--rust:#a94e26;--spruce:#1f4d3a;--soft:#f8e2de}
*{box-sizing:border-box;margin:0}
html,body{width:1920px;height:1080px;background:transparent;font-family:"DM Sans",sans-serif;color:var(--ink)}
.card{position:absolute;inset:0;background:var(--paper);display:flex;flex-direction:column;justify-content:center;padding:0 200px;
  background-image:radial-gradient(circle at 78% 70%,rgba(169,78,38,.18),transparent 45%),radial-gradient(circle at 15% 20%,rgba(31,77,58,.12),transparent 40%)}
.logo{width:120px;height:120px;margin-bottom:36px}
.logo svg{width:100%;height:100%}
h1{font:800 132px/0.98 "Bricolage Grotesque";letter-spacing:-.035em}
h1 em{font-style:normal;color:var(--rust)}
.sub{font-size:44px;color:var(--muted);margin-top:30px;max-width:24em}
.links{margin-top:56px;display:flex;flex-direction:column;gap:18px;font:500 42px "DM Mono"}
.links b{color:var(--rust);font-weight:500}
.chip{position:absolute;right:72px;top:96px;display:flex;align-items:center;gap:14px;background:var(--ink);color:#fff4e2;
  border-radius:999px;padding:12px 26px 12px 14px;font:600 34px "Bricolage Grotesque";box-shadow:6px 6px 0 rgba(169,78,38,.9)}
.chip span{background:var(--rust);border-radius:999px;font:500 22px "DM Mono";padding:5px 12px}
.cap{position:absolute;left:50%;bottom:64px;transform:translateX(-50%);max-width:1500px;width:max-content;text-align:center;
  background:rgba(22,38,45,.88);color:#fff8ee;font:500 40px/1.3 "DM Sans";padding:16px 34px;border-radius:18px}
</style>`

const pages = []
pages.push(['intro', `<div class="card"><div class="logo">${logo}</div><h1>Hot<em>sauce</em></h1><p class="sub">The open sauce office suite. Docs, meetings, tasks and more, on your own server.</p></div>`])
pages.push(['outro', `<div class="card"><div class="logo">${logo}</div><h1>Run it for<br>your <em>team.</em></h1><div class="links"><div><b>→</b> hotsauce.work</div><div><b>→</b> github.com/hotsauce-suite/hotsauce</div></div><p class="sub" style="font-size:36px">Free and open source. Deploys to Cloudflare in minutes.</p></div>`])
caps.chapters.forEach((c, i) => pages.push([`chip-${c.id}`, `<div class="chip"><span>${String(i + 1).padStart(2, '0')}</span>${c.app}</div>`]))
caps.lines.forEach((l, i) => pages.push([`cap-${String(i).padStart(3, '0')}`, `<div class="cap">${l.text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`]))

const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } })
for (const [name, body] of pages) {
  await p.setContent(`<!doctype html><html><head>${HEAD}</head><body>${body}</body></html>`, { waitUntil: 'networkidle' })
  await p.evaluate(() => document.fonts.ready)
  await p.screenshot({ path: path.join(out, `${name}.png`), omitBackground: true })
}
await Promise.race([b.close(), new Promise((r) => setTimeout(r, 3000))])
console.log(`rendered ${pages.length} overlays`)
process.exit(0)

// After GitHub deploys hotsauce.work (docs/PLAN-site-deploy.md), checks the live site really
// changed: both hosts answer with this commit, every changed page matches what was built, and
// the demo's page matches the demo that was built. Run by .github/workflows/deploy-site.yml:
//   node site/verify-live.mjs <commit> <changed file>...
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SITE = 'https://hotsauce.work'
const DEMO = 'https://demo.hotsauce.work'

// Changed files under site/public/ that are pages people visit, as their addresses.
// Workers assets serve /x/index.html at /x/ and /x.html at /x.
export function pagesFor(changed) {
  return changed
    .filter((f) => f.startsWith('site/public/') && !f.startsWith('site/public/demo/'))
    .map((f) => f.slice('site/public'.length))
    .filter((p) => /\.(html|md|txt|sh)$/.test(p))
    .map((p) => p.replace(/index\.html$/, '').replace(/\.html$/, ''))
}

async function problemsOnce({ sha, changed, publicDir, fetch }) {
  const problems = []
  const get = (url) =>
    fetch(`${url}${url.includes('?') ? '&' : '?'}v=${sha}`, { cache: 'no-store' })
  for (const host of [SITE, DEMO]) {
    const res = await get(`${host}/`)
    const live = res.headers.get('x-site-version')
    if (live !== sha) problems.push(`${host} runs ${live ?? 'an unknown version'}, not ${sha}`)
  }
  const demo = await get(`${DEMO}/`)
  if ((await demo.text()) !== readFileSync(join(publicDir, 'demo', 'index.html'), 'utf8')) {
    problems.push(`${DEMO}/ doesn't match the demo that was built`)
  }
  for (const page of pagesFor(changed)) {
    const file = page.endsWith('/')
      ? `${page}index.html`
      : /\.\w+$/.test(page)
        ? page
        : `${page}.html`
    const res = await get(`${SITE}${page}`)
    const built = readFileSync(join(publicDir, file), 'utf8')
    if (!res.ok || (await res.text()) !== built)
      problems.push(`${SITE}${page} doesn't match ${file}`)
  }
  return problems
}

// Tries again while the new version spreads across Cloudflare; returns the last problems seen.
export async function checkLive({ tries = 12, wait = 10_000, ...opts }) {
  let problems = []
  for (let i = 0; i < tries; i++) {
    problems = await problemsOnce(opts)
    if (problems.length === 0) return problems
    if (i < tries - 1) await new Promise((r) => setTimeout(r, wait))
  }
  return problems
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [sha, ...changed] = process.argv.slice(2)
  const publicDir = join(import.meta.dirname, 'public')
  const problems = await checkLive({ sha, changed, publicDir, fetch })
  for (const p of problems) console.log(`::error::${p}`)
  if (problems.length) process.exit(1)
  console.log(`hotsauce.work and demo.hotsauce.work are live at ${sha}`)
  for (const page of pagesFor(changed)) console.log(`  checked ${SITE}${page}`)
}

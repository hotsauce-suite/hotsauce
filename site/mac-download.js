// The Mac app (docs/PLAN-mac-download.md). It is built on a Mac, so it isn't part of this site:
// each build is its own prerelease on GitHub, tagged mac-app-<build>, with Hotsauce.dmg and
// mac-app.json ({ version, build }). /download/mac sends people to the newest build's disk image,
// and /download/mac.json says which version that is, so the page can show the number.
const REPO = 'hotsauce-suite/hotsauce'
// Only the mac-app-* tags, in one short answer: the release list holds every Hotsauce release
// too (about ten a day), so a Mac build would soon fall off its first page.
const MAC_TAGS_API = `https://api.github.com/repos/${REPO}/git/matching-refs/tags/mac-app-`
const MAC_DOWNLOADS = `https://github.com/${REPO}/releases/download`
// Builds from before mac-app-<build> releases existed; used only when GitHub has never answered.
const MAC_LEGACY_TAG = 'mac-app'
// Ask GitHub at most this often per Cloudflare location; unauthenticated calls share a small limit.
const FRESH_SECONDS = 600
// After a failed ask, wait this long before asking again.
const RETRY_SECONDS = 60
// The last good answer is kept this long, to use while GitHub can't be asked.
const KEEP_SECONDS = 7 * 24 * 3600

/** The newest mac-app-<build> tag among GitHub's refs (or release tag names), or null. */
export function newestMacTag(refs) {
  let best = null
  for (const r of Array.isArray(refs) ? refs : []) {
    const name = typeof r?.ref === 'string' ? r.ref.replace(/^refs\/tags\//, '') : r?.tag_name
    if (typeof name !== 'string') continue
    const m = /^mac-app-(\d+)$/.exec(name)
    if (m && (!best || Number(m[1]) > best.build)) best = { tag: name, build: Number(m[1]) }
  }
  return best ? best.tag : null
}

/** A plain dotted version like 0.34.1, or null. */
function plainVersion(v) {
  return typeof v === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v) ? v : null
}

/** Asks GitHub for the newest build: { tag, version, build }, or null if it can't say. */
async function askGitHub(fetchFn) {
  const headers = { 'user-agent': 'hotsauce.work', accept: 'application/vnd.github+json' }
  const refs = await fetchFn(MAC_TAGS_API, { headers }).catch(() => null)
  if (!refs?.ok) return null
  const tag = newestMacTag(await refs.json().catch(() => null))
  if (!tag) return null
  // The tag alone is enough for the download; the version is a bonus for the page.
  const info = await fetchFn(`${MAC_DOWNLOADS}/${tag}/mac-app.json`, { headers }).catch(() => null)
  const data = info?.ok ? await info.json().catch(() => null) : null
  const build = typeof data?.build === 'string' && /^\d{1,9}$/.test(data.build) ? data.build : null
  return { tag, version: plainVersion(data?.version), build }
}

const keyFor = (name) => new Request(`https://hotsauce.work/__mac-app-${name}`)
const cached = async (cache, name) => {
  const hit = cache && (await cache.match(keyFor(name)).catch(() => null))
  return hit ? hit.json() : undefined
}
const remember = (cache, name, value, seconds) =>
  cache
    ? cache
        .put(
          keyFor(name),
          new Response(JSON.stringify(value), {
            headers: { 'cache-control': `public, max-age=${seconds}` },
          }),
        )
        .catch(() => {})
    : Promise.resolve()

/**
 * The newest Mac app build, kept in Cloudflare's cache so a busy page doesn't use up GitHub's
 * limit. A failed ask is remembered for a minute, and the last good answer is used meanwhile.
 */
async function newestMacApp(fetchFn, cache, waitUntil) {
  const fresh = await cached(cache, 'latest')
  if (fresh !== undefined) return fresh ?? (await cached(cache, 'last-good')) ?? null
  const latest = await askGitHub(fetchFn)
  if (latest) {
    waitUntil(remember(cache, 'latest', latest, FRESH_SECONDS))
    waitUntil(remember(cache, 'last-good', latest, KEEP_SECONDS))
    return latest
  }
  waitUntil(remember(cache, 'latest', null, RETRY_SECONDS))
  return (await cached(cache, 'last-good')) ?? null
}

export async function serveMacDownload(url, env, ctx) {
  const fetchFn = env.fetch ?? ((...a) => fetch(...a))
  const cache = env.cache ?? (typeof caches === 'undefined' ? null : caches.default)
  const pending = []
  const waitUntil = (p) => (ctx?.waitUntil ? ctx.waitUntil(p) : pending.push(p))
  const latest = await newestMacApp(fetchFn, cache, waitUntil)
  await Promise.all(pending)
  const headers = { 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' }
  if (url.pathname === '/download/mac.json') {
    const body = {
      version: latest?.version ?? null,
      build: latest?.build ?? null,
      url: 'https://hotsauce.work/download/mac',
      minimumMacOS: '14.0',
    }
    return new Response(JSON.stringify(body), {
      headers: {
        ...headers,
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
      },
    })
  }
  const tag = latest?.tag ?? MAC_LEGACY_TAG
  return new Response(null, {
    status: 302,
    headers: { ...headers, location: `${MAC_DOWNLOADS}/${tag}/Hotsauce.dmg` },
  })
}

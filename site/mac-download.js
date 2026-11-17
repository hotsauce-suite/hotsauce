// The Mac app (docs/PLAN-mac-download.md). It is built on a Mac, so it isn't part of this site:
// each build is its own prerelease on GitHub, tagged mac-app-<build>, with Hotsauce.dmg and
// mac-app.json ({ version, build }). /download/mac sends people to the newest build's disk image,
// and /download/mac.json says which version that is, so the page can show the number.
const REPO = 'hotsauce-suite/hotsauce'
const MAC_RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=100`
const MAC_DOWNLOADS = `https://github.com/${REPO}/releases/download`
// Builds from before mac-app-<build> releases existed; used only when GitHub can't be asked.
const MAC_LEGACY_TAG = 'mac-app'
const MAC_FRESH_SECONDS = 600

/** The tag of the newest Mac app build among GitHub's releases, or null. */
export function newestMacTag(releases) {
  let best = null
  for (const r of Array.isArray(releases) ? releases : []) {
    if (!r || r.draft === true || typeof r.tag_name !== 'string') continue
    const m = /^mac-app-(\d+)$/.exec(r.tag_name)
    if (m && (!best || Number(m[1]) > best.build)) best = { tag: r.tag_name, build: Number(m[1]) }
  }
  return best ? best.tag : null
}

/** A plain dotted version like 0.34.1, or null. */
function plainVersion(v) {
  return typeof v === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v) ? v : null
}

/**
 * The newest Mac app build: { tag, version, build }, looked up on GitHub and kept for ten minutes
 * in Cloudflare's cache, so a busy page doesn't use up GitHub's limit. Null when GitHub can't say.
 */
async function newestMacApp(fetchFn, cache) {
  const key = new Request('https://hotsauce.work/__mac-app-latest')
  const hit = cache && (await cache.match(key).catch(() => null))
  if (hit) return hit.json()
  const ua = { 'user-agent': 'hotsauce.work', accept: 'application/vnd.github+json' }
  const list = await fetchFn(MAC_RELEASES_API, { headers: ua }).catch(() => null)
  if (!list?.ok) return null
  const tag = newestMacTag(await list.json().catch(() => null))
  if (!tag) return null
  const info = await fetchFn(`${MAC_DOWNLOADS}/${tag}/mac-app.json`, { headers: ua }).catch(
    () => null,
  )
  const data = info?.ok ? await info.json().catch(() => null) : null
  const version = plainVersion(data?.version)
  if (!version) return null
  const build = typeof data.build === 'string' && /^\d{1,9}$/.test(data.build) ? data.build : null
  const latest = { tag, version, build }
  if (cache) {
    const res = new Response(JSON.stringify(latest), {
      headers: { 'cache-control': `public, max-age=${MAC_FRESH_SECONDS}` },
    })
    await cache.put(key, res).catch(() => {})
  }
  return latest
}

export async function serveMacDownload(url, env) {
  const fetchFn = env.fetch ?? ((...a) => fetch(...a))
  const cache = env.cache ?? (typeof caches === 'undefined' ? null : caches.default)
  const latest = await newestMacApp(fetchFn, cache)
  const headers = { 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' }
  if (url.pathname === '/download/mac.json') {
    const body = latest
      ? {
          version: latest.version,
          build: latest.build,
          url: 'https://hotsauce.work/download/mac',
          minimumMacOS: '14.0',
        }
      : { version: null, url: 'https://hotsauce.work/download/mac', minimumMacOS: '14.0' }
    return new Response(JSON.stringify(body), {
      headers: {
        ...headers,
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
      },
    })
  }
  const tag = latest ? latest.tag : MAC_LEGACY_TAG
  return new Response(null, {
    status: 302,
    headers: { ...headers, location: `${MAC_DOWNLOADS}/${tag}/Hotsauce.dmg` },
  })
}

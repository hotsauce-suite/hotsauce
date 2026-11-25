import { Hono } from 'hono'
import type { AppDeps, AppEnv } from './env.js'

/** The Android app's package (docs/PLAN-android.md R2). */
export const ANDROID_PACKAGE = 'work.hotsauce.app'

/**
 * The signing fingerprints of the published Android app (Google Play's app signing key and the
 * upload key), so every Hotsauce server opens it full screen without any setting. Filled in when
 * the app is first published; ANDROID_CERT_SHA256 adds others.
 */
export const PUBLISHED_ANDROID_CERTS: readonly string[] = []

/** The fingerprints a server vouches for: the published app's, then the environment's. */
export function androidCerts(extra: string | undefined): string[] {
  const all = [
    ...PUBLISHED_ANDROID_CERTS,
    ...(extra ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  ]
  return [...new Set(all)]
}

/**
 * `/.well-known/assetlinks.json` (docs/PLAN-android.md R4): tells Chrome that the Hotsauce Android
 * app may show this server full screen, with no address bar (a Trusted Web Activity). Public, as
 * Digital Asset Links requires; it names only the app and its public signing fingerprints.
 */
export function androidWellKnownRoutes(deps: Pick<AppDeps, 'config'>) {
  return new Hono<AppEnv>().get('/assetlinks.json', (c) => {
    const certs = androidCerts(deps.config.ANDROID_CERT_SHA256)
    c.header('Cache-Control', 'public, max-age=3600')
    if (certs.length === 0) return c.json([])
    return c.json([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: ANDROID_PACKAGE,
          sha256_cert_fingerprints: certs,
        },
      },
    ])
  })
}

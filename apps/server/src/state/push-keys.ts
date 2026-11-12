import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import webpush from 'web-push'

/**
 * Web push keys kept on the data volume (and so in the state mirror), for instances whose
 * environment doesn't set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY: generated once, then reused, so
 * members' push subscriptions keep working across restarts. The environment always wins.
 */
export function ensurePushKeys(dataDir: string): { publicKey: string; privateKey: string } {
  const file = path.join(dataDir, 'push', 'vapid.json')
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      publicKey?: string
      privateKey?: string
    }
    if (saved.publicKey && saved.privateKey)
      return { publicKey: saved.publicKey, privateKey: saved.privateKey }
  }
  const keys = webpush.generateVAPIDKeys()
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(keys), { mode: 0o600 })
  renameSync(tmp, file)
  return keys
}

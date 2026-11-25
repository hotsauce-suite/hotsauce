// Sends a release bundle to Google Play internal testing (docs/PLAN-android.md R12) through the
// Google Play Developer API, with no dependencies: a service account's JSON key signs a token,
// then one edit uploads the bundle, puts it on the internal track and commits.
//
//   PLAY_SERVICE_ACCOUNT='<json>' node apps/android/scripts/play-upload.mjs <bundle.aab> [package]
//
// The key is read from the environment and never printed.
import { createSign } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const API = 'https://androidpublisher.googleapis.com'
const [bundlePath, packageName = 'work.hotsauce.app'] = process.argv.slice(2)
if (!bundlePath) throw new Error('usage: play-upload.mjs <bundle.aab> [package]')
const account = JSON.parse(process.env.PLAY_SERVICE_ACCOUNT ?? '')

const b64url = (data) => Buffer.from(data).toString('base64url')

/** An OAuth access token for the service account, scoped to the Play Developer API. */
async function accessToken() {
  const now = Math.floor(Date.now() / 1000)
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(
    JSON.stringify({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: account.token_uri ?? 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 600,
    }),
  )
  const signature = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(account.private_key)
  const res = await fetch(account.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${head}.${claims}.${b64url(signature)}`,
    }),
  })
  if (!res.ok) throw new Error(`Google refused the service account (${res.status})`)
  return (await res.json()).access_token
}

const token = await accessToken()
async function call(method, path, body, type = 'application/json') {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': type } : {}) },
    body: body && type === 'application/json' ? JSON.stringify(body) : body,
  })
  const text = await res.text()
  if (!res.ok)
    throw new Error(`${method} ${path.replace(API, '')}: ${res.status} ${text.slice(0, 500)}`)
  return text ? JSON.parse(text) : {}
}

const app = `/androidpublisher/v3/applications/${packageName}`
const edit = await call('POST', `${app}/edits`, {})
const bundle = await call(
  'POST',
  `${API}/upload${app}/edits/${edit.id}/bundles?uploadType=media`,
  await readFile(bundlePath),
  'application/octet-stream',
)
await call('PUT', `${app}/edits/${edit.id}/tracks/internal`, {
  track: 'internal',
  releases: [{ versionCodes: [String(bundle.versionCode)], status: 'completed' }],
})
await call('POST', `${app}/edits/${edit.id}:commit`)
console.log(`Sent version code ${bundle.versionCode} to internal testing for ${packageName}.`)

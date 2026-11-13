import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { stampForServer } from './stamp.js'
import { zip } from './zip.js'

/** Where Meetings → Chrome extension downloads it (the web app links here). */
export const EXTENSION_ZIP_PATH = '/downloads/hearth-meetings-chrome.zip'

/**
 * The Chrome extension zip for this server: the generic build (`apps/extension/dist`, copied
 * into the image) with this server's address and name written in, so one image serves any
 * organization. Null when the build isn't there (a dev checkout that never built it).
 */
export function extensionZip(
  distDir: string,
  server: { url: string; name: string },
): Buffer | null {
  const manifestFile = path.join(distDir, 'manifest.json')
  if (!existsSync(manifestFile)) return null
  const generic = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>
  const { manifest, serverJson } = stampForServer(generic, server)
  const files = readdirSync(distDir, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => path.relative(distDir, path.join(f.parentPath, f.name)).split(path.sep).join('/'))
    .filter((name) => name !== 'manifest.json' && name !== 'server.json')
    .sort()
  return zip([
    ...files.map((name) => ({ name, data: readFileSync(path.join(distDir, name)) })),
    { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
    { name: 'server.json', data: Buffer.from(serverJson) },
  ])
}

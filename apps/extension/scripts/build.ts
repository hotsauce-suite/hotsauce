// Builds the Chrome extension into dist/ and packs dist/ as release/hearth-meetings-chrome.zip.
//
//   PRODUCT_NAME  the name it shows (default Hotsauce; match the server's PRODUCT_NAME)
//   HEARTH_URL  the instance it talks to (default http://localhost:3000). A localhost URL also
//               allows both dev ports, :3000 (built server) and :5173 (Vite).
//
// The Dockerfile copies the zip to the web app's /downloads/, where Meetings links to it.

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { zip } from './zip.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
const release = path.join(root, 'release')
const ZIP_NAME = 'hearth-meetings-chrome.zip'

const productName = process.env.PRODUCT_NAME?.trim() || 'Hotsauce'
const hearthUrl = new URL(process.env.HEARTH_URL ?? 'http://localhost:3000')
const origins =
  hearthUrl.hostname === 'localhost'
    ? ['http://localhost:3000', 'http://localhost:5173']
    : [hearthUrl.origin]
if (!origins.includes(hearthUrl.origin)) origins.unshift(hearthUrl.origin)

const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  version: string
}

const icons = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png' }
const manifest = {
  manifest_version: 3,
  name: productName,
  version,
  description: `Take notes on Google Meet calls with ${productName}, and save pages to read later.`,
  minimum_chrome_version: '116',
  icons: { ...icons, 128: 'icons/icon-128.png' },
  action: { default_title: productName, default_popup: 'popup.html', default_icon: icons },
  background: { service_worker: 'background.js', type: 'module' },
  permissions: ['tabCapture', 'storage', 'activeTab', 'contextMenus'],
  host_permissions: ['https://meet.google.com/*'],
  content_scripts: [
    {
      // Chrome match patterns carry no port: http://localhost/* covers every dev port.
      matches: [...new Set(origins.map((o) => `${new URL(o).protocol}//${new URL(o).hostname}/*`))],
      js: ['bridge.js'],
      run_at: 'document_start',
    },
  ],
  commands: {
    _execute_action: { suggested_key: { default: 'Alt+Shift+H' } },
  },
}

rmSync(dist, { recursive: true, force: true })
await build({
  entryPoints: ['background', 'bridge', 'popup'].map((n) => path.join(root, 'src', `${n}.ts`)),
  outdir: dist,
  bundle: true,
  format: 'esm',
  target: 'chrome116',
  minify: false,
  legalComments: 'none',
  define: {
    __HEARTH_URL__: JSON.stringify(hearthUrl.origin),
    __HEARTH_ORIGINS__: JSON.stringify(origins),
    __PRODUCT_NAME__: JSON.stringify(productName),
  },
  logLevel: 'warning',
})
cpSync(path.join(root, 'static'), dist, { recursive: true })
writeFileSync(path.join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

const files = readdirSync(dist, { recursive: true, withFileTypes: true })
  .filter((f) => f.isFile())
  .map((f) => path.relative(dist, path.join(f.parentPath, f.name)).split(path.sep).join('/'))
  .sort()
mkdirSync(release, { recursive: true })
writeFileSync(
  path.join(release, ZIP_NAME),
  zip(files.map((name) => ({ name, data: readFileSync(path.join(dist, name)) }))),
)
console.log(`${productName} extension ${version} for ${hearthUrl.origin}: release/${ZIP_NAME}`)

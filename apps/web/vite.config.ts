import { cpSync, createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { msw } from 'msw/vite'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { type BuiltAsset, type BuiltChunk, screenFiles } from './src/build/precache.ts'

// API_PROXY_TARGET points the dev server at a server on another port (e.g. two checkouts at once).
const API_TARGET = process.env.API_PROXY_TARGET ?? 'http://localhost:3000'

/**
 * The live demo (`vite build --mode demo`, docs/PLAN-live-demo.md) runs the mock API in the
 * browser, so it ships MSW's worker script. Normal builds never include it.
 */
function mswWorkerFile(): Plugin {
  const file = createRequire(import.meta.url).resolve('msw/mockServiceWorker.js')
  return {
    name: 'hotsauce-msw-worker-file',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'mockServiceWorker.js', source: readFileSync(file) })
    },
  }
}

/**
 * Whiteboard's fonts (ARCHITECTURE §15.4): Excalidraw fetches them from EXCALIDRAW_ASSET_PATH.
 * The build copies them to dist/excalidraw/fonts and the dev server serves them from the
 * package, so boards never load anything from a CDN.
 */
function excalidrawFonts(): Plugin {
  // The package exports only its entry points: find the folder from the main one (dist/prod/index.js).
  const entry = createRequire(import.meta.url).resolve('@excalidraw/excalidraw')
  const fonts = join(dirname(entry), 'fonts')
  let outDir = 'dist'
  return {
    name: 'hotsauce-excalidraw-fonts',
    configResolved(config) {
      outDir = config.build.outDir
    },
    configureServer(server) {
      server.middlewares.use('/excalidraw/fonts', (req, res, next) => {
        const file = normalize(join(fonts, decodeURIComponent((req.url ?? '').split('?')[0] ?? '')))
        if (!file.startsWith(fonts) || !existsSync(file) || !statSync(file).isFile()) return next()
        res.setHeader(
          'Content-Type',
          file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream',
        )
        createReadStream(file).pipe(res)
      })
    },
    writeBundle() {
      cpSync(fonts, join(outDir, 'excalidraw', 'fonts'), { recursive: true })
    },
  }
}

/**
 * Every screen of the app is kept on the device by the service worker (docs/PLAN-offline.md, A1).
 * This reads the finished bundle and hands the worker's precache list the files our screens need
 * (src/build/precache.ts); library chunks loaded on demand stay cache-on-first-use.
 */
function appScreens() {
  const files = new Set<string>()
  const sourceDir = join(dirname(fileURLToPath(import.meta.url)), 'src')
  const plugin: Plugin = {
    name: 'hotsauce-app-screens',
    apply: 'build',
    generateBundle(_options, bundle) {
      files.clear()
      for (const name of screenFiles(bundle as Record<string, BuiltChunk | BuiltAsset>, sourceDir))
        files.add(name)
    },
  }
  /** workbox's manifestTransforms: drop asset files that aren't one of our screens' files. */
  const transform = <Entry extends { url: string }>(entries: Entry[]) => ({
    manifest: entries.filter(
      (entry) =>
        !entry.url.startsWith('assets/') || entry.url.endsWith('.woff2') || files.has(entry.url),
    ),
    warnings: [],
  })
  return { plugin, transform }
}

const screens = appScreens()

/** The release this build is made from, for the page to notice a newer server
 * (src/lib/appUpdate.ts, docs/PLAN-reload-after-updates.md R1). */
function releaseVersion(): string {
  const file = join(dirname(fileURLToPath(import.meta.url)), '../../HOTSAUCE_VERSION')
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
}

function extensionVersion(): string {
  const file = join(dirname(fileURLToPath(import.meta.url)), '../extension/package.json')
  if (!existsSync(file)) return ''
  const { version } = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }
  return typeof version === 'string' ? version : ''
}

export default defineConfig(({ mode, command }) => ({
  define: {
    // Empty for the dev server and the demo: they never reload themselves.
    // The Chrome extension's version in this build's download (docs/PLAN-extension-setup.md).
    __EXTENSION_VERSION__: JSON.stringify(extensionVersion()),
    __HOTSAUCE_VERSION__: JSON.stringify(
      command === 'build' && mode !== 'demo' ? releaseVersion() : '',
    ),
  },
  // Secrets (VITE_CLERK_PUBLISHABLE_KEY) live in the repo-root .env.local.
  envDir: '../../',
  plugins: [
    react(),
    excalidrawFonts(),
    screens.plugin,
    tailwindcss(),
    // Serves /mockServiceWorker.js from the dev server only; production builds never ship it.
    { ...msw({ mode: 'worker-only' }), apply: 'serve' },
    // The demo has no PWA worker: it would fight MSW's worker, and nobody should install a demo.
    mode === 'demo'
      ? mswWorkerFile()
      : VitePWA({
          registerType: 'autoUpdate',
          injectRegister: 'script-defer',
          includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
          manifest: {
            // The server rewrites the names to the organization's (main.ts, serveWebApp).
            name: 'Hotsauce',
            short_name: 'Hotsauce',
            description: 'Hotsauce: the open sauce office suite.',
            // The app's identity stays the old start_url, so installed icons keep working.
            id: '/docs',
            // Docs on a computer; a phone or tablet opens straight to voice notes (routes/Launch).
            start_url: '/?launch=home',
            display: 'standalone',
            background_color: '#f4ece0',
            theme_color: '#1f1915',
            // Android shows these when the home-screen icon is held; iPhone ignores them.
            shortcuts: [
              {
                name: 'New voice note',
                short_name: 'Voice note',
                description: 'Start recording a voice note',
                url: '/dictate/voice?start=1',
                icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
              },
            ],
            // Android's share sheet offers the installed app; a shared page is saved to Links.
            share_target: {
              action: '/links/save',
              method: 'GET',
              params: { title: 'title', text: 'text', url: 'url' },
            },
            icons: [
              { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
              { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
              {
                src: '/icon-maskable-512.png',
                sizes: '512x512',
                type: 'image/png',
                purpose: 'maskable',
              },
            ],
          },
          workbox: {
            // Take over open tabs as soon as a new deploy's worker installs; without these the
            // new worker waits until every tab is closed and users keep the old build.
            skipWaiting: true,
            clientsClaim: true,
            // Meeting reminders: push and notificationclick handlers (public/push-sw.js).
            importScripts: ['/push-sw.js'],
            navigateFallback: '/index.html',
            // The server's own addresses, never the app shell: the same list main.ts keeps out
            // of the web app (the MCP endpoint and its sign-in discovery, docs/mcp.md).
            navigateFallbackDenylist: [
              /^\/api\//,
              /^\/ws/,
              /^\/downloads\//,
              /^\/mcp(\/|$)/,
              /^\/\.well-known\//,
            ],
            // Precache every screen (appScreens above), in the background once the page has
            // loaded. Library chunks loaded on demand (dozens of CodeMirror modes, diagrams) are
            // cached the first time they load; their names are content-hashed, so cache-first is safe.
            globPatterns: ['index.html', 'assets/**/*.{js,css,woff2}', '*.{svg,png}'],
            manifestTransforms: [screens.transform],
            maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
            runtimeCaching: [
              {
                urlPattern: ({ url, sameOrigin }) =>
                  sameOrigin && url.pathname.startsWith('/assets/'),
                handler: 'CacheFirst',
                options: {
                  cacheName: 'hearth-assets',
                  expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 60 },
                },
              },
              {
                urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/,
                handler: 'CacheFirst',
                options: {
                  cacheName: 'google-fonts',
                  expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
                  cacheableResponse: { statuses: [0, 200] },
                },
              },
            ],
          },
        }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: API_TARGET, ws: true, changeOrigin: true },
    },
  },
  build: {
    target: 'es2023',
    // The demo is served by the hotsauce.work site worker (site/worker.js) at demo.hotsauce.work.
    ...(mode === 'demo' ? { outDir: '../../site/public/demo', emptyOutDir: true } : {}),
    rolldownOptions: {
      // @hotsauce/format is pure (ARCHITECTURE §2) but its package.json doesn't say so. Without
      // this, any import of it (slugify in the sidebar) keeps its top-level zod schemas, and so
      // zod and yaml, in the shell chunk.
      treeshake: { moduleSideEffects: (id) => !id.includes('/packages/format/') },
    },
  },
}))

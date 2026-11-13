import { cpSync, createReadStream, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, normalize } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { msw } from 'msw/vite'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const API_TARGET = 'http://localhost:3000'

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
    name: 'hearth-excalidraw-fonts',
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

export default defineConfig({
  // Secrets (VITE_CLERK_PUBLISHABLE_KEY) live in the repo-root .env.local.
  envDir: '../../',
  plugins: [
    react(),
    excalidrawFonts(),
    tailwindcss(),
    // Serves /mockServiceWorker.js from the dev server only; production builds never ship it.
    { ...msw({ mode: 'worker-only' }), apply: 'serve' },
    VitePWA({
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
        navigateFallbackDenylist: [/^\/api\//, /^\/ws/, /^\/downloads\//],
        // Precache the shell only. Route and language chunks (dozens of CodeMirror modes) are
        // cached the first time they load; their names are content-hashed, so cache-first is safe.
        globPatterns: ['index.html', 'assets/index-*.{js,css}', '*.{svg,png}'],
        runtimeCaching: [
          {
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/assets/'),
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
    rolldownOptions: {
      // @hearth/format is pure (ARCHITECTURE §2) but its package.json doesn't say so. Without
      // this, any import of it (slugify in the sidebar) keeps its top-level zod schemas, and so
      // zod and yaml, in the shell chunk.
      treeshake: { moduleSideEffects: (id) => !id.includes('/packages/format/') },
    },
  },
})

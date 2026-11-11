import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { msw } from 'msw/vite'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const API_TARGET = 'http://localhost:3000'

export default defineConfig({
  // Secrets (VITE_CLERK_PUBLISHABLE_KEY) live in the repo-root .env.local.
  envDir: '../../',
  plugins: [
    react(),
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
        start_url: '/docs',
        display: 'standalone',
        background_color: '#f4ece0',
        theme_color: '#1f1915',
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

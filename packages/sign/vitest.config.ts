import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'sign',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Sealing makes RSA keys and embeds fonts; the slowest test takes a few seconds.
    testTimeout: 30_000,
  },
})

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'server-integration',
    include: ['test/integration/**/*.test.ts'],
    // Real git processes and, when configured, a real Forgejo: slow, and serial to keep the
    // Forgejo container's load predictable.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})

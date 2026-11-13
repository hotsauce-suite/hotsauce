import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { name: 'site', environment: 'node', include: ['*.test.js'] },
})

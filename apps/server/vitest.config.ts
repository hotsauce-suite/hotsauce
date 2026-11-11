import { defineConfig } from 'vitest/config'

// Unit tests only. Integration tests have their own config (vitest.integration.config.ts) so each
// file is a single project the root config can select with --project.
export default defineConfig({
  test: {
    name: 'server-unit',
    include: ['src/**/*.test.ts'],
  },
})

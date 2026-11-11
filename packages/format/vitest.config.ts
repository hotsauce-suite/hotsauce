import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'format',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
})

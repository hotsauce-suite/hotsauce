import { defineConfig } from 'vitest/config'

// Every package ships its own vitest.config.ts. The root scripts filter by these
// project names: format, server-unit, server-integration, web, site.
//
// A package with more than one project ships one config file per extra project
// (`vitest.integration.config.ts`), listed by the glob below. One config that
// declares `projects` itself would also work, but Vitest 5 then namespaces the
// children as "@hearth/server (server-unit)", which `--project server-unit`
// does not match.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'apps/*/vitest.integration.config.ts', 'site'],
    // Reported, not gated (ARCHITECTURE §5). Enable with --coverage.
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text-summary', 'html', 'lcov'],
      include: ['**/src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.{ts,tsx}', '**/*.d.ts'],
    },
  },
})

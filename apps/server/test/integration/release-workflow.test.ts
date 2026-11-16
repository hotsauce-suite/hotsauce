// docs/PLAN-pinned-images.md R1: every release records the exact image it built, published in
// the same step that creates the release, and the name matches what the updater reads.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { IMAGE_DIGEST_ASSET } from '../../src/updates/releases.js'

interface Step {
  id?: string
  uses?: string
  run?: string
  env?: Record<string, string>
}
const workflow = parse(
  readFileSync(
    fileURLToPath(new URL('../../../../.github/workflows/release.yml', import.meta.url)),
    'utf8',
  ),
) as { jobs: { release: { steps: Step[] } } }
const steps = workflow.jobs.release.steps

describe('release workflow', () => {
  it('publishes the pushed image’s digest with the release, in one step', () => {
    const build = steps.find((s) => s.uses?.startsWith('docker/build-push-action@'))
    expect(build?.id).toBeTruthy()
    const publish = steps.filter((s) => s.run?.includes('gh release create'))
    expect(publish).toHaveLength(1)
    const step = publish[0] as Step
    expect(step.env?.DIGEST).toBe(`\${{ steps.${build?.id}.outputs.digest }}`)
    expect(step.run).toContain(`> ${IMAGE_DIGEST_ASSET}`)
    expect(step.run).toMatch(
      new RegExp(`gh release create "v\\$VERSION" ${IMAGE_DIGEST_ASSET.replace('.', '\\.')} `),
    )
    // A missing or odd digest stops the release instead of publishing one nobody can install.
    expect(step.run).toContain('^sha256:[0-9a-f]{64}$')
    expect(step.run).toMatch(/exit 1/)
  })
})

/**
 * `hearth reindex [space]`: rebuilds the index from the working clones. The spaces table comes
 * back from each clone's .hearth/space.yaml, and the files of every space (or just `space`) are
 * indexed from scratch. index.sqlite itself is kept, so recents, stars, conflicts and sync state
 * survive. Safe to run while the server is up.
 *
 *   pnpm --filter @hearth/server reindex [space]      (development)
 *   node apps/server/dist/cli/reindex.js [space]       (production image)
 */
import { loadConfig } from '../config.js'
import { createServices, loadEnvFile } from '../services.js'
import { rebuildRegistryFromClones } from '../spaces/index.js'

async function reindex(only: string | undefined): Promise<void> {
  loadEnvFile()
  const { git, index, indexer } = createServices(loadConfig())
  try {
    const clones = await git.listClones()
    if (only !== undefined && !clones.includes(only)) {
      throw new Error(`No clone of "${only}" under DATA_DIR/repos (have: ${clones.join(', ')})`)
    }
    await rebuildRegistryFromClones(git, index)
    console.log(`spaces: ${index.listSpaces().length} recorded`)
    for (const space of only === undefined ? clones : [only]) {
      await indexer.full(space)
      console.log(`${space}: indexed at ${index.getSyncState(space)?.headOid ?? '(no commits)'}`)
    }
  } finally {
    index.close()
  }
}

reindex(process.argv[2]).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})

/**
 * `move-to-local`: copies every space's repository from the git host (GitHub or Forgejo) onto
 * this server's disk, where HOST_KIND=local keeps them (docs/PLAN-backups-storage.md). Safe to run
 * while the server is up and to run twice; the old host is only read. Afterwards set
 * HOST_KIND=local and restart. Take a backup first.
 *
 *   node apps/server/dist/cli/move-to-local.js          (production image)
 */
import { loadConfig } from '../config.js'
import { moveReposToLocal } from '../hosts/move-to-local.js'
import { loadEnvFile } from '../services.js'

async function main(): Promise<void> {
  loadEnvFile()
  const config = loadConfig()
  const moved = await moveReposToLocal({
    dataDir: config.DATA_DIR,
    localDir: config.LOCAL_HOST_DIR,
  })
  for (const m of moved) {
    console.log(
      m.skipped
        ? `${m.space}: already local`
        : `${m.space}: ${m.branches} branches from ${m.from}${m.unpushed ? `, plus ${m.unpushed} unpushed commits` : ''}`,
    )
  }
  console.log(
    `${moved.length} spaces in ${config.LOCAL_HOST_DIR}. Now set HOST_KIND=local and restart.`,
  )
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})

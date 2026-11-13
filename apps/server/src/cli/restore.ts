/**
 * `restore`: lists backups, or puts one back into DATA_DIR (docs/PLAN-backups-storage.md).
 * Restoring over a live DATA_DIR: stop the server first. On Fly, a machine's process can't be
 * stopped while you're in it, so restore into another folder (`--target /data/restored`), check
 * it, then swap folders from a one-off machine with the volume attached. For a drill, restore to
 * a scratch folder; and if you start a throwaway server on it, set BACKUP=off, or it will add its
 * own backups to the real instance's folder and prune it.
 *
 *   restore list                          every backup under BACKUP_PREFIX, newest first
 *   restore latest [--from <host>]        the newest backup of this instance (or of <host>)
 *   restore <key> [--target <dir>]        that backup, into <dir> (default DATA_DIR)
 *   ... --force                           move what's in the target aside first
 *
 *   pnpm --filter @hearth/server restore list          (development)
 *   node apps/server/dist/cli/restore.js list            (production image)
 */
import { backupInstance, restoreBackup } from '../backup/index.js'
import { dateOfKey } from '../backup/retention.js'
import { loadConfig } from '../config.js'
import { loadEnvFile } from '../services.js'
import { S3Client } from '../storage/s3.js'

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

async function main(args: string[]): Promise<void> {
  loadEnvFile()
  const config = loadConfig()
  if (!config.OBJECT_STORE) throw new Error('No bucket configured (S3_* or R2_* variables)')
  const s3 = new S3Client(config.OBJECT_STORE)
  const what = args[0]
  if (!what || what === '--help') {
    console.log('usage: restore list | latest [--from <host>] | <key> [--target <dir>] [--force]')
    return
  }
  const backups = async (prefix: string) =>
    (await s3.list(prefix))
      .filter((o) => dateOfKey(o.key))
      .sort((a, b) => (dateOfKey(b.key)?.getTime() ?? 0) - (dateOfKey(a.key)?.getTime() ?? 0))
  if (what === 'list') {
    for (const o of await backups(config.BACKUP_PREFIX)) {
      console.log(`${o.key}\t${(o.size / 1_048_576).toFixed(1)} MB`)
    }
    return
  }
  let key = what
  if (what === 'latest') {
    const from = flag(args, '--from') ?? backupInstance(config)
    const newest = (await backups(`${config.BACKUP_PREFIX}${from}/`))[0]
    if (!newest) throw new Error(`No backups under ${config.BACKUP_PREFIX}${from}/`)
    key = newest.key
  }
  const target = flag(args, '--target') ?? config.DATA_DIR
  console.log(`restoring ${key} into ${target}`)
  const { manifest, movedAside } = await restoreBackup({
    s3,
    key,
    target,
    force: args.includes('--force'),
  })
  console.log(`restored ${manifest.files} files from ${manifest.createdAt}`)
  if (movedAside) console.log(`what was there before is in ${movedAside}`)
  console.log(
    'start the server (BACKUP=off for a throwaway copy); search rebuilds from the repositories',
  )
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})

import type { Config } from '../config.js'
import { type ObjectStore, S3Client } from '../storage/s3.js'
import { BackupService } from './service.js'

export { restoreBackup } from './restore.js'
export type { BackupInfo, BackupStatus } from './service.js'
export { BackupService } from './service.js'

/** The instance's folder name in the bucket: its public host. */
export function backupInstance(config: Config): string {
  try {
    return new URL(config.PUBLIC_URL).host.replace(/:/g, '_') || 'hotsauce'
  } catch {
    return 'hotsauce'
  }
}

/** Daily backups, when there's a bucket and BACKUP isn't off; null otherwise. */
export function createBackups(
  config: Config,
  store: ObjectStore | null | undefined,
  lockSpace?: <T>(space: string, fn: () => Promise<T>) => Promise<T>,
): BackupService | null {
  if (config.BACKUP === 'off' || store === null) return null
  const s3 = store ?? (config.OBJECT_STORE ? new S3Client(config.OBJECT_STORE) : null)
  if (!s3) return null
  return new BackupService({
    dataDir: config.DATA_DIR,
    s3,
    prefix: config.BACKUP_PREFIX,
    instance: backupInstance(config),
    hour: config.BACKUP_HOUR,
    ...(lockSpace ? { lockSpace } : {}),
  })
}

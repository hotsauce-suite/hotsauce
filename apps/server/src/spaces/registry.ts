import { parseSpaceConfig, SPACE_LAYOUT } from '@hearth/format'
import { HearthError } from '../errors.js'
import { type SpaceRegistry, TEAM_SPACE } from './service.js'

const SPACE_CONFIG = `${SPACE_LAYOUT.meta}/space.yaml`

/** The slice of GitStore the rebuild needs. */
export interface CloneReader {
  listClones(): Promise<string[]>
  readFile(space: string, path: string): Promise<{ content: string }>
}

/**
 * Rebuilds the spaces table from each clone's `.hearth/space.yaml`, which is where ownership is
 * recorded in Git. Upserts only: a row whose clone is missing is kept, since clones are a cache
 * that comes back on the owner's next request.
 */
export async function rebuildRegistryFromClones(
  git: CloneReader,
  registry: SpaceRegistry,
  log: (message: string) => void = console.warn,
): Promise<void> {
  for (const name of await git.listClones()) {
    const config = await readSpaceConfig(git, name, log)
    if (name === TEAM_SPACE) {
      if (config && config.kind !== 'team') {
        log(`${name}: ${SPACE_CONFIG} says personal; kept as team`)
      }
      registry.upsertSpace({ name, kind: 'team', ownerEmail: null })
    } else if (config?.kind === 'personal' && config.owner !== undefined) {
      registry.upsertSpace({ name, kind: 'personal', ownerEmail: config.owner })
    } else if (config?.kind === 'team') {
      registry.upsertSpace({ name, kind: 'team', ownerEmail: null })
    } else {
      // An older seed without kind/owner. A personal row needs an owner, so record nothing and
      // keep any row we already have. With no row, nobody can open the space until a member
      // with that handle signs in and ensurePersonalSpace claims it.
      log(
        `${name}: ${SPACE_CONFIG} names no owner; treating it as a personal space owned by nobody`,
      )
    }
  }
}

async function readSpaceConfig(
  git: CloneReader,
  name: string,
  log: (message: string) => void,
): Promise<ReturnType<typeof parseSpaceConfig> | null> {
  let text: string
  try {
    text = (await git.readFile(name, SPACE_CONFIG)).content
  } catch (err) {
    if (err instanceof HearthError && err.code === 'not_found') return null
    throw err
  }
  try {
    return parseSpaceConfig(text)
  } catch (err) {
    log(`${name}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

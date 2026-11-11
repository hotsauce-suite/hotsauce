import type { Config } from '../config.js'
import { HearthError } from '../errors.js'
import { ForgejoHost } from './forgejo.js'
import { GitHubHost } from './github.js'
import { LocalHost } from './local.js'
import type { HostAdapter } from './types.js'

export { ForgejoHost } from './forgejo.js'
export { GitHubHost } from './github.js'
export { LocalHost } from './local.js'
export { verifyHmacSha256Hex } from './shared.js'
export type { HostAdapter } from './types.js'

/** The adapter selected by HOST_KIND. */
export function createHostAdapter(config: Config): HostAdapter {
  switch (config.HOST_KIND) {
    case 'local':
      return new LocalHost({ dir: config.LOCAL_HOST_DIR })
    case 'forgejo': {
      const { FORGEJO_URL: url, FORGEJO_TOKEN: token, FORGEJO_ORG: org } = config
      if (!(url && token && org))
        throw new HearthError('internal', 'Forgejo host is not configured')
      return new ForgejoHost({ url, token, org })
    }
    case 'github': {
      const { GITHUB_TOKEN: token, GITHUB_ORG: org } = config
      if (!(token && org)) throw new HearthError('internal', 'GitHub host is not configured')
      return new GitHubHost({ org, credential: async () => token })
    }
  }
}

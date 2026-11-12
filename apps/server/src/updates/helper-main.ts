// Entry point of the short-lived updater machine (docs/PLAN-releases-and-updates.md, R6).
// `node apps/server/dist/updates/helper-main.js`, started by the app with these env vars.
import { flyApi } from './fly.js'
import { runHelper } from './helper.js'

const need = (name: string): string => {
  const v = process.env[name]?.trim()
  if (!v) {
    console.error(`updater: ${name} is not set`)
    process.exit(2)
  }
  return v
}

const result = await runHelper({
  fly: flyApi({ token: need('FLY_API_TOKEN'), app: need('FLY_APP_NAME') }),
  target: need('HOTSAUCE_UPDATE_TARGET'),
  targetVersion: need('HOTSAUCE_UPDATE_VERSION'),
  previous: need('HOTSAUCE_UPDATE_PREVIOUS'),
  publicUrl: need('PUBLIC_URL'),
})
console.log(`updater: ${JSON.stringify(result)}`)
process.exit(result.ok ? 0 : 1)

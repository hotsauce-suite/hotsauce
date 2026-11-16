import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createSealIdentity, type SealIdentity } from '@hotsauce/sign'

/**
 * The key and self-signed certificate Sign seals finished PDFs with (docs/PLAN-sign.md Q5), kept
 * on the data volume (and so in the state mirror and backups): made once, on the first seal, then
 * reused, so every PDF this install seals names the same certificate. A PDF sealed earlier still
 * checks out if the key is ever lost: it carries its own certificate.
 */
export function ensureSealKey(dataDir: string, commonName: string): SealIdentity {
  const file = path.join(dataDir, 'sign', 'seal.json')
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<SealIdentity>
    if (saved.privateKeyPem && saved.certificateChainPem?.length) {
      return { privateKeyPem: saved.privateKeyPem, certificateChainPem: saved.certificateChainPem }
    }
  }
  const made = createSealIdentity({ commonName })
  const identity: SealIdentity = {
    privateKeyPem: made.privateKeyPem,
    certificateChainPem: made.certificateChainPem,
  }
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(identity), { mode: 0o600 })
  renameSync(tmp, file)
  return identity
}

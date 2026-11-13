// Fails when two tracked files differ only in letter case (Keys.tsx and keys.ts). macOS and
// Windows disks ignore case, so one would shadow the other there while Linux CI builds fine.
import { execFileSync } from 'node:child_process'

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
const seen = new Map()
const clashes = []
for (const file of files) {
  const key = file.toLowerCase()
  const other = seen.get(key)
  if (other && other !== file) clashes.push(`${other}  ↔  ${file}`)
  else seen.set(key, file)
}
// Imports name files without extensions, so keys.ts and Keys.tsx clash too.
const stems = new Map()
for (const file of files) {
  if (!/\.(ts|tsx|js|jsx|mjs)$/.test(file)) continue
  const key = file.replace(/\.(ts|tsx|js|jsx|mjs)$/, '').toLowerCase()
  const other = stems.get(key)
  if (other && other.replace(/\.\w+$/, '') !== file.replace(/\.\w+$/, ''))
    clashes.push(`${other}  ↔  ${file}`)
  else stems.set(key, file)
}
if (clashes.length) {
  console.error('These files differ only in case, which breaks builds on Mac and Windows:')
  for (const c of clashes) console.error(`  ${c}`)
  process.exit(1)
}

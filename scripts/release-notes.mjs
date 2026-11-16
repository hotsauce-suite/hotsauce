#!/usr/bin/env node
// Plain-language release notes (docs/PLAN-mac-version-and-whats-new.md, N1 to N3).
//
// Every pull request's description has a "## What's new" section: one line per change people will
// notice, each starting "- " ("- Mac app: ..." for the Mac app), or the word None for changes
// nobody sees. The Release workflow collects those lines into WHATS_NEW.json at the root, which
// Settings → What's new and hotsauce.work/changes show.
//
//   node scripts/release-notes.mjs check                 PR_BODY in the environment; exit 1 if
//                                                        the section is missing or empty
//   node scripts/release-notes.mjs add <version> <date> <prs.jsonl>
//                                                        adds (or replaces) that release's notes in
//                                                        WHATS_NEW.json from {"number","body"} lines
//   node scripts/release-notes.mjs markdown <version>    the release's notes as Markdown, for the
//                                                        GitHub release; nothing if it has none
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const FILE = 'WHATS_NEW.json'
export const MAC_AREA = 'Mac app'

const HEADING = /^#{2,3}\s*What[’']s new\s*:?\s*$/i

/**
 * What a pull request's description says is new:
 * `{ status: 'notes', notes }`, `{ status: 'none' }`, `{ status: 'missing' }` (no section) or
 * `{ status: 'empty' }` (a section with neither lines nor None).
 */
export function parseWhatsNew(body) {
  const text = String(body ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  const start = lines.findIndex((l) => HEADING.test(l.trim()))
  if (start === -1) return { status: 'missing' }
  const section = []
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(line.trim())) break
    section.push(line)
  }
  const notes = []
  let none = false
  for (const raw of section) {
    const line = raw.trim()
    if (!line) continue
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    const content = (bullet ? bullet[1] : line).trim()
    if (/^none\.?(\s*[(:–—-].*)?$/i.test(content)) {
      none = true
      continue
    }
    if (!bullet || !content) continue
    const mac = /^Mac app\s*[:–—-]\s*(.+)$/i.exec(content)
    const textOf = (s) => s.charAt(0).toUpperCase() + s.slice(1)
    notes.push(mac ? { text: textOf(mac[1].trim()), area: MAC_AREA } : { text: textOf(content) })
  }
  if (notes.length > 0) return { status: 'notes', notes }
  return none ? { status: 'none' } : { status: 'empty' }
}

/** The message a failed check prints, or null when the description is fine. */
export function checkMessage(body) {
  const { status } = parseWhatsNew(body)
  if (status === 'missing') {
    return `Add a "## What's new" section to the pull request's description: one line per change people will notice, each starting "- " (start it "- Mac app:" for the Mac app), or the word None. See CONTRIBUTING.md, Release notes.`
  }
  if (status === 'empty') {
    return `The "## What's new" section is empty: add a line starting "- " for each change people will notice, or write None.`
  }
  return null
}

export function readNotes(file = FILE) {
  if (!existsSync(file)) return { releases: [] }
  const data = JSON.parse(readFileSync(file, 'utf8'))
  return { releases: Array.isArray(data.releases) ? data.releases : [] }
}

function compare(a, b) {
  const p = (v) => String(v).split('.').map(Number)
  const x = p(a)
  const y = p(b)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

/**
 * The notes with this release added from its pull requests, newest release first. The same
 * release again replaces its entry; a pull request seen twice counts once. A release whose pull
 * requests all say None isn't listed.
 */
export function addRelease(data, { version, date, prs }) {
  const seen = new Set()
  const notes = []
  for (const pr of prs) {
    if (pr.number != null) {
      if (seen.has(pr.number)) continue
      seen.add(pr.number)
    }
    const parsed = parseWhatsNew(pr.body)
    if (parsed.status === 'notes') notes.push(...parsed.notes)
  }
  const releases = data.releases.filter((r) => r.version !== version)
  if (notes.length > 0) releases.push({ version, date, notes })
  releases.sort((a, b) => compare(b.version, a.version))
  return { releases }
}

export function writeNotes(data, file = FILE) {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

/** A release's notes for its GitHub page; '' when it has none. */
export function markdown(data, version) {
  const release = data.releases.find((r) => r.version === version)
  if (!release || release.notes.length === 0) return ''
  const lines = release.notes.map((n) => `- ${n.area ? `${n.area}: ` : ''}${n.text}`)
  return `## What's new\n\n${lines.join('\n')}\n`
}

function main([command, ...args]) {
  if (command === 'check') {
    const message = checkMessage(process.env.PR_BODY)
    if (message) {
      console.error(message)
      process.exit(1)
    }
    console.log(`What's new: ${JSON.stringify(parseWhatsNew(process.env.PR_BODY))}`)
    return
  }
  if (command === 'add') {
    const [version, date, prsFile] = args
    if (!version || !date || !prsFile) throw new Error('usage: add <version> <date> <prs.jsonl>')
    const prs = readFileSync(prsFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
    writeNotes(addRelease(readNotes(), { version, date, prs }))
    return
  }
  if (command === 'markdown') {
    const [version] = args
    if (!version) throw new Error('usage: markdown <version>')
    process.stdout.write(markdown(readNotes(), version))
    return
  }
  throw new Error(
    'usage: release-notes.mjs check | add <version> <date> <prs.jsonl> | markdown <version>',
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}

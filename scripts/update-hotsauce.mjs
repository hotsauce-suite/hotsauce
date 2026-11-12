#!/usr/bin/env node
// Brings this copy of Hotsauce up to Hotsauce's newest release (docs/self-host.md, "Staying up
// to date"). Run by .github/workflows/update-hotsauce.yml; also fine by hand.
//
// A copy made by the Deploy to Cloudflare button shares no git history with Hotsauce, so instead
// of merging, this applies the change between the release the copy has (HOTSAUCE_VERSION) and the
// newest one, with a three-way apply that keeps the copy's own edits where they don't collide.
// It leaves a commit on a new branch and prints one line of JSON:
//   {"status":"up-to-date","version":"0.2.0"}
//   {"status":"ready","from":"0.2.0","version":"0.3.0","branch":"update-hotsauce/v0.3.0","workflows":[]}
//   (workflows: files under .github/workflows the release changed, which are left for a person)
//   {"status":"conflict","from":"0.2.0","version":"0.3.0"}   (nothing changed; exit code 2)
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const UPSTREAM = process.env.HOTSAUCE_UPSTREAM || 'https://github.com/hotsauce-suite/hotsauce.git'
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const out = (o, code = 0) => {
  console.log(JSON.stringify(o))
  process.exit(code)
}

const semver = (t) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(t)?.slice(1).map(Number) ?? null
const newer = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

const current = readFileSync('HOTSAUCE_VERSION', 'utf8').trim()
git('fetch', '--quiet', '--no-tags', UPSTREAM, '+refs/tags/v*:refs/hotsauce/v*')
const tags = git('for-each-ref', '--format=%(refname:strip=2)', 'refs/hotsauce/')
  .split('\n')
  .filter((t) => semver(t))
let latest = null
for (const t of tags) if (!latest || newer(semver(t), semver(latest))) latest = t
if (
  !latest ||
  latest === `v${current}` ||
  !newer(semver(latest), semver(`v${current}`) ?? [0, 0, 0])
) {
  out({ status: 'up-to-date', version: current })
}
const version = latest.slice(1)
if (!tags.includes(`v${current}`)) {
  console.error(`HOTSAUCE_VERSION says ${current}, which isn't a Hotsauce release.`)
  out({ status: 'conflict', from: current, version }, 2)
}
const branch = `update-hotsauce/${latest}`
git('checkout', '--quiet', '-B', branch)
const patch = execFileSync(
  'git',
  [
    'diff',
    '--binary',
    `refs/hotsauce/v${current}`,
    `refs/hotsauce/${latest}`,
    '--',
    '.',
    ':(exclude)HOTSAUCE_VERSION',
    // GitHub refuses a workflow's own token any push that changes workflow files, so those are
    // listed in the pull request for a person to copy instead.
    ':(exclude).github/workflows',
  ],
  { maxBuffer: 256 * 1024 * 1024 },
)
const workflows = git(
  'diff',
  '--name-only',
  `refs/hotsauce/v${current}`,
  `refs/hotsauce/${latest}`,
  '--',
  '.github/workflows',
)
  .split('\n')
  .filter(Boolean)
try {
  if (patch.length > 0)
    execFileSync('git', ['apply', '--3way', '--index', '--whitespace=nowarn'], {
      input: patch,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
} catch (err) {
  git('reset', '--quiet', '--hard')
  git('checkout', '--quiet', '-')
  console.error(String(err.stderr || err.message))
  out({ status: 'conflict', from: current, version }, 2)
}
writeFileSync('HOTSAUCE_VERSION', `${version}\n`)
git('add', 'HOTSAUCE_VERSION')
git(
  'commit',
  '--quiet',
  '-m',
  `Update Hotsauce to ${version}`,
  '-m',
  `From ${current}. Release notes: https://github.com/hotsauce-suite/hotsauce/releases/tag/${latest}`,
)
out({ status: 'ready', from: current, version, branch, workflows })

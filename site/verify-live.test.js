// The check that runs after GitHub deploys the site (docs/PLAN-site-deploy.md, R3–R5).
// fetch is faked: each test says what the live site answers.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkLive, pagesFor } from './verify-live.mjs'

function publicDir() {
  const dir = mkdtempSync(join(tmpdir(), 'site-'))
  mkdirSync(join(dir, 'help'))
  mkdirSync(join(dir, 'demo'))
  writeFileSync(join(dir, 'index.html'), 'home v2')
  writeFileSync(join(dir, 'help', 'docs.html'), 'help v2')
  writeFileSync(join(dir, 'demo', 'index.html'), 'demo v2')
  return dir
}

function site(pages, version = 'abc') {
  return async (url) => {
    const u = new URL(url)
    const body = pages[`${u.host}${u.pathname}`]
    return new Response(body ?? 'not found', {
      status: body === undefined ? 404 : 200,
      headers: { 'x-site-version': version },
    })
  }
}

const live = {
  'hotsauce.work/': 'home v2',
  'hotsauce.work/help/docs': 'help v2',
  'demo.hotsauce.work/': 'demo v2',
}

describe('pagesFor', () => {
  it('maps changed site files to the addresses people visit', () => {
    expect(
      pagesFor([
        'site/public/index.html',
        'site/public/help/docs.html',
        'site/public/install.md',
        'site/public/img/logo.png',
        'site/worker.js',
        'README.md',
      ]),
    ).toEqual(['/', '/help/docs', '/install.md'])
  })
})

describe('checkLive', () => {
  const opts = { sha: 'abc', publicDir: publicDir(), tries: 1, wait: 0 }

  it('passes when both hosts run this commit and show the new pages', async () => {
    const problems = await checkLive({
      ...opts,
      changed: ['site/public/help/docs.html'],
      fetch: site(live),
    })
    expect(problems).toEqual([])
  })

  it('fails when the live site still runs an older commit', async () => {
    const problems = await checkLive({ ...opts, changed: [], fetch: site(live, 'old') })
    expect(problems.join('\n')).toMatch(/hotsauce.work.*old/)
  })

  it('fails when a changed page does not match what was built', async () => {
    const problems = await checkLive({
      ...opts,
      changed: ['site/public/help/docs.html'],
      fetch: site({ ...live, 'hotsauce.work/help/docs': 'help v1' }),
    })
    expect(problems.join('\n')).toMatch(/\/help\/docs/)
  })

  it('fails when the demo does not match the demo that was built', async () => {
    const problems = await checkLive({
      ...opts,
      changed: [],
      fetch: site({ ...live, 'demo.hotsauce.work/': 'demo v1' }),
    })
    expect(problems.join('\n')).toMatch(/demo.hotsauce.work/)
  })

  it('counts a network error as a problem and tries again', async () => {
    let calls = 0
    const flaky = async (url) => {
      calls++
      if (calls === 1) throw new Error('ECONNRESET')
      return site(live)(url)
    }
    const problems = await checkLive({ ...opts, changed: [], fetch: flaky, tries: 2 })
    expect(problems).toEqual([])
  })

  it('reports the network error when it never clears', async () => {
    const down = async () => {
      throw new Error('ECONNRESET')
    }
    const problems = await checkLive({ ...opts, changed: [], fetch: down })
    expect(problems.join('\n')).toMatch(/ECONNRESET/)
  })

  it('keeps trying until the new version shows up', async () => {
    let calls = 0
    const slow = async (url) => {
      calls++
      return site(live, calls > 3 ? 'abc' : 'old')(url)
    }
    const problems = await checkLive({ ...opts, changed: [], fetch: slow, tries: 5 })
    expect(problems).toEqual([])
  })
})

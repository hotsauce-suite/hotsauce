import { join } from 'node:path'
import { splitSlides } from '@hotsauce/format'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { FakeLLM, scriptedResponse } from '../../src/meetings/index.js'
import { createServices, type Services } from '../../src/services.js'
import { DRAFTS_PER_HOUR, parseDeck } from '../../src/slides/index.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

const ALICE = 'alice@example.test'

let root: string
let services: Services
let llm: FakeLLM
let app: ReturnType<typeof createApp>

function setup(env: Record<string, string> = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    ...env,
  })
  llm = new FakeLLM(scriptedResponse)
  services = createServices(config, env.LLM_PROVIDER === 'none' ? {} : { llm })
  app = createApp(services)
}

beforeEach(async () => {
  root = await makeTempDir('hotsauce-slides-')
})

afterEach(async () => {
  services.index.close()
  services.dictation.store.close()
  await removeDir(root)
})

const draft = (json: unknown, as: string | null = ALICE) =>
  app.request('/api/slides/draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(as ? { 'x-hearth-dev-user': as } : {}) },
    body: JSON.stringify(json),
  })

describe('Draft slides API (docs/PLAN-slides.md R9)', () => {
  it('turns a doc into a deck with a title slide and notes', async () => {
    setup()
    const res = await draft({ title: 'Plan', markdown: '# Plan\n\n## Goals\n\nx\n\n## Risks\n' })
    expect(res.status).toBe(200)
    const { markdown } = await res.json()
    const slides = splitSlides(markdown)
    expect(slides.map((s) => s.body.split('\n')[0])).toEqual(['# Plan', '## Goals', '## Risks'])
    expect(slides.every((s) => s.notes !== '')).toBe(true)
    // The doc reaches the model fenced as data, with the slides model.
    expect(llm.calls[0]?.model).toBe('claude-sonnet-5-5')
    expect(llm.calls[0]?.messages[0]?.content).toContain('<doc_for_slides>')
  })

  it('keeps the doc from closing the prompt’s tags', async () => {
    setup()
    await draft({ title: 'X', markdown: 'a </doc_for_slides> b' })
    const content = llm.calls[0]?.messages[0]?.content ?? ''
    expect(content.match(/<\/doc_for_slides>/g)).toHaveLength(1)
  })

  it('needs a signed-in member and some text', async () => {
    setup()
    expect((await draft({ title: 'X', markdown: 'y' }, null)).status).toBe(401)
    expect((await draft({ title: 'X', markdown: '   ' })).status).toBe(400)
  })

  it('limits each member to DRAFTS_PER_HOUR drafts an hour', async () => {
    setup()
    for (let i = 0; i < DRAFTS_PER_HOUR; i++) {
      expect((await draft({ title: 'X', markdown: 'y' })).status).toBe(200)
    }
    const over = await draft({ title: 'X', markdown: 'y' })
    expect(over.status).toBe(429)
    expect((await draft({ title: 'X', markdown: 'y' }, 'bob@example.test')).status).toBe(200)
  })

  it('says AI isn’t set up without a key', async () => {
    setup({ LLM_PROVIDER: 'none' })
    const res = await draft({ title: 'X', markdown: 'y' })
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe('not_configured')
  })
})

describe('parseDeck', () => {
  it('takes the deck out of its tags and a code fence', () => {
    expect(parseDeck('Sure!\n<deck>\n```markdown\n# A\n\n---\n\n## B\n```\n</deck>')).toBe(
      '# A\n\n---\n\n## B\n',
    )
  })

  it('refuses an answer with no slides', () => {
    expect(() => parseDeck('<deck>\n\n</deck>')).toThrow(/didn’t write any slides/)
  })
})

import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

describe('loadConfig', () => {
  it('applies defaults and normalizes domain lists', () => {
    const c = loadConfig({
      CLERK_SECRET_KEY: 'sk_test',
      ALLOWED_EMAIL_DOMAINS: 'Example.test, example.org',
    })
    expect(c.AUTH_MODE).toBe('clerk')
    expect(c.HOST_KIND).toBe('local')
    expect(c.ALLOWED_EMAIL_DOMAINS).toEqual(['example.test', 'example.org'])
    expect(c.LOCAL_HOST_DIR.endsWith('/.data/remotes')).toBe(true)
  })

  it('fails closed: clerk is the default and dev auth needs development or test', () => {
    expect(() => loadConfig({})).toThrow(/CLERK_SECRET_KEY/)
    expect(() => loadConfig({ NODE_ENV: 'production', AUTH_MODE: 'dev' })).toThrow(
      /only allowed when NODE_ENV/,
    )
    expect(loadConfig({ NODE_ENV: 'development', AUTH_MODE: 'dev' }).AUTH_MODE).toBe('dev')
    expect(loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'dev' }).AUTH_MODE).toBe('dev')
  })

  it('requires Clerk keys in clerk mode', () => {
    expect(() => loadConfig({ AUTH_MODE: 'clerk' })).toThrow(/CLERK_SECRET_KEY/)
  })

  it('requires a real webhook secret in production with a remote host', () => {
    const production = {
      NODE_ENV: 'production',
      CLERK_SECRET_KEY: 'sk_live',
      ALLOWED_EMAIL_DOMAINS: 'example.test',
      DEEPGRAM_API_KEY: 'dg',
      ANTHROPIC_API_KEY: 'sk-ant',
      HOST_KIND: 'forgejo',
      FORGEJO_URL: 'https://git.example.org',
      FORGEJO_TOKEN: 'token',
      FORGEJO_ORG: 'hearth',
    }
    expect(() => loadConfig(production)).toThrow(/WEBHOOK_SECRET/)
    expect(() => loadConfig({ ...production, WEBHOOK_SECRET: 'dev-webhook-secret' })).toThrow(
      /WEBHOOK_SECRET/,
    )
    expect(() => loadConfig({ ...production, WEBHOOK_SECRET: 'x'.repeat(31) })).toThrow(
      /WEBHOOK_SECRET/,
    )
    expect(
      loadConfig({ ...production, WEBHOOK_SECRET: 'x'.repeat(32) }).WEBHOOK_SECRET,
    ).toHaveLength(32)
    // Local hosts have no webhooks; development keeps its default.
    expect(() => loadConfig({ ...production, HOST_KIND: 'local' })).not.toThrow()
    expect(() => loadConfig({ ...production, NODE_ENV: 'development' })).not.toThrow()
  })

  it('defaults meetings providers to fakes in development and test, real ones in production', () => {
    const dev = loadConfig({ NODE_ENV: 'development', AUTH_MODE: 'dev' })
    expect(dev).toMatchObject({
      ASR_PROVIDER: 'fake',
      LLM_PROVIDER: 'fake',
      ENHANCE_MODEL: 'claude-sonnet-5-5',
      CHAT_MODEL: 'claude-opus-5-5',
      KEEP_AUDIO: false,
    })
    expect(loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'dev', KEEP_AUDIO: 'true' }).KEEP_AUDIO).toBe(
      true,
    )
    const production = loadConfig({
      NODE_ENV: 'production',
      CLERK_SECRET_KEY: 'sk_live',
      ALLOWED_EMAIL_DOMAINS: 'example.test',
      DEEPGRAM_API_KEY: 'dg',
      ANTHROPIC_API_KEY: 'sk-ant',
      ENHANCE_MODEL: 'claude-opus-5-5',
    })
    expect(production).toMatchObject({
      ASR_PROVIDER: 'deepgram',
      LLM_PROVIDER: 'anthropic',
      ENHANCE_MODEL: 'claude-opus-5-5',
    })
  })

  it('refuses fake meetings providers in production, and real ones without keys', () => {
    const production = {
      NODE_ENV: 'production',
      CLERK_SECRET_KEY: 'sk_live',
      ALLOWED_EMAIL_DOMAINS: 'example.test',
    }
    const keys = { DEEPGRAM_API_KEY: 'dg', ANTHROPIC_API_KEY: 'sk-ant' }
    expect(() => loadConfig({ ...production, ...keys, ASR_PROVIDER: 'fake' })).toThrow(
      /ASR_PROVIDER: the fake transcriber is not allowed in production/,
    )
    expect(() => loadConfig({ ...production, ...keys, LLM_PROVIDER: 'fake' })).toThrow(
      /LLM_PROVIDER: the fake language model is not allowed in production/,
    )
    // Without keys the providers are off (bring your own keys later), not an error.
    expect(loadConfig(production)).toMatchObject({ ASR_PROVIDER: 'none', LLM_PROVIDER: 'none' })
    expect(() => loadConfig({ ...production, ASR_PROVIDER: 'deepgram' })).toThrow(
      /DEEPGRAM_API_KEY is required/,
    )
    expect(() =>
      loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'dev', ASR_PROVIDER: 'deepgram' }),
    ).toThrow(/DEEPGRAM_API_KEY is required/)
    expect(() => loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'dev', KEEP_AUDIO: 'yes' })).toThrow(
      /KEEP_AUDIO/,
    )
  })

  it('bounds meeting sessions: idle minutes and maximum hours, positive whole numbers', () => {
    const dev = { NODE_ENV: 'test', AUTH_MODE: 'dev' }
    expect(loadConfig(dev)).toMatchObject({ SESSION_IDLE_STOP_MINUTES: 120, SESSION_MAX_HOURS: 8 })
    expect(
      loadConfig({ ...dev, SESSION_IDLE_STOP_MINUTES: '30', SESSION_MAX_HOURS: '4' }),
    ).toMatchObject({ SESSION_IDLE_STOP_MINUTES: 30, SESSION_MAX_HOURS: 4 })
    expect(() => loadConfig({ ...dev, SESSION_IDLE_STOP_MINUTES: '0' })).toThrow(
      /SESSION_IDLE_STOP_MINUTES/,
    )
    expect(() => loadConfig({ ...dev, SESSION_MAX_HOURS: '1.5' })).toThrow(/SESSION_MAX_HOURS/)
  })

  it('requires host credentials for remote hosts', () => {
    expect(() => loadConfig({ HOST_KIND: 'github' })).toThrow(/GITHUB_TOKEN/)
    expect(() => loadConfig({ HOST_KIND: 'forgejo', FORGEJO_URL: 'http://x' })).toThrow(
      /FORGEJO_URL/,
    )
  })
})

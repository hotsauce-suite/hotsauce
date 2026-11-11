import { describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { authorizedParties, ClerkAuth, createAuthenticator, DevAuth } from './index.js'

describe('createAuthenticator', () => {
  it('picks DevAuth in dev mode', () => {
    expect(createAuthenticator(loadConfig({ AUTH_MODE: 'dev' }))).toBeInstanceOf(DevAuth)
  })

  it('picks ClerkAuth in clerk mode', () => {
    const config = loadConfig({ AUTH_MODE: 'clerk', CLERK_SECRET_KEY: 'sk_test_x' })
    expect(createAuthenticator(config)).toBeInstanceOf(ClerkAuth)
  })
})

describe('authorizedParties', () => {
  it('is the public origin, plus the Vite dev origin only in development', () => {
    const publicUrl = 'https://hearth.example.com/app'
    expect(authorizedParties({ NODE_ENV: 'production', PUBLIC_URL: publicUrl })).toEqual([
      'https://hearth.example.com',
    ])
    expect(authorizedParties({ NODE_ENV: 'test', PUBLIC_URL: publicUrl })).toEqual([
      'https://hearth.example.com',
    ])
    expect(authorizedParties({ NODE_ENV: 'development', PUBLIC_URL: publicUrl })).toEqual([
      'https://hearth.example.com',
      'http://localhost:5173',
    ])
  })
})

import { describe, expect, it } from 'vitest'
import { isServerPage, matchPatterns, originsFor, parseServerUrl } from './server'

describe('parseServerUrl', () => {
  it('keeps the origin and adds https to a bare host', () => {
    expect(parseServerUrl(' hotsauce.acme.com/docs ')).toEqual({ url: 'https://hotsauce.acme.com' })
    expect(parseServerUrl('https://office.example.com/')).toEqual({
      url: 'https://office.example.com',
    })
    expect(parseServerUrl('http://localhost:3000')).toEqual({ url: 'http://localhost:3000' })
  })
  it('refuses plain http elsewhere, and nonsense', () => {
    expect(parseServerUrl('http://office.example.com')).toHaveProperty('error')
    expect(parseServerUrl('')).toHaveProperty('error')
    expect(parseServerUrl('ftp://x.example')).toHaveProperty('error')
  })
})

describe('origins', () => {
  it('is the server alone, or both dev ports on localhost', () => {
    expect(originsFor('https://office.example.com')).toEqual(['https://office.example.com'])
    expect(originsFor('http://localhost:5173')).toEqual([
      'http://localhost:5173',
      'http://localhost:3000',
    ])
    expect(matchPatterns('http://localhost:5173')).toEqual(['http://localhost/*'])
    expect(matchPatterns('https://office.example.com')).toEqual(['https://office.example.com/*'])
  })
  it('knows the server’s own pages', () => {
    const server = { url: 'https://office.example.com', name: 'Hotsauce' }
    expect(isServerPage(server, 'https://office.example.com/meetings')).toBe(true)
    expect(isServerPage(server, 'https://evil.example/meetings')).toBe(false)
    expect(isServerPage(null, 'https://office.example.com/')).toBe(false)
  })
})

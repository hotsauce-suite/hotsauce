import { describe, expect, it } from 'vitest'
import { isId, newId } from './ids.js'

describe('newId', () => {
  it('makes uppercase ULIDs', () => {
    const id = newId()
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(isId(id)).toBe(true)
  })

  it('makes unique ids that sort by creation time', async () => {
    const first = newId()
    await new Promise((resolve) => setTimeout(resolve, 2))
    const second = newId()
    expect(second > first).toBe(true)
    expect(new Set(Array.from({ length: 1000 }, newId)).size).toBe(1000)
  })
})

describe('isId', () => {
  it('accepts a ULID', () => {
    expect(isId('01JA2Z8Q4M7V3K9R5T1XWYB6CD')).toBe(true)
  })

  it('rejects the wrong length, lowercase, and letters outside Crockford base32', () => {
    expect(isId('')).toBe(false)
    expect(isId('01JA2Z8Q4M7V3K9R5T1XWYB6C')).toBe(false)
    expect(isId('01JA2Z8Q4M7V3K9R5T1XWYB6CDE')).toBe(false)
    expect(isId('01ja2z8q4m7v3k9r5t1xwyb6cd')).toBe(false)
    expect(isId('01JA2Z8Q4M7V3K9R5T1XWYB6CI')).toBe(false)
    expect(isId('01JA2Z8Q4M7V3K9R5T1XWYB6CU')).toBe(false)
  })

  it('rejects a timestamp beyond the 48-bit range', () => {
    expect(isId('81JA2Z8Q4M7V3K9R5T1XWYB6CD')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { connectorName } from './tokens'

describe('connectorName', () => {
  it('names the connector after the product', () => {
    expect(connectorName('Hotsauce')).toBe('hotsauce')
    expect(connectorName('Acme Office')).toBe('acme-office')
  })

  it('falls back to hotsauce when the name has no letters or digits', () => {
    expect(connectorName('✨')).toBe('hotsauce')
  })
})

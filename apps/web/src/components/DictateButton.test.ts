import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isSendKey, SEND_TAIL_MS } from './DictateButton'

const press = (key: string, extra: Partial<KeyboardEvent> = {}, target: Element | null = null) =>
  ({
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    repeat: false,
    target,
    ...extra,
  }) as KeyboardEvent

describe('the web send key (docs/PLAN-dictate-send-and-sounds.md, R5)', () => {
  it('matches the member’s key, and nothing for Off', () => {
    expect(isSendKey('space', press(' '))).toBe(true)
    expect(isSendKey('return', press('Enter'))).toBe(true)
    expect(isSendKey('tab', press('Tab'))).toBe(true)
    expect(isSendKey('space', press('Enter'))).toBe(false)
    expect(isSendKey('off', press(' '))).toBe(false)
  })

  it('leaves shortcuts, repeats and typing in a text field alone', () => {
    expect(isSendKey('space', press(' ', { metaKey: true }))).toBe(false)
    expect(isSendKey('space', press(' ', { altKey: true }))).toBe(false)
    expect(isSendKey('space', press(' ', { repeat: true }))).toBe(false)
    const box = document.createElement('textarea')
    document.body.append(box)
    expect(isSendKey('space', press(' ', {}, box))).toBe(false)
    const button = document.createElement('button')
    document.body.append(button)
    expect(isSendKey('space', press(' ', {}, button))).toBe(true)
  })
})

describe('the send key keeps listening a moment', () => {
  it('long enough to catch the word it was pressed on, the same as the Mac app', () => {
    expect(SEND_TAIL_MS).toBeGreaterThanOrEqual(300)
    expect(SEND_TAIL_MS).toBeLessThanOrEqual(1000)
    const swift = readFileSync(
      path.resolve(__dirname, '../../../dictate-mac/Sources/DictateCore/SendKey.swift'),
      'utf8',
    )
    const mac = Number(/static let tailSeconds = ([\d.]+)/.exec(swift)?.[1])
    expect(mac * 1000).toBe(SEND_TAIL_MS)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extensionVersion, meetTabFromExtension, resetExtensionForTests } from './extension'

type Answer = (message: {
  type: string
  id: string
  code?: string
}) => Record<string, unknown> | null

/** Stands in for the extension's bridge script: answers the page's window messages. */
function installBridge(answer: Answer): () => void {
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { source?: string; type: string; id: string; code?: string }
    if (data?.source !== 'hearth-page') return
    const reply = answer(data)
    // jsdom's postMessage leaves origin and source empty; a browser fills both in.
    if (reply) {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'hearth-extension', type: data.type, id: data.id, ...reply },
          origin: window.location.origin,
          source: window,
        }),
      )
    }
  }
  window.addEventListener('message', onMessage)
  return () => window.removeEventListener('message', onMessage)
}

const stream = { id: 'tab-stream' } as unknown as MediaStream

let uninstall: (() => void) | null = null
beforeEach(() => resetExtensionForTests())
afterEach(() => {
  uninstall?.()
  uninstall = null
})

describe('the Hearth extension', () => {
  it('is not installed when nothing answers hello', async () => {
    expect(await extensionVersion()).toBeNull()
    const media = { getUserMedia: vi.fn() }
    expect(await meetTabFromExtension(null, media)).toBeNull()
    expect(media.getUserMedia).not.toHaveBeenCalled()
  })

  it('hands over the Meet tab’s audio and plays it back, since capture mutes the tab', async () => {
    const asked: Array<string | undefined> = []
    uninstall = installBridge((m) => {
      if (m.type === 'hello') return { version: '0.1.0' }
      asked.push(m.code)
      return { ok: true, streamId: 'stream-123', code: 'abc-defg-hij' }
    })
    expect(await extensionVersion()).toBe('0.1.0')
    const media = { getUserMedia: vi.fn(async () => stream) }
    const play = vi.fn()
    expect(await meetTabFromExtension('abc-defg-hij', media, play)).toBe(stream)
    expect(asked).toEqual(['abc-defg-hij'])
    expect(media.getUserMedia).toHaveBeenCalledWith({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'stream-123' } },
      video: false,
    })
    expect(play).toHaveBeenCalledWith(stream)
  })

  it('answers null when the person hasn’t clicked the icon on a Meet call', async () => {
    uninstall = installBridge((m) =>
      m.type === 'hello'
        ? { version: '0.1.0' }
        : { ok: false, reason: 'not-invoked', message: 'Click the Hearth icon' },
    )
    const media = { getUserMedia: vi.fn() }
    expect(await meetTabFromExtension(null, media, vi.fn())).toBeNull()
    expect(media.getUserMedia).not.toHaveBeenCalled()
  })
})

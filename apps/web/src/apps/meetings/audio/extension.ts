// The Meet tab's audio through the Hearth Meetings Chrome extension (apps/extension), which
// skips Chrome's "pick a tab, tick share audio" dialog. This is the page side of
// apps/extension/src/protocol.ts; keep the two in step.
//
// The extension's bridge script answers window messages on Hearth's own pages. It hands back a
// stream id for the Meet tab the person clicked the Hearth icon on, and getUserMedia turns that
// id into the tab's audio.

const PAGE = 'hearth-page'
const EXTENSION = 'hearth-extension'

/** How long to wait for the bridge to say hello. It's already listening when it's installed. */
const HELLO_MS = 300
/** Chrome answers a capture in well under a second; this only catches a stuck extension. */
const CAPTURE_MS = 10_000

type Reply = Record<string, unknown> & { type: string; id: string }

let seq = 0

function ask(
  type: 'hello' | 'capture-meet',
  timeoutMs: number,
  extra: Record<string, string> = {},
): Promise<Reply | null> {
  seq += 1
  const id = `${Date.now().toString(36)}-${seq}`
  return new Promise((resolve) => {
    const done = (reply: Reply | null) => {
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      resolve(reply)
    }
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return
      const data = event.data as Partial<Reply> | null
      if (data?.source === EXTENSION && data.type === type && data.id === id) done(data as Reply)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    window.addEventListener('message', onMessage)
    window.postMessage({ ...extra, source: PAGE, type, id }, window.location.origin)
  })
}

let installed: Promise<string | null> | null = null

/**
 * The installed extension's version, or null. A yes is remembered for the page; a no is asked
 * again next time, in case the answer was only slow.
 */
export function extensionVersion(): Promise<string | null> {
  installed ??= ask('hello', HELLO_MS).then((reply) => {
    const version = typeof reply?.version === 'string' ? reply.version : null
    if (!version) installed = null
    return version
  })
  return installed
}

/** For tests: forget what the last hello said. */
export function resetExtensionForTests(): void {
  installed = null
}

/**
 * Capturing a tab mutes it for the person, so the page plays the call back. The Start page only
 * captures after a click, so the browser lets it play.
 */
function playBack(stream: MediaStream): void {
  const audio = new Audio()
  audio.srcObject = stream
  void audio.play().catch(() => {})
}

/**
 * The Meet tab's audio, or null when the extension isn't installed or the person hasn't clicked
 * its icon on the call. Null means: fall back to Chrome's share dialog. `call` is the meeting's
 * Meet code when the page knows it; without it, the extension only hands over a tab clicked in
 * the last few minutes.
 */
export async function meetTabFromExtension(
  call: string | null,
  media: Pick<MediaDevices, 'getUserMedia'> = navigator.mediaDevices,
  play: (stream: MediaStream) => void = playBack,
): Promise<MediaStream | null> {
  if (!(await extensionVersion())) return null
  const reply = await ask('capture-meet', CAPTURE_MS, call ? { code: call } : {})
  if (reply?.ok !== true || typeof reply.streamId !== 'string') return null
  // Chrome's legacy constraints for a tab capture stream id; not in the DOM typings.
  const constraints = {
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: reply.streamId } },
    video: false,
  } as unknown as MediaStreamConstraints
  const stream = await media.getUserMedia(constraints)
  play(stream)
  return stream
}

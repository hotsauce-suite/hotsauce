const LABEL_TRAILER = 'Hearth-Label'

/** `<app>: <verb> "<title>"`, plus a `Hearth-Label: <label>` trailer for named versions. */
export function formatCommitMessage(args: {
  app: string
  verb: string
  title: string
  label?: string
}): string {
  return withLabel(`${args.app}: ${args.verb} "${args.title}"`, args.label)
}

/** Appends a `Hearth-Label: <label>` trailer to any message; a blank label adds nothing. */
export function withLabel(message: string, label?: string): string {
  const oneLine = label?.replace(/\s+/g, ' ').trim()
  return oneLine ? `${message}\n\n${LABEL_TRAILER}: ${oneLine}` : message
}

const VIA_TRAILER = 'Hearth-Via'

/**
 * Appends a `Hearth-Via: <via>` trailer saying the change came through an agent channel (MCP),
 * joining the label trailer's paragraph when there is one.
 */
export function withVia(message: string, via?: string): string {
  const oneLine = via?.replace(/\s+/g, ' ').trim()
  if (!oneLine) return message
  const trailer = `${VIA_TRAILER}: ${oneLine}`
  const lastParagraph = message.slice(message.lastIndexOf('\n\n') + 2)
  const hasTrailers = message.includes('\n\n') && lastParagraph.startsWith(`${LABEL_TRAILER}:`)
  return hasTrailers ? `${message}\n${trailer}` : `${message}\n\n${trailer}`
}

/** Splits a raw commit message into the message without the label trailer, and the label. */
export function parseCommitMessage(raw: string): { message: string; label?: string } {
  const text = raw.replace(/\s+$/, '')
  const paragraphStart = text.lastIndexOf('\n\n')
  // Trailers live in the last paragraph, and a subject line alone is never a trailer block.
  if (paragraphStart === -1) return { message: text }

  const lines = text.slice(paragraphStart + 2).split('\n')
  const prefix = `${LABEL_TRAILER}:`
  const labelLine = lines.find((line) => line.startsWith(prefix))
  if (labelLine === undefined) return { message: text }

  const label = labelLine.slice(prefix.length).trim()
  const rest = lines.filter((line) => line !== labelLine)
  const head = text.slice(0, paragraphStart)
  const message = rest.length > 0 ? `${head}\n\n${rest.join('\n')}` : head
  return label ? { message, label } : { message }
}

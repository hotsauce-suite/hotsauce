// Commits before 0.15 carry the same trailers as `Hotsauce-*`; both spellings are read.
const LABEL_TRAILER = 'Hotsauce-Label'
const LABEL_PREFIXES = ['Hotsauce-Label:', 'Hearth-Label:']

/** `<app>: <verb> "<title>"`, plus a `Hotsauce-Label: <label>` trailer for named versions. */
export function formatCommitMessage(args: {
  app: string
  verb: string
  title: string
  label?: string
}): string {
  return withLabel(`${args.app}: ${args.verb} "${args.title}"`, args.label)
}

/** Appends a `Hotsauce-Label: <label>` trailer to any message; a blank label adds nothing. */
export function withLabel(message: string, label?: string): string {
  const oneLine = label?.replace(/\s+/g, ' ').trim()
  return oneLine ? `${message}\n\n${LABEL_TRAILER}: ${oneLine}` : message
}

const VIA_TRAILER = 'Hotsauce-Via'
const VIA_PREFIXES = ['Hotsauce-Via:', 'Hearth-Via:']

/** The trailer prefix `line` starts with, if any. */
const prefixOf = (line: string, prefixes: string[]) => prefixes.find((p) => line.startsWith(p))

/**
 * Appends a `Hotsauce-Via: <via>` trailer saying the change came through an agent channel (MCP),
 * joining the label trailer's paragraph when there is one.
 */
export function withVia(message: string, via?: string): string {
  const oneLine = via?.replace(/\s+/g, ' ').trim()
  if (!oneLine) return message
  const trailer = `${VIA_TRAILER}: ${oneLine}`
  const lastParagraph = message.slice(message.lastIndexOf('\n\n') + 2)
  const hasTrailers =
    message.includes('\n\n') && prefixOf(lastParagraph, LABEL_PREFIXES) !== undefined
  return hasTrailers ? `${message}\n${trailer}` : `${message}\n\n${trailer}`
}

/** Splits a raw commit message into the message without the label trailer, and the label. */
export function parseCommitMessage(raw: string): { message: string; label?: string } {
  const text = raw.replace(/\s+$/, '')
  const paragraphStart = text.lastIndexOf('\n\n')
  // Trailers live in the last paragraph, and a subject line alone is never a trailer block.
  if (paragraphStart === -1) return { message: text }

  const lines = text.slice(paragraphStart + 2).split('\n')
  const labelLine = lines.find((line) => prefixOf(line, LABEL_PREFIXES) !== undefined)
  if (labelLine === undefined) return { message: text }

  const label = labelLine.slice((prefixOf(labelLine, LABEL_PREFIXES) ?? '').length).trim()
  const rest = lines.filter((line) => line !== labelLine)
  const head = text.slice(0, paragraphStart)
  const message = rest.length > 0 ? `${head}\n\n${rest.join('\n')}` : head
  return label ? { message, label } : { message }
}

/**
 * Who made a change through an agent channel, for the history list ("Morgan via Cursor"): the
 * AI tool's name from a `Hotsauce-Via: mcp (client "Cursor", token "My laptop")` trailer, else the
 * token's name (older trailers), else "an AI tool" for a bare `mcp`. Other channels have none.
 */
export function viaLabel(message: string): string | undefined {
  const line = message
    .split('\n')
    .slice(1)
    .find((l) => prefixOf(l, VIA_PREFIXES) !== undefined)
  if (line === undefined) return undefined
  const via = line.slice((prefixOf(line, VIA_PREFIXES) ?? '').length).trim()
  const channel = /^(mcp|api)\b/.exec(via)?.[1]
  if (channel === undefined) return undefined
  // The client, when there is one, comes first: `mcp (client "Cursor", token "…")`.
  const client = /^mcp \(client "([^"]*)"/.exec(via)?.[1]
  if (client) return client
  const token = /^(?:mcp|api) \((?:client "[^"]*", )?token "([^"]*)"/.exec(via)?.[1]
  if (token) return token
  return channel === 'mcp' ? 'an AI tool' : undefined
}

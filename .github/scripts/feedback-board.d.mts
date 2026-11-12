// Types for feedback-board.mjs, so the server's tests can import it.
export const PROJECT_TITLE: string
export const FIELD_NAME: string
export const COLUMNS: { name: string; color: string; description: string }[]
export const LABELS: { name: string; color: string; description: string }[]
export function statusLabel(column: string): string
export function columnOf(labels: string[], state: string): string
export function decide(input: {
  column: string | null
  columnUpdatedAt: string | null
  labelColumn: string
  labelUpdatedAt: string | null
}): 'none' | 'set-column' | 'set-labels'
// biome-ignore lint/suspicious/noExplicitAny: an Actions event payload
export function statusChanged(payload: any): boolean
export function run(input: {
  // biome-ignore lint/suspicious/noExplicitAny: the octokit from actions/github-script
  github: any
  // biome-ignore lint/suspicious/noExplicitAny: the Actions context
  context: any
  // biome-ignore lint/suspicious/noExplicitAny: @actions/core
  core: any
  mode: 'event' | 'sweep' | 'setup'
  hasToken: boolean
}): Promise<void>

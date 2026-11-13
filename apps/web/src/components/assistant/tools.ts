import type { ToolView } from '../../api/assistant'

/** What each tool did, in plain words, for the panel's activity lines. */
const LABELS: Record<string, string> = {
  search: 'Searched',
  list_spaces: 'Looked at your spaces',
  list_files: 'Listed files',
  read_file: 'Read',
  write_file: 'Wrote',
  move_file: 'Move',
  delete_file: 'Delete',
  file_history: 'Looked at the history of',
  restore_file: 'Restored',
  list_meetings: 'Looked through meetings',
  get_meeting: 'Read the meeting',
  ask_meetings: 'Asked across meetings',
  get_agent_brief: 'Read your brief',
  get_brand: 'Read the brand kit',
  list_tasks: 'Looked at tasks',
  add_task: 'Added a task',
  update_task: 'Updated a task',
  complete_task: 'Completed a task',
  list_notes: 'Looked at notes',
  add_note: 'Added a note',
  update_note: 'Updated a note',
  list_boards: 'Looked at boards',
  read_board: 'Read a board',
  find_person: 'Looked up',
  get_person: 'Read about',
  list_clips: 'Looked at clips',
  get_clip: 'Watched a clip',
  list_events: 'Checked your calendar',
  get_event: 'Read the invite',
  list_drive_files: 'Looked through Files',
  get_drive_file: 'Read',
  list_links: 'Looked at saved links',
  get_link: 'Read a saved link',
  publish_page: 'Publish as a page',
  list_pages: 'Looked at pages',
  get_page: 'Read a page',
  share_link: 'Turn on a read-only link for',
  list_tables: 'Looked at tables',
  read_table: 'Read a table',
  update_table: 'Updated a table',
  create_table: 'Created a table',
  list_checkins: 'Looked at check-ins',
  get_checkin: 'Read a check-in',
}

function field(input: unknown, key: string): string | null {
  if (!input || typeof input !== 'object') return null
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** "Searched “quokka launch”", "Read team/docs/plan.md", "Added a task". */
export function toolLine(tool: Pick<ToolView, 'name' | 'input'>): string {
  const label = LABELS[tool.name] ?? tool.name.replace(/_/g, ' ')
  const query = field(tool.input, 'query') ?? field(tool.input, 'question')
  if (query) return `${label} “${query}”`
  const path = field(tool.input, 'path')
  const space = field(tool.input, 'space')
  if (path) return `${label} ${space ? `${space}/` : ''}${path}`
  const text = field(tool.input, 'text') ?? field(tool.input, 'title') ?? field(tool.input, 'name')
  if (text && /^(Added|Looked up|Read about)/.test(label)) {
    return `${label}: ${text.length > 60 ? `${text.slice(0, 59)}…` : text}`
  }
  return label
}

/** A `hearth:<space>/<path>` link from the model, as an in-app address; null when it isn't one. */
export function hearthTarget(href: string): { space: string; path: string } | null {
  const match = /^hearth:([^/\s]+)\/(.+)$/.exec(href)
  if (!match?.[1] || !match[2]) return null
  try {
    return { space: decodeURIComponent(match[1]), path: decodeURIComponent(match[2]) }
  } catch {
    return { space: match[1], path: match[2] }
  }
}

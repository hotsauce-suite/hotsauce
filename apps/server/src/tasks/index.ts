import type { Ramble } from './ramble.js'
import type { TaskReminders } from './reminders.js'
import type { Tasks } from './service.js'
import type { TodoistImport } from './todoist.js'

export {
  buildRamblePrompt,
  MAX_RAMBLE_TASKS,
  parseRambleResponse,
  RAMBLE_SYSTEM,
  Ramble,
} from './ramble.js'
export {
  dueForReminder,
  TASK_REMINDER_LATE_MS,
  TASK_REMINDER_LEAD_MS,
  TaskReminders,
  taskReminderKey,
} from './reminders.js'
export {
  compareTasks,
  isMine,
  MAX_TASK_LIST,
  notesOf,
  type Person,
  resolveAssignee,
  type TaskFilter,
  type TaskInput,
  type TaskPatch,
  Tasks,
  type TasksDeps,
  type TaskView,
} from './service.js'
export {
  type ImportedTask,
  type ImportResult,
  MAX_IMPORT_TASKS,
  mapTodoistApi,
  mapTodoistDue,
  parseCsv,
  parseTodoistCsv,
  TODOIST_API,
  TodoistImport,
  type TodoistImportInput,
} from './todoist.js'

/** Hearth Tasks (ARCHITECTURE §12), as the API and MCP reach it. */
export interface TaskServices {
  service: Tasks
  ramble: Ramble
  todoist: TodoistImport
  /** Null when there is no push sender (no VAPID keys). */
  reminders: TaskReminders | null
}
